// Model settings (pushed by main on every change) and per-provider model lists
// (fetched on demand from each provider's API).
import { desktop, main } from "../bridge";
import { type AgentSummary, type ModelChoice, type ModelRef, type ModelSettings, parseModelRef, PROVIDER_IDS, PROVIDER_LABELS, type ProviderId } from "../../shared/model";
import { Store } from "./store";

export const modelSettings = new Store<ModelSettings>(desktop.boot.model);

export interface ModelList {
  models: ModelChoice[];
  loading: boolean;
  error: string | null;
}

export const modelLists = new Store<Partial<Record<ProviderId, ModelList>>>({});

let started = false;
export function startModels(): void {
  if (started) return;
  started = true;
  main.subscribe({ "model-settings-changed": (next) => modelSettings.set(next) });
}

export function setModelSettings(next: ModelSettings): void {
  modelSettings.set(next);
}

/** Providers that can serve requests right now. */
export function isProviderReady(provider: ProviderId, settings: ModelSettings): boolean {
  switch (provider) {
    case "xai":
      return settings.xai.hasApiKey;
    case "openai":
      return settings.openai.auth === "api-key" ? settings.openai.hasApiKey : settings.openai.chatgpt.connected && settings.openai.chatgpt.planUsage;
    case "anthropic":
      return settings.anthropic.hasApiKey;
    case "claude-code":
      return settings.claudeCode.installed;
    case "custom":
      return settings.custom.baseUrl.length > 0;
    case "mock":
      return true;
  }
}

export function readyProviders(settings: ModelSettings): ProviderId[] {
  return PROVIDER_IDS.filter((provider) => isProviderReady(provider, settings));
}

export async function loadModels(provider: ProviderId, force = false): Promise<void> {
  const current = modelLists.get()[provider];
  if (!force && current != null && (current.loading || current.error == null)) return;
  modelLists.set((lists) => ({ ...lists, [provider]: { models: current?.models ?? [], loading: true, error: null } }));
  try {
    const models = await main.listProviderModels({ provider });
    modelLists.set((lists) => ({ ...lists, [provider]: { models, loading: false, error: null } }));
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/^[\w/-]+: /, "") : String(error);
    modelLists.set((lists) => ({ ...lists, [provider]: { models: current?.models ?? [], loading: false, error: message } }));
  }
}

export function effectiveModel(agent: Pick<AgentSummary, "model"> | null, settings: ModelSettings): ModelRef {
  return parseModelRef(agent?.model, settings.defaultModel);
}

export function modelLabel(ref: ModelRef): string {
  if (ref.provider === "mock") return "Offline mock";
  if (ref.provider === "claude-code") return ref.model === "default" || ref.model.length === 0 ? "Claude Code" : `Claude Code · ${ref.model}`;
  return `${ref.model || "(no model)"} · ${PROVIDER_LABELS[ref.provider]}`;
}
