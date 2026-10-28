// Minimal Model Context Protocol client (initialize -> notifications/initialized -> tools/list ->
// tools/call) over two transports:
//   stdio            newline-delimited JSON-RPC 2.0 with a child process
//   Streamable HTTP  one POST per message to the server's URL, answered with JSON or an SSE stream
//                    that may carry server requests first; Mcp-Session-Id and MCP-Protocol-Version
//                    headers; DELETE ends the session
// An HTTP server that answers 401 needs an OAuth sign-in. Main runs it (src/main/mcp-auth.ts); the
// box only asks its McpAuthProvider for access tokens.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readSse } from "../shared/gateway-protocol";
import { isSecureEndpoint, MCP_REFRESH_MARGIN_MS, parseWwwAuthenticate } from "../shared/mcp-oauth";
import type { McpAuthChallenge, McpHttpServerConfig, McpOAuthClientConfig, McpServerConfig, McpServerSummary, McpServerTool, McpSignInTarget, McpStdioServerConfig, OrderedStamp } from "../shared/model";

const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 60_000;
const CLIENT_INFO = { name: "wisp", version: "0.2.0" };

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
}

export interface McpCallResult {
  text: string;
  image: { mime: string; base64: string } | null;
  isError: boolean;
}

/** Access tokens for HTTP servers: main's sign-ins for the box on this PC, the server's own on a remote box. */
export interface McpAuthProvider {
  /** A valid access token for the server, or null without a sign-in for it; `force` refreshes (after a 401). */
  accessToken(server: { id: string; url: string }, force: boolean): Promise<{ accessToken: string; expiresAt: number } | null>;
  /** The server was removed: revoke and forget its sign-in. */
  forget(serverId: string): Promise<void>;
}

/** The server wants an OAuth sign-in (again). */
class McpAuthRequired extends Error {
  constructor(readonly challenge: McpAuthChallenge | null) {
    super("The MCP server needs you to sign in.");
  }
}

/** The HTTP server no longer knows our session (404 on a request that carried its id). */
class McpSessionExpired extends Error {}

interface Channel {
  request(method: string, params: unknown, signal?: AbortSignal): Promise<any>;
  notify(method: string, params: unknown): Promise<void>;
  close(): void;
}

/**
 * On Windows servers start through cmd.exe (so `npx` resolves), which splits arguments at spaces
 * and acts on & | < > ^ ( ): such an argument is quoted, like a path with a space in it.
 */
const shellArg = (arg: string) => (process.platform !== "win32" || /^[\w\-.:\\/=,@+]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`);

/**
 * What a program needs from the environment to start and find its tools: the search path, the
 * user's folders, temp, locale, and on Windows the system folders. A server started with
 * `basicEnv` gets only these, so the box's keys and tokens (XAI_API_KEY, WISP_BOX_TOKEN, …)
 * stay out of a marketplace plugin's process.
 */
export const BASIC_ENV = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
];

/** The box's environment cut down to BASIC_ENV (names compared without case, as Windows does). */
export function basicEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const wanted = new Set(BASIC_ENV);
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] != null && wanted.has(entry[0].toUpperCase())));
}

/**
 * Every other variable of the box's environment, empty: for a client that starts the server
 * itself with its own environment under the server's (Claude Code), which can't leave one out.
 */
export function blankedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const wanted = new Set(BASIC_ENV);
  return Object.fromEntries(Object.keys(env).filter((name) => !wanted.has(name.toUpperCase())).map((name) => [name, ""]));
}

/** A child process speaking newline-delimited JSON-RPC on stdin and stdout. */
class StdioChannel implements Channel {
  private child: ChildProcessWithoutNullStreams | null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = "";

  constructor(
    private readonly config: McpStdioServerConfig,
    /** The process ended on its own (not through close()). */
    private readonly onExit: (detail: string) => void,
    private readonly log: (line: string) => void,
  ) {
    const child = spawn(shellArg(config.command), config.args.map(shellArg), {
      env: { ...(config.basicEnv === true ? basicEnv() : process.env), ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true,
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => log(`[mcp ${config.name}] ${chunk.trimEnd()}`));
    child.on("exit", (code) => this.exited(code));
    child.on("error", (error) => this.exited(null, error));
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.child == null) return reject(new Error("MCP server not running"));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener("abort", () => {
        if (!this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        void this.notify("notifications/cancelled", { requestId: id, reason: "interrupted" });
        reject(new Error("interrupted"));
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  close(): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("MCP server stopped"));
    }
    this.pending.clear();
    const child = this.child;
    this.child = null;
    child?.kill();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        this.log(`[mcp ${this.config.name}] non-JSON output: ${line.slice(0, 200)}`);
        continue;
      }
      if (message.id != null && (message.result !== undefined || message.error !== undefined)) {
        const waiter = this.pending.get(message.id);
        if (waiter == null) continue;
        clearTimeout(waiter.timer);
        this.pending.delete(message.id);
        if (message.error != null) waiter.reject(new Error(message.error.message ?? "MCP error"));
        else waiter.resolve(message.result);
      } else if (message.id != null && typeof message.method === "string") {
        this.child?.stdin.write(`${JSON.stringify(answerServerRequest(message.id, message.method))}\n`);
      }
    }
  }

  private exited(code: number | null, error?: Error): void {
    if (this.child == null) return;
    this.child = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(`MCP server exited (${code ?? error?.message ?? "unknown"})`));
    }
    this.pending.clear();
    this.onExit(error?.message ?? `exited with code ${code}`);
  }
}

/** A server-to-client request: answer ping, decline the rest (this client offers no sampling or elicitation). */
function answerServerRequest(id: unknown, method: string): unknown {
  return { jsonrpc: "2.0", id, ...(method === "ping" ? { result: {} } : { error: { code: -32601, message: `unsupported: ${method}` } }) };
}

const describeFetchError = (url: string, error: unknown) => {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  return new Error(`Couldn't reach ${new URL(url).host} (${cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error))}).`);
};

/** MCP Streamable HTTP: every message is a POST to the server's URL. */
class HttpChannel implements Channel {
  private nextId = 1;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private token: { accessToken: string; expiresAt: number } | null = null;
  /** The provider was asked for a token; a server without a sign-in isn't asked again until a 401. */
  private tokenChecked = false;
  private readonly requests = new Set<AbortController>();
  private closed = false;

  constructor(
    private readonly config: McpHttpServerConfig,
    private readonly auth: McpAuthProvider | null,
    private readonly log: (line: string) => void,
  ) {}

  /** Requests carry an OAuth access token. */
  get signedIn(): boolean {
    return this.token != null;
  }

  /** OAuth applies unless the config sets its own Authorization header. */
  private get usesOAuth(): boolean {
    return this.auth != null && !Object.keys(this.config.headers).some((name) => name.toLowerCase() === "authorization");
  }

  /** The version agreed on in initialize goes on every later request. */
  initialized(protocolVersion: unknown): void {
    this.protocolVersion = typeof protocolVersion === "string" ? protocolVersion : PROTOCOL_VERSION;
  }

  async request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) throw new Error("interrupted");
    if (this.closed) throw new Error("MCP server not running");
    const id = this.nextId++;
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(new Error(`MCP ${method} timed out`)), REQUEST_TIMEOUT_MS);
    const onAbort = () => {
      controller.abort(new Error("interrupted"));
      void this.notify("notifications/cancelled", { requestId: id, reason: "interrupted" });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const initializing = method === "initialize";
      const response = await this.post({ jsonrpc: "2.0", id, method, params }, controller.signal, initializing);
      if (initializing) this.sessionId = response.headers.get("mcp-session-id");
      const reply = await this.reply(response, id, controller.signal);
      if (reply.error != null) throw new Error(reply.error.message ?? "MCP error");
      return reply.result;
    } catch (error) {
      // Say why the wait ended (timeout, interrupt, stop) rather than the fetch's AbortError.
      if (controller.signal.aborted && !(error instanceof McpAuthRequired) && !(error instanceof McpSessionExpired)) {
        throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error("MCP request aborted");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      this.requests.delete(controller);
      controller.abort(); // releases a reply stream the server left open
    }
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.send({ jsonrpc: "2.0", method, params });
  }

  /** The configured headers plus a current access token, for a client that calls the server itself. */
  async clientHeaders(): Promise<Record<string, string>> {
    const headers = { ...this.config.headers };
    if (this.usesOAuth && this.token != null) {
      this.token = await this.auth!.accessToken({ id: this.config.id, url: this.config.url }, false);
      if (this.token != null) headers.Authorization = `Bearer ${this.token.accessToken}`;
    }
    return headers;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.requests) controller.abort(new Error("MCP server stopped"));
    if (this.sessionId == null) return;
    // Ends the session on the server; one that doesn't allow it answers 405.
    const headers = this.baseHeaders(false);
    if (this.token != null) headers.set("authorization", `Bearer ${this.token.accessToken}`);
    void fetch(this.config.url, { method: "DELETE", headers, signal: AbortSignal.timeout(5_000) }).then(
      (response) => response.body?.cancel(),
      () => undefined,
    );
  }

  private baseHeaders(initializing: boolean): Headers {
    const headers = new Headers(this.config.headers);
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json, text/event-stream");
    if (this.sessionId != null && !initializing) headers.set("mcp-session-id", this.sessionId);
    if (this.protocolVersion != null && !initializing) headers.set("mcp-protocol-version", this.protocolVersion);
    return headers;
  }

  private async headers(initializing: boolean, refresh: boolean): Promise<Headers> {
    const headers = this.baseHeaders(initializing);
    if (this.usesOAuth) {
      const stale = this.token != null && this.token.expiresAt - Date.now() < MCP_REFRESH_MARGIN_MS;
      if (refresh || stale || !this.tokenChecked) {
        this.token = await this.auth!.accessToken({ id: this.config.id, url: this.config.url }, refresh);
        this.tokenChecked = true;
      }
      if (this.token != null) headers.set("authorization", `Bearer ${this.token.accessToken}`);
    }
    return headers;
  }

  private async post(message: unknown, signal: AbortSignal, initializing: boolean): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const headers = await this.headers(initializing, attempt > 0);
      let response: Response;
      try {
        response = await fetch(this.config.url, { method: "POST", headers, body: JSON.stringify(message), signal });
      } catch (error) {
        if (signal.aborted) throw error;
        throw describeFetchError(this.config.url, error);
      }
      const challenge = response.headers.get("www-authenticate");
      if (response.status === 401 || (response.status === 403 && /insufficient_scope/i.test(challenge ?? ""))) {
        await response.body?.cancel();
        if (!this.usesOAuth) throw new Error(`HTTP ${response.status}: the server refused the credentials in this server's headers.`);
        // A token the server refused gets one refresh before the user is asked to sign in again.
        if (response.status === 401 && attempt === 0 && this.token != null) continue;
        throw new McpAuthRequired(parseWwwAuthenticate(challenge));
      }
      if (response.status === 404 && this.sessionId != null && !initializing) {
        await response.body?.cancel();
        this.sessionId = null;
        throw new McpSessionExpired("The MCP server ended the session.");
      }
      if (!response.ok) {
        const text = (await response.text().catch(() => "")).trim();
        throw new Error(`HTTP ${response.status}${text.length > 0 ? `: ${text.slice(0, 300)}` : ""}`);
      }
      return response;
    }
  }

  /** The response to request `id`, from a JSON body or an SSE stream (answering server requests on the way). */
  private async reply(response: Response, id: number, signal: AbortSignal): Promise<any> {
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (type.startsWith("text/event-stream") && response.body != null) {
      for await (const block of readSse(response.body, signal)) {
        if (block.data == null) continue;
        let payload: unknown;
        try {
          payload = JSON.parse(block.data);
        } catch {
          this.log(`[mcp ${this.config.name}] non-JSON event: ${block.data.slice(0, 200)}`);
          continue;
        }
        const answer = this.receive(payload, id);
        if (answer != null) return answer;
      }
      throw new Error("The MCP server closed its reply stream without an answer.");
    }
    if (type.startsWith("application/json")) {
      const answer = this.receive(await response.json(), id);
      if (answer != null) return answer;
      throw new Error("The MCP server's reply didn't answer the request.");
    }
    await response.body?.cancel();
    throw new Error(`The MCP server answered with ${type.length > 0 ? type : `HTTP ${response.status} and no content type`}.`);
  }

  /** Handles one JSON-RPC message or batch; returns the response with this id when it's there. */
  private receive(payload: unknown, id: number): any {
    let answer: any = null;
    for (const message of Array.isArray(payload) ? payload : [payload]) {
      if (typeof message !== "object" || message == null) continue;
      if (typeof message.method === "string") {
        if (message.id != null) void this.send(answerServerRequest(message.id, message.method));
      } else if (message.id != null && String(message.id) === String(id)) {
        answer = message;
      }
    }
    return answer;
  }

  /** POSTs a notification or a response to a server request; the server answers 202. */
  private async send(message: unknown): Promise<void> {
    if (this.closed) return;
    try {
      const response = await fetch(this.config.url, { method: "POST", headers: await this.headers(false, false), body: JSON.stringify(message), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      await response.body?.cancel();
      if (!response.ok) this.log(`[mcp ${this.config.name}] a notification got HTTP ${response.status}`);
    } catch (error) {
      this.log(`[mcp ${this.config.name}] couldn't send a notification: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** What a connection depends on. Changing anything else (the name, the account, switched-off tools, instructions) keeps it open. */
function connectionKey(config: McpServerConfig): string {
  return config.transport === "http" ? JSON.stringify(["http", config.url, config.headers, config.oauth ?? null]) : JSON.stringify(["stdio", config.command, config.args, config.env, config.basicEnv === true]);
}

/** How agents and the user tell servers apart: the app's name, and the account when it has several. */
export function mcpServerLabel(config: McpServerConfig): string {
  return config.accountKey ? `${config.name} (${config.accountKey})` : config.name;
}

class McpConnection {
  private channel: Channel | null = null;
  status: "stopped" | "starting" | "ready" | "needs-auth" | "error" = "stopped";
  error: string | null = null;
  /** Why an HTTP server wants a sign-in, as it said. */
  challenge: McpAuthChallenge | null = null;
  tools: McpTool[] = [];

  constructor(
    /** Kept current by McpManager.sync; only connectionKey's parts are fixed. */
    public config: McpServerConfig,
    private readonly auth: McpAuthProvider | null,
    private readonly onChange: () => void,
    private readonly log: (line: string) => void,
  ) {}

  get signedIn(): boolean {
    return this.channel instanceof HttpChannel && this.channel.signedIn;
  }

  async start(): Promise<void> {
    this.status = "starting";
    this.error = null;
    this.challenge = null;
    this.onChange();
    try {
      const config = this.config;
      const channel = config.transport === "http" ? new HttpChannel(config, this.auth, this.log) : new StdioChannel(config, (detail) => this.onExit(channel, detail), this.log);
      this.channel = channel;
      await this.initialize(channel);
      this.tools = await this.listTools(channel);
      this.status = "ready";
    } catch (error) {
      this.fail(error);
    }
    this.onChange();
  }

  stop(): void {
    this.channel?.close();
    this.channel = null;
    if (this.status !== "error" && this.status !== "needs-auth") this.status = "stopped";
  }

  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    const result = await this.request("tools/call", { name, arguments: args }, signal);
    const texts: string[] = [];
    let image: McpCallResult["image"] = null;
    for (const part of result.content ?? []) {
      if (part.type === "text") texts.push(part.text);
      else if (part.type === "image" && image == null) image = { mime: part.mimeType ?? "image/png", base64: part.data };
      else if (part.type === "resource") texts.push(part.resource?.text ?? `[resource ${part.resource?.uri ?? ""}]`);
    }
    if (result.structuredContent != null && texts.length === 0) texts.push(JSON.stringify(result.structuredContent, null, 2));
    return { text: texts.join("\n"), image, isError: result.isError === true };
  }

  async clientHeaders(): Promise<Record<string, string> | null> {
    return this.channel instanceof HttpChannel ? this.channel.clientHeaders() : null;
  }

  private async initialize(channel: Channel): Promise<void> {
    const result = await channel.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
    if (channel instanceof HttpChannel) channel.initialized(result?.protocolVersion);
    await channel.notify("notifications/initialized", {});
  }

  private async listTools(channel: Channel): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await channel.request("tools/list", cursor == null ? {} : { cursor });
      for (const tool of page.tools ?? []) {
        const title = typeof tool.title === "string" ? tool.title : typeof tool.annotations?.title === "string" ? tool.annotations.title : undefined;
        const readOnly = typeof tool.annotations?.readOnlyHint === "boolean" ? tool.annotations.readOnlyHint : undefined;
        tools.push({ name: tool.name, ...(title != null ? { title } : {}), description: tool.description ?? "", inputSchema: tool.inputSchema ?? { type: "object" }, ...(readOnly != null ? { readOnly } : {}) });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor != null);
    return tools;
  }

  /** A request on the open channel; an HTTP session the server dropped is started again once. */
  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    const channel = this.channel;
    if (channel == null || this.status !== "ready") throw new Error("MCP server is not running");
    try {
      try {
        return await channel.request(method, params, signal);
      } catch (error) {
        if (!(error instanceof McpSessionExpired)) throw error;
        await this.initialize(channel);
        return await channel.request(method, params, signal);
      }
    } catch (error) {
      if (!(error instanceof McpAuthRequired)) throw error;
      // The sign-in expired or was revoked: the tools stay hidden until the user signs in again.
      this.fail(error);
      this.onChange();
      throw new Error(`${mcpServerLabel(this.config)} needs you to sign in again (Connect Apps, or Settings → MCP servers).`);
    }
  }

  private fail(error: unknown): void {
    if (error instanceof McpAuthRequired) {
      this.status = "needs-auth";
      this.challenge = error.challenge;
    } else {
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.channel?.close();
    this.channel = null;
  }

  private onExit(channel: Channel, detail: string): void {
    if (this.channel !== channel) return;
    this.channel = null;
    this.status = "error";
    this.error = detail;
    this.onChange();
  }
}

export class McpManager {
  private connections = new Map<string, McpConnection>();
  /** Counts changes, so clients can tell a newer state from an older one (see McpState). */
  private readonly epoch = randomUUID().slice(0, 8);
  private sequence = 0;
  private readonly onChange: () => void;

  constructor(
    onChange: () => void,
    private readonly log: (line: string) => void,
    private readonly auth: McpAuthProvider | null = null,
  ) {
    this.onChange = () => {
      this.sequence++;
      onChange();
    };
  }

  /** Where the state stands in the box's sequence of changes. */
  ordered(): OrderedStamp {
    return { replicaKey: "mcp", epoch: this.epoch, sequence: this.sequence };
  }

  sync(configs: McpServerConfig[]): void {
    for (const [id, connection] of this.connections) {
      if (!configs.some((config) => config.id === id && config.enabled)) {
        connection.stop();
        this.connections.delete(id);
      }
    }
    for (const config of configs) {
      const existing = this.connections.get(config.id);
      if (!config.enabled) continue;
      if (existing != null && connectionKey(existing.config) === connectionKey(config)) {
        existing.config = config;
        continue;
      }
      existing?.stop();
      this.start(config);
    }
    this.onChange();
  }

  /** Connects a server again, e.g. after its sign-in changed. */
  restart(serverId: string): void {
    const existing = this.connections.get(serverId);
    if (existing == null) return;
    existing.stop();
    this.start(existing.config);
  }

  /** The server was removed: its sign-in goes too. */
  forget(serverId: string): void {
    void this.auth?.forget(serverId).catch((error) => this.log(`forgetting the MCP sign-in for ${serverId} failed: ${String(error)}`));
  }

  state(configs: McpServerConfig[]): McpServerSummary[] {
    return configs.map((config) => {
      const connection = this.connections.get(config.id);
      const status: McpServerSummary["status"] =
        connection == null || connection.status === "stopped"
          ? "disconnected"
          : connection.status === "ready"
            ? "connected"
            : connection.status === "starting"
              ? "initializing"
              : connection.status === "needs-auth"
                ? "needsAuth"
                : "error";
      const tools = status === "connected" ? connection!.tools : [];
      const disabled = new Set(config.disabledTools ?? []);
      return {
        id: config.id,
        name: config.name,
        serverIdentifier: config.id,
        rowServerIdentifier: config.id,
        accountKey: config.accountKey ?? "",
        customInstructions: config.customInstructions ?? "",
        isTeamServer: false,
        status,
        statusDetail: status === "error" ? { kind: "load_error", technicalDetail: connection?.error ?? undefined } : status === "needsAuth" ? { kind: "sign_in_needed" } : null,
        toolCount: tools.length,
        disabledToolCount: tools.filter((tool) => disabled.has(tool.name)).length,
        ...(config.transport === "http" ? { transport: "http" as const, url: config.url } : { transport: "stdio" as const, command: [config.command, ...config.args].join(" ") }),
        ...(config.pluginId != null ? { pluginId: config.pluginId } : {}),
        enabled: config.enabled,
        signedIn: connection?.signedIn ?? false,
      };
    });
  }

  toolsOf(serverId: string): McpServerTool[] {
    const connection = this.connections.get(serverId);
    const disabled = new Set(connection?.config.disabledTools ?? []);
    return (connection?.tools ?? []).map((tool) => ({
      name: tool.name,
      ...(tool.title != null ? { title: tool.title } : {}),
      description: tool.description,
      ...(tool.readOnly != null ? { isReadOnly: tool.readOnly } : {}),
      isDisabled: disabled.has(tool.name),
    }));
  }

  /** What main needs to sign in to an HTTP server. */
  signInTarget(config: McpHttpServerConfig): McpSignInTarget {
    return { serverId: config.id, name: config.name, url: config.url, oauth: config.oauth ?? null, challenge: this.connections.get(config.id)?.challenge ?? null };
  }

  /** Headers for a client that calls this HTTP server itself (Claude Code); null while it isn't usable. */
  async clientHeaders(serverId: string): Promise<Record<string, string> | null> {
    const connection = this.connections.get(serverId);
    return connection?.status === "ready" ? connection.clientHeaders() : null;
  }

  /** Tools of every ready server, exposed to the model as `mcp__<serverId>__<tool>`; switched-off tools aren't among them. */
  readyTools(): Array<{ qualifiedName: string; serverId: string; serverName: string; tool: McpTool }> {
    const out: Array<{ qualifiedName: string; serverId: string; serverName: string; tool: McpTool }> = [];
    for (const [serverId, connection] of this.connections) {
      if (connection.status !== "ready") continue;
      const disabled = new Set(connection.config.disabledTools ?? []);
      for (const tool of connection.tools) {
        if (!disabled.has(tool.name)) out.push({ qualifiedName: `mcp__${serverId}__${tool.name}`.slice(0, 64), serverId, serverName: mcpServerLabel(connection.config), tool });
      }
    }
    return out;
  }

  /** The user's instructions for each ready server that offers agents at least one tool. */
  appInstructions(): Array<{ serverId: string; serverName: string; instructions: string }> {
    const offered = new Set(this.readyTools().map((tool) => tool.serverId));
    const out: Array<{ serverId: string; serverName: string; instructions: string }> = [];
    for (const [serverId, connection] of this.connections) {
      const instructions = connection.config.customInstructions?.trim() ?? "";
      if (offered.has(serverId) && instructions.length > 0) out.push({ serverId, serverName: mcpServerLabel(connection.config), instructions });
    }
    return out;
  }

  call(serverId: string, toolName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    const connection = this.connections.get(serverId);
    if (connection == null || connection.status !== "ready") return Promise.reject(new Error("MCP server is not running"));
    return connection.call(toolName, args, signal);
  }

  stopAll(): void {
    for (const connection of this.connections.values()) connection.stop();
    this.connections.clear();
  }

  private start(config: McpServerConfig): void {
    const connection = new McpConnection(config, this.auth, this.onChange, this.log);
    this.connections.set(config.id, connection);
    void connection.start();
  }
}

type ParsedMcpConfig = Omit<McpStdioServerConfig, "id" | "enabled"> | Omit<McpHttpServerConfig, "id" | "enabled">;

/**
 * Reads a server config: `{"command","args","env"}` (stdio), `{"url","headers","oauth"}` or
 * `{"type":"http",…}` (Streamable HTTP), or a Claude/Cursor-style `{"mcpServers":{name:{…}}}` block.
 */
export function parseMcpConfig(name: string, configJson: string): ParsedMcpConfig {
  let parsed: any;
  try {
    parsed = JSON.parse(configJson);
  } catch (error) {
    throw new Error(`The config isn't valid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  const spec = parsed?.mcpServers != null ? Object.values(parsed.mcpServers as Record<string, unknown>)[0] : parsed;
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) throw new Error('Config needs a "url" (a remote server) or a "command" (a local one).');
  const record = spec as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : null;
  if (type === "sse") throw new Error("The old HTTP+SSE transport isn't supported. Use the server's Streamable HTTP address (it often ends in /mcp).");
  const url = record.url ?? record.serverUrl;
  if (url != null || type === "http" || type === "streamable-http" || type === "streamablehttp") {
    if (typeof url !== "string") throw new Error('A remote server needs a "url".');
    const oauth = readOAuth(record.oauth);
    return { name, transport: "http", url: normalizeMcpUrl(url), headers: readHeaders(record.headers), ...(oauth != null ? { oauth } : {}) };
  }
  if (typeof record.command !== "string") throw new Error('Config needs a "url" (a remote server) or a "command" (a local one).');
  const { command, args, env } = record as { command: string; args?: unknown; env?: unknown };
  return {
    name,
    transport: "stdio",
    command,
    args: Array.isArray(args) ? args.map(String) : [],
    env: typeof env === "object" && env !== null ? Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])) : {},
  };
}

/** https anywhere; plain http only to this machine, since headers and sign-in tokens go with every request. */
export function normalizeMcpUrl(raw: string): string {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`“${text}” isn't a web address.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Use an https:// address.");
  if (!isSecureEndpoint(url.href)) throw new Error("Use an https:// address: headers and sign-in tokens must not cross the network unencrypted. Plain http works only for this machine (localhost).");
  if (url.username !== "" || url.password !== "") throw new Error("Put credentials in a header, not in the address.");
  url.hash = "";
  return url.href;
}

function readHeaders(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error('"headers" must be an object of header names and values.');
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const text = String(raw);
    try {
      new Headers([[key, text]]);
    } catch {
      throw new Error(`The header ${JSON.stringify(key)} isn't valid.`);
    }
    headers[key] = text;
  }
  return headers;
}

function readOAuth(value: unknown): McpOAuthClientConfig | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error('"oauth" must be an object, like {"clientId": "…"}.');
  const record = value as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === "string" && (record[key] as string).trim().length > 0 ? (record[key] as string).trim() : undefined);
  const scopes = Array.isArray(record.scopes) ? record.scopes.map(String).filter(Boolean) : typeof record.scopes === "string" ? record.scopes.split(/\s+/).filter(Boolean) : [];
  const port = record.callbackPort;
  if (port != null && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('"oauth.callbackPort" must be a port number.');
  const clientId = text("clientId");
  const clientSecret = text("clientSecret");
  const oauth: McpOAuthClientConfig = {
    ...(clientId != null ? { clientId } : {}),
    ...(clientSecret != null ? { clientSecret } : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
    ...(typeof port === "number" ? { callbackPort: port } : {}),
  };
  return Object.keys(oauth).length > 0 ? oauth : null;
}
