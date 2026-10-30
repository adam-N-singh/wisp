import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type BoxServer, startBoxServer } from "../../src/box-server/server";
import type { ClaudeCodeEngine, EngineHost } from "../../src/box/claude-code";
import { Harness } from "../../src/box/harness";
import { McpManager } from "../../src/box/mcp";
import { createDocument, PageError, pageEditsSince, readCanvas, retitleCanvas, restoreRevision, revisionList, writeCanvas } from "../../src/box/pages";
import { BoxStore } from "../../src/box/store";
import { CanvasFrames } from "../../src/main/canvases";
import {
  CANVAS_CSP,
  CANVAS_GESTURE_MS,
  CANVAS_HEADERS,
  CANVAS_LINK_MESSAGE,
  CANVAS_PERMISSIONS_POLICY,
  canvasAddress,
  canvasDocument,
  canvasFrameUrl,
  CanvasLinkGate,
  parseCanvasFrameUrl,
} from "../../src/shared/canvas";
import type { BoxModelConfig } from "../../src/shared/edges";
import { removeGlobals, WEBRTC_GLOBALS } from "../../src/shared/frame-lockdown";
import { readSse } from "../../src/shared/gateway-protocol";
import type { AgentSummary, ClaudeCodeStatus, PageMessage, SendMessageEntry, ToolCallEntry, TranscriptEntry } from "../../src/shared/model";
import { canvasExcerpt, canvasTitle, type LibraryPage, MAX_PAGE_SOURCE, type PageChangedEvent, type PageDocument, pageEditsNote, pageFileName, pageId } from "../../src/shared/pages";
import { TRUSTED_TYPES_DEFAULT_POLICY, VISUALIZATION_CSP, VISUALIZATION_FRAME_CSP, visualizationDocument } from "../../src/shared/visualization";

const cleanup: Array<() => void> = [];
const stores: BoxStore[] = [];
after(() => {
  stores.forEach((store) => store.close());
  for (const fn of cleanup.reverse()) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wisp-canvas-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function agent(id: string): AgentSummary {
  const now = Date.now();
  return {
    id, name: "Maker", description: "", path: "", origin: "user", isGroup: false, memberIds: [], isActive: false, createdAt: now, updatedAt: now,
    isRunning: false, isComposingMessage: false, awaitingUserResponse: null, hasUnread: false, lastMessageId: null, lastEntry: null,
    notificationsEnabled: true, notifyOnUpdatesEnabled: true, avatarDataUrl: null, instructions: "", model: null, isPinned: false,
  };
}

const MOCK_MODELS: BoxModelConfig = { defaultModel: { provider: "mock", model: "mock-1" }, reasoningEffort: "default", temperature: null, xai: null, openai: null, anthropic: null, custom: null, claudeCode: null };

function setup(options: { dir?: string; models?: BoxModelConfig; claudeCode?: ClaudeCodeEngine } = {}) {
  const dir = options.dir ?? tempDir();
  const store = new BoxStore(dir);
  stores.push(store);
  if (store.getAgent("a1") == null) store.putAgent(agent("a1"));
  const events: Array<{ channel: string; payload: any }> = [];
  const harness = new Harness({
    store,
    models: () => options.models ?? MOCK_MODELS,
    resolveDeps: { chatGptToken: async () => "unused" },
    workspaceRoot: () => join(dir, "workspaces"),
    localTools: () => [],
    callLocalTool: async () => ({ kind: "error", message: "no local tools" }),
    mcp: new McpManager(() => undefined, () => undefined),
    claudeCode: options.claudeCode ?? null,
    cloud: null,
    cloudConfig: () => null,
    emit: (channel, payload) => events.push({ channel, payload }),
    log: () => undefined,
  });
  return { dir, store, harness, events };
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const prompt = (text: string, clientNonce: string) => ({ prompt: text, attachmentPaths: [], attachmentNames: [], clientNonce, source: "user" as const });
const cards = (entries: TranscriptEntry[]) => entries.filter((entry): entry is SendMessageEntry & { message: PageMessage } => entry.kind === "send-message" && entry.message.type === "page");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const pageFiles = (dir: string) => (existsSync(join(dir, "attachments", "pages")) ? readdirSync(join(dir, "attachments", "pages")).sort() : []);

async function runTool(harness: Harness, store: BoxStore, name: string, args: Record<string, unknown>, nonce: string): Promise<{ call: ToolCallEntry; added: TranscriptEntry[] }> {
  const before = new Set(store.entries("a1").map((entry) => entry.id));
  harness.submitPrompt("a1", prompt(`/tool ${name} ${JSON.stringify(args)}`, nonce));
  await until(() => !harness.isRunning("a1") && store.entries("a1").some((entry) => !before.has(entry.id) && entry.kind === "tool-call" && entry.status !== "pending"));
  const added = store.entries("a1").filter((entry) => !before.has(entry.id));
  return { call: added.find((entry): entry is ToolCallEntry => entry.kind === "tool-call")!, added };
}

const COUNTER = `<!doctype html>
<html><head><title>Counter</title><style>button { font-size: 20px; }</style></head>
<body><h1>Clicks</h1><p id="out">0 clicks so far</p><button id="more">Add one</button>
<script>let n = 0; document.getElementById("more").onclick = () => { n++; document.getElementById("out").textContent = n + " clicks so far"; };</script>
</body></html>`;

/** The JSON line a canvas tool's output starts with. */
const result = (output: string) => JSON.parse(output.split("\n")[0]) as { canvas_id: string; title: string; url: string; revision: number };

test("canvas text and addresses: titles, excerpts, file names, the note, and frame URLs with the theme first", () => {
  assert.equal(canvasTitle(COUNTER), "Counter");
  assert.equal(canvasTitle("<h1>Big <em>news</em> &amp; more</h1>"), "Big news & more");
  assert.equal(canvasTitle("<p>no title</p>"), null);
  assert.equal(canvasExcerpt(COUNTER), "Clicks 0 clicks so far Add one");
  assert.equal(pageFileName("A: canvas?", "canvas"), "A canvas.html");
  assert.equal(pageFileName("", "canvas"), "Canvas.html");
  assert.equal(pageFileName("Plan"), "Plan.md");
  assert.match(pageEditsNote([{ documentId: "canvas-abc123", title: "Counter", revision: 3, kind: "canvas" }]), /“Counter” \(canvas-abc123, now revision 3\)\. Read a page with read_canvas before you change it again\.\]/);
  assert.match(pageEditsNote([{ documentId: "doc-abc123", title: "Plan", revision: 2 }, { documentId: "canvas-abc123", title: "Counter", revision: 3, kind: "canvas" }]), /read_document or read_canvas before you change it again/);

  assert.equal(canvasAddress("a1", "canvas-abc123"), "wisp-canvas://frame/store/a1/canvas-abc123");
  assert.equal(canvasFrameUrl("a1", "canvas-abc123", "dark", 2), "wisp-canvas://frame/store/a1/canvas-abc123?theme=dark&rev=2");
  assert.deepEqual(parseCanvasFrameUrl("wisp-canvas://frame/store/a1/canvas-abc123?theme=dark&rev=2"), { storeId: "a1", canvasId: "canvas-abc123", theme: "dark", rev: 2 });
  assert.deepEqual(parseCanvasFrameUrl("wisp-canvas://frame/store/a1/canvas-abc123?theme=light"), { storeId: "a1", canvasId: "canvas-abc123", theme: "light", rev: null });
  for (const bad of [
    "wisp-canvas://frame/store/a1/canvas-abc123?rev=2&theme=dark", // rev before theme
    "wisp-canvas://frame/store/a1/canvas-abc123",
    "wisp-canvas://frame/store/a1/canvas-abc123?theme=blue",
    "wisp-canvas://frame/store/a1/canvas-abc123?theme=dark&rev=0",
    "wisp-canvas://frame/store/a1/canvas-abc123?theme=dark&rev=2&x=1",
    "wisp-canvas://frame/user/canvas-abc123?theme=dark",
    "wisp-canvas://frame/store/a1/../canvas-abc123?theme=dark",
    "wisp-canvas://other/store/a1/canvas-abc123?theme=dark",
    "wisp-visualization://frame/store/a1/canvas-abc123?theme=dark",
  ]) {
    assert.equal(parseCanvasFrameUrl(bad), null, bad);
  }

  // The shell: the theme and the link guard come first, then the agent's whole document.
  const shell = canvasDocument(COUNTER, "dark");
  assert.ok(shell.startsWith('<!doctype html>\n<html lang="en" data-theme="dark">'));
  assert.ok(shell.indexOf("color-scheme: dark") < shell.indexOf("window.open = function") && shell.indexOf("window.open = function") < shell.indexOf("<title>Counter</title>"));
  assert.ok(shell.includes(CANVAS_LINK_MESSAGE) && shell.includes("--viz-accent: #4d9bff") && shell.endsWith(COUNTER));
});

test("the link gate opens http, https, mailto and tel links only within a second of a real click or key, one link per gesture, with a canvas on the page", () => {
  const gate = new CanvasLinkGate();
  assert.deepEqual(gate.admit("https://example.com/", true, 1_000), { open: false, reason: "no-gesture" }, "no click yet");
  gate.noteInput({ type: "mouseUp" }, 1_000);
  assert.deepEqual(gate.admit("https://example.com/a", true, 1_000 + CANVAS_GESTURE_MS), { open: true, url: "https://example.com/a" });
  assert.deepEqual(gate.admit("https://example.com/b", true, 1_000 + CANVAS_GESTURE_MS), { open: false, reason: "no-gesture" }, "the click is spent");
  gate.noteInput({ type: "mouseUp" }, 5_000);
  assert.deepEqual(gate.admit("https://example.com/late", true, 5_000 + CANVAS_GESTURE_MS + 1), { open: false, reason: "no-gesture" }, "more than a second later");
  gate.noteInput({ type: "mouseDown" }, 9_000);
  gate.noteInput({ type: "mouseMove" }, 9_000);
  gate.noteInput({ type: "keyDown", key: "Escape" }, 9_000);
  gate.noteInput({ type: "keyDown", key: "a", isAutoRepeat: true }, 9_000);
  gate.noteInput({ type: "keyUp", key: "Enter" }, 9_000);
  assert.deepEqual(gate.admit("https://example.com/", true, 9_100), { open: false, reason: "no-gesture" }, "a press, a move, Esc, a held key and a key going up aren't gestures");
  gate.noteInput({ type: "keyDown", key: "Enter" }, 10_000);
  for (const url of ["javascript:alert(1)", "file:///C:/Windows/win.ini", "wisp-canvas://frame/store/a1/canvas-abc123?theme=dark", "data:text/html,hi", "obsidian://open"]) {
    assert.deepEqual(gate.admit(url, true, 10_100), { open: false, reason: "scheme" }, url);
  }
  assert.deepEqual(gate.admit("not a url", true, 10_100), { open: false, reason: "invalid" });
  assert.deepEqual(gate.admit("mailto:someone@example.com", false, 10_100), { open: false, reason: "no-canvas" });
  assert.deepEqual(gate.admit("tel:+15551234567", true, 10_100), { open: true, url: "tel:+15551234567" });
  gate.noteInput({ type: "keyDown", key: "Enter" }, 20_000);
  assert.deepEqual(gate.admit("mailto:someone@example.com", true, 19_000), { open: false, reason: "no-gesture" }, "a clock that went back");
  gate.noteInput({ type: "keyDown", key: " " }, 30_000);
  assert.deepEqual(gate.admit("http://example.com", true, 30_500), { open: true, url: "http://example.com/" });
});

test("canvas revisions: HTML is kept by hash, writes add revisions, restore adds the old one as the user's, renames add none, and a restart keeps them all", () => {
  const { dir, store } = setup();
  const first = writeCanvas(store, "a1", { contents: COUNTER }, 1_000);
  assert.deepEqual([first.created, first.record.kind, first.record.title, first.record.revisions.length], [true, "canvas", "Counter", 1]);
  assert.match(first.record.id, /^canvas-[0-9a-f]{12}$/);
  assert.deepEqual(pageFiles(dir), [`${sha(COUNTER)}.html`]);
  const second = COUNTER.replace("Add one", "Add another");
  const updated = writeCanvas(store, "a1", { contents: second, canvasId: first.record.id }, 2_000);
  assert.deepEqual([updated.created, updated.changed, updated.record.revisions.map((revision) => revision.n), updated.record.title], [false, true, [1, 2], "Counter"]);
  assert.equal(writeCanvas(store, "a1", { contents: second, canvasId: first.record.id }, 2_500).changed, false, "the same HTML adds nothing");
  const retitled = writeCanvas(store, "a1", { contents: second, canvasId: first.record.id, title: "Click counter" }, 3_000);
  assert.deepEqual([retitled.changed, retitled.record.title, retitled.record.revisions.length], [true, "Click counter", 2], "a new title alone adds no revision");
  assert.equal(readCanvas(store, "a1", first.record.id, 1).source, COUNTER);

  const restored = restoreRevision(store, "a1", first.record.id, 1, 2, 4_000);
  assert.deepEqual([restored.source, restored.record.revisions.at(-1)!.by, restored.record.title], [COUNTER, "user", "Click counter"], "a canvas keeps its title through a restore");
  assert.deepEqual(revisionList(restored.record).map((revision) => [revision.n, revision.by]), [[3, "user"], [2, "agent"], [1, "agent"]]);
  assert.throws(() => restoreRevision(store, "a1", first.record.id, 1, 2), (error: unknown) => error instanceof PageError && error.code === "stale");
  assert.deepEqual(pageEditsSince(store, "a1", 3_500), [{ documentId: first.record.id, title: "Click counter", revision: 3, kind: "canvas" }]);

  // The agent's next write must name the revision the user restored, or it would undo the restore.
  const edited = COUNTER.replace("Add one", "Add a few");
  assert.throws(
    () => writeCanvas(store, "a1", { contents: edited, canvasId: first.record.id }),
    (error: unknown) => error instanceof PageError && error.code === "stale" && /is at revision 3 now, which the user restored since you wrote it\. Read it with read_canvas and write your change on that, with base_revision 3/.test(error.message),
  );
  assert.throws(
    () => writeCanvas(store, "a1", { contents: edited, canvasId: first.record.id, baseRevision: 2 }),
    (error: unknown) => error instanceof PageError && error.code === "stale" && /is at revision 3 now, not 2: the user changed it since\. Read it again with read_canvas/.test(error.message),
  );
  assert.equal(readCanvas(store, "a1", first.record.id).source, COUNTER, "nothing was written over the restore");
  const onRestore = writeCanvas(store, "a1", { contents: edited, canvasId: first.record.id, baseRevision: 3 }, 4_500);
  assert.deepEqual(onRestore.record.revisions.map((revision) => [revision.n, revision.by]).slice(-2), [[3, "user"], [4, "agent"]]);
  // With the agent's own revision newest again, a write needs no base.
  assert.equal(writeCanvas(store, "a1", { contents: second, canvasId: first.record.id }, 4_600).record.revisions.at(-1)!.n, 5);
  restoreRevision(store, "a1", first.record.id, 1, 5, 4_700);
  assert.equal(store.getPage("a1", first.record.id)!.revisions.at(-1)!.n, 6);

  assert.deepEqual(retitleCanvas(store, "a1", first.record.id, "  Clicks \n tally  ").record.title, "Clicks tally");
  assert.equal(store.getPage("a1", first.record.id)!.revisions.length, 6);
  assert.throws(() => retitleCanvas(store, "a1", first.record.id, "   "), /Give the canvas a title/);

  // A document and a canvas never stand in for each other; a canvas without a title takes "Untitled canvas".
  const doc = createDocument(store, "a1", "Notes", "# Notes\n\nHi.");
  assert.throws(() => writeCanvas(store, "a1", { contents: "<p>x</p>", canvasId: doc.record.id }), /is a document: read it with read_document/);
  assert.throws(() => readCanvas(store, "a1", doc.record.id), /is a document/);
  assert.equal(writeCanvas(store, "a1", { contents: "<p>no title here</p>" }).record.title, "Untitled canvas");
  assert.throws(() => writeCanvas(store, "a1", { contents: "x".repeat(MAX_PAGE_SOURCE + 1) }), /The canvas is 262145 characters; keep it under 262144/);

  // The same text as a document and as a canvas are two files; deleting one leaves the other.
  const same = "<h1>Same</h1>";
  const asCanvas = writeCanvas(store, "a1", { contents: same });
  const asDoc = createDocument(store, "a1", "Same", same);
  assert.ok(pageFiles(dir).includes(`${sha(same)}.html`) && pageFiles(dir).includes(`${sha(same)}.md`));
  store.deletePage("a1", asCanvas.record.id);
  assert.ok(!pageFiles(dir).includes(`${sha(same)}.html`) && pageFiles(dir).includes(`${sha(same)}.md`));
  store.deletePage("a1", asDoc.record.id);

  store.close();
  const reopened = new BoxStore(dir);
  stores.push(reopened);
  const kept = reopened.getPage("a1", first.record.id)!;
  assert.deepEqual([kept.kind, kept.title, kept.revisions.length], ["canvas", "Clicks tally", 6]);
  assert.equal(readCanvas(reopened, "a1", first.record.id, 2).source, second);
  reopened.deletePage("a1", first.record.id);
  assert.ok([COUNTER, second, edited].every((html) => !pageFiles(dir).includes(`${sha(html)}.html`)));
});

test("tools: write_canvas posts a card and answers {canvas_id, title, url}; a second write is revision 2 on the same card; read_canvas by id or url; the 256 KB cap and refusals post nothing", async () => {
  const { store, harness, events } = setup();
  const made = await runTool(harness, store, "write_canvas", { contents: COUNTER }, "w1");
  assert.equal(made.call.status, "done", made.call.detail?.error ?? "");
  assert.equal(made.call.summary, "Made “Counter”");
  const [page] = store.listPages("a1");
  assert.deepEqual(result(made.call.detail!.output), { canvas_id: page.id, title: "Counter", url: `wisp-canvas://frame/store/a1/${page.id}`, revision: 1 });
  assert.match(made.call.detail!.output, /Made “Counter” as canvas canvas-[0-9a-f]+ \(revision 1\)\. The user sees its card below this step/);
  const [card] = cards(made.added);
  assert.ok(card != null && card.seq > made.call.seq);
  assert.deepEqual(card.message, { type: "page", page: { kind: "canvas", storeId: "a1", canvasId: page.id }, title: "Counter", excerpt: "Clicks 0 clicks so far Add one", revision: 1, updatedBy: "agent", updatedAt: page.updatedAt });
  const created = events.find((event) => event.channel === "page-changed")!.payload as PageChangedEvent;
  assert.deepEqual([created.change, created.page.page, created.editRight], ["created", { kind: "canvas", storeId: "a1", canvasId: page.id }, { canEdit: false, reason: "agent-writing" }]);

  const second = COUNTER.replace("Add one", "Add two");
  const again = await runTool(harness, store, "write_canvas", { canvas_id: page.id, contents: second }, "w2");
  assert.equal(again.call.summary, "Updated “Counter”");
  assert.equal(result(again.call.detail!.output).revision, 2);
  assert.deepEqual(cards(again.added), [], "no second card");
  assert.deepEqual([cards(store.entries("a1"))[0].id, cards(store.entries("a1"))[0].message.revision, cards(store.entries("a1"))[0].message.excerpt], [card.id, 2, "Clicks 0 clicks so far Add two"]);

  const read = await runTool(harness, store, "read_canvas", { url: `wisp-canvas://frame/store/a1/${page.id}?theme=dark` }, "r1");
  assert.equal(read.call.summary, "Read “Counter”");
  assert.ok(read.call.detail!.output.endsWith(`“Counter”, revision 2, last changed by you:\n\n${second}`));
  assert.equal(result((await runTool(harness, store, "read_canvas", { canvas_id: page.id }, "r2")).call.detail!.output).canvas_id, page.id);

  const big = `<p>${"x".repeat(MAX_PAGE_SOURCE)}</p>`;
  for (const [name, args, pattern] of [
    ["write_canvas", { contents: big }, /The canvas is \d+ characters; keep it under 262144/],
    ["write_canvas", { contents: " \n " }, /The canvas is empty/],
    ["write_canvas", { canvas_id: "canvas-nothere1", contents: "<p>x</p>" }, /isn’t there any more\. Use a canvas_id that write_canvas returned/],
    ["read_canvas", {}, /Name the canvas/],
    ["read_canvas", { url: `wisp-canvas://frame/store/someone-else/${page.id}` }, /Name the canvas/],
    ["read_document", { document_id: page.id }, /is a canvas: read it with read_canvas/],
  ] as const) {
    const { call, added } = await runTool(harness, store, name, args, `bad-${name}-${JSON.stringify(args).length}`);
    assert.equal(call.status, "failed", name);
    assert.match(call.detail!.error ?? "", pattern);
    assert.deepEqual(cards(added), []);
  }
  // Exactly at the cap is fine, and read back whole.
  const atCap = `<p>${"y".repeat(MAX_PAGE_SOURCE - 7)}</p>`;
  const capped = await runTool(harness, store, "write_canvas", { contents: atCap, title: "Full" }, "w3");
  assert.equal(capped.call.status, "done", capped.call.detail?.error ?? "");
  const cappedRead = await runTool(harness, store, "read_canvas", { canvas_id: result(capped.call.detail!.output).canvas_id }, "r3");
  assert.ok(cappedRead.call.detail!.output.endsWith(atCap), "read_canvas comes back uncut");
});

test("write_canvas after the user restored a revision: refused without base_revision, so the restore stands; with it, a new revision on the restore", async () => {
  const { store, harness } = setup();
  const id = result((await runTool(harness, store, "write_canvas", { contents: COUNTER }, "b1")).call.detail!.output).canvas_id;
  await runTool(harness, store, "write_canvas", { canvas_id: id, contents: COUNTER.replace("Add one", "Add two") }, "b2");
  restoreRevision(store, "a1", id, 1, 2);
  const three = COUNTER.replace("Add one", "Add three");
  const blind = await runTool(harness, store, "write_canvas", { canvas_id: id, contents: three }, "b3");
  assert.equal(blind.call.status, "failed");
  assert.match(blind.call.detail!.error ?? "", /“Counter” is at revision 3 now, which the user restored since you wrote it\. Read it with read_canvas and write your change on that, with base_revision 3, so their restore isn't undone\./);
  assert.deepEqual(cards(blind.added), [], "the card isn't touched");
  assert.equal(readCanvas(store, "a1", id).source, COUNTER, "the restore stands");
  const stale = await runTool(harness, store, "write_canvas", { canvas_id: id, contents: three, base_revision: 2 }, "b4");
  assert.match(stale.call.detail!.error ?? "", /is at revision 3 now, not 2: the user changed it since\. Read it again with read_canvas/);
  const based = await runTool(harness, store, "write_canvas", { canvas_id: id, contents: three, base_revision: 3 }, "b5");
  assert.equal(based.call.status, "done", based.call.detail?.error ?? "");
  assert.equal(result(based.call.detail!.output).revision, 4);
  assert.equal(cards(store.entries("a1"))[0].message.revision, 4);
});

test("frames agents write lose WebRTC and get Trusted Types: the preload's lockdown works from a copy of its source; both shells set a pass-through default policy first", () => {
  // contextBridge.executeInMainWorld runs a copy of the function's source in the frame's world.
  const copy = new Function(`return (${removeGlobals.toString()})`)() as typeof removeGlobals;
  function Peer() {}
  const frame: Record<string, unknown> = { RTCPeerConnection: Peer, webkitRTCPeerConnection: Peer, fetch: Peer };
  copy(WEBRTC_GLOBALS, frame);
  assert.deepEqual([frame.RTCPeerConnection, frame.webkitRTCPeerConnection, frame.fetch], [undefined, undefined, Peer]);
  assert.equal(Reflect.set(frame, "RTCPeerConnection", Peer), false, "the page can't put it back");
  assert.throws(() => Object.defineProperty(frame, "webkitRTCPeerConnection", { value: Peer }), TypeError);
  copy(WEBRTC_GLOBALS, frame);
  assert.equal(frame.RTCPeerConnection, undefined, "running twice is harmless");
  assert.deepEqual(WEBRTC_GLOBALS, ["RTCPeerConnection", "webkitRTCPeerConnection"]);

  assert.match(CANVAS_CSP, /; require-trusted-types-for 'script'; sandbox allow-scripts allow-pointer-lock$/);
  assert.equal(VISUALIZATION_FRAME_CSP, `${VISUALIZATION_CSP}; require-trusted-types-for 'script'; sandbox allow-scripts`);
  for (const doc of [canvasDocument("<p>x</p>", "light"), visualizationDocument("<p>x</p>", "light")]) {
    const body = doc.indexOf("<script>") + "<script>".length;
    assert.equal(doc.slice(body, body + TRUSTED_TYPES_DEFAULT_POLICY.length), TRUSTED_TYPES_DEFAULT_POLICY, "before anything else runs");
  }
  const created: Array<[string, Record<string, (input: string) => string>]> = [];
  new Function("window", "trustedTypes", TRUSTED_TYPES_DEFAULT_POLICY)({ trustedTypes: {} }, { createPolicy: (name: string, rules: Record<string, (input: string) => string>) => created.push([name, rules]) });
  assert.equal(created.length, 1);
  const [name, rules] = created[0];
  assert.deepEqual([name, rules.createHTML("<b>x</b>"), rules.createScript("go()"), rules.createScriptURL("data:,")], ["default", "<b>x</b>", "go()", "data:,"]);
  assert.doesNotThrow(() => new Function("window", "trustedTypes", TRUSTED_TYPES_DEFAULT_POLICY)({}, undefined), "a browser without Trusted Types");
});

test("Claude Code agents write canvases through the bridge", async () => {
  let tools: string[] = [];
  const outputs: string[] = [];
  const engine = {
    runTurn: async (host: EngineHost) => {
      tools = host.appTools().map((tool) => tool.name);
      outputs.push((await host.runAppTool(1, "write_canvas", { contents: COUNTER })).output);
      return { sessionId: "session-1", failed: null, text: "" };
    },
  } as unknown as ClaudeCodeEngine;
  const { store, harness } = setup({ models: { ...MOCK_MODELS, claudeCode: { executable: "claude" } }, claudeCode: engine });
  store.putAgent({ ...store.getAgent("a1")!, model: "claude-code:default" });
  harness.submitPrompt("a1", prompt("make it", "b1"));
  await until(() => outputs.length === 1 && !store.getAgent("a1")!.isRunning);
  assert.ok(tools.includes("write_canvas") && tools.includes("read_canvas"));
  assert.equal(result(outputs[0]).title, "Counter");
  assert.equal(cards(store.entries("a1"))[0].message.page.kind, "canvas");
});

const TOKEN = randomBytes(24).toString("hex");
const NO_CLAUDE = async (): Promise<ClaudeCodeStatus> => ({ executable: null, installed: false, version: null, signedIn: false, authMethod: null, checkedAt: 1 });

test("a box server: GET /pages needs the token; main's wisp-canvas frames come from it with their headers; the gateway's canvas calls", async () => {
  const dir = tempDir();
  const server: BoxServer = await startBoxServer({
    settings: { dataDir: dir, host: "127.0.0.1", port: 0, token: TOKEN, tls: null, behindTlsProxy: false, admin: true, configFile: join(dir, "box-config.json"), workspaceRoot: join(dir, "workspaces") },
    env: { WISP_BOX_DEFAULT_MODEL: "mock:mock-1" },
    version: "9.9.9-test",
    detectClaudeCode: NO_CLAUDE,
    log: () => undefined,
  });
  cleanup.push(() => server.close());
  const post = (method: string, args: unknown) => fetch(`${server.url}/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(args) });
  const api = async <T = any>(method: string, args: unknown): Promise<T> => {
    const response = await post(method, args);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as T;
  };
  const refused = async (method: string, args: unknown, status: number, failureCode?: string) => {
    const response = await post(method, args);
    const body = (await response.json()) as { error: string; failureCode?: string };
    assert.equal(response.status, status, body.error);
    if (failureCode != null) assert.equal(body.failureCode, failureCode);
    return body.error;
  };
  const abort = new AbortController();
  cleanup.push(() => abort.abort());
  const pageEvents: PageChangedEvent[] = [];
  const stream = await fetch(`${server.url}/events`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: abort.signal });
  void (async () => {
    for await (const block of readSse(stream.body!, abort.signal)) {
      const frame = block.data != null ? JSON.parse(block.data) : null;
      if (frame?.channel === "page-changed") pageEvents.push(frame.payload);
    }
  })().catch(() => undefined);

  const { agent: created } = await api<{ agent: AgentSummary }>("addAgent", { name: "Maker", description: "" });
  const id = created.id;
  const row = async () => (await api<AgentSummary[]>("rosterAgents", {})).find((candidate) => candidate.id === id)!;
  await api("deliverMessage", { agentId: id, prompt: `/tool write_canvas ${JSON.stringify({ contents: COUNTER })}`, clientNonce: "g1" });
  await until(async () => !(await row()).isRunning && pageEvents.some((event) => event.change === "editable"));
  const [canvas] = await api<LibraryPage[]>("libraryPages", { includeDocuments: false });
  assert.equal(canvas.page.kind, "canvas");
  const canvasId = pageId(canvas.page);
  const locator = { storeId: id, canvasId };

  // The route: the gateway token or nothing.
  const pagePath = `${server.url}/pages/${id}/${canvasId}`;
  assert.equal((await fetch(pagePath)).status, 401);
  assert.equal((await fetch(pagePath, { headers: { authorization: `Bearer ${"0".repeat(TOKEN.length)}` } })).status, 401);
  const served = await fetch(`${pagePath}?rev=1`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(served.status, 200);
  assert.deepEqual(((await served.json()) as PageDocument).source, COUNTER);
  for (const bad of [`/pages/${id}/${canvasId}?rev=9`, `/pages/${id}/canvas-nothere1`, `/pages/no-such-agent/${canvasId}`, `/pages/${id}/..%2F..%2Fagents.json`, `/pages/${id}/${canvasId}/x`]) {
    const response = await fetch(`${server.url}${bad}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 404, bad);
  }

  // Main's frames, from the box over HTTP as for a box server: the shell, the theme, the headers.
  const frames = new CanvasFrames(async () => ({ baseUrl: server.url, token: TOKEN }));
  const frame = await frames.respond(canvasFrameUrl(id, canvasId, "dark", 1));
  assert.equal(frame.status, 200);
  assert.deepEqual(Object.fromEntries(frame.headers.entries()), { ...CANVAS_HEADERS, "content-type": "text/html; charset=utf-8" });
  assert.match(CANVAS_CSP, /sandbox allow-scripts allow-pointer-lock$/);
  assert.match(CANVAS_CSP, /connect-src 'none'/);
  assert.equal(CANVAS_PERMISSIONS_POLICY, "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()");
  assert.equal(frame.headers.get("referrer-policy"), "no-referrer");
  const body = await frame.text();
  assert.ok(body.startsWith('<!doctype html>\n<html lang="en" data-theme="dark">') && body.endsWith(COUNTER));
  const wrongToken = new CanvasFrames(async () => ({ baseUrl: server.url, token: "wrong" }));
  assert.equal((await wrongToken.respond(canvasFrameUrl(id, canvasId, "light"))).status, 404, "the box refused it");
  assert.equal((await frames.respond(`wisp-canvas://frame/store/${id}/${canvasId}?rev=1&theme=dark`)).status, 404, "out of order");
  assert.equal((await new CanvasFrames(async () => null).respond(canvasFrameUrl(id, canvasId, "light"))).status, 404, "no box");

  // A second write is revision 2: the newest frame shows it; revision 1 still serves revision 1.
  const second = COUNTER.replace("Add one", "Add two");
  await api("deliverMessage", { agentId: id, prompt: `/tool write_canvas ${JSON.stringify({ canvas_id: canvasId, contents: second })}`, clientNonce: "g2" });
  await until(async () => !(await row()).isRunning && (await api<PageDocument>("canvasPage", { locator })).revision === 2);
  assert.ok((await (await frames.respond(canvasFrameUrl(id, canvasId, "light"))).text()).endsWith(second));
  assert.ok((await (await frames.respond(canvasFrameUrl(id, canvasId, "light", 1))).text()).endsWith(COUNTER));
  assert.deepEqual((await api<PageDocument>("canvasPage", { locator, revision: 1 })).source, COUNTER);

  // The gateway: rename (no revision), the Library with and without documents, restore, delete.
  assert.deepEqual(await api("retitleCanvas", { storeId: id, canvasId, title: "  Tally " }), { title: "Tally" });
  await until(() => pageEvents.at(-1)?.change === "renamed");
  assert.deepEqual([pageEvents.at(-1)!.page.title, pageEvents.at(-1)!.page.revision, pageEvents.at(-1)!.by], ["Tally", 2, "user"]);
  await refused("retitleCanvas", { storeId: id, canvasId, title: "   " }, 400, "page/refused");
  await api("deliverMessage", { agentId: id, prompt: `/tool create_document ${JSON.stringify({ title: "Notes", markdown: "# Notes\n\nHi." })}`, clientNonce: "g3" });
  await until(async () => !(await row()).isRunning && (await api<LibraryPage[]>("libraryPages", { includeDocuments: true })).length === 2);
  assert.deepEqual((await api<LibraryPage[]>("libraryPages", { includeDocuments: false })).map((page) => page.title), ["Tally"]);
  assert.deepEqual((await api<LibraryPage[]>("libraryPages", { includeDocuments: true, agentId: id })).map((page) => page.page.kind).sort(), ["canvas", "document"]);
  assert.deepEqual((await api<LibraryPage[]>("libraryDocuments", { agentId: id })).map((page) => page.page.kind), ["document"]);
  assert.deepEqual((await api("listPageRevisions", { locator })).map((revision: { n: number }) => revision.n), [2, 1]);
  assert.deepEqual(await api("pageEditAccess", { locator }), { canEdit: true });
  const restored = await api<PageDocument>("restorePageRevision", { locator, revision: 1, baseRevision: 2 });
  assert.deepEqual([restored.revision, restored.updatedBy, restored.title, restored.source, restored.page.kind], [3, "user", "Tally", COUNTER, "canvas"]);
  await refused("restorePageRevision", { locator, revision: 1, baseRevision: 2 }, 409, "page/stale");
  await refused("canvasPage", { locator: { storeId: id, canvasId: "doc-abc1234" } }, 400);
  await refused("readPage", { locator: { storeId: id, documentId: canvasId } }, 400);
  assert.equal(await api("deletePage", { locator }), null);
  await refused("canvasPage", { locator }, 404, "page/not-found");
  assert.equal((await frames.respond(canvasFrameUrl(id, canvasId, "light"))).status, 404, "a deleted canvas has no frame");
  assert.ok(!pageFiles(dir).some((file) => file.endsWith(".html")));
  abort.abort();
});

test("main's frames: a cancelled read is 499 and an answer that isn't a canvas is 422", async () => {
  const box = async () => ({ baseUrl: "http://box.test", token: "t" });
  const url = canvasFrameUrl("a1", "canvas-abc123", "light", 1);
  const aborted = new AbortController();
  aborted.abort();
  const cancelled = new CanvasFrames(box, async (_url, init) => {
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    throw new Error("unreachable");
  });
  assert.equal((await cancelled.respond(url, aborted.signal)).status, 499);
  assert.equal((await cancelled.respond(url)).status, 404, "a read that fails");
  const notJson = new CanvasFrames(box, async () => new Response("<html>", { status: 200 }));
  assert.equal((await notJson.respond(url)).status, 422);
  const aDocument = new CanvasFrames(box, async () => Response.json({ page: { kind: "document", storeId: "a1", documentId: "doc-abc123" }, source: "# Hi" }));
  assert.equal((await aDocument.respond(url)).status, 422);
  // Revisions are read once; the newest each time.
  let reads = 0;
  const counted = new CanvasFrames(box, async (asked, init) => {
    reads++;
    assert.equal(init.headers.authorization, "Bearer t");
    assert.ok(asked.startsWith("http://box.test/pages/a1/canvas-abc123"));
    return Response.json({ page: { kind: "canvas", storeId: "a1", canvasId: "canvas-abc123" }, source: "<p>hi</p>" });
  });
  await counted.respond(url);
  await counted.respond(canvasFrameUrl("a1", "canvas-abc123", "dark", 1));
  assert.equal(reads, 1, "the other theme is the same revision");
  await counted.respond(canvasFrameUrl("a1", "canvas-abc123", "dark"));
  await counted.respond(canvasFrameUrl("a1", "canvas-abc123", "dark"));
  assert.equal(reads, 3);
});
