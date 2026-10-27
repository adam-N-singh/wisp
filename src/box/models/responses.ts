// Responses API: OpenAI, used with an API key or with Sign in with ChatGPT
// (requests then draw on the user's ChatGPT plan), and xAI while its web search
// is on (xAI's `web_search` and `x_search` tools exist only on its Responses
// API; with search off xAI goes through Chat Completions). Requests are
// stateless (`store: false`): the full history goes in `input` each time, and
// reasoning items come back with `encrypted_content` so they can be replayed.
//
// ChatGPT plan route rules (developers.openai.com/siwc, "Preview limitations"):
// `store: false` and `stream: true` are required; no `temperature`,
// `max_output_tokens`, `previous_response_id` or system-role items (use
// `instructions`); function tools must be grouped in a namespace. Of the hosted
// tools only web search is allowed, "subject to model and account/workspace policy".
//
// Search: the provider runs it inside the response. Its calls come back as
// `web_search_call` items (xAI's X searches as `custom_tool_call` items whose
// call_id starts with "xs_") and its sources as `url_citation` annotations on the
// reply; both are replayed with the step like reasoning.
import type { ReplayState, WebSource } from "../../shared/model";
import { type ConvItem, mergeSources, type ModelRequest, ModelError, readErrorBody, refusedSearch, type ResolvedModel, sseData, type StreamEvent, toDataUrl, type ToolCall, type ToolSpec } from "./types";

type Model = Extract<ResolvedModel, { kind: "responses" }>;
type Flavor = "openai" | "xai";

export const TOOL_NAMESPACE = "wisp";
const SOURCES_INCLUDE = "web_search_call.action.sources";

/** OpenAI's reasoning models accept `reasoning` and return reasoning items; older chat models reject it. */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|gpt-6|gpt-7|o\d|codex)/i.test(model);
}

export interface ResponsesInputOptions {
  /** Whose items a replay must hold to be replayed (default "openai"). */
  provider?: Flavor;
  /** The request has search tools; a step that searched is replayed only then. */
  search?: boolean;
}

export function toResponsesInput(items: ConvItem[], model: string, namespaced: boolean, options: ResponsesInputOptions = {}): unknown[] {
  const provider = options.provider ?? "openai";
  const input: unknown[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      input.push({
        role: "user",
        content: item.parts.map((part) => (part.type === "text" ? { type: "input_text", text: part.text } : { type: "input_image", image_url: toDataUrl(part.image), detail: "auto" })),
      });
    } else if (item.kind === "assistant") {
      // Replay this model's own output items (reasoning and search calls included) when we have
      // them. Without search tools in the request, a step that searched is rebuilt from its text.
      const replay = item.replay;
      if (replay?.provider === provider && replay.model === model && (options.search === true || !replay.items.some(isSearchItem))) {
        input.push(...replay.items.map((entry) => adaptReplayedItem(entry, namespaced, provider)));
        continue;
      }
      if (item.text.length > 0) input.push({ role: "assistant", content: item.text });
      for (const call of item.toolCalls) {
        input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments || "{}", ...(namespaced ? { namespace: TOOL_NAMESPACE } : {}) });
      }
    } else {
      for (const result of item.results) input.push({ type: "function_call_output", call_id: result.callId, output: result.output });
      const images = item.results.filter((result) => result.image != null);
      if (images.length > 0) {
        input.push({
          role: "user",
          content: images.flatMap((result) => [
            { type: "input_text", text: `Image returned by ${result.name}:` },
            { type: "input_image", image_url: toDataUrl(result.image!), detail: "auto" },
          ]),
        });
      }
    }
  }
  return input;
}

/** A search the provider ran: a web search call, or one of xAI's X searches. */
function isSearchItem(entry: unknown): boolean {
  if (typeof entry !== "object" || entry == null) return false;
  const item = entry as Record<string, unknown>;
  return item.type === "web_search_call" || isXSearchCall(item);
}

function isXSearchCall(item: Record<string, unknown>): boolean {
  return item.type === "custom_tool_call" && (String(item.call_id ?? "").startsWith("xs_") || /^x_/.test(String(item.name ?? "")));
}

/**
 * OpenAI items are replayed without ids (nothing is stored server-side with store:false), except
 * search calls: their id and status are required fields, and the sources they listed are dropped
 * (the model doesn't read them back). xAI's items go back as they came, as its docs show.
 */
function adaptReplayedItem(entry: unknown, namespaced: boolean, provider: Flavor): unknown {
  if (typeof entry !== "object" || entry == null || provider === "xai") return entry;
  if ((entry as Record<string, unknown>).type === "web_search_call") {
    const { action, ...call } = entry as Record<string, unknown>;
    if (typeof action !== "object" || action == null) return call;
    const { sources: _sources, ...rest } = action as Record<string, unknown>;
    return { ...call, action: rest };
  }
  const { id: _id, status: _status, ...rest } = entry as Record<string, unknown>;
  if (rest.type === "function_call") {
    if (namespaced && rest.namespace == null) rest.namespace = TOOL_NAMESPACE;
    if (!namespaced) delete rest.namespace;
  }
  if (rest.type === "message" && Array.isArray(rest.content)) {
    rest.content = (rest.content as Array<Record<string, unknown>>).map(({ annotations: _a, logprobs: _l, ...part }) => part);
  }
  return rest;
}

export function toResponsesTools(tools: ToolSpec[], namespaced: boolean, provider: Flavor = "openai"): unknown[] {
  // xAI's function tools take no `strict`.
  const functions = tools.map((tool) => ({ type: "function", name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters, ...(provider === "openai" ? { strict: false } : {}) }));
  if (!namespaced || functions.length === 0) return functions;
  return [{ type: "namespace", name: TOOL_NAMESPACE, description: "Tools provided by the Wisp desktop app.", tools: functions }];
}

/** The provider's own search tools, after the function tools; none once the provider refused them for this connection. */
function searchTools(model: Model): unknown[] {
  const search = model.search;
  if (search == null || !search.web || refusedSearch.has(searchKey(model))) return [];
  if (model.ref.provider !== "xai") return [{ type: "web_search" }];
  return [{ type: "web_search" }, ...(search.x ? [{ type: "x_search" }] : [])];
}

const searchKey = (model: Model) => `${model.ref.provider}|${model.auth.type}|${model.baseUrl}|${model.ref.model}`;

export async function* streamResponses(model: Model, request: ModelRequest): AsyncGenerator<StreamEvent> {
  const flavor: Flavor = model.ref.provider === "xai" ? "xai" : "openai";
  const plan = model.auth.type === "chatgpt";
  const reasoning = flavor === "openai" && isReasoningModel(model.ref.model);
  const search = searchTools(model);
  const input = (withSearch: boolean) => toResponsesInput(request.items, model.ref.model, plan, { provider: flavor, search: withSearch });
  const body: Record<string, unknown> = {
    model: model.ref.model,
    instructions: request.system,
    input: input(search.length > 0),
    store: false,
    stream: true,
  };
  const tools = [...toResponsesTools(request.tools, plan, flavor), ...search];
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }
  const include: string[] = [];
  if (reasoning) {
    body.reasoning = { ...(model.effort !== "default" ? { effort: model.effort } : {}), summary: "auto" };
    include.push("reasoning.encrypted_content");
  }
  // Grok models reason without a `reasoning` field; their encrypted reasoning still has to be asked for.
  if (flavor === "xai") include.push("reasoning.encrypted_content");
  if (flavor === "openai" && search.length > 0) include.push(SOURCES_INCLUDE);
  if (include.length > 0) body.include = include;
  if (flavor === "xai" && model.temperature != null) body.temperature = model.temperature;

  const provider = flavor === "xai" ? "xAI" : plan ? "ChatGPT plan" : "OpenAI";
  const { response, searchRefusal } = await postWithFallbacks(model, body, request.signal, provider, () => input(false));
  if (searchRefusal != null) {
    refusedSearch.add(searchKey(model));
    yield { type: "notice", text: `${provider} didn't accept web search for ${model.ref.model}, so it answers without searching until the app restarts: ${searchRefusal.slice(0, 300)}` };
  }

  const outputs = new Map<number, Record<string, unknown>>();
  const calls: ToolCall[] = [];
  let finishReason = "stop";
  let detail: string | undefined;
  let sawSummary = false;
  let finished = false;
  /** xAI lists every page its search consulted on the response itself. */
  let consulted: string[] = [];
  for await (const data of sseData(response.body!, request.signal)) {
    let event: any;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    switch (event.type) {
      case "response.output_text.delta":
        if (typeof event.delta === "string" && event.delta.length > 0) yield { type: "text", delta: event.delta };
        break;
      case "response.reasoning_summary_text.delta":
        if (typeof event.delta === "string" && event.delta.length > 0) {
          sawSummary = true;
          yield { type: "reasoning", delta: event.delta };
        }
        break;
      case "response.reasoning_summary_part.done":
        if (sawSummary) yield { type: "reasoning", delta: "\n\n" };
        break;
      case "response.output_item.added": {
        const found = searchActivity(event.item);
        if (found != null) yield { type: "search", ...found };
        break;
      }
      case "response.output_item.done":
        if (event.item != null) {
          outputs.set(Number(event.output_index ?? outputs.size), event.item);
          // OpenAI fills in the query only when the call is done.
          const found = searchActivity(event.item);
          if (found?.query != null) yield { type: "search", ...found };
        }
        break;
      case "response.completed":
      case "response.incomplete": {
        finished = true;
        const done = event.response ?? {};
        if (Array.isArray(done.output)) done.output.forEach((item: Record<string, unknown>, index: number) => outputs.has(index) || outputs.set(index, item));
        if (Array.isArray(done.citations)) consulted = done.citations.filter((url: unknown): url is string => typeof url === "string");
        const usage = done.usage;
        if (usage != null) yield { type: "usage", inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0, cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0 };
        if (event.type === "response.incomplete") {
          finishReason = "length";
          detail = done.incomplete_details?.reason;
        }
        break;
      }
      case "response.failed": {
        const error = event.response?.error ?? {};
        throw new ModelError(statusForCode(error.code), String(error.message ?? "The response failed."), error.code ?? null, provider);
      }
      case "error":
        throw new ModelError(statusForCode(event.code), String(event.message ?? "The response stream failed."), event.code ?? null, provider);
    }
  }
  if (request.signal.aborted) return;
  // A response only counts once `response.completed` (or `.incomplete`) arrives.
  if (!finished) throw new ModelError(502, "The response stream ended before it finished.", null, provider);

  const items = [...outputs.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
  for (const item of items) {
    if (item.type === "function_call") {
      calls.push({ id: String(item.call_id ?? item.id), type: "function", function: { name: String(item.name ?? ""), arguments: String(item.arguments ?? "{}") } });
    } else if (item.type === "refusal") {
      finishReason = "refusal";
    }
  }
  const sources = responseSources(items, consulted);
  if (sources.length > 0) yield { type: "sources", sources };
  const replay: ReplayState = { provider: flavor, model: model.ref.model, items };
  yield { type: "replay", state: replay };
  for (const call of calls) yield { type: "tool-call", call };
  yield { type: "done", finishReason: calls.length > 0 ? "tool_calls" : finishReason, ...(detail ? { detail } : {}) };
}

/** A search item's kind and query (null until known), or null for any other item. */
function searchActivity(value: unknown): { source: "web" | "x"; query: string | null } | null {
  if (typeof value !== "object" || value == null) return null;
  const item = value as Record<string, any>;
  if (item.type === "web_search_call") {
    const action = item.action ?? {};
    const query = action.query ?? (Array.isArray(action.queries) ? action.queries[0] : undefined) ?? (action.type === "open_page" || action.type === "find_in_page" ? action.url : undefined);
    return { source: "web", query: typeof query === "string" && query.length > 0 ? query : null };
  }
  if (!isXSearchCall(item)) return null;
  let query: unknown = null;
  try {
    const input = typeof item.input === "string" ? JSON.parse(item.input) : item.input;
    query = input?.query ?? input?.name ?? input?.url ?? null;
  } catch {
    query = null;
  }
  return { source: "x", query: typeof query === "string" && query.length > 0 ? query : null };
}

/** Cited pages from the reply's `url_citation` annotations, then pages the searches only returned. */
function responseSources(items: Array<Record<string, any>>, consulted: string[]): WebSource[] {
  const found: WebSource[] = [];
  for (const item of items) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        for (const annotation of Array.isArray(part?.annotations) ? part.annotations : []) {
          if (annotation?.type !== "url_citation" || typeof annotation.url !== "string") continue;
          // xAI titles its citations with their number ("1"), which is no title.
          const title = typeof annotation.title === "string" && !/^\d+$/.test(annotation.title.trim()) ? annotation.title : undefined;
          found.push({ url: annotation.url, ...(title != null ? { title } : {}), cited: true });
        }
      }
    } else if (item.type === "web_search_call" && Array.isArray(item.action?.sources)) {
      for (const source of item.action.sources) if (typeof source?.url === "string") found.push({ url: source.url, cited: false });
    }
  }
  for (const url of consulted) found.push({ url, cited: false });
  return mergeSources([], found);
}

const statusForCode = (code: unknown): number =>
  code === "subscription_sharing_usage_limit_exceeded" || code === "rate_limit_exceeded" ? 429 : code === "subscription_sharing_user_not_eligible" ? 403 : code === "subscription_sharing_usage_unavailable" ? 503 : 500;

/**
 * Optional request parts we drop and retry without when the API says it can't take them. Most are
 * matched on the error's `param`; the search ones also on its message, since a model or a
 * workspace policy that refuses search may name the tool there instead.
 */
const OPTIONAL_FIELDS: Array<{ param: RegExp; inMessage?: boolean; search?: boolean; drop(body: Record<string, unknown>, inputWithoutSearch: () => unknown[]): boolean }> = [
  { param: /web_search_call\.action\.sources/, inMessage: true, drop: (body) => dropInclude(body, SOURCES_INCLUDE) },
  { param: /web[_ ]search(?!_call)|x_search/i, inMessage: true, search: true, drop: (body, inputWithoutSearch) => dropSearch(body, inputWithoutSearch) },
  { param: /reasoning\.summary|summary/i, drop: (body) => dropPath(body, "reasoning", "summary") },
  { param: /reasoning\.effort|effort/i, drop: (body) => dropPath(body, "reasoning", "effort") },
  { param: /^reasoning$/i, drop: (body) => delete body.reasoning },
  { param: /include/i, drop: (body) => delete body.include },
  { param: /parallel_tool_calls/i, drop: (body) => delete body.parallel_tool_calls },
];

function dropPath(body: Record<string, unknown>, key: string, inner: string): boolean {
  const value = body[key] as Record<string, unknown> | undefined;
  if (value == null || !(inner in value)) return false;
  delete value[inner];
  return true;
}

function dropInclude(body: Record<string, unknown>, value: string): boolean {
  const include = body.include as string[] | undefined;
  if (include == null || !include.includes(value)) return false;
  const rest = include.filter((entry) => entry !== value);
  if (rest.length > 0) body.include = rest;
  else delete body.include;
  return true;
}

/** Turns the provider's search off for this request; steps that searched are then sent as their text. */
function dropSearch(body: Record<string, unknown>, inputWithoutSearch: () => unknown[]): boolean {
  const tools = (body.tools as Array<{ type?: string }> | undefined) ?? [];
  const kept = tools.filter((tool) => tool.type !== "web_search" && tool.type !== "x_search");
  if (kept.length === tools.length) return false;
  if (kept.length > 0) body.tools = kept;
  else {
    delete body.tools;
    delete body.tool_choice;
    delete body.parallel_tool_calls;
  }
  dropInclude(body, SOURCES_INCLUDE);
  body.input = inputWithoutSearch();
  return true;
}

/** The streaming response, and the provider's message when it refused the search tools and the request went without them. */
async function postWithFallbacks(
  model: Model,
  body: Record<string, unknown>,
  signal: AbortSignal,
  provider: string,
  inputWithoutSearch: () => unknown[],
): Promise<{ response: Response; searchRefusal: string | null }> {
  let refreshed = false;
  let searchRefusal: string | null = null;
  let searchStepsAsText = false;
  for (let attempt = 0; attempt < 7; attempt++) {
    const token = model.auth.type === "api-key" ? model.auth.apiKey : await model.auth.accessToken(false);
    const response = await fetch(`${model.baseUrl.replace(/\/+$/, "")}/responses`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (response.ok && response.body != null) return { response, searchRefusal };
    const error = await readErrorBody(response);
    if (response.status === 401 && model.auth.type === "chatgpt" && !refreshed) {
      refreshed = true;
      await model.auth.accessToken(true);
      continue;
    }
    if (response.status === 400 || error.code === "subscription_sharing_unsupported_capability") {
      const hint = `${error.param ?? ""} ${error.message}`;
      // A replayed search call the API won't take: send the steps that searched as their text instead.
      const index = /^input\[(\d+)\]/.exec(error.param ?? "")?.[1];
      const badCall = (index != null && isSearchItem((body.input as unknown[])[Number(index)])) || /web_search_call(?!\.action\.sources)/.test(hint);
      if (badCall && !searchStepsAsText) {
        searchStepsAsText = true;
        body.input = inputWithoutSearch();
        continue;
      }
      const fix = OPTIONAL_FIELDS.find((field) => field.param.test(error.param ?? "") || ((error.param == null || field.inMessage === true) && field.param.test(hint)));
      if (fix != null && fix.drop(body, inputWithoutSearch)) {
        if (fix.search === true) searchRefusal = error.message;
        continue;
      }
    }
    throw new ModelError(response.status, error.message.slice(0, 2000), error.code, provider);
  }
  throw new ModelError(400, "The request was rejected after retrying without optional fields.", null, provider);
}

/** API key route: GET /v1/models lists everything; keep the chat-capable text models. */
export function filterOpenAiChatModels(ids: string[]): string[] {
  return ids
    .filter((id) => /^(gpt-|o\d|chatgpt-|codex)/i.test(id))
    .filter((id) => !/(audio|realtime|transcribe|tts|image|embedding|moderation|search-preview|instruct|live|daybreak|rosalind|cyber)/i.test(id))
    .sort((a, b) => b.localeCompare(a));
}

export async function listResponsesModels(model: Model): Promise<Array<{ id: string; label?: string }>> {
  const token = model.auth.type === "api-key" ? model.auth.apiKey : await model.auth.accessToken(false);
  const response = await fetch(`${model.baseUrl.replace(/\/+$/, "")}/models`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const error = await readErrorBody(response);
    throw new ModelError(response.status, error.message, error.code, model.auth.type === "chatgpt" ? "ChatGPT plan" : "OpenAI");
  }
  const json = (await response.json()) as { data?: Array<{ id: string }>; models?: Array<{ slug: string; display_name?: string; visibility?: string }> };
  // The plan route answers {models: [{slug, display_name, visibility}]}; keep the
  // listed ones in server order.
  if (Array.isArray(json.models)) return json.models.filter((entry) => entry.visibility == null || entry.visibility === "list").map((entry) => ({ id: entry.slug, label: entry.display_name }));
  return filterOpenAiChatModels((json.data ?? []).map((entry) => entry.id)).map((id) => ({ id }));
}
