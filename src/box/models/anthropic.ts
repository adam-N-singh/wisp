// Anthropic Messages API through the official SDK (`@anthropic-ai/sdk`).
//
// - Adaptive thinking with summarized display on current models, so the UI can
//   show the reasoning; thinking blocks are replayed unchanged on later steps.
// - The history is append-only, but tools or the system prompt can change when
//   an MCP server or the local tools reconnect, so thinking blocks that no longer
//   match their conversation are dropped instead of failing the request
//   (`prefix_mismatch_behavior: "drop_block"`).
// - Server-side refusal fallbacks (`fallbacks: "default"`) on the models that support them.
// - Top-level prompt caching on every request.
// - Web search through Anthropic's server tool. Its `server_tool_use` and
//   `web_search_tool_result` blocks (encrypted results) and the citations on the
//   reply's text are replayed with the step's other blocks; a turn the search
//   loop paused (`pause_turn`) is continued by sending it back unchanged.
import Anthropic from "@anthropic-ai/sdk";
import type { ReplayState, WebSource } from "../../shared/model";
import { type ConvItem, mergeSources, type ModelRequest, ModelError, refusedSearch, type ResolvedModel, type StreamEvent, type ToolCall, type ToolSpec } from "./types";

type Model = Extract<ResolvedModel, { kind: "anthropic" }>;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;

const MAX_TOKENS = 64_000;
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

/**
 * The basic web search tool, called by the model directly. The `_20260209` and later versions
 * filter results with code execution in an Anthropic sandbox ("dynamic filtering"): agents here
 * already have a shell and files on the user's PC, which a second, hidden computer would muddle
 * (Anthropic's code execution docs warn about exactly that), and those versions aren't ZDR-eligible.
 */
const WEB_SEARCH_TOOL: Anthropic.Beta.Messages.BetaWebSearchTool20250305 = { type: "web_search_20250305", name: "web_search" };

/** Which request features a model takes (adaptive thinking, effort, server-side fallbacks). */
export function anthropicCapabilities(model: string): { adaptive: boolean; effort: boolean; fallbacks: boolean } {
  const match = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:$|-)/.exec(model);
  if (match == null) return { adaptive: false, effort: false, fallbacks: false };
  const family = match[1];
  const version = Number(match[2]) + (match[3] != null ? Number(match[3]) / 10 : 0);
  const adaptive = family === "fable" || family === "mythos" || (family === "haiku" ? version >= 5 : version >= 4.6);
  return { adaptive, effort: adaptive || (family === "opus" && version >= 4.5), fallbacks: FALLBACK_MODELS.has(model) };
}

export function toAnthropicMessages(items: ConvItem[], options: { webSearch?: boolean } = {}): MessageParam[] {
  const messages: MessageParam[] = [];
  const answered = answeredServerCalls(items);
  items.forEach((item, index) => {
    if (item.kind === "user") {
      messages.push({
        role: "user",
        content: item.parts.map((part): ContentBlockParam =>
          part.type === "text" ? { type: "text", text: part.text } : { type: "image", source: { type: "base64", media_type: imageMediaType(part.image.mime), data: part.image.base64 } },
        ),
      });
    } else if (item.kind === "assistant") {
      // Replay the step's own blocks (thinking signatures, search results and citations included)
      // unchanged; the API drops any it can't use. Without the search tool in the request, a step
      // that searched is sent as its text and tool calls.
      const blocks = item.replay?.provider === "anthropic" ? (item.replay.items as ContentBlockParam[]) : null;
      const content: ContentBlockParam[] =
        blocks != null && (options.webSearch === true || !blocks.some(usedSearch))
          ? withoutStrandedServerCalls(blocks, answered, isOpenTurn(items, index))
          : [
              ...(item.text.length > 0 ? [{ type: "text" as const, text: item.text }] : []),
              ...item.toolCalls.map((call): ContentBlockParam => ({ type: "tool_use", id: call.id, name: call.function.name, input: parseArgs(call.function.arguments) })),
            ];
      if (content.length > 0) messages.push({ role: "assistant", content });
    } else {
      messages.push({
        role: "user",
        content: item.results.map(
          (result): ContentBlockParam => ({
            type: "tool_result",
            tool_use_id: result.callId,
            is_error: result.isError,
            content: [
              { type: "text", text: result.output.length > 0 ? result.output : "(no output)" },
              ...(result.image != null ? [{ type: "image" as const, source: { type: "base64" as const, media_type: imageMediaType(result.image.mime), data: result.image.base64 } }] : []),
            ],
          }),
        ),
      });
    }
  });
  return messages;
}

/** A block from the search tool, or text citing its results. */
function usedSearch(block: ContentBlockParam): boolean {
  if (block.type === "server_tool_use" || block.type === "web_search_tool_result") return true;
  return block.type === "text" && (block.citations ?? []).some((citation) => citation.type === "web_search_result_location");
}

/** Ids of server tool calls whose result block is somewhere in the history (a deferred call's arrives in the next step). */
function answeredServerCalls(items: ConvItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.kind !== "assistant" || item.replay?.provider !== "anthropic") continue;
    for (const block of item.replay.items as Array<{ type?: string; tool_use_id?: unknown }>) {
      if (block.type !== "tool_result" && typeof block.tool_use_id === "string") ids.add(block.tool_use_id);
    }
  }
  return ids;
}

/** This request continues the step's turn: it is the last item (a paused turn), or only its tool results follow. */
function isOpenTurn(items: ConvItem[], index: number): boolean {
  return index === items.length - 1 || (index === items.length - 2 && items[index + 1].kind === "tool-results");
}

/**
 * A server tool call that never got its result (the run stopped before the search ran) makes
 * every later request fail, so it is left out unless this request continues its turn.
 */
function withoutStrandedServerCalls(blocks: ContentBlockParam[], answered: Set<string>, open: boolean): ContentBlockParam[] {
  return open ? blocks : blocks.filter((block) => block.type !== "server_tool_use" || answered.has(block.id));
}

function toAnthropicTools(tools: ToolSpec[]): Anthropic.Beta.Messages.BetaTool[] {
  return tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters as Anthropic.Beta.Messages.BetaTool.InputSchema }));
}

/** Cited pages from the text's search citations, then the other pages the searches returned. */
function messageSources(content: Anthropic.Beta.Messages.BetaContentBlock[]): WebSource[] {
  const found: WebSource[] = [];
  for (const block of content) {
    if (block.type === "text") {
      for (const citation of block.citations ?? []) {
        if (citation.type === "web_search_result_location") found.push({ url: citation.url, ...(citation.title != null ? { title: citation.title } : {}), cited: true });
      }
    } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const result of block.content) found.push({ url: result.url, title: result.title, cited: false });
    }
  }
  return mergeSources([], found);
}

const searchKey = (model: Model) => `anthropic|${model.baseUrl ?? ""}|${model.ref.model}`;

function imageMediaType(mime: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" {
  return mime === "image/jpeg" || mime === "image/gif" || mime === "image/webp" ? mime : "image/png";
}

function parseArgs(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text || "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function client(model: Model): Anthropic {
  return new Anthropic({ apiKey: model.apiKey, maxRetries: 2, ...(model.baseUrl != null ? { baseURL: model.baseUrl } : {}) });
}

export async function* streamAnthropic(model: Model, request: ModelRequest): AsyncGenerator<StreamEvent> {
  const caps = anthropicCapabilities(model.ref.model);
  const betas: string[] = [];
  if (caps.adaptive) betas.push("thinking-binding-controls-2026-08-01");
  if (caps.fallbacks) betas.push("server-side-fallback-2026-07-01");
  /** `replaySearch` false sends earlier steps that searched as their text (see toAnthropicMessages). */
  const params = (webSearch: boolean, replaySearch: boolean): Anthropic.Beta.Messages.MessageCreateParamsStreaming => {
    const tools: Anthropic.Beta.Messages.BetaToolUnion[] = [...toAnthropicTools(request.tools), ...(webSearch ? [WEB_SEARCH_TOOL] : [])];
    return {
      model: model.ref.model,
      max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: request.system }],
      messages: toAnthropicMessages(request.items, { webSearch: webSearch && replaySearch }),
      ...(tools.length > 0 ? { tools } : {}),
      cache_control: { type: "ephemeral" },
      ...(caps.adaptive ? { thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } } } : {}),
      ...(caps.effort && model.effort !== "default" ? { output_config: { effort: model.effort } } : {}),
      ...(caps.fallbacks ? { fallbacks: "default" } : {}),
      ...(betas.length > 0 ? { betas } : {}),
      stream: true,
    };
  };

  let webSearch = model.webSearch === true && !refusedSearch.has(searchKey(model));
  let replaySearch = true;
  let message: Anthropic.Beta.Messages.BetaMessage | null = null;
  while (message == null) {
    let started = false;
    try {
      const stream = client(model).beta.messages.stream(params(webSearch, replaySearch), { signal: request.signal });
      // Search calls by block index, with their input as it streams; the search runs once the block ends.
      const searches = new Map<number, string>();
      for await (const event of stream) {
        started = true;
        if (event.type === "content_block_start") {
          if (event.content_block.type === "server_tool_use" && event.content_block.name === "web_search") {
            searches.set(event.index, "");
            yield { type: "search", source: "web", query: null };
          }
        } else if (event.type === "content_block_stop") {
          const input = searches.get(event.index);
          if (input == null) continue;
          searches.delete(event.index);
          const query = searchQuery(input);
          if (query != null) yield { type: "search", source: "web", query };
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta" && event.delta.text.length > 0) yield { type: "text", delta: event.delta.text };
          else if (event.delta.type === "thinking_delta" && event.delta.thinking.length > 0) yield { type: "reasoning", delta: event.delta.thinking };
          else if (event.delta.type === "input_json_delta" && searches.has(event.index)) searches.set(event.index, (searches.get(event.index) ?? "") + event.delta.partial_json);
        }
      }
      message = await stream.finalMessage();
    } catch (error) {
      if (request.signal.aborted) return;
      const failure = toModelError(error);
      if (started || failure.status !== 400) throw failure;
      // Earlier search blocks the API won't take back: send those steps as their text.
      if (webSearch && replaySearch && /tool use with id|web_search_tool_result/i.test(failure.body)) {
        replaySearch = false;
        continue;
      }
      // An account (web search off in the Console) or model that doesn't take the tool refuses the whole request.
      if (webSearch && /web[_ ]search/i.test(failure.body)) {
        webSearch = false;
        refusedSearch.add(searchKey(model));
        yield { type: "notice", text: `Anthropic didn't accept web search for ${model.ref.model}, so it answers without searching until the app restarts: ${failure.body.slice(0, 300)}` };
        continue;
      }
      throw failure;
    }
  }

  const usage = message.usage;
  yield { type: "usage", inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), outputTokens: usage.output_tokens ?? 0, cachedTokens: usage.cache_read_input_tokens ?? 0 };
  const sources = messageSources(message.content);
  if (sources.length > 0) yield { type: "sources", sources };
  const replay: ReplayState = { provider: "anthropic", model: model.ref.model, items: message.content as unknown[] };
  yield { type: "replay", state: replay };

  if (message.stop_reason === "refusal") {
    const details = (message as { stop_details?: { category?: string | null; explanation?: string | null } | null }).stop_details;
    yield { type: "done", finishReason: "refusal", detail: details?.explanation ?? details?.category ?? undefined };
    return;
  }
  const calls: ToolCall[] = message.content
    .filter((block): block is Anthropic.Beta.Messages.BetaToolUseBlock => block.type === "tool_use")
    .map((block) => ({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }));
  // The calls are always reported, so each tool_use in the replayed content gets
  // a result; on "length" the harness records them as not run (cut-off input must not run).
  for (const call of calls) yield { type: "tool-call", call };
  if (message.stop_reason === "max_tokens") {
    yield { type: "done", finishReason: "length", ...(calls.length > 0 ? { detail: "The reply hit the output limit in the middle of a tool call." } : {}) };
    return;
  }
  // The server-side search loop paused a long turn; sending this content back continues it.
  if (message.stop_reason === "pause_turn" && calls.length === 0) {
    yield { type: "done", finishReason: "pause_turn" };
    return;
  }
  yield { type: "done", finishReason: calls.length > 0 ? "tool_calls" : "stop" };
}

function searchQuery(input: string): string | null {
  try {
    const query = (JSON.parse(input) as { query?: unknown }).query;
    return typeof query === "string" && query.length > 0 ? query : null;
  } catch {
    return null;
  }
}

function toModelError(error: unknown): ModelError {
  if (error instanceof Anthropic.APIError) {
    const body = error.error as { error?: { type?: string; message?: string } } | undefined;
    return new ModelError(error.status ?? 500, body?.error?.message ?? error.message, body?.error?.type ?? null, "Anthropic");
  }
  return new ModelError(500, error instanceof Error ? error.message : String(error), null, "Anthropic");
}

export async function listAnthropicModels(model: Model): Promise<Array<{ id: string; label?: string }>> {
  try {
    const models: Array<{ id: string; label?: string }> = [];
    for await (const entry of client(model).models.list({ limit: 100 })) models.push({ id: entry.id, label: entry.display_name });
    return models;
  } catch (error) {
    throw toModelError(error);
  }
}
