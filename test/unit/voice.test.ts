import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type BoxServer, startBoxServer } from "../../src/box-server/server";
import { Harness } from "../../src/box/harness";
import { McpManager } from "../../src/box/mcp";
import { BoxStore } from "../../src/box/store";
import { audioFileName, listVoices, speakableText, speaker, speechParts, synthesize, transcribe, transcriber, voiceCapabilities, VoiceError } from "../../src/box/voice";
import { GatewayClient } from "../../src/coordinator/gateway-client";
import { allowPermission, appPagePrefix } from "../../src/main/web-permissions";
import type { BoxModelConfig } from "../../src/shared/edges";
import { type AgentSummary, type ClaudeCodeStatus, type MessageEntry, parseVoiceId, type TranscriptEntry, type VoiceCapabilities } from "../../src/shared/model";
import { isInside } from "../../src/shared/paths";

const cleanup: Array<() => void> = [];
after(() => {
  for (const fn of cleanup.reverse()) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wisp-voice-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The fake's MP3: an ID3 header and some bytes, enough to tell replies apart. */
const fakeMp3 = (label: string) => Buffer.concat([Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000", "latin1"), Buffer.from(label)]);

interface SpeechRequest {
  path: string;
  authorization: string | undefined;
  /** Multipart fields in the order they came, files as {name, type, size}. */
  fields: Array<[string, string | { name: string; type: string; size: number }]>;
  json: Record<string, unknown> | null;
}

/** A fake xAI (/v1/stt, /v1/tts, /v1/tts/voices) and OpenAI (/v1/audio/transcriptions, /v1/audio/speech) speech API. */
async function fakeSpeech() {
  const requests: SpeechRequest[] = [];
  const state = {
    transcript: "Remind me to water the plants at six.",
    /** Status to answer the next request with, then cleared. */
    failNext: null as { status: number; body: unknown } | null,
    /** Refuse any transcription that names a language. */
    refuseLanguage: false,
    voices: [{ voice_id: "eve", name: "Eve" }, { voice_id: "rex", name: "Rex" }, { voice_id: "ara", name: "Ara" }] as unknown,
  };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      const url = new URL(request.url ?? "/", "http://fake.local");
      const body = Buffer.concat(chunks);
      const record: SpeechRequest = { path: url.pathname, authorization: request.headers.authorization, fields: [], json: null };
      const type = request.headers["content-type"] ?? "";
      if (type.startsWith("multipart/form-data")) {
        const form = await new Response(body, { headers: { "content-type": type } }).formData();
        for (const [name, value] of form.entries()) record.fields.push([name, typeof value === "string" ? value : { name: value.name, type: value.type, size: value.size }]);
      } else if (type.startsWith("application/json")) record.json = JSON.parse(body.toString("utf8"));
      requests.push(record);
      const json = (status: number, payload: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (state.failNext != null) {
        const failure = state.failNext;
        state.failNext = null;
        return json(failure.status, failure.body);
      }
      const field = (name: string) => record.fields.find(([key]) => key === name)?.[1];
      if (request.method === "POST" && (url.pathname === "/v1/stt" || url.pathname === "/v1/audio/transcriptions")) {
        if (state.refuseLanguage && (field("language") != null || field("languages[]") != null)) return json(400, { error: { message: "unsupported language" } });
        if (url.pathname === "/v1/audio/transcriptions") return json(200, { text: ` ${state.transcript} `, languages: [{ code: "en" }], usage: { type: "duration", seconds: 2.5 } });
        const words = state.transcript.split(" ").map((text, index) => ({ text, start: 0.2 + index * 0.4, end: 0.5 + index * 0.4 }));
        return json(200, { text: state.transcript, language: "en", duration: 3.24, words });
      }
      if (request.method === "POST" && (url.pathname === "/v1/tts" || url.pathname === "/v1/audio/speech")) {
        const text = String(record.json?.text ?? record.json?.input ?? "");
        response.writeHead(200, { "content-type": "audio/mpeg" });
        return response.end(fakeMp3(`${url.pathname}:${text}`));
      }
      if (request.method === "GET" && url.pathname === "/v1/tts/voices") return json(200, { voices: state.voices });
      json(404, { error: { message: `no route ${url.pathname}` } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { base, requests, state };
}

const models = (connected: { xai?: string; openai?: string; chatgpt?: boolean }): BoxModelConfig => ({
  defaultModel: { provider: "mock", model: "mock-1" },
  reasoningEffort: "default",
  temperature: null,
  xai: connected.xai != null ? { baseUrl: `${connected.xai}/`, apiKey: "xai-key" } : null,
  openai: connected.openai != null ? { baseUrl: connected.openai, auth: "api-key", apiKey: "sk-openai" } : connected.chatgpt ? { baseUrl: "https://api.openai.com/v1", auth: "chatgpt", accessToken: "plan", expiresAt: Date.now() + 3_600_000 } : null,
  anthropic: { apiKey: "sk-ant" },
  custom: null,
  claudeCode: null,
});

const m4a = () => new Uint8Array(Buffer.from("....ftypM4A fake recording"));

test("voice providers: the agent's provider first, then xAI, then OpenAI; WebM to OpenAI; nothing on a ChatGPT plan alone", async () => {
  const both = models({ xai: "https://x.test/v1", openai: "https://o.test/v1" });
  assert.equal(transcriber(both, "anthropic")?.provider, "xai");
  assert.equal(transcriber(both, "openai")?.provider, "openai", "an agent on OpenAI keeps its recordings there");
  assert.equal(transcriber(both, "xai", "audio/webm;codecs=opus")?.provider, "openai", "xAI doesn't list WebM");
  assert.equal(transcriber(models({ xai: "https://x.test/v1" }), null, "audio/webm")?.provider, "xai", "xAI alone still gets a try");
  assert.equal(transcriber(models({ chatgpt: true }), "openai"), null);

  assert.deepEqual(speaker(both, "openai:cedar", "xai"), { connection: { provider: "openai", baseUrl: "https://o.test/v1", apiKey: "sk-openai" }, voice: "cedar" });
  assert.equal(speaker(both, null, "openai")?.voice, "marin");
  assert.equal(speaker(models({ xai: "https://x.test/v1" }), "openai:cedar", "openai")?.voice, "eve", "a voice whose provider isn't connected falls back to a connected one's default");
  assert.equal(parseVoiceId("xai:eve")?.voice, "eve");
  assert.equal(parseVoiceId("eve"), null);
  assert.equal(parseVoiceId("anthropic:claude"), null);

  const none = await voiceCapabilities(models({ chatgpt: true }), "openai");
  assert.equal(none.transcription, null);
  assert.equal(none.speech, null);
  assert.match(none.transcriptionUnavailable ?? "", /xAI API key or an OpenAI API key\. A ChatGPT plan sign-in can’t do it/);
  assert.match(none.speechUnavailable ?? "", /^Reading replies aloud needs/);
  assert.deepEqual(none.voices, []);

  assert.equal(audioFileName("audio/mp4;codecs=mp4a.40.2"), "recording.m4a");
  assert.equal(audioFileName("audio/webm;codecs=opus"), "recording.webm");
  assert.equal(audioFileName("audio/mpeg"), "recording.mp3");
});

test("transcribe: xAI's /stt and OpenAI's /audio/transcriptions, word timings, language hints and refusals", async () => {
  const fake = await fakeSpeech();
  const xai = models({ xai: fake.base });

  const heard = await transcribe(xai, { bytes: m4a(), mime: "audio/mp4;codecs=mp4a.40.2" }, { language: "en-GB" });
  assert.equal(heard.text, "Remind me to water the plants at six.");
  assert.equal(heard.provider, "xai");
  assert.equal(heard.durationMs, 3240);
  assert.equal(heard.language, "en");
  assert.deepEqual(heard.words?.slice(0, 2), [
    { text: "Remind", startMs: 200, endMs: 500 },
    { text: "me", startMs: 600, endMs: 900 },
  ]);
  const stt = fake.requests.at(-1)!;
  assert.equal(stt.path, "/v1/stt");
  assert.equal(stt.authorization, "Bearer xai-key");
  // Options first, the file last (xAI ignores options sent after it); "format" needs the language.
  assert.deepEqual(stt.fields, [
    ["language", "en"],
    ["format", "true"],
    ["file", { name: "recording.m4a", type: "audio/mp4", size: m4a().byteLength }],
  ]);

  const openai = models({ openai: fake.base });
  const fromOpenAi = await transcribe(openai, { bytes: m4a(), mime: "audio/webm;codecs=opus" }, { language: "fr" });
  assert.equal(fromOpenAi.text, "Remind me to water the plants at six.", "trimmed");
  assert.equal(fromOpenAi.provider, "openai");
  assert.equal(fromOpenAi.durationMs, 2500);
  assert.equal(fromOpenAi.words, undefined);
  const whisper = fake.requests.at(-1)!;
  assert.equal(whisper.path, "/v1/audio/transcriptions");
  assert.equal(whisper.authorization, "Bearer sk-openai");
  assert.deepEqual(whisper.fields, [
    ["model", "gpt-transcribe"],
    ["languages[]", "fr"],
    ["file", { name: "recording.webm", type: "audio/webm", size: m4a().byteLength }],
  ]);

  // A language the provider refuses: the same recording again without one.
  fake.state.refuseLanguage = true;
  const before = fake.requests.length;
  assert.equal((await transcribe(xai, { bytes: m4a(), mime: "audio/mp4" }, { language: "tlh" })).text, "Remind me to water the plants at six.");
  assert.equal(fake.requests.length, before + 2);
  assert.deepEqual(fake.requests.at(-1)!.fields.map(([name]) => name), ["file"]);
  fake.state.refuseLanguage = false;

  fake.state.failNext = { status: 401, body: { error: { message: "bad key" } } };
  await assert.rejects(transcribe(xai, { bytes: m4a(), mime: "audio/mp4" }), (error: unknown) => error instanceof VoiceError && error.code === "provider" && /xAI rejected the API key \(401\)/.test(error.message));
  fake.state.failNext = { status: 500, body: { error: { message: "decoder exploded" } } };
  await assert.rejects(transcribe(openai, { bytes: m4a(), mime: "audio/mp4" }), /OpenAI couldn’t transcribe the recording \(500\): decoder exploded/);
  const count = fake.requests.length;
  await assert.rejects(transcribe(xai, { bytes: new Uint8Array(0), mime: "audio/mp4" }), (error: unknown) => error instanceof VoiceError && error.code === "empty");
  await assert.rejects(transcribe(xai, { bytes: new Uint8Array(26 * 1024 * 1024), mime: "audio/mp4" }), (error: unknown) => error instanceof VoiceError && error.code === "too-large");
  await assert.rejects(transcribe(models({ chatgpt: true }), { bytes: m4a(), mime: "audio/mp4" }), (error: unknown) => error instanceof VoiceError && error.code === "unavailable");
  assert.equal(fake.requests.length, count, "nothing is sent that can't succeed");
});

test("speech: xAI's /tts and OpenAI's /audio/speech in the chosen voice, the voice list, and replies as speakable text in parts", async () => {
  const fake = await fakeSpeech();
  const both = models({ xai: fake.base, openai: fake.base });

  const xaiAudio = await synthesize(both, { text: "Hello there.", voiceId: "xai:rex", language: "en" });
  assert.equal(xaiAudio.mime, "audio/mpeg");
  assert.equal(xaiAudio.voiceId, "xai:rex");
  assert.deepEqual(xaiAudio.bytes, fakeMp3("/v1/tts:Hello there."));
  assert.deepEqual(fake.requests.at(-1)!.json, { text: "Hello there.", voice_id: "rex", language: "en" });

  const openaiAudio = await synthesize(both, { text: "Hello again.", prefer: "openai" });
  assert.equal(openaiAudio.voiceId, "openai:marin");
  assert.deepEqual(fake.requests.at(-1)!.json, { model: "gpt-4o-mini-tts", input: "Hello again.", voice: "marin", response_format: "mp3" });
  assert.deepEqual((await synthesize(both, { text: "Hi" })).voiceId, "xai:eve", "xAI's default voice, with language left to it");
  assert.equal(fake.requests.at(-1)!.json?.language, "auto");
  await assert.rejects(synthesize(both, { text: "   " }), (error: unknown) => error instanceof VoiceError && error.code === "empty");

  const voices = await listVoices(both);
  assert.deepEqual(
    voices.map((voice) => voice.id),
    ["xai:eve", "xai:rex", "xai:ara", "openai:marin", "openai:cedar", "openai:alloy", "openai:ash", "openai:ballad", "openai:coral", "openai:echo", "openai:fable", "openai:nova", "openai:onyx", "openai:sage", "openai:shimmer", "openai:verse"],
  );
  assert.equal(voices[1].label, "Rex");
  const capabilities = await voiceCapabilities(both, "openai", "xai:ara");
  assert.deepEqual(capabilities.speech, { provider: "xai", voiceId: "xai:ara", defaultVoiceId: "openai:marin" });
  assert.deepEqual(capabilities.transcription, { provider: "openai" });

  assert.equal(
    speakableText(
      [
        "## Plan",
        "Here is **the plan** for *today* — see [the docs](https://example.com/docs) or https://www.example.org/a/b?c=d. [[1]](https://example.com/cite)",
        "",
        "- Buy `milk`",
        "1. Call ~~Bob~~ Alice",
        "> quoted",
        "",
        "```js",
        "console.log('x')",
        "```",
        "",
        "| Name | Qty |",
        "| --- | --- |",
        "| apples | 3 |",
        "snake_case_names stay.",
      ].join("\n"),
    ),
    ["Plan", "Here is the plan for today — see the docs or example.org.", "", "Buy milk", "Call Bob Alice", "quoted", "", "Code omitted.", "", "Name, Qty.", "", "apples, 3.", "snake_case_names stay."].join("\n"),
  );

  const long = Array.from({ length: 60 }, (_, index) => `Sentence number ${index + 1} is here to make this reply long enough.`).join(" ");
  const parts = speechParts(long);
  assert.ok(parts.length > 1);
  assert.ok(parts[0].length <= 300 && parts[0].endsWith("."), "a short first part, cut after a sentence");
  assert.ok(parts.slice(1).every((part) => part.length <= 3_500));
  assert.equal(parts.join(" "), long, "nothing is lost or repeated");
  assert.deepEqual(speechParts(long), parts, "the same parts every time");
  assert.deepEqual(speechParts("Short."), ["Short."]);
  assert.deepEqual(speechParts(""), []);
});

test("web permissions: only the app's own pages, and only the main window may use the microphone, never the camera", () => {
  const distDir = join(tmpdir(), "wisp-dist");
  const prefix = appPagePrefix(distDir);
  const page = `${prefix}index.html`;
  const ask = (permission: string, url: string, mediaTypes: string[] = [], mainWindowFrame = true) => allowPermission({ permission, url, mediaTypes, mainWindowFrame }, prefix);
  assert.ok(prefix.startsWith("file:///") && prefix.endsWith("/renderer/"));
  assert.equal(ask("media", page, ["audio"]), true);
  assert.equal(ask("media", page, ["video"]), false);
  assert.equal(ask("media", page, ["audio", "video"]), false);
  assert.equal(ask("media", page, []), false, "a request that names nothing gets nothing");
  assert.equal(ask("media", page, ["audio"], false), false, "the desktop panel or a frame isn't the main window");
  assert.equal(ask("media", "https://abc.e2b.app/vnc.html", ["audio"]), false);
  assert.equal(ask("media", `${prefix.slice(0, -"renderer/".length)}evil.html`, ["audio"]), false, "a file outside the renderer folder");
  assert.equal(ask("clipboard-sanitized-write", page), true);
  assert.equal(ask("notifications", `${prefix}desktop-mount/panel.html`, [], false), true);
  assert.equal(ask("clipboard-sanitized-write", "https://evil.example/"), false);
  for (const permission of ["geolocation", "midi", "pointerLock", "fullscreen", "openInBrowser", "display-capture"]) assert.equal(ask(permission, page), false, permission);
});

test("voice memos in the harness: the recording rides on the message, and the model reads the transcript as spoken", async () => {
  const dir = tempDir();
  const store = new BoxStore(dir);
  cleanup.push(() => store.close());
  const now = Date.now();
  const row: AgentSummary = {
    id: "a1", name: "Tester", description: "", path: "", origin: "user", isGroup: false, memberIds: [], isActive: false, createdAt: now, updatedAt: now,
    isRunning: false, isComposingMessage: false, awaitingUserResponse: null, hasUnread: false, lastMessageId: null, lastEntry: null,
    notificationsEnabled: true, notifyOnUpdatesEnabled: true, avatarDataUrl: null, instructions: "", model: null, isPinned: false,
  };
  store.putAgent(row);
  const harness = new Harness({
    store,
    models: () => models({}),
    resolveDeps: { chatGptToken: async () => "unused" },
    workspaceRoot: () => join(dir, "workspaces"),
    localTools: () => [],
    callLocalTool: async () => ({ kind: "error", message: "no local tools" }),
    mcp: new McpManager(() => undefined, () => undefined),
    claudeCode: null,
    cloud: null,
    cloudConfig: () => null,
    emit: () => undefined,
    log: () => undefined,
  });
  const recording = join(dir, "attachments", "r1", "Voice memo.m4a");
  mkdirSync(join(dir, "attachments", "r1"), { recursive: true });
  writeFileSync(recording, m4a());
  harness.submitPrompt("a1", { prompt: "Book a table for two.", attachmentPaths: [recording], attachmentNames: ["Voice memo.m4a"], clientNonce: "memo-1", source: "user", voiceMemo: { durationMs: 42_000, provider: "xai" } });
  await until(() => !store.getAgent("a1")!.isRunning);
  const entries = store.entries("a1");
  const memo = entries.find((entry): entry is MessageEntry => entry.kind === "message" && entry.role === "user")!;
  assert.equal(memo.content, "Book a table for two.");
  assert.deepEqual(memo.voiceMemo, { path: recording, name: "Voice memo.m4a", mime: "audio/mp4", byteSize: m4a().byteLength, durationMs: 42_000, provider: "xai" });
  assert.equal(entries.filter((entry) => entry.kind === "user-attachment").length, 0, "no separate attachment row");
  assert.equal(store.getAgent("a1")!.lastMessagePreview?.startsWith("Mock model here"), true);
  const user = harness.buildConversation("a1")[0];
  assert.equal(user.kind, "user");
  const text = user.kind === "user" && user.parts[0].type === "text" ? user.parts[0].text : "";
  assert.match(text, /^\[Sent [^\]]+\]\n\[Voice memo, 0:42 long; its transcript follows, made automatically, so a word may be misheard\]\nBook a table for two\.$/);
});

const TOKEN = randomBytes(24).toString("hex");
const NO_CLAUDE = async (): Promise<ClaudeCodeStatus> => ({ executable: null, installed: false, version: null, signedIn: false, authMethod: null, checkedAt: 1 });

async function bootBox(env: NodeJS.ProcessEnv): Promise<{ server: BoxServer; dataDir: string }> {
  const dataDir = tempDir();
  const server = await startBoxServer({
    settings: { dataDir, host: "127.0.0.1", port: 0, token: TOKEN, tls: null, behindTlsProxy: false, admin: true, configFile: join(dataDir, "box-config.json"), workspaceRoot: join(dataDir, "workspaces") },
    env: { WISP_BOX_DEFAULT_MODEL: "mock:mock-1", ...env },
    version: "9.9.9-test",
    detectClaudeCode: NO_CLAUDE,
    log: () => undefined,
  });
  cleanup.push(() => server.close());
  return { server, dataDir };
}

const post = (server: BoxServer, method: string, args: unknown) =>
  fetch(`${server.url}/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(args) });

async function api<T = any>(server: BoxServer, method: string, args: unknown): Promise<T> {
  const response = await post(server, method, args);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as T;
}

async function upload(server: BoxServer, name: string, bytes: Uint8Array): Promise<string> {
  const response = await fetch(`${server.url}/attachments?name=${encodeURIComponent(name)}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream" }, body: Buffer.from(bytes) });
  assert.equal(response.status, 200);
  return ((await response.json()) as { path: string }).path;
}

test("box gateway: dictation, a voice memo the mock model answers, the agent's voice and Read aloud, against a fake xAI", async () => {
  const fake = await fakeSpeech();
  const { server, dataDir } = await bootBox({ XAI_API_KEY: "xai-key", WISP_BOX_XAI_BASE_URL: fake.base });
  const { agent } = await api<{ agent: AgentSummary }>(server, "addAgent", { name: "Voice", description: "" });

  const capabilities = await api<VoiceCapabilities>(server, "getVoiceCapabilities", { agentId: agent.id });
  assert.deepEqual(capabilities.transcription, { provider: "xai" });
  assert.deepEqual(capabilities.speech, { provider: "xai", voiceId: "xai:eve", defaultVoiceId: "xai:eve" });
  assert.deepEqual(capabilities.voices.map((voice) => voice.id), ["xai:eve", "xai:rex", "xai:ara"]);

  // Dictation inline.
  const inline = await api(server, "speechToText", { audioBase64: Buffer.from(m4a()).toString("base64"), mimeType: "audio/mp4", language: "en-US", agentId: agent.id });
  assert.equal(inline.text, "Remind me to water the plants at six.");
  assert.equal(inline.provider, "xai");
  assert.equal(typeof inline.transcriptionTimeMs, "number");

  // Dictation as an attached file (how the app sends it, uploaded first to a remote box); discard deletes it.
  const dictation = await upload(server, "Dictation.m4a", m4a());
  assert.equal((await api(server, "speechToText", { attachmentPath: dictation, mimeType: "audio/mp4", agentId: agent.id, discard: true })).text, "Remind me to water the plants at six.");
  assert.equal(existsSync(dictation), false);
  const outside = join(dataDir, "notes.m4a");
  writeFileSync(outside, m4a());
  const refused = await post(server, "speechToText", { attachmentPath: outside, mimeType: "audio/mp4", discard: true });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).failureCode, "voice/refused");
  assert.equal(existsSync(outside), true, "a refused path is never touched");
  assert.equal((await post(server, "speechToText", { mimeType: "audio/mp4" })).status, 400, "audio inline or attached, one of them");

  // A voice memo: transcribed, then sent with its recording; the model reads the transcript.
  const memoPath = await upload(server, "Voice memo.m4a", m4a());
  const memo = await api(server, "speechToText", { attachmentPath: memoPath, mimeType: "audio/mp4", agentId: agent.id });
  assert.equal(existsSync(memoPath), true, "a memo's recording stays");
  await api(server, "deliverMessage", { agentId: agent.id, prompt: memo.text, clientNonce: "memo-1", attachmentPaths: [memoPath], attachmentNames: ["Voice memo.m4a"], voiceMemo: { durationMs: memo.durationMs, provider: memo.provider, words: memo.words } });
  const entries = async () => (await api<{ entries: TranscriptEntry[] }>(server, "readTranscriptEnd", { id: agent.id, limit: 100 })).entries;
  await until(async () => (await entries()).some((entry) => entry.kind === "message" && entry.role === "assistant" && !entry.isStreaming && entry.content.includes("water the plants")));
  const all = await entries();
  const sent = all.find((entry): entry is MessageEntry => entry.kind === "message" && entry.role === "user")!;
  assert.equal(sent.content, "Remind me to water the plants at six.");
  assert.equal(sent.voiceMemo?.path, memoPath);
  assert.equal(sent.voiceMemo?.mime, "audio/mp4");
  assert.equal(sent.voiceMemo?.durationMs, 3240);
  assert.equal(sent.voiceMemo?.words?.length, 8);
  const reply = all.find((entry): entry is MessageEntry => entry.kind === "message" && entry.role === "assistant")!;
  assert.match(reply.content, /\[Voice memo, 0:03 long; its transcript follows[^\]]*\]\nRemind me to water the plants at six\./);
  const media = await fetch(`${server.url}/media?path=${encodeURIComponent(memoPath)}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(media.headers.get("content-type"), "audio/mp4");
  const refusedMemo = await post(server, "deliverMessage", { agentId: agent.id, prompt: "x", attachmentPaths: [outside], voiceMemo: { durationMs: 1000 } });
  assert.equal((await refusedMemo.json()).failureCode, "send/voice-memo-refused");
  const found = await api(server, "findInConversation", { agentId: agent.id, query: "water the plants" });
  assert.ok(found.matches.some((match: { entryId: string }) => match.entryId === sent.id), "a memo's transcript is searchable");

  // The agent's voice, Read aloud in it (in parts, cached), and a preview.
  await api(server, "changeAgentVoice", { id: agent.id, voiceId: "xai:rex", voiceSpeed: 1.25 });
  const voiced = (await api<AgentSummary[]>(server, "rosterAgents", {})).find((row) => row.id === agent.id)!;
  assert.equal(voiced.voiceId, "xai:rex");
  assert.equal(voiced.voiceSpeed, 1.25);
  assert.equal((await post(server, "changeAgentVoice", { id: agent.id, voiceId: "rex" })).status, 400);
  const ttsBefore = fake.requests.filter((request) => request.path === "/v1/tts").length;
  const spoken = await api(server, "speakMessage", { agentId: agent.id, entryId: reply.id });
  assert.equal(spoken.voiceId, "xai:rex");
  assert.equal(spoken.mimeType, "audio/mpeg");
  assert.equal(spoken.part, 0);
  assert.ok(spoken.parts >= 1);
  const tts = fake.requests.filter((request) => request.path === "/v1/tts");
  assert.equal(tts.length, ttsBefore + 1);
  assert.equal(tts.at(-1)!.json?.voice_id, "rex");
  assert.ok(Buffer.from(spoken.audioBase64, "base64").toString().startsWith("ID3"));
  assert.equal(tts.at(-1)!.json?.text, speechParts(speakableText(reply.content))[0], "the reply as it should be heard, its first part");
  assert.deepEqual(await api(server, "speakMessage", { agentId: agent.id, entryId: reply.id }), spoken, "the same part again comes from the cache");
  assert.equal(fake.requests.filter((request) => request.path === "/v1/tts").length, ttsBefore + 1);
  assert.equal((await post(server, "speakMessage", { agentId: agent.id, entryId: sent.id })).status, 404, "only replies are read aloud");
  const preview = await api(server, "sampleVoice", { voiceId: "xai:ara", greetingId: "default" });
  assert.equal(preview.mimeType, "audio/mpeg");
  assert.equal(fake.requests.at(-1)!.json?.voice_id, "ara");
  const notConnected = await post(server, "sampleVoice", { voiceId: "openai:marin", greetingId: "default" });
  assert.equal(notConnected.status, 409);
  assert.match((await notConnected.json()).error, /Connect OpenAI with an API key/);

  // xAI refuses: the user sees why.
  fake.state.failNext = { status: 429, body: { error: { message: "slow down" } } };
  const limited = await post(server, "speechToText", { audioBase64: Buffer.from(m4a()).toString("base64"), mimeType: "audio/mp4" });
  assert.equal(limited.status, 424);
  assert.deepEqual(await limited.json(), { error: "xAI is rate-limiting requests. Try again shortly.", failureCode: "voice/provider" });
});

test("box gateway without a provider that can do speech: clear messages instead of recordings going nowhere", async () => {
  const { server } = await bootBox({});
  const { agent } = await api<{ agent: AgentSummary }>(server, "addAgent", { name: "Quiet", description: "" });
  const capabilities = await api<VoiceCapabilities>(server, "getVoiceCapabilities", { agentId: agent.id });
  assert.equal(capabilities.transcription, null);
  assert.match(capabilities.transcriptionUnavailable ?? "", /^Transcribing speech needs an xAI API key or an OpenAI API key\. Add one in Settings → Models\.$/);
  const response = await post(server, "speechToText", { audioBase64: Buffer.from(m4a()).toString("base64"), mimeType: "audio/mp4", agentId: agent.id });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: capabilities.transcriptionUnavailable, failureCode: "voice/unavailable" });
  await api(server, "deliverMessage", { agentId: agent.id, prompt: "Hello", clientNonce: "n1" });
  const entries = async () => (await api<{ entries: TranscriptEntry[] }>(server, "readTranscriptEnd", { id: agent.id, limit: 50 })).entries;
  await until(async () => (await entries()).some((entry) => entry.kind === "message" && entry.role === "assistant" && !entry.isStreaming));
  const reply = (await entries()).find((entry) => entry.kind === "message" && entry.role === "assistant")!;
  const silent = await post(server, "speakMessage", { agentId: agent.id, entryId: reply.id });
  assert.equal(silent.status, 409);
  assert.match((await silent.json()).error, /^Reading replies aloud needs/);
});

test("coordinator: a remote box gets a memo's recording once, for transcription, and its send names the box's copy", async () => {
  const { server, dataDir } = await bootBox({});
  const staging = join(tempDir(), "attachments");
  mkdirSync(join(staging, "s1"), { recursive: true });
  const staged = join(staging, "s1", "Voice memo.m4a");
  writeFileSync(staged, m4a());
  const client = new GatewayClient({ resolveConnection: async () => ({ baseUrl: server.url, token: TOKEN, remote: true }), onEvent: () => undefined, onState: () => undefined, log: () => undefined });
  const uploads = () => (existsSync(join(dataDir, "attachments")) ? readdirSync(join(dataDir, "attachments")).length : 0);

  const transcribed = await client.withUploadedRecording({ attachmentPath: staged, mimeType: "audio/mp4" }, staging);
  assert.ok(isInside(transcribed.attachmentPath!, join(dataDir, "attachments")));
  assert.equal(uploads(), 1);
  const sent = await client.withUploadedAttachments({ attachmentPaths: [staged], attachmentNames: ["Voice memo.m4a"] }, staging);
  assert.deepEqual(sent.attachmentPaths, [transcribed.attachmentPath], "no second upload");
  assert.equal(uploads(), 1);

  // A dictation is deleted after transcribing, so it isn't remembered.
  const dictation = join(staging, "s1", "Dictation.m4a");
  writeFileSync(dictation, m4a());
  const once = await client.withUploadedRecording({ attachmentPath: dictation, mimeType: "audio/mp4", discard: true }, staging);
  const again = await client.withUploadedRecording({ attachmentPath: dictation, mimeType: "audio/mp4", discard: true }, staging);
  assert.notEqual(once.attachmentPath, again.attachmentPath);
  await assert.rejects(client.withUploadedRecording({ attachmentPath: join(dataDir, "box-config.json"), mimeType: "audio/mp4" }, staging), /attached in the app/);
  const local = new GatewayClient({ resolveConnection: async () => ({ baseUrl: server.url, token: TOKEN }), onEvent: () => undefined, onState: () => undefined, log: () => undefined });
  assert.equal((await local.withUploadedRecording({ attachmentPath: staged, mimeType: "audio/mp4" }, staging)).attachmentPath, staged, "a box on this PC reads it where it is");
});
