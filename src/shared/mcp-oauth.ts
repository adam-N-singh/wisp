// MCP authorization (modelcontextprotocol.io/specification/2025-06-18/basic/authorization),
// shared by main, which signs in on this PC and refreshes for the box here, and the standalone
// box server, which refreshes a sign-in handed to it:
//   1. an HTTP server refuses a request with 401 and `WWW-Authenticate: Bearer resource_metadata="…"`
//   2. its protected resource metadata (RFC 9728) names the authorization server; servers written
//      for the 2025-03-26 spec publish none, and their own origin is the authorization server
//   3. that server's metadata (RFC 8414, or OpenID discovery) gives the endpoints
//   4. dynamic client registration (RFC 7591), unless the user configured a client
//   5. authorization code with PKCE (S256), naming the MCP server as `resource` (RFC 8707)
// Refresh tokens may rotate, so each sign-in is refreshed in one place, one refresh at a time.
import type { McpAuthChallenge } from "./model";

export const MCP_CLIENT_NAME = "Wisp";
/** Refresh this long before an access token expires. */
export const MCP_REFRESH_MARGIN_MS = 60_000;
/** Assumed lifetime of an access token issued without `expires_in`; a 401 ends it sooner. */
const DEFAULT_TOKEN_LIFETIME_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
/** Refresh errors after which the sign-in can't be used again. */
const TERMINAL_REFRESH_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

export type TokenEndpointAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

/** An MCP server's authorization server, as discovered. */
export interface McpAuthorizationServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
  /** Null when the metadata doesn't say. */
  tokenEndpointAuthMethods: string[] | null;
}

/** How to sign in to one MCP server. */
export interface McpAuthorizationPlan {
  /** The RFC 8707 resource the tokens are for. */
  resource: string;
  server: McpAuthorizationServer;
  /** Scopes to ask for; none are named when empty. */
  scopes: string[];
}

/** The app as registered with an authorization server, for one loopback redirect URI. */
export interface McpOAuthClient {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  redirectUri: string;
  /** When an issued client secret stops working (epoch ms), if the server said. */
  secretExpiresAt: number | null;
}

/** One sign-in: its tokens, and what refreshing and revoking them takes. */
export interface McpCredentials {
  /** The MCP server's URL when it was signed in to; its tokens are handed out for that URL only. */
  serverUrl: string;
  resource: string;
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  clientId: string;
  clientSecret: string | null;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string | null;
}

export class McpAuthError extends Error {}

export class McpTokenEndpointError extends McpAuthError {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`The sign-in server refused the request (${code})${detail.length > 0 && detail !== code ? `: ${detail}` : ""}.`);
  }
}

/** The refresh token is spent or revoked, or the client is gone: sign in again. */
export function isTerminalMcpRefreshError(error: unknown): boolean {
  return error instanceof McpTokenEndpointError && TERMINAL_REFRESH_ERRORS.has(error.code);
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/** https, or plain http to this machine's own loopback. */
export function isSecureEndpoint(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.test(url.hostname));
  } catch {
    return false;
  }
}

/** The bearer challenge in a `WWW-Authenticate` header, or null without one. */
export function parseWwwAuthenticate(header: string | null): McpAuthChallenge | null {
  const at = header?.search(/\bbearer\b/i) ?? -1;
  if (header == null || at < 0) return null;
  const params: Record<string, string> = {};
  for (const match of header.slice(at + 6).matchAll(/([a-z_][a-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))/gi)) {
    const key = match[1].toLowerCase();
    params[key] ??= match[2] != null ? match[2].replace(/\\(.)/g, "$1") : match[3];
  }
  return { resourceMetadataUrl: params.resource_metadata ?? null, scope: params.scope ?? null, error: params.error ?? null };
}

/** The server's canonical URI for `resource`: its URL without a fragment or a bare trailing slash. */
export function canonicalResource(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = "";
  return url.pathname === "/" && url.search === "" ? url.href.slice(0, -1) : url.href;
}

/** Protected resource metadata must be about this server: same origin, a path the server's URL falls under. */
function resourceCovers(resource: string, serverUrl: string): boolean {
  try {
    const declared = new URL(resource);
    const server = new URL(serverUrl);
    const withSlash = (path: string) => (path.endsWith("/") ? path : `${path}/`);
    return declared.origin === server.origin && withSlash(server.pathname).startsWith(withSlash(declared.pathname));
  } catch {
    return false;
  }
}

/** Where RFC 9728 puts a resource's metadata: under the server's path first, then at its origin. */
function protectedResourceMetadataUrls(serverUrl: string): string[] {
  const url = new URL(serverUrl);
  const path = url.pathname.replace(/\/+$/, "");
  const root = `${url.origin}/.well-known/oauth-protected-resource`;
  return path.length > 0 ? [`${root}${path}`, root] : [root];
}

/** RFC 8414 and OpenID discovery locations for an issuer, path-aware. */
function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  if (path.length === 0) return [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
  return [`${url.origin}/.well-known/oauth-authorization-server${path}`, `${url.origin}/.well-known/openid-configuration${path}`, `${url.origin}${path}/.well-known/openid-configuration`];
}

const unreachable = (url: string, error: unknown) => {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  return new McpAuthError(`Couldn't reach ${new URL(url).host} (${cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error))}).`);
};

async function readJsonBody(response: Response): Promise<Record<string, any>> {
  try {
    const body = await response.json();
    return typeof body === "object" && body != null && !Array.isArray(body) ? body : {};
  } catch {
    return {};
  }
}

/** A metadata document, or null when the server has none there. */
async function getMetadata(url: string): Promise<Record<string, any> | null> {
  if (!isSecureEndpoint(url)) throw new McpAuthError(`Sign-in metadata must come over HTTPS (${url}).`);
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw unreachable(url, error);
  }
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const body = await readJsonBody(response);
  return Object.keys(body).length > 0 ? body : null;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

async function authorizationServer(issuer: string): Promise<McpAuthorizationServer> {
  let metadata: Record<string, any> | null = null;
  for (const url of authorizationServerMetadataUrls(issuer)) {
    metadata = await getMetadata(url);
    if (metadata != null) break;
  }
  if (metadata == null) {
    throw new McpAuthError("This server asked for a sign-in but publishes no OAuth metadata. If it takes an API key or token instead, add it as a header (Authorization: Bearer …).");
  }
  const text = (key: string) => (typeof metadata[key] === "string" && metadata[key].length > 0 ? (metadata[key] as string) : null);
  const declared = text("issuer");
  if (declared != null && declared.replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")) throw new McpAuthError(`The authorization server's metadata names another issuer (${declared}).`);
  const authorizationEndpoint = text("authorization_endpoint");
  const tokenEndpoint = text("token_endpoint");
  if (authorizationEndpoint == null || tokenEndpoint == null) throw new McpAuthError("The authorization server's metadata is missing its endpoints.");
  const registrationEndpoint = text("registration_endpoint");
  const revocationEndpoint = text("revocation_endpoint");
  for (const endpoint of [authorizationEndpoint, tokenEndpoint, registrationEndpoint, revocationEndpoint]) {
    if (endpoint != null && !isSecureEndpoint(endpoint)) throw new McpAuthError(`The authorization server's endpoints must use HTTPS (${endpoint}).`);
  }
  if (Array.isArray(metadata.code_challenge_methods_supported) && !strings(metadata.code_challenge_methods_supported).includes("S256")) {
    throw new McpAuthError("The authorization server doesn't support PKCE (S256), which MCP sign-in requires.");
  }
  return {
    issuer: declared ?? issuer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint,
    revocationEndpoint,
    tokenEndpointAuthMethods: Array.isArray(metadata.token_endpoint_auth_methods_supported) ? strings(metadata.token_endpoint_auth_methods_supported) : null,
  };
}

/** Finds the authorization server for the MCP server at `serverUrl`, starting from its last refusal when it gave one. */
export async function discoverMcpAuthorization(serverUrl: string, challenge: McpAuthChallenge | null): Promise<McpAuthorizationPlan> {
  let metadata: Record<string, any> | null = null;
  if (challenge?.resourceMetadataUrl != null) {
    metadata = await getMetadata(challenge.resourceMetadataUrl);
    if (metadata == null) throw new McpAuthError("The server's sign-in metadata couldn't be loaded.");
  } else {
    for (const url of protectedResourceMetadataUrls(serverUrl)) {
      metadata = await getMetadata(url);
      if (metadata != null) break;
    }
  }
  let resource = canonicalResource(serverUrl);
  let issuer = new URL(serverUrl).origin;
  let scopes: string[] = [];
  if (metadata != null) {
    const issuers = strings(metadata.authorization_servers);
    if (issuers.length === 0) throw new McpAuthError("The server's metadata doesn't name an authorization server.");
    if (typeof metadata.resource === "string") {
      if (!resourceCovers(metadata.resource, serverUrl)) throw new McpAuthError(`The server's metadata is for another resource (${metadata.resource}).`);
      resource = metadata.resource;
    }
    issuer = issuers[0];
    scopes = strings(metadata.scopes_supported);
  }
  if (challenge?.scope != null) scopes = challenge.scope.split(/\s+/).filter(Boolean);
  return { resource, server: await authorizationServer(issuer), scopes };
}

/** Registers the app with the authorization server (RFC 7591) as a public client for `redirectUri`. */
export async function registerMcpClient(server: McpAuthorizationServer, redirectUri: string, scopes: string[]): Promise<McpOAuthClient> {
  if (server.registrationEndpoint == null) {
    throw new McpAuthError('This server doesn\'t let apps register themselves. Add the OAuth client you registered with it to the server\'s config ("oauth": {"clientId": …}), or a token as a header.');
  }
  let response: Response;
  try {
    response = await fetch(server.registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: MCP_CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw unreachable(server.registrationEndpoint, error);
  }
  const body = await readJsonBody(response);
  if (!response.ok || typeof body.client_id !== "string") {
    throw new McpAuthError(`Registering the app with the sign-in server failed (${String(body.error ?? `HTTP ${response.status}`)}${typeof body.error_description === "string" ? `: ${body.error_description}` : ""}).`);
  }
  const secret = typeof body.client_secret === "string" && body.client_secret.length > 0 ? body.client_secret : null;
  return {
    issuer: server.issuer,
    clientId: body.client_id,
    clientSecret: secret,
    tokenEndpointAuthMethod: secret == null || body.token_endpoint_auth_method === "none" ? "none" : body.token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "client_secret_basic",
    redirectUri,
    secretExpiresAt: typeof body.client_secret_expires_at === "number" && body.client_secret_expires_at > 0 ? body.client_secret_expires_at * 1000 : null,
  };
}

/** How a client the user registered ahead of time authenticates: basic unless the server only takes post. */
export function configuredClientAuthMethod(server: McpAuthorizationServer, secret: string | null): TokenEndpointAuthMethod {
  if (secret == null) return "none";
  const methods = server.tokenEndpointAuthMethods;
  return methods != null && !methods.includes("client_secret_basic") && methods.includes("client_secret_post") ? "client_secret_post" : "client_secret_basic";
}

export function authorizationUrl(plan: McpAuthorizationPlan, client: McpOAuthClient, request: { state: string; codeChallenge: string }): string {
  const url = new URL(plan.server.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", client.redirectUri);
  url.searchParams.set("state", request.state);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", plan.resource);
  if (plan.scopes.length > 0) url.searchParams.set("scope", plan.scopes.join(" "));
  return url.toString();
}

type ClientAuth = Pick<McpCredentials, "clientId" | "clientSecret" | "tokenEndpointAuthMethod">;

/** A token-endpoint style form POST, authenticated the way the client was registered. */
function clientPost(url: string, client: ClientAuth, form: Record<string, string>): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  const body = new URLSearchParams(form);
  if (client.tokenEndpointAuthMethod === "client_secret_basic" && client.clientSecret != null) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString("base64")}`;
  } else {
    body.set("client_id", client.clientId);
    if (client.tokenEndpointAuthMethod === "client_secret_post" && client.clientSecret != null) body.set("client_secret", client.clientSecret);
  }
  return fetch(url, { method: "POST", headers, body: body.toString(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

async function tokenRequest(endpoint: string, client: ClientAuth, form: Record<string, string>): Promise<Record<string, any>> {
  let response: Response;
  try {
    response = await clientPost(endpoint, client, form);
  } catch (error) {
    throw unreachable(endpoint, error);
  }
  const body = await readJsonBody(response);
  if (!response.ok) throw new McpTokenEndpointError(String(body.error ?? response.status), String(body.error_description ?? "").slice(0, 300));
  if (typeof body.access_token !== "string" || body.access_token.length === 0) throw new McpAuthError("The sign-in server's reply had no access token.");
  if (typeof body.token_type === "string" && body.token_type.toLowerCase() !== "bearer") throw new McpAuthError(`The sign-in server issued an unsupported ${body.token_type} token.`);
  return body;
}

function tokenFields(body: Record<string, any>, previous: McpCredentials | null): Pick<McpCredentials, "accessToken" | "refreshToken" | "expiresAt" | "scope"> {
  const lifetime = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token.length > 0 ? body.refresh_token : (previous?.refreshToken ?? null),
    expiresAt: Date.now() + (lifetime > 0 ? lifetime * 1000 : DEFAULT_TOKEN_LIFETIME_MS),
    scope: typeof body.scope === "string" ? body.scope : (previous?.scope ?? null),
  };
}

/** Trades the authorization code (with its PKCE verifier) for the sign-in's first tokens. */
export async function exchangeMcpCode(plan: McpAuthorizationPlan, client: McpOAuthClient, request: { code: string; codeVerifier: string; serverUrl: string }): Promise<McpCredentials> {
  const body = await tokenRequest(plan.server.tokenEndpoint, client, {
    grant_type: "authorization_code",
    code: request.code,
    redirect_uri: client.redirectUri,
    code_verifier: request.codeVerifier,
    resource: plan.resource,
  });
  return {
    serverUrl: request.serverUrl,
    resource: plan.resource,
    issuer: plan.server.issuer,
    tokenEndpoint: plan.server.tokenEndpoint,
    revocationEndpoint: plan.server.revocationEndpoint,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    ...tokenFields(body, null),
  };
}

/** One refresh_token grant; the reply's refresh token, if any, replaces the old one. */
export async function refreshMcpCredentials(current: McpCredentials): Promise<McpCredentials> {
  if (current.refreshToken == null) throw new McpTokenEndpointError("invalid_grant", "no refresh token");
  const body = await tokenRequest(current.tokenEndpoint, current, { grant_type: "refresh_token", refresh_token: current.refreshToken, resource: current.resource });
  return { ...current, ...tokenFields(body, current) };
}

/** Revokes the refresh token, or the access token without one (RFC 7009); true when the server accepted. */
export async function revokeMcpCredentials(credentials: McpCredentials): Promise<boolean> {
  if (credentials.revocationEndpoint == null) return false;
  try {
    const refresh = credentials.refreshToken != null;
    const response = await clientPost(credentials.revocationEndpoint, credentials, { token: refresh ? credentials.refreshToken! : credentials.accessToken, token_type_hint: refresh ? "refresh_token" : "access_token" });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/** Where sign-ins are kept: main's keychain-encrypted secrets, or a 0600 file on the box server. */
export interface McpCredentialStore {
  read(): Record<string, McpCredentials>;
  write(credentials: Record<string, McpCredentials>): Promise<void> | void;
}

/**
 * Sign-ins by MCP server id, handing out fresh access tokens. Refreshes are serialized per server
 * and saved before the next one can start, since each may replace the refresh token.
 */
export class McpSignIns {
  private readonly refreshing = new Map<string, Promise<McpCredentials | null>>();

  constructor(
    private readonly store: McpCredentialStore,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  has(serverId: string): boolean {
    return this.store.read()[serverId] != null;
  }

  async save(serverId: string, credentials: McpCredentials): Promise<void> {
    await this.refreshing.get(serverId)?.catch(() => null);
    await this.store.write({ ...this.store.read(), [serverId]: credentials });
  }

  /** A valid access token for the server at `url`, or null without a sign-in for it; `force` refreshes (after a 401). */
  async accessToken(serverId: string, url: string, force: boolean): Promise<{ accessToken: string; expiresAt: number } | null> {
    let credentials: McpCredentials | null = this.store.read()[serverId] ?? null;
    // A sign-in belongs to the address it was made for; a server added again under the same id needs its own.
    if (credentials == null || credentials.serverUrl !== url) return null;
    if (force || (credentials.refreshToken != null && credentials.expiresAt - Date.now() < MCP_REFRESH_MARGIN_MS)) credentials = await this.refresh(serverId);
    return credentials != null ? { accessToken: credentials.accessToken, expiresAt: credentials.expiresAt } : null;
  }

  /** Forgets a sign-in, asking its authorization server to revoke it first when `revoke`; true when it was revoked. */
  async forget(serverId: string, revoke: boolean): Promise<boolean> {
    await this.refreshing.get(serverId)?.catch(() => null);
    const credentials = this.store.read()[serverId];
    if (credentials == null) return false;
    const revoked = revoke ? await revokeMcpCredentials(credentials) : false;
    await this.remove(serverId);
    return revoked;
  }

  private refresh(serverId: string): Promise<McpCredentials | null> {
    let pending = this.refreshing.get(serverId);
    if (pending == null) {
      pending = (async () => {
        const current = this.store.read()[serverId];
        if (current == null) return null;
        try {
          const next = await refreshMcpCredentials(current);
          await this.store.write({ ...this.store.read(), [serverId]: next });
          return next;
        } catch (error) {
          // Only a spent or revoked refresh token ends the sign-in; network trouble keeps it for the next try.
          if (!isTerminalMcpRefreshError(error)) throw error;
          await this.remove(serverId);
          this.log(`the MCP sign-in for ${serverId} expired and was removed`);
          return null;
        }
      })().finally(() => this.refreshing.delete(serverId));
      this.refreshing.set(serverId, pending);
    }
    return pending;
  }

  private async remove(serverId: string): Promise<void> {
    const remaining = { ...this.store.read() };
    delete remaining[serverId];
    await this.store.write(remaining);
  }
}
