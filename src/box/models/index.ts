// Model routing: a ModelRef is resolved against the connected providers, then
// streamed through the adapter for its API. Web search (on unless the config
// turns it off) is each provider's own server-side tool, so it decides the API
// for xAI: its web and X search exist only on its Responses API.
import type { BoxModelConfig } from "../../shared/edges";
import { DEFAULT_MODELS, type ModelChoice, type ModelRef, type ProviderId } from "../../shared/model";
import { anthropicCapabilities, listAnthropicModels, streamAnthropic } from "./anthropic";
import { listChatCompletionsModels, streamChatCompletions } from "./chat-completions";
import { streamMock } from "./mock";
import { listResponsesModels, streamResponses } from "./responses";
import type { ModelRequest, ResolvedModel, StreamEvent } from "./types";

export * from "./types";
export { anthropicCapabilities };

export interface ResolveDeps {
  /** A ChatGPT plan access token; main refreshes it when asked or when it is close to expiry. */
  chatGptToken(forceRefresh: boolean): Promise<string>;
}

export type Resolution = { ok: true; model: ResolvedModel } | { ok: false; reason: string };

const where = "Settings → Models";

export function resolveModel(config: BoxModelConfig | null, requested: ModelRef, deps: ResolveDeps): Resolution {
  const ref: ModelRef = { provider: requested.provider, model: requested.model.trim() || DEFAULT_MODELS[requested.provider] };
  const effort = config?.reasoningEffort ?? "default";
  const webSearch = config?.webSearch !== false;
  switch (ref.provider) {
    case "mock":
      return { ok: true, model: { kind: "mock", ref, webSearch } };
    case "xai": {
      if (config?.xai == null) return { ok: false, reason: `xAI isn't connected. Add an xAI API key in ${where}.` };
      const { baseUrl, apiKey } = config.xai;
      if (!webSearch) return { ok: true, model: { kind: "chat-completions", ref, baseUrl, apiKey, temperature: config.temperature } };
      return { ok: true, model: { kind: "responses", ref, baseUrl, effort, auth: { type: "api-key", apiKey }, search: { web: true, x: config.xSearch !== false }, temperature: config.temperature } };
    }
    case "custom":
      if (config?.custom == null) return { ok: false, reason: `The custom endpoint isn't set up. Add its address in ${where}.` };
      if (ref.model.length === 0) return { ok: false, reason: `Pick a model for the custom endpoint in ${where}.` };
      return { ok: true, model: { kind: "chat-completions", ref, baseUrl: config.custom.baseUrl, apiKey: config.custom.apiKey, temperature: config.temperature } };
    case "openai": {
      const openai = config?.openai;
      if (openai == null) return { ok: false, reason: `OpenAI isn't connected. Add an API key or continue with ChatGPT in ${where}.` };
      const auth = openai.auth === "api-key" ? { type: "api-key" as const, apiKey: openai.apiKey } : { type: "chatgpt" as const, accessToken: deps.chatGptToken };
      return { ok: true, model: { kind: "responses", ref, baseUrl: openai.baseUrl, effort, auth, search: { web: webSearch, x: false } } };
    }
    case "anthropic":
      if (config?.anthropic == null) return { ok: false, reason: `Anthropic isn't connected. Add an Anthropic API key in ${where}.` };
      return { ok: true, model: { kind: "anthropic", ref, apiKey: config.anthropic.apiKey, effort, webSearch } };
    case "claude-code":
      if (config?.claudeCode == null) return { ok: false, reason: `Claude Code wasn't found on this computer. Install it, sign in, then select Check again in ${where}.` };
      return { ok: true, model: { kind: "claude-code", ref, executable: config.claudeCode.executable, effort } };
  }
}

export function streamModel(model: ResolvedModel, request: ModelRequest): AsyncGenerator<StreamEvent> {
  switch (model.kind) {
    case "mock":
      return streamMock(request, model);
    case "chat-completions":
      return streamChatCompletions(model, request);
    case "responses":
      return streamResponses(model, request);
    case "anthropic":
      return streamAnthropic(model, request);
    case "claude-code":
      throw new Error("Claude Code runs as its own engine, not through streamModel.");
  }
}

const CLAUDE_CODE_MODELS: ModelChoice[] = [
  { id: "default", label: "Claude Code's default" },
  { id: "opus", label: "Opus (latest)" },
  { id: "sonnet", label: "Sonnet (latest)" },
  { id: "haiku", label: "Haiku (latest)" },
  { id: "fable", label: "Fable (latest, if your plan includes it)" },
];

export async function listModels(config: BoxModelConfig | null, provider: ProviderId, deps: ResolveDeps): Promise<ModelChoice[]> {
  if (provider === "claude-code") return CLAUDE_CODE_MODELS;
  if (provider === "mock") return [{ id: "mock-1", label: "Mock model" }];
  const resolution = resolveModel(config, { provider, model: provider === "custom" ? "list" : "" }, deps);
  if (!resolution.ok) throw new Error(resolution.reason);
  const model = resolution.model;
  switch (model.kind) {
    case "chat-completions":
      return (await listChatCompletionsModels(model.baseUrl, model.apiKey)).map((id) => ({ id }));
    case "responses":
      // xAI lists its models the same way whichever API serves them.
      if (model.ref.provider === "xai" && model.auth.type === "api-key") return (await listChatCompletionsModels(model.baseUrl, model.auth.apiKey)).map((id) => ({ id }));
      return listResponsesModels(model);
    case "anthropic":
      return listAnthropicModels(model);
    default:
      return [];
  }
}
