import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { CloudComputer } from "../../src/box/cloud-computer";
import { CLOUD_TOOLS, cloudToolSpecs, resolveCloudPath } from "../../src/box/cloud-tools";
import { Harness, publicEntry } from "../../src/box/harness";
import { McpManager } from "../../src/box/mcp";
import { BoxStore } from "../../src/box/store";
import type { BoxModelConfig } from "../../src/shared/edges";
import type { AgentSummary, MessageEntry, SendMessageEntry, TranscriptEntry, TranscriptEvent } from "../../src/shared/model";

const dirs: string[] = [];
const stores: BoxStore[] = [];
after(() => {
  stores.forEach((store) => store.close());
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function agent(id: string): AgentSummary {
  const now = Date.now();
  return {
    id, name: "Tester", description: "", path: "", origin: "user", isGroup: false, memberIds: [], isActive: false, createdAt: now, updatedAt: now,
    isRunning: false, isComposingMessage: false, awaitingUserResponse: null, hasUnread: false, lastMessageId: null, lastEntry: null,
    notificationsEnabled: true, notifyOnUpdatesEnabled: true, avatarDataUrl: null, instructions: "", model: null, isPinned: false,
  };
}

function setup(models: BoxModelConfig = MOCK_MODELS) {
  const dir = mkdtempSync(join(tmpdir(), "wisp-test-"));
  dirs.push(dir);
  const store = new BoxStore(dir);
  stores.push(store);
  store.putAgent(agent("a1"));
  const events: Array<{ channel: string; payload: any }> = [];
  const harness = new Harness({
    store,
    models: () => models,
    resolveDeps: { chatGptToken: async () => "unused" },
    workspaceRoot: () => join(dir, "workspaces"),
    localTools: () => [],
    callLocalTool: async () => ({ kind: "error", message: "no local tools" }),
    mcp: new McpManager(() => undefined, () => undefined),
    claudeCode: null,
    cloud: null,
    cloudConfig: () => null,
    emit: (channel, payload) => events.push({ channel, payload }),
    log: () => undefined,
  });
  return { dir, store, harness, events };
}

const MOCK_MODELS: BoxModelConfig = {
  defaultModel: { provider: "mock", model: "mock-1" },
  reasoningEffort: "default",
  temperature: null,
  xai: null,
  openai: null,
  anthropic: null,
  custom: null,
  claudeCode: null,
};

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("store folds upserts, stamps sequences and survives a reload", () => {
  const { dir, store } = setup();
  const entry: TranscriptEntry = { kind: "notice", id: "t1s0", seq: 1, turn: 1, step: 0, timestampMs: 1, text: "one" };
  store.upsertEntry("a1", entry, true);
  store.upsertEntry("a1", { ...entry, text: "two" }, true);
  assert.equal(store.entries("a1").length, 1);
  const first = store.stamp("a1");
  assert.equal(store.stamp("a1").sequence, first.sequence + 1);
  const reloaded = new BoxStore(dir);
  assert.deepEqual(reloaded.entries("a1").map((e) => (e.kind === "notice" ? e.text : "")), ["two"]);
  const cleared = reloaded.clearTranscript("a1");
  assert.notEqual(cleared.epoch, first.epoch);
  assert.equal(new BoxStore(dir).entries("a1").length, 0);
});

test("a prompt runs to completion with consecutive transcript stamps", async () => {
  const { store, harness, events } = setup();
  assert.equal(harness.submitPrompt("a1", { prompt: "hi", attachmentPaths: [], attachmentNames: [], clientNonce: "n1", source: "user" }), true);
  assert.equal(harness.submitPrompt("a1", { prompt: "hi", attachmentPaths: [], attachmentNames: [], clientNonce: "n1", source: "user" }), false, "duplicate nonce is deduplicated");
  await until(() => store.getAgent("a1")!.isRunning === false && store.entries("a1").some((e) => e.kind === "message" && e.role === "assistant" && !e.isStreaming));
  const reply = store.entries("a1").find((e) => e.kind === "message" && e.role === "assistant");
  assert.match(reply && reply.kind === "message" ? reply.content : "", /Mock model here/);
  const sequences = events.filter((e) => e.channel === "transcript").map((e) => (e.payload as TranscriptEvent).ordered.sequence);
  sequences.forEach((sequence, index) => assert.equal(sequence, index + 1));
  const settled = store.getAgent("a1")!;
  assert.equal(settled.lastTurnSettlement?.outcome, "success");
  assert.equal(settled.hasUnread, true);
  assert.ok(events.some((e) => e.channel === "activity" && e.payload.kind === "finished"));
});

test("ask_user posts a widget card and resumes with the answer", async () => {
  const { store, harness } = setup();
  harness.submitPrompt("a1", { prompt: '/tool ask_user {"question":"Which color?","options":["Red","Blue"]}', attachmentPaths: [], attachmentNames: [], clientNonce: "n2", source: "user" });
  await until(() => store.entries("a1").some((e) => e.kind === "send-message"));
  const card = store.entries("a1").find((e): e is SendMessageEntry => e.kind === "send-message")!;
  assert.equal(card.message.type, "widget");
  assert.equal(store.getAgent("a1")!.awaitingUserResponse?.reason, "question");
  assert.equal(harness.answerCard("a1", card.id, "Blue"), true);
  await until(() => !store.getAgent("a1")!.isRunning);
  const call = store.entries("a1").find((e) => e.kind === "tool-call");
  assert.equal(call?.kind === "tool-call" ? call.detail?.output : "", "The user answered: Blue");
  const answered = store.entries("a1").find((e): e is SendMessageEntry => e.kind === "send-message")!;
  assert.equal(answered.respondedValue, "Blue");
});

test("the model conversation is rebuilt append-only, with replay state kept out of client events", () => {
  const { store, harness } = setup();
  const user = (id: string, seq: number, turn: number, content: string): TranscriptEntry => ({ kind: "message", role: "user", id, seq, turn, step: 0, timestampMs: Date.UTC(2026, 9, 23, 9, seq), content, isStreaming: false });
  const replay = { provider: "anthropic" as const, model: "claude-opus-5-5", items: [{ type: "thinking", thinking: "t", signature: "S" }] };
  store.upsertEntry("a1", user("t1s0", 1, 1, "read a.txt"), true);
  store.upsertEntry("a1", { kind: "message", role: "assistant", id: "t1s1", seq: 2, turn: 1, step: 1, timestampMs: 2, content: "Reading.", isStreaming: false, replay }, true);
  store.upsertEntry("a1", { kind: "tool-call", id: "t1s2", seq: 3, turn: 1, step: 1, timestampMs: 3, name: "read_file", status: "done", detail: { callId: "toolu_1", args: { path: "a.txt" }, output: "hello", error: null, image: null, startedAt: 3, finishedAt: 4 } }, true);
  store.upsertEntry("a1", { kind: "tool-call", id: "t1s3", seq: 4, turn: 1, step: 1, timestampMs: 4, name: "write_file", status: "failed", detail: { callId: "toolu_2", args: {}, output: "", error: "denied", image: null, startedAt: 4, finishedAt: 5 } }, true);
  store.upsertEntry("a1", { kind: "message", role: "assistant", id: "t1s4", seq: 5, turn: 1, step: 2, timestampMs: 5, content: "It says hello.", isStreaming: false }, true);

  const first = harness.buildConversation("a1");
  assert.deepEqual(
    first.map((item) => item.kind),
    ["user", "assistant", "tool-results", "assistant"],
  );
  const header = first[0].kind === "user" && first[0].parts[0].type === "text" ? first[0].parts[0].text : "";
  assert.match(header, /^\[Sent .*2026.*\]\nread a\.txt$/, "the send time rides on the message, not the system prompt");
  assert.deepEqual(first[1].kind === "assistant" ? first[1].replay : null, replay);
  assert.deepEqual(first[2].kind === "tool-results" ? first[2].results.map((r) => [r.callId, r.isError, r.output]) : [], [
    ["toolu_1", false, "hello"],
    ["toolu_2", true, "Error: denied"],
  ]);

  // A later prompt only appends: the earlier items are byte-for-byte the same.
  store.upsertEntry("a1", user("t2s0", 6, 2, "thanks"), true);
  const second = harness.buildConversation("a1");
  assert.equal(second.length, 5);
  assert.equal(JSON.stringify(second.slice(0, 4)), JSON.stringify(first));

  const stripped = publicEntry(store.entries("a1")[1]);
  assert.equal("replay" in stripped, false);
  assert.equal("replay" in store.entries("a1")[1], true, "the box keeps it");
});

test("cloud agents get the cloud toolset and their own folder", async () => {
  const commands: Array<{ command: string; cwd: string }> = [];
  const files = new Map<string, string>([["/home/user/agents/a1/notes.md", "one\ntwo\nthree"]]);
  const cloud = {
    exec: async (command: string, options: { cwd: string; onOutput(chunk: string): void }) => {
      commands.push({ command, cwd: options.cwd });
      options.onOutput("hi\n");
      return { exitCode: 0, output: "hi\n", killedBy: null };
    },
    readText: async (path: string) => files.get(path) ?? Promise.reject(new Error(`missing ${path}`)),
    writeText: async (path: string, content: string) => void files.set(path, content),
    exists: async (path: string) => files.has(path),
    ensureDir: async () => undefined,
    list: async () => [],
  } as unknown as CloudComputer;
  const context = { agentId: "a1", cloud, signal: new AbortController().signal, progress: () => undefined };

  assert.equal(resolveCloudPath("", "a1"), "/home/user/agents/a1");
  assert.equal(resolveCloudPath("src/app.ts", "a1"), "/home/user/agents/a1/src/app.ts");
  assert.equal(resolveCloudPath("~/x", "a1"), "/home/user/x");
  assert.equal(resolveCloudPath("/etc/hosts", "a1"), "/etc/hosts");

  const shell = await CLOUD_TOOLS.run_shell.run({ command: "echo hi" }, context);
  assert.equal(shell.output, "hi\n\nExit code 0.");
  assert.deepEqual(commands[0], { command: "echo hi", cwd: "/home/user/agents/a1" });

  const read = await CLOUD_TOOLS.read_file.run({ path: "notes.md", offset: 2, limit: 1 }, context);
  assert.match(read.output, /\(3 lines\)\n\s+2\ttwo\n…\(1 more lines; continue with offset 3\)/);

  const edit = await CLOUD_TOOLS.edit_file.run({ path: "notes.md", old_string: "two", new_string: "2" }, context);
  assert.equal(edit.isError, undefined);
  assert.equal(files.get("/home/user/agents/a1/notes.md"), "one\n2\nthree");

  await CLOUD_TOOLS.search_files.run({ pattern: "it's", glob: "**/*.md" }, context);
  assert.match(commands[1].command, /^grep -rnIE .*--include='\*\.md' -e 'it'\\''s' '\/home\/user\/agents\/a1' \| head -n 100$/);

  assert.deepEqual(
    cloudToolSpecs("headless").map((spec) => spec.function.name),
    ["run_shell", "await_command", "stop_command", "read_file", "list_directory", "search_files", "write_file", "edit_file"],
  );
  assert.ok(cloudToolSpecs("desktop").some((spec) => spec.function.name === "computer_click"));
});

test("interrupting a run waiting on the user settles it as cancelled", async () => {
  const { store, harness } = setup();
  harness.submitPrompt("a1", { prompt: '/tool ask_user {"question":"Proceed?"}', attachmentPaths: [], attachmentNames: [], clientNonce: "n3", source: "user" });
  await until(() => store.getAgent("a1")!.awaitingUserResponse != null);
  assert.equal(harness.interrupt("a1"), true);
  await until(() => !store.getAgent("a1")!.isRunning);
  assert.equal(store.getAgent("a1")!.lastTurnSettlement?.outcome, "cancelled");
  assert.ok(store.entries("a1").some((e) => e.kind === "notice" && e.text === "Stopped."));
});

const lastReply = (store: BoxStore) => [...store.entries("a1")].reverse().find((e): e is MessageEntry => e.kind === "message" && e.role === "assistant" && e.content.length > 0);
const activities = (events: Array<{ channel: string; payload: any }>) => events.filter((e) => e.channel === "agent-saved").map((e) => (e.payload.agent as AgentSummary).currentActivity);

test("a search shows as the searching activity and its sources stay on the reply", async () => {
  const { store, harness, events } = setup();
  harness.submitPrompt("a1", { prompt: "/search starship launch", attachmentPaths: [], attachmentNames: [], clientNonce: "s1", source: "user" });
  await until(() => !store.getAgent("a1")!.isRunning);
  assert.deepEqual(
    activities(events).filter((activity) => activity?.kind === "searching"),
    [
      { kind: "searching", tool: "web_search", detail: "starship launch" },
      { kind: "searching", tool: "x_search", detail: "starship launch" },
    ],
  );
  const reply = lastReply(store)!;
  assert.match(reply.content, /\[\[1\]\]\(https:\/\/example\.com\/starship-launch\)/);
  assert.deepEqual(reply.sources?.map((source) => [source.url, source.cited]), [
    ["https://example.com/starship-launch", true],
    ["https://x.com/example/status/1", true],
    ["https://example.org/background", false],
  ]);
  assert.deepEqual(publicEntry(reply).sources, reply.sources, "sources reach the app");

  // With web search off the same prompt is only text.
  const off = setup({ ...MOCK_MODELS, webSearch: false });
  off.harness.submitPrompt("a1", { prompt: "/search starship launch", attachmentPaths: [], attachmentNames: [], clientNonce: "s2", source: "user" });
  await until(() => !off.store.getAgent("a1")!.isRunning);
  assert.equal(lastReply(off.store)?.sources, undefined);
  assert.equal(activities(off.events).some((activity) => activity?.kind === "searching"), false);
});

test("a turn Anthropic's search loop paused is sent back as it was and continued", async () => {
  const requests: any[] = [];
  const message = (id: string) => ({ id, type: "message", role: "assistant", content: [], model: "claude-opus-5-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } });
  const paused = { type: "server_tool_use", id: "srvtoolu_p", name: "web_search", input: { query: "claude shannon born" } };
  const result = { type: "web_search_tool_result", tool_use_id: "srvtoolu_p", content: [{ type: "web_search_result", url: "https://en.wikipedia.org/wiki/Claude_Shannon", title: "Claude Shannon - Wikipedia", encrypted_content: "E", page_age: null }] };
  const citation = { type: "web_search_result_location", url: "https://en.wikipedia.org/wiki/Claude_Shannon", title: "Claude Shannon - Wikipedia", encrypted_index: "I", cited_text: "April 30, 1916" };
  const responses = [
    [
      { type: "message_start", message: message("msg_1") },
      { type: "content_block_start", index: 0, content_block: { ...paused, input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(paused.input) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "pause_turn", stop_sequence: null }, usage: { output_tokens: 8 } },
      { type: "message_stop" },
    ],
    [
      { type: "message_start", message: message("msg_2") },
      { type: "content_block_start", index: 0, content_block: result },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "", citations: [] } },
      { type: "content_block_delta", index: 1, delta: { type: "citations_delta", citation } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "He was born on April 30, 1916." } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ],
  ];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      requests.push(JSON.parse(raw));
      const events = responses[Math.min(requests.length, responses.length) - 1];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // The box's Anthropic connection has no address of its own; the SDK reads this one.
  const previous = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { store, harness, events } = setup({ ...MOCK_MODELS, defaultModel: { provider: "anthropic", model: "claude-opus-5-5" }, anthropic: { apiKey: "sk-ant-test" } });
    harness.submitPrompt("a1", { prompt: "When was Claude Shannon born?", attachmentPaths: [], attachmentNames: [], clientNonce: "p1", source: "user" });
    await until(() => !store.getAgent("a1")!.isRunning);

    assert.equal(requests.length, 2, "the paused turn is continued once");
    const continued = requests[1].messages;
    assert.deepEqual(continued[continued.length - 1], { role: "assistant", content: [paused] }, "the paused content goes back unchanged, last");
    assert.ok(requests[1].tools.some((tool: { type: string }) => tool.type === "web_search_20250305"), "with the tool it may still run");
    assert.ok(activities(events).some((activity) => activity?.kind === "searching" && activity.detail === "claude shannon born"));

    const reply = lastReply(store)!;
    assert.equal(reply.content, "He was born on April 30, 1916.");
    assert.deepEqual(reply.sources, [{ url: "https://en.wikipedia.org/wiki/Claude_Shannon", title: "Claude Shannon - Wikipedia", cited: true }]);
    assert.equal(store.getAgent("a1")!.lastTurnSettlement?.outcome, "success");
    assert.equal(store.entries("a1").some((e) => e.kind === "notice"), false);
  } finally {
    if (previous == null) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previous;
    server.close();
  }
});
