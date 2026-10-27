// OpenAI-compatible `/chat/completions` with streamed tool calling: xAI's API
// and any custom endpoint (OpenRouter, a local server, …).
import { type ConvItem, type ModelRequest, ModelError, readErrorBody, type ResolvedModel, sseData, type StreamEvent, toDataUrl, type ToolCall } from "./types";

type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export function toChatMessages(system: string, items: ConvItem[]): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: system }];
  for (const item of items) {
    if (item.kind === "user") {
      const onlyText = item.parts.every((part) => part.type === "text");
      messages.push({
        role: "user",
        content: onlyText
          ? item.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n\n")
          : item.parts.map((part) => (part.type === "text" ? { type: "text" as const, text: part.text } : { type: "image_url" as const, image_url: { url: toDataUrl(part.image) } })),
      });
    } else if (item.kind === "assistant") {
      if (item.text.length === 0 && item.toolCalls.length === 0) continue;
      messages.push({ role: "assistant", content: item.text.length > 0 ? item.text : null, ...(item.toolCalls.length > 0 ? { tool_calls: item.toolCalls } : {}) });
    } else {
      for (const result of item.results) messages.push({ role: "tool", tool_call_id: result.callId, content: result.output });
      // Tool messages carry text only; images follow as a user message.
      const images = item.results.filter((result) => result.image != null);
      if (images.length > 0) {
        messages.push({
          role: "user",
          content: images.flatMap((result) => [
            { type: "text" as const, text: `Image returned by ${result.name}:` },
            { type: "image_url" as const, image_url: { url: toDataUrl(result.image!) } },
          ]),
        });
      }
    }
  }
  return messages;
}

export async function* streamChatCompletions(model: Extract<ResolvedModel, { kind: "chat-completions" }>, request: ModelRequest): AsyncGenerator<StreamEvent> {
  const post = (withUsage: boolean) =>
    fetch(`${model.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: request.signal,
      headers: { "content-type": "application/json", ...(model.apiKey.length > 0 ? { authorization: `Bearer ${model.apiKey}` } : {}) },
      body: JSON.stringify({
        model: model.ref.model,
        messages: toChatMessages(request.system, request.items),
        tools: request.tools.length > 0 ? request.tools : undefined,
        tool_choice: request.tools.length > 0 ? "auto" : undefined,
        temperature: model.temperature ?? undefined,
        stream: true,
        ...(withUsage ? { stream_options: { include_usage: true } } : {}),
      }),
    });
  const provider = model.ref.provider === "xai" ? "xAI" : "model API";
  let response = await post(true);
  if (response.status === 400) {
    // Not every OpenAI-compatible provider accepts stream_options; retry once without it.
    const error = await readErrorBody(response);
    if (!/stream_options|include_usage/i.test(error.message)) throw new ModelError(400, error.message.slice(0, 2000), error.code, provider);
    response = await post(false);
  }
  if (!response.ok || response.body == null) {
    const error = await readErrorBody(response);
    throw new ModelError(response.status, error.message.slice(0, 2000), error.code, provider);
  }

  // Tool-call arguments arrive as fragments keyed by index; assemble them and
  // emit each call once the stream finishes.
  const calls = new Map<number, ToolCall>();
  let finishReason = "stop";
  for await (const data of sseData(response.body, request.signal)) {
    if (data === "[DONE]") break;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error != null) throw new ModelError(500, String(chunk.error.message ?? JSON.stringify(chunk.error)).slice(0, 2000), chunk.error.code ?? null, provider);
    if (chunk.usage != null) {
      yield { type: "usage", inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0, cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0 };
    }
    const choice = chunk.choices?.[0];
    if (choice == null) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) yield { type: "reasoning", delta: delta.reasoning_content };
    if (typeof delta.content === "string" && delta.content.length > 0) yield { type: "text", delta: delta.content };
    for (const fragment of delta.tool_calls ?? []) {
      const index = typeof fragment.index === "number" ? fragment.index : calls.size;
      const call = calls.get(index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
      if (fragment.id) call.id = fragment.id;
      if (fragment.function?.name) call.function.name += fragment.function.name;
      if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments;
      calls.set(index, call);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  for (const [index, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
    yield { type: "tool-call", call: { ...call, id: call.id || `call_${index}_${Date.now().toString(36)}` } };
  }
  yield { type: "done", finishReason };
}

export async function listChatCompletionsModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { headers: apiKey.length > 0 ? { authorization: `Bearer ${apiKey}` } : {} });
  if (!response.ok) {
    const error = await readErrorBody(response);
    throw new ModelError(response.status, error.message, error.code);
  }
  const json = (await response.json()) as { data?: Array<{ id: string }> };
  return (json.data ?? []).map((model) => model.id).sort();
}
