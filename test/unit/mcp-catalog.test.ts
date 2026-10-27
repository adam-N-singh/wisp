import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Harness } from "../../src/box/harness";
import { startBoxHost } from "../../src/box/host";
import { McpManager } from "../../src/box/mcp";
import { type CatalogApp, type CatalogFile, catalogProblems, catalogServer, MCP_CATALOG, mcpCatalog } from "../../src/box/mcp-catalog";
import { BoxStore } from "../../src/box/store";
import type { BoxModelConfig } from "../../src/shared/edges";
import { readSse } from "../../src/shared/gateway-protocol";
import type { AgentSummary, McpCatalogEntry, McpHttpServerConfig, McpServerSummary, McpServerTool, McpState, MessageEntry, TranscriptEntry } from "../../src/shared/model";

const cleanup: Array<() => void> = [];
after(() => {
  for (const fn of cleanup.reverse()) fn();
});

const TOKEN = randomBytes(24).toString("hex");
const MOCK_MODELS: BoxModelConfig = { defaultModel: { provider: "mock", model: "mock-1" }, reasoningEffort: "default", temperature: null, xai: null, openai: null, anthropic: null, custom: null, claudeCode: null };
const NO_SIGN_INS = { accessToken: async () => null, forget: async () => undefined };

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wisp-apps-"));
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

const sendJson = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
};

const TOOLS = [
  { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
];

/**
 * A remote MCP server (Streamable HTTP, JSON replies) with the tools above. With `tokens`, every
 * request needs one of them as a bearer token. It notes the Authorization header of each request.
 */
async function fakeMcpServer(options: { tokens?: Set<string> } = {}) {
  const authorizations: string[] = [];
  let initializes = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (raw += chunk));
    request.on("end", () => {
      const message = raw.length > 0 ? JSON.parse(raw) : null;
      authorizations.push(request.headers.authorization ?? "");
      if (request.method === "DELETE") return void response.writeHead(200).end();
      if (options.tokens != null && !options.tokens.has((request.headers.authorization ?? "").replace(/^Bearer /, ""))) {
        return sendJson(response, 401, { error: "invalid_token" }, { "www-authenticate": 'Bearer error="invalid_token"' });
      }
      if (message?.method === "initialize") {
        initializes++;
        return sendJson(response, 200, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }, { "mcp-session-id": `s${initializes}` });
      }
      if (message?.id == null) return void response.writeHead(202).end();
      if (message.method === "tools/list") return sendJson(response, 200, { jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
      if (message.method === "tools/call") return sendJson(response, 200, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `echo: ${message.params.arguments.text}` }] } });
      sendJson(response, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, authorizations, initializes: () => initializes };
}

/** A small catalog: an app with a sign-in, one with a token, and a public one with an optional field. */
function testCatalog(urls: { oauth: string; token: string; open: string }): CatalogFile {
  const site = { website: "https://example.com", docs: "https://example.com/mcp" };
  return {
    categories: [
      { key: "developer", label: "Developer tools" },
      { key: "productivity", label: "Productivity" },
    ],
    apps: [
      { id: "notes", name: "Notes", publisher: "Notes Inc.", category: "productivity", description: "Read and write the notes in your Notes workspace.", url: urls.oauth, auth: "oauth", color: "#123456", featured: true, ...site },
      {
        id: "tracker",
        name: "Tracker",
        publisher: "Tracker",
        category: "developer",
        description: "Search and file issues in your Tracker projects.",
        url: urls.token,
        auth: "token",
        headers: { Authorization: "Bearer {token}" },
        fields: [{ key: "token", label: "Personal token", secret: true, required: true, hintUrl: "https://example.com/tokens" }],
        color: "#654321",
        ...site,
      },
      { id: "docs", name: "Docs", publisher: "Docs", category: "developer", description: "Search the public documentation; no sign-in needed.", url: urls.open, query: { team: "{team}" }, fields: [{ key: "team", label: "Team" }], auth: "none", color: "#fcb400", monogram: "Dx", ...site },
    ],
  };
}

test("Connect Apps catalog: every bundled app is well formed, official and listed by category", () => {
  assert.deepEqual(catalogProblems(), []);
  const entries = mcpCatalog();
  assert.ok(entries.length >= 15, "a gallery worth browsing");
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  const order = MCP_CATALOG.categories.map((category) => category.key);
  assert.deepEqual(
    entries.map((entry) => order.indexOf(entry.categoryKey)),
    entries.map((entry) => order.indexOf(entry.categoryKey)).sort((a, b) => a - b),
    "grouped by category, in the categories' order",
  );
  for (const entry of entries) {
    assert.ok(order.includes(entry.categoryKey), `${entry.id}: a listed category`);
    assert.equal(new URL(entry.url).protocol, "https:", `${entry.id}: https only`);
    assert.match(entry.color, /^#[0-9a-f]{6}$/i);
    assert.ok(entry.monogram.length >= 1 && entry.monogram.length <= 2);
    if (entry.auth === "token") assert.ok(entry.fields?.some((field) => field.isSecret && field.isRequired), `${entry.id}: asks for its token`);
    const app = MCP_CATALOG.apps.find((candidate) => candidate.id === entry.id)!;
    // Every app connects with the fields it asks for, and nothing else is sent.
    const { url, headers } = catalogServer(app, Object.fromEntries((app.fields ?? []).filter((field) => field.required).map((field) => [field.key, "x"])));
    assert.equal(new URL(url).origin, new URL(app.url).origin);
    if (entry.auth !== "token") assert.deepEqual(headers, {}, `${entry.id}: a sign-in or nothing, no header`);
  }
  for (const id of ["github", "linear", "notion", "sentry", "stripe", "huggingface"]) assert.ok(entries.some((entry) => entry.id === id), `${id} is in the catalog`);
  assert.ok(entries.some((entry) => entry.featured));

  // The checks catch what a hand-edited entry gets wrong.
  const broken: CatalogApp = { id: "Bad App", name: "", publisher: "x", category: "nope", description: "short", url: "http://mcp.example.com/mcp", headers: { Authorization: "Bearer {key}" }, fields: [{ key: "unused", label: "Unused" }], auth: "oauth", website: "http://example.com", docs: "https://example.com", color: "red" };
  const problems = catalogProblems({ categories: MCP_CATALOG.categories, apps: [broken] });
  for (const expected of [/the id must be/, /the name must be/, /the description must be/, /category “nope”/, /must be https addresses/, /the color must/, /\{key\} isn't one of its fields/, /“unused” isn't used/, /an Authorization header turns the sign-in off/, /the address doesn't work/]) {
    assert.ok(problems.some((problem) => expected.test(problem)), `${expected} in ${problems.join("\n")}`);
  }
});

test("Connect Apps catalog: fields fill in the address, query and headers; empty optional ones are left out", () => {
  const app: CatalogApp = {
    id: "acme",
    name: "Acme",
    publisher: "Acme",
    category: "developer",
    description: "Acme's projects, scoped to one region and project.",
    url: "https://{region}.mcp.acme.example/mcp/",
    query: { project: "{project}", mode: "full" },
    headers: { Authorization: "Bearer {token}", "X-Team": "{team}" },
    auth: "token",
    fields: [
      { key: "region", label: "Region", required: true },
      { key: "project", label: "Project" },
      { key: "token", label: "API key", secret: true, required: true },
      { key: "team", label: "Team" },
    ],
    website: "https://acme.example",
    docs: "https://acme.example/mcp",
    color: "#000000",
  };
  assert.deepEqual(catalogServer(app, { region: "eu", token: "k1", project: "a b&c" }), { url: "https://eu.mcp.acme.example/mcp/?project=a+b%26c&mode=full", headers: { Authorization: "Bearer k1" } });
  assert.deepEqual(catalogServer(app, { region: " us ", token: "k2", team: "core", project: "" }), { url: "https://us.mcp.acme.example/mcp/?mode=full", headers: { Authorization: "Bearer k2", "X-Team": "core" } });
  assert.throws(() => catalogServer(app, { region: "eu" }), /needs api key/);
  assert.throws(() => catalogServer(app, { region: "eu", token: "k\r\nX-Evil: 1" }), /line breaks/);
  assert.throws(() => catalogServer(app, { region: "eu", token: "k", other: "x" }), /no setting called “other”/);
  assert.throws(() => catalogServer(app, { region: "evil.example/x?", token: "k" }), /isn't a web address|https|acme/, "a value can't move the server somewhere else");
});

test("box gateway: apps connect from the catalog, with more accounts, renames, a new token and removal", async () => {
  const open = await fakeMcpServer();
  const locked = await fakeMcpServer({ tokens: new Set(["tok-1", "tok-2"]) });
  const signIn = await fakeMcpServer({ tokens: new Set(["never-issued"]) });
  const catalog = testCatalog({ oauth: signIn.url, token: locked.url, open: open.url });
  assert.deepEqual(catalogProblems(catalog), []);
  const dir = tempDir();
  const boot = () =>
    startBoxHost({
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
      mcpAuth: NO_SIGN_INS,
      mcpCatalog: catalog,
      log: () => undefined,
    });
  let box = await boot();
  cleanup.push(() => box.close());
  const post = (method: string, args: unknown) => fetch(`http://127.0.0.1:${box.port}/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(args) });
  const api = async <T = any>(method: string, args: unknown): Promise<T> => {
    const response = await post(method, args);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as T;
  };
  const refused = async (method: string, args: unknown, status: number, message?: RegExp) => {
    const response = await post(method, args);
    assert.equal(response.status, status, `${method} ${JSON.stringify(args)}`);
    if (message != null) assert.match(((await response.json()) as { error: string }).error, message);
  };
  const servers = async () => (await api<{ servers: McpServerSummary[] }>("readAppsState", {})).servers;
  const server = async (id: string) => (await servers()).find((candidate) => candidate.id === id);
  const status = (id: string, wanted: McpServerSummary["status"]) => until(async () => (await server(id))?.status === wanted);

  // The gallery: by category, then in the file's order.
  const entries = await api<McpCatalogEntry[]>("readAppCatalog", {});
  assert.deepEqual(
    entries.map((entry) => [entry.id, entry.category, entry.auth]),
    [
      ["tracker", "Developer tools", "token"],
      ["docs", "Developer tools", "none"],
      ["notes", "Productivity", "oauth"],
    ],
  );
  assert.deepEqual(entries[0].fields, [{ key: "token", label: "Personal token", type: "string", isSecret: true, isRequired: true, hintUrl: "https://example.com/tokens" }]);
  assert.deepEqual([entries[1].monogram, entries[2].monogram, entries[2].featured], ["Dx", "N", true]);

  // Replies and events count the box's changes, so a client can drop a reply an event overtook.
  const events: McpState[] = [];
  const abort = new AbortController();
  cleanup.push(() => abort.abort());
  const stream = await fetch(`http://127.0.0.1:${box.port}/events`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: abort.signal });
  void (async () => {
    for await (const block of readSse(stream.body!, abort.signal)) {
      const frame = block.data != null ? JSON.parse(block.data) : null;
      if (frame?.channel === "apps-state") events.push(frame.payload);
    }
  })().catch(() => undefined);

  // A public app connects at once; an empty optional field stays out of its address.
  const docs = await api<McpState & { serverId: string }>("connectCatalogApp", { entryId: "docs", values: { team: "" } });
  assert.equal(docs.serverId, "docs");
  await status("docs", "connected");
  await until(() => events.some((event) => event.servers.find((summary) => summary.id === "docs")?.status === "connected"));
  const connected = events.find((event) => event.servers.find((summary) => summary.id === "docs")?.status === "connected")!;
  assert.equal(connected.ordered!.epoch, docs.ordered!.epoch);
  assert.ok(connected.ordered!.sequence > docs.ordered!.sequence, "the connected state is newer than the install's reply");
  const added = (await server("docs"))!;
  assert.deepEqual([added.name, added.pluginId, added.accountKey, added.url, added.toolCount, added.disabledToolCount], ["Docs", "docs", "", open.url, 2, 0]);
  await refused("connectCatalogApp", { entryId: "docs" }, 409, /already added/);
  await refused("connectCatalogApp", { entryId: "nope" }, 404);

  // A token app needs its token, and sends it as the header.
  await refused("connectCatalogApp", { entryId: "tracker" }, 400, /needs personal token/);
  await refused("connectCatalogApp", { entryId: "tracker", values: { token: "tok\nX-Evil: 1" } }, 400, /line breaks/);
  const tracker = await api<{ serverId: string }>("connectCatalogApp", { entryId: "tracker", values: { token: "tok-1" } });
  assert.equal(tracker.serverId, "tracker");
  await status("tracker", "connected");
  assert.deepEqual(new Set(locked.authorizations), new Set(["Bearer tok-1"]));

  // Another account: named, with its own id (agents see mcp__tracker-work__…) and token.
  await refused("connectCatalogApp", { entryId: "tracker", values: { token: "tok-2" } }, 409, /Name the new account/);
  const work = await api<{ serverId: string }>("connectCatalogApp", { entryId: "tracker", accountKey: " Work ", values: { token: "tok-2" } });
  assert.equal(work.serverId, "tracker-work");
  await refused("connectCatalogApp", { entryId: "tracker", accountKey: "Work", values: { token: "tok-2" } }, 409, /already have a Tracker account called “Work”/);
  await status("tracker-work", "connected");
  assert.equal((await server("tracker-work"))!.accountKey, "Work");

  // Renaming keeps the connection; names stay unique within the app.
  const connects = locked.initializes();
  await refused("relabelMcpAccount", { serverId: "tracker-work", accountKey: "Home", newAccountKey: "Clients" }, 409, /renamed meanwhile/);
  await refused("relabelMcpAccount", { serverId: "tracker-work", accountKey: "Work", newAccountKey: "" }, 409, /Another Tracker account has no name/);
  await api("relabelMcpAccount", { serverId: "tracker-work", accountKey: "Work", newAccountKey: "Clients" });
  assert.deepEqual([(await server("tracker-work"))!.accountKey, (await server("tracker-work"))!.status], ["Clients", "connected"]);

  // Switches and instructions don't reconnect either.
  const tools = await api<McpServerTool[]>("switchMcpTool", { serverId: "tracker", toolName: "add" });
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.isDisabled, tool.isReadOnly ?? null]),
    [
      ["echo", false, true],
      ["add", true, null],
    ],
  );
  await api("changeAppInstructions", { serverId: "tracker", instructions: "  File bugs in the Platform project.  " });
  assert.deepEqual([(await server("tracker"))!.disabledToolCount, (await server("tracker"))!.customInstructions], [1, "File bugs in the Platform project."]);
  assert.equal(locked.initializes(), connects, "renames, switches and instructions keep the sessions");
  await refused("switchMcpTool", { serverId: "missing", toolName: "add" }, 404);

  // A new token for an account reconnects with it and keeps its settings.
  await refused("connectCatalogApp", { entryId: "docs", serverId: "tracker", values: {} }, 409, /wasn't added from Docs/);
  const before = locked.authorizations.length;
  await api("connectCatalogApp", { entryId: "tracker", serverId: "tracker", values: { token: "tok-2" } });
  await until(() => locked.initializes() > connects);
  await status("tracker", "connected");
  assert.ok(locked.authorizations.slice(before).includes("Bearer tok-2"));
  const replaced = (await server("tracker"))!;
  assert.deepEqual([replaced.accountKey, replaced.disabledToolCount, replaced.customInstructions], ["", 1, "File bugs in the Platform project."]);

  // An app with a sign-in waits for it, and sends no header of its own.
  await api("connectCatalogApp", { entryId: "notes" });
  await status("notes", "needsAuth");
  assert.deepEqual(new Set(signIn.authorizations), new Set([""]));

  // The box remembers it all; removing an account forgets it.
  box.close();
  box = await boot();
  await status("tracker-work", "connected");
  assert.deepEqual(
    (await servers()).map((summary) => [summary.id, summary.pluginId, summary.accountKey]),
    [
      ["docs", "docs", ""],
      ["tracker", "tracker", ""],
      ["tracker-work", "tracker", "Clients"],
      ["notes", "notes", ""],
    ],
  );
  await refused("dropMcpAccount", { serverId: "tracker-work", accountKey: "Work" }, 409);
  await api("dropMcpAccount", { serverId: "tracker-work", accountKey: "Clients" });
  assert.deepEqual(
    (await servers()).map((summary) => summary.id),
    ["docs", "tracker", "notes"],
  );
});

test("box gateway: a switched-off tool isn't offered to the model, and an app's instructions are in the prompt while its tools are", async () => {
  const open = await fakeMcpServer();
  const catalog = testCatalog({ oauth: open.url, token: open.url, open: open.url });
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
    mcpAuth: NO_SIGN_INS,
    mcpCatalog: catalog,
    log: () => undefined,
  });
  cleanup.push(() => box.close());
  const api = async <T = any>(method: string, args: unknown): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${box.port}/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(args) });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as T;
  };
  await api("connectCatalogApp", { entryId: "docs" });
  await until(async () => (await api<{ servers: McpServerSummary[] }>("readAppsState", {})).servers[0]?.status === "connected");

  const { agent } = await api<{ agent: AgentSummary }>("addAgent", { name: "Researcher", description: "" });
  const entries = async () => (await api<{ entries: TranscriptEntry[] }>("readTranscriptEnd", { id: agent.id, limit: 200 })).entries;
  const replies = async () => (await entries()).filter((entry): entry is MessageEntry => entry.kind === "message" && entry.role === "assistant" && !entry.isStreaming);
  let nonce = 0;
  /** What the mock model says to a prompt (it reads its system prompt back for /system). */
  const ask = async (prompt: string) => {
    const count = (await replies()).length;
    await api("deliverMessage", { agentId: agent.id, prompt, clientNonce: `n${++nonce}` });
    await until(async () => (await replies()).length > count && (await api<AgentSummary[]>("rosterAgents", {})).find((row) => row.id === agent.id)?.isRunning === false);
    return (await replies()).pop()!.content;
  };

  assert.doesNotMatch(await ask("/system"), /## Apps/, "no instructions, no section");
  await api("changeAppInstructions", { serverId: "docs", instructions: "Cite the page you used.\nPrefer the newest version." });
  assert.match(await ask("/system"), /\n## Apps\nThe user gave instructions for these connected apps\. Follow them whenever you use that app's tools\.\n\n### Docs \(tools named mcp__docs__…\)\nCite the page you used\.\nPrefer the newest version\.\n/);

  // A switched-off tool isn't among the tools the model is offered, so the mock can't call it.
  await api("switchMcpTool", { serverId: "docs", toolName: "echo" });
  assert.match(await ask('/tool mcp__docs__echo {"text":"hi"}'), /^Mock model here\./);
  assert.equal((await entries()).some((entry) => entry.kind === "tool-call"), false);
  // With every tool off, the app's instructions go too.
  await api("switchMcpTool", { serverId: "docs", toolName: "add" });
  assert.doesNotMatch(await ask("/system"), /## Apps/);
  // Back on, the model is offered it again (it asks before its first use).
  const tools = await api<McpServerTool[]>("switchMcpTool", { serverId: "docs", toolName: "echo" });
  assert.deepEqual(tools.map((tool) => tool.isDisabled), [false, true]);
  await api("deliverMessage", { agentId: agent.id, prompt: '/tool mcp__docs__echo {"text":"hi"}', clientNonce: "n-call" });
  await until(async () => (await entries()).some((entry) => entry.kind === "tool-call" && entry.name === "mcp__docs__echo"));
  await api("stopAgentRun", { id: agent.id });
});

test("harness: switched-off tools leave the tool list at once, and instructions follow the tools", async () => {
  const fake = await fakeMcpServer();
  const dir = tempDir();
  const store = new BoxStore(dir);
  cleanup.push(() => store.close());
  const now = Date.now();
  const row = { id: "a1", name: "Tester", description: "", path: "", origin: "user", isGroup: false, memberIds: [], isActive: false, createdAt: now, updatedAt: now, isRunning: false, isComposingMessage: false, awaitingUserResponse: null, hasUnread: false, lastMessageId: null, lastEntry: null, notificationsEnabled: true, notifyOnUpdatesEnabled: true, avatarDataUrl: null, instructions: "", model: null, isPinned: false } as AgentSummary;
  store.putAgent(row);
  const manager = new McpManager(() => undefined, () => undefined, null);
  cleanup.push(() => manager.stopAll());
  const harness = new Harness({
    store,
    models: () => MOCK_MODELS,
    resolveDeps: { chatGptToken: async () => "unused" },
    workspaceRoot: () => join(dir, "workspaces"),
    localTools: () => [],
    callLocalTool: async () => ({ kind: "error", message: "no local tools" }),
    mcp: manager,
    claudeCode: null,
    cloud: null,
    cloudConfig: () => null,
    emit: () => undefined,
    log: () => undefined,
  });
  const config: McpHttpServerConfig = { id: "tracker-work", name: "Tracker", accountKey: "Work", pluginId: "tracker", transport: "http", url: fake.url, headers: {}, enabled: true, customInstructions: "Use the Platform project." };
  manager.sync([config]);
  await until(() => manager.state([config])[0].status === "connected");
  const offered = () => harness.toolSpecs(row).map((spec) => spec.function.name).filter((name) => name.startsWith("mcp__"));
  assert.deepEqual(offered(), ["mcp__tracker-work__add", "mcp__tracker-work__echo"]);
  assert.match(harness.toolSpecs(row).find((spec) => spec.function.name === "mcp__tracker-work__echo")!.function.description, /^\[Tracker \(Work\)\] Echo text back/, "agents can tell the accounts apart");
  assert.match(harness.systemPrompt(row), /\n### Tracker \(Work\) \(tools named mcp__tracker-work__…\)\nUse the Platform project\.\n/);

  manager.sync([{ ...config, disabledTools: ["add"] }]);
  assert.deepEqual(offered(), ["mcp__tracker-work__echo"]);
  manager.sync([{ ...config, disabledTools: ["add", "echo"] }]);
  assert.deepEqual(offered(), []);
  assert.doesNotMatch(harness.systemPrompt(row), /## Apps/);
  assert.equal(fake.initializes(), 1, "the switches never reconnect");
  manager.sync([{ ...config, url: `${fake.url}?v=2` }]);
  await until(() => fake.initializes() === 2 && manager.state([config])[0].status === "connected");
});
