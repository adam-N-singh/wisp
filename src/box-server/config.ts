// Configuration for the standalone box server.
//
// Server settings (where to listen, TLS, the token, the data folder) come from
// command-line flags and environment variables only. Model and cloud-computer
// configuration has three sources, highest first:
//   1. what the desktop app pushes to POST /admin/configure (saved as <data>/app-config.json)
//   2. environment variables (XAI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, E2B_API_KEY, WISP_BOX_*)
//   3. a JSON file (WISP_BOX_CONFIG, default <data>/box-config.json)
// Credentials are merged per provider: one the app doesn't send falls back to
// the server's own, so keys set on the server stay available. Paths from the
// app (its workspace folder, its Claude Code executable) never apply here.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { BoxCloudConfig, BoxConfig, BoxModelConfig, BoxServerStatus } from "../shared/edges";
import { type ClaudeCodeStatus, DEFAULT_MODELS, DEFAULT_XAI_BASE_URL, type ModelRef, OPENAI_BASE_URL, PROVIDER_IDS, parseModelRef, type ReasoningEffort } from "../shared/model";

export const DEFAULT_PORT = 8787;

export interface ServerSettings {
  dataDir: string;
  host: string;
  port: number;
  /** From WISP_BOX_TOKEN or WISP_BOX_TOKEN_FILE; null means use (or create) <data>/gateway-token. */
  token: string | null;
  tls: { certFile: string; keyFile: string } | null;
  /** TLS ends at a reverse proxy in front of the box (Caddy, nginx, a tunnel). */
  behindTlsProxy: boolean;
  /** Accept configuration from the app at /admin. */
  admin: boolean;
  configFile: string;
  workspaceRoot: string;
}

/** Environment variables holding secrets; the server removes them from its environment once read. */
export const SECRET_ENV = ["WISP_BOX_TOKEN", "XAI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "WISP_BOX_CUSTOM_API_KEY", "E2B_API_KEY"] as const;

export class UsageError extends Error {}

export const USAGE = `Wisp box server: runs your agents and their automations on an always-on machine.

Usage: node dist/box-server/main.cjs [--data-dir <dir>] [--host <address>] [--port <n>] [--config <file>]

Settings (flags win over environment variables):
  WISP_BOX_DATA_DIR       data folder (default ~/.wisp-box; /data in the Docker image)
  WISP_BOX_HOST           listen address (default 127.0.0.1)
  WISP_BOX_PORT           listen port (default ${DEFAULT_PORT})
  WISP_BOX_TOKEN          bearer token for the app, at least 32 characters
  WISP_BOX_TOKEN_FILE     or read the token from this file (default: <data>/gateway-token, created on first start)
  WISP_BOX_TLS_CERT/_KEY  PEM files to serve HTTPS directly
  WISP_BOX_BEHIND_TLS_PROXY=1  plain HTTP behind a TLS-terminating proxy; required to listen beyond loopback without a certificate
  WISP_BOX_ADMIN=off      refuse configuration from the app (keys then come only from env or the config file)
  WISP_BOX_CONFIG         JSON config file (default <data>/box-config.json)
  WISP_BOX_WORKSPACES     agents' folders (default <data>/workspaces)

Models and the cloud computer (the app can also push these):
  XAI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, E2B_API_KEY
  WISP_BOX_XAI_BASE_URL, WISP_BOX_CUSTOM_BASE_URL, WISP_BOX_CUSTOM_API_KEY
  WISP_BOX_DEFAULT_MODEL (provider:model), WISP_BOX_REASONING_EFFORT (default|low|medium|high)
  WISP_BOX_WEB_SEARCH=off the providers' own web search (on by default); WISP_BOX_X_SEARCH=off leaves X out for xAI
  WISP_BOX_CLAUDE_CODE    path to the claude executable (found on PATH otherwise)
  WISP_BOX_CLOUD_KIND (headless|desktop), WISP_BOX_CLOUD_IDLE_MINUTES, WISP_BOX_CLOUD_ASK=1
  TZ                         time zone for automations; otherwise the one the app reports
`;

const truthy = (value: string | undefined) => value != null && /^(1|true|yes|on)$/i.test(value.trim());
const falsy = (value: string | undefined) => value != null && /^(0|false|no|off)$/i.test(value.trim());
const text = (value: string | undefined) => (value != null && value.trim().length > 0 ? value.trim() : null);
/** An on/off variable: null when unset. */
const flag = (value: string | undefined) => (truthy(value) ? true : falsy(value) ? false : null);

/** Flags and environment -> server settings. `readFile` reads WISP_BOX_TOKEN_FILE. */
export function readServerSettings(env: NodeJS.ProcessEnv, argv: string[], readFile: (path: string) => string): ServerSettings {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") throw new UsageError(USAGE);
    const match = /^--(data-dir|host|port|config)(?:=(.*))?$/.exec(arg);
    if (match == null) throw new UsageError(`Unknown argument ${arg}\n\n${USAGE}`);
    const value = match[2] ?? argv[++index];
    if (value == null) throw new UsageError(`--${match[1]} needs a value.`);
    flags.set(match[1], value);
  }
  const dataDir = resolve(flags.get("data-dir") ?? text(env.WISP_BOX_DATA_DIR) ?? join(homedir(), ".wisp-box"));
  const portText = flags.get("port") ?? text(env.WISP_BOX_PORT) ?? String(DEFAULT_PORT);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`Invalid port ${portText}.`);
  const tokenFile = text(env.WISP_BOX_TOKEN_FILE);
  const token = text(env.WISP_BOX_TOKEN) ?? (tokenFile != null ? text(readFile(tokenFile)) : null);
  if (token != null && token.length < 32) throw new UsageError("The box token must be at least 32 characters. Create one with: openssl rand -hex 32");
  const certFile = text(env.WISP_BOX_TLS_CERT);
  const keyFile = text(env.WISP_BOX_TLS_KEY);
  if ((certFile == null) !== (keyFile == null)) throw new UsageError("Set both WISP_BOX_TLS_CERT and WISP_BOX_TLS_KEY, or neither.");
  return {
    dataDir,
    host: flags.get("host") ?? text(env.WISP_BOX_HOST) ?? "127.0.0.1",
    port,
    token,
    tls: certFile != null && keyFile != null ? { certFile, keyFile } : null,
    behindTlsProxy: truthy(env.WISP_BOX_BEHIND_TLS_PROXY),
    admin: !falsy(env.WISP_BOX_ADMIN),
    configFile: resolve(flags.get("config") ?? text(env.WISP_BOX_CONFIG) ?? join(dataDir, "box-config.json")),
    workspaceRoot: resolve(text(env.WISP_BOX_WORKSPACES) ?? join(dataDir, "workspaces")),
  };
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

/** What the server's operator configured (config file and environment), before the app's pushes. */
export interface OperatorConfig {
  defaultModel: ModelRef | null;
  reasoningEffort: ReasoningEffort | null;
  temperature: number | null;
  /** null: as the app sets it, on by default. */
  webSearch: boolean | null;
  xSearch: boolean | null;
  xai: BoxModelConfig["xai"];
  openai: { baseUrl: string; apiKey: string } | null;
  anthropic: BoxModelConfig["anthropic"];
  custom: BoxModelConfig["custom"];
  claudeCodeExecutable: string | null;
  cloud: BoxCloudConfig | null;
  /** TZ as the operator set it; otherwise the box runs in the time zone the app reports. */
  timeZone: string | null;
}

const effort = z.enum(["default", "low", "medium", "high"]);
const operatorFile = z
  .object({
    defaultModel: z.string().max(200).optional(),
    reasoningEffort: effort.optional(),
    temperature: z.number().min(0).max(2).nullable().optional(),
    webSearch: z.boolean().optional(),
    xSearch: z.boolean().optional(),
    xai: z.object({ apiKey: z.string().min(1), baseUrl: z.string().url().optional() }).strict().optional(),
    openai: z.object({ apiKey: z.string().min(1), baseUrl: z.string().url().optional() }).strict().optional(),
    anthropic: z.object({ apiKey: z.string().min(1) }).strict().optional(),
    custom: z.object({ baseUrl: z.string().url(), apiKey: z.string().optional() }).strict().optional(),
    claudeCode: z.object({ executable: z.string().min(1) }).strict().optional(),
    cloud: z
      .object({ apiKey: z.string().min(1), kind: z.enum(["headless", "desktop"]).optional(), idleMinutes: z.number().int().min(1).max(60).optional(), askBeforeCommands: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict();

const parseRef = (value: string): ModelRef => {
  const ref = parseModelRef(value, { provider: "xai", model: "" });
  if (!value.includes(":") || !(PROVIDER_IDS as readonly string[]).includes(value.split(":")[0])) throw new UsageError(`"${value}" isn't a model reference like anthropic:claude-opus-5-5.`);
  return ref;
};

/** The config file (null when there is none) overlaid with environment variables. */
export function readOperatorConfig(env: NodeJS.ProcessEnv, fileText: string | null): OperatorConfig {
  let file: z.infer<typeof operatorFile> = {};
  if (fileText != null) {
    let raw: unknown;
    try {
      raw = JSON.parse(fileText);
    } catch (error) {
      throw new UsageError(`The box config file isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = operatorFile.safeParse(raw);
    if (!parsed.success) throw new UsageError(`The box config file isn't valid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
    file = parsed.data;
  }
  const xaiKey = text(env.XAI_API_KEY) ?? file.xai?.apiKey ?? null;
  const openaiKey = text(env.OPENAI_API_KEY) ?? file.openai?.apiKey ?? null;
  const anthropicKey = text(env.ANTHROPIC_API_KEY) ?? file.anthropic?.apiKey ?? null;
  const customBase = text(env.WISP_BOX_CUSTOM_BASE_URL) ?? file.custom?.baseUrl ?? null;
  const e2bKey = text(env.E2B_API_KEY) ?? file.cloud?.apiKey ?? null;
  const defaultModel = text(env.WISP_BOX_DEFAULT_MODEL) ?? file.defaultModel ?? null;
  const effortText = text(env.WISP_BOX_REASONING_EFFORT);
  if (effortText != null && !effort.safeParse(effortText).success) throw new UsageError(`WISP_BOX_REASONING_EFFORT must be default, low, medium or high.`);
  const kindText = text(env.WISP_BOX_CLOUD_KIND);
  if (kindText != null && kindText !== "headless" && kindText !== "desktop") throw new UsageError("WISP_BOX_CLOUD_KIND must be headless or desktop.");
  const idle = Number(text(env.WISP_BOX_CLOUD_IDLE_MINUTES) ?? file.cloud?.idleMinutes ?? 10);
  return {
    defaultModel: defaultModel != null ? parseRef(defaultModel) : null,
    reasoningEffort: (effortText as ReasoningEffort | null) ?? file.reasoningEffort ?? null,
    temperature: file.temperature ?? null,
    webSearch: flag(env.WISP_BOX_WEB_SEARCH) ?? file.webSearch ?? null,
    xSearch: flag(env.WISP_BOX_X_SEARCH) ?? file.xSearch ?? null,
    xai: xaiKey != null ? { apiKey: xaiKey, baseUrl: text(env.WISP_BOX_XAI_BASE_URL) ?? file.xai?.baseUrl ?? DEFAULT_XAI_BASE_URL } : null,
    openai: openaiKey != null ? { apiKey: openaiKey, baseUrl: file.openai?.baseUrl ?? OPENAI_BASE_URL } : null,
    anthropic: anthropicKey != null ? { apiKey: anthropicKey } : null,
    custom: customBase != null ? { baseUrl: customBase, apiKey: text(env.WISP_BOX_CUSTOM_API_KEY) ?? file.custom?.apiKey ?? "" } : null,
    claudeCodeExecutable: text(env.WISP_BOX_CLAUDE_CODE) ?? file.claudeCode?.executable ?? null,
    timeZone: text(env.TZ),
    cloud:
      e2bKey != null
        ? {
            apiKey: e2bKey,
            kind: (kindText as "headless" | "desktop" | null) ?? file.cloud?.kind ?? "headless",
            idleMinutes: Number.isInteger(idle) && idle >= 1 && idle <= 60 ? idle : 10,
            askBeforeCommands: env.WISP_BOX_CLOUD_ASK != null ? truthy(env.WISP_BOX_CLOUD_ASK) : (file.cloud?.askBeforeCommands ?? false),
          }
        : null,
  };
}

/** Removes secrets from the environment so MCP servers and Claude Code, which inherit it, never see them. */
export function scrubSecretEnv(env: NodeJS.ProcessEnv): void {
  for (const name of SECRET_ENV) delete env[name];
}

export interface EffectiveInput {
  operator: OperatorConfig;
  /** The app's last push, or null. */
  pushed: BoxConfig | null;
  workspaceRoot: string;
  claudeCode: ClaudeCodeStatus;
  /** A ChatGPT sign-in was copied to this server. */
  chatGptSignedIn: boolean;
}

/** The configuration the box runs with, and where each provider's credentials came from. */
export function effectiveConfig(input: EffectiveInput): { config: BoxConfig; providers: BoxServerStatus["providers"] } {
  const { operator, pushed } = input;
  const app = pushed?.models;
  const pick = <T>(fromApp: T | null | undefined, fromServer: T | null): [T | null, "app" | "server" | null] =>
    fromApp != null ? [fromApp, "app"] : fromServer != null ? [fromServer, "server"] : [null, null];

  const [xai, xaiSource] = pick(app?.xai, operator.xai);
  const [anthropic, anthropicSource] = pick(app?.anthropic, operator.anthropic);
  const [custom, customSource] = pick(app?.custom, operator.custom);
  const [cloud, cloudSource] = pick(pushed?.cloud, operator.cloud);

  // A ChatGPT plan only works through the sign-in copied here; the app's own tokens never are.
  const chatgpt: BoxModelConfig["openai"] = input.chatGptSignedIn ? { baseUrl: OPENAI_BASE_URL, auth: "chatgpt", accessToken: "", expiresAt: 0 } : null;
  let openai: BoxModelConfig["openai"] = null;
  let openaiSource: "app" | "server" | null = null;
  if (app?.openai?.auth === "api-key") [openai, openaiSource] = [app.openai, "app"];
  else if (app?.openai?.auth === "chatgpt") [openai, openaiSource] = [chatgpt, chatgpt != null ? "app" : null];
  else if (operator.openai != null) [openai, openaiSource] = [{ baseUrl: operator.openai.baseUrl, auth: "api-key", apiKey: operator.openai.apiKey }, "server"];
  else if (chatgpt != null) [openai, openaiSource] = [chatgpt, "server"];

  const claudeCode = input.claudeCode.installed && input.claudeCode.executable != null ? { executable: input.claudeCode.executable } : null;
  const connected: ModelRef | null =
    xai != null ? { provider: "xai", model: DEFAULT_MODELS.xai }
    : openai != null ? { provider: "openai", model: DEFAULT_MODELS.openai }
    : anthropic != null ? { provider: "anthropic", model: DEFAULT_MODELS.anthropic }
    : claudeCode != null ? { provider: "claude-code", model: DEFAULT_MODELS["claude-code"] }
    : null;

  return {
    config: {
      models: {
        defaultModel: app?.defaultModel ?? operator.defaultModel ?? connected ?? { provider: "xai", model: DEFAULT_MODELS.xai },
        reasoningEffort: app?.reasoningEffort ?? operator.reasoningEffort ?? "default",
        temperature: app != null ? app.temperature : operator.temperature,
        xai,
        openai,
        anthropic,
        custom,
        claudeCode,
        webSearch: app?.webSearch ?? operator.webSearch ?? true,
        xSearch: app?.xSearch ?? operator.xSearch ?? true,
      },
      workspaceRoot: input.workspaceRoot,
      cloud,
      timeZone: operator.timeZone ?? pushed?.timeZone ?? null,
    },
    providers: { xai: xaiSource, openai: openaiSource, anthropic: anthropicSource, custom: customSource, cloud: cloudSource },
  };
}
