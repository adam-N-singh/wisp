import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ServerChatGptSignIn } from "../../src/box-server/chatgpt-sign-in";
import { effectiveConfig, readOperatorConfig, readServerSettings, scrubSecretEnv, type ServerSettings, USAGE, UsageError } from "../../src/box-server/config";
import { type BoxServer, startBoxServer } from "../../src/box-server/server";
import { GatewayClient } from "../../src/coordinator/gateway-client";
import { IssuedApprovals } from "../../src/local-exec/approvals";
import { agentWorkspace } from "../../src/local-exec/workspace";
import { normalizeBoxUrl, probeBox, RemoteBoxClient, RemoteBoxError } from "../../src/main/remote-box";
import type { BoxConfig, BoxServerStatus } from "../../src/shared/edges";
import { readSse } from "../../src/shared/gateway-protocol";
import type { ClaudeCodeStatus, TranscriptEntry, TranscriptEvent } from "../../src/shared/model";
import { isInside } from "../../src/shared/paths";

const cleanup: Array<() => void> = [];
after(() => {
  for (const fn of cleanup.reverse()) fn();
});

const TOKEN = randomBytes(24).toString("hex");
const NO_CLAUDE = async (): Promise<ClaudeCodeStatus> => ({ executable: null, installed: false, version: null, signedIn: false, authMethod: null, checkedAt: 1 });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wisp-box-server-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function settingsFor(dataDir: string, overrides: Partial<ServerSettings> = {}): ServerSettings {
  return { dataDir, host: "127.0.0.1", port: 0, token: TOKEN, tls: null, behindTlsProxy: false, admin: true, configFile: join(dataDir, "box-config.json"), workspaceRoot: join(dataDir, "workspaces"), ...overrides };
}

async function boot(dataDir: string, overrides: Partial<ServerSettings> = {}, env: NodeJS.ProcessEnv = {}, chatGptAuthBase?: string): Promise<BoxServer> {
  const server = await startBoxServer({ settings: settingsFor(dataDir, overrides), env: { ...env }, version: "9.9.9-test", detectClaudeCode: NO_CLAUDE, chatGptAuthBase, log: () => undefined });
  cleanup.push(() => server.close());
  return server;
}

const call = (server: BoxServer, path: string, init: RequestInit = {}, token = TOKEN) =>
  fetch(`${server.url}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) } });

async function api<T = any>(server: BoxServer, method: string, args: unknown): Promise<T> {
  const response = await call(server, `/api/${method}`, { method: "POST", body: JSON.stringify(args) });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as T;
}

async function admin<T = BoxServerStatus>(server: BoxServer, method: string, args: unknown): Promise<T> {
  const response = await call(server, `/admin/${method}`, { method: "POST", body: JSON.stringify(args) });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as T;
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** What the app pushes: its own keys, plus paths that only mean something on the PC. */
const PUSHED: BoxConfig = {
  models: {
    defaultModel: { provider: "xai", model: "grok-4.7" },
    reasoningEffort: "high",
    temperature: 0.2,
    xai: { baseUrl: "https://api.x.ai/v1", apiKey: "xai-secret-from-app" },
    openai: { baseUrl: "https://api.openai.com/v1", auth: "chatgpt", accessToken: "", expiresAt: 0 },
    anthropic: null,
    custom: null,
    claudeCode: { executable: "C:\\Users\\me\\.local\\bin\\claude.exe" },
  },
  workspaceRoot: "C:\\Users\\me\\AppData\\Roaming\\Wisp\\box\\workspaces",
  cloud: { apiKey: "e2b-secret-from-app", kind: "headless", idleMinutes: 10, askBeforeCommands: false },
};

test("box server settings: flags beat environment, tokens are long, TLS takes a pair", () => {
  const files: Record<string, string> = { "/run/secrets/box-token": `${"k".repeat(40)}\n` };
  const read = (env: NodeJS.ProcessEnv, argv: string[] = []) => readServerSettings(env, argv, (path) => files[path] ?? "");
  const settings = read({ WISP_BOX_DATA_DIR: "/srv/box", WISP_BOX_PORT: "9000" }, ["--port", "9100", "--host=0.0.0.0"]);
  assert.equal(settings.port, 9100);
  assert.equal(settings.host, "0.0.0.0");
  assert.equal(settings.configFile, join(settings.dataDir, "box-config.json"));
  assert.equal(settings.workspaceRoot, join(settings.dataDir, "workspaces"));
  assert.equal(settings.token, null);
  assert.equal(settings.admin, true);
  assert.equal(read({ WISP_BOX_TOKEN_FILE: "/run/secrets/box-token" }).token, "k".repeat(40));
  assert.equal(read({ WISP_BOX_ADMIN: "off" }).admin, false);
  assert.equal(read({ WISP_BOX_BEHIND_TLS_PROXY: "1" }).behindTlsProxy, true);
  assert.throws(() => read({ WISP_BOX_TOKEN: "short" }), /at least 32 characters/);
  assert.throws(() => read({ WISP_BOX_TLS_CERT: "/cert.pem" }), /both/);
  assert.throws(() => read({}, ["--port", "70000"]), /Invalid port/);
  assert.throws(() => read({}, ["--bogus"]), /Unknown argument/);
  assert.throws(() => read({}, ["--help"]), (error) => error instanceof UsageError && error.message === USAGE);
});

test("box server config: the app's keys win per provider, the server's fill gaps, paths stay the server's", () => {
  const operator = readOperatorConfig(
    { ANTHROPIC_API_KEY: "sk-ant-env", E2B_API_KEY: "e2b-env", WISP_BOX_DEFAULT_MODEL: "anthropic:claude-opus-5-5" },
    JSON.stringify({ xai: { apiKey: "xai-file" }, anthropic: { apiKey: "sk-ant-file" }, claudeCode: { executable: "/usr/local/bin/claude" } }),
  );
  assert.equal(operator.anthropic?.apiKey, "sk-ant-env", "the environment beats the file");
  assert.equal(operator.xai?.apiKey, "xai-file");
  assert.equal(operator.claudeCodeExecutable, "/usr/local/bin/claude");
  const claudeCode: ClaudeCodeStatus = { executable: "/usr/local/bin/claude", installed: true, version: "2.1.296", signedIn: true, authMethod: "claude.ai", checkedAt: 1 };

  const alone = effectiveConfig({ operator, pushed: null, workspaceRoot: "/data/workspaces", claudeCode, chatGptSignedIn: false });
  assert.deepEqual(alone.config.models.defaultModel, { provider: "anthropic", model: "claude-opus-5-5" });
  assert.deepEqual(alone.providers, { xai: "server", openai: null, anthropic: "server", custom: null, cloud: "server" });
  assert.deepEqual(alone.config.models.claudeCode, { executable: "/usr/local/bin/claude" });

  const merged = effectiveConfig({ operator, pushed: PUSHED, workspaceRoot: "/data/workspaces", claudeCode, chatGptSignedIn: false });
  assert.equal(merged.config.models.xai?.apiKey, "xai-secret-from-app");
  assert.equal(merged.config.models.anthropic?.apiKey, "sk-ant-env", "a provider the app doesn't send falls back to the server's key");
  assert.equal(merged.config.models.openai, null, "a ChatGPT plan needs a sign-in copied to the box");
  assert.equal(merged.config.cloud?.apiKey, "e2b-secret-from-app");
  assert.equal(merged.config.models.reasoningEffort, "high");
  assert.equal(merged.config.workspaceRoot, "/data/workspaces", "the PC's folder never applies");
  assert.deepEqual(merged.config.models.claudeCode, { executable: "/usr/local/bin/claude" }, "the PC's Claude Code never applies");

  const signedIn = effectiveConfig({ operator, pushed: PUSHED, workspaceRoot: "/data/workspaces", claudeCode, chatGptSignedIn: true });
  assert.equal(signedIn.config.models.openai?.auth, "chatgpt");
  assert.equal(signedIn.providers.openai, "app");

  assert.throws(() => readOperatorConfig({}, "{ nope"), /isn't valid JSON/);
  assert.throws(() => readOperatorConfig({}, JSON.stringify({ xai: { apiKey: "k", extra: 1 } })), /isn't valid/);
  assert.throws(() => readOperatorConfig({ WISP_BOX_DEFAULT_MODEL: "gpt-x" }, null), /model reference/);

  // Web search: on unless the app or the server says otherwise; the app's choice wins when it sends one.
  const models = (from: ReturnType<typeof readOperatorConfig>, pushed: BoxConfig | null) => {
    const { webSearch, xSearch } = effectiveConfig({ operator: from, pushed, workspaceRoot: "/data/workspaces", claudeCode, chatGptSignedIn: false }).config.models;
    return [webSearch, xSearch];
  };
  assert.deepEqual(models(readOperatorConfig({}, null), null), [true, true]);
  const searchOff = readOperatorConfig({ WISP_BOX_WEB_SEARCH: "off" }, JSON.stringify({ webSearch: true, xSearch: false }));
  assert.deepEqual([searchOff.webSearch, searchOff.xSearch], [false, false], "the environment beats the file");
  assert.deepEqual(models(searchOff, null), [false, false]);
  assert.deepEqual(models(searchOff, PUSHED), [false, false], "an app that doesn't send it leaves the server's choice");
  assert.deepEqual(models(searchOff, { ...PUSHED, models: { ...PUSHED.models, webSearch: true, xSearch: true } }), [true, true]);
  assert.throws(() => readOperatorConfig({}, JSON.stringify({ webSearch: "yes" })), /isn't valid/);

  // Secrets leave the environment that MCP servers and Claude Code inherit; Claude Code's own token stays.
  const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", WISP_BOX_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "c", PATH: "/bin" };
  scrubSecretEnv(env);
  assert.deepEqual(env, { CLAUDE_CODE_OAUTH_TOKEN: "c", PATH: "/bin" });
});

test("box server: plain HTTP only on loopback, the token on every route but /livez, a created token is kept", async () => {
  const dir = tempDir();
  await assert.rejects(startBoxServer({ settings: settingsFor(dir, { host: "0.0.0.0" }), env: {}, version: "x", detectClaudeCode: NO_CLAUDE, log: () => undefined }), /plain HTTP/);

  const server = await boot(dir, { token: null });
  const tokenFile = join(dir, "gateway-token");
  assert.equal(server.createdTokenFile, tokenFile);
  const token = readFileSync(tokenFile, "utf8").trim();
  assert.equal(token.length, 64);
  if (process.platform !== "win32") assert.equal(statSync(tokenFile).mode & 0o777, 0o600);

  assert.equal((await fetch(`${server.url}/livez`)).status, 204);
  assert.equal((await fetch(`${server.url}/health`)).status, 401);
  assert.equal((await call(server, "/health", {}, "x".repeat(64))).status, 401);
  assert.deepEqual(await (await call(server, "/health", {}, token)).json(), { ok: true, version: "9.9.9-test", protocol: 1, localExec: "down" });
  // Claude Code's bridge has its own loopback listener; the gateway doesn't serve it.
  assert.equal((await call(server, "/bridge/tools", { method: "POST", body: "{}" }, "some-run-token")).status, 401);
  server.close();

  const again = await boot(dir, { token: null });
  assert.equal(again.createdTokenFile, null, "the saved token is used again");
  assert.equal((await call(again, "/health", {}, token)).status, 200);
});

test("box server admin: pushed configuration survives restarts, secrets never come back, admin can be off", async () => {
  const dir = tempDir();
  const server = await boot(dir);
  const status = await admin(server, "configure", PUSHED);
  assert.equal(status.providers.xai, "app");
  assert.equal(status.providers.cloud, "app");
  assert.equal(status.providers.openai, null, "no ChatGPT sign-in on the box yet");
  assert.doesNotMatch(JSON.stringify(status), /secret/);
  assert.doesNotMatch(JSON.stringify(await admin(server, "status", {})), /secret/);
  assert.equal(server.host.config()?.workspaceRoot, join(dir, "workspaces"));
  const saved = join(dir, "app-config.json");
  assert.match(readFileSync(saved, "utf8"), /xai-secret-from-app/);
  if (process.platform !== "win32") assert.equal(statSync(saved).mode & 0o777, 0o600);
  assert.equal((await call(server, "/admin/configure", { method: "POST", body: "{}" })).status, 400);
  assert.equal((await call(server, "/admin/nope", { method: "POST", body: "{}" })).status, 404);
  assert.equal((await call(server, "/admin/status")).status, 405);
  assert.equal((await call(server, "/admin/status", { method: "POST", body: "{}" }, "x".repeat(48))).status, 401);
  server.close();

  const restarted = await boot(dir);
  assert.equal(restarted.status().providers.xai, "app");
  assert.equal(restarted.host.config()?.models.xai?.apiKey, "xai-secret-from-app");
  restarted.close();

  const locked = await boot(dir, { admin: false });
  const refused = await call(locked, "/admin/configure", { method: "POST", body: JSON.stringify(PUSHED) });
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as { failureCode: string }).failureCode, "admin/disabled");
  assert.equal((await admin(locked, "status", {})).admin, false, "reading the status still works");
});

test("box server time zone: the app's zone applies unless TZ is set, and automations follow it", async () => {
  const original = process.env.TZ;
  cleanup.push(() => {
    if (original == null) delete process.env.TZ;
    else process.env.TZ = original;
  });
  process.env.TZ = "UTC";
  const server = await boot(tempDir());
  const { agent } = await api<{ agent: { id: string } }>(server, "addAgent", { name: "Clock", description: "" });
  const [before] = await api<Array<{ nextRunAt: number }>>(server, "addAgentAutomation", { id: agent.id, spec: { name: "Morning", prompt: "Say hi.", trigger: { type: "cron", schedule: "0 9 * * *" } } });
  assert.equal(new Date(before.nextRunAt).getUTCHours(), 9);

  await admin(server, "configure", { ...PUSHED, timeZone: "Asia/Tokyo" });
  assert.equal(process.env.TZ, "Asia/Tokyo");
  const [after] = await api<Array<{ nextRunAt: number }>>(server, "listAgentAutomations", { id: agent.id });
  assert.equal(new Date(after.nextRunAt).getUTCHours(), 0, "09:00 in Tokyo is midnight UTC");
  await admin(server, "configure", { ...PUSHED, timeZone: "Not/AZone" });
  assert.equal(process.env.TZ, "Asia/Tokyo", "an unknown zone is ignored");

  const operator = readOperatorConfig({ TZ: "Europe/Berlin" }, null);
  assert.equal(effectiveConfig({ operator, pushed: { ...PUSHED, timeZone: "Asia/Tokyo" }, workspaceRoot: "/data/workspaces", claudeCode: await NO_CLAUDE(), chatGptSignedIn: false }).config.timeZone, "Europe/Berlin", "the operator's TZ wins");
});

test("box server gateway: prompts round-trip over HTTP and SSE, and PC tools run in the PC's folder", async () => {
  const dir = tempDir();
  const server = await boot(dir, {}, { WISP_BOX_DEFAULT_MODEL: "mock:mock-1" });
  const abort = new AbortController();
  cleanup.push(() => abort.abort());
  const auth = { authorization: `Bearer ${TOKEN}` };

  const events: Array<{ channel: string; payload: unknown }> = [];
  const stream = await fetch(`${server.url}/events`, { headers: auth, signal: abort.signal });
  void (async () => {
    for await (const block of readSse(stream.body!, abort.signal)) if (block.data != null) events.push(JSON.parse(block.data));
  })().catch(() => undefined);

  // A local-exec daemon on a Windows PC dials in and answers every tool request.
  const pcRoot = "C:\\Users\\tester\\AppData\\Roaming\\Wisp\\box\\workspaces";
  const register = await call(server, "/pc/register", {
    method: "POST",
    body: JSON.stringify({
      tools: [{ name: "list_directory", description: "List a folder", parameters: { type: "object", properties: {} }, permissionId: "files.read", readOnly: true }],
      label: "TESTPC",
      machine: { hostname: "TESTPC", platform: "win32", osType: "Windows_NT", osRelease: "10.0.26200", workspaceRoot: pcRoot },
    }),
  });
  assert.equal(register.status, 200);
  const requests: Array<{ requestId: string; cwd: string; tool: string }> = [];
  const daemon = await fetch(`${server.url}/pc/requests`, { headers: auth, signal: abort.signal });
  void (async () => {
    for await (const block of readSse(daemon.body!, abort.signal)) {
      if (block.data == null) continue;
      const request = JSON.parse(block.data);
      requests.push(request);
      await call(server, "/pc/responses", { method: "POST", body: JSON.stringify({ requestId: request.requestId, result: { kind: "ok", output: "notes.txt" } }) });
    }
  })().catch(() => undefined);
  await until(() => server.status().localExec === "ready");

  const { agent } = await api<{ agent: { id: string } }>(server, "addAgent", { name: "Remote", description: "" });
  const entries = async () => (await api<{ entries: TranscriptEntry[] }>(server, "readTranscriptEnd", { id: agent.id, limit: 50 })).entries;
  const reply = (pattern: RegExp) => async () => (await entries()).some((entry) => entry.kind === "message" && entry.role === "assistant" && !entry.isStreaming && pattern.test(entry.content));

  await api(server, "deliverMessage", { agentId: agent.id, prompt: "hello from the PC", clientNonce: "n1" });
  await until(reply(/You said: "hello from the PC"/));
  assert.ok(events.some((event) => event.channel === "transcript" && (event.payload as TranscriptEvent).type === "appended"), "transcript events reach the SSE stream");
  assert.ok(events.some((event) => event.channel === "agent-saved"));

  await api(server, "deliverMessage", { agentId: agent.id, prompt: "/tool list_directory {}", clientNonce: "n2" });
  await until(() => requests.length === 1);
  assert.equal(requests[0].tool, "list_directory");
  assert.equal(requests[0].cwd, `${pcRoot}\\${agent.id}`, "the PC's own folder, joined the Windows way");
  await until(reply(/Tool finished\. Output:[\s\S]*notes\.txt/));
  assert.equal(JSON.parse(readFileSync(join(dir, "local-machine.json"), "utf8")).machine.hostname, "TESTPC", "remembered for when the PC is off");
});

test("box server attachments: uploads land in the box's store, /media serves only that store", async () => {
  const dir = tempDir();
  const server = await boot(dir);
  const store = join(dir, "attachments");
  const upload = await call(server, `/attachments?name=${encodeURIComponent("../../report.txt")}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "quarterly numbers" });
  assert.equal(upload.status, 200);
  const { path, name, bytes } = (await upload.json()) as { path: string; name: string; bytes: number };
  assert.equal(name, "report.txt");
  assert.equal(bytes, 17);
  assert.ok(isInside(path, store));

  const media = await call(server, `/media?path=${encodeURIComponent(path)}`);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get("content-type"), "text/plain");
  assert.equal(await media.text(), "quarterly numbers");
  assert.equal((await call(server, `/media?path=${encodeURIComponent(join(store, "..", "agents.json"))}`)).status, 403);
  assert.equal((await call(server, `/media?path=${encodeURIComponent(join(store, "missing.png"))}`)).status, 404);
  assert.equal((await fetch(`${server.url}/media?path=${encodeURIComponent(path)}`)).status, 401);

  // The coordinator uploads staged files to a remote box and sends the box's paths instead.
  const staging = join(tempDir(), "attachments");
  mkdirSync(join(staging, "abc"), { recursive: true });
  const staged = join(staging, "abc", "photo.png");
  writeFileSync(staged, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const client = (remote: boolean) => new GatewayClient({ resolveConnection: async () => ({ baseUrl: server.url, token: TOKEN, remote }), onEvent: () => undefined, onState: () => undefined, log: () => undefined });
  const sent = await client(true).withUploadedAttachments({ attachmentPaths: [staged], attachmentNames: ["photo.png"] }, staging);
  assert.ok(isInside(sent.attachmentPaths![0], store));
  assert.deepEqual(readFileSync(sent.attachmentPaths![0]), readFileSync(staged));
  await assert.rejects(client(true).withUploadedAttachments({ attachmentPaths: [join(dir, "app-config.json")] }, staging), /attached in the app/);
  assert.deepEqual((await client(false).withUploadedAttachments({ attachmentPaths: [staged] }, staging)).attachmentPaths, [staged], "a box on this PC reads the file where it is");
});

/** A fake auth.openai.com token endpoint that rotates refresh tokens, plus discovery and revocation. */
async function fakeOpenAiAuth() {
  const log: Array<{ path: string; params: Record<string, string> }> = [];
  const state = { refreshes: 0, failNext: null as { status: number; error: string } | null };
  let base = "";
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", base);
      const params = Object.fromEntries(new URLSearchParams(raw));
      log.push({ path: url.pathname, params });
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (url.pathname === "/api/accounts/oauth/token") {
        if (state.failNext != null) {
          const failure = state.failNext;
          state.failNext = null;
          return json(failure.status, { error: failure.error });
        }
        state.refreshes++;
        if (params.refresh_token !== `refresh-${state.refreshes}`) return json(400, { error: "refresh_token_reused" });
        return json(200, { access_token: `access-${state.refreshes + 1}`, refresh_token: `refresh-${state.refreshes + 1}`, token_type: "Bearer", expires_in: 3600 });
      }
      if (url.pathname === "/.well-known/openid-configuration") return json(200, { revocation_endpoint: `${base}/api/accounts/oauth/revoke` });
      if (url.pathname === "/api/accounts/oauth/revoke") return json(200, {});
      json(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(() => server.close());
  return { base, log, state };
}

const idToken = (email: string) => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.sig`;
const copiedSignIn = (expiresAt: number) => ({
  clientId: "oaiapp_test",
  accessToken: "access-1",
  refreshToken: "refresh-1",
  idToken: idToken("tester@example.com"),
  expiresAt,
  scopes: ["openid", "offline_access", "chatgpt.tokens.use.direct"],
});

test("box server ChatGPT: a sign-in copied from the PC is refreshed by the box, which keeps its own host id", async () => {
  const fake = await fakeOpenAiAuth();
  const dir = tempDir();
  const signIn = new ServerChatGptSignIn({ dataDir: dir, authBase: fake.base, log: () => undefined });
  assert.match(signIn.hostId, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(new ServerChatGptSignIn({ dataDir: dir, authBase: fake.base, log: () => undefined }).hostId, signIn.hostId, "the host id is created once");
  await assert.rejects(signIn.accessToken(false), /isn't set up on your box/);

  signIn.import(copiedSignIn(Date.now() - 1000));
  assert.deepEqual(signIn.status(), { connected: true, planUsage: true, email: "tester@example.com", hostId: signIn.hostId });
  assert.equal((await signIn.accessToken(false)).accessToken, "access-2", "an expired token is refreshed");
  assert.equal((await signIn.accessToken(false)).accessToken, "access-2", "a fresh one is reused");
  assert.equal((await signIn.accessToken(true)).accessToken, "access-3", "the replacement refresh token is used next");
  const [first, second] = await Promise.all([signIn.accessToken(true), signIn.accessToken(true)]);
  assert.equal(first.accessToken, "access-4");
  assert.equal(second.accessToken, "access-4", "concurrent refreshes share one request");
  const file = join(dir, "chatgpt-auth.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.refreshToken, "refresh-4");
  assert.equal(saved.clientId, "oaiapp_test");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(
    fake.log.filter((entry) => entry.path === "/api/accounts/oauth/token").map((entry) => [entry.params.grant_type, entry.params.client_id, entry.params.refresh_token]),
    [
      ["refresh_token", "oaiapp_test", "refresh-1"],
      ["refresh_token", "oaiapp_test", "refresh-2"],
      ["refresh_token", "oaiapp_test", "refresh-3"],
    ],
  );

  fake.state.failNext = { status: 503, error: "temporarily_unavailable" };
  await assert.rejects(signIn.accessToken(true));
  assert.equal(signIn.status().connected, true, "a network or server failure keeps the sign-in");
  fake.state.failNext = { status: 400, error: "refresh_token_reused" };
  await assert.rejects(signIn.accessToken(true), /expired/);
  assert.equal(existsSync(file), false, "a spent refresh token clears it");

  // Through the admin endpoint, as the app moves a sign-in to the box.
  const server = await boot(tempDir(), {}, {}, fake.base);
  const imported = await admin(server, "importChatGptSignIn", { ...copiedSignIn(Date.now() + 3_600_000), email: "tester@example.com" });
  assert.deepEqual({ ...imported.chatgpt, hostId: "" }, { connected: true, planUsage: true, email: "tester@example.com", hostId: "" });
  assert.equal(imported.providers.openai, "server");
  assert.equal(server.host.config()?.models.openai?.auth, "chatgpt");
  assert.equal((await admin(server, "configure", PUSHED)).providers.openai, "app", "the app chose the plan");
  const signedOut = await admin(server, "signOutChatGpt", {});
  assert.equal(signedOut.chatgpt.connected, false);
  assert.equal(server.host.config()?.models.openai, null);
  assert.ok(fake.log.some((entry) => entry.path === "/api/accounts/oauth/revoke" && entry.params.token === "refresh-1"));
});

test("main's remote box client: https only, the token checked first, pushes in order", async () => {
  assert.equal(normalizeBoxUrl("box.example.com/"), "https://box.example.com");
  assert.equal(normalizeBoxUrl(" https://box.example.com/grok/ "), "https://box.example.com/grok");
  assert.equal(normalizeBoxUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.throws(() => normalizeBoxUrl("http://box.example.com"), /https/);
  assert.throws(() => normalizeBoxUrl("https://me:pw@box.example.com"), /user name/);
  assert.throws(() => normalizeBoxUrl(""), /address/);

  const dir = tempDir();
  const server = await boot(dir);
  const address = { baseUrl: server.url, token: TOKEN };
  assert.deepEqual(await probeBox(address), { version: "9.9.9-test" });
  await assert.rejects(probeBox({ ...address, token: "w".repeat(48) }), (error) => error instanceof RemoteBoxError && error.kind === "unauthorized");
  await assert.rejects(probeBox({ baseUrl: "http://127.0.0.1:9", token: TOKEN }), (error) => error instanceof RemoteBoxError && error.kind === "unreachable");

  let changes = 0;
  const client = new RemoteBoxClient(address, { onChange: () => void changes++, log: () => undefined });
  cleanup.push(() => client.close());
  await client.pushConfig(async () => PUSHED);
  assert.equal(client.status?.providers.xai, "app");
  assert.equal(client.error, null);
  assert.ok(changes > 0);

  // A push still waiting in line is dropped for the newer one.
  const built: string[] = [];
  const later: BoxConfig = { ...PUSHED, models: { ...PUSHED.models, defaultModel: { provider: "mock", model: "mock-1" } } };
  await Promise.all([client.pushConfig(async () => (built.push("older"), PUSHED)), client.pushConfig(async () => (built.push("newer"), later))]);
  assert.deepEqual(built, ["newer"]);
  assert.deepEqual(server.host.config()?.models.defaultModel, { provider: "mock", model: "mock-1" });
  assert.deepEqual(await client.call("listModels", { provider: "mock" }), [{ id: "mock-1", label: "Mock model" }]);
  server.close();

  const locked = await boot(dir, { admin: false });
  const refused = new RemoteBoxClient({ baseUrl: locked.url, token: TOKEN }, { onChange: () => undefined, log: () => undefined });
  cleanup.push(() => refused.close());
  await refused.pushConfig(async () => PUSHED);
  assert.match(refused.error ?? "", /doesn't accept settings from the app/);
});

test("local-exec honors a relayed approval only for its own card's call, answered on this PC", async () => {
  const answers = new Map<string, "allow-once" | "always" | "never">();
  const taken: string[] = [];
  const approvals = new IssuedApprovals(async (requestId) => {
    taken.push(requestId);
    const answer = answers.get(requestId) ?? null;
    answers.delete(requestId);
    return answer;
  });
  const call = { agentId: "a1", tool: "run_shell", args: { command: "mkdir out" } };
  const approval = (requestId: string | undefined, resolution: "allow-once" | "always" = "allow-once") => ({ resolution, entryId: "t1s2", ...(requestId != null ? { requestId } : {}) });

  assert.equal(await approvals.confirm({ ...call, approval: approval("invented-by-the-box") }), false, "an id this daemon never issued");
  assert.equal(await approvals.confirm({ ...call, approval: approval(undefined) }), false, "no id at all");
  assert.deepEqual(taken, [], "neither reaches the user's answers");

  approvals.issue("card-1", call);
  answers.set("card-1", "allow-once");
  assert.equal(await approvals.confirm({ ...call, args: { command: "rm -rf ~" }, approval: approval("card-1") }), false, "a card can't approve another command");
  assert.equal(await approvals.confirm({ ...call, agentId: "a2", approval: approval("card-1") }), false, "or another agent's call");
  assert.equal(await approvals.confirm({ ...call, approval: approval("card-1") }), true);
  approvals.issue("card-1", call);
  assert.equal(await approvals.confirm({ ...call, approval: approval("card-1") }), false, "an answer works once");

  approvals.issue("card-2", call);
  answers.set("card-2", "allow-once");
  assert.equal(await approvals.confirm({ ...call, approval: approval("card-2", "always") }), false, "only the answer the user gave");
  approvals.issue("card-3", call);
  assert.equal(await approvals.confirm({ ...call, approval: approval("card-3") }), false, "no answer given on this PC");
});

test("local-exec decides the agent's folder from its id alone", () => {
  const root = tempDir();
  const id = "3f1c2a9e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
  assert.equal(agentWorkspace(root, id), join(root, id));
  assert.ok(existsSync(join(root, id)));
  for (const bad of ["..", "../escape", "a/b", "a\\b", "", ".hidden", "C:\\Windows"]) assert.throws(() => agentWorkspace(root, bad), /unusual agent id/, bad);
});

// A self-signed certificate for 127.0.0.1 and localhost, valid until 2126 (test only).
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBaDCCAQ+gAwIBAgIUcAwpX0SuqUq5UGjzgVqqifuzRgkwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyMzE5MDkyOFoYDzIxMjYwOTI5
MTkwOTI4WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAATdLYyvuWOUEVlnpe8do36nM3hEyVbH+L4HHHpZ+2aSLG4BHTtnGNKN
rpUGIazEN7Bo+UDodUm+2/MGG/ugcqcGoz0wOzAaBgNVHREEEzARhwR/AAABggls
b2NhbGhvc3QwHQYDVR0OBBYEFE/p16FXkiocHEd91Co95WOmj8NuMAoGCCqGSM49
BAMCA0cAMEQCIG/NxjuUmzOTRs015RX5eflRGptVr8MJSmRyqQvoTRBhAiBtqsG6
wQCV3MPi6rSBfTzUCpV1dlVpOxZ3UPBeukm5hA==
-----END CERTIFICATE-----
`;
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgnPFI0QFy/eWhBVeV
lZNsQ4ggqzqGBI2BB848xPg5tv+hRANCAATdLYyvuWOUEVlnpe8do36nM3hEyVbH
+L4HHHpZ+2aSLG4BHTtnGNKNrpUGIazEN7Bo+UDodUm+2/MGG/ugcqcG
-----END PRIVATE KEY-----
`;

test("box server TLS: serves HTTPS with its own certificate", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "cert.pem"), TEST_CERT);
  writeFileSync(join(dir, "key.pem"), TEST_KEY);
  const server = await boot(dir, { tls: { certFile: join(dir, "cert.pem"), keyFile: join(dir, "key.pem") } });
  assert.match(server.url, /^https:\/\/127\.0\.0\.1:\d+$/);
  const get = (path: string, token: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpsRequest(`${server.url}${path}`, { ca: TEST_CERT, headers: { authorization: `Bearer ${token}` } }, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      });
      request.on("error", reject);
      request.end();
    });
  const health = await get("/health", TOKEN);
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).ok, true);
  assert.equal((await get("/health", "nope".repeat(12))).status, 401);
});
