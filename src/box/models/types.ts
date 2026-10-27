// Provider-neutral conversation and streaming types. The harness builds a
// ModelRequest from the transcript; each adapter (Chat Completions, OpenAI
// Responses, Anthropic Messages, mock) converts it to its wire format and
// yields StreamEvents back.
import type { ModelRef, ReasoningEffort, ReplayState, WebSource } from "../../shared/model";

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ImagePart {
  mime: string;
  base64: string;
}

export type UserPart = { type: "text"; text: string } | { type: "image"; image: ImagePart };

export interface ToolResultItem {
  callId: string;
  name: string;
  /** Already formatted for the model (errors start with "Error:"). */
  output: string;
  isError: boolean;
  image: ImagePart | null;
}

/**
 * One conversation item. The transcript is append-only, so rebuilding the
 * items for each request yields the same prefix every time (prompt caches and
 * Anthropic's thinking-block binding both depend on that).
 */
export type ConvItem =
  | { kind: "user"; parts: UserPart[] }
  | { kind: "assistant"; text: string; toolCalls: ToolCall[]; replay: ReplayState | null }
  | { kind: "tool-results"; results: ToolResultItem[] };

export interface ModelRequest {
  system: string;
  items: ConvItem[];
  tools: ToolSpec[];
  signal: AbortSignal;
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedTokens: number }
  | { type: "replay"; state: ReplayState }
  /** The provider's own search started, or reported its query (null until it does). */
  | { type: "search"; source: "web" | "x"; query: string | null }
  /** What the provider's search returned and the reply cites; sent once the step finishes. */
  | { type: "sources"; sources: WebSource[] }
  /** Something the user should know about this request, shown as an info notice. */
  | { type: "notice"; text: string }
  /** finishReason: stop | tool_calls | length | refusal | pause_turn (continue the same turn) | … */
  | { type: "done"; finishReason: string; detail?: string };

export class ModelError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    /** Provider error code when there is one, e.g. subscription_sharing_usage_limit_exceeded. */
    readonly code: string | null = null,
    readonly provider: string = "model",
  ) {
    super(`${provider} request failed (${status}${code ? ` ${code}` : ""}): ${body}`);
    this.name = "ModelError";
  }
}

/** Which of the provider's own server-side search tools a request turns on. */
export interface SearchTools {
  web: boolean;
  /** xAI only: X posts and users. */
  x: boolean;
}

/**
 * A ModelRef bound to the connection that serves it. The Responses kind serves
 * OpenAI and, while its web search is on, xAI (whose search tools only exist on
 * its Responses API); `ref.provider` tells them apart.
 */
export type ResolvedModel =
  | { kind: "chat-completions"; ref: ModelRef; baseUrl: string; apiKey: string; temperature: number | null }
  | { kind: "responses"; ref: ModelRef; baseUrl: string; effort: ReasoningEffort; auth: ResponsesAuth; search?: SearchTools; temperature?: number | null }
  | { kind: "anthropic"; ref: ModelRef; apiKey: string; effort: ReasoningEffort; baseUrl?: string; webSearch?: boolean }
  | { kind: "claude-code"; ref: ModelRef; executable: string; effort: ReasoningEffort }
  | { kind: "mock"; ref: ModelRef; webSearch?: boolean };

/**
 * Connections (provider, endpoint and model) whose provider refused its own search tool: their
 * requests go without it until the box restarts, so each one isn't refused first.
 */
export const refusedSearch = new Set<string>();

const MAX_SOURCES = 60;

/** Adds sources by URL: a page cited anywhere counts as cited, the first title wins, cited pages come first. */
export function mergeSources(current: WebSource[] | undefined, more: WebSource[]): WebSource[] {
  const byUrl = new Map<string, WebSource>();
  for (const source of [...(current ?? []), ...more]) {
    if (!/^https?:\/\//i.test(source.url)) continue;
    const seen = byUrl.get(source.url);
    const title = seen?.title ?? (source.title?.trim() || undefined);
    byUrl.set(source.url, { url: source.url, ...(title != null ? { title } : {}), cited: (seen?.cited ?? false) || source.cited });
  }
  const all = [...byUrl.values()];
  return [...all.filter((source) => source.cited), ...all.filter((source) => !source.cited)].slice(0, MAX_SOURCES);
}

export type ResponsesAuth =
  | { type: "api-key"; apiKey: string }
  /** Sign in with ChatGPT: requests draw on the user's plan. */
  | { type: "chatgpt"; accessToken(forceRefresh: boolean): Promise<string> };

export function toDataUrl(image: ImagePart): string {
  return `data:${image.mime};base64,${image.base64}`;
}

/** Yields the `data:` payload of each Server-Sent Events block. */
export async function* sseData(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data.length > 0) yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Reads an HTTP error body into {message, code, param} across provider formats. */
export async function readErrorBody(response: Response): Promise<{ message: string; code: string | null; param: string | null }> {
  const text = await response.text().catch(() => "");
  try {
    const json = JSON.parse(text) as { error?: { message?: string; code?: string | null; param?: string | null; type?: string } | string; detail?: string; message?: string };
    if (typeof json.error === "object" && json.error != null) {
      return { message: json.error.message ?? text, code: json.error.code ?? json.error.type ?? null, param: json.error.param ?? null };
    }
    return { message: typeof json.error === "string" ? json.error : (json.detail ?? json.message ?? text), code: null, param: null };
  } catch {
    return { message: text.slice(0, 2000) || response.statusText, code: null, param: null };
  }
}
