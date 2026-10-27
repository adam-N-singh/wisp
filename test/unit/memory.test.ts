import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type BoxServer, startBoxServer } from "../../src/box-server/server";
import type { ClaudeCodeEngine, EngineHost } from "../../src/box/claude-code";
import { Harness } from "../../src/box/harness";
import { McpManager } from "../../src/box/mcp";
import { addMemory, editMemory, forgetMemory, MemoryError, memoriesForPrompt, memoryInstructions, memoryText, reviewMemory } from "../../src/box/memory";
import { BoxStore } from "../../src/box/store";
import type { BoxModelConfig } from "../../src/shared/edges";
import { readSse } from "../../src/shared/gateway-protocol";
import {
  type AgentMemory,
  type AgentSummary,
  type ClaudeCodeStatus,
  MAX_MEMORIES,
  MAX_MEMORY_TEXT,
  MEMORY_BUDGET,
  type MemoryReview,
  memoryImportPrompt,
  memoryUsage,
  type MessageEntry,
  type ToolCallEntry,
  type TranscriptEntry,
} from "../../src/shared/model";

const cleanup: Array<() => void> = [];
const stores: BoxStore[] = [];
after(() => {
  stores.forEach((store) => store.close());
  for (const fn of cleanup.reverse()) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wisp-memory-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function agent(id: string): AgentSummary {
  const now = Date.now();
  return {
    id, name: "Tester", description: "", path: "", origin: "user", isGroup: false, memberIds: [], isActive: false, createdAt: now, updatedAt: now,
    isRunning: false, isComposingMessage: false, awaitingUserResponse: null, hasUnread: false, lastMessageId: null, lastEntry: null,
    notificationsEnabled: true, notifyOnUpdatesEnabled: true, avatarDataUrl: null, instructions: "", model: null, isPinned: false,
  };
}

const MOCK_MODELS: BoxModelConfig = {
  defaultModel: { provider: "mock", model: "mock-1" },
  reasoningEffort: "default",
  temperature: null,
  xai: null,
  openai: null,
  anthropic: null,
  custom: null,
  claudeCode: null,
};

function setup(options: { models?: BoxModelConfig; claudeCode?: ClaudeCodeEngine } = {}) {
  const dir = tempDir();
  const store = new BoxStore(dir);
  stores.push(store);
  store.putAgent(agent("a1"));
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

const replies = (entries: TranscriptEntry[]) => entries.filter((entry): entry is MessageEntry => entry.kind === "message" && entry.role === "assistant" && !entry.isStreaming);
const toolCalls = (entries: TranscriptEntry[]) => entries.filter((entry): entry is ToolCallEntry => entry.kind === "tool-call");
const prompt = (text: string, clientNonce: string) => ({ prompt: text, attachmentPaths: [], attachmentNames: [], clientNonce, source: "user" as const });
const memory = (id: string, text: string, at: number, review: MemoryReview | null = null): AgentMemory => ({ id, agentId: "a1", text, createdAt: at, updatedAt: at, source: "agent", review });
const day = (ms: number) => new Date(ms).toLocaleDateString("en-CA");

test("memory store: memories survive a restart per agent, a file edited by hand keeps what parses, and deleting the agent removes them", () => {
  const { dir, store } = setup();
  const units = addMemory(store, "a1", "  Prefers   metric\nunits. ", "agent", false).memory;
  const work = addMemory(store, "a1", "Works at Acme as a data engineer.", "user", false).memory;
  assert.equal(units.text, "Prefers metric units.");
  assert.match(units.id, /^[0-9a-f]{8}$/);
  assert.deepEqual([units.source, work.source, units.review], ["agent", "user", null]);
  const file = join(dir, "memories", "a1.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { schemaVersion: 1, memories: [units, work] });

  const reloaded = new BoxStore(dir);
  stores.push(reloaded);
  assert.deepEqual(reloaded.listMemories("a1"), [units, work], "everything survives a restart, oldest first");

  writeFileSync(file, JSON.stringify({ schemaVersion: 1, memories: [work, { id: "byhand01", text: "Has a dog named Rex.", createdAt: 5 }, { text: "no id" }, { id: "no-text" }] }));
  const edited = new BoxStore(dir);
  stores.push(edited);
  assert.deepEqual(edited.listMemories("a1"), [{ id: "byhand01", agentId: "a1", text: "Has a dog named Rex.", createdAt: 5, updatedAt: 5, source: "agent", review: null }, work]);
  assert.deepEqual(edited.listMemories("../a1"), [], "only a plain agent id names a file");

  assert.equal(edited.deleteMemory("a1", "byhand01")?.text, "Has a dog named Rex.");
  assert.equal(edited.deleteMemory("a1", "byhand01"), undefined);
  edited.deleteAgent("a1");
  assert.equal(existsSync(file), false);
  assert.deepEqual(edited.listMemories("a1"), []);
});

test("memory rules: one line each, no duplicates, the budget and the count hold, and review holds the agent's changes", () => {
  const { store } = setup();
  assert.equal(memoryText(" Likes\n\ttea  "), "Likes tea");
  assert.throws(() => memoryText(" \n "), (error) => error instanceof MemoryError && error.code === "empty");
  assert.throws(() => memoryText("x".repeat(MAX_MEMORY_TEXT + 1)), /up to 500 characters; this one has 501\./);

  const units = addMemory(store, "a1", "Prefers metric units.", "agent", false).memory;
  const again = addMemory(store, "a1", "prefers METRIC units", "user", false);
  assert.deepEqual([again.existing, again.memory.id], [true, units.id], "case and a closing full stop don't make a new memory");

  // Every memory fits in the prompt: a change that would take them past the budget is refused, and one that shrinks them is fine.
  for (let i = 0; memoryUsage(store.listMemories("a1")) + MAX_MEMORY_TEXT <= MEMORY_BUDGET; i++) addMemory(store, "a1", `${String(i).padStart(3, "0")} ${"x".repeat(MAX_MEMORY_TEXT - 4)}`, "user", false);
  const room = MEMORY_BUDGET - memoryUsage(store.listMemories("a1"));
  assert.throws(() => addMemory(store, "a1", "y".repeat(room + 1), "agent", false), new RegExp(`^MemoryError: The memory is full: it holds up to 8,000 characters, ${(MEMORY_BUDGET - room).toLocaleString("en-US")} are in use and this needs ${room + 1} more\\.$`));
  addMemory(store, "a1", "y".repeat(room), "agent", false);
  assert.equal(memoryUsage(store.listMemories("a1")), MEMORY_BUDGET);
  assert.throws(() => editMemory(store, "a1", units.id, "Prefers metric units and 24-hour times.", "user", false), /memory is full/);
  const big = store.listMemories("a1")[1];
  assert.equal(editMemory(store, "a1", big.id, "Short now.", "user", false).outcome, "updated");

  store.putAgent(agent("a2"));
  for (let i = 0; i < MAX_MEMORIES; i++) addMemory(store, "a2", `Fact ${i}`, "user", false);
  assert.throws(() => addMemory(store, "a2", "One more fact", "agent", false), /holds up to 100 memories/);

  // Review: the agent's new memory, change and forget each wait; the user settles them.
  store.putAgent(agent("a3"));
  const lisbon = addMemory(store, "a3", "Lives in Lisbon.", "user", true).memory;
  assert.equal(lisbon.review, null, "what the user saves never waits");
  const concise = addMemory(store, "a3", "Likes concise answers.", "agent", true).memory;
  assert.equal(concise.review?.action, "add");
  assert.equal(editMemory(store, "a3", `[${concise.id}]`, "Likes concise answers, code first.", "agent", true).outcome, "proposed");
  assert.deepEqual([store.getMemory("a3", concise.id)!.text, store.getMemory("a3", concise.id)!.review?.action], ["Likes concise answers, code first.", "add"], "its own new memory takes the new text and still waits");
  const change = editMemory(store, "a3", lisbon.id.toUpperCase(), "Lives in Porto.", "agent", true);
  assert.deepEqual([change.outcome, change.memory.text, change.memory.review?.action, change.memory.review?.text], ["proposed", "Lives in Lisbon.", "edit", "Lives in Porto."]);
  reviewMemory(store, "a3", lisbon.id, true);
  assert.deepEqual([store.getMemory("a3", lisbon.id)!.text, store.getMemory("a3", lisbon.id)!.review], ["Lives in Porto.", null]);
  assert.equal(forgetMemory(store, "a3", lisbon.id, "agent", true).outcome, "proposed");
  reviewMemory(store, "a3", lisbon.id, false);
  assert.equal(store.getMemory("a3", lisbon.id)?.review, null, "rejecting a forget keeps the memory");
  assert.throws(() => reviewMemory(store, "a3", lisbon.id, true), (error) => error instanceof MemoryError && error.code === "settled");
  reviewMemory(store, "a3", concise.id, false);
  assert.equal(store.getMemory("a3", concise.id), undefined, "rejecting a new memory drops it");
  const cats = addMemory(store, "a3", "Has two cats.", "agent", true).memory;
  assert.equal(forgetMemory(store, "a3", cats.id, "agent", true).outcome, "forgotten", "the agent withdraws its own new memory at once");
  forgetMemory(store, "a3", lisbon.id, "agent", true);
  assert.deepEqual([editMemory(store, "a3", lisbon.id, "Lives in Porto, Portugal.", "user", true).outcome, store.getMemory("a3", lisbon.id)!.review], ["updated", null], "the user's edit settles what waited");
  assert.throws(() => forgetMemory(store, "a3", "nope", "agent", false), /no memory with the id “nope”/);
});

test("memory prompt: ids and dates, pending changes apart, a budget, guidance on what to keep, and its place in the system prompt", () => {
  const { store, harness } = setup();
  const row = store.getAgent("a1")!;
  const empty = harness.systemPrompt(row);
  assert.match(empty, /\n## Memory\nYou keep a memory across conversations[^\n]*\nYour memory is empty so far\.\nHow to keep your memory:\n/);
  assert.match(empty, /with save_memory, one short fact per memory: facts about the user and their work/);
  assert.match(empty, /Don't save secrets/);
  assert.doesNotMatch(empty, /reviews your memory/);

  const at = Date.UTC(2026, 2, 3, 12);
  const listed = [
    memory("aaaa0001", "Prefers metric units.", at),
    memory("aaaa0002", "Works at Acme.", at + 1, { action: "edit", text: "Works at Acme as a staff engineer.", requestedAt: at + 5 }),
    memory("aaaa0003", "Likes concise answers.", at + 2, { action: "add", requestedAt: at + 2 }),
    memory("aaaa0004", "Has a dog.", at + 3, { action: "forget", requestedAt: at + 6 }),
  ];
  const lines = memoryInstructions(listed, { review: true });
  assert.deepEqual(lines.slice(1, 9), [
    "Your memories (id, date written):",
    `- [aaaa0001] ${day(at)}: Prefers metric units.`,
    `- [aaaa0002] ${day(at)}: Works at Acme.`,
    `- [aaaa0004] ${day(at)}: Has a dog.`,
    "Waiting for the user's approval, not in effect yet:",
    "- [aaaa0002] change to: Works at Acme as a staff engineer.",
    "- [aaaa0003] new: Likes concise answers.",
    "- [aaaa0004] forget",
  ]);
  assert.equal(lines.at(-1), "- The user reviews your memory: what you save, change or forget waits for their approval in the Memory tab before it takes effect.");
  const bridged = memoryInstructions([], { review: false, toolPrefix: "mcp__wisp__" }).join("\n");
  assert.ok(["mcp__wisp__save_memory", "mcp__wisp__update_memory", "mcp__wisp__forget_memory"].every((name) => bridged.includes(name)));

  // Over the budget (a file edited by hand), the least recently written stay out.
  const old = memory("bbbb0001", "o".repeat(30), 1);
  const middle = memory("bbbb0002", "m".repeat(20), 2);
  const recent = memory("bbbb0003", "r".repeat(15), 3);
  assert.deepEqual(memoriesForPrompt([old, middle, recent], 40), { current: [middle, recent], pending: [], omitted: 1 });
  assert.ok(memoryInstructions([old, middle, recent], { review: false, budget: 40 }).includes("(1 more memory doesn't fit here.)"));

  // The agent's own memories, between its skills and the user's instructions.
  const saved = addMemory(store, "a1", "Prefers metric units.", "agent", false).memory;
  const withInstructions = { ...row, instructions: "Be brief." };
  const system = harness.systemPrompt(withInstructions);
  assert.match(system, new RegExp(`\\nYour memories \\(id, date written\\):\\n- \\[${saved.id}\\] ${day(saved.updatedAt)}: Prefers metric units\\.\\n`));
  assert.ok(system.indexOf("## Memory") < system.indexOf("## Instructions from the user"));
  assert.match(harness.systemPrompt({ ...row, memoryReview: true }), /\n- The user reviews your memory/);
});

test("harness: the agent saves, updates and forgets memories with its tools, and review holds what it saves", async () => {
  const { store, harness, events } = setup();
  const settled = async (text: string, nonce: string) => {
    harness.submitPrompt("a1", prompt(text, nonce));
    await until(() => !store.getAgent("a1")!.isRunning);
    return toolCalls(store.entries("a1")).pop()!;
  };

  const saved = await settled('/tool save_memory {"text":"Prefers metric units."}', "n1");
  const [units] = store.listMemories("a1");
  assert.deepEqual([saved.summary, saved.status, saved.detail?.output], ["Remembered “Prefers metric units.”", "done", `Saved to your memory as [${units.id}].`]);
  assert.deepEqual(events.filter((event) => event.channel === "memories").pop()?.payload, { agentId: "a1", memories: [units] });
  assert.equal((await settled('/tool save_memory {"text":"prefers metric units"}', "n2")).detail?.output, `That is already in your memory as [${units.id}].`);

  const missing = await settled('/tool update_memory {"id":"nope","text":"Anything."}', "n3");
  assert.deepEqual([missing.status, missing.detail?.output], ["failed", "There is no memory with the id “nope”. Use an id from the memories listed in your instructions."]);
  const updated = await settled(`/tool update_memory {"id":"[${units.id}]","text":"Prefers metric units and 24-hour times."}`, "n4");
  assert.deepEqual([updated.summary, updated.detail?.output], ["Updated a memory: “Prefers metric units and 24-hour times.”", `Updated [${units.id}].`]);
  const forgot = await settled(`/tool forget_memory {"id":"${units.id}"}`, "n5");
  assert.deepEqual([forgot.summary, forgot.detail?.output, store.listMemories("a1")], ["Forgot “Prefers metric units and 24-hour times.”", `Forgot [${units.id}].`, []]);

  const tooLong = await settled(`/tool save_memory {"text":"${"x".repeat(MAX_MEMORY_TEXT + 1)}"}`, "n6");
  assert.equal(tooLong.status, "failed");
  assert.match(tooLong.detail!.output, /this one has 501\. Keep each memory to one short fact, and split longer notes into several memories\.$/);

  store.putAgent({ ...store.getAgent("a1")!, memoryReview: true });
  const asked = await settled('/tool save_memory {"text":"Likes concise answers."}', "n7");
  const [concise] = store.listMemories("a1");
  assert.deepEqual([asked.summary, asked.detail?.output, concise.review?.action], ["Asked to remember “Likes concise answers.”", `Saved [${concise.id}] for the user's review; it takes effect once they approve it.`, "add"]);
  reviewMemory(store, "a1", concise.id, true);
  const forgetting = await settled(`/tool forget_memory {"id":"${concise.id}"}`, "n8");
  assert.deepEqual([forgetting.summary, forgetting.detail?.output], ["Asked to forget “Likes concise answers.”", `Asked the user to approve forgetting [${concise.id}]; until then it stays in your memory.`]);

  // A full memory tells the agent how to make room.
  for (let i = 0; memoryUsage(store.listMemories("a1")) + MAX_MEMORY_TEXT <= MEMORY_BUDGET; i++) addMemory(store, "a1", `${i} ${"x".repeat(MAX_MEMORY_TEXT - 4)}`, "user", false);
  const full = await settled(`/tool save_memory {"text":"${"z".repeat(MAX_MEMORY_TEXT)}"}`, "n9");
  assert.match(full.detail!.output, /^The memory is full: .* Make room first: merge related memories with update_memory or forget ones that no longer matter, then try again\.$/);
});

test("harness: a run reads the agent's memories when its turn starts, and Import memory's notes become memories", async () => {
  // A scripted OpenAI-compatible model that records the system prompt of every request.
  const systems: string[] = [];
  const model = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const messages: Array<{ role: string; content: string }> = JSON.parse(body).messages;
    systems.push(messages[0].content);
    const last = messages[messages.length - 1];
    const text = last.content.replace(/^\[Sent [^\]]*\]\n/, "");
    const chunks: object[] = [];
    const call = (index: number, name: string, args: object) => ({ choices: [{ delta: { tool_calls: [{ index, id: `call_${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
    if (last.role === "tool") chunks.push({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] });
    else if (text.startsWith("Please remember: ")) chunks.push(call(0, "save_memory", { text: text.slice(17) }), { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    else if (text.startsWith("Please add these notes to your memory.")) {
      const notes = text.slice(text.indexOf("\n\n") + 2).split("\n");
      chunks.push(...notes.map((note, index) => call(index, "save_memory", { text: note })), { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else chunks.push({ choices: [{ delta: { content: "OK." }, finish_reason: "stop" }] });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => model.close());
  const { store, harness } = setup({ models: { ...MOCK_MODELS, defaultModel: { provider: "custom", model: "scripted" }, custom: { baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}`, apiKey: "" } } });
  const send = async (text: string, nonce: string) => {
    harness.submitPrompt("a1", prompt(text, nonce));
    await until(() => !store.getAgent("a1")!.isRunning);
  };

  await send("Please remember: Prefers metric units.", "n1");
  const [units] = store.listMemories("a1");
  assert.equal(units.text, "Prefers metric units.");
  assert.equal(systems.length, 2);
  assert.equal(systems[1], systems[0], "the save doesn't change the prompt under the rest of its turn");
  assert.match(systems[0], /Your memory is empty so far\./);
  await send("What do you know about me?", "n2");
  assert.match(systems[2], new RegExp(`- \\[${units.id}\\] ${day(units.updatedAt)}: Prefers metric units\\.`), "the next turn's prompt lists it");

  // Import memory sends the pasted notes as a message, and the agent saves what's worth keeping.
  const notes = "I'm a data engineer at Acme.\nI like short answers with the code first.";
  assert.equal(memoryImportPrompt(`\n${notes}\n\n`).split("\n\n")[1], notes);
  await send(memoryImportPrompt(notes), "n3");
  assert.deepEqual(store.listMemories("a1").map((saved) => saved.text), ["Prefers metric units.", "I'm a data engineer at Acme.", "I like short answers with the code first."]);
  assert.deepEqual(replies(store.entries("a1")).pop()?.content, "Done.");
});

test("Claude Code agents keep their memory through the bridge", async () => {
  const turns: Array<{ tools: string[]; notes: string; saved: { output: string; isError: boolean } }> = [];
  const engine = {
    // Like the real engine: the notes are written before Claude Code starts, then it calls a tool.
    runTurn: async (host: EngineHost) => {
      const notes = host.agentNotes();
      const saved = await host.runAppTool(1, "save_memory", { text: "Prefers tabs over spaces." });
      turns.push({ tools: host.appTools().map((tool) => tool.name), notes, saved });
      return { sessionId: "session-1", failed: null, text: "" };
    },
  } as unknown as ClaudeCodeEngine;
  const { store, harness } = setup({ models: { ...MOCK_MODELS, claudeCode: { executable: "claude" } }, claudeCode: engine });
  store.putAgent({ ...store.getAgent("a1")!, model: "claude-code:default" });

  harness.submitPrompt("a1", prompt("hello", "n1"));
  await until(() => turns.length === 1 && !store.getAgent("a1")!.isRunning);
  const [tabs] = store.listMemories("a1");
  assert.ok(["save_memory", "update_memory", "forget_memory"].every((name) => turns[0].tools.includes(name)), "the bridge offers the memory tools");
  assert.deepEqual(turns[0].saved, { output: `Saved to your memory as [${tabs.id}].`, isError: false, image: null });
  assert.match(turns[0].notes, /save_memory, update_memory and forget_memory keep your memory/);
  assert.match(turns[0].notes, /\nMemory:\nYou keep a memory[^\n]*\nYour memory is empty so far\.\n/);
  assert.match(turns[0].notes, /with mcp__wisp__save_memory, one short fact per memory/);
  assert.match(turns[0].notes, /not in CLAUDE\.md or other files/);

  harness.submitPrompt("a1", prompt("again", "n2"));
  await until(() => turns.length === 2 && !store.getAgent("a1")!.isRunning);
  assert.match(turns[1].notes, new RegExp(`\\n- \\[${tabs.id}\\] ${day(tabs.updatedAt)}: Prefers tabs over spaces\\.\\n`));
  assert.equal(turns[1].saved.output, `That is already in your memory as [${tabs.id}].`);
});

const TOKEN = randomBytes(24).toString("hex");
const NO_CLAUDE = async (): Promise<ClaudeCodeStatus> => ({ executable: null, installed: false, version: null, signedIn: false, authMethod: null, checkedAt: 1 });

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

test("box gateway: with the mock model, a memory saved in one conversation is in the agent's prompt after Start fresh conversation", async () => {
  const dir = tempDir();
  let server = await bootBox(dir);
  const abort = new AbortController();
  cleanup.push(() => abort.abort());
  const events: Array<{ agentId: string; memories: AgentMemory[] }> = [];
  const stream = await fetch(`${server.url}/events`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: abort.signal });
  void (async () => {
    for await (const block of readSse(stream.body!, abort.signal)) {
      const frame = block.data != null ? JSON.parse(block.data) : null;
      if (frame?.channel === "memories") events.push(frame.payload);
    }
  })().catch(() => undefined);

  const { agent: created } = await api<{ agent: AgentSummary }>(server, "addAgent", { name: "Rememberer", description: "" });
  const id = created.id;
  const entries = async () => (await api<{ entries: TranscriptEntry[] }>(server, "readTranscriptEnd", { id, limit: 200 })).entries;
  const idle = () => until(async () => (await api<AgentSummary[]>(server, "rosterAgents", {})).find((row) => row.id === id)?.isRunning === false);
  const memories = () => api<AgentMemory[]>(server, "getAgentMemories", { id });
  /** The system prompt as the mock model reads it back. */
  const systemPrompt = async (nonce: string) => {
    const before = replies(await entries()).length;
    await api(server, "deliverMessage", { agentId: id, prompt: "/system", clientNonce: nonce });
    await until(async () => replies(await entries()).length > before);
    await idle();
    const reply = replies(await entries()).pop()!.content;
    assert.match(reply, /^My system prompt:\n\n/);
    return reply;
  };

  // In the first conversation the agent saves a memory (the mock runs "/tool …" as a tool call).
  await api(server, "deliverMessage", { agentId: id, prompt: '/tool save_memory {"text":"The user’s favourite colour is teal."}', clientNonce: "n1" });
  await until(() => events.some((event) => event.agentId === id && event.memories.length === 1));
  await idle();
  const [teal] = await memories();
  assert.deepEqual([teal.text, teal.source, teal.review], ["The user’s favourite colour is teal.", "agent", null]);

  // Start fresh conversation forgets the conversation, not the memory.
  await api(server, "resetConversation", { id });
  assert.deepEqual(await entries(), []);
  assert.match(await systemPrompt("n2"), new RegExp(`\\n## Memory\\n[^\\n]*\\nYour memories \\(id, date written\\):\\n- \\[${teal.id}\\] ${day(teal.updatedAt)}: The user’s favourite colour is teal\\.\\n`));

  // The Memory tab adds, edits and deletes; refusals are for the user.
  const lisbon = (await api<AgentMemory[]>(server, "createAgentMemory", { id, text: "Works  from\nLisbon." })).find((saved) => saved.source === "user")!;
  assert.equal(lisbon.text, "Works from Lisbon.");
  const duplicate = await post(server, "createAgentMemory", { id, text: "works from lisbon" });
  assert.equal(duplicate.status, 400);
  assert.match(((await duplicate.json()) as { error: string }).error, /already in this agent’s memory/);
  assert.equal((await post(server, "createAgentMemory", { id, text: "x".repeat(MAX_MEMORY_TEXT + 1) })).status, 400);
  assert.equal((await post(server, "updateAgentMemory", { id, memoryId: "missing", text: "Anything." })).status, 404);
  assert.equal((await post(server, "createAgentMemory", { id: "no-such-agent", text: "Anything." })).status, 404);
  const edited = await api<AgentMemory[]>(server, "updateAgentMemory", { id, memoryId: teal.id, text: "Favourite colour: teal." });
  assert.deepEqual([edited[0].text, edited[0].source], ["Favourite colour: teal.", "user"]);

  // With review on, what the agent saves or forgets waits for Approve or Reject.
  await api(server, "updateAgentConfig", { id, memoryReview: true });
  await api(server, "deliverMessage", { agentId: id, prompt: '/tool save_memory {"text":"Likes concise answers."}', clientNonce: "n3" });
  await until(async () => (await memories()).some((saved) => saved.review?.action === "add"));
  await idle();
  const concise = (await memories()).find((saved) => saved.review != null)!;
  const reviewing = await systemPrompt("n4");
  assert.match(reviewing, new RegExp(`\\nWaiting for the user's approval, not in effect yet:\\n- \\[${concise.id}\\] new: Likes concise answers\\.\\n`));
  assert.match(reviewing, /\n- The user reviews your memory/);
  assert.equal((await api<AgentMemory[]>(server, "reviewAgentMemory", { id, memoryId: concise.id, approve: true })).find((saved) => saved.id === concise.id)?.review, null);
  assert.equal((await post(server, "reviewAgentMemory", { id, memoryId: concise.id, approve: true })).status, 409);
  await api(server, "deliverMessage", { agentId: id, prompt: `/tool forget_memory {"id":"${lisbon.id}"}`, clientNonce: "n5" });
  await until(async () => (await memories()).some((saved) => saved.review?.action === "forget"));
  await idle();
  assert.equal((await api<AgentMemory[]>(server, "reviewAgentMemory", { id, memoryId: lisbon.id, approve: false })).find((saved) => saved.id === lisbon.id)?.review, null);

  const remaining = await api<AgentMemory[]>(server, "deleteAgentMemory", { id, memoryId: lisbon.id });
  assert.deepEqual(remaining.map((saved) => saved.text), ["Favourite colour: teal.", "Likes concise answers."]);
  await until(() => JSON.stringify(events[events.length - 1]?.memories) === JSON.stringify(remaining));

  // A restarted box remembers; deleting the agent forgets.
  abort.abort();
  server.close();
  server = await bootBox(dir);
  assert.deepEqual(await api(server, "getAgentMemories", { id }), remaining);
  assert.ok(existsSync(join(dir, "memories", `${id}.json`)));
  await api(server, "removeAgents", { ids: [id] });
  assert.equal(existsSync(join(dir, "memories", `${id}.json`)), false);
});
