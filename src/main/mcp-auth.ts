// Signing in to remote MCP servers on this PC (MCP authorization, src/shared/mcp-oauth.ts), the
// way Sign in with ChatGPT works: main discovers the server's authorization server, registers the
// app with it (once per authorization server and loopback redirect), opens the system browser and
// catches the redirect on 127.0.0.1. The box on this PC asks main for access tokens over
// `box-host`; sign-ins and registrations stay here, encrypted with the OS keychain (SecretStore
// "mcp-oauth"). For a remote box main hands the finished sign-in over, and the box refreshes it
// from then on.
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import {
  authorizationUrl,
  configuredClientAuthMethod,
  discoverMcpAuthorization,
  exchangeMcpCode,
  McpAuthError,
  type McpAuthorizationPlan,
  type McpCredentials,
  type McpOAuthClient,
  McpSignIns,
  McpTokenEndpointError,
  registerMcpClient,
} from "../shared/mcp-oauth";
import type { McpSignInTarget } from "../shared/model";
import { callbackPage, listenLoopback } from "./oauth-loopback";
import type { SecretStore } from "./secrets";

export { McpAuthError };

const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const CALLBACK_PATH = "/callback";

interface StoredMcpAuth {
  version: 1;
  /** The box on this PC's sign-ins, by MCP server id. */
  servers: Record<string, McpCredentials>;
  /** The app's dynamic client registrations, by issuer, each for one loopback redirect URI. */
  clients: Record<string, McpOAuthClient>;
}

const redirectUri = (port: number) => `http://127.0.0.1:${port}${CALLBACK_PATH}`;

export class McpAuth {
  /** The box on this PC's sign-ins. */
  readonly signIns: McpSignIns;
  private readonly pending = new Map<string, AbortController>();

  constructor(
    private readonly options: {
      secrets: SecretStore;
      openInBrowser(url: string): Promise<void>;
      log?(line: string): void;
    },
  ) {
    this.signIns = new McpSignIns({ read: () => this.read().servers, write: (servers) => this.write({ ...this.read(), servers }) }, options.log);
  }

  signingIn(serverId: string): boolean {
    return this.pending.has(serverId);
  }

  cancel(serverId: string): void {
    this.pending.get(serverId)?.abort();
  }

  /** Runs the browser sign-in for one server and returns its credentials; the caller decides where they live. */
  async signIn(target: McpSignInTarget): Promise<McpCredentials> {
    if (this.pending.has(target.serverId)) throw new McpAuthError("A sign-in to this server is already in progress.");
    const abort = new AbortController();
    this.pending.set(target.serverId, abort);
    let listener: Server | null = null;
    try {
      const plan = await discoverMcpAuthorization(target.url, target.challenge);
      if (target.oauth?.scopes != null && target.oauth.scopes.length > 0) plan.scopes = target.oauth.scopes;
      const { client, server } = await this.client(plan, target);
      listener = server;
      const verifier = randomBytes(48).toString("base64url");
      const state = randomBytes(32).toString("base64url");
      const url = authorizationUrl(plan, client, { state, codeChallenge: createHash("sha256").update(verifier).digest("base64url") });
      const callback = await waitForRedirect(server, client.redirectUri, state, abort.signal, () => this.options.openInBrowser(url));
      // RFC 9207: an authorization server that names itself must be the one this sign-in started with.
      const issuer = callback.get("iss");
      if (issuer != null && issuer.replace(/\/+$/, "") !== plan.server.issuer.replace(/\/+$/, "")) throw new McpAuthError("The sign-in response came from a different authorization server.");
      try {
        return await exchangeMcpCode(plan, client, { code: callback.get("code")!, codeVerifier: verifier, serverUrl: target.url });
      } catch (error) {
        // A registration the server no longer knows is dropped, so the next attempt registers again.
        if (error instanceof McpTokenEndpointError && error.code === "invalid_client" && target.oauth?.clientId == null) await this.dropClient(plan.server.issuer);
        throw error;
      }
    } finally {
      this.pending.delete(target.serverId);
      // Frees the port at once, so the next sign-in can reuse a registration made for it.
      listener?.close();
      listener?.closeAllConnections();
    }
  }

  /** The client to sign in as, with a loopback listener on its redirect URI's port. */
  private async client(plan: McpAuthorizationPlan, target: McpSignInTarget): Promise<{ client: McpOAuthClient; server: Server }> {
    const configured = target.oauth;
    if (configured?.clientId != null) {
      const { server, port } = await listenLoopback(configured.callbackPort ?? 0).catch((error) => {
        throw configured.callbackPort != null ? new McpAuthError(`Port ${configured.callbackPort} on 127.0.0.1 is in use, and this server's sign-in redirects there.`) : error;
      });
      const secret = configured.clientSecret ?? null;
      const client = { issuer: plan.server.issuer, clientId: configured.clientId, clientSecret: secret, tokenEndpointAuthMethod: configuredClientAuthMethod(plan.server, secret), redirectUri: redirectUri(port), secretExpiresAt: null };
      return { client, server };
    }
    // A registration is for one redirect URI: reuse it while its port is free, register again otherwise.
    const saved = this.read().clients[plan.server.issuer];
    if (saved != null && (saved.secretExpiresAt == null || saved.secretExpiresAt > Date.now())) {
      const reused = await listenLoopback(Number(new URL(saved.redirectUri).port)).catch(() => null);
      if (reused != null) return { client: saved, server: reused.server };
    }
    const { server, port } = await listenLoopback(0);
    try {
      const client = await registerMcpClient(plan.server, redirectUri(port), plan.scopes);
      const stored = this.read();
      await this.write({ ...stored, clients: { ...stored.clients, [plan.server.issuer]: client } });
      return { client, server };
    } catch (error) {
      server.close();
      throw error;
    }
  }

  private async dropClient(issuer: string): Promise<void> {
    const stored = this.read();
    const clients = { ...stored.clients };
    delete clients[issuer];
    await this.write({ ...stored, clients });
  }

  private read(): StoredMcpAuth {
    try {
      const parsed = JSON.parse(this.options.secrets.get("mcp-oauth") ?? "null") as Partial<StoredMcpAuth> | null;
      if (parsed?.version === 1) return { version: 1, servers: parsed.servers ?? {}, clients: parsed.clients ?? {} };
    } catch {
      // unreadable: start over
    }
    return { version: 1, servers: {}, clients: {} };
  }

  private write(next: StoredMcpAuth): Promise<void> {
    return this.options.secrets.set("mcp-oauth", JSON.stringify(next));
  }
}

/** Opens the browser, then waits for the authorization server's redirect to the loopback listener. */
function waitForRedirect(server: Server, redirect: string, state: string, signal: AbortSignal, open: () => Promise<void>): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(new McpAuthError("Sign-in was cancelled.")));
    const timer = setTimeout(() => finish(() => reject(new McpAuthError("Sign-in timed out."))), SIGN_IN_TIMEOUT_MS);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", redirect);
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end();
        return;
      }
      const query = url.searchParams;
      const ok = query.get("state") === state && query.get("error") == null && query.get("code") != null;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(callbackPage(ok));
      finish(() => {
        if (query.get("state") !== state) reject(new McpAuthError("The sign-in response didn't match this request. Try again."));
        else if (query.get("error") != null) reject(new McpAuthError(query.get("error") === "access_denied" ? "Sign-in was cancelled." : `Sign-in failed: ${query.get("error_description") ?? query.get("error")}`));
        else if (query.get("code") == null) reject(new McpAuthError("The sign-in response had no authorization code."));
        else resolve(query);
      });
    });
    void open().catch((error) => finish(() => reject(error)));
  });
}
