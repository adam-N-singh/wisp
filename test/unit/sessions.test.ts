// The session layer: an agent has a main conversation ("") and others keyed by session id
// (`group:<roomId>`, later `task:<id>`). The main session must stay byte for byte what it was
// before sessions existed: its files, entry ids, ordered stamps, events and model requests are
// compared with a recording (fixtures/main-session.json, made with RECORD_MAIN_SESSION=1).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startBoxServer } from "../../src/box-server/server";
import type { ClaudeCodeEngine, EngineHost } from "../../src/box/claude-code";
import { Harness } from "../../src/box/harness";
import { McpManager } from "../../src/box/mcp";
import { BoxStore } from "../../src/box/store";
import type { LocalToolDescriptor, ToolResult } from "../../src/shared/gateway-protocol";
import type { AgentSummary, SendMessageEntry } from "../../src/shared/model";
import { type ScriptedReply, type ScriptedRequest, startScriptedModel, until } from "./scripted-model";

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function agent(id: string, name = "Tester"): AgentSummary {
  const now = Date.now();
  return {
    id, name, description: "", path: "", origin: "user", isGroup: false, memberIds: [], isActive: false, createdAt: now, updatedAt: now,
    isRunning: false, isComposingMessage: false, awaitingUserResponse: null, hasUnread: false, lastMessageId: null, lastEntry: null,
    notificationsEnabled: true, notifyOnUpdatesEnabled: true, avatarDataUrl: null, instructions: "", model: null, isPinned: false,
  };
}

const SHELL: LocalToolDescriptor = { name: "run_shell", description: "Run a command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }, permissionId: "shell", readOnly: false };
const MACHINE = { hostname: "test-pc", platform: "linux", osType: "Linux", osRelease: "6.0", workspaceRoot: "/home/test/workspaces" };

/** The main-session script: each user message names what the model does. */
function mainScript(request: ScriptedRequest): ScriptedReply {
  if (request.afterTools) {
    const last = request.messages[request.messages.length - 1];
    return { text: { call_plan: "Planned.", call_run: "Ran it.", call_ask: "You picked." }[String(last.tool_call_id)] ?? "Done." };
  }
  const said = request.lastUser;
  if (said.includes("plan")) return { text: "Planning.", toolCalls: [{ id: "call_plan", name: "todo_write", args: { todos: [{ id: "1", content: "Step one", status: "in_progress" }, { id: "2", content: "Step two", status: "pending" }] } }] };
  if (said.includes("run")) return { toolCalls: [{ id: "call_run", name: "run_shell", args: { command: "echo hi" } }] };
  if (said.includes("ask")) return { toolCalls: [{ id: "call_ask", name: "ask_user", args: { question: "Which one?", options: ["A", "B"] } }] };
  if (said.includes("reply")) return { text: "Replying to that." };
  if (said.includes("Background command")) return { text: "Noted." };
  if (said.includes("again")) return { text: "Fresh start." };
  return { text: "Hi there." };
}

/** Runs one conversation in a1's main session and returns everything it left: files, events and model requests. */
async function recordMainSession() {
  const dir = mkdtempSync(join(tmpdir(), "wisp-main-session-"));
  dirs.push(dir);
  const model = await startScriptedModel(mainScript);
  const store = new BoxStore(dir);
  store.putAgent(agent("a1"));
  const events: Array<{ channel: string; payload: unknown }> = [];
  const harness = new Harness({
    store,
    models: () => model.models,
    resolveDeps: { chatGptToken: async () => "unused" },
    workspaceRoot: () => join(dir, "workspaces"),
    localTools: () => [SHELL],
    localMachine: () => MACHINE,
    callLocalTool: async (call): Promise<ToolResult> =>
      call.approval == null
        ? { kind: "needs-approval", approvalId: "appr-1", ask: { action: "run-command", target: String(call.args.command), title: "Run a command", machineLabel: "Test PC", risk: "mutating", reasons: ["Runs on your PC."], standingGrant: null } }
        : { kind: "ok", output: "hi\n" },
    mcp: new McpManager(() => undefined, () => undefined),
    claudeCode: null,
    cloud: null,
    cloudConfig: () => null,
    emit: (channel, payload) => events.push({ channel, payload: structuredClone(payload) }),
    log: () => undefined,
  });
  const idle = (what: string) => until(() => !harness.isRunning("a1"), 5_000, what);
  const send = (prompt: string, clientNonce: string, extra: { replyToId?: string } = {}) =>
    harness.submitPrompt("a1", { prompt, attachmentPaths: [], attachmentNames: [], clientNonce, source: "user", ...extra });
  const card = (type: "local-tool-permission" | "widget") =>
    store.entries("a1").find((entry): entry is SendMessageEntry => entry.kind === "send-message" && entry.message.type === type && (type === "widget" ? entry.respondedValue == null : entry.message.type === "local-tool-permission" && entry.message.ask.status === "pending"));

  send("hello", "n1");
  await idle("the first reply");
  send("make a plan", "n2");
  await idle("the plan");
  send("run it", "n3");
  await until(() => card("local-tool-permission") != null, 5_000, "the approval card");
  const permission = card("local-tool-permission")!;
  harness.resolvePermission("a1", permission.id, permission.requestId!, "allow-once");
  await idle("the command");
  send("ask me", "n4");
  await until(() => card("widget") != null, 5_000, "the question");
  harness.answerCard("a1", card("widget")!.id, "B");
  await idle("the answer");
  const firstReply = store.entries("a1").find((entry) => entry.kind === "message" && entry.role === "assistant")!;
  harness.annotate("a1", firstReply.id, (entry) => (entry.reactions = [{ emoji: "👍", by: "user" }]));
  harness.annotate("a1", firstReply.id, (entry) => entry.kind === "message" && (entry.feedback = { sentiment: "up", state: "voted", categories: [], votedAt: Date.now() }));
  send("a reply", "n5", { replyToId: firstReply.id });
  await idle("the reply");
  harness.notifyQuietly("a1", "[Background command 1 ended] exit 0", true);
  await idle("the quiet wake");
  const lines = (path: string) =>
    readFileSync(join(dir, path), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const beforeFresh = { transcript: lines("transcripts/a1.jsonl"), todos: JSON.parse(readFileSync(join(dir, "todos/a1.json"), "utf8")) };
  harness.startFresh("a1");
  send("again", "n6");
  await idle("the fresh conversation");
  await new Promise((resolve) => setTimeout(resolve, 80)); // any throttled partial
  harness.shutdown();
  store.close();
  await model.close();

  const read = (path: string) => readFileSync(join(dir, path), "utf8");
  const recording = {
    beforeFresh,
    transcript: lines("transcripts/a1.jsonl"),
    todos: JSON.parse(read("todos/a1.json")),
    agents: JSON.parse(read("agents.json")),
    events,
    requests: model.requests.map((request) => request.body),
  };
  return normalize(recording, dir);
}

/** Times, epochs, the temporary folder and the time zone differ from run to run; everything else must not. */
function normalize(value: unknown, dir: string): unknown {
  const epochs = new Map<string, string>();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const text = (input: string) =>
    input
      .replace(/(?:[0-9a-f]{8}:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (epoch) => {
        if (!epochs.has(epoch)) epochs.set(epoch, `<epoch ${epochs.size + 1}>`);
        return epochs.get(epoch)!;
      })
      .replace(/\[Sent [^\]]+\]/g, "[Sent <time>]")
      .split(dir)
      .join("<dir>")
      .split(dir.replace(/\\/g, "/"))
      .join("<dir>")
      .split(`time zone is ${zone}.`)
      .join("time zone is <zone>.");
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return text(node);
    if (typeof node === "number") return node > 1_500_000_000_000 && node < 2_500_000_000_000 ? "<ms>" : node;
    if (Array.isArray(node)) return node.map(walk);
    if (node != null && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    return node;
  };
  // As clients get it: JSON, where a field set to undefined isn't there.
  return walk(JSON.parse(JSON.stringify(value)));
}

/** A harness on a fresh box folder with agent a1, a local shell that asks for approval, and a scripted model. */
async function sessionsSetup(script: (request: ScriptedRequest) => ScriptedReply | Promise<ScriptedReply>) {
  const dir = mkdtempSync(join(tmpdir(), "wisp-sessions-"));
  dirs.push(dir);
  const model = await startScriptedModel(script);
  const store = new BoxStore(dir);
  store.putAgent(agent("a1"));
  const events: Array<{ channel: string; payload: any }> = [];
  const harness = new Harness({
    store,
    models: () => model.models,
    resolveDeps: { chatGptToken: async () => "unused" },
    workspaceRoot: () => join(dir, "workspaces"),
    localTools: () => [SHELL],
    localMachine: () => MACHINE,
    callLocalTool: async (call): Promise<ToolResult> =>
      call.approval == null
        ? { kind: "needs-approval", approvalId: `appr-${String(call.args.command)}`, ask: { action: "run-command", target: String(call.args.command), title: "Run a command", machineLabel: "Test PC", risk: "mutating", reasons: [], standingGrant: null } }
        : { kind: "ok", output: "ran\n" },
    mcp: new McpManager(() => undefined, () => undefined),
    claudeCode: null,
    cloud: null,
    cloudConfig: () => null,
    emit: (channel, payload) => events.push({ channel, payload: structuredClone(payload) }),
    log: () => undefined,
  });
  after(async () => {
    harness.shutdown();
    store.close();
    await model.close();
  });
  const send = (prompt: string, sessionId?: string) => harness.submitPrompt("a1", { prompt, attachmentPaths: [], attachmentNames: [], clientNonce: null, source: "user", ...(sessionId != null ? { sessionId } : {}) });
  return { dir, store, harness, model, events, send };
}

const ROOM = "group:room-1";

test("two sessions of one agent run at the same time, each in its own transcript and model conversation", async () => {
  let release: () => void = () => undefined;
  const answer = new Promise<void>((resolve) => (release = resolve));
  const { dir, store, harness, model, events, send } = await sessionsSetup(async (request) => {
    await answer;
    return { text: request.lastUser.includes("main") ? "Main answer." : "Room answer." };
  });
  send("in main");
  send("in the room", ROOM);
  await until(() => model.requests.length === 2, 5_000, "both requests");
  // Both are in flight at once, and the row says so.
  const running = store.getAgent("a1")!;
  assert.equal(running.isRunning, true);
  assert.deepEqual(running.runningSessionIds, ["", ROOM]);
  assert.ok(harness.isRunning("a1", "") && harness.isRunning("a1", ROOM));
  release();
  await until(() => !harness.isRunning("a1"), 5_000, "both runs");
  const idle = store.getAgent("a1")!;
  assert.equal(idle.isRunning, false);
  assert.equal(idle.runningSessionIds, undefined);

  // Each request held only its own session's conversation.
  const [mainRequest, roomRequest] = model.requests[0].lastUser.includes("main") ? model.requests : [...model.requests].reverse();
  assert.deepEqual(mainRequest.messages.map((message) => message.role), ["system", "user"]);
  assert.match(mainRequest.lastUser, /in main$/);
  assert.match(roomRequest.lastUser, /in the room$/);
  assert.equal(mainRequest.system, roomRequest.system, "memory, skills and the workspace are the agent's");

  // Separate transcripts: the same entry ids in each, in different files, stamped in different replicas.
  const ids = (sessionId: string) => store.entries("a1", sessionId).map((entry) => `${entry.id}:${entry.kind === "message" ? entry.content : entry.kind}`);
  assert.deepEqual(ids(""), ["t1s0:in main", "t1s1:Main answer."]);
  assert.deepEqual(ids(ROOM), ["t1s0:in the room", "t1s1:Room answer."]);
  assert.match(readFileSync(join(dir, "sessions", "a1", "group~room-1.jsonl"), "utf8"), /Room answer/);
  assert.doesNotMatch(readFileSync(join(dir, "transcripts", "a1.jsonl"), "utf8"), /Room answer/);
  const stamps = events.filter((event) => event.channel === "transcript").map((event) => event.payload.ordered);
  assert.deepEqual([...new Set(stamps.map((stamp) => stamp.replicaKey))].sort(), ["transcript:a1", "transcript:a1\u0000group:room-1"]);
  for (const key of ["transcript:a1", "transcript:a1\u0000group:room-1"]) {
    const sequences = stamps.filter((stamp) => stamp.replicaKey === key).map((stamp) => stamp.sequence);
    assert.deepEqual(sequences, sequences.map((_, index) => index + 1), `${JSON.stringify(key)} counts on its own`);
  }

  // The room turn left the agent's chat alone: its preview, unread count and settlement are the main session's.
  assert.equal(idle.lastMessagePreview, "Main answer.");
  assert.equal(idle.unreadCount, 1);
  // Only the main session tells main to notify, and only it changes the outline.
  assert.equal(events.filter((event) => event.channel === "activity").length, 1);
  const outline = events.filter((event) => event.channel === "outline").map((event) => JSON.stringify(event.payload));
  assert.ok(outline.some((payload) => payload.includes("Main answer.")));
  assert.ok(outline.every((payload) => !payload.includes("Room answer.")));
});

test("approvals, questions and todos belong to their session", async () => {
  const { store, harness, events, send } = await sessionsSetup((request) => {
    if (request.afterTools) return { text: "Done." };
    if (request.lastUser.includes("shell")) return { toolCalls: [{ id: "call_shell", name: "run_shell", args: { command: "room-cmd" } }] };
    if (request.lastUser.includes("ask")) return { toolCalls: [{ id: "call_ask", name: "ask_user", args: { question: "Pick one", options: ["X", "Y"] } }] };
    if (request.lastUser.includes("plan")) return { toolCalls: [{ id: "call_plan", name: "todo_write", args: { todos: [{ id: "1", content: "Room step", status: "in_progress" }] } }] };
    return { text: "Hello." };
  });
  const card = (sessionId: string, type: "local-tool-permission" | "widget") => store.entries("a1", sessionId).find((entry): entry is SendMessageEntry => entry.kind === "send-message" && entry.message.type === type);

  send("run the shell", ROOM);
  await until(() => card(ROOM, "local-tool-permission") != null, 5_000, "the room's approval card");
  const permission = card(ROOM, "local-tool-permission")!;
  const row = store.getAgent("a1")!;
  assert.deepEqual(row.awaitingSessionIds, [ROOM]);
  assert.equal(row.awaitingUserResponse, null, "the agent's chat isn't waiting");
  assert.equal(harness.isAwaiting("a1", ROOM), true);
  assert.throws(() => harness.resolvePermission("a1", permission.id, permission.requestId!, "allow-once"), /no longer pending/, "the main session has no such request");
  harness.resolvePermission("a1", permission.id, permission.requestId!, "allow-once", ROOM);
  await until(() => !harness.isRunning("a1", ROOM), 5_000, "the room's command");
  assert.equal(store.getAgent("a1")!.awaitingSessionIds, undefined);
  const settled = card(ROOM, "local-tool-permission")!.message;
  assert.equal(settled.type === "local-tool-permission" ? settled.ask.status : "", "allowed");
  assert.equal(card("", "local-tool-permission"), undefined);

  // A question in the room isn't answered by a message in the main chat.
  send("ask me", ROOM);
  await until(() => card(ROOM, "widget") != null, 5_000, "the room's question");
  send("hello from main");
  await until(() => !harness.isRunning("a1", ""), 5_000, "the main reply");
  assert.equal(card(ROOM, "widget")!.respondedValue, undefined);
  assert.equal(harness.answerCard("a1", card(ROOM, "widget")!.id, "Y"), false, "not the main session's");
  assert.equal(harness.answerCard("a1", card(ROOM, "widget")!.id, "Y", ROOM), true);
  await until(() => !harness.isRunning("a1", ROOM), 5_000, "the answered room turn");
  assert.equal(card(ROOM, "widget")!.respondedValue, "Y");

  // Todos: the room's own file and event; the main session's list is untouched.
  send("make a plan", ROOM);
  await until(() => store.todos("a1", ROOM).length === 1, 5_000, "the room's todos");
  await until(() => !harness.isRunning("a1", ROOM), 5_000, "the plan");
  assert.deepEqual(store.todos("a1"), []);
  const todoEvents = events.filter((event) => event.channel === "todos");
  assert.deepEqual(todoEvents.map((event) => event.payload.sessionId), [ROOM]);
});

test("interrupting one session leaves the other running; a reload recovers both; deleting a session removes its files", async () => {
  const { dir, store, harness, model, send } = await sessionsSetup((request) => (request.lastUser.includes("slow") ? { hang: true } : { text: "Quick." }));
  send("slow in main");
  send("slow in the room", ROOM);
  await until(() => model.requests.length === 2, 5_000, "both requests");
  assert.equal(harness.interrupt("a1", ROOM), true);
  await until(() => !harness.isRunning("a1", ROOM), 5_000, "the room run to stop");
  assert.equal(harness.isRunning("a1", ""), true, "the main run goes on");
  assert.deepEqual(store.getAgent("a1")!.runningSessionIds, undefined, "only the main session runs, so the row says so plainly");
  assert.equal(store.getAgent("a1")!.isRunning, true);
  assert.ok(store.entries("a1", ROOM).some((entry) => entry.kind === "notice" && entry.text === "Stopped."));
  assert.ok(!store.entries("a1").some((entry) => entry.kind === "notice"));
  harness.interrupt("a1");
  await until(() => !harness.isRunning("a1"), 5_000, "the main run to stop");

  // A pending tool call left in a session by a crash is closed out on the next start.
  store.upsertEntry("a1", { kind: "tool-call", id: "t9s1", seq: 99, turn: 9, step: 1, timestampMs: 1, name: "run_shell", status: "pending", detail: { callId: "c", args: {}, output: "", error: null, image: null, startedAt: 1, finishedAt: null } }, true, ROOM);
  store.close();
  const reloaded = new BoxStore(dir);
  assert.deepEqual(reloaded.sessionIds("a1"), [ROOM]);
  new Harness({ store: reloaded, models: () => model.models, resolveDeps: { chatGptToken: async () => "" }, workspaceRoot: () => dir, localTools: () => [], callLocalTool: async () => ({ kind: "error", message: "" }), mcp: new McpManager(() => undefined, () => undefined), claudeCode: null, cloud: null, cloudConfig: () => null, emit: () => undefined, log: () => undefined });
  const recovered = reloaded.entry("a1", "t9s1", ROOM);
  assert.equal(recovered?.kind === "tool-call" ? recovered.status : "", "failed");

  reloaded.setTodos("a1", [{ id: "1", content: "x", status: "pending", updatedAt: 1 }], ROOM);
  reloaded.setSessionState("a1", ROOM, { claudeCodeSession: { id: "cc-1", lastUserSeq: 3 } });
  assert.equal(reloaded.sessionState("a1", ROOM).claudeCodeSession?.id, "cc-1");
  reloaded.deleteSession("a1", ROOM);
  assert.deepEqual(reloaded.sessionIds("a1"), []);
  assert.deepEqual(reloaded.todos("a1", ROOM), []);
  assert.deepEqual(reloaded.sessionState("a1", ROOM), {});
  assert.throws(() => reloaded.entries("a1", "group:../x"), /Bad session/);
  reloaded.close();
});

test("the gateway carries sessionId to a session's transcript, its cards and its reactions", async () => {
  const model = await startScriptedModel((request) => (request.afterTools ? { text: "Done." } : request.lastUser.includes("ask") ? { toolCalls: [{ id: "call_ask", name: "ask_user", args: { question: "Sure?", options: ["Yes"] } }] } : { text: "Hi." }));
  after(() => model.close());
  const dataDir = mkdtempSync(join(tmpdir(), "wisp-sessions-gateway-"));
  dirs.push(dataDir);
  const token = "t".repeat(48);
  const server = await startBoxServer({
    settings: { dataDir, host: "127.0.0.1", port: 0, token, tls: null, behindTlsProxy: false, admin: true, configFile: join(dataDir, "box-config.json"), workspaceRoot: join(dataDir, "workspaces") },
    env: { WISP_BOX_DEFAULT_MODEL: "custom:scripted", WISP_BOX_CUSTOM_BASE_URL: model.baseUrl },
    version: "9.9.9-test",
    detectClaudeCode: async () => ({ executable: null, installed: false, version: null, signedIn: false, authMethod: null, checkedAt: 1 }),
    log: () => undefined,
  });
  after(() => server.close());
  const post = (method: string, args: unknown) => fetch(`${server.url}/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args) });
  const api = async <T = any>(method: string, args: unknown): Promise<T> => {
    const response = await post(method, args);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as T;
  };
  const { agent: created } = await api<{ agent: AgentSummary }>("addAgent", { name: "Gatekeeper", description: "" });
  const id = created.id;
  // A thread's session, which (unlike a group chat member's) takes messages from the gateway.
  const SESSION = "task:t1";
  await api("deliverMessage", { agentId: id, prompt: "ask in the thread", sessionId: SESSION, clientNonce: "s1" });
  const tail = () => api<{ entries: any[]; ordered: { replicaKey: string } }>("readTranscriptEnd", { id, limit: 50, sessionId: SESSION });
  let page = await tail();
  for (let tries = 0; tries < 200 && !page.entries.some((entry) => entry.kind === "send-message"); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    page = await tail();
  }
  assert.equal(page.ordered.replicaKey, `transcript:${id}\u0000${SESSION}`);
  const card = page.entries.find((entry) => entry.kind === "send-message");
  assert.ok(card != null);
  assert.equal((await api("readTranscriptEnd", { id, limit: 50 })).entries.length, 0, "the main session is empty");
  assert.deepEqual(await api("answerCard", { agentId: id, entryId: card.id, value: "Yes" }), { accepted: false });
  assert.deepEqual(await api("answerCard", { agentId: id, entryId: card.id, value: "Yes", sessionId: SESSION }), { accepted: true });
  for (let tries = 0; tries < 200 && (await api<AgentSummary[]>("rosterAgents", {})).find((row) => row.id === id)!.isRunning; tries++) await new Promise((resolve) => setTimeout(resolve, 20));

  const reply = (await tail()).entries.findLast((entry) => entry.kind === "message" && entry.role === "assistant");
  // A reaction or vote with the session's id lands on that session's entry; without it, the main session has no such entry.
  assert.equal((await post("setReaction", { agentId: id, entryId: reply.id, emoji: "👍" })).status, 404);
  await api("setReaction", { agentId: id, entryId: reply.id, emoji: "👍", sessionId: SESSION });
  await api("rateReply", { agentId: id, entryId: reply.id, action: "up", sessionId: SESSION });
  const voted = (await tail()).entries.find((entry) => entry.id === reply.id);
  assert.deepEqual(voted.reactions, [{ emoji: "👍", by: "user" }]);
  assert.equal(voted.feedback.sentiment, "up");
  assert.equal((await post("setReaction", { agentId: id, entryId: reply.id, emoji: "👍", sessionId: "group:../../x" })).status, 400, "only session ids");
  assert.deepEqual(await api("readAgentTodos", { id, sessionId: SESSION }), []);
});

test("Start fresh while a run is under way: what it still writes goes nowhere, and a prompt sent at once gets a run of its own", async () => {
  const { store, harness, model, send } = await sessionsSetup((request) => (request.lastUser.includes("slow") ? { hang: true } : { text: "Fresh answer." }));
  for (const sessionId of ["", ROOM]) {
    send("slow one", sessionId || undefined);
    await until(() => model.requests.some((request) => request.lastUser.includes("slow") && harness.isRunning("a1", sessionId)), 5_000, "the run");
    harness.startFresh("a1", sessionId);
    // While the stopped run still winds down.
    send("right after", sessionId || undefined);
    await until(() => !harness.isRunning("a1", sessionId) && store.entries("a1", sessionId).length === 2, 5_000, "the answer");
    await new Promise((resolve) => setTimeout(resolve, 80)); // any throttled partial
    const left = store.entries("a1", sessionId).map((entry) => `${entry.kind}:${entry.kind === "message" ? entry.content.replace(/^\[Sent [^\]]*\]\n/, "") : ""}`);
    assert.deepEqual(left, ["message:right after", "message:Fresh answer."], `no "Stopped." from the old run in ${JSON.stringify(sessionId)}`);
  }
  assert.equal(store.getAgent("a1")!.lastMessagePreview, "Fresh answer.", "the stopped run previews nothing");
});

test("Start fresh while a Claude Code turn is under way: the old Claude Code session isn't written back, and the next turn starts a new one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wisp-sessions-claude-"));
  dirs.push(dir);
  const store = new BoxStore(dir);
  store.putAgent(agent("a1"));
  const turns: Array<{ prompt: string; sessionId: string | null }> = [];
  // A fake engine: a "slow" turn waits to be stopped, then hands back the session it was in, as the CLI does.
  const engine = {
    runTurn: async (host: EngineHost, _model: unknown, input: { prompt: string; sessionId: string | null }) => {
      turns.push(input);
      if (input.prompt.includes("slow")) {
        await new Promise((resolve) => (host.signal.aborted ? resolve(null) : host.signal.addEventListener("abort", () => resolve(null))));
        return { sessionId: "cc-old", failed: null, text: "" };
      }
      return { sessionId: `cc-${turns.length}`, failed: null, text: "" };
    },
  } as unknown as ClaudeCodeEngine;
  const harness = new Harness({
    store,
    models: () => ({ defaultModel: { provider: "claude-code", model: "default" }, reasoningEffort: "default", temperature: null, xai: null, openai: null, anthropic: null, custom: null, claudeCode: { executable: "claude" } }),
    resolveDeps: { chatGptToken: async () => "unused" },
    workspaceRoot: () => join(dir, "workspaces"),
    localTools: () => [],
    callLocalTool: async () => ({ kind: "error", message: "none" }),
    mcp: new McpManager(() => undefined, () => undefined),
    claudeCode: engine,
    cloud: null,
    cloudConfig: () => null,
    emit: () => undefined,
    log: () => undefined,
  });
  after(() => {
    harness.shutdown();
    store.close();
  });
  const send = (prompt: string, sessionId: string) => harness.submitPrompt("a1", { prompt, attachmentPaths: [], attachmentNames: [], clientNonce: null, source: "user", ...(sessionId !== "" ? { sessionId } : {}) });
  const claudeSession = (sessionId: string) => (sessionId === "" ? store.getAgent("a1")!.claudeCodeSession : store.sessionState("a1", sessionId).claudeCodeSession) ?? null;
  for (const sessionId of ["", ROOM]) {
    const before = turns.length;
    send("slow one", sessionId);
    await until(() => turns.length === before + 1, 5_000, "the slow turn");
    harness.startFresh("a1", sessionId);
    await until(() => !harness.isRunning("a1", sessionId), 5_000, "the stopped turn");
    assert.equal(claudeSession(sessionId), null, `the cleared ${JSON.stringify(sessionId)} doesn't take the old Claude Code session back`);
    send("again", sessionId);
    await until(() => turns.length === before + 2 && !harness.isRunning("a1", sessionId), 5_000, "the next turn");
    assert.equal(turns[before + 1].sessionId, null, "a new Claude Code session");
    assert.match(turns[before + 1].prompt, /again$/);
    assert.equal(claudeSession(sessionId)?.id, `cc-${before + 2}`);
  }
});

test("the main session is unchanged: files, entry ids, stamps, events and model requests match the recording", async () => {
  const recording = await recordMainSession();
  const fixture = join(process.cwd(), "test", "unit", "fixtures", "main-session.json");
  if (process.env.RECORD_MAIN_SESSION === "1") {
    writeFileSync(fixture, `${JSON.stringify(recording, null, 1)}\n`);
    return;
  }
  const expected = JSON.parse(readFileSync(fixture, "utf8"));
  assert.deepEqual(recording, expected);
  // The same conversation twice gives the same recording: nothing in it depends on timing.
  assert.deepEqual(await recordMainSession(), expected);
});
