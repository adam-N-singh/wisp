import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type BoxServer, startBoxServer } from "../../src/box-server/server";
import { BoxStore } from "../../src/box/store";
import type { AgentSummary, Automation, ClaudeCodeStatus, ConversationMatch, EventEntry, MessageEntry, MessageMatch, TranscriptEntry } from "../../src/shared/model";

const cleanup: Array<() => void> = [];
after(() => {
  for (const fn of cleanup.reverse()) fn();
});

const TOKEN = randomBytes(24).toString("hex");
const NO_CLAUDE = async (): Promise<ClaudeCodeStatus> => ({ executable: null, installed: false, version: null, signedIn: false, authMethod: null, checkedAt: 1 });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wisp-search-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function agent(id: string, name: string, extra: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id, name, description: "", path: "", origin: "user", isGroup: false, memberIds: [], isActive: false, createdAt: 1, updatedAt: 1,
    isRunning: false, isComposingMessage: false, awaitingUserResponse: null, hasUnread: false, lastMessageId: null, lastEntry: null,
    notificationsEnabled: true, notifyOnUpdatesEnabled: true, avatarDataUrl: null, instructions: "", model: null, isPinned: false, ...extra,
  };
}

/** A box data folder holding these conversations, as if the agents had written them. */
function seed(conversations: Record<string, Array<[role: "user" | "assistant", content: string, timestampMs: number]>>, agents: AgentSummary[]): string {
  const dir = tempDir();
  const store = new BoxStore(dir);
  for (const row of agents) store.putAgent(row);
  for (const [agentId, messages] of Object.entries(conversations)) {
    messages.forEach(([role, content, timestampMs], index) => {
      const entry: MessageEntry = { kind: "message", id: `${agentId}-m${index + 1}`, seq: store.nextSeq(agentId), turn: index + 1, step: 0, timestampMs, role, content, isStreaming: false };
      store.upsertEntry(agentId, entry, true);
    });
  }
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

const LONG = `${"Earlier context that has nothing to do with the question. ".repeat(3)}The quarterly    report\n\nis due on Friday. ${"More text after the match that keeps going for a while. ".repeat(3)}`;

test("findAcrossAgents: messages across agents, hidden ones included, newest first, any case, as typed", async () => {
  const dir = seed(
    {
      a1: [
        ["user", "Draft the quarterly report outline.", 1_000],
        ["assistant", "Here is an outline for the Quarterly Report.", 2_000],
        ["user", "Costs went up 3.5% (a.k.a. a lot).", 5_000],
      ],
      a2: [
        ["user", LONG, 3_000],
        ["assistant", "Noted, on a 3x5 card.", 4_000],
      ],
      a3: [["assistant", "The quarterly numbers are in.", 6_000]],
    },
    [agent("a1", "Planner"), agent("a2", "Writer"), agent("a3", "Quiet", { isHiddenFromSidebar: true })],
  );
  const server = await bootBox(dir);

  const hits = await api<MessageMatch[]>(server, "findAcrossAgents", { query: "QUARTERLY" });
  assert.deepEqual(
    hits.map((hit) => [hit.agentId, hit.entryId, hit.role, hit.seq]),
    [
      ["a3", "a3-m1", "assistant", 1],
      ["a2", "a2-m1", "user", 1],
      ["a1", "a1-m2", "assistant", 2],
      ["a1", "a1-m1", "user", 1],
    ],
  );
  assert.deepEqual([hits[0].snippet, hits[0].timestampMs], ["The quarterly numbers are in.", 6_000]);
  // Long messages give the text around the match, on one line, marked where it was cut.
  assert.match(hits[1].snippet, /^….{20,} The quarterly report is due on Friday\. More text.*…$/);
  assert.ok(hits[1].snippet.length < 140, hits[1].snippet);

  assert.deepEqual((await api<MessageMatch[]>(server, "findAcrossAgents", { query: "quarterly", limit: 2 })).map((hit) => hit.entryId), ["a3-m1", "a2-m1"]);
  // The query is plain text, not a pattern.
  assert.deepEqual((await api<MessageMatch[]>(server, "findAcrossAgents", { query: "3.5" })).map((hit) => hit.entryId), ["a1-m3"]);
  assert.deepEqual((await api<MessageMatch[]>(server, "findAcrossAgents", { query: "3.5% (a.k.a." })).map((hit) => hit.entryId), ["a1-m3"]);
  assert.deepEqual(await api(server, "findAcrossAgents", { query: "   " }), []);
  assert.equal((await post(server, "findAcrossAgents", { query: "" })).status, 400);
});

test("findInConversation: one agent's matches, newest first, paged back with beforeSeq", async () => {
  const messages = Array.from({ length: 7 }, (_, index): ["user" | "assistant", string, number] => [index % 2 === 0 ? "user" : "assistant", index === 3 ? "no match here" : `step ${index + 1}: ping the server`, (index + 1) * 1_000]);
  const server = await bootBox(seed({ a1: messages, a2: [["user", "ping from elsewhere", 9_000]] }, [agent("a1", "Ops"), agent("a2", "Other")]));

  const first = await api<{ isComplete: boolean; matches: ConversationMatch[] }>(server, "findInConversation", { agentId: "a1", query: "Ping", limit: 4 });
  assert.equal(first.isComplete, false);
  assert.deepEqual(first.matches.map((match) => match.seq), [7, 6, 5, 3]);
  assert.deepEqual(first.matches[0], { entryId: "a1-m7", role: "user", seq: 7, snippet: "step 7: ping the server", timestampMs: 7_000 });

  const rest = await api<{ isComplete: boolean; matches: ConversationMatch[] }>(server, "findInConversation", { agentId: "a1", query: "Ping", limit: 4, beforeSeq: first.matches[3].seq });
  assert.deepEqual([rest.isComplete, rest.matches.map((match) => match.seq)], [true, [2, 1]]);
  assert.deepEqual(await api(server, "findInConversation", { agentId: "a1", query: "pong" }), { isComplete: true, matches: [] });
  assert.equal((await post(server, "findInConversation", { agentId: "missing", query: "ping" })).status, 404);
});

test("rosterAgents keeps hidden agents, flagged, so they can be shown again; notification and automation edits stick", async () => {
  const server = await bootBox(seed({}, [agent("a1", "Visible"), agent("a2", "Tucked away", { isHiddenFromSidebar: true })]));
  const flags = async () => Object.fromEntries((await api<AgentSummary[]>(server, "rosterAgents", {})).map((row) => [row.id, [row.isHiddenFromSidebar === true, row.notifyOnUpdatesEnabled]]));
  assert.deepEqual(await flags(), { a1: [false, true], a2: [true, true] });

  await api(server, "changeAgentHidden", { id: "a1", isHidden: true });
  await api(server, "changeAgentHidden", { id: "a2", isHidden: false });
  await api(server, "changeAgentNotifications", { id: "a2", isEnabled: false });
  assert.deepEqual(await flags(), { a1: [true, true], a2: [false, false] });

  // Editing an automation keeps its id, runs and paused state unless the edit says otherwise.
  const [created] = await api<Automation[]>(server, "addAgentAutomation", { id: "a2", spec: { name: "Digest", prompt: "Summarize the day.", trigger: { type: "cron", schedule: "0 8 * * *" } } });
  await api(server, "toggleAgentAutomation", { id: "a2", automationId: created.id, isEnabled: false });
  const [edited] = await api<Automation[]>(server, "editAgentAutomation", { id: "a2", automationId: created.id, spec: { name: "Evening digest", prompt: "Summarize the day so far.", trigger: { type: "cron", schedule: "0 18 * * 1-5" } } });
  assert.deepEqual([edited.id, edited.name, edited.prompt, edited.schedule, edited.isEnabled, edited.createdAt], [created.id, "Evening digest", "Summarize the day so far.", "0 18 * * 1-5", false, created.createdAt]);
  assert.notEqual(edited.triggerDescription, created.triggerDescription);
  const resumed = await api<Automation[]>(server, "editAgentAutomation", { id: "a2", automationId: created.id, spec: { name: "Evening digest", prompt: "Summarize the day so far.", trigger: { type: "cron", schedule: "0 18 * * 1-5" }, isEnabled: true } });
  assert.equal(resumed[0].isEnabled, true);
  assert.equal((await post(server, "editAgentAutomation", { id: "a2", automationId: created.id, spec: { name: "x", prompt: "y", trigger: { type: "cron", schedule: "61 * * * * *" } } })).status, 400);
  assert.equal((await post(server, "editAgentAutomation", { id: "a1", automationId: created.id, spec: { name: "x", prompt: "y", trigger: { type: "cron", schedule: "0 8 * * *" } } })).status, 404);

  const timeline = (await api<{ entries: TranscriptEntry[] }>(server, "readTranscriptEnd", { id: "a2", limit: 20 })).entries.filter((entry): entry is EventEntry => entry.kind === "event");
  assert.deepEqual(
    timeline.map((entry) => (entry.event.type === "automation-changed" ? [entry.event.action, entry.event.automationName] : [])),
    [["created", "Digest"], ["updated", "Evening digest"], ["updated", "Evening digest"]],
  );
});
