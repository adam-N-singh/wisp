// App settings owned by main, stored as `settings.json` in userData. Values
// that other processes depend on (models, tool permissions, the cloud
// computer) fan out through change listeners.
//
// Schema 2 replaced the single OpenAI-compatible `model` block with
// per-provider `models` preferences; older files are migrated on load.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODELS, DEFAULT_XAI_BASE_URL, type ModelRef, type ReasoningEffort, type ToolPermission } from "../shared/model";
import { writeFileAtomic } from "./atomic-write";

export interface ModelPrefs {
  defaultModel: ModelRef;
  reasoningEffort: ReasoningEffort;
  temperature: number | null;
  /** Let xAI, OpenAI and Anthropic models use their own web search. */
  webSearch: boolean;
  /** With web search on, Grok models also search X. */
  xSearch: boolean;
  xaiBaseUrl: string;
  /** Empty until the user sets up a custom OpenAI-compatible endpoint. */
  customBaseUrl: string;
  openaiAuth: "api-key" | "chatgpt";
  /** Overrides the detected Claude Code executable. */
  claudeCodeExecutable: string | null;
  /** Sign in with ChatGPT registration; kept across sign-outs so later sign-ins reuse it. */
  chatgpt: { clientId: string | null; hostId: string | null; email: string | null; sub: string | null; welcomeSeen: boolean };
}

export interface CloudPrefs {
  /** "desktop" adds a Linux desktop (screenshots, mouse and keyboard, a live view). */
  kind: "headless" | "desktop";
  /** Minutes without activity before the cloud computer pauses (and stops costing compute). */
  idleMinutes: number;
  /** Ask before running commands there (it is isolated from this computer, so off by default). */
  askBeforeCommands: boolean;
}

export interface BoxPrefs {
  /** "local": a utility process on this PC; "remote": the user's own box server (its token is a secret). */
  location: "local" | "remote";
  /** The remote box's address, e.g. https://box.example.com. */
  remoteUrl: string;
}

export interface Settings {
  schemaVersion: 2;
  theme: "system" | "light" | "dark";
  spellCheck: boolean;
  hardwareAcceleration: boolean;
  notifications: { enabled: boolean; onlyWhenUnfocused: boolean; sound: boolean };
  /** Check GitHub for new versions every few hours and download them (installed app only). */
  updates: { automatic: boolean };
  onboardingSeen: boolean;
  models: ModelPrefs;
  cloud: CloudPrefs;
  box: BoxPrefs;
  toolPermissions: Record<string, ToolPermission>;
  standingGrants: Array<{ toolId: string; scope: string; grantedAt: number }>;
  mountedAgentId: string | null;
  panelPosition: { x: number; y: number } | null;
}

const DEFAULT_MODEL_PREFS: ModelPrefs = {
  defaultModel: { provider: "xai", model: DEFAULT_MODELS.xai },
  reasoningEffort: "default",
  temperature: null,
  webSearch: true,
  xSearch: true,
  xaiBaseUrl: DEFAULT_XAI_BASE_URL,
  customBaseUrl: "",
  openaiAuth: "api-key",
  claudeCodeExecutable: null,
  chatgpt: { clientId: null, hostId: null, email: null, sub: null, welcomeSeen: false },
};

const DEFAULTS: Settings = {
  schemaVersion: 2,
  theme: "system",
  spellCheck: true,
  hardwareAcceleration: true,
  notifications: { enabled: true, onlyWhenUnfocused: true, sound: true },
  updates: { automatic: true },
  onboardingSeen: false,
  models: DEFAULT_MODEL_PREFS,
  cloud: { kind: "headless", idleMinutes: 10, askBeforeCommands: false },
  box: { location: "local", remoteUrl: "" },
  toolPermissions: {},
  standingGrants: [],
  mountedAgentId: null,
  panelPosition: null,
};

interface LegacyModel {
  provider?: "openai-compatible" | "mock";
  baseUrl?: string;
  model?: string;
  temperature?: number | null;
}

export class SettingsStore {
  private value: Settings;
  private listeners = new Set<(settings: Settings, changed: Array<keyof Settings>) => void>();
  private readonly file: string;
  /** Where the schema-1 API key belongs now ("model-api-key" -> this provider's key), if a migration ran. */
  readonly legacyKeyTarget: "xai" | "custom" | null = null;

  constructor(userDataDir: string) {
    this.file = join(userDataDir, "settings.json");
    let stored: Partial<Settings> & { model?: LegacyModel } = {};
    try {
      stored = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      // first run or unreadable: defaults
    }
    let models: ModelPrefs = { ...DEFAULT_MODEL_PREFS, ...stored.models, chatgpt: { ...DEFAULT_MODEL_PREFS.chatgpt, ...stored.models?.chatgpt } };
    if (stored.models == null && stored.model != null) {
      const migrated = migrateLegacyModel(stored.model);
      models = { ...models, ...migrated.prefs };
      this.legacyKeyTarget = migrated.keyTarget;
    }
    const { model: _legacy, ...rest } = stored;
    this.value = {
      ...DEFAULTS,
      ...rest,
      schemaVersion: 2,
      notifications: { ...DEFAULTS.notifications, ...stored.notifications },
      updates: { ...DEFAULTS.updates, ...stored.updates },
      models,
      cloud: { ...DEFAULTS.cloud, ...stored.cloud },
      box: { ...DEFAULTS.box, ...stored.box },
      toolPermissions: { ...stored.toolPermissions },
      standingGrants: Array.isArray(stored.standingGrants) ? stored.standingGrants : [],
    };
    if (this.legacyKeyTarget != null) void writeFileAtomic(this.file, JSON.stringify(this.value, null, 2)).catch(() => undefined);
  }

  get(): Readonly<Settings> {
    return this.value;
  }

  update(patch: Partial<Settings>): Settings {
    const changed = (Object.keys(patch) as Array<keyof Settings>).filter((key) => JSON.stringify(patch[key]) !== JSON.stringify(this.value[key]));
    if (changed.length === 0) return this.value;
    this.value = { ...this.value, ...patch };
    void writeFileAtomic(this.file, JSON.stringify(this.value, null, 2)).catch((error) => console.error("settings write failed", error));
    for (const listener of this.listeners) listener(this.value, changed);
    return this.value;
  }

  onChange(listener: (settings: Settings, changed: Array<keyof Settings>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function migrateLegacyModel(legacy: LegacyModel): { prefs: Partial<ModelPrefs>; keyTarget: "xai" | "custom" | null } {
  const temperature = typeof legacy.temperature === "number" ? legacy.temperature : null;
  if (legacy.provider === "mock") return { prefs: { defaultModel: { provider: "mock", model: DEFAULT_MODELS.mock }, temperature }, keyTarget: null };
  const baseUrl = (legacy.baseUrl ?? DEFAULT_XAI_BASE_URL).trim();
  const model = (legacy.model ?? "").trim();
  if (/^https:\/\/api\.x\.ai(\/|$)/i.test(baseUrl)) {
    return { prefs: { defaultModel: { provider: "xai", model: model || DEFAULT_MODELS.xai }, xaiBaseUrl: baseUrl, temperature }, keyTarget: "xai" };
  }
  return { prefs: { defaultModel: { provider: "custom", model }, customBaseUrl: baseUrl, temperature }, keyTarget: "custom" };
}
