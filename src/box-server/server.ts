// The standalone box server: the box host (src/box/host.ts) without Electron
// or a MessagePort, for an always-on machine, so agents and their automations
// keep running while the user's PC is off. The PC's app connects to it like it
// connects to the box on the PC, over HTTPS with a bearer token; its local-exec
// daemon dials in to offer tools on the PC whenever the PC is on.
//
// What main does for the box on the PC, this does itself: configuration comes
// from a file, the environment and the app's pushes to /admin; ChatGPT plan
// and MCP server tokens are refreshed from sign-ins copied here; Claude Code
// is the server's own installation, signed in on the server.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { detectClaudeCode } from "../main/claude-code-cli";
import { type BoxConfig, boxAdminEdge, type BoxServerStatus } from "../shared/edges";
import { GATEWAY_PROTOCOL_VERSION } from "../shared/gateway-protocol";
import type { ClaudeCodeStatus } from "../shared/model";
import { type BoxHost, startBoxHost } from "../box/host";
import { CommandError, readJson, sendJson as json } from "../box/http";
import { ServerChatGptSignIn, writePrivateFile } from "./chatgpt-sign-in";
import { effectiveConfig, isLoopbackHost, type OperatorConfig, readOperatorConfig, scrubSecretEnv, type ServerSettings, UsageError } from "./config";
import { serverMcpSignIns } from "./mcp-sign-ins";

export interface BoxServerOptions {
  settings: ServerSettings;
  /** Read for model and cloud configuration, then stripped of secrets (pass process.env in production). */
  env: NodeJS.ProcessEnv;
  version: string;
  /** Tests point Sign in with ChatGPT at a fake. */
  chatGptAuthBase?: string;
  /** Finds and checks the server's Claude Code (tests replace it). */
  detectClaudeCode?(executable: string | null): Promise<ClaudeCodeStatus>;
  log(line: string): void;
}

export interface BoxServer {
  readonly port: number;
  readonly url: string;
  /** Set when the token was created on this start (and saved in the data folder). */
  readonly createdTokenFile: string | null;
  readonly host: BoxHost;
  status(): BoxServerStatus;
  close(): void;
}

/** Admin methods that change the box; with WISP_BOX_ADMIN=off only the read-only ones answer. */
const MUTATING = new Set(["configure", "importChatGptSignIn", "signOutChatGpt", "importMcpSignIn", "signOutMcpServer"]);

const NOT_CHECKED: ClaudeCodeStatus = { executable: null, installed: false, version: null, signedIn: false, authMethod: null, checkedAt: 0 };

export async function startBoxServer(options: BoxServerOptions): Promise<BoxServer> {
  const { settings, log } = options;
  if (settings.tls == null && !settings.behindTlsProxy && !isLoopbackHost(settings.host)) {
    throw new UsageError(
      `Refusing to serve the box on ${settings.host} over plain HTTP: the token and your API keys would cross the network unencrypted. ` +
        "Set WISP_BOX_TLS_CERT and WISP_BOX_TLS_KEY, or put a TLS proxy in front and set WISP_BOX_BEHIND_TLS_PROXY=1.",
    );
  }
  mkdirSync(settings.dataDir, { recursive: true });

  // ---- token ------------------------------------------------------------------------------
  let token = settings.token;
  let createdTokenFile: string | null = null;
  if (token == null) {
    const file = join(settings.dataDir, "gateway-token");
    token = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    if (token.length < 32) {
      token = randomBytes(32).toString("hex");
      writePrivateFile(file, `${token}\n`);
      createdTokenFile = file;
    }
  }

  // ---- configuration ----------------------------------------------------------------------
  const operator: OperatorConfig = readOperatorConfig(options.env, existsSync(settings.configFile) ? readFileSync(settings.configFile, "utf8") : null);
  scrubSecretEnv(options.env);
  const pushedFile = join(settings.dataDir, "app-config.json");
  const configureSchema = boxAdminEdge.methods.configure.schema!;
  let pushed: BoxConfig | null = null;
  if (existsSync(pushedFile)) {
    const parsed = configureSchema.safeParse(JSON.parse(readFileSync(pushedFile, "utf8")));
    if (parsed.success) pushed = parsed.data;
    else log(`ignoring ${pushedFile}: ${parsed.error.message}`);
  }
  const chatgpt = new ServerChatGptSignIn({ dataDir: settings.dataDir, authBase: options.chatGptAuthBase, log });
  const mcpSignIns = serverMcpSignIns(settings.dataDir, log);
  let claudeCode = NOT_CHECKED;
  let box: BoxHost | null = null;
  let effective = effectiveConfig({ operator, pushed, workspaceRoot: settings.workspaceRoot, claudeCode, chatGptSignedIn: chatgpt.status().connected });

  const apply = () => {
    effective = effectiveConfig({ operator, pushed, workspaceRoot: settings.workspaceRoot, claudeCode, chatGptSignedIn: chatgpt.status().connected });
    box?.configure(effective.config);
  };
  const status = (): BoxServerStatus => ({
    version: options.version,
    protocol: GATEWAY_PROTOCOL_VERSION,
    localExec: box?.localExecReady() ? "ready" : "down",
    admin: settings.admin,
    providers: effective.providers,
    chatgpt: chatgpt.status(),
    claudeCode,
  });
  const checkClaudeCode = async () => {
    claudeCode = await (options.detectClaudeCode ?? detectClaudeCode)(operator.claudeCodeExecutable);
    apply();
  };

  // ---- admin: POST /admin/<method> with the gateway token ---------------------------------
  const handlers: { [K in keyof typeof boxAdminEdge.methods]: (args: any) => unknown } = {
    status: () => status(),
    configure: (next: BoxConfig) => {
      pushed = next;
      writePrivateFile(pushedFile, JSON.stringify(next));
      apply();
      return status();
    },
    listModels: ({ provider }) => box!.listModels(provider),
    importChatGptSignIn: (tokens) => {
      chatgpt.import(tokens);
      apply();
      return status();
    },
    signOutChatGpt: async () => {
      await chatgpt.signOut();
      apply();
      return status();
    },
    checkClaudeCode: async () => {
      await checkClaudeCode();
      return status();
    },
    mcpSignInTarget: ({ serverId }) => box!.mcpSignInTarget(serverId),
    importMcpSignIn: async ({ serverId, credentials }) => {
      // A sign-in is for the address it was made with; the server may have been removed or changed meanwhile.
      if (box!.mcpSignInTarget(serverId).url !== credentials.serverUrl) throw new CommandError(409, "That sign-in is for a different server address. Sign in again.");
      await mcpSignIns.save(serverId, credentials);
      box!.mcpSignInChanged(serverId);
      return status();
    },
    signOutMcpServer: async ({ serverId }) => {
      await mcpSignIns.forget(serverId, true);
      box!.mcpSignInChanged(serverId);
      return status();
    },
  };

  async function admin(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const method = decodeURIComponent(url.pathname.slice("/admin/".length));
    const decl = (boxAdminEdge.methods as Record<string, { schema: { safeParse(v: unknown): any } | null }>)[method];
    const handler = (handlers as Record<string, (args: unknown) => unknown>)[method];
    if (decl == null || handler == null) {
      json(response, 404, { error: `unknown admin method ${method}`, failureCode: "admin/unknown-method" });
      return true;
    }
    if (request.method !== "POST") {
      json(response, 405, { error: "use POST" });
      return true;
    }
    if (!settings.admin && MUTATING.has(method)) {
      json(response, 403, { error: "This box doesn't accept settings from the app (WISP_BOX_ADMIN=off). Set keys on the server instead.", failureCode: "admin/disabled" });
      return true;
    }
    const parsed = decl.schema?.safeParse(await readJson(request)) ?? { success: true, data: {} };
    if (!parsed.success) {
      json(response, 400, { error: `${method}: ${parsed.error.message}` });
      return true;
    }
    json(response, 200, (await handler(parsed.data)) ?? null);
    return true;
  }

  const host = await startBoxHost({
    dataDir: settings.dataDir,
    version: options.version,
    token,
    host: settings.host,
    port: settings.port,
    tls: settings.tls != null ? { cert: readFileSync(settings.tls.certFile), key: readFileSync(settings.tls.keyFile) } : null,
    bridgeListener: "loopback",
    config: effective.config,
    refreshChatGptToken: (force) => chatgpt.accessToken(force),
    mcpAuth: {
      accessToken: (server, force) => mcpSignIns.accessToken(server.id, server.url, force),
      forget: async (serverId) => void (await mcpSignIns.forget(serverId, true)),
    },
    routes: (request, response, url) => (url.pathname.startsWith("/admin/") ? admin(request, response, url) : Promise.resolve(false)),
    log,
  });
  box = host;
  void checkClaudeCode().catch((error) => log(`Claude Code detection failed: ${String(error)}`));

  const scheme = settings.tls != null ? "https" : "http";
  return {
    port: host.port,
    url: `${scheme}://${settings.host.includes(":") ? `[${settings.host}]` : settings.host}:${host.port}`,
    createdTokenFile,
    host,
    status,
    close: () => host.close(),
  };
}
