// Speech in the box: transcribing dictation and voice memos, and reading replies aloud, with a
// connected provider's own speech APIs (checked against their docs on 2026-10-25):
//   - xAI, with an API key: POST {base}/stt, multipart with the options first and the file last,
//     answers {text, language, duration, words: [{text, start, end}]} (seconds). POST {base}/tts,
//     JSON {text, voice_id, language}, answers MP3. GET {base}/tts/voices lists its voices.
//   - OpenAI, with an API key: POST {base}/audio/transcriptions, multipart with model
//     gpt-transcribe and optional languages[], answers {text}. POST {base}/audio/speech, JSON
//     {model, input, voice, response_format}, answers MP3; it reads at most 4,096 characters.
// A ChatGPT plan sign-in only reaches /v1/responses, so it can neither transcribe nor speak.
//
// Transcription prefers the agent's own provider, so a recording goes where its conversation
// already goes; otherwise xAI (Grok's own speech recognition), then OpenAI. xAI doesn't list WebM
// among its formats, so a WebM recording goes to OpenAI when both are connected. Replies are read
// in the agent's voice, by that voice's provider, in parts: a short first one so reading starts
// quickly, then up to 3,500 characters each.
import type { BoxModelConfig } from "../shared/edges";
import { MAX_TRANSCRIBE_BYTES, parseVoiceId, type ProviderId, type SpeechProvider, type TranscriptWord, type VoiceCapabilities, type VoiceOption, type VoiceTranscription } from "../shared/model";
import { readErrorBody } from "./models";

export type VoiceErrorCode = "unavailable" | "empty" | "too-large" | "provider";

/** A speech request that can't be done; the message is for the user. */
export class VoiceError extends Error {
  constructor(
    readonly code: VoiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VoiceError";
  }
}

interface SpeechConnection {
  provider: SpeechProvider;
  baseUrl: string;
  apiKey: string;
}

const LABEL: Record<SpeechProvider, string> = { xai: "xAI", openai: "OpenAI" };
const REQUEST_TIMEOUT_MS = 100_000;
const OPENAI_TRANSCRIBE_MODEL = "gpt-transcribe";
const OPENAI_SPEECH_MODEL = "gpt-4o-mini-tts";
const DEFAULT_VOICE: Record<SpeechProvider, string> = { xai: "eve", openai: "marin" };
/** OpenAI recommends marin and cedar; the rest are its other built-in voices. */
const OPENAI_VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];
/** xAI's voices when its list can't be read. */
const XAI_VOICES = ["eve", "ara", "rex", "sal", "leo"];
const FIRST_PART_CHARS = 300;
const PART_CHARS = 3_500;
const MAX_PARTS = 60;
const MAX_WORDS = 20_000;

/** The providers connected with what speech needs: an API key. */
export function speechConnections(models: BoxModelConfig | null): SpeechConnection[] {
  const connections: SpeechConnection[] = [];
  if (models?.xai != null && models.xai.apiKey.length > 0) connections.push({ provider: "xai", baseUrl: models.xai.baseUrl.replace(/\/+$/, ""), apiKey: models.xai.apiKey });
  if (models?.openai?.auth === "api-key" && models.openai.apiKey.length > 0) connections.push({ provider: "openai", baseUrl: models.openai.baseUrl.replace(/\/+$/, ""), apiKey: models.openai.apiKey });
  return connections;
}

/** Why no provider can do it, and what to connect. */
function unavailable(models: BoxModelConfig | null, task: string): string {
  const plan = models?.openai?.auth === "chatgpt" ? " A ChatGPT plan sign-in can’t do it: it only reaches OpenAI’s Responses API." : "";
  return `${task} needs an xAI API key or an OpenAI API key.${plan} Add one in Settings → Models.`;
}

const ordered = (connections: SpeechConnection[], first: ProviderId | SpeechProvider | null | undefined) =>
  [...connections].sort((a, b) => Number(b.provider === first) - Number(a.provider === first));

/** Who transcribes: the agent's provider when it can, xAI, then OpenAI; OpenAI first for WebM, which xAI doesn't list. */
export function transcriber(models: BoxModelConfig | null, prefer?: ProviderId | null, mime?: string | null): SpeechConnection | null {
  const connections = ordered(speechConnections(models), prefer);
  if (/webm/i.test(mime ?? "")) return connections.find((connection) => connection.provider === "openai") ?? connections[0] ?? null;
  return connections[0] ?? null;
}

/** Who reads aloud, and in which voice: the chosen voice's provider when it's connected, else the agent's provider, xAI, OpenAI. */
export function speaker(models: BoxModelConfig | null, voiceId?: string | null, prefer?: ProviderId | null): { connection: SpeechConnection; voice: string } | null {
  const chosen = parseVoiceId(voiceId);
  const connected = speechConnections(models);
  const connection = ordered(connected, chosen != null && connected.some((candidate) => candidate.provider === chosen.provider) ? chosen.provider : prefer)[0];
  if (connection == null) return null;
  return { connection, voice: chosen != null && chosen.provider === connection.provider ? chosen.voice : DEFAULT_VOICE[connection.provider] };
}

const EXTENSIONS: Array<[RegExp, string]> = [
  [/mp4|m4a|aac/i, "m4a"],
  [/webm/i, "webm"],
  [/ogg|opus/i, "ogg"],
  [/mpeg|mp3/i, "mp3"],
  [/wav/i, "wav"],
  [/flac/i, "flac"],
];

/** A file name whose extension matches the recording (OpenAI reads the format from it). */
export function audioFileName(mime: string): string {
  const base = mime.split(";")[0].trim();
  if (base === "audio/aac") return "recording.aac";
  return `recording.${EXTENSIONS.find(([pattern]) => pattern.test(base))?.[1] ?? "m4a"}`;
}

/** Language hints as each provider takes them: "en-US" -> "en". */
const languageCode = (language: string | undefined) => {
  const code = language?.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return /^[a-z]{2,3}$/.test(code) ? code : undefined;
};

async function failure(response: Response, connection: SpeechConnection, task: string): Promise<VoiceError> {
  const { message } = await readErrorBody(response);
  const who = LABEL[connection.provider];
  if (response.status === 401 || response.status === 403) return new VoiceError("provider", `${who} rejected the API key (${response.status}). Check Settings → Models.`);
  if (response.status === 413) return new VoiceError("too-large", `The recording is too large for ${who}. Record a shorter one.`);
  if (response.status === 429) return new VoiceError("provider", `${who} is rate-limiting requests. Try again shortly.`);
  return new VoiceError("provider", `${who} couldn’t ${task} (${response.status}): ${message.slice(0, 300)}`);
}

const deadline = (signal?: AbortSignal) => (signal != null ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS));

async function post(connection: SpeechConnection, path: string, body: FormData | string, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(`${connection.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${connection.apiKey}`, ...(typeof body === "string" ? { "content-type": "application/json" } : {}) },
      body,
      signal: deadline(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new VoiceError("provider", `${LABEL[connection.provider]} didn’t answer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function words(raw: unknown): TranscriptWord[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list: TranscriptWord[] = [];
  for (const word of raw.slice(0, MAX_WORDS)) {
    const text = typeof word?.text === "string" ? word.text : typeof word?.word === "string" ? word.word : null;
    if (text == null || typeof word.start !== "number" || typeof word.end !== "number") continue;
    list.push({ text, startMs: Math.round(word.start * 1000), endMs: Math.round(word.end * 1000) });
  }
  return list.length > 0 ? list : undefined;
}

/** Turns a recording into text with the provider `transcriber` picks. */
export async function transcribe(
  models: BoxModelConfig | null,
  audio: { bytes: Uint8Array; mime: string },
  options: { language?: string; prefer?: ProviderId | null; signal?: AbortSignal } = {},
): Promise<VoiceTranscription> {
  if (audio.bytes.byteLength === 0) throw new VoiceError("empty", "The recording is empty.");
  if (audio.bytes.byteLength > MAX_TRANSCRIBE_BYTES) throw new VoiceError("too-large", "Recordings over 25 MB can’t be transcribed. Record a shorter one.");
  const connection = transcriber(models, options.prefer, audio.mime);
  if (connection == null) throw new VoiceError("unavailable", unavailable(models, "Transcribing speech"));
  const started = Date.now();
  const language = languageCode(options.language);
  const form = (withLanguage: boolean) => {
    const body = new FormData();
    if (connection.provider === "openai") body.append("model", OPENAI_TRANSCRIBE_MODEL);
    if (withLanguage && language != null) {
      if (connection.provider === "xai") {
        // The language also turns on xAI's formatting (numbers, amounts, dates as written).
        body.append("language", language);
        body.append("format", "true");
      } else body.append("languages[]", language);
    }
    // xAI reads options sent before the file; the file goes last for both.
    body.append("file", new Blob([new Uint8Array(audio.bytes)], { type: audio.mime.split(";")[0] }), audioFileName(audio.mime));
    return body;
  };
  const path = connection.provider === "xai" ? "/stt" : "/audio/transcriptions";
  let response = await post(connection, path, form(true), options.signal);
  // A language the provider doesn't take is refused outright; the recording may still be fine without it.
  if (response.status === 400 && language != null) response = await post(connection, path, form(false), options.signal);
  if (!response.ok) throw await failure(response, connection, "transcribe the recording");
  const body = (await response.json().catch(() => ({}))) as { text?: unknown; language?: unknown; duration?: unknown; words?: unknown; languages?: Array<{ code?: unknown }>; usage?: { seconds?: unknown } };
  const seconds = typeof body.duration === "number" ? body.duration : typeof body.usage?.seconds === "number" ? body.usage.seconds : null;
  const detected = typeof body.language === "string" ? body.language : typeof body.languages?.[0]?.code === "string" ? (body.languages[0].code as string) : undefined;
  const timed = words(body.words);
  return {
    text: typeof body.text === "string" ? body.text.trim() : "",
    transcriptionTimeMs: Date.now() - started,
    provider: connection.provider,
    ...(seconds != null ? { durationMs: Math.round(seconds * 1000) } : {}),
    ...(detected != null ? { language: detected } : {}),
    ...(timed != null ? { words: timed } : {}),
  };
}

/** Speaks `text` in the voice `speaker` picks; MP3 from both providers. */
export async function synthesize(
  models: BoxModelConfig | null,
  request: { text: string; voiceId?: string | null; language?: string; prefer?: ProviderId | null; signal?: AbortSignal },
): Promise<{ bytes: Buffer; mime: string; voiceId: string }> {
  const chosen = speaker(models, request.voiceId, request.prefer);
  if (chosen == null) throw new VoiceError("unavailable", unavailable(models, "Reading replies aloud"));
  const { connection, voice } = chosen;
  const text = request.text.trim();
  if (text.length === 0) throw new VoiceError("empty", "There’s nothing to read aloud.");
  const body =
    connection.provider === "xai"
      ? { text, voice_id: voice, language: request.language?.trim() || "auto" }
      : { model: OPENAI_SPEECH_MODEL, input: text, voice, response_format: "mp3" };
  const response = await post(connection, connection.provider === "xai" ? "/tts" : "/audio/speech", JSON.stringify(body), request.signal);
  if (!response.ok) throw await failure(response, connection, "read it aloud");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new VoiceError("provider", `${LABEL[connection.provider]} sent back no audio.`);
  const type = response.headers.get("content-type")?.split(";")[0].trim();
  return { bytes, mime: type != null && type.startsWith("audio/") ? type : "audio/mpeg", voiceId: `${connection.provider}:${voice}` };
}

const voiceLabel = (voice: string) => voice.charAt(0).toUpperCase() + voice.slice(1);
const xaiVoiceCache = new Map<string, { voices: VoiceOption[]; at: number }>();

async function xaiVoices(connection: SpeechConnection): Promise<VoiceOption[]> {
  const key = `${connection.baseUrl}\u0000${connection.apiKey.slice(-6)}`;
  const cached = xaiVoiceCache.get(key);
  if (cached != null && Date.now() - cached.at < 10 * 60_000) return cached.voices;
  let voices = XAI_VOICES.map((voice): VoiceOption => ({ id: `xai:${voice}`, provider: "xai", voice, label: voiceLabel(voice) }));
  try {
    const response = await fetch(`${connection.baseUrl}/tts/voices`, { headers: { authorization: `Bearer ${connection.apiKey}` }, signal: AbortSignal.timeout(10_000) });
    const body = (await response.json()) as { voices?: Array<{ voice_id?: unknown; name?: unknown }> };
    const listed = (body.voices ?? []).flatMap((entry) =>
      typeof entry.voice_id === "string" && parseVoiceId(`xai:${entry.voice_id}`) != null
        ? [{ id: `xai:${entry.voice_id}`, provider: "xai" as const, voice: entry.voice_id, label: typeof entry.name === "string" && entry.name.trim().length > 0 ? entry.name.trim() : voiceLabel(entry.voice_id) }]
        : [],
    );
    if (response.ok && listed.length > 0) voices = listed;
  } catch {
    // the built-in names still work
  }
  xaiVoiceCache.set(key, { voices, at: Date.now() });
  return voices;
}

/** Every voice the connected providers can read in, xAI's first. */
export async function listVoices(models: BoxModelConfig | null): Promise<VoiceOption[]> {
  const lists = await Promise.all(
    speechConnections(models).map((connection) =>
      connection.provider === "xai" ? xaiVoices(connection) : Promise.resolve(OPENAI_VOICES.map((voice): VoiceOption => ({ id: `openai:${voice}`, provider: "openai", voice, label: voiceLabel(voice) }))),
    ),
  );
  return lists.flat();
}

/** What speech the box can do for an agent on `prefer`'s provider, in `voiceId`. */
export async function voiceCapabilities(models: BoxModelConfig | null, prefer?: ProviderId | null, voiceId?: string | null): Promise<VoiceCapabilities> {
  const listener = transcriber(models, prefer);
  const reader = speaker(models, voiceId, prefer);
  const fallback = speaker(models, null, prefer);
  return {
    transcription: listener != null ? { provider: listener.provider } : null,
    transcriptionUnavailable: listener == null ? unavailable(models, "Transcribing speech") : null,
    speech:
      reader != null && fallback != null
        ? { provider: reader.connection.provider, voiceId: `${reader.connection.provider}:${reader.voice}`, defaultVoiceId: `${fallback.connection.provider}:${fallback.voice}` }
        : null,
    speechUnavailable: reader == null ? unavailable(models, "Reading replies aloud") : null,
    voices: await listVoices(models),
  };
}

const GREETINGS: Record<string, string> = {
  default: "Hi! This is how I’ll sound when I read my replies to you.",
  short: "Hi there!",
};

/** What `sampleVoice` says. */
export const greetingText = (greetingId: string) => GREETINGS[greetingId] ?? GREETINGS.default;

/**
 * A Markdown reply as it should be heard: code blocks and URLs aren't read out, links read as
 * their text, and formatting marks, list bullets, table pipes and citation numbers go.
 */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, "\nCode omitted.\n")
    .replace(/\[\[\d+\]\]\([^)]*\)/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    .replace(/<?\bhttps?:\/\/(?:www\.)?([^\s/<>)]+)(?:[^\s<>)]*[^\s<>).,;:!?])?>?/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/^[ \t]*\|?([ \t]*:?-{2,}:?[ \t]*\|)+[ \t]*:?-*:?[ \t]*\|?[ \t]*$/gm, "")
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_line, cells: string) => cells.split("|").map((cell) => cell.trim()).filter(Boolean).join(", ") + ".")
    .replace(/[ \t]\|[ \t]/g, ", ")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Where to cut `text` at most `limit` characters in: after a sentence, a line or a word. */
function cutAt(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  const window = text.slice(0, limit);
  const sentence = Math.max(...[...window.matchAll(/[.!?…。！？](?=\s)|\n/g)].map((match) => (match.index ?? 0) + match[0].length), -1);
  if (sentence >= limit * 0.4) return sentence;
  const space = window.lastIndexOf(" ");
  return space >= limit * 0.4 ? space : limit;
}

/** The parts a reply is read in: a short first part so it starts quickly, then longer ones. */
export function speechParts(text: string): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > 0 && parts.length < MAX_PARTS) {
    const end = cutAt(rest, parts.length === 0 ? FIRST_PART_CHARS : PART_CHARS);
    const part = rest.slice(0, end).trim();
    if (part.length > 0) parts.push(part);
    rest = rest.slice(end).trim();
  }
  return parts;
}
