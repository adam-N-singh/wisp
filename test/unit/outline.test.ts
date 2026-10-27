import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type BoxServer, startBoxServer } from "../../src/box-server/server";
import { conversationOutline, OutlineTracker, outlineItems } from "../../src/box/outline";
import { BoxStore } from "../../src/box/store";
import { readSse } from "../../src/shared/gateway-protocol";
import {
  type AgentSummary,
  applyOutlineEvent,
  type ClaudeCodeStatus,
  type ConversationOutlineEvent,
  type ConversationOutlineItem,
  type EventEntry,
  type MessageEntry,
  type NoticeEntry,
  type SendMessageEntry,
  type ToolCallDetail,
  type ToolCallEntry,
  type UserAttachmentEntry,
} from "../../src/shared/model";

const cleanup: Array<() => void> = [];
after(() => {
  for (const fn of cleanup.reverse()) fn();
});

const TOKEN = randomBytes(24).toString("hex");
const NO_CLAUDE = async (): Promise<ClaudeCodeStatus> => ({ executable: null, installed: false, version: null, signedIn: false, authMethod: null, checkedAt: 1 });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wisp-outline-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function agent(id: string): AgentSummary {
  return {
    id, name: "Helper", description: "", path: "", origin: "user", isGroup: false, memberIds: [], isActive: false, createdAt: 1, updatedAt: 1,
    isRunning: false, isComposingMessage: false, awaitingUserResponse: null, hasUnread: false, lastMessageId: null, lastEntry: null,
    notificationsEnabled: true, notifyOnUpdatesEnabled: true, avatarDataUrl: null, instructions: "", model: null, isPinned: false,
  };
}

const base = (id: string, seq: number) => ({ id, seq, turn: 1, step: 1, timestampMs: seq * 1_000 });
const userMessage = (id: string, seq: number, content: string): MessageEntry => ({ ...base(id, seq), step: 0, kind: "message", role: "user", content, isStreaming: false });
const reply = (id: string, seq: number, content: string, extra: Partial<MessageEntry> = {}): MessageEntry => ({ ...base(id, seq), kind: "message", role: "assistant", content, isStreaming: false, ...extra });
const toolCall = (id: string, seq: number, status: ToolCallEntry["status"], output = ""): ToolCallEntry => ({
  ...base(id, seq),
  kind: "tool-call",
  name: "run_shell",
  status,
  summary: "Ran `dir`",
  detail: { callId: "call_1", args: { command: "dir", secret: "ARGUMENT-TEXT" }, output, error: null, image: null, startedAt: 1, finishedAt: status === "pending" ? null : 2 },
});

test("outlineItems: what each kind of entry shows, without tool arguments, output or replay state", () => {
  const thought = reply("t1s1", 2, "Here is the plan.", {
    reasoning: "First I should list the folder.",
    reasoningMs: 2_400,
    replay: { provider: "anthropic", model: "claude-opus-5-5", items: [{ type: "thinking", signature: "SIGNED-STATE" }] },
    reactions: [{ emoji: "👍", by: "user" }],
  });
  const attachment: UserAttachmentEntry = { ...base("t1s3", 3), kind: "user-attachment", file_path: "C:\\uploads\\x\\report.pdf", mime: "application/pdf" };
  const widget: SendMessageEntry = { ...base("t1s5", 5), kind: "send-message", message: { type: "widget", widget: { prompt: "Which folder?", options: [{ label: "Documents" }] } }, respondedValue: "Documents" };
  const notice: NoticeEntry = { ...base("t1s6", 6), kind: "notice", text: "Stopped.", tone: "info" };
  const renamed: EventEntry = { ...base("t1s7", 7), kind: "event", event: { type: "name-changed", from: "A", to: "B" } };

  assert.deepEqual(outlineItems(userMessage("t1s0", 1, "List my files")), [{ id: "t1s0", kind: "user", text: "List my files", timestampMs: 1_000, seq: 1 }]);
  assert.deepEqual(outlineItems(userMessage("t1s0", 1, "  ")), [], "attachments alone: their own items say what was sent");
  assert.deepEqual(outlineItems(thought), [
    { id: "t1s1:thinking", kind: "thinking", text: "First I should list the folder.", durationMs: 2_400, seq: 2 },
    { id: "t1s1", kind: "assistant-text", text: "Here is the plan.", seq: 2 },
  ]);
  assert.deepEqual(outlineItems(reply("t1s1", 2, "", { reasoning: "Still thinking" })), [{ id: "t1s1:thinking", kind: "thinking", text: "Still thinking", seq: 2 }], "thinking still being written has no duration yet");
  assert.deepEqual(outlineItems(reply("t1s1", 2, "")), []);
  assert.deepEqual(outlineItems(attachment), [{ id: "t1s3", kind: "user", text: "Attached report.pdf", timestampMs: 3_000, seq: 3 }]);
  assert.deepEqual(outlineItems(toolCall("t1s4", 4, "done", "TOOL-OUTPUT")), [{ id: "t1s4", kind: "tool-call", name: "run_shell", status: "done", summary: "Ran `dir`", seq: 4 }]);
  assert.deepEqual(outlineItems(widget), [{ id: "t1s5", kind: "send-message", message: widget.message, timestampMs: 5_000, seq: 5 }]);
  assert.deepEqual(outlineItems(notice), []);
  assert.deepEqual(outlineItems(renamed), []);

  const all = JSON.stringify(conversationOutline([userMessage("t1s0", 1, "List my files"), thought, attachment, toolCall("t1s4", 4, "done", "TOOL-OUTPUT"), widget, notice, renamed]));
  for (const hidden of ["SIGNED-STATE", "TOOL-OUTPUT", "ARGUMENT-TEXT", "replay", "detail", "reactions"]) assert.equal(all.includes(hidden), false, hidden);
});

test("OutlineTracker: an item goes out when it is new and when it changes, not when the entry changes elsewhere", () => {
  const tracker = new OutlineTracker();
  const types = (events: ConversationOutlineEvent[]) => events.map((event) => (event.type === "snapshot" ? "snapshot" : `${event.type} ${event.item.id}`));

  assert.deepEqual(types(tracker.changes("a1", userMessage("t1s0", 1, "Hi"))), ["appended t1s0"]);
  assert.deepEqual(types(tracker.changes("a1", { ...userMessage("t1s0", 1, "Hi"), reactions: [{ emoji: "👍", by: "user" }] })), [], "a reaction");

  const streaming = reply("t1s1", 2, "", { reasoning: "Let me", isStreaming: true });
  assert.deepEqual(types(tracker.changes("a1", streaming)), ["appended t1s1:thinking"]);
  assert.deepEqual(types(tracker.changes("a1", { ...streaming, reasoning: "Let me look." })), ["updated t1s1:thinking"]);
  assert.deepEqual(types(tracker.changes("a1", { ...streaming, reasoning: "Let me look.", reasoningMs: 900, content: "Sure" })), ["updated t1s1:thinking", "appended t1s1"]);
  assert.deepEqual(types(tracker.changes("a1", { ...streaming, reasoning: "Let me look.", reasoningMs: 900, content: "Sure", isStreaming: false, feedback: { sentiment: "up", state: "voted", categories: [], votedAt: 1 } })), [], "finishing and a vote");

  assert.deepEqual(types(tracker.changes("a1", toolCall("t1s2", 3, "pending"))), ["appended t1s2"]);
  assert.deepEqual(types(tracker.changes("a1", toolCall("t1s2", 3, "pending", "partial output"))), [], "output streaming in");
  assert.deepEqual(types(tracker.changes("a1", toolCall("t1s2", 3, "done", "all output"))), ["updated t1s2"]);

  const ask = (status: "pending" | "allowed"): SendMessageEntry => ({ ...base("t1s3", 4), kind: "send-message", message: { type: "local-tool-permission", ask: { action: "run-command", target: "dir", requestId: "r1", status } } });
  assert.deepEqual(types(tracker.changes("a1", ask("pending"))), ["appended t1s3"]);
  assert.deepEqual(types(tracker.changes("a1", ask("allowed"))), ["updated t1s3"]);
  assert.deepEqual(types(tracker.changes("a1", { ...base("t1s9", 9), kind: "notice", text: "Stopped." })), []);
  assert.deepEqual(types(tracker.changes("a2", userMessage("t1s0", 1, "Hi"))), ["appended t1s0"], "agents are apart");

  assert.deepEqual(tracker.cleared("a1"), { type: "snapshot", agentId: "a1", items: [] });
  assert.deepEqual(types(tracker.changes("a1", userMessage("t1s0", 1, "Hi"))), ["appended t1s0"], "after a fresh start, a reused id is new again");
});

test("applyOutlineEvent: replaces by id, puts new items in their place in the conversation, takes snapshots whole", () => {
  const item = (id: string, seq: number, kind: "user" | "thinking" | "assistant-text" = "user"): ConversationOutlineItem => (kind === "user" ? { id, kind, text: id, seq } : { id, kind, text: id, seq });
  const appended = (value: ConversationOutlineItem): ConversationOutlineEvent => ({ type: "appended", agentId: "a1", item: value });
  const ids = (items: ConversationOutlineItem[]) => items.map((value) => value.id);

  let items = [appended(item("u1", 1)), appended(item("r2:thinking", 2, "thinking"))].reduce(applyOutlineEvent, [] as ConversationOutlineItem[]);
  // A message sent while the reply is still being written comes before the reply's text does.
  items = applyOutlineEvent(items, appended(item("u3", 3)));
  items = applyOutlineEvent(items, appended(item("r2", 2, "assistant-text")));
  assert.deepEqual(ids(items), ["u1", "r2:thinking", "r2", "u3"]);
  // Thinking that starts after a reply's text still goes before it.
  items = applyOutlineEvent(items, appended(item("r4", 4, "assistant-text")));
  items = applyOutlineEvent(items, appended(item("r4:thinking", 4, "thinking")));
  assert.deepEqual(ids(items), ["u1", "r2:thinking", "r2", "u3", "r4:thinking", "r4"]);

  const textOf = (list: ConversationOutlineItem[], id: string) => {
    const found = list.find((value) => value.id === id);
    return found != null && "text" in found ? found.text : null;
  };
  const before = items;
  items = applyOutlineEvent(items, { type: "updated", agentId: "a1", item: { id: "r2", kind: "assistant-text", text: "longer", seq: 2 } });
  assert.deepEqual(ids(items), ids(before));
  assert.equal(textOf(items, "r2"), "longer");
  assert.equal(textOf(before, "r2"), "r2", "a new list, the old one untouched");
  assert.deepEqual(ids(applyOutlineEvent(items, appended(item("u1", 1)))), ids(items), "an item sent again (a box that restarted) stays one item");
  assert.deepEqual(applyOutlineEvent(items, { type: "snapshot", agentId: "a1", items: [] }), []);
});

// ---- through the gateway, with the mock model -----------------------------------------------

function seeded(): string {
  const dir = tempDir();
  const store = new BoxStore(dir);
  store.putAgent(agent("a1"));
  store.close();
  return dir;
}

async function bootBox(dataDir: string): Promise<BoxServer> {
  const server = await startBoxServer({
    settings: { dataDir, host: "127.0.0.1", port: 0, token: TOKEN, tls: null, behindTlsProxy: false, admin: true, configFile: join(dataDir, "box-config.json"), workspaceRoot: join(dataDir, "workspaces") },
    env: { WISP_BOX_DEFAULT_MODEL: "mock:mock-1" },
    version: "9.9.9-test",
    detectClaudeCode: NO_CLAUDE,
    log: () => undefined,
  });
  cleanup.push(() => server.close());
  return server;
}

const post = (server: BoxServer, method: string, args: unknown) =>
  fetch(`${server.url}/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(args) });

async function api<T = any>(server: BoxServer, method: string, args: unknown): Promise<T> {
  const response = await post(server, method, args);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as T;
}

/** Every "outline" event the box sends from now on. */
async function outlineEvents(server: BoxServer): Promise<ConversationOutlineEvent[]> {
  const abort = new AbortController();
  cleanup.push(() => abort.abort());
  const events: ConversationOutlineEvent[] = [];
  const stream = await fetch(`${server.url}/events`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: abort.signal });
  void (async () => {
    for await (const block of readSse(stream.body!, abort.signal)) {
      if (block.data == null) continue;
      const { channel, payload } = JSON.parse(block.data);
      if (channel === "outline") events.push(payload);
    }
  })().catch(() => undefined);
  return events;
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const outline = (server: BoxServer) => api<ConversationOutlineItem[]>(server, "readOutline", { id: "a1" });
const running = async (server: BoxServer) => (await api<AgentSummary[]>(server, "rosterAgents", {})).find((row) => row.id === "a1")!.isRunning;

/** Sends a prompt and waits until the run is over and the events have caught up with the outline. */
async function turn(server: BoxServer, events: ConversationOutlineEvent[], prompt: string): Promise<ConversationOutlineItem[]> {
  const before = (await outline(server)).length;
  await api(server, "deliverMessage", { agentId: "a1", prompt });
  let items: ConversationOutlineItem[] = [];
  await until(async () => {
    if (await running(server)) return false;
    items = await outline(server);
    return items.length > before && JSON.stringify(events.reduce(applyOutlineEvent, [])) === JSON.stringify(items);
  });
  return items;
}

test("gateway: the outline of a run with tool calls, kept live by outline events, and each call's detail on request", async () => {
  const server = await bootBox(seeded());
  const events = await outlineEvents(server);
  assert.deepEqual(await outline(server), []);

  const items = await turn(server, events, '/tool todo_write {"todos":[{"content":"Write the outline","status":"in_progress"}]}');
  assert.deepEqual(
    items.map((item) => item.kind),
    ["user", "thinking", "assistant-text", "tool-call", "assistant-text"],
  );
  const [question, thinking, started, call, finished] = items;
  assert.equal(question.kind === "user" && question.text, '/tool todo_write {"todos":[{"content":"Write the outline","status":"in_progress"}]}');
  assert.equal(thinking.kind === "thinking" && thinking.text, "The user asked me to run todo_write.");
  assert.equal(thinking.kind === "thinking" && typeof thinking.durationMs, "number");
  assert.equal(started.kind === "assistant-text" && started.text, "Running `todo_write`…");
  assert.deepEqual(call, { id: call.id, kind: "tool-call", name: "todo_write", status: "done", summary: "Updated the todo list (1 items)", seq: call.seq });
  assert.equal(finished.kind === "assistant-text" && finished.text.startsWith("Tool finished."), true);
  // The call went out twice: when it started, and when it finished; the question once.
  const sentOf = (id: string) => events.flatMap((event) => (event.type !== "snapshot" && event.item.id === id ? [event] : []));
  assert.deepEqual(sentOf(call.id).map((event) => `${event.type} ${event.item.kind === "tool-call" ? event.item.status : ""}`), ["appended pending", "updated done"]);
  assert.equal(sentOf(question.id).length, 1);

  const detail = await api<ToolCallDetail>(server, "getToolCallDetail", { id: "a1", entryId: call.id });
  assert.deepEqual(detail.args, { todos: [{ content: "Write the outline", status: "in_progress" }] });
  assert.equal(detail.error, null);
  assert.ok(detail.output.length > 0);
  assert.ok(detail.finishedAt != null);
  assert.equal((await post(server, "getToolCallDetail", { id: "a1", entryId: question.id })).status, 404, "not a tool call");
  assert.equal((await post(server, "getToolCallDetail", { id: "a1", entryId: "t99s0" })).status, 404);
  assert.equal((await post(server, "getToolCallDetail", { id: "a1" })).status, 400);
  assert.equal((await post(server, "readOutline", { id: "nobody" })).status, 404);

  // A reaction changes nothing the outline shows, so no event goes out for it.
  await api(server, "setReaction", { agentId: "a1", entryId: question.id, emoji: "👍" });
  const failed = await turn(server, events, '/tool delete_automation {"id":"nope"}');
  const refused = failed.findLast((item) => item.kind === "tool-call")!;
  assert.equal(refused.kind === "tool-call" && refused.status, "failed");
  assert.match(JSON.stringify(await api<ToolCallDetail>(server, "getToolCallDetail", { id: "a1", entryId: refused.id })), /No automation with that id/);
  assert.equal(sentOf(question.id).length, 1);

  const echoed = await turn(server, events, "/echo Hello **outline**");
  assert.deepEqual(echoed.slice(-2).map((item) => [item.kind, "text" in item ? item.text : null]), [
    ["user", "/echo Hello **outline**"],
    ["assistant-text", "Hello **outline**"],
  ]);

  await api(server, "resetConversation", { id: "a1" });
  await until(() => events.at(-1)?.type === "snapshot");
  assert.deepEqual(events.at(-1), { type: "snapshot", agentId: "a1", items: [] });
  assert.deepEqual(await outline(server), []);
});
