import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type BoxServer, startBoxServer } from "../../src/box-server/server";
import { startBoxHost } from "../../src/box/host";
import { McpManager, parseMcpConfig } from "../../src/box/mcp";
import { McpAuth } from "../../src/main/mcp-auth";
import { RemoteBoxClient } from "../../src/main/remote-box";
import type { SecretStore } from "../../src/main/secrets";
import type { BoxModelConfig } from "../../src/shared/edges";
import { discoverMcpAuthorization, parseWwwAuthenticate, registerMcpClient } from "../../src/shared/mcp-oauth";
import type { ClaudeCodeStatus, McpHttpServerConfig, McpServerSummary, McpServerTool, SendMessageEntry, TranscriptEntry } from "../../src/shared/model";

const cleanup: Array<() => void> = [];
after(() => {
  for (const fn of cleanup.reverse()) fn();
});

const PROTOCOL = "2025-06-18";
const TOKEN = randomBytes(24).toString("hex");
const MOCK_MODELS: BoxModelConfig = { defaultModel: { provider: "mock", model: "mock-1" }, reasoningEffort: "default", temperature: null, xai: null, openai: null, anthropic: null, custom: null, claudeCode: null };
const NO_CLAUDE = async (): Promise<ClaudeCodeStatus> => ({ executable: null, installed: false, version: null, signedIn: false, authMethod: null, checkedAt: 1 });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wisp-mcp-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** In-memory stand-in for the keychain-backed SecretStore. */
function memorySecrets(): SecretStore {
  const values = new Map<string, string>();
  return {
    get: (name: string) => values.get(name) ?? null,
    has: (name: string) => values.has(name),
    set: async (name: string, value: string) => void values.set(name, value),
    remove: async (name: string) => void values.delete(name),
  } as unknown as SecretStore;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (raw += chunk));
    request.on("end", () => resolve(raw));
  });
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse, raw: string) => void): Promise<string> {
  const server = createServer((request, response) => void readBody(request).then((raw) => handler(request, response, raw)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const sendJson = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
};

const TOOLS = [
  { name: "echo", title: "Echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
  { name: "slow", description: "Answers only when cancelled", inputSchema: { type: "object" } },
];

/**
 * A remote MCP server speaking Streamable HTTP at /mcp: sessions, JSON replies for initialize and
 * tools/list (in two pages), SSE replies with CRLF line ends for tools/call (a log notification
 * and a ping to the client first), 404 for unknown sessions, DELETE. With `tokens` every request
 * needs one of them as a bearer token, and a 401 points at its protected resource metadata.
 */
async function fakeMcpServer(options: { tokens?: Set<string>; authorizationServer?: string } = {}) {
  const log: Array<{ http: string; path: string; rpc: string | null; headers: IncomingHttpHeaders; message: any }> = [];
  const sessions = new Set<string>();
  const deleted: string[] = [];
  const answers: any[] = [];
  const cancelled: any[] = [];
  let created = 0;
  let base = "";
  base = await listen((request, response, raw) => {
    const url = new URL(request.url ?? "/", base);
    const message = raw.length > 0 ? JSON.parse(raw) : null;
    log.push({ http: request.method ?? "", path: url.pathname, rpc: message?.method ?? null, headers: request.headers, message });
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp" && options.authorizationServer != null) {
      return sendJson(response, 200, { resource: `${base}/mcp`, authorization_servers: [options.authorizationServer], scopes_supported: ["mcp:tools"], bearer_methods_supported: ["header"] });
    }
    if (url.pathname !== "/mcp") return sendJson(response, 404, { error: "not found" });
    if (options.tokens != null && !options.tokens.has((request.headers.authorization ?? "").replace(/^Bearer /, ""))) {
      return sendJson(response, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"` });
    }
    if (request.method === "GET") return sendJson(response, 405, { error: "no standalone stream" });
    if (request.method === "DELETE") {
      deleted.push(String(request.headers["mcp-session-id"]));
      sessions.delete(String(request.headers["mcp-session-id"]));
      return void response.writeHead(200).end();
    }
    if (message?.method === "initialize") {
      const session = `s${++created}`;
      sessions.add(session);
      const result = { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } };
      return sendJson(response, 200, { jsonrpc: "2.0", id: message.id, result }, { "mcp-session-id": session });
    }
    if (!sessions.has(String(request.headers["mcp-session-id"]))) return sendJson(response, 404, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } });
    if (request.headers["mcp-protocol-version"] !== PROTOCOL) return sendJson(response, 400, { error: "no protocol version" });
    if (message.id == null || message.method == null) {
      // Notifications, and the client's answers to this server's requests.
      if (message.method === "notifications/cancelled") cancelled.push(message.params);
      else if (message.method == null) answers.push(message);
      return void response.writeHead(202).end();
    }
    if (message.method === "tools/list") {
      const page = message.params?.cursor === "2" ? { tools: TOOLS.slice(1) } : { tools: TOOLS.slice(0, 1), nextCursor: "2" };
      return sendJson(response, 200, { jsonrpc: "2.0", id: message.id, result: page });
    }
    if (message.method === "tools/call") {
      const event = (payload: unknown) => `event: message\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(event({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } }));
      response.write(event({ jsonrpc: "2.0", id: `ping-${message.id}`, method: "ping" }));
      const { name, arguments: args } = message.params;
      if (name === "slow") return;
      const result = name === "echo" ? { content: [{ type: "text", text: `echo: ${args.text}` }] } : { content: [], structuredContent: { sum: args.a + args.b } };
      // The final CRLF CRLF split across two writes, after a CR.
      const text = event({ jsonrpc: "2.0", id: message.id, result });
      response.write(text.slice(0, -3));
      setTimeout(() => response.end(text.slice(-3)), 20);
      return;
    }
    sendJson(response, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
  });
  return { url: `${base}/mcp`, base, log, sessions, deleted, answers, cancelled, expireSessions: () => sessions.clear() };
}

/**
 * An OAuth authorization server for MCP: RFC 8414 metadata, dynamic client registration, an
 * authorize endpoint that consents at once, code exchange checking PKCE and `resource`, refresh
 * with rotation, revocation. Access tokens it issues go into `tokens`, which the MCP server takes.
 */
async function fakeAuthServer(tokens: Set<string>) {
  const log: Array<{ path: string; params: Record<string, any>; headers: IncomingHttpHeaders }> = [];
  const clients = new Map<string, { redirectUris: string[] }>();
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; resource: string; scope: string | null }>();
  const refreshTokens = new Map<string, { clientId: string; resource: string }>();
  const revoked: string[] = [];
  const state = { failRefresh: null as string | null };
  let issued = 0;
  let base = "";
  const issue = (clientId: string, resource: string, scope: string | null) => {
    issued++;
    tokens.add(`at-${issued}`);
    refreshTokens.set(`rt-${issued}`, { clientId, resource });
    return { access_token: `at-${issued}`, token_type: "Bearer", expires_in: 3600, refresh_token: `rt-${issued}`, ...(scope != null ? { scope } : {}) };
  };
  base = await listen((request, response, raw) => {
    const url = new URL(request.url ?? "/", base);
    const json = String(request.headers["content-type"] ?? "").startsWith("application/json");
    const params = request.method === "POST" ? (json ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : Object.fromEntries(url.searchParams);
    log.push({ path: url.pathname, params, headers: request.headers });
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return sendJson(response, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        revocation_endpoint: `${base}/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register") {
      if (!Array.isArray(params.redirect_uris) || !params.redirect_uris.every((uri: string) => /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(uri))) return sendJson(response, 400, { error: "invalid_redirect_uri" });
      const clientId = `client-${clients.size + 1}`;
      clients.set(clientId, { redirectUris: params.redirect_uris });
      return sendJson(response, 201, { client_id: clientId, client_name: params.client_name, redirect_uris: params.redirect_uris, token_endpoint_auth_method: "none" });
    }
    if (url.pathname === "/authorize") {
      const client = clients.get(params.client_id);
      if (client == null || !client.redirectUris.includes(params.redirect_uri) || params.response_type !== "code" || params.code_challenge_method !== "S256" || !params.code_challenge || !params.resource) {
        return sendJson(response, 400, { error: "invalid_request" });
      }
      const code = `code-${codes.size + 1}-${randomBytes(4).toString("hex")}`;
      codes.set(code, { clientId: params.client_id, redirectUri: params.redirect_uri, challenge: params.code_challenge, resource: params.resource, scope: params.scope ?? null });
      const back = new URL(params.redirect_uri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", params.state);
      back.searchParams.set("iss", base);
      return void response.writeHead(302, { location: back.toString() }).end();
    }
    if (url.pathname === "/token" && params.grant_type === "authorization_code") {
      const entry = codes.get(params.code);
      codes.delete(params.code);
      if (entry == null || entry.clientId !== params.client_id || entry.redirectUri !== params.redirect_uri || entry.resource !== params.resource) return sendJson(response, 400, { error: "invalid_grant" });
      if (createHash("sha256").update(String(params.code_verifier)).digest("base64url") !== entry.challenge) return sendJson(response, 400, { error: "invalid_grant", error_description: "PKCE mismatch" });
      return sendJson(response, 200, issue(entry.clientId, entry.resource, entry.scope));
    }
    if (url.pathname === "/token" && params.grant_type === "refresh_token") {
      if (state.failRefresh != null) return sendJson(response, 400, { error: state.failRefresh });
      const entry = refreshTokens.get(params.refresh_token);
      if (entry == null || entry.clientId !== params.client_id || entry.resource !== params.resource) return sendJson(response, 400, { error: "invalid_grant" });
      refreshTokens.delete(params.refresh_token); // each refresh token works once
      return sendJson(response, 200, issue(entry.clientId, entry.resource, null));
    }
    if (url.pathname === "/revoke") {
      revoked.push(params.token);
      refreshTokens.delete(params.token);
      return void response.writeHead(200).end();
    }
    sendJson(response, 404, { error: "not found" });
  });
  return { base, log, clients, revoked, state };
}

/** Plays the user in the browser: the authorization server sends them straight back to the app's loopback (or with an error). */
async function browser(url: string): Promise<void> {
  const authorize = await fetch(url, { redirect: "manual" });
  const request = new URL(url).searchParams;
  const location = authorize.headers.get("location") ?? `${request.get("redirect_uri")}?error=server_error&error_description=${encodeURIComponent(`HTTP ${authorize.status}`)}&state=${request.get("state")}`;
  await (await fetch(location)).text();
}

/** Main's McpAuth with the keychain and the system browser replaced. */
function signer() {
  const secrets = memorySecrets();
  const opened: string[] = [];
  const auth = new McpAuth({
    secrets,
    openInBrowser: async (url) => {
      opened.push(url);
      setTimeout(() => void browser(url), 5);
    },
  });
  return { auth, secrets, opened };
}

const stored = (secrets: SecretStore) => JSON.parse(secrets.get("mcp-oauth") ?? "{}") as { servers?: Record<string, any>; clients?: Record<string, any> };

test("MCP config: remote servers by URL or in an mcpServers block, checked headers and OAuth clients, stdio as before", () => {
  assert.deepEqual(parseMcpConfig("Linear", JSON.stringify({ url: "https://mcp.linear.app/mcp" })), { name: "Linear", transport: "http", url: "https://mcp.linear.app/mcp", headers: {} });
  assert.deepEqual(parseMcpConfig("GitHub", JSON.stringify({ mcpServers: { github: { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ghp_x" } } } })), {
    name: "GitHub",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    headers: { Authorization: "Bearer ghp_x" },
  });
  assert.deepEqual(parseMcpConfig("Slack", JSON.stringify({ type: "streamable-http", serverUrl: "https://mcp.example.com/mcp#frag", oauth: { clientId: "abc", scopes: "read write", callbackPort: 3118 } })), {
    name: "Slack",
    transport: "http",
    url: "https://mcp.example.com/mcp",
    headers: {},
    oauth: { clientId: "abc", scopes: ["read", "write"], callbackPort: 3118 },
  });
  assert.equal(parseMcpConfig("local", JSON.stringify({ url: "http://127.0.0.1:9000/mcp" })).transport, "http", "plain http to this machine is fine");
  assert.throws(() => parseMcpConfig("x", JSON.stringify({ url: "http://mcp.example.com/mcp" })), /https/);
  assert.throws(() => parseMcpConfig("x", JSON.stringify({ url: "https://user:pw@mcp.example.com/mcp" })), /header, not in the address/);
  assert.throws(() => parseMcpConfig("x", JSON.stringify({ type: "sse", url: "https://mcp.example.com/sse" })), /Streamable HTTP/);
  assert.throws(() => parseMcpConfig("x", JSON.stringify({ type: "http" })), /needs a "url"/);
  assert.throws(() => parseMcpConfig("x", JSON.stringify({ url: "https://mcp.example.com/mcp", headers: { "Bad Header": "x" } })), /header "Bad Header"/);
  assert.throws(() => parseMcpConfig("x", JSON.stringify({ url: "https://mcp.example.com/mcp", oauth: { callbackPort: 99999 } })), /port number/);
  assert.throws(() => parseMcpConfig("x", "{ nope"), /isn't valid JSON/);
  assert.throws(() => parseMcpConfig("x", JSON.stringify({ args: [] })), /"url".*"command"/);
  assert.deepEqual(parseMcpConfig("everything", JSON.stringify({ command: "npx", args: ["-y", "x"], env: { A: 1 } })), { name: "everything", transport: "stdio", command: "npx", args: ["-y", "x"], env: { A: "1" } });

  assert.deepEqual(parseWwwAuthenticate('Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="files:read files:write"'), {
    resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    scope: "files:read files:write",
    error: "invalid_token",
  });
  assert.deepEqual(parseWwwAuthenticate("Bearer error=insufficient_scope"), { resourceMetadataUrl: null, scope: null, error: "insufficient_scope" });
  assert.equal(parseWwwAuthenticate('Basic realm="x"'), null);
  assert.equal(parseWwwAuthenticate(null), null);
});

test("MCP over Streamable HTTP: session and version headers, JSON and SSE replies, server pings answered, cancels, a dropped session started again, DELETE on stop", async () => {
  const fake = await fakeMcpServer();
  const manager = new McpManager(() => undefined, () => undefined, null);
  cleanup.push(() => manager.stopAll());
  const config: McpHttpServerConfig = { id: "remote", name: "Remote", transport: "http", url: fake.url, headers: { "X-Api-Key": "k-123" }, enabled: true };
  manager.sync([config]);
  await until(() => manager.state([config])[0].status === "connected");
  const [summary] = manager.state([config]);
  assert.deepEqual({ transport: summary.transport, url: summary.url, toolCount: summary.toolCount, signedIn: summary.signedIn }, { transport: "http", url: fake.url, toolCount: 3, signedIn: false });
  assert.deepEqual(manager.toolsOf("remote"), [
    { name: "echo", title: "Echo", description: "Echo text back", isReadOnly: true, isDisabled: false },
    { name: "add", description: "Add two numbers", isDisabled: false },
    { name: "slow", description: "Answers only when cancelled", isDisabled: false },
  ]);

  const initialize = fake.log.find((entry) => entry.rpc === "initialize")!;
  assert.equal(initialize.headers["mcp-session-id"], undefined, "initialize starts a session");
  assert.equal(initialize.headers.accept, "application/json, text/event-stream");
  assert.equal(initialize.headers["x-api-key"], "k-123", "configured headers go with every request");
  assert.equal(initialize.message.params.protocolVersion, PROTOCOL);
  const order = fake.log.map((entry) => entry.rpc);
  assert.ok(order.indexOf("notifications/initialized") < order.indexOf("tools/list"), "initialized is sent (and accepted) before tools/list");
  for (const entry of fake.log.filter((item) => item.rpc !== "initialize")) {
    assert.equal(entry.headers["mcp-session-id"], "s1");
    assert.equal(entry.headers["mcp-protocol-version"], PROTOCOL);
  }

  assert.deepEqual(await manager.call("remote", "echo", { text: "hi" }, new AbortController().signal), { text: "echo: hi", image: null, isError: false });
  await until(() => fake.answers.length === 1);
  assert.deepEqual(fake.answers[0], { jsonrpc: "2.0", id: `ping-${fake.log.find((entry) => entry.rpc === "tools/call")!.message.id}`, result: {} }, "the ping on the reply stream is answered");

  const abort = new AbortController();
  const slow = manager.call("remote", "slow", {}, abort.signal);
  await until(() => fake.log.some((entry) => entry.rpc === "tools/call" && entry.message.params.name === "slow"));
  abort.abort();
  await assert.rejects(slow, /interrupted/);
  await until(() => fake.cancelled.length === 1);
  assert.deepEqual(fake.cancelled[0], { requestId: fake.log.find((entry) => entry.rpc === "tools/call" && entry.message.params.name === "slow")!.message.id, reason: "interrupted" });

  fake.expireSessions();
  assert.equal((await manager.call("remote", "add", { a: 2, b: 3 }, new AbortController().signal)).text, JSON.stringify({ sum: 5 }, null, 2));
  assert.equal(fake.log.filter((entry) => entry.rpc === "initialize").length, 2, "a session the server dropped is started again");

  manager.stopAll();
  await until(() => fake.deleted.length === 1);
  assert.equal(fake.deleted[0], "s2", "stopping ends the session");
});

test("MCP discovery: well-known fallbacks and path-aware issuers, refusals for a foreign resource, no PKCE, a mismatched issuer, no metadata", async () => {
  const docs = new Map<string, unknown>();
  const base = await listen((request, response) => {
    const doc = docs.get(new URL(request.url ?? "/", "http://x").pathname);
    if (doc == null) return sendJson(response, 404, {});
    sendJson(response, 200, doc);
  });
  const authServer = (overrides: Record<string, unknown> = {}) => ({ issuer: `${base}/tenant`, authorization_endpoint: `${base}/tenant/authorize`, token_endpoint: `${base}/tenant/token`, code_challenge_methods_supported: ["S256"], ...overrides });
  // Metadata only at the origin's well-known path, for a resource covering the server's path.
  docs.set("/.well-known/oauth-protected-resource", { resource: `${base}/v1`, authorization_servers: [`${base}/tenant`], scopes_supported: ["read"] });
  docs.set("/.well-known/oauth-authorization-server/tenant", authServer());
  const plan = await discoverMcpAuthorization(`${base}/v1/mcp`, null);
  assert.equal(plan.resource, `${base}/v1`);
  assert.equal(plan.server.issuer, `${base}/tenant`);
  assert.equal(plan.server.registrationEndpoint, null);
  assert.deepEqual(plan.scopes, ["read"]);
  assert.deepEqual((await discoverMcpAuthorization(`${base}/v1/mcp`, { resourceMetadataUrl: null, scope: "write", error: null })).scopes, ["write"], "the server's challenge picks the scope");
  await assert.rejects(registerMcpClient(plan.server, "http://127.0.0.1:1/callback", []), /doesn't let apps register themselves/);

  docs.set("/.well-known/oauth-protected-resource", { resource: `${base}/other`, authorization_servers: [`${base}/tenant`] });
  await assert.rejects(discoverMcpAuthorization(`${base}/v1/mcp`, null), /another resource/);
  docs.set("/.well-known/oauth-protected-resource", { resource: `${base}/v1`, authorization_servers: [`${base}/tenant`] });
  docs.set("/.well-known/oauth-authorization-server/tenant", authServer({ code_challenge_methods_supported: ["plain"] }));
  await assert.rejects(discoverMcpAuthorization(`${base}/v1/mcp`, null), /PKCE/);
  docs.set("/.well-known/oauth-authorization-server/tenant", authServer({ issuer: "https://evil.example" }));
  await assert.rejects(discoverMcpAuthorization(`${base}/v1/mcp`, null), /another issuer/);
  docs.delete("/.well-known/oauth-authorization-server/tenant");
  docs.set("/tenant/.well-known/openid-configuration", authServer());
  assert.equal((await discoverMcpAuthorization(`${base}/v1/mcp`, null)).server.tokenEndpoint, `${base}/tenant/token`, "OpenID discovery under the issuer's path");
  docs.clear();
  await assert.rejects(discoverMcpAuthorization(`${base}/v1/mcp`, null), /publishes no OAuth metadata/);
  await assert.rejects(discoverMcpAuthorization(`${base}/v1/mcp`, { resourceMetadataUrl: `${base}/missing`, scope: null, error: null }), /couldn't be loaded/);
});

test("MCP sign-in for the box on this PC: 401 asks for it, discovery, registration, PKCE and resource, tokens refreshed with rotation, revoked on removal", async () => {
  const tokens = new Set<string>();
  const authServer = await fakeAuthServer(tokens);
  const fake = await fakeMcpServer({ tokens, authorizationServer: authServer.base });
  const { auth, secrets, opened } = signer();
  // box/main.ts asks main over box-host; main answers from these sign-ins.
  const manager = new McpManager(() => undefined, () => undefined, {
    accessToken: (server, force) => auth.signIns.accessToken(server.id, server.url, force),
    forget: async (serverId) => void (await auth.signIns.forget(serverId, true)),
  });
  cleanup.push(() => manager.stopAll());
  const config: McpHttpServerConfig = { id: "linear", name: "Linear", transport: "http", url: fake.url, headers: {}, enabled: true };
  const summary = () => manager.state([config])[0];
  manager.sync([config]);
  await until(() => summary().status === "needsAuth");
  assert.deepEqual(summary().statusDetail, { kind: "sign_in_needed" });
  assert.equal(summary().toolCount, 0);
  const target = manager.signInTarget(config);
  assert.deepEqual(target.challenge, { resourceMetadataUrl: `${fake.base}/.well-known/oauth-protected-resource/mcp`, scope: "mcp:tools", error: "invalid_token" });

  const credentials = await auth.signIn(target);
  const registration = authServer.log.find((entry) => entry.path === "/register")!;
  assert.equal(registration.params.client_name, "Wisp");
  assert.equal(registration.params.token_endpoint_auth_method, "none");
  assert.deepEqual(registration.params.grant_types, ["authorization_code", "refresh_token"]);
  assert.match(registration.params.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const authorize = new URL(opened[0]).searchParams;
  assert.deepEqual(
    ["response_type", "client_id", "code_challenge_method", "resource", "scope", "redirect_uri"].map((key) => authorize.get(key)),
    ["code", "client-1", "S256", fake.url, "mcp:tools", registration.params.redirect_uris[0]],
  );
  const exchange = authServer.log.find((entry) => entry.path === "/token")!;
  assert.deepEqual([exchange.params.grant_type, exchange.params.resource, exchange.params.client_id], ["authorization_code", fake.url, "client-1"]);
  assert.deepEqual(
    { serverUrl: credentials.serverUrl, resource: credentials.resource, issuer: credentials.issuer, clientId: credentials.clientId, accessToken: credentials.accessToken, refreshToken: credentials.refreshToken },
    { serverUrl: fake.url, resource: fake.url, issuer: authServer.base, clientId: "client-1", accessToken: "at-1", refreshToken: "rt-1" },
  );
  assert.equal(stored(secrets).servers?.linear, undefined, "signing in returns the sign-in; the caller decides where it's kept");

  await auth.signIns.save("linear", credentials);
  assert.equal(stored(secrets).servers?.linear.refreshToken, "rt-1", "kept with main's secrets (keychain-encrypted in the app)");
  manager.restart("linear");
  await until(() => summary().status === "connected");
  assert.equal(summary().signedIn, true);
  assert.equal(summary().toolCount, 3);
  assert.equal((await manager.call("linear", "echo", { text: "signed in" }, new AbortController().signal)).text, "echo: signed in");
  assert.equal(fake.log.at(-1)?.headers.authorization, "Bearer at-1");

  // The server stops taking the access token: one refresh, which rotates the refresh token, and the call goes through.
  tokens.delete("at-1");
  assert.equal((await manager.call("linear", "echo", { text: "again" }, new AbortController().signal)).text, "echo: again");
  const refreshes = () => authServer.log.filter((entry) => entry.path === "/token" && entry.params.grant_type === "refresh_token");
  assert.deepEqual(refreshes().map((entry) => [entry.params.refresh_token, entry.params.resource, entry.params.client_id]), [["rt-1", fake.url, "client-1"]]);
  assert.equal(stored(secrets).servers?.linear.refreshToken, "rt-2");

  // Near expiry the token is refreshed before use; concurrent refreshes share one request.
  await auth.signIns.save("linear", { ...stored(secrets).servers!.linear, expiresAt: Date.now() - 1000 });
  const [first, second] = await Promise.all([auth.signIns.accessToken("linear", fake.url, false), auth.signIns.accessToken("linear", fake.url, false)]);
  assert.equal(first?.accessToken, "at-3");
  assert.equal(second?.accessToken, "at-3");
  assert.equal(refreshes().length, 2);
  assert.equal(await auth.signIns.accessToken("linear", "https://elsewhere.example/mcp", false), null, "a sign-in is only for the address it was made with");

  // A refresh token the server won't take any more: the server needs a sign-in again.
  authServer.state.failRefresh = "invalid_grant";
  tokens.clear();
  await assert.rejects(manager.call("linear", "echo", { text: "x" }, new AbortController().signal), /Linear needs you to sign in again/);
  assert.equal(summary().status, "needsAuth");
  assert.equal(auth.signIns.has("linear"), false);

  // Signing in again reuses the app's registration while its loopback port is free.
  authServer.state.failRefresh = null;
  await auth.signIns.save("linear", await auth.signIn(manager.signInTarget(config)));
  assert.equal(authServer.clients.size, 1);
  assert.equal(new URL(opened[1]).searchParams.get("redirect_uri"), registration.params.redirect_uris[0]);
  manager.restart("linear");
  await until(() => summary().status === "connected");

  // Removing the server revokes its sign-in.
  manager.sync([]);
  manager.forget("linear");
  await until(() => authServer.revoked.length === 1);
  assert.equal(authServer.revoked[0], "rt-4", "the second sign-in's refresh token");
  assert.equal(auth.signIns.has("linear"), false);
});

test("remote MCP server on the box on this PC, end to end: added by URL, signed in, tools listed, a tool call waits on the approval card", async () => {
  const tokens = new Set<string>();
  const authServer = await fakeAuthServer(tokens);
  const fake = await fakeMcpServer({ tokens, authorizationServer: authServer.base });
  const { auth } = signer();
  const dir = tempDir();
  const box = await startBoxHost({
    dataDir: dir,
    version: "test",
    token: TOKEN,
    host: "127.0.0.1",
    port: 0,
    bridgeListener: "shared",
    config: { models: MOCK_MODELS, workspaceRoot: join(dir, "workspaces"), cloud: null },
    refreshChatGptToken: async () => {
      throw new Error("not used");
    },
    mcpAuth: {
      accessToken: (server, force) => auth.signIns.accessToken(server.id, server.url, force),
      forget: async (serverId) => void (await auth.signIns.forget(serverId, true)),
    },
    log: () => undefined,
  });
  cleanup.push(() => box.close());
  const api = async <T = any>(method: string, args: unknown): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${box.port}/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(args) });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as T;
  };
  const server = async () => (await api<{ servers: McpServerSummary[] }>("readAppsState", {})).servers[0];

  const { servers } = await api<{ servers: McpServerSummary[] }>("addMcpServer", { name: "Linear", configJson: JSON.stringify({ url: fake.url }) });
  assert.deepEqual({ id: servers[0].id, transport: servers[0].transport, url: servers[0].url }, { id: "linear", transport: "http", url: fake.url });
  await until(async () => (await server()).status === "needsAuth");

  // What main does on Sign in: the target over box-control, the browser flow, the sign-in kept by main, a reconnect.
  await auth.signIns.save("linear", await auth.signIn(box.mcpSignInTarget("linear")));
  box.mcpSignInChanged("linear");
  await until(async () => (await server()).status === "connected");
  assert.equal((await server()).signedIn, true);
  assert.deepEqual(await api<McpServerTool[]>("mcpServerTools", { serverId: "linear" }), [
    { name: "echo", title: "Echo", description: "Echo text back", isReadOnly: true, isDisabled: false },
    { name: "add", description: "Add two numbers", isDisabled: false },
    { name: "slow", description: "Answers only when cancelled", isDisabled: false },
  ]);
  assert.throws(() => box.mcpSignInTarget("nope"), /No such MCP server/);

  const { agent } = await api<{ agent: { id: string } }>("addAgent", { name: "Tester", description: "" });
  const entries = async () => (await api<{ entries: TranscriptEntry[] }>("readTranscriptEnd", { id: agent.id, limit: 50 })).entries;
  await api("deliverMessage", { agentId: agent.id, prompt: '/tool mcp__linear__echo {"text":"from the agent"}', clientNonce: "n1" });
  let card: SendMessageEntry | undefined;
  await until(async () => {
    card = (await entries()).find((entry): entry is SendMessageEntry => entry.kind === "send-message" && entry.message.type === "local-tool-permission");
    return card != null;
  });
  const message = card!.message as Extract<SendMessageEntry["message"], { type: "local-tool-permission" }>;
  assert.deepEqual([message.ask.status, message.ask.title, message.ask.action], ["pending", "Use echo from Linear", "use-app"]);
  assert.equal(fake.log.filter((entry) => entry.rpc === "tools/call").length, 0, "nothing runs before the user answers");

  await api("answerToolApproval", { agentId: agent.id, entryId: card!.id, requestId: message.ask.requestId, resolution: "allow-once" });
  await until(async () => (await entries()).some((entry) => entry.kind === "tool-call" && entry.status === "done" && entry.detail?.output === "echo: from the agent"));
  await until(async () => (await entries()).some((entry) => entry.kind === "message" && entry.role === "assistant" && !entry.isStreaming && /echo: from the agent/.test(entry.content)));
  assert.equal(fake.log.find((entry) => entry.rpc === "tools/call")?.headers.authorization, "Bearer at-1");

  await api("dropMcpServer", { serverId: "linear" });
  await until(() => authServer.revoked.length === 1);
  assert.equal(auth.signIns.has("linear"), false, "removing the server forgets its sign-in");
});

async function bootBox(dataDir: string, admin = true): Promise<BoxServer> {
  const settings = { dataDir, host: "127.0.0.1", port: 0, token: TOKEN, tls: null, behindTlsProxy: false, admin, configFile: join(dataDir, "box-config.json"), workspaceRoot: join(dataDir, "workspaces") };
  const server = await startBoxServer({ settings, env: {}, version: "9.9.9-test", detectClaudeCode: NO_CLAUDE, log: () => undefined });
  cleanup.push(() => server.close());
  return server;
}

test("remote box: the sign-in made on the PC moves to the box, which refreshes and revokes it; this PC keeps no copy", async () => {
  const tokens = new Set<string>();
  const authServer = await fakeAuthServer(tokens);
  const fake = await fakeMcpServer({ tokens, authorizationServer: authServer.base });
  const dir = tempDir();
  const box = await bootBox(dir);
  const call = (path: string, args: unknown) => fetch(`${box.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(args) });
  const state = async () => ((await (await call("/api/readAppsState", {})).json()) as { servers: McpServerSummary[] }).servers[0];
  assert.equal((await call("/api/addMcpServer", { name: "Notion", configJson: JSON.stringify({ mcpServers: { notion: { type: "http", url: fake.url } } }) })).status, 200);
  await until(async () => (await state()).status === "needsAuth");

  // What main's startMcpSignIn does when the box is remote.
  const remote = new RemoteBoxClient({ baseUrl: box.url, token: TOKEN }, { onChange: () => undefined, log: () => undefined });
  cleanup.push(() => remote.close());
  const { auth, secrets } = signer();
  const target = await remote.call("mcpSignInTarget", { serverId: "notion" });
  assert.equal(target.url, fake.url);
  assert.equal(target.challenge?.resourceMetadataUrl, `${fake.base}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(remote.status, null, "a sign-in target isn't the box's status");
  const credentials = await auth.signIn(target);
  assert.equal((await remote.call("importMcpSignIn", { serverId: "notion", credentials })).version, "9.9.9-test");
  assert.deepEqual(stored(secrets).servers, {}, "this PC keeps only its client registration");
  await until(async () => (await state()).status === "connected");
  assert.equal((await state()).signedIn, true);
  const file = join(dir, "mcp-auth.json");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).servers.notion.refreshToken, "rt-1");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);

  // The box refreshes the sign-in itself once the server stops taking the token.
  tokens.delete("at-1");
  box.host.mcpSignInChanged("notion");
  await until(async () => (await state()).status === "connected" && JSON.parse(readFileSync(file, "utf8")).servers.notion.refreshToken === "rt-2");
  assert.deepEqual(
    authServer.log.filter((entry) => entry.params.grant_type === "refresh_token").map((entry) => entry.params.refresh_token),
    ["rt-1"],
  );

  // A sign-in for another address is refused; signing out revokes it on the box.
  const elsewhere = await call("/admin/importMcpSignIn", { serverId: "notion", credentials: { ...credentials, serverUrl: "https://elsewhere.example/mcp" } });
  assert.equal(elsewhere.status, 409);
  await remote.call("signOutMcpServer", { serverId: "notion" });
  assert.deepEqual(authServer.revoked, ["rt-2"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).servers, {});
  await until(async () => (await state()).status === "needsAuth");

  // With WISP_BOX_ADMIN=off the box reads targets but takes no sign-ins.
  box.close();
  const locked = await bootBox(dir, false);
  const lockedCall = (method: string, args: unknown) => fetch(`${locked.url}/admin/${method}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(args) });
  assert.equal((await lockedCall("mcpSignInTarget", { serverId: "notion" })).status, 200);
  const refused = await lockedCall("importMcpSignIn", { serverId: "notion", credentials });
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as { failureCode: string }).failureCode, "admin/disabled");
});
