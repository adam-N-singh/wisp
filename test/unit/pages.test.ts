import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type BoxServer, startBoxServer } from "../../src/box-server/server";
import type { ClaudeCodeEngine, EngineHost } from "../../src/box/claude-code";
import { Harness } from "../../src/box/harness";
import { McpManager } from "../../src/box/mcp";
import { toggleReaction } from "../../src/box/message-actions";
import { createDocument, editDocument, PageError, pageEditsSince, readDocument, restoreRevision, revisionList, writePage } from "../../src/box/pages";
import { BoxStore } from "../../src/box/store";
import type { BoxModelConfig } from "../../src/shared/edges";
import { readSse } from "../../src/shared/gateway-protocol";
import type { AgentSummary, ClaudeCodeStatus, MessageEntry, PageMessage, SendMessageEntry, ToolCallEntry, TranscriptEntry } from "../../src/shared/model";
import {
  applyDocumentEdits,
  documentExcerpt,
  documentTitle,
  type LibraryPage,
  MAX_PAGE_REVISIONS,
  MAX_PAGE_SOURCE,
  type PageChangedEvent,
  type PageDocument,
  pageEditsNote,
  pageFileName,
} from "../../src/shared/pages";

const cleanup: Array<() => void> = [];
const stores: BoxStore[] = [];
after(() => {
  stores.forEach((store) => store.close());
  for (const fn of cleanup.reverse()) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wisp-pages-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function agent(id: string): AgentSummary {
  const now = Date.now();
  return {
    id, name: "Writer", description: "", path: "", origin: "user", isGroup: false, memberIds: [], isActive: false, createdAt: now, updatedAt: now,
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

/** Sends a "/tool …" prompt to the mock model and waits for that call to settle and the run to end. */
async function runTool(harness: Harness, store: BoxStore, name: string, args: Record<string, unknown>, nonce: string): Promise<{ call: ToolCallEntry; added: TranscriptEntry[] }> {
  const before = new Set(store.entries("a1").map((entry) => entry.id));
  harness.submitPrompt("a1", prompt(`/tool ${name} ${JSON.stringify(args)}`, nonce));
  await until(() => !harness.isRunning("a1") && store.entries("a1").some((entry) => !before.has(entry.id) && entry.kind === "tool-call" && entry.status !== "pending"));
  const added = store.entries("a1").filter((entry) => !before.has(entry.id));
  return { call: added.find((entry): entry is ToolCallEntry => entry.kind === "tool-call")!, added };
}

const PLAN = "# Trip plan\n\nTwo days in Portugal.\n\n- Day 1: Lisbon\n- Day 2: Sintra\n";

test("page text: the title is the first # heading outside code, excerpts leave marks out, edits match once, and the note names each page", () => {
  assert.equal(documentTitle(PLAN), "Trip plan");
  assert.equal(documentTitle("```md\n# Not this\n```\n\n## Sub\n\n#  The **real**   one #\n"), "The real one");
  assert.equal(documentTitle("# [Linked](https://example.com) `code` _plan_\n"), "Linked code plan");
  assert.equal(documentTitle("Some text\n#hashtag\n## Only a sub-heading\n"), null);
  assert.equal(documentTitle(`# ${"Long ".repeat(60)}`)!.length, 200);

  assert.equal(documentExcerpt(PLAN), "Two days in Portugal. Day 1: Lisbon Day 2: Sintra");
  assert.equal(documentExcerpt("# T\n\n| a | b |\n|---|---|\n| **1** | [two](x) |\n\n```js\nconsole.log(1)\n```\n> quoted\n"), "a · b 1 · two quoted");
  assert.ok(documentExcerpt(`# T\n\n${"word ".repeat(200)}`).endsWith("…"));

  assert.deepEqual(applyDocumentEdits(PLAN, [{ find: "Sintra", replace: "Cascais" }, { find: "Day 2: Cascais", replace: "Day 2: Cascais\n- Day 3: Porto" }]), { source: PLAN.replace("Day 2: Sintra", "Day 2: Cascais\n- Day 3: Porto") });
  assert.match((applyDocumentEdits(PLAN, [{ find: "Madrid", replace: "x" }]) as { error: string }).error, /“Madrid” isn’t in the document\. Read it with read_document/);
  assert.match((applyDocumentEdits(PLAN, [{ find: "Day", replace: "x" }]) as { error: string }).error, /is in the document 2 times\. Quote more/);
  assert.match((applyDocumentEdits(PLAN, [{ find: "Lisbon", replace: "Évora" }, { find: "Lisbon", replace: "x" }]) as { error: string }).error, /^Edit 2: .* after the edits before it/);
  assert.match((applyDocumentEdits(PLAN, [{ find: "", replace: "x" }]) as { error: string }).error, /find is empty/);

  assert.equal(pageEditsNote([]), "");
  assert.equal(pageEditsNote([{ documentId: "doc-aaaaaa", title: "Trip plan", revision: 3 }]), "[I changed this page since my last message: “Trip plan” (doc-aaaaaa, now revision 3). Read a page with read_document before you edit it again.]\n");
  assert.match(pageEditsNote([{ documentId: "doc-aaaaaa", title: "A", revision: 2 }, { documentId: "doc-bbbbbb", title: "B", revision: 5 }]), /^\[I changed these pages since my last message: “A” \(doc-aaaaaa, now revision 2\), “B” \(doc-bbbbbb, now revision 5\)\./);
  assert.deepEqual([pageFileName("Q3: plan / draft?"), pageFileName("  ...  "), pageFileName("Notes.")], ["Q3 plan draft.md", "Document.md", "Notes.md"]);
});

test("page store: revisions keep their Markdown by hash, survive a restart, the oldest go past the limit, and deleting removes what no page names", () => {
  const { dir, store } = setup();
  store.putAgent(agent("a2"));
  const { record } = createDocument(store, "a1", "ignored: the heading wins", PLAN, 1_000);
  assert.match(record.id, /^doc-[0-9a-f]{12}$/);
  assert.deepEqual([record.title, record.createdAt, record.revisions], ["Trip plan", 1_000, [{ n: 1, sha256: sha(PLAN), by: "agent", atMs: 1_000 }]]);
  assert.equal(readFileSync(join(dir, "attachments", "pages", `${sha(PLAN)}.md`), "utf8"), PLAN, "kept in the box's attachment store, not the workspace");
  assert.equal(existsSync(join(dir, "workspaces", "a1")), false);
  // Another agent's page with the same text shares the file.
  const other = createDocument(store, "a2", "Copy", PLAN, 2_000).record;
  assert.deepEqual(pageFiles(dir), [`${sha(PLAN)}.md`]);

  // A restart reads every agent's pages back; a hand-edited index keeps the pages that parse.
  store.close();
  const index = join(dir, "pages", "a1", "index.json");
  const stored = JSON.parse(readFileSync(index, "utf8"));
  stored.pages.push({ id: "../escape", revisions: [{ n: 1, sha256: sha(PLAN), by: "agent", atMs: 1 }] }, { id: "doc-noversions", revisions: [] }, { ...stored.pages[0], id: "doc-badrevision", revisions: [{ n: 1, sha256: "zz", by: "agent" }] });
  writeFileSync(index, JSON.stringify(stored));
  const reopened = setup({ dir }).store;
  assert.deepEqual(reopened.listPages("a1").map((page) => page.id), [record.id]);
  assert.equal(reopened.getPage("a2", other.id)?.title, "Trip plan");

  // Past MAX_PAGE_REVISIONS the oldest revisions go, and their Markdown with them (unless another page names it).
  for (let n = 2; n <= MAX_PAGE_REVISIONS + 2; n++) writePage(reopened, "a1", record.id, `# Trip plan\n\nVersion ${n}\n`, n - 1, 1_000 + n);
  const kept = reopened.getPage("a1", record.id)!;
  assert.equal(kept.revisions.length, MAX_PAGE_REVISIONS);
  assert.deepEqual([kept.revisions[0].n, kept.revisions.at(-1)!.n], [3, MAX_PAGE_REVISIONS + 2]);
  assert.ok(!pageFiles(dir).includes(`${sha("# Trip plan\n\nVersion 2\n")}.md`) && pageFiles(dir).includes(`${sha("# Trip plan\n\nVersion 3\n")}.md`));
  assert.ok(pageFiles(dir).includes(`${sha(PLAN)}.md`), "a2's page still names the first text");
  assert.equal(pageFiles(dir).length, MAX_PAGE_REVISIONS + 1);
  assert.throws(() => readDocument(reopened, "a1", record.id, 2), (error: unknown) => error instanceof PageError && error.code === "missing" && /no longer keeps revision 2/.test(error.message));

  // Deleting a page takes its files; deleting an agent takes its pages.
  reopened.deletePage("a1", record.id);
  assert.deepEqual(pageFiles(dir), [`${sha(PLAN)}.md`]);
  reopened.deleteAgent("a2");
  assert.deepEqual([pageFiles(dir), existsSync(join(dir, "pages", "a2")), reopened.listPages("a2")], [[], false, []]);
});

test("revisions: a change made on an older revision is refused, the same text adds none, restoring adds the old text again, and the title follows the heading", () => {
  const { store } = setup();
  const { record } = createDocument(store, "a1", "Notes", "Plain text, no heading.", 1_000);
  assert.equal(record.title, "Notes", "without a heading the given title stays");
  const saved = writePage(store, "a1", record.id, "# Renamed\r\n\r\nText.", 1, 2_000);
  assert.deepEqual([saved.changed, saved.record.title, saved.source, saved.record.updatedAt], [true, "Renamed", "# Renamed\n\nText.", 2_000]);
  assert.equal(writePage(store, "a1", record.id, "# Renamed\n\nText.", 2, 3_000).changed, false);
  assert.throws(
    () => writePage(store, "a1", record.id, "Mine", 1),
    (error: unknown) => error instanceof PageError && error.code === "stale" && error.message === "“Renamed” changed since you opened it (revision 2 now, not 1).",
  );
  assert.throws(
    () => editDocument(store, "a1", record.id, { markdown: "Theirs", baseRevision: 1 }),
    (error: unknown) => error instanceof PageError && error.code === "stale" && /is at revision 2 now, not 1: the user changed it since\. Read it again with read_document/.test(error.message),
  );
  // A whole new text has to say what it replaces; quoted edits don't.
  assert.throws(
    () => editDocument(store, "a1", record.id, { markdown: "# Blind" }),
    (error: unknown) => error instanceof PageError && error.code === "invalid" && /needs base_revision.* “Renamed” is at revision 2: read it with read_document/.test(error.message),
  );
  // Dropping the heading keeps the last title.
  assert.equal(editDocument(store, "a1", record.id, { edits: [{ find: "# Renamed\n\n", replace: "" }], baseRevision: 2 }, 4_000).record.title, "Renamed");
  const restored = restoreRevision(store, "a1", record.id, 1, 3, 5_000);
  assert.deepEqual([restored.source, restored.record.title, restored.record.revisions.at(-1)], ["Plain text, no heading.", "Renamed", { n: 4, sha256: sha("Plain text, no heading."), by: "user", atMs: 5_000 }]);
  assert.deepEqual(revisionList(restored.record), [{ n: 4, by: "user", atMs: 5_000 }, { n: 3, by: "agent", atMs: 4_000 }, { n: 2, by: "user", atMs: 2_000 }, { n: 1, by: "agent", atMs: 1_000 }]);
  for (const [run, pattern] of [
    [() => writePage(store, "a1", record.id, "  \n ", 4), /empty/],
    [() => writePage(store, "a1", record.id, "x".repeat(MAX_PAGE_SOURCE + 1), 4), /keep it under 262144/],
    [() => editDocument(store, "a1", record.id, { edits: [], markdown: "x" }), /either edits or markdown/],
    [() => createDocument(store, "a1", "   ", "No heading"), /title/],
    [() => readDocument(store, "a1", "doc-missing1"), /isn’t there any more/],
  ] as const) assert.throws(run, pattern);
  // What the user changed since a time: their revisions only.
  assert.deepEqual(pageEditsSince(store, "a1", 4_500), [{ documentId: record.id, title: "Renamed", revision: 4 }]);
  assert.deepEqual(pageEditsSince(store, "a1", 5_000), []);
});

test("tools: create_document posts a page card after its call, edit_document updates that card in place, read_document gives the text; refusals post nothing", async () => {
  const { store, harness, events } = setup();
  const created = await runTool(harness, store, "create_document", { title: "Plan", markdown: PLAN }, "c1");
  assert.equal(created.call.status, "done", created.call.detail?.error ?? "");
  assert.equal(created.call.summary, "Wrote “Trip plan”");
  const [page] = store.listPages("a1");
  assert.equal(created.call.detail!.output, `Created “Trip plan” as document ${page.id} (revision 1). The user sees its card below this step and can open it beside the chat; don't repeat its contents in your reply.`);
  const [card] = cards(created.added);
  assert.ok(card != null && card.seq > created.call.seq && card.step === created.call.step, "the card follows its call in the same step");
  assert.deepEqual(card.message, { type: "page", page: { kind: "document", storeId: "a1", documentId: page.id }, title: "Trip plan", excerpt: "Two days in Portugal. Day 1: Lisbon Day 2: Sintra", revision: 1, updatedBy: "agent", updatedAt: page.updatedAt });
  assert.equal(store.getPage("a1", page.id)?.cardId, card.id);
  assert.deepEqual(toggleReaction(card, "📝", "user"), [{ emoji: "📝", by: "user" }], "the card takes reactions like a message");
  // Read-only to the user while the run that wrote it went on; editable when it ended.
  const [created1, released] = events.filter((event) => event.channel === "page-changed").map((event) => event.payload as PageChangedEvent);
  assert.deepEqual([created1.change, created1.by, created1.page.title, created1.page.revision, created1.editRight], ["created", "agent", "Trip plan", 1, { canEdit: false, reason: "agent-writing" }]);
  assert.deepEqual([released.change, released.page.revision, released.editRight], ["editable", 1, { canEdit: true }]);
  assert.equal(harness.isWritingPage("a1", page.id), false, "the run is over");

  const read = await runTool(harness, store, "read_document", { document_id: page.id }, "c2");
  assert.equal(read.call.summary, "Read “Trip plan”");
  assert.equal(read.call.detail!.output, `“Trip plan” (${page.id}), revision 1, last changed by you:\n\n${PLAN}`);

  const edited = await runTool(harness, store, "edit_document", { document_id: page.id, edits: [{ find: "- Day 2: Sintra", replace: "- Day 2: Sintra\n- Day 3: Porto" }], base_revision: 1 }, "c3");
  assert.equal(edited.call.detail!.output, "Saved “Trip plan” as revision 2. Its card in the chat shows the change.");
  assert.deepEqual(cards(edited.added), [], "no second card");
  const updated = cards(store.entries("a1"))[0];
  assert.deepEqual([updated.id, updated.message.revision, updated.message.excerpt], [card.id, 2, "Two days in Portugal. Day 1: Lisbon Day 2: Sintra Day 3: Porto"]);
  assert.ok(events.some((event) => event.channel === "transcript" && event.payload.type === "updated" && event.payload.entry.id === card.id && event.payload.entry.message.revision === 2));

  for (const [name, args, pattern] of [
    ["edit_document", { document_id: page.id, markdown: "# Old base", base_revision: 1 }, /is at revision 2 now, not 1/],
    ["edit_document", { document_id: page.id, edits: [{ find: "Day", replace: "x" }] }, /3 times/],
    ["edit_document", { document_id: page.id, markdown: "# Blind" }, /Replacing the whole text needs base_revision/],
    ["edit_document", { document_id: "doc-nothere1", markdown: "x" }, /isn’t there any more\. Use a document_id from a document you created/],
    ["create_document", { title: "Huge", markdown: "x".repeat(MAX_PAGE_SOURCE + 1) }, /keep it under/],
    ["create_document", { title: "Blank", markdown: "  " }, /empty/],
  ] as const) {
    const { call, added } = await runTool(harness, store, name, args, `bad-${name}-${JSON.stringify(args).length}`);
    assert.equal(call.status, "failed");
    assert.match(call.detail!.error ?? "", pattern);
    assert.deepEqual(cards(added), []);
  }
  const unchanged = await runTool(harness, store, "edit_document", { document_id: page.id, markdown: readDocument(store, "a1", page.id).source, base_revision: 2 }, "c4");
  assert.equal(unchanged.call.detail!.output, "“Trip plan” already says that (revision 2).");

  // A whole document read back is kept and replayed uncut (the usual limit is 20 000 characters).
  const big = `# Big\n\n${"All work and no play. ".repeat(5_000)}`;
  const bigPage = (await runTool(harness, store, "create_document", { title: "Big", markdown: big }, "c5")).added;
  const bigId = cards(bigPage)[0].message.page.documentId;
  const bigRead = await runTool(harness, store, "read_document", { document_id: bigId }, "c6");
  assert.ok(bigRead.call.detail!.output.endsWith(big));
  assert.ok(JSON.stringify(harness.buildConversation("a1")).includes(JSON.stringify(big).slice(1, -1)));

  // After Start fresh conversation the card is gone: the next edit posts a new one, never touching
  // the entry that took the old card's id.
  harness.startFresh("a1");
  await runTool(harness, store, "read_document", { document_id: page.id }, "c7");
  const occupant = store.entry("a1", card.id);
  assert.ok(occupant?.kind === "message", "the new conversation used the old card's id again");
  const snapshot = JSON.stringify(occupant);
  const reposted = await runTool(harness, store, "edit_document", { document_id: page.id, edits: [{ find: "Two days", replace: "Three days" }] }, "c8");
  const [again] = cards(reposted.added);
  assert.deepEqual([again?.message.revision, again?.message.excerpt.startsWith("Three days"), store.getPage("a1", page.id)?.cardId], [3, true, again?.id]);
  assert.equal(JSON.stringify(store.entry("a1", card.id)), snapshot);
});

test("the user's edits reach the model as a note on their next message; the conversation it already read doesn't change", async () => {
  const { store, harness, events } = setup();
  await runTool(harness, store, "create_document", { title: "Plan", markdown: PLAN }, "n1");
  const [page] = store.listPages("a1");
  const before = JSON.stringify(harness.buildConversation("a1"));

  // The user saves on the page stage (the gateway's writePage does this).
  const saved = writePage(store, "a1", page.id, PLAN.replace("Sintra", "Cascais"), 1);
  harness.pageChanged("a1", saved.record, saved.source, "edited", "user");
  const card = cards(store.entries("a1"))[0];
  assert.deepEqual([card.message.revision, card.message.updatedBy], [2, "user"], "the card shows the user's revision");
  const event = events.filter((candidate) => candidate.channel === "page-changed").pop()!.payload as PageChangedEvent;
  assert.deepEqual([event.change, event.by, event.page.revision, event.page.updatedBy, event.editRight], ["edited", "user", 2, "user", { canEdit: true }]);
  assert.equal(JSON.stringify(harness.buildConversation("a1")), before, "nothing the model already read changed");

  harness.submitPrompt("a1", prompt("Look at what I changed", "n2"));
  await until(() => !harness.isRunning("a1"));
  const sent = store.entries("a1").filter((entry): entry is MessageEntry => entry.kind === "message" && entry.role === "user");
  assert.deepEqual(sent.at(-1)!.pageEdits, [{ documentId: page.id, title: "Trip plan", revision: 2 }]);
  const conversation = harness.buildConversation("a1");
  assert.ok(JSON.stringify(conversation).startsWith(before.slice(0, -1)), "the conversation only grew");
  const user = conversation.filter((item) => item.kind === "user").at(-1)!;
  assert.match(user.kind === "user" && user.parts[0].type === "text" ? user.parts[0].text : "", /^\[Sent [^\]]+\]\n\[I changed this page since my last message: “Trip plan” \(doc-[0-9a-f]+, now revision 2\)\. Read a page with read_document before you edit it again\.\]\nLook at what I changed$/);
  // The mock model read the message without the note.
  assert.match((store.entries("a1").filter((entry) => entry.kind === "message" && entry.role === "assistant").at(-1) as MessageEntry).content, /You said: "Look at what I changed"/);

  // The next message has nothing more to say.
  harness.submitPrompt("a1", prompt("Thanks", "n3"));
  await until(() => !harness.isRunning("a1"));
  assert.equal(store.entries("a1").filter((entry): entry is MessageEntry => entry.kind === "message" && entry.role === "user").at(-1)!.pageEdits, undefined);
});

test("Claude Code agents write documents through the bridge", async () => {
  const outputs: string[] = [];
  let tools: string[] = [];
  let notes = "";
  const engine = {
    runTurn: async (host: EngineHost) => {
      tools = host.appTools().map((tool) => tool.name);
      notes = host.agentNotes();
      const created = await host.runAppTool(1, "create_document", { title: "Bridge", markdown: "# From Claude Code\n\nHello." });
      outputs.push(created.output);
      return { sessionId: "session-1", failed: null, text: "" };
    },
  } as unknown as ClaudeCodeEngine;
  const { store, harness } = setup({ models: { ...MOCK_MODELS, claudeCode: { executable: "claude" } }, claudeCode: engine });
  store.putAgent({ ...store.getAgent("a1")!, model: "claude-code:default" });
  harness.submitPrompt("a1", prompt("write it", "b1"));
  await until(() => outputs.length === 1 && !store.getAgent("a1")!.isRunning);
  assert.ok(["create_document", "read_document", "edit_document"].every((name) => tools.includes(name)));
  assert.match(notes, /create_document, read_document and edit_document keep Markdown documents/);
  assert.match(outputs[0], /^Created “From Claude Code” as document doc-/);
  assert.equal(cards(store.entries("a1"))[0].message.title, "From Claude Code");
});

const TOKEN = randomBytes(24).toString("hex");
const NO_CLAUDE = async (): Promise<ClaudeCodeStatus> => ({ executable: null, installed: false, version: null, signedIn: false, authMethod: null, checkedAt: 1 });

test("gateway: read-only while the agent writes, 409s on a stale revision, the library, revisions, restore, delete, and page-changed events", async () => {
  // A scripted OpenAI-compatible model: it writes a document, then asks a question (so the run stays on), then says Done.
  const seen: string[] = [];
  const model = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const messages: Array<{ role: string; content: string }> = JSON.parse(body).messages;
    const last = messages[messages.length - 1];
    if (last.role === "user") seen.push(last.content);
    const call = (name: string, args: object) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${messages.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
    const chunks: object[] = [];
    if (last.role === "tool" && last.content.startsWith("Created")) chunks.push(call("ask_user", { question: "Anything to add?" }), { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    else if (last.role === "tool") chunks.push({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] });
    else if (last.content.includes("Write the plan")) chunks.push(call("create_document", { title: "Plan", markdown: PLAN }), { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    else chunks.push({ choices: [{ delta: { content: "OK." }, finish_reason: "stop" }] });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => model.close());
  const dir = tempDir();
  const server: BoxServer = await startBoxServer({
    settings: { dataDir: dir, host: "127.0.0.1", port: 0, token: TOKEN, tls: null, behindTlsProxy: false, admin: true, configFile: join(dir, "box-config.json"), workspaceRoot: join(dir, "workspaces") },
    env: { WISP_BOX_DEFAULT_MODEL: "custom:scripted", WISP_BOX_CUSTOM_BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}` },
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

  const { agent: created } = await api<{ agent: AgentSummary }>("addAgent", { name: "Planner", description: "" });
  const id = created.id;
  const row = async () => (await api<AgentSummary[]>("rosterAgents", {})).find((candidate) => candidate.id === id)!;
  const entries = async () => (await api<{ entries: TranscriptEntry[] }>("readTranscriptEnd", { id, limit: 200 })).entries;

  await api("deliverMessage", { agentId: id, prompt: "Write the plan", clientNonce: "g1" });
  await until(async () => (await row()).awaitingUserResponse?.reason === "question");
  const [doc] = await api<LibraryPage[]>("libraryDocuments", { agentId: id });
  const locator = { storeId: id, documentId: doc.page.documentId };
  assert.deepEqual([doc.title, doc.revision, doc.updatedBy, doc.page.kind], ["Trip plan", 1, "agent", "document"]);
  assert.deepEqual(pageEvents.map((event) => [event.change, event.by]), [["created", "agent"]]);

  // While the run that wrote it is on, the page is the agent's.
  assert.deepEqual(await api("pageEditAccess", { locator }), { canEdit: false, reason: "agent-writing" });
  assert.match(await refused("writePage", { locator, source: "# Mine", baseRevision: 1 }, 409, "page/agent-writing"), /Planner is writing this page/);
  const question = (await entries()).find((entry) => entry.kind === "send-message" && entry.message.type === "widget")!;
  assert.deepEqual(pageEvents[0].editRight, { canEdit: false, reason: "agent-writing" });
  await api("answerCard", { agentId: id, entryId: question.id, value: "No" });
  await until(async () => !(await row()).isRunning);
  assert.deepEqual(await api("pageEditAccess", { locator }), { canEdit: true });
  // The run's end says so, with nothing else changed.
  await until(() => pageEvents.length === 2);
  assert.deepEqual([pageEvents[1].change, pageEvents[1].page.revision, pageEvents[1].editRight], ["editable", 1, { canEdit: true }]);

  // The user's save, then a second one on the revision it replaced.
  const mine = PLAN.replace("Sintra", "Cascais");
  const saved = await api<PageDocument>("writePage", { locator, source: mine, baseRevision: 1 });
  assert.deepEqual([saved.revision, saved.sourceRevision, saved.updatedBy, saved.source], [2, 2, "user", mine]);
  assert.match(await refused("writePage", { locator, source: "# Lost update", baseRevision: 1 }, 409, "page/stale"), /changed since you opened it \(revision 2 now, not 1\)/);
  await until(() => pageEvents.length === 3);
  assert.deepEqual([pageEvents[2].change, pageEvents[2].by, pageEvents[2].page.revision, pageEvents[2].editRight], ["edited", "user", 2, { canEdit: true }]);
  const card = (await entries()).find((entry): entry is SendMessageEntry => entry.kind === "send-message" && entry.message.type === "page")!;
  assert.ok(card.message.type === "page" && card.message.revision === 2 && card.message.updatedBy === "user");

  const first = await api<PageDocument>("readPage", { locator, revision: 1 });
  assert.deepEqual([first.source, first.sourceRevision, first.revision], [PLAN, 1, 2]);
  assert.deepEqual((await api("listPageRevisions", { locator })).map((revision: { n: number; by: string }) => [revision.n, revision.by]), [[2, "user"], [1, "agent"]]);

  // The model reads the note at the start of the user's next message.
  await api("deliverMessage", { agentId: id, prompt: "What do you think?", clientNonce: "g2" });
  await until(async () => !(await row()).isRunning && seen.length === 2);
  assert.match(seen[1], new RegExp(`^\\[Sent [^\\]]+\\]\\n\\[I changed this page since my last message: “Trip plan” \\(${doc.page.documentId}, now revision 2\\)\\.`));

  const restored = await api<PageDocument>("restorePageRevision", { locator, revision: 1, baseRevision: 2 });
  assert.deepEqual([restored.revision, restored.source, restored.updatedBy], [3, PLAN, "user"]);
  await refused("restorePageRevision", { locator, revision: 1, baseRevision: 2 }, 409, "page/stale");
  assert.deepEqual((await api<LibraryPage[]>("libraryPages", { includeDocuments: true })).map((page) => page.page.documentId), [doc.page.documentId]);
  assert.deepEqual(await api("libraryPages", { includeDocuments: false }), []);
  await refused("readPage", { locator: { storeId: id, documentId: "../../etc" } }, 400);
  await refused("readPage", { locator: { storeId: "no-such-agent", documentId: doc.page.documentId } }, 404);

  // Deleting the page keeps its card, marked deleted.
  assert.equal(await api("deletePage", { locator }), null);
  await refused("readPage", { locator }, 404, "page/not-found");
  await refused("deletePage", { locator }, 404, "page/not-found");
  const deletedCard = (await entries()).find((entry) => entry.id === card.id);
  assert.ok(deletedCard?.kind === "send-message" && deletedCard.message.type === "page" && deletedCard.message.deleted === true);
  await until(() => pageEvents.at(-1)?.change === "deleted");
  assert.deepEqual(pageFiles(dir), []);

  // Deleting the agent removes its pages.
  await api("deliverMessage", { agentId: id, prompt: "Write the plan", clientNonce: "g3" });
  await until(async () => (await row()).awaitingUserResponse?.reason === "question");
  await api("stopAgentRun", { id });
  await until(async () => !(await row()).isRunning);
  assert.equal(pageFiles(dir).length, 1);
  await api("removeAgents", { ids: [id] });
  assert.deepEqual([pageFiles(dir), existsSync(join(dir, "pages", id))], [[], false]);
  abort.abort();
});
