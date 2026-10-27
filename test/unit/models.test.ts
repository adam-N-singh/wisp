import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { resolveModel } from "../../src/box/models";
import { anthropicCapabilities, toAnthropicMessages, streamAnthropic } from "../../src/box/models/anthropic";
import { streamChatCompletions } from "../../src/box/models/chat-completions";
import { listResponsesModels, streamResponses, TOOL_NAMESPACE, toResponsesInput } from "../../src/box/models/responses";
import { type ConvItem, mergeSources, ModelError, type ModelRequest, type ResolvedModel, type StreamEvent, type ToolSpec } from "../../src/box/models/types";
import type { BoxModelConfig } from "../../src/shared/edges";
import type { ReplayState } from "../../src/shared/model";

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: any;
}

const servers: Server[] = [];
after(() => servers.forEach((server) => server.close()));

/** A local server answering each request with the next scripted response. */
async function fakeServer(responses: Array<(request: Recorded) => { status?: number; type?: string; body: string }>): Promise<{ baseUrl: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const recorded: Recorded = { method: request.method ?? "", url: request.url ?? "", headers: request.headers, body: raw.length > 0 ? JSON.parse(raw) : null };
      requests.push(recorded);
      const next = responses[Math.min(requests.length - 1, responses.length - 1)](recorded);
      response.writeHead(next.status ?? 200, { "content-type": next.type ?? "text/event-stream" });
      response.end(next.body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const sse = (events: unknown[], named = false) =>
  events.map((event) => `${named ? `event: ${(event as { type: string }).type}\n` : ""}data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");

async function collect(stream: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const TOOLS: ToolSpec[] = [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];
const request = (items: ConvItem[]): ModelRequest => ({ system: "You are a test agent.", items, tools: TOOLS, signal: new AbortController().signal });
const hello: ConvItem[] = [{ kind: "user", parts: [{ type: "text", text: "[Sent now]\nhello" }] }];

test("chat completions: streams text, assembles tool calls and reports usage", async () => {
  const { baseUrl, requests } = await fakeServer([
    () => ({
      body: sse([
        { choices: [{ delta: { content: "Reading " } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"pa' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } },
        "[DONE]",
      ]),
    }),
  ]);
  const model: ResolvedModel = { kind: "chat-completions", ref: { provider: "xai", model: "grok-4.7" }, baseUrl, apiKey: "test-key", temperature: null };
  const events = await collect(streamChatCompletions(model, request(hello)));
  assert.deepEqual(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta), ["Reading "]);
  const call = events.find((e) => e.type === "tool-call");
  assert.deepEqual(call, { type: "tool-call", call: { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } } });
  assert.ok(events.some((e) => e.type === "usage" && e.inputTokens === 12));
  const body = requests[0].body;
  assert.equal(body.model, "grok-4.7");
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.stream_options.include_usage, true);
  assert.equal(body.temperature, undefined, "no temperature unless configured");
  assert.equal(requests[0].headers.authorization, "Bearer test-key");
});

test("responses (API key): request shape, reasoning summary, replay items and tool calls", async () => {
  const reasoning = { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "Need the file." }], encrypted_content: "ENC" };
  const call = { id: "fc_1", type: "function_call", call_id: "call_9", name: "read_file", arguments: '{"path":"a.txt"}', status: "completed" };
  const { baseUrl, requests } = await fakeServer([
    () => ({
      body: sse([
        { type: "response.reasoning_summary_text.delta", delta: "Need the file." },
        { type: "response.reasoning_summary_part.done" },
        { type: "response.output_item.done", output_index: 0, item: reasoning },
        { type: "response.output_text.delta", delta: "Let me read it." },
        { type: "response.output_item.done", output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Let me read it.", annotations: [] }] } },
        { type: "response.output_item.done", output_index: 2, item: call },
        { type: "response.completed", response: { usage: { input_tokens: 30, output_tokens: 9, input_tokens_details: { cached_tokens: 4 } } } },
      ]),
    }),
  ]);
  const model: ResolvedModel = { kind: "responses", ref: { provider: "openai", model: "gpt-6.1-sol" }, baseUrl, effort: "high", auth: { type: "api-key", apiKey: "sk-test" } };
  const events = await collect(streamResponses(model, request(hello)));
  const body = requests[0].body;
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, "You are a test agent.");
  assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(body.tools[0].type, "function", "API key route uses plain function tools");
  assert.equal(body.temperature, undefined);
  assert.equal(body.input[0].content[0].type, "input_text");
  assert.equal(events.filter((e) => e.type === "reasoning").map((e) => (e as { delta: string }).delta).join(""), "Need the file.\n\n");
  const replay = events.find((e) => e.type === "replay");
  assert.equal(replay?.type === "replay" ? replay.state.items.length : 0, 3);
  assert.deepEqual(events.find((e) => e.type === "tool-call"), { type: "tool-call", call: { id: "call_9", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } } });
  assert.ok(events.some((e) => e.type === "usage" && e.cachedTokens === 4));
  assert.deepEqual(events[events.length - 1], { type: "done", finishReason: "tool_calls" });

  // The next request replays this model's items without ids, then the tool output.
  const input = toResponsesInput(
    [
      ...hello,
      { kind: "assistant", text: "Let me read it.", toolCalls: [], replay: replay?.type === "replay" ? replay.state : null },
      { kind: "tool-results", results: [{ callId: "call_9", name: "read_file", output: "contents", isError: false, image: null }] },
    ],
    "gpt-6.1-sol",
    false,
  ) as Array<Record<string, unknown>>;
  assert.deepEqual(input[1], { type: "reasoning", summary: reasoning.summary, encrypted_content: "ENC" });
  assert.equal(input[2].type, "message");
  assert.equal("annotations" in (input[2].content as Array<Record<string, unknown>>)[0], false);
  assert.deepEqual(input[3], { type: "function_call", call_id: "call_9", name: "read_file", arguments: '{"path":"a.txt"}' });
  assert.deepEqual(input[4], { type: "function_call_output", call_id: "call_9", output: "contents" });

  // Another model can't use those items, so the step is rebuilt from text and calls.
  const rebuilt = toResponsesInput([{ kind: "assistant", text: "Hi", toolCalls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }], replay: replay?.type === "replay" ? replay.state : null }], "gpt-5.6-sol", false);
  assert.deepEqual(rebuilt, [{ role: "assistant", content: "Hi" }, { type: "function_call", call_id: "c1", name: "read_file", arguments: "{}" }]);
});

test("responses (ChatGPT plan): namespaced tools, token refresh on 401, plan errors", async () => {
  const { baseUrl, requests } = await fakeServer([
    () => ({ status: 401, type: "application/json", body: JSON.stringify({ detail: "token expired" }) }),
    () => ({
      body: sse([
        { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "read_file", namespace: TOOL_NAMESPACE, arguments: "{}" } },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ]),
    }),
    () => ({ body: sse([{ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "Limit reached" } } }]) }),
  ]);
  const tokens: boolean[] = [];
  let current = "old-token";
  const model: ResolvedModel = {
    kind: "responses",
    ref: { provider: "openai", model: "gpt-6.1-sol" },
    baseUrl,
    effort: "default",
    auth: {
      type: "chatgpt",
      accessToken: async (force) => {
        tokens.push(force);
        if (force) current = "fresh-token";
        return current;
      },
    },
  };
  const events = await collect(streamResponses(model, request(hello)));
  assert.deepEqual(tokens, [false, true, false], "a 401 forces one refresh");
  assert.equal(requests[0].headers.authorization, "Bearer old-token");
  assert.equal(requests[1].headers.authorization, "Bearer fresh-token", "the retry uses the refreshed token");
  const body = requests[1].body;
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].type, "namespace");
  assert.equal(body.tools[0].name, TOOL_NAMESPACE);
  assert.equal(body.tools[0].tools[0].name, "read_file");
  assert.equal(body.temperature, undefined);
  assert.equal(body.max_output_tokens, undefined);
  assert.equal(body.previous_response_id, undefined);
  assert.ok(events.some((e) => e.type === "tool-call"));

  await assert.rejects(collect(streamResponses(model, request(hello))), (error) => error instanceof ModelError && error.status === 429 && error.code === "subscription_sharing_usage_limit_exceeded");
});

test("responses: drops an optional field the API rejects and retries", async () => {
  const { baseUrl, requests } = await fakeServer([
    () => ({ status: 400, type: "application/json", body: JSON.stringify({ error: { message: "Organization must be verified to generate reasoning summaries.", param: "reasoning.summary", code: "unsupported_value" } }) }),
    () => ({ body: sse([{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: {} }]) }),
  ]);
  const model: ResolvedModel = { kind: "responses", ref: { provider: "openai", model: "gpt-6-astra" }, baseUrl, effort: "low", auth: { type: "api-key", apiKey: "sk" } };
  const events = await collect(streamResponses(model, request(hello)));
  assert.deepEqual(requests[0].body.reasoning, { effort: "low", summary: "auto" });
  assert.deepEqual(requests[1].body.reasoning, { effort: "low" });
  assert.ok(events.some((e) => e.type === "text" && e.delta === "ok"));
});

test("responses: model lists for the API key and plan routes", async () => {
  const { baseUrl } = await fakeServer([
    () => ({ type: "application/json", body: JSON.stringify({ data: [{ id: "gpt-6.1-sol" }, { id: "whisper-1" }, { id: "gpt-image-2" }, { id: "text-embedding-3-small" }, { id: "gpt-6-astra" }] }) }),
    () => ({ type: "application/json", body: JSON.stringify({ models: [{ slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" }, { slug: "internal", visibility: "hide" }] }) }),
  ]);
  const keyed: ResolvedModel = { kind: "responses", ref: { provider: "openai", model: "" }, baseUrl, effort: "default", auth: { type: "api-key", apiKey: "sk" } };
  assert.deepEqual(await listResponsesModels(keyed as Extract<ResolvedModel, { kind: "responses" }>), [{ id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }]);
  const plan: ResolvedModel = { ...keyed, auth: { type: "chatgpt", accessToken: async () => "t" } } as ResolvedModel;
  assert.deepEqual(await listResponsesModels(plan as Extract<ResolvedModel, { kind: "responses" }>), [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }]);
});

test("anthropic: capabilities by model", () => {
  assert.deepEqual(anthropicCapabilities("claude-opus-5-5"), { adaptive: true, effort: true, fallbacks: true });
  assert.deepEqual(anthropicCapabilities("claude-sonnet-5-5"), { adaptive: true, effort: true, fallbacks: true });
  assert.deepEqual(anthropicCapabilities("claude-haiku-5-5"), { adaptive: true, effort: true, fallbacks: false });
  assert.deepEqual(anthropicCapabilities("claude-opus-4-6"), { adaptive: true, effort: true, fallbacks: false });
  assert.deepEqual(anthropicCapabilities("claude-haiku-4-5"), { adaptive: false, effort: false, fallbacks: false });
  assert.deepEqual(anthropicCapabilities("claude-haiku-4-5-20251001"), { adaptive: false, effort: false, fallbacks: false });
  assert.deepEqual(anthropicCapabilities("claude-fable-5-1"), { adaptive: true, effort: true, fallbacks: true });
});

test("anthropic: conversation conversion replays blocks and puts images in tool results", () => {
  const replayed = [{ type: "thinking", thinking: "plan", signature: "SIG" }, { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.png" } }];
  const messages = toAnthropicMessages([
    ...hello,
    { kind: "assistant", text: "", toolCalls: [{ id: "toolu_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.png"}' } }], replay: { provider: "anthropic", model: "claude-opus-5-5", items: replayed } },
    { kind: "tool-results", results: [{ callId: "toolu_1", name: "read_file", output: "Image a.png", isError: false, image: { mime: "image/png", base64: "AAAA" } }] },
  ]);
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[1], { role: "assistant", content: replayed });
  const result = (messages[2].content as Array<Record<string, any>>)[0];
  assert.equal(result.type, "tool_result");
  assert.equal(result.tool_use_id, "toolu_1");
  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[1].source.data, "AAAA");
});

test("anthropic: streams thinking and text, replays the final content, maps tool use", async () => {
  const message = { id: "msg_1", type: "message", role: "assistant", content: [], model: "claude-opus-5-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } };
  const { baseUrl, requests } = await fakeServer([
    () => ({
      body: sse(
        [
          { type: "message_start", message },
          { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check the file." } },
          { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG123" } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Reading it." } },
          { type: "content_block_stop", index: 1 },
          { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_9", name: "read_file", input: {} } },
          { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } },
          { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"a.txt"}' } },
          { type: "content_block_stop", index: 2 },
          { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 15 } },
          { type: "message_stop" },
        ],
        true,
      ),
    }),
  ]);
  const model: ResolvedModel = { kind: "anthropic", ref: { provider: "anthropic", model: "claude-opus-5-5" }, apiKey: "sk-ant-test", effort: "high", baseUrl };
  const events = await collect(streamAnthropic(model, request(hello)));
  const body = requests[0].body;
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.max_tokens, 64000);
  assert.deepEqual(body.system, [{ type: "text", text: "You are a test agent." }]);
  assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } });
  assert.deepEqual(body.output_config, { effort: "high" });
  assert.equal(body.fallbacks, "default");
  assert.deepEqual(body.cache_control, { type: "ephemeral" });
  assert.equal(body.temperature, undefined, "sampling parameters are never sent");
  assert.equal(body.tools[0].input_schema.type, "object");
  assert.match(String(requests[0].headers["anthropic-beta"]), /thinking-binding-controls-2026-08-01/);
  assert.match(String(requests[0].headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
  assert.equal(requests[0].headers.authorization, "Bearer sk-ant-test", "SDK 1.x sends the key as a bearer token");

  assert.equal(events.filter((e) => e.type === "reasoning").map((e) => (e as { delta: string }).delta).join(""), "Check the file.");
  assert.equal(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join(""), "Reading it.");
  const replay = events.find((e) => e.type === "replay");
  const blocks = replay?.type === "replay" ? (replay.state.items as Array<Record<string, unknown>>) : [];
  assert.deepEqual(blocks[0], { type: "thinking", thinking: "Check the file.", signature: "SIG123" });
  assert.deepEqual(events.find((e) => e.type === "tool-call"), { type: "tool-call", call: { id: "toolu_9", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } } });
  assert.ok(events.some((e) => e.type === "usage" && e.cachedTokens === 5 && e.outputTokens === 15));
  assert.deepEqual(events[events.length - 1], { type: "done", finishReason: "tool_calls" });
});

test("anthropic: a refusal ends the step without running tools", async () => {
  const message = { id: "msg_2", type: "message", role: "assistant", content: [], model: "claude-opus-5-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } };
  const { baseUrl } = await fakeServer([
    () => ({
      body: sse(
        [
          { type: "message_start", message },
          { type: "message_delta", delta: { stop_reason: "refusal", stop_sequence: null, stop_details: { type: "refusal", category: "cyber", explanation: null } }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ],
        true,
      ),
    }),
  ]);
  const model: ResolvedModel = { kind: "anthropic", ref: { provider: "anthropic", model: "claude-opus-5-5" }, apiKey: "k", effort: "default", baseUrl };
  const events = await collect(streamAnthropic(model, request(hello)));
  assert.equal(events.some((e) => e.type === "tool-call"), false);
  const done = events[events.length - 1];
  assert.equal(done.type === "done" ? done.finishReason : "", "refusal");
});

// ---- web search ------------------------------------------------------------------

const searches = (events: StreamEvent[]) => events.filter((e): e is Extract<StreamEvent, { type: "search" }> => e.type === "search").map((e) => [e.source, e.query]);
const sourcesOf = (events: StreamEvent[]) => events.filter((e): e is Extract<StreamEvent, { type: "sources" }> => e.type === "sources").flatMap((e) => e.sources);
const replayOf = (events: StreamEvent[]): ReplayState | null => {
  const event = events.find((e) => e.type === "replay");
  return event?.type === "replay" ? event.state : null;
};

test("web search: on by default, decides xAI's API, and reaches each provider's model", () => {
  const config: BoxModelConfig = {
    defaultModel: { provider: "xai", model: "grok-4.7" },
    reasoningEffort: "default",
    temperature: 0.3,
    xai: { baseUrl: "https://api.x.ai/v1", apiKey: "xai-key" },
    openai: { baseUrl: "https://api.openai.com/v1", auth: "api-key", apiKey: "sk" },
    anthropic: { apiKey: "sk-ant" },
    custom: { baseUrl: "http://localhost:11434/v1", apiKey: "" },
    claudeCode: null,
  };
  const deps = { chatGptToken: async () => "t" };
  const resolve = (overrides: Partial<BoxModelConfig>, provider: "xai" | "openai" | "anthropic" | "custom" | "mock") => {
    const resolution = resolveModel({ ...config, ...overrides }, { provider, model: provider === "custom" ? "llama" : "" }, deps);
    assert.ok(resolution.ok);
    return resolution.model;
  };
  assert.deepEqual(resolve({}, "xai"), {
    kind: "responses",
    ref: { provider: "xai", model: "grok-4.7" },
    baseUrl: "https://api.x.ai/v1",
    effort: "default",
    auth: { type: "api-key", apiKey: "xai-key" },
    search: { web: true, x: true },
    temperature: 0.3,
  });
  assert.deepEqual((resolve({ xSearch: false }, "xai") as Extract<ResolvedModel, { kind: "responses" }>).search, { web: true, x: false });
  assert.equal(resolve({ webSearch: false }, "xai").kind, "chat-completions", "without search xAI stays on Chat Completions");
  assert.deepEqual((resolve({}, "openai") as Extract<ResolvedModel, { kind: "responses" }>).search, { web: true, x: false });
  assert.deepEqual((resolve({ webSearch: false }, "openai") as Extract<ResolvedModel, { kind: "responses" }>).search, { web: false, x: false });
  assert.equal((resolve({}, "anthropic") as Extract<ResolvedModel, { kind: "anthropic" }>).webSearch, true);
  assert.equal((resolve({ webSearch: false }, "anthropic") as Extract<ResolvedModel, { kind: "anthropic" }>).webSearch, false);
  assert.equal(resolve({}, "custom").kind, "chat-completions", "custom endpoints have no search");
  assert.equal((resolve({ webSearch: false }, "mock") as Extract<ResolvedModel, { kind: "mock" }>).webSearch, false);
});

test("sources: merged by URL, cited first, first title kept, only web links", () => {
  assert.deepEqual(
    mergeSources(
      [{ url: "https://a.example/1", cited: false }],
      [
        { url: "https://b.example/2", title: "B", cited: true },
        { url: "https://a.example/1", title: "A", cited: true },
        { url: "https://b.example/2", title: "Other title", cited: false },
        { url: "javascript:alert(1)", title: "Nope", cited: true },
      ],
    ),
    [
      { url: "https://a.example/1", title: "A", cited: true },
      { url: "https://b.example/2", title: "B", cited: true },
    ],
  );
});

test("xai (web search on): Responses request with web and X search, search activity, citations and verbatim replay", async () => {
  const reasoningItem = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "XENC", status: "completed" };
  const xSearch = { type: "custom_tool_call", id: "ctc_1", call_id: "xs_1", name: "x_keyword_search", input: '{"query":"starship from:SpaceX","limit":10}', status: "completed" };
  const webSearch = { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "starship next launch" } };
  const text = "Starship flies Friday [[1]](https://x.com/SpaceX/status/123) [[2]](https://www.nasa.gov/starship).";
  const message = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text,
        logprobs: [],
        annotations: [
          { type: "url_citation", url: "https://x.com/SpaceX/status/123", start_index: 22, end_index: 60, title: "1" },
          { type: "url_citation", url: "https://www.nasa.gov/starship", start_index: 61, end_index: 98, title: "2" },
        ],
      },
    ],
  };
  const { baseUrl, requests } = await fakeServer([
    () => ({
      body: sse([
        { type: "response.output_item.added", output_index: 0, item: { ...reasoningItem, encrypted_content: null, status: "in_progress" } },
        { type: "response.output_item.done", output_index: 0, item: reasoningItem },
        { type: "response.output_item.added", output_index: 1, item: { ...xSearch, input: "", status: "in_progress" } },
        { type: "response.output_item.done", output_index: 1, item: xSearch },
        { type: "response.output_item.added", output_index: 2, item: { ...webSearch, status: "in_progress" } },
        { type: "response.output_item.done", output_index: 2, item: webSearch },
        { type: "response.output_text.delta", output_index: 3, delta: text },
        { type: "response.output_item.done", output_index: 3, item: message },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 50, output_tokens: 20 }, citations: ["https://x.com/SpaceX/status/123", "https://www.nasa.gov/starship", "https://spaceflightnow.com/launch-schedule/"] },
        },
        "[DONE]",
      ]),
    }),
  ]);
  const model: ResolvedModel = { kind: "responses", ref: { provider: "xai", model: "grok-4.7" }, baseUrl, effort: "default", auth: { type: "api-key", apiKey: "xai-key" }, search: { web: true, x: true }, temperature: 0.3 };
  const events = await collect(streamResponses(model, request(hello)));

  assert.equal(requests[0].url, "/responses", "xAI's search tools exist only on its Responses API");
  assert.equal(requests[0].headers.authorization, "Bearer xai-key");
  const body = requests[0].body;
  assert.equal(body.model, "grok-4.7");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, "You are a test agent.");
  assert.deepEqual(body.tools, [{ type: "function", name: "read_file", description: "Read a file", parameters: TOOLS[0].function.parameters }, { type: "web_search" }, { type: "x_search" }]);
  assert.equal(body.tool_choice, "auto");
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(body.reasoning, undefined, "Grok models get no reasoning field");
  assert.equal(body.temperature, 0.3, "xAI keeps the configured temperature");

  assert.deepEqual(searches(events), [
    ["x", null],
    ["x", "starship from:SpaceX"],
    ["web", "starship next launch"],
    ["web", "starship next launch"],
  ]);
  assert.equal(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join(""), text);
  assert.deepEqual(sourcesOf(events), [
    { url: "https://x.com/SpaceX/status/123", cited: true },
    { url: "https://www.nasa.gov/starship", cited: true },
    { url: "https://spaceflightnow.com/launch-schedule/", cited: false },
  ]);
  const replay = replayOf(events);
  assert.equal(replay?.provider, "xai");
  assert.deepEqual(replay?.items, [reasoningItem, xSearch, webSearch, message]);
  assert.deepEqual(events[events.length - 1], { type: "done", finishReason: "stop" });

  // xAI's items go back exactly as they came; without search, or to OpenAI, the step is its text.
  const next: ConvItem[] = [...hello, { kind: "assistant", text, toolCalls: [], replay }, { kind: "user", parts: [{ type: "text", text: "[Sent now]\nthanks" }] }];
  assert.deepEqual(toResponsesInput(next, "grok-4.7", false, { provider: "xai", search: true }).slice(1, 5), [reasoningItem, xSearch, webSearch, message]);
  assert.deepEqual(toResponsesInput(next, "grok-4.7", false, { provider: "xai", search: false })[1], { role: "assistant", content: text });
  assert.deepEqual(toResponsesInput(next, "grok-4.7", false, { provider: "openai", search: true })[1], { role: "assistant", content: text });
});

test("responses (OpenAI): web_search tool and sources include, cited and consulted sources, search calls replayed with their ids", async () => {
  const reasoningItem = { id: "rs_9", type: "reasoning", summary: [], encrypted_content: "OENC" };
  const searchCall = {
    id: "ws_9",
    type: "web_search_call",
    status: "completed",
    action: { type: "search", query: "gpt release notes", sources: [{ type: "url", url: "https://openai.com/news" }, { type: "url", url: "https://help.openai.com/notes" }] },
  };
  const message = {
    id: "msg_9",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Per the release notes, it shipped.", annotations: [{ type: "url_citation", url: "https://help.openai.com/notes", title: "Release notes", start_index: 0, end_index: 20 }] }],
  };
  const { baseUrl, requests } = await fakeServer([
    () => ({
      body: sse([
        { type: "response.output_item.done", output_index: 0, item: reasoningItem },
        { type: "response.output_item.added", output_index: 1, item: { id: "ws_9", type: "web_search_call", status: "in_progress" } },
        { type: "response.web_search_call.in_progress", output_index: 1, item_id: "ws_9" },
        { type: "response.web_search_call.searching", output_index: 1, item_id: "ws_9" },
        { type: "response.web_search_call.completed", output_index: 1, item_id: "ws_9" },
        { type: "response.output_item.done", output_index: 1, item: searchCall },
        { type: "response.output_text.delta", delta: "Per the release notes, it shipped." },
        { type: "response.output_item.done", output_index: 2, item: message },
        { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } },
      ]),
    }),
  ]);
  const model: ResolvedModel = { kind: "responses", ref: { provider: "openai", model: "gpt-6.1-sol" }, baseUrl, effort: "default", auth: { type: "api-key", apiKey: "sk" }, search: { web: true, x: false } };
  const events = await collect(streamResponses(model, request(hello)));
  const body = requests[0].body;
  assert.deepEqual(body.tools[body.tools.length - 1], { type: "web_search" }, "the hosted tool follows the function tools");
  assert.equal(body.tools[0].strict, false);
  assert.deepEqual(body.include, ["reasoning.encrypted_content", "web_search_call.action.sources"]);
  assert.deepEqual(searches(events), [
    ["web", null],
    ["web", "gpt release notes"],
  ]);
  assert.deepEqual(sourcesOf(events), [
    { url: "https://help.openai.com/notes", title: "Release notes", cited: true },
    { url: "https://openai.com/news", cited: false },
  ]);

  const replay = replayOf(events);
  const next: ConvItem[] = [...hello, { kind: "assistant", text: "Per the release notes, it shipped.", toolCalls: [], replay }, { kind: "user", parts: [{ type: "text", text: "[Sent now]\nmore?" }] }];
  const input = toResponsesInput(next, "gpt-6.1-sol", false, { search: true }) as Array<Record<string, any>>;
  assert.deepEqual(input[1], { type: "reasoning", summary: [], encrypted_content: "OENC" });
  assert.deepEqual(input[2], { id: "ws_9", type: "web_search_call", status: "completed", action: { type: "search", query: "gpt release notes" } }, "a search call keeps its required id and status; its sources are dropped");
  assert.deepEqual(input[3].content, [{ type: "output_text", text: "Per the release notes, it shipped." }]);
  assert.deepEqual(toResponsesInput(next, "gpt-6.1-sol", false, { search: false })[1], { role: "assistant", content: "Per the release notes, it shipped." }, "without the tool, a step that searched is its text");
});

test("responses (ChatGPT plan): web search sits beside the tool namespace", async () => {
  const { baseUrl, requests } = await fakeServer([() => ({ body: sse([{ type: "response.completed", response: {} }]) })]);
  const model: ResolvedModel = { kind: "responses", ref: { provider: "openai", model: "gpt-6.1-sol" }, baseUrl, effort: "default", auth: { type: "chatgpt", accessToken: async () => "t" }, search: { web: true, x: false } };
  await collect(streamResponses(model, request(hello)));
  assert.deepEqual(requests[0].body.tools.map((tool: { type: string }) => tool.type), ["namespace", "web_search"]);
});

test("responses: a refused web search tool is dropped with a notice and stays off for that model", async () => {
  const ok = () => ({ body: sse([{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: {} }]) });
  const { baseUrl, requests } = await fakeServer([
    () => ({
      status: 400,
      type: "application/json",
      body: JSON.stringify({ error: { message: "Hosted tool 'web_search' is not supported with gpt-4.1-nano.", type: "invalid_request_error", param: "tools", code: "unsupported_value" } }),
    }),
    ok,
    ok,
  ]);
  const model: ResolvedModel = { kind: "responses", ref: { provider: "openai", model: "gpt-4.1-nano" }, baseUrl, effort: "default", auth: { type: "api-key", apiKey: "sk" }, search: { web: true, x: false } };
  const first = await collect(streamResponses(model, request(hello)));
  assert.deepEqual(requests[0].body.include, ["web_search_call.action.sources"]);
  assert.ok(requests[0].body.tools.some((tool: { type: string }) => tool.type === "web_search"));
  assert.deepEqual(requests[1].body.tools.map((tool: { type: string }) => tool.type), ["function"], "the retry goes without the search tool");
  assert.equal(requests[1].body.include, undefined);
  const notice = first.find((e) => e.type === "notice");
  assert.match(notice?.type === "notice" ? notice.text : "", /didn't accept web search for gpt-4\.1-nano.*not supported/);
  assert.ok(first.some((e) => e.type === "text" && e.delta === "ok"));

  const second = await collect(streamResponses(model, request(hello)));
  assert.equal(requests.length, 3, "the next request doesn't try search again");
  assert.deepEqual(requests[2].body.tools.map((tool: { type: string }) => tool.type), ["function"]);
  assert.equal(second.some((e) => e.type === "notice"), false);
});

test("responses: a replayed search call the API rejects is sent as text, keeping the search tool", async () => {
  const replay: ReplayState = {
    provider: "openai",
    model: "gpt-6.1-sol",
    items: [
      { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "E" },
      { id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", query: "q" } },
      { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Found it.", annotations: [] }] },
    ],
  };
  const { baseUrl, requests } = await fakeServer([
    () => ({ status: 400, type: "application/json", body: JSON.stringify({ error: { message: "Invalid value for 'input[2].action'.", param: "input[2].action", code: "invalid_value" } }) }),
    () => ({ body: sse([{ type: "response.completed", response: {} }]) }),
  ]);
  const model: ResolvedModel = { kind: "responses", ref: { provider: "openai", model: "gpt-6.1-sol" }, baseUrl, effort: "default", auth: { type: "api-key", apiKey: "sk" }, search: { web: true, x: false } };
  const items: ConvItem[] = [...hello, { kind: "assistant", text: "Found it.", toolCalls: [], replay }, { kind: "user", parts: [{ type: "text", text: "[Sent now]\nand?" }] }];
  const events = await collect(streamResponses(model, request(items)));
  assert.equal(requests[0].body.input[2].type, "web_search_call");
  assert.deepEqual(requests[1].body.input[1], { role: "assistant", content: "Found it." });
  assert.ok(requests[1].body.tools.some((tool: { type: string }) => tool.type === "web_search"));
  assert.equal(events.some((e) => e.type === "notice"), false);
});

const anthropicMessage = (id: string) => ({ id, type: "message", role: "assistant", content: [], model: "claude-opus-5-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 0 } });

test("anthropic: the web search tool, search activity, citations as sources, and replay with or without the tool", async () => {
  const results = [
    { type: "web_search_result", url: "https://en.wikipedia.org/wiki/Claude_Shannon", title: "Claude Shannon - Wikipedia", encrypted_content: "ENC1", page_age: "April 30, 2025" },
    { type: "web_search_result", url: "https://www.britannica.com/biography/Claude-Shannon", title: "Claude Shannon | Britannica", encrypted_content: "ENC2", page_age: null },
  ];
  const citation = { type: "web_search_result_location", url: results[0].url, title: results[0].title, encrypted_index: "IDX1", cited_text: "Claude Elwood Shannon (April 30, 1916 – February 24, 2001)" };
  const { baseUrl, requests } = await fakeServer([
    () => ({
      body: sse(
        [
          { type: "message_start", message: anthropicMessage("msg_s1") },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check. " } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query": ' } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"claude shannon birth date"}' } },
          { type: "content_block_stop", index: 1 },
          { type: "content_block_start", index: 2, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: results } },
          { type: "content_block_stop", index: 2 },
          { type: "content_block_start", index: 3, content_block: { type: "text", text: "", citations: [] } },
          { type: "content_block_delta", index: 3, delta: { type: "citations_delta", citation } },
          { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "He was born on April 30, 1916." } },
          { type: "content_block_stop", index: 3 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 40, server_tool_use: { web_search_requests: 1 } } },
          { type: "message_stop" },
        ],
        true,
      ),
    }),
  ]);
  const model: ResolvedModel = { kind: "anthropic", ref: { provider: "anthropic", model: "claude-opus-5-5" }, apiKey: "k", effort: "default", baseUrl, webSearch: true };
  const events = await collect(streamAnthropic(model, request(hello)));
  const body = requests[0].body;
  assert.deepEqual(body.tools.map((tool: { name: string }) => tool.name), ["read_file", "web_search"]);
  assert.deepEqual(body.tools[1], { type: "web_search_20250305", name: "web_search" }, "the basic tool: no code execution sandbox beside the user's PC");

  assert.deepEqual(searches(events), [
    ["web", null],
    ["web", "claude shannon birth date"],
  ]);
  assert.equal(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join(""), "Let me check. He was born on April 30, 1916.");
  assert.deepEqual(sourcesOf(events), [
    { url: results[0].url, title: results[0].title, cited: true },
    { url: results[1].url, title: results[1].title, cited: false },
  ]);
  const replay = replayOf(events);
  const blocks = (replay?.items ?? []) as Array<Record<string, any>>;
  assert.deepEqual(blocks[1], { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "claude shannon birth date" } });
  assert.deepEqual(blocks[2], { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: results }, "encrypted results are kept for the next request");
  assert.deepEqual(blocks[3].citations, [citation]);
  assert.deepEqual(events[events.length - 1], { type: "done", finishReason: "stop" });

  const next: ConvItem[] = [...hello, { kind: "assistant", text: "Let me check. He was born on April 30, 1916.", toolCalls: [], replay }, { kind: "user", parts: [{ type: "text", text: "[Sent now]\nthanks" }] }];
  assert.deepEqual(toAnthropicMessages(next, { webSearch: true })[1], { role: "assistant", content: blocks }, "the blocks go back unchanged");
  assert.deepEqual(
    toAnthropicMessages(next, { webSearch: false })[1],
    { role: "assistant", content: [{ type: "text", text: "Let me check. He was born on April 30, 1916." }] },
    "without the tool, the step is its text",
  );
});

test("anthropic: a turn the search loop paused ends the step as pause_turn", async () => {
  const { baseUrl } = await fakeServer([
    () => ({
      body: sse(
        [
          { type: "message_start", message: anthropicMessage("msg_p1") },
          { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_7", name: "web_search", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"long research"}' } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "pause_turn", stop_sequence: null }, usage: { output_tokens: 9 } },
          { type: "message_stop" },
        ],
        true,
      ),
    }),
  ]);
  const model: ResolvedModel = { kind: "anthropic", ref: { provider: "anthropic", model: "claude-opus-5-5" }, apiKey: "k", effort: "default", baseUrl, webSearch: true };
  const events = await collect(streamAnthropic(model, request(hello)));
  assert.equal(events.some((e) => e.type === "tool-call"), false);
  assert.deepEqual((replayOf(events)?.items as unknown[])[0], { type: "server_tool_use", id: "srvtoolu_7", name: "web_search", input: { query: "long research" } });
  assert.deepEqual(events[events.length - 1], { type: "done", finishReason: "pause_turn" });
});

test("anthropic: a search call that never got its result is left out unless the request continues its turn", () => {
  const replay = (items: unknown[]): ReplayState => ({ provider: "anthropic", model: "claude-opus-5-5", items });
  const stranded = { type: "server_tool_use", id: "srvtoolu_x", name: "web_search", input: { query: "q" } };
  const text = { type: "text", text: "Looking." };
  const moveOn: ConvItem = { kind: "user", parts: [{ type: "text", text: "[Sent now]\nnever mind" }] };

  // Paused, and this request continues it: kept. The run stopped there and the user moved on: dropped.
  const paused: ConvItem[] = [...hello, { kind: "assistant", text: "Looking.", toolCalls: [], replay: replay([text, stranded]) }];
  assert.deepEqual(toAnthropicMessages(paused, { webSearch: true })[1].content, [text, stranded]);
  assert.deepEqual(toAnthropicMessages([...paused, moveOn], { webSearch: true })[1].content, [text]);

  // Deferred beside a client tool call: kept while only its tool results follow, and once its result arrived.
  const toolUse = { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.txt" } };
  const deferred: ConvItem[] = [
    ...hello,
    { kind: "assistant", text: "", toolCalls: [{ id: "toolu_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }], replay: replay([stranded, toolUse]) },
    { kind: "tool-results", results: [{ callId: "toolu_1", name: "read_file", output: "hi", isError: false, image: null }] },
  ];
  assert.deepEqual(toAnthropicMessages(deferred, { webSearch: true })[1].content, [stranded, toolUse]);
  assert.deepEqual(toAnthropicMessages([...deferred, moveOn], { webSearch: true })[1].content, [toolUse], "results followed by a new prompt would close the turn without it");
  const answered: ConvItem[] = [
    ...deferred,
    { kind: "assistant", text: "Done.", toolCalls: [], replay: replay([{ type: "web_search_tool_result", tool_use_id: "srvtoolu_x", content: [] }, { type: "text", text: "Done." }]) },
    moveOn,
  ];
  assert.deepEqual(toAnthropicMessages(answered, { webSearch: true })[1].content, [stranded, toolUse]);
});

test("anthropic: an account that refuses web search answers without it, with a notice", async () => {
  const { baseUrl, requests } = await fakeServer([
    () => ({ status: 400, type: "application/json", body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Web search is not enabled for this organization." } }) }),
    () => ({
      body: sse(
        [
          { type: "message_start", message: anthropicMessage("msg_r1") },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "From memory: 1916." } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
          { type: "message_stop" },
        ],
        true,
      ),
    }),
  ]);
  const model: ResolvedModel = { kind: "anthropic", ref: { provider: "anthropic", model: "claude-opus-5-5" }, apiKey: "k", effort: "default", baseUrl, webSearch: true };
  const events = await collect(streamAnthropic(model, request(hello)));
  assert.equal(requests.length, 2);
  assert.ok(requests[0].body.tools.some((tool: { name: string }) => tool.name === "web_search"));
  assert.deepEqual(requests[1].body.tools.map((tool: { name: string }) => tool.name), ["read_file"]);
  const notice = events.find((e) => e.type === "notice");
  assert.match(notice?.type === "notice" ? notice.text : "", /didn't accept web search.*not enabled/);
  assert.deepEqual(events[events.length - 1], { type: "done", finishReason: "stop" });
});
