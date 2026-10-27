import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type BoxServer, startBoxServer } from "../../src/box-server/server";
import { Harness } from "../../src/box/harness";
import { McpManager } from "../../src/box/mcp";
import { isReactionEmoji, MAX_REACTIONS, MAX_REPLY_QUOTE, MessageActionError, nextFeedback, toggleReaction } from "../../src/box/message-actions";
import { BoxStore } from "../../src/box/store";
import { readSse } from "../../src/shared/gateway-protocol";
import type { AgentSummary, ClaudeCodeStatus, MessageEntry, NoticeEntry, TranscriptEntry, TranscriptEvent } from "../../src/shared/model";

const cleanup: Array<() => void> = [];
after(() => {
  for (const fn of cleanup.reverse()) fn();
});

const TOKEN = randomBytes(24).toString("hex");
const NO_CLAUDE = async (): Promise<ClaudeCodeStatus> => ({ executable: null, installed: false, version: null, signedIn: false, authMethod: null, checkedAt: 1 });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wisp-actions-"));
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

const message = (id: string, seq: number, role: "user" | "assistant", content: string, extra: Partial<MessageEntry> = {}): MessageEntry => ({
  kind: "message", id, seq, turn: seq, step: role === "user" ? 0 : 1, timestampMs: seq * 1_000, role, content, isStreaming: false, ...extra,
});
const notice: NoticeEntry = { kind: "notice", id: "n3", seq: 3, turn: 2, step: 0, timestampMs: 3_000, text: "Stopped.", tone: "info" };

/** A box data folder with one agent and a short conversation: a question, a reply and a notice. */
function seeded(): string {
  const dir = tempDir();
  const store = new BoxStore(dir);
  store.putAgent(agent("a1"));
  for (const entry of [message("m1", 1, "user", "Plot last week’s sales."), message("m2", 2, "assistant", "Here is the plot. Sales rose 12%."), notice]) store.upsertEntry("a1", entry, true);
  store.close();
  return dir;
}

function harnessOn(store: BoxStore) {
  const events: Array<{ channel: string; payload: any }> = [];
  const harness = new Harness({
    store,
    models: () => ({ defaultModel: { provider: "mock", model: "mock-1" }, reasoningEffort: "default", temperature: null, xai: null, openai: null, anthropic: null, custom: null, claudeCode: null }),
    resolveDeps: { chatGptToken: async () => "unused" },
    workspaceRoot: () => join(store.dataDir, "workspaces"),
    localTools: () => [],
    callLocalTool: async () => ({ kind: "error", message: "no local tools" }),
    mcp: new McpManager(() => undefined, () => undefined),
    claudeCode: null,
    cloud: null,
    cloudConfig: () => null,
    emit: (channel, payload) => events.push({ channel, payload }),
    log: () => undefined,
  });
  return { harness, events };
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

/** Every transcript event the box sends from now on. */
async function transcriptEvents(server: BoxServer): Promise<TranscriptEvent[]> {
  const abort = new AbortController();
  cleanup.push(() => abort.abort());
  const events: TranscriptEvent[] = [];
  const stream = await fetch(`${server.url}/events`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: abort.signal });
  void (async () => {
    for await (const block of readSse(stream.body!, abort.signal)) {
      if (block.data == null) continue;
      const { channel, payload } = JSON.parse(block.data);
      if (channel === "transcript") events.push(payload);
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

const tail = async (server: BoxServer) => (await api<{ entries: TranscriptEntry[] }>(server, "readTranscriptEnd", { id: "a1", limit: 50 })).entries;
const byId = (entries: TranscriptEntry[], id: string) => entries.find((entry) => entry.id === id)!;

test("reactions are single emoji, toggled per person, on messages that are written", () => {
  for (const emoji of ["👍", "❤️", "👍🏽", "🇯🇵", "1️⃣", "👨‍👩‍👧", "✅"]) assert.equal(isReactionEmoji(emoji), true, emoji);
  for (const text of ["", "a", ":)", "👍👍", "ok 👍", "👍 ", "<b>", "❤".repeat(40)]) assert.equal(isReactionEmoji(text), false, JSON.stringify(text));

  const reply = message("m2", 2, "assistant", "Done.");
  const once = toggleReaction(reply, "👍", "user");
  assert.deepEqual(once, [{ emoji: "👍", by: "user" }]);
  const twice = toggleReaction({ ...reply, reactions: once }, "🎉", "user");
  assert.deepEqual(twice.map((reaction) => reaction.emoji), ["👍", "🎉"], "kept in the order added");
  assert.deepEqual(toggleReaction({ ...reply, reactions: twice }, "👍", "user"), [{ emoji: "🎉", by: "user" }], "the same emoji again takes it back");
  // Someone else's reaction with the same emoji stays when the user adds theirs.
  assert.deepEqual(toggleReaction({ ...reply, reactions: [{ emoji: "👍", by: "teammate" }] }, "👍", "user").length, 2);

  const full = { ...reply, reactions: [..."😀😁😂🤣😃😄😅😆😉😊😋😎😍😘🥰😗😙😚🙂🤗"].map((emoji) => ({ emoji, by: "user" })) };
  assert.equal(new Set(full.reactions.map((reaction) => reaction.emoji)).size, MAX_REACTIONS);
  assert.throws(() => toggleReaction(full, "🔥", "user"), (error: MessageActionError) => error.code === "invalid");
  assert.equal(toggleReaction(full, "😀", "user").length, MAX_REACTIONS - 1, "one can still be taken back");

  assert.throws(() => toggleReaction({ ...reply, isStreaming: true }, "👍", "user"), (error: MessageActionError) => error.code === "streaming");
  assert.throws(() => toggleReaction(notice, "👍", "user"), (error: MessageActionError) => error.code === "unsupported");
  assert.throws(() => toggleReaction(reply, "nice", "user"), (error: MessageActionError) => error.code === "invalid");
});

test("feedback: Good settles, Bad waits for its reasons, submit and revert", () => {
  const reply = message("m2", 2, "assistant", "Done.");
  assert.deepEqual(nextFeedback(reply, "up", [], undefined, 5), { sentiment: "up", state: "voted", categories: [], votedAt: 5 });
  const bad = nextFeedback(reply, "down", [], undefined, 6)!;
  assert.deepEqual(bad, { sentiment: "down", state: "improve", categories: [], votedAt: 6 });
  // The reasons come back in the card's order, whatever order they were picked in.
  const submitted = nextFeedback({ ...reply, feedback: bad }, "submit", ["Too slow", "Not what I asked"], "  It missed the chart.  ", 7)!;
  assert.deepEqual(submitted, { sentiment: "down", state: "voted", categories: ["Not what I asked", "Too slow"], comment: "It missed the chart.", votedAt: 7 });
  assert.deepEqual(nextFeedback({ ...reply, feedback: submitted }, "down", [], undefined, 8), { sentiment: "down", state: "improve", categories: ["Not what I asked", "Too slow"], comment: "It missed the chart.", votedAt: 8 }, "Bad again reopens the reasons");
  assert.equal(nextFeedback({ ...reply, feedback: submitted }, "revert"), undefined);

  assert.throws(() => nextFeedback({ ...reply, feedback: bad }, "submit", ["Rude"]), (error: MessageActionError) => error.code === "invalid");
  assert.throws(() => nextFeedback(reply, "submit", ["Inaccurate"]), (error: MessageActionError) => error.code === "invalid", "nothing to submit before a vote");
  assert.throws(() => nextFeedback({ ...reply, feedback: nextFeedback(reply, "up") }, "submit", ["Inaccurate"]), (error: MessageActionError) => error.code === "invalid", "reasons go with Bad");
  assert.throws(() => nextFeedback(message("m1", 1, "user", "Hi"), "up"), (error: MessageActionError) => error.code === "unsupported");
  assert.throws(() => nextFeedback({ ...reply, isStreaming: true }, "up"), (error: MessageActionError) => error.code === "streaming");
});

test("gateway: reactions and votes change the stored entry, arrive as ordered `updated` events and survive a restart", async () => {
  const dir = seeded();
  const server = await bootBox(dir);
  const events = await transcriptEvents(server);
  await api(server, "readBoxStatus", {}); // the event stream is open once a later request has been served

  assert.equal(await api(server, "setReaction", { agentId: "a1", entryId: "m2", emoji: "👍" }), null);
  await api(server, "setReaction", { agentId: "a1", entryId: "m1", emoji: "🎉" });
  await api(server, "setReaction", { agentId: "a1", entryId: "m2", emoji: "❤️" });
  await api(server, "setReaction", { agentId: "a1", entryId: "m2", emoji: "👍" });
  await api(server, "rateReply", { agentId: "a1", entryId: "m2", action: "down" });
  await api(server, "rateReply", { agentId: "a1", entryId: "m2", action: "submit", categories: ["Inaccurate"], comment: "The number is off." });

  // Refusals change nothing and send nothing.
  assert.equal((await post(server, "setReaction", { agentId: "a1", entryId: "m2", emoji: "nice" })).status, 400);
  assert.equal((await post(server, "setReaction", { agentId: "a1", entryId: "n3", emoji: "👍" })).status, 400);
  assert.equal((await post(server, "setReaction", { agentId: "a1", entryId: "gone", emoji: "👍" })).status, 404);
  assert.equal((await post(server, "setReaction", { agentId: "nobody", entryId: "m2", emoji: "👍" })).status, 404);
  assert.equal((await post(server, "rateReply", { agentId: "a1", entryId: "m1", action: "up" })).status, 400);
  assert.equal((await post(server, "rateReply", { agentId: "a1", entryId: "m2", action: "submit", categories: ["Rude"] })).status, 400);
  assert.equal((await post(server, "rateReply", { agentId: "a1", entryId: "m2", action: "maybe" })).status, 400);

  await until(() => events.length >= 6);
  await api(server, "readBoxStatus", {});
  assert.equal(events.length, 6, JSON.stringify(events.map((event) => event.type)));
  assert.ok(events.every((event) => event.type === "updated"), "entries that already existed change through `updated`");
  const stamps = events.map((event) => event.ordered);
  assert.ok(stamps.every((stamp) => stamp.epoch === stamps[0].epoch && stamp.replicaKey === "transcript:a1"));
  stamps.forEach((stamp, index) => index > 0 && assert.equal(stamp.sequence, stamps[index - 1].sequence + 1, "one sequence step per event"));
  const updates = events.map((event) => (event.type === "updated" ? event.entry : null)) as MessageEntry[];
  assert.deepEqual(
    updates.map((entry) => [entry.id, (entry.reactions ?? []).map((reaction) => reaction.emoji).join(""), entry.feedback?.state ?? ""]),
    [["m2", "👍", ""], ["m1", "🎉", ""], ["m2", "👍❤️", ""], ["m2", "❤️", ""], ["m2", "❤️", "improve"], ["m2", "❤️", "voted"]],
  );

  const check = (entries: TranscriptEntry[]) => {
    const reply = byId(entries, "m2") as MessageEntry;
    assert.deepEqual(reply.reactions, [{ emoji: "❤️", by: "user" }]);
    assert.deepEqual([reply.feedback?.sentiment, reply.feedback?.state, reply.feedback?.categories, reply.feedback?.comment], ["down", "voted", ["Inaccurate"], "The number is off."]);
    assert.deepEqual(byId(entries, "m1").reactions, [{ emoji: "🎉", by: "user" }]);
    assert.equal(byId(entries, "n3").reactions, undefined);
    assert.deepEqual(entries.map((entry) => entry.seq), [1, 2, 3], "nothing reordered or added");
  };
  check(await tail(server));

  // A restart reads the log back, newest line per entry; a change then is still an `updated` event, in a new epoch.
  server.close();
  const lines = readFileSync(join(dir, "transcripts", "a1.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 3 + 6, "each change is one more line in the log");
  const restarted = await bootBox(dir);
  check(await tail(restarted));
  const later = await transcriptEvents(restarted);
  await api(restarted, "readBoxStatus", {});
  await api(restarted, "rateReply", { agentId: "a1", entryId: "m2", action: "revert" });
  await until(() => later.length === 1);
  assert.equal(later[0].type, "updated");
  assert.notEqual(later[0].ordered.epoch, stamps[0].epoch);
  assert.equal((byId(await tail(restarted), "m2") as MessageEntry).feedback, undefined);
});

test("the model never sees reactions or votes: its conversation stays the same", () => {
  const store = new BoxStore(seeded());
  cleanup.push(() => store.close());
  const { harness, events } = harnessOn(store);
  const before = JSON.stringify(harness.buildConversation("a1"));
  harness.annotate("a1", "m2", (entry) => {
    entry.reactions = toggleReaction(entry, "🔥", "user");
  });
  harness.annotate("a1", "m2", (entry) => {
    if (entry.kind === "message") entry.feedback = nextFeedback(entry, "up");
  });
  assert.equal(JSON.stringify(harness.buildConversation("a1")), before);
  assert.deepEqual(events.filter((event) => event.channel === "transcript").map((event) => event.payload.type), ["updated", "updated"]);

  // A reply still being written can't take one yet; nothing is sent.
  store.upsertEntry("a1", message("m4", 4, "assistant", "Work", { isStreaming: true }), false);
  assert.throws(
    () => harness.annotate("a1", "m4", (entry) => void toggleReaction(entry, "👍", "user")),
    (error: MessageActionError) => error.code === "streaming",
  );
  assert.throws(() => harness.annotate("a1", "nope", () => undefined), (error: MessageActionError) => error.code === "missing");
  assert.equal(events.filter((event) => event.channel === "transcript").length, 2);
});

test("a reply keeps its quote, who wrote it and the entry it answers, and the model reads the quote first", async () => {
  const store = new BoxStore(seeded());
  cleanup.push(() => store.close());
  const { harness } = harnessOn(store);
  const send = (prompt: string, extra: { replyToId?: string; replyQuote?: string }, nonce: string) =>
    harness.submitPrompt("a1", { prompt, attachmentPaths: [], attachmentNames: [], clientNonce: nonce, source: "user", ...extra });
  const sent = (nonce: string) => store.entries("a1").find((entry): entry is MessageEntry => entry.kind === "message" && entry.clientNonce === nonce)!;

  send("Which week was that?", { replyToId: "m2", replyQuote: "Sales rose 12%." }, "r1");
  assert.deepEqual([sent("r1").replyTo, sent("r1").replyRole, sent("r1").replyQuote], ["m2", "assistant", "Sales rose 12%."]);
  await until(() => !harness.isRunning("a1"));
  const prompt = (nonce: string) => {
    const item = harness.buildConversation("a1").find((candidate) => candidate.kind === "user" && candidate.parts.some((part) => part.type === "text" && part.text.includes(sent(nonce).content)));
    return item?.kind === "user" && item.parts[0].type === "text" ? item.parts[0].text : "";
  };
  assert.match(prompt("r1"), /^\[Sent [^\]]+\]\n\[Replying to your message:\]\n> Sales rose 12%\.\n\nWhich week was that\?$/);
  const reply = store.entries("a1").filter((entry): entry is MessageEntry => entry.kind === "message" && entry.role === "assistant").pop()!;
  assert.match(reply.content, /Replying to your message/, "the mock model got the quote with the prompt");

  // No quote sent: the start of the message replied to. A quote of the user's own message says so.
  send("And this?", { replyToId: "m1" }, "r2");
  assert.deepEqual([sent("r2").replyQuote, sent("r2").replyRole], ["Plot last week’s sales.", "user"]);
  await until(() => !harness.isRunning("a1"));
  assert.match(prompt("r2"), /\[Replying to my earlier message:\]\n> Plot last week’s sales\.\n\nAnd this\?$/);

  // A message the box no longer has: the quote stays, the link doesn't. Long quotes are cut.
  send("Still true?", { replyToId: "gone", replyQuote: `${"0123456789".repeat(300)}\nsecond line` }, "r3");
  assert.equal(sent("r3").replyTo, undefined);
  assert.equal(sent("r3").replyQuote!.length, MAX_REPLY_QUOTE);
  assert.ok(sent("r3").replyQuote!.endsWith("…"));
  await until(() => !harness.isRunning("a1"));
  assert.match(prompt("r3"), /\[Replying to an earlier message:\]\n> 01234567890123/);

  // A plain message has no reply fields.
  send("Thanks!", {}, "r4");
  assert.deepEqual([sent("r4").replyTo, sent("r4").replyQuote, sent("r4").replyRole], [undefined, undefined, undefined]);
  await until(() => !harness.isRunning("a1"));
});

test("gateway: a reply sent with deliverMessage (the schema the coordinator also checks) reaches the mock model", async () => {
  const server = await bootBox(seeded());
  await api(server, "deliverMessage", { agentId: "a1", prompt: "Why?", clientNonce: "g1", replyToId: "m2", replyQuote: "Sales rose 12%." });
  await until(async () => (await tail(server)).some((entry) => entry.kind === "message" && entry.role === "assistant" && !entry.isStreaming && /Replying to your message/.test(entry.content)));
  const question = (await tail(server)).find((entry): entry is MessageEntry => entry.kind === "message" && entry.clientNonce === "g1")!;
  assert.deepEqual([question.replyTo, question.replyQuote, question.replyRole], ["m2", "Sales rose 12%.", "assistant"]);
  assert.equal((await post(server, "deliverMessage", { agentId: "a1", prompt: "x", replyQuote: "q".repeat(4001) })).status, 400);
});
