// Group chats (src/box/rooms.ts): who takes a turn, passes, bot hops and the post limit, winding
// down, the deadline, Stop, approvals reaching the member that asked, and the gateway's
// makeGroupChat / changeGroupMembers. Members run on a scripted model that answers by its own name.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startBoxServer } from "../../src/box-server/server";
import { AsyncTasks } from "../../src/box/async-tasks";
import { Harness, type LocalToolCall } from "../../src/box/harness";
import { McpManager } from "../../src/box/mcp";
import { streamMock } from "../../src/box/models/mock";
import { writePage } from "../../src/box/pages";
import { MAX_BOT_HOPS, mentionedMembers, Rooms } from "../../src/box/rooms";
import { BoxStore } from "../../src/box/store";
import type { BackgroundShellStatus } from "../../src/shared/background-shell";
import type { BoxModelConfig } from "../../src/shared/edges";
import type { LocalToolDescriptor, ToolResult } from "../../src/shared/gateway-protocol";
import { type AgentSummary, groupSessionId, MAIN_SESSION, type MessageEntry, type PageMessage, type SendMessageEntry, type TranscriptEntry } from "../../src/shared/model";
import { type ScriptedReply, type ScriptedRequest, startScriptedModel, until } from "./scripted-model";

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function agent(id: string, name: string, description = ""): AgentSummary {
  const now = Date.now();
  return {
    id, name, description, path: "", origin: "user", isGroup: false, memberIds: [], isActive: false, createdAt: now, updatedAt: now,
    isRunning: false, isComposingMessage: false, awaitingUserResponse: null, hasUnread: false, lastMessageId: null, lastEntry: null,
    notificationsEnabled: true, notifyOnUpdatesEnabled: true, avatarDataUrl: null, instructions: "", model: null, isPinned: false,
  };
}

const SHELL: LocalToolDescriptor = { name: "run_shell", description: "Run a command.", parameters: { type: "object", properties: { command: { type: "string" } } }, permissionId: "shell", readOnly: false };
const MOCK: BoxModelConfig = { defaultModel: { provider: "mock", model: "mock-1" }, reasoningEffort: "default", temperature: null, xai: null, openai: null, anthropic: null, custom: null, claudeCode: null };

/** The member a request is for, from its system prompt. */
const who = (request: ScriptedRequest) => /^You are (.+?), an AI agent/m.exec(request.system)?.[1] ?? "?";

type Script = (request: ScriptedRequest, name: string) => ScriptedReply | Promise<ScriptedReply>;

async function roomSetup(
  script: Script | null,
  options: { members?: Array<[string, string, string?]>; deadlineMs?: number; callLocalTool?: (call: LocalToolCall) => ToolResult; asyncTasks?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "wisp-rooms-"));
  dirs.push(dir);
  const model = script != null ? await startScriptedModel((request) => script(request, who(request))) : null;
  const store = new BoxStore(dir);
  const members = options.members ?? [["scout", "Scout", "Finds things."], ["atlas", "Atlas", "Draws maps."]];
  for (const [id, name, description] of members) store.putAgent(agent(id, name, description));
  const events: Array<{ channel: string; payload: any }> = [];
  // Background commands as the box keeps them: the one that ends tells the session that started it.
  const tasks =
    options.asyncTasks === true
      ? new AsyncTasks({
          store,
          emit: () => undefined,
          patchAgent: (agentId, patch) => harness.patchAgent(agentId, patch),
          ended: (record, text, wake) => harness.notifyQuietly(record.agentId, text, wake, record.sessionId ?? MAIN_SESSION),
          controlLocal: async () => ({ kind: "error", message: "no daemon" }),
          localHost: () => "test-pc",
          cloud: null,
          log: () => undefined,
        })
      : undefined;
  const harness: Harness = new Harness({
    store,
    models: () => model?.models ?? MOCK,
    resolveDeps: { chatGptToken: async () => "unused" },
    workspaceRoot: () => join(dir, "workspaces"),
    localTools: () => [SHELL],
    localMachine: () => ({ hostname: "test-pc", platform: "linux", osType: "Linux", osRelease: "6.0", workspaceRoot: "/home/test/workspaces" }),
    callLocalTool: async (call): Promise<ToolResult> =>
      options.callLocalTool != null
        ? options.callLocalTool(call)
        : call.approval == null
          ? { kind: "needs-approval", approvalId: `appr-${call.agentId}`, ask: { action: "run-command", target: String(call.args.command), title: "Run a command", machineLabel: "Test PC", risk: "mutating", reasons: [], standingGrant: null } }
          : { kind: "ok", output: "ran\n" },
    asyncTasks: tasks,
    mcp: new McpManager(() => undefined, () => undefined),
    claudeCode: null,
    cloud: null,
    cloudConfig: () => null,
    sessions: {
      instructions: (agentId, sessionId) => rooms.hooks.instructions?.(agentId, sessionId) ?? null,
      live: (agentId, sessionId, live) => rooms.hooks.live?.(agentId, sessionId, live),
      entry: (agentId, sessionId, entry) => rooms.hooks.entry?.(agentId, sessionId, entry),
      activity: (agentId, sessionId, payload) => rooms.hooks.activity?.(agentId, sessionId, payload),
      wake: (agentId, sessionId) => rooms.hooks.wake?.(agentId, sessionId) ?? false,
    },
    emit: (channel, payload) => events.push({ channel, payload: structuredClone(payload) }),
    log: () => undefined,
  });
  const rooms: Rooms = new Rooms({
    store,
    harness: () => harness,
    newRow: (input) => ({ ...agent(randomUUID(), input.name), description: input.description }),
    emit: (channel, payload) => events.push({ channel, payload: structuredClone(payload) }),
    log: () => undefined,
    deadlineMs: options.deadlineMs,
  });
  after(async () => {
    tasks?.stop();
    rooms.shutdown();
    harness.shutdown();
    store.close();
    await model?.close();
  });
  const room = rooms.makeGroupChat({ name: "Team", memberAgentIds: members.map(([id]) => id) });
  const name = (id: string) => store.getAgent(id)?.name ?? id;
  return {
    dir,
    store,
    harness,
    rooms,
    model,
    events,
    room,
    tasks,
    /** The room's entries in order: "user:…", "assistant:…" (a member's post), "notice:…", or the kind. */
    lines: () =>
      store.entries(room.id).map((entry) => (entry.kind === "message" ? `${entry.role}:${entry.content}` : entry.kind === "notice" ? `notice:${entry.text}` : entry.kind === "send-message" ? `card:${entry.message.type}` : entry.kind)),
    say: (prompt: string) => rooms.post(room.id, { prompt, clientNonce: null }),
    settled: (what = "the round") => until(() => !rooms.isRunning(room.id), 10_000, what),
    /** The room's posts, as "Name: text". */
    posts: () => store.entries(room.id).flatMap((entry) => (entry.kind === "message" && entry.role === "assistant" ? [`${entry.fromAgent?.name}: ${entry.content}`] : [])),
    /** The latest round's turns, as "Name@hop OUTCOME". */
    turns: () => (store.getAgent(room.id)!.groupTurns ?? []).map((turn) => `${name(turn.memberId)}@${turn.hop} ${turn.outcome ?? "-"}`),
    /** The requests one member's room session made. */
    asked: (memberName: string) => (model?.requests ?? []).filter((request) => who(request) === memberName),
  };
}

test("mentions pick who replies, in the order mentioned; @everyone and no mention give every member a turn; a pass isn't posted", async () => {
  const { say, settled, posts, turns, asked } = await roomSetup((request, name) => (name === "Echo" && request.lastUser.includes("No mentions") ? { text: "[pass]" } : { text: `${name} says hi.` }), {
    members: [["scout", "Scout"], ["atlas", "Atlas"], ["echo", "Echo"]],
  });
  say("@Atlas and @scout, what do you think?");
  await settled();
  assert.deepEqual(posts(), ["Atlas: Atlas says hi.", "Scout: Scout says hi."]);
  assert.deepEqual(turns(), ["Atlas@0 SENT", "Scout@0 SENT"]);
  assert.equal(asked("Echo").length, 0, "a member nobody mentioned isn't asked");

  say("@everyone hello");
  await settled();
  assert.deepEqual(turns(), ["Scout@0 SENT", "Atlas@0 SENT", "Echo@0 SENT"], "@everyone: the room's order");

  say("No mentions this time.");
  await settled();
  assert.deepEqual(turns(), ["Scout@0 SENT", "Atlas@0 SENT", "Echo@0 PASS"]);
  assert.equal(posts().filter((post) => post.startsWith("Echo:")).length, 1, "Echo's pass wasn't posted");
  assert.equal(posts().some((post) => post.includes("[pass]")), false);

  assert.deepEqual(mentionedMembers("mail me@scout.example, then @Atlas.", [{ id: "s", name: "Scout" }, { id: "a", name: "Atlas" }]), ["a"], "an email address isn't a mention");
  assert.deepEqual(mentionedMembers("@Research Bot and @Research", [{ id: "r", name: "Research" }, { id: "rb", name: "Research Bot" }]), ["rb", "r"], "the longer name first");
  assert.deepEqual(mentionedMembers("@Scouting", [{ id: "s", name: "Scout" }]), []);
});

test("each member's room session gets the room section and, per turn, one message with the new messages labelled by author", async () => {
  const { say, settled, asked, store, room } = await roomSetup((_request, name) => ({ text: `${name} here.` }));
  say("Hello team");
  await settled();
  const [first] = asked("Atlas");
  assert.match(first.system, /## Group chat\nYou're in a group chat called “Team” with the user and another bot:\n- Scout: Finds things\./);
  assert.match(first.system, /@mention it by name/);
  assert.match(first.system, /reply with exactly \[pass\]/);
  assert.doesNotMatch(first.system, /Atlas: Draws maps/, "not itself");
  assert.match(first.lastUser, /\[Group chat “Team”: new messages\]\nUser: Hello team\nScout: Scout here\.$/);

  say("Second message");
  await settled();
  const [, second] = asked("Atlas");
  assert.match(second.lastUser, /\[Group chat “Team”: new messages\]\nUser: Second message\nScout: Scout here\.$/, "only what's new, and never its own posts");
  // One user item per turn; the member's provider sees its own earlier replies as its own.
  assert.deepEqual(second.messages.map((message) => message.role), ["system", "user", "assistant", "user"]);
  assert.equal(second.system, first.system, "the system prompt stays the same while the room does");

  // The members' own chats are untouched.
  for (const id of ["scout", "atlas"]) {
    assert.equal(store.entries(id).length, 0);
    assert.equal(store.getAgent(id)!.lastMessagePreview, undefined);
    assert.ok(store.entries(id, groupSessionId(room.id)).length > 0);
  }
});

test("a member's @mention gives another a turn, up to 3 bot hops; the last hop is told it's winding down and its mentions start nothing", async () => {
  const next: Record<string, string> = { Scout: "Atlas", Atlas: "Echo", Echo: "Scout" };
  const { say, settled, turns, asked } = await roomSetup((_request, name) => ({ text: `Over to you, @${next[name]}.` }), { members: [["scout", "Scout"], ["atlas", "Atlas"], ["echo", "Echo"]] });
  say("@Scout start us off");
  await settled();
  assert.equal(MAX_BOT_HOPS, 3);
  assert.deepEqual(turns(), ["Scout@0 SENT", "Atlas@1 SENT", "Echo@2 SENT", "Scout@3 SENT"]);
  const scoutAsks = asked("Scout");
  assert.doesNotMatch(scoutAsks[0].lastUser, /last bot turn/);
  assert.match(scoutAsks[1].lastUser, /\[This is the last bot turn for now: answer without @mentioning anyone\.\]$/);
  assert.doesNotMatch(asked("Echo")[0].lastUser, /last bot turn/);
});

test("posts stop at twice the member count per message; the last post is told it's winding down; a newer message skips waiting turns", async () => {
  // Each mentions everyone else, so turns keep coming until the post limit.
  const { say, settled, turns, posts, asked, rooms, room } = await roomSetup((request, name) => {
    if (request.lastUser.includes("slow")) return { text: `${name} took a while.`, delayMs: 300 };
    return { text: name === "Scout" ? "@Atlas @Echo?" : name === "Atlas" ? "@Scout @Echo?" : "@Scout @Atlas?" };
  }, { members: [["scout", "Scout"], ["atlas", "Atlas"], ["echo", "Echo"]] });
  say("Go");
  await settled();
  assert.equal(posts().length, 6, "2 × 3 members");
  assert.deepEqual(turns(), ["Scout@0 SENT", "Atlas@0 SENT", "Scout@1 SENT", "Atlas@2 SENT", "Scout@3 SENT", "Echo@0 SENT"]);
  assert.match(asked("Echo")[0].lastUser, /last bot turn/, "the sixth post is the last");

  // A message sent while a round runs skips its waiting turns; the next round answers it.
  say("slow one");
  await until(() => (rooms as any).rounds.get(room.id)?.active != null, 5_000, "the first turn");
  say("@Atlas and a newer one");
  await until(() => turns().length === 1 && turns()[0] === "Atlas@0 SENT" && !rooms.isRunning(room.id), 10_000, "the second round");
  const atlasLast = asked("Atlas").at(-1)!;
  assert.match(atlasLast.lastUser, /\nUser: slow one\nUser: @Atlas and a newer one\nScout: Scout took a while\.$/, "in the order the room got them");
});

test("a turn past its deadline times out, but waiting for the user's approval doesn't count", async () => {
  const { say, settled, turns, posts, store, room, harness } = await roomSetup(
    (request, name) => {
      if (name === "Scout") return request.lastUser.includes("hang") ? { hang: true } : { text: "Scout here." };
      if (request.afterTools) return { text: "Atlas ran it." };
      return request.lastUser.includes("run") ? { toolCalls: [{ id: "call_run", name: "run_shell", args: { command: "make" } }] } : { text: "Atlas here." };
    },
    { deadlineMs: 250 },
  );
  say("hang on");
  await settled();
  assert.deepEqual(turns(), ["Scout@0 TIMEOUT", "Atlas@0 SENT"]);
  assert.ok(store.entries(room.id).some((entry) => entry.kind === "notice" && entry.text === "Scout didn’t answer in time."));

  say("@Atlas run it");
  const copy = () => store.entries(room.id).find((entry): entry is SendMessageEntry => entry.kind === "send-message" && entry.forwarded != null);
  await until(() => copy() != null, 5_000, "the approval card in the room");
  await new Promise((resolve) => setTimeout(resolve, 600)); // well past the deadline, while it waits for the user
  const card = copy()!;
  harness.resolvePermission("atlas", card.forwarded!.entryId, card.requestId!, "allow-once", card.forwarded!.sessionId);
  await settled();
  assert.deepEqual(turns(), ["Atlas@0 SENT"]);
  assert.equal(posts().at(-1), "Atlas: Atlas ran it.");
});

test("Stop interrupts every member's turn in the room", async () => {
  const { say, settled, turns, store, room, rooms, harness, posts } = await roomSetup(() => ({ hang: true }));
  say("Anyone there?");
  await until(() => harness.isRunning("scout", groupSessionId(room.id)), 5_000, "Scout's turn");
  assert.equal(store.getAgent(room.id)!.isRunning, true);
  assert.equal(store.getAgent(room.id)!.activeGroupMemberId, "scout");
  assert.equal(rooms.stop(room.id), true);
  await settled();
  assert.deepEqual(turns(), ["Scout@0 CANCELLED", "Atlas@0 CANCELLED"]);
  assert.equal(harness.isRunning("scout") || harness.isRunning("atlas"), false);
  const row = store.getAgent(room.id)!;
  assert.equal(row.isRunning, false);
  assert.equal(row.activeGroupMemberId, undefined);
  assert.equal(row.lastTurnSettlement?.outcome, "cancelled");
  assert.ok(store.entries(room.id).some((entry) => entry.kind === "notice" && entry.text === "Stopped."));
  assert.deepEqual(posts(), []);
  assert.equal(rooms.stop(room.id), false, "nothing left to stop");
});

test("a member's approval and question show in the room, marked with who asked, and resolve in that member's session", async () => {
  const { say, settled, store, room, harness, events, posts } = await roomSetup((request, name) => {
    if (request.afterTools) return { text: `${name} is done.` };
    if (name === "Atlas" && request.lastUser.includes("shell")) return { toolCalls: [{ id: "call_shell", name: "run_shell", args: { command: "rm -rf build" } }] };
    if (name === "Atlas" && request.lastUser.includes("ask")) return { toolCalls: [{ id: "call_ask", name: "ask_user", args: { question: "Which build?", options: ["Debug", "Release"] } }] };
    return { text: "[pass]" };
  });
  const sessionId = groupSessionId(room.id);
  const copies = () => store.entries(room.id).filter((entry): entry is SendMessageEntry => entry.kind === "send-message");

  say("Atlas, use the shell");
  await until(() => copies().length === 1, 5_000, "the approval copy");
  const [approval] = copies();
  assert.deepEqual(approval.fromAgent, { id: "atlas", name: "Atlas", kind: "agent" });
  assert.equal(approval.forwarded?.agentId, "atlas");
  assert.equal(approval.forwarded?.sessionId, sessionId);
  const original = store.entry("atlas", approval.forwarded!.entryId, sessionId) as SendMessageEntry;
  assert.equal(original.message.type, "local-tool-permission");
  assert.equal(original.requestId, approval.requestId);
  // The room waits for the user on Atlas's behalf; the agent's own chat doesn't.
  await until(() => store.getAgent(room.id)!.awaitingUserResponse != null, 5_000, "the room to wait");
  assert.equal(store.getAgent(room.id)!.awaitingUserResponse?.reason, "approval");
  assert.match(store.getAgent(room.id)!.awaitingUserResponse?.reasonCopy ?? "", /^Atlas: /);
  assert.equal(store.getAgent("atlas")!.awaitingUserResponse, null);
  assert.deepEqual(store.getAgent("atlas")!.awaitingSessionIds, [sessionId]);
  assert.ok(events.some((event) => event.channel === "activity" && event.payload.agentId === room.id && event.payload.kind === "needs-approval" && event.payload.preview.startsWith("Atlas: ")));
  assert.ok(!events.some((event) => event.channel === "activity" && event.payload.agentId === "atlas"), "the member's chat doesn't notify");
  assert.throws(() => harness.resolvePermission("scout", approval.forwarded!.entryId, approval.requestId!, "allow-once", sessionId), /no longer pending/, "only the member that asked");
  harness.resolvePermission("atlas", approval.forwarded!.entryId, approval.requestId!, "allow-once", sessionId);
  await settled();
  const settledCopy = store.entry(room.id, approval.id) as SendMessageEntry;
  assert.equal(settledCopy.message.type === "local-tool-permission" ? settledCopy.message.ask.status : "", "allowed", "the copy follows the member's card");
  assert.ok(posts().includes("Atlas: Atlas is done."));

  say("Atlas, ask me");
  await until(() => copies().length === 2, 5_000, "the question copy");
  const question = copies()[1];
  assert.equal(question.message.type, "widget");
  assert.equal(harness.answerCard("atlas", question.forwarded!.entryId, "Release", question.forwarded!.sessionId), true);
  await settled();
  assert.equal((store.entry(room.id, question.id) as SendMessageEntry).respondedValue, "Release");
  const result = store.entries("atlas", sessionId).find((entry) => entry.kind === "tool-call" && entry.name === "ask_user");
  assert.equal(result?.kind === "tool-call" ? result.detail?.output : "", "The user answered: Release");
});

test("the mock model answers room turns by name, and passes when only bots spoke", async () => {
  const { say, settled, posts, turns } = await roomSetup(null);
  say("@everyone status?");
  await settled();
  assert.deepEqual(posts(), ['Scout: Scout here. You said: "status?".', 'Atlas: Atlas here. You said: "status?".']);
  say("@Atlas just you");
  await settled();
  assert.deepEqual(turns(), ["Atlas@0 SENT"]);
  assert.equal(posts().at(-1), 'Atlas: Atlas here. You said: "just you".');

  const said: string[] = [];
  for await (const event of streamMock({ system: "You are Atlas, an AI agent in Wisp.", items: [{ kind: "user", parts: [{ type: "text", text: "[Sent now]\n[Group chat “Team”: new messages]\nScout: Over to you." }] }], tools: [], signal: new AbortController().signal })) {
    if (event.type === "text") said.push(event.delta);
  }
  assert.equal(said.join(""), "[pass]");
});

test("makeGroupChat and changeGroupMembers through the gateway; deleting a room keeps its members, deleting a member leaves its rooms", async () => {
  const model = await startScriptedModel((request) => ({ text: `${who(request)} replied.` }));
  after(() => model.close());
  const dataDir = mkdtempSync(join(tmpdir(), "wisp-rooms-gateway-"));
  dirs.push(dataDir);
  const token = "r".repeat(48);
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
  const refused = async (method: string, args: unknown, pattern: RegExp) => {
    const response = await post(method, args);
    const body = (await response.json()) as { error: string };
    assert.equal(response.status, 400, body.error);
    assert.match(body.error, pattern);
  };
  const make = async (name: string) => (await api<{ agent: AgentSummary }>("addAgent", { name, description: "" })).agent.id;
  const [scout, atlas, echo] = [await make("Scout"), await make("Atlas"), await make("Echo")];

  await refused("makeGroupChat", { name: "", memberAgentIds: [scout] }, /at least two bots/);
  await refused("makeGroupChat", { name: "", memberAgentIds: [scout, "nobody"] }, /isn’t there/);
  await refused("makeGroupChat", { name: "", memberAgentIds: [scout, atlas], humanMemberUserIds: [7] }, /Only bots can join/);
  const { agent: room } = await api<{ agent: AgentSummary }>("makeGroupChat", { name: "", memberAgentIds: [scout, atlas], clientNonce: "g1" });
  assert.equal(room.isGroup, true);
  assert.deepEqual(room.memberIds, [scout, atlas]);
  assert.equal(room.name, "Scout, Atlas", "named after its members");
  assert.equal((await api<{ agent: AgentSummary }>("makeGroupChat", { name: "", memberAgentIds: [scout, atlas], clientNonce: "g1" })).agent.id, room.id, "a resend makes no second room");
  await refused("makeGroupChat", { name: "Nested", memberAgentIds: [room.id, echo] }, /can’t be a member/);
  await refused("addAgentAutomation", { id: room.id, spec: { name: "x", prompt: "y", trigger: { type: "cron", schedule: "0 9 * * *" } } }, /no automations of its own/);
  await refused("deliverMessage", { agentId: scout, prompt: "sneak in", sessionId: groupSessionId(room.id) }, /takes its messages from the group chat/);

  await api("deliverMessage", { agentId: room.id, prompt: "Hello", clientNonce: "m1" });
  const tail = async () => (await api<{ entries: TranscriptEntry[] }>("readTranscriptEnd", { id: room.id, limit: 100 })).entries;
  for (let tries = 0; tries < 300 && (await tail()).filter((entry) => entry.kind === "message" && entry.role === "assistant").length < 2; tries++) await new Promise((resolve) => setTimeout(resolve, 20));
  const replies = (await tail()).filter((entry): entry is MessageEntry => entry.kind === "message" && entry.role === "assistant");
  assert.deepEqual(replies.map((entry) => `${entry.fromAgent?.name}: ${entry.content}`), ["Scout: Scout replied.", "Atlas: Atlas replied."]);

  const renamed = await api<AgentSummary>("editAgent", { id: room.id, profile: { name: "Crew", description: "" } });
  assert.equal(renamed.name, "Crew");
  await refused("changeGroupMembers", { id: room.id, memberAgentIds: [scout] }, /at least two bots/);
  const changed = await api<AgentSummary>("changeGroupMembers", { id: room.id, memberAgentIds: [scout, echo] });
  assert.deepEqual(changed.memberIds, [scout, echo]);
  const events = (await tail()).filter((entry) => entry.kind === "event").map((entry) => (entry.kind === "event" ? entry.event : null));
  assert.deepEqual(events, [
    { type: "members-changed", added: ["Scout", "Atlas"], removed: [] },
    { type: "name-changed", from: "Scout, Atlas", to: "Crew" },
    { type: "members-changed", added: ["Echo"], removed: ["Atlas"] },
  ]);

  // Deleting a member takes it out of the room; deleting the room keeps its members and drops their room sessions.
  await api("removeAgents", { ids: [echo] });
  const rows = await api<AgentSummary[]>("rosterAgents", {});
  assert.deepEqual(rows.find((row) => row.id === room.id)!.memberIds, [scout]);
  await api("removeAgents", { ids: [room.id] });
  const left = (await api<AgentSummary[]>("rosterAgents", {})).map((row) => row.id).sort();
  assert.deepEqual(left, [atlas, scout].sort());
  const scoutRoom = await api<{ entries: TranscriptEntry[] }>("readTranscriptEnd", { id: scout, limit: 10, sessionId: groupSessionId(room.id) });
  assert.equal(scoutRoom.entries.length, 0, "Scout's room session went with the room");
});

/** What the person said last in a room turn's batch (earlier lines are context the member has seen before). */
const lastSaid = (request: ScriptedRequest) =>
  request.lastUser
    .split("\n")
    .filter((line) => line.startsWith("User: "))
    .pop() ?? "";

test("a message sent right after Stop is answered, after “Stopped.”; the first message in a room started fresh mid-turn is answered, and the stopped turn leaves nothing behind", async () => {
  const { say, settled, rooms, room, harness, store, lines } = await roomSetup((request, name) => (lastSaid(request).includes("slow") ? { hang: true } : { text: `${name} here.` }));
  const session = groupSessionId(room.id);
  say("slow please");
  await until(() => harness.isRunning("scout", session), 5_000, "Scout's turn");
  assert.equal(rooms.stop(room.id), true);
  // Sent while Scout's stopped run still winds down.
  say("actually, do this");
  await until(() => lines().filter((line) => line.startsWith("assistant:")).length === 2, 10_000, "both replies");
  await settled();
  assert.deepEqual(lines().slice(1), ["user:slow please", "notice:Stopped.", "user:actually, do this", "assistant:Scout here.", "assistant:Atlas here."]);

  say("slow again");
  await until(() => harness.isRunning("scout", session), 5_000, "Scout's next turn");
  rooms.startFresh(room.id);
  say("hello again");
  await until(() => lines().filter((line) => line.startsWith("assistant:")).length === 2, 10_000, "the fresh room's replies");
  await settled();
  assert.deepEqual(lines(), ["user:hello again", "assistant:Scout here.", "assistant:Atlas here."], "no notice, and the first message is answered");
  // Scout's room session was cleared under its stopped run, which wrote nothing into it afterwards.
  const scout = store.entries("scout", session).map((entry) => (entry.kind === "message" ? `${entry.role}:${entry.content.split("\n").pop()}` : entry.kind));
  assert.deepEqual(scout, ["user:User: hello again", "assistant:Scout here."]);
});

test("Start fresh while a member waits for an approval: the expired card lands in neither its cleared session nor the room", async () => {
  const { say, rooms, room, harness, store } = await roomSetup((request, name) => {
    if (request.afterTools) return { text: `${name} ran it.` };
    return name === "Atlas" && lastSaid(request).includes("shell") ? { toolCalls: [{ id: "call_shell", name: "run_shell", args: { command: "make" } }] } : { text: "[pass]" };
  });
  const session = groupSessionId(room.id);
  say("Atlas, use the shell");
  await until(() => store.entries(room.id).some((entry) => entry.kind === "send-message" && entry.forwarded != null), 5_000, "the approval in the room");
  assert.equal(harness.isAwaiting("atlas", session), true);
  rooms.startFresh(room.id);
  await until(() => !harness.isRunning("atlas") && !rooms.isRunning(room.id), 5_000, "Atlas's run to end");
  await new Promise((resolve) => setTimeout(resolve, 80)); // any throttled partial
  assert.deepEqual(store.entries("atlas", session), [], "nothing of the stopped run in Atlas's cleared session");
  assert.deepEqual(store.entries(room.id), [], "no expired copy in the cleared room");
  assert.equal(store.getAgent(room.id)!.awaitingUserResponse, null);
  assert.equal(store.getAgent("atlas")!.awaitingSessionIds, undefined);
});

test("a background command a member starts in a room tells that member's room session and gives it a turn; its own chat hears nothing", async () => {
  const running: BackgroundShellStatus = { id: 4242, agentId: "atlas", command: "npm run dev", cwd: "/home/test/workspaces/atlas", pid: 7001, logPath: "/tmp/4242.txt", state: "running", exitCode: null, startedAt: Date.now(), endedAt: null, origin: "spawned" };
  const { say, settled, store, room, tasks, posts } = await roomSetup(
    (request, name) => {
      if (request.lastUser.includes("[Background command")) return { text: "The server is up." };
      if (request.afterTools) return { text: "Started it." };
      return name === "Atlas" && lastSaid(request).includes("server") ? { toolCalls: [{ id: "call_dev", name: "run_shell", args: { command: "npm run dev", background: true } }] } : { text: "[pass]" };
    },
    { asyncTasks: true, callLocalTool: (call) => (call.args.background === true ? { kind: "ok", output: "Started background command 4242.", task: running } : { kind: "error", message: "no" }) },
  );
  const session = groupSessionId(room.id);
  say("@Atlas start the dev server");
  await settled("Atlas's turn");
  assert.deepEqual(posts(), ["Atlas: Started it."]);
  assert.equal(store.tasks().find((task) => task.key === "local:4242")?.sessionId, session, "the task remembers the session that started it");

  // The command ends with nobody waiting on it.
  tasks!.noteShell("local", { ...running, state: "succeeded", exitCode: 0, endedAt: Date.now() }, "test-pc");
  await until(() => posts().length === 2, 10_000, "Atlas's post about it");
  await settled("the woken turn");
  assert.deepEqual(posts(), ["Atlas: Started it.", "Atlas: The server is up."]);
  const told = store.entries("atlas", session).find((entry) => entry.kind === "message" && entry.suppressed === "quiet-wake");
  assert.match(told?.kind === "message" ? told.content : "", /\[Background command 4242/);
  assert.deepEqual(store.entries("atlas"), [], "Atlas's own chat wasn't told or woken");
  assert.equal(store.getAgent(room.id)!.lastTurnSettlement?.outcome, "success", "the person's message's settlement stays");
});

test("a page a member writes in a room shows its card in the room; an edit from the member's own chat posts a card there; every card follows the page", async () => {
  let store!: BoxStore;
  const page = () => store.listPages("atlas")[0];
  const setup = await roomSetup((request, name) => {
    if (request.afterTools) return { text: "Done." };
    if (name !== "Atlas") return { text: "[pass]" };
    if (lastSaid(request).includes("plan")) return { toolCalls: [{ id: "call_write", name: "create_document", args: { title: "Plan", markdown: "# Plan\n\nStep one." } }] };
    if (request.lastUser.includes("edit the plan")) return { toolCalls: [{ id: "call_edit", name: "edit_document", args: { document_id: page().id, edits: [{ find: "Step one.", replace: "Step two." }], base_revision: 1 } }] };
    return { text: "[pass]" };
  });
  store = setup.store;
  const { say, settled, room, harness } = setup;
  const session = groupSessionId(room.id);
  const cards = (agentId: string, sessionId: string) => store.entries(agentId, sessionId).filter((entry): entry is SendMessageEntry & { message: PageMessage } => entry.kind === "send-message" && entry.message.type === "page");

  say("Atlas, write a plan");
  await settled();
  assert.equal(cards("atlas", session).length, 1);
  const [copy] = cards(room.id, MAIN_SESSION);
  assert.equal(copy?.fromAgent?.id, "atlas", "the room shows the member's card, marked with who wrote it");
  assert.equal(copy.message.page.storeId, "atlas", "and it opens the member's page");
  assert.equal(copy.message.revision, 1);
  assert.deepEqual(page().sessionCards, { [session]: cards("atlas", session)[0].id });
  assert.equal(page().cardId, null, "the member's own chat has no card yet");

  // The member's own chat edits it: a card there, and the room's card and its copy follow.
  harness.submitPrompt("atlas", { prompt: "edit the plan", attachmentPaths: [], attachmentNames: [], clientNonce: null, source: "user" });
  await until(() => !harness.isRunning("atlas"), 5_000, "the edit");
  const [own] = cards("atlas", MAIN_SESSION);
  assert.equal(own?.message.revision, 2, "the main chat got a card of its own");
  assert.equal(page().cardId, own.id);
  assert.equal(cards("atlas", session)[0].message.revision, 2);
  assert.equal(cards(room.id, MAIN_SESSION)[0].message.revision, 2);
  assert.equal(cards(room.id, MAIN_SESSION).length, 1, "the copy is updated in place");

  // The user's save updates all three and posts none.
  const saved = writePage(store, "atlas", page().id, "# Plan\n\nStep three.", 2);
  harness.pageChanged("atlas", saved.record, saved.source, "edited", "user");
  for (const [agentId, sessionId] of [["atlas", MAIN_SESSION], ["atlas", session], [room.id, MAIN_SESSION]] as const) {
    assert.equal(cards(agentId, sessionId).length, 1);
    assert.equal(cards(agentId, sessionId)[0].message.revision, 3);
    assert.equal(cards(agentId, sessionId)[0].message.updatedBy, "user");
  }

  // A page saved before cards were kept per session (one card, and the session it was in) loads as such.
  const dir = mkdtempSync(join(tmpdir(), "wisp-rooms-pages-"));
  dirs.push(dir);
  const old = new BoxStore(dir);
  old.putPage("atlas", { ...page(), cardId: "t3s2", sessionCards: undefined, cardSessionId: session } as never);
  old.close();
  const reloaded = new BoxStore(dir).getPage("atlas", page().id)!;
  assert.equal(reloaded.cardId, null);
  assert.deepEqual(reloaded.sessionCards, { [session]: "t3s2" });
});
