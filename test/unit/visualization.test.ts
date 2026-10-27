import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type BoxServer, startBoxServer } from "../../src/box-server/server";
import { Harness } from "../../src/box/harness";
import { isInside } from "../../src/box/http";
import { McpManager } from "../../src/box/mcp";
import { toggleReaction } from "../../src/box/message-actions";
import { BoxStore } from "../../src/box/store";
import type { AgentSummary, ClaudeCodeStatus, SendMessageEntry, ToolCallEntry, TranscriptEntry } from "../../src/shared/model";
import { clampVisualizationHeight, MAX_VISUALIZATION_HTML, VISUALIZATION_CSP, VISUALIZATION_HEIGHT_MESSAGE, visualizationDocument } from "../../src/shared/visualization";

const cleanup: Array<() => void> = [];
after(() => {
  for (const fn of cleanup.reverse()) fn();
});

const TOKEN = randomBytes(24).toString("hex");
const NO_CLAUDE = async (): Promise<ClaudeCodeStatus> => ({ executable: null, installed: false, version: null, signedIn: false, authMethod: null, checkedAt: 1 });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wisp-viz-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function agent(id: string): AgentSummary {
  return {
    id, name: "Charts", description: "", path: "", origin: "user", isGroup: false, memberIds: [], isActive: false, createdAt: 1, updatedAt: 1,
    isRunning: false, isComposingMessage: false, awaitingUserResponse: null, hasUnread: false, lastMessageId: null, lastEntry: null,
    notificationsEnabled: true, notifyOnUpdatesEnabled: true, avatarDataUrl: null, instructions: "", model: null, isPinned: false,
  };
}

function setup() {
  const dir = tempDir();
  const store = new BoxStore(dir);
  cleanup.push(() => store.close());
  store.putAgent(agent("a1"));
  const events: Array<{ channel: string; payload: any }> = [];
  const harness = new Harness({
    store,
    models: () => ({ defaultModel: { provider: "mock", model: "mock-1" }, reasoningEffort: "default", temperature: null, xai: null, openai: null, anthropic: null, custom: null, claudeCode: null }),
    resolveDeps: { chatGptToken: async () => "unused" },
    workspaceRoot: () => join(dir, "workspaces"),
    localTools: () => [],
    callLocalTool: async () => ({ kind: "error", message: "no local tools" }),
    mcp: new McpManager(() => undefined, () => undefined),
    claudeCode: null,
    cloud: null,
    cloudConfig: () => null,
    emit: (channel, payload) => events.push({ channel, payload }),
    log: () => undefined,
  });
  return { dir, store, harness, events };
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const HTML = `<svg viewBox="0 0 100 40" width="100%"><rect x="0" y="10" width="60" height="20" fill="var(--viz-series-1)"></rect></svg><script>document.title = WispViz.theme;</script>`;

/** Runs show_visualization through the mock model and waits for the run to end. */
async function show(harness: Harness, store: BoxStore, args: Record<string, unknown>, nonce: string): Promise<{ card: SendMessageEntry | undefined; call: ToolCallEntry }> {
  const before = new Set(store.entries("a1").map((entry) => entry.id));
  harness.submitPrompt("a1", { prompt: `/tool show_visualization ${JSON.stringify(args)}`, attachmentPaths: [], attachmentNames: [], clientNonce: nonce, source: "user" });
  await until(() => !harness.isRunning("a1") && store.entries("a1").some((entry) => !before.has(entry.id) && entry.kind === "tool-call" && entry.status !== "pending"));
  const added = store.entries("a1").filter((entry) => !before.has(entry.id));
  return {
    card: added.find((entry): entry is SendMessageEntry => entry.kind === "send-message"),
    call: added.find((entry): entry is ToolCallEntry => entry.kind === "tool-call")!,
  };
}

test("show_visualization keeps the HTML by its hash in the attachment store and posts a card after the call", async () => {
  const { dir, store, harness, events } = setup();
  const { card, call } = await show(harness, store, { title: "Weekly   sales", html: HTML, summary: "Sales by day.", height: 240 }, "v1");
  assert.equal(call.status, "done", call.detail?.error ?? "");
  assert.equal(call.summary, "Showed “Weekly sales”");
  assert.match(call.detail!.output, /Shown in the chat as “Weekly sales”/);
  assert.ok(card != null && card.message.type === "visualization");
  const message = card.message;
  const sha256 = createHash("sha256").update(HTML).digest("hex");
  assert.deepEqual([message.title, message.summary, message.documentSha256, message.heightPx], ["Weekly sales", "Sales by day.", sha256, 240]);
  assert.equal(message.path, join(dir, "attachments", "visualizations", `${sha256}.html`));
  assert.ok(isInside(message.path, join(dir, "attachments")), "served by /media for a PC talking to a remote box");
  assert.equal(readFileSync(message.path, "utf8"), HTML);
  assert.ok(card.seq > call.seq && card.turn === call.turn && card.step === call.step, "the card follows its call in the same step");
  assert.ok(events.some((event) => event.channel === "transcript" && event.payload.type === "appended" && event.payload.entry.id === card.id));

  // The same HTML again is the same file; the card takes reactions like a message.
  const again = await show(harness, store, { title: "Again", html: HTML }, "v2");
  assert.ok(again.card?.message.type === "visualization" && again.card.message.path === message.path);
  assert.equal(again.card.message.type === "visualization" ? again.card.message.heightPx : -1, undefined);
  assert.deepEqual(toggleReaction(card, "📈", "user"), [{ emoji: "📈", by: "user" }]);

  // The model sees its call and the result, not the card.
  const conversation = JSON.stringify(harness.buildConversation("a1"));
  assert.ok(conversation.includes("show_visualization") && !conversation.includes('"kind":"send-message"'));
});

test("show_visualization refuses an empty title, empty HTML and HTML over the limit, and posts nothing", async () => {
  const { store, harness } = setup();
  for (const [args, pattern] of [
    [{ title: "  ", html: HTML }, /title/],
    [{ title: "Blank", html: "   " }, /empty/],
    [{ title: "Huge", html: "x".repeat(MAX_VISUALIZATION_HTML + 1) }, /keep it under/],
  ] as const) {
    const { card, call } = await show(harness, store, args, `bad-${String(args.title).trim() || "untitled"}`);
    assert.equal(call.status, "failed");
    assert.match(call.detail!.error ?? "", pattern);
    assert.equal(card, undefined);
  }
});

test("the visualization document: the fragment, the theme's colors and WispViz, and a height report; the frame's bounds", () => {
  const light = visualizationDocument(HTML, "light");
  const dark = visualizationDocument(HTML, "dark");
  assert.ok(light.startsWith("<!doctype html>") && light.includes(`<body>\n${HTML}\n</body>`));
  assert.match(light, /color-scheme: light; --viz-text: #1c1c1c;/);
  assert.match(dark, /color-scheme: dark; --viz-text: #f5f5f5;/);
  assert.match(dark, /--viz-series-6: #59c8b5/);
  assert.match(dark, /window\.WispViz = Object\.freeze\(\{"theme":"dark","tokens":\{"text":"#f5f5f5"/);
  assert.ok(light.includes(`type: "${VISUALIZATION_HEIGHT_MESSAGE}"`), "it posts its height to the page");
  // Inline script and style only: the CSP allows nothing else.
  assert.equal(VISUALIZATION_CSP, "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'");
  assert.doesNotMatch(light.replace(HTML, ""), /\bsrc=|href=|@import|url\(/);
  assert.deepEqual([clampVisualizationHeight(10), clampVisualizationHeight(500.4), clampVisualizationHeight(99_999), clampVisualizationHeight(Number.NaN)], [80, 500, 1200, 360]);
});

test("box server: /media serves a visualization's file to a PC that talks to a remote box", async () => {
  const dir = tempDir();
  const server: BoxServer = await startBoxServer({
    settings: { dataDir: dir, host: "127.0.0.1", port: 0, token: TOKEN, tls: null, behindTlsProxy: false, admin: true, configFile: join(dir, "box-config.json"), workspaceRoot: join(dir, "workspaces") },
    env: { WISP_BOX_DEFAULT_MODEL: "mock:mock-1" },
    version: "9.9.9-test",
    detectClaudeCode: NO_CLAUDE,
    log: () => undefined,
  });
  cleanup.push(() => server.close());
  const post = async (method: string, args: unknown) =>
    (await fetch(`${server.url}/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(args) })).json();
  const { agent: created } = await post("addAgent", { name: "Remote charts", description: "" });
  await post("deliverMessage", { agentId: created.id, prompt: `/tool show_visualization ${JSON.stringify({ title: "Remote", html: HTML })}`, clientNonce: "r1" });
  // Once the run is over (the mock replies after the tool), the card is there.
  for (let attempt = 0; attempt < 250; attempt++) {
    const rows = (await post("rosterAgents", {})) as AgentSummary[];
    if (rows.some((row) => row.id === created.id && !row.isRunning && row.lastTurnSettlement != null)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const card = ((await post("readTranscriptEnd", { id: created.id, limit: 20 })).entries as TranscriptEntry[]).find((entry) => entry.kind === "send-message");
  assert.ok(card?.kind === "send-message" && card.message.type === "visualization");
  assert.ok(existsSync(card.message.path));
  const media = await fetch(`${server.url}/media?path=${encodeURIComponent(card.message.path)}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(media.status, 200);
  assert.equal(await media.text(), HTML);
});
