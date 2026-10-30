// Group chats. A room is a roster row with `isGroup` and
// `memberIds`; its own transcript (its main session) is what the user sees, and it has no model of
// its own. Each member keeps a private `group:<roomId>` session: its own system prompt with a room
// section (the room's name, the other members, how to @mention them, that it may pass) and, each
// turn, one user message carrying the room's new messages since its last turn, each labelled with
// its author. So every member keeps its provider's prompt cache and its own reasoning replay, and
// members on different models and providers share a room; a Claude Code member gets a Claude Code
// session per room.
//
// This orchestrator is the rooms' turn policy:
// - A person's message gives a turn to the members it @mentions, in the order they're mentioned;
//   "@everyone" gives every member one. With no mention, every member gets a turn, in the room's order.
// - A member passes by replying "[pass]" (or nothing). A pass is never posted.
// - A member's post that @mentions another member gives that one a turn next: one bot hop more.
// - Per person's message, at most 3 bot hops and twice as many posts as members. A member on the
//   last hop or with the last post is told it's winding down,
//   and its mentions start nothing.
// - Each turn has a deadline; time spent waiting for the user's approval or answer doesn't count.
// - Turns run one at a time and end SENT, PASS, SKIPPED, TIMEOUT, CANCELLED or ERROR, as the room
//   row's `groupTurns` say; `activeGroupMemberId` names the member taking its turn. A message sent
//   meanwhile skips the turns still waiting, and the next round answers it once the current turn ends.
// - Stop interrupts every member's turn in the room and says "Stopped." at once; a message sent
//   while the stopped turn winds down (or into a room started fresh) starts the next round.
// - A member whose background command ended gets a turn to say so (rooms are woken through it).
// A member's approval and ask_user cards are copied into the room, marked with who asked, and
// answered in that member's session; so are the pages and visualizations it makes. Each copy
// follows the member's card.
import { type AgentGroupTurn, type AgentSummary, type EventEntry, groupSessionId, type GroupTurnOutcome, MAIN_SESSION, type MessageEntry, type NoticeEntry, roomIdOf, type SendMessageEntry, type TranscriptEntry } from "../shared/model";
import type { ActivityPayload, Harness, SessionHooks, SessionLiveState } from "./harness";
import { clipQuote, quoteOf, replyRoleOf } from "./message-actions";
import type { BoxStore } from "./store";

export const MAX_BOT_HOPS = 3;
export const MAX_GROUP_MEMBERS = 8;
const DEFAULT_DEADLINE_MS = 180_000;
/** The most room messages one turn's message carries. */
const BATCH_LIMIT = 40;
const PASS = /^\[?pass\]?\.?$/i;
const WINDING_DOWN = "[This is the last bot turn for now: answer without @mentioning anyone.]";
/**
 * The cards a member's room session shows that the room shows too, marked with who: approvals and
 * questions (answered in the member's session), and the pages and visualizations it made (a page's
 * copy follows its card as the page changes).
 */
const COPIED_CARDS = new Set<SendMessageEntry["message"]["type"]>(["local-tool-permission", "widget", "page", "visualization"]);

const preview = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 200);

export class RoomError extends Error {
  constructor(
    readonly code: "invalid" | "missing",
    message: string,
  ) {
    super(message);
    this.name = "RoomError";
  }
}

export interface RoomsDeps {
  store: BoxStore;
  harness(): Harness;
  /** A new roster row, as addAgent makes one. */
  newRow(input: { name: string; description: string }): AgentSummary;
  emit(channel: string, payload: unknown): void;
  log(line: string): void;
  /** How long a member's turn may take, waiting for the user aside. */
  deadlineMs?: number;
}

interface Turn {
  memberId: string;
  hop: number;
  running: boolean;
  outcome?: GroupTurnOutcome;
  /** The member was told something in its room session (a background command ended), which it answers even with no new message. */
  woken?: boolean;
}

interface Round {
  /** The person's message it answers; null for a member woken by its own background command. */
  trigger: MessageEntry | null;
  turns: Turn[];
  posts: number;
  maxPosts: number;
  stopped: boolean;
  /** Stopped to start the room fresh or delete it: nothing more is posted. */
  silent: boolean;
  /** A message sent while this round ran, or after it was stopped: the next round answers it. */
  next: MessageEntry | null;
  active: Turn | null;
  lastPost: string | null;
  failed: boolean;
}

type TurnResult = { outcome: Exclude<GroupTurnOutcome, "SENT" | "SKIPPED"> ; error?: string } | { outcome: "SENT"; text: string };

/**
 * The members a message @mentions, in the order mentioned; every member for "@everyone". A name
 * matches in any case when it ends there (`@Scout,` but not `@Scouting`), longer names first.
 */
export function mentionedMembers(text: string, members: Array<Pick<AgentSummary, "id" | "name">>): string[] {
  const lower = text.toLowerCase();
  const word = /[\p{L}\p{N}_]/u;
  const byLength = members.filter((member) => member.name.trim().length > 0).sort((a, b) => b.name.length - a.name.length);
  const found: string[] = [];
  for (let at = lower.indexOf("@"); at >= 0; at = lower.indexOf("@", at + 1)) {
    if (at > 0 && word.test(lower[at - 1])) continue; // an email address
    const rest = lower.slice(at + 1);
    if (/^everyone(?![\p{L}\p{N}_])/u.test(rest)) return members.map((member) => member.id);
    const member = byLength.find((candidate) => rest.startsWith(candidate.name.toLowerCase()) && !word.test(rest.charAt(candidate.name.length)));
    if (member != null && !found.includes(member.id)) found.push(member.id);
  }
  return found;
}

export class Rooms {
  /** Running rounds, by room. */
  private rounds = new Map<string, Round>();
  /** Members' live state in their room sessions, by `<roomId>\0<memberId>`. */
  private memberLive = new Map<string, SessionLiveState>();
  /** The room's copy of a member's card, by `<roomId>\0<memberId>\0<entryId>`. */
  private copies = new Map<string, string>();

  /** What members' room sessions add to the harness: the room section, live state, cards, notifications and wakes. */
  readonly hooks: SessionHooks = {
    instructions: (agentId, sessionId) => this.instructions(agentId, sessionId),
    live: (agentId, sessionId, live) => this.memberLiveChanged(agentId, sessionId, live),
    entry: (agentId, sessionId, entry) => this.copyCard(agentId, sessionId, entry),
    activity: (agentId, sessionId, payload) => this.memberActivity(agentId, sessionId, payload),
    wake: (agentId, sessionId) => this.memberWoken(agentId, sessionId),
  };

  constructor(private readonly deps: RoomsDeps) {
    this.recover();
  }

  private get store(): BoxStore {
    return this.deps.store;
  }

  private get harness(): Harness {
    return this.deps.harness();
  }

  isRoom(id: string): boolean {
    return this.store.getAgent(id)?.isGroup === true;
  }

  /** Whether a round is running in the room. */
  isRunning(roomId: string): boolean {
    return this.rounds.has(roomId);
  }

  // ---- rooms and members --------------------------------------------------------------

  /** A new room of these bots (two or more); with a nonce, a resend returns the same room. */
  makeGroupChat(input: { name: string; description?: string; memberAgentIds: string[]; clientNonce?: string }): AgentSummary {
    const members = this.checkMembers(input.memberAgentIds);
    if (input.clientNonce != null) {
      const existing = this.store.rosterAgents().find((row) => row.isGroup && (row as AgentSummary & { createNonce?: string }).createNonce === input.clientNonce);
      if (existing != null) return existing;
    }
    const name = input.name.trim().length > 0 ? input.name.trim() : members.map((member) => member.name).join(", ").slice(0, 80);
    const row = this.store.putAgent({
      ...this.deps.newRow({ name, description: input.description?.trim() ?? "" }),
      isGroup: true,
      memberIds: members.map((member) => member.id),
      ...(input.clientNonce != null ? { createNonce: input.clientNonce } : {}),
    } as AgentSummary);
    this.deps.emit("agent-saved", { agent: row, ordered: this.store.rosterStamp() });
    this.harness.append<EventEntry>(row.id, MAIN_SESSION, { kind: "event", event: { type: "members-changed", added: members.map((member) => member.name), removed: [] } });
    return this.store.getAgent(row.id) ?? row;
  }

  /** The room's bots now (two or more): those who leave stop their turn, and their room session stays for if they come back. */
  setMembers(roomId: string, memberAgentIds: string[]): AgentSummary {
    const room = this.requireRoom(roomId);
    const members = this.checkMembers(memberAgentIds);
    const ids = members.map((member) => member.id);
    const added = members.filter((member) => !room.memberIds.includes(member.id));
    const removed = room.memberIds.filter((id) => !ids.includes(id));
    if (added.length === 0 && removed.length === 0 && ids.join() === room.memberIds.join()) return room;
    for (const id of removed) this.harness.interrupt(id, groupSessionId(roomId));
    const next = this.harness.patchAgent(roomId, { memberIds: ids }) ?? room;
    if (added.length > 0 || removed.length > 0) {
      this.harness.append<EventEntry>(roomId, MAIN_SESSION, { kind: "event", event: { type: "members-changed", added: added.map((member) => member.name), removed: removed.map((id) => this.store.getAgent(id)?.name ?? "A bot") } });
    }
    return next;
  }

  /** Before an agent is deleted: it leaves every room it's in (a room may be left with one bot). */
  memberDeleted(agentId: string): void {
    for (const room of this.store.rosterAgents()) {
      if (!room.isGroup || !room.memberIds.includes(agentId)) continue;
      const name = this.store.getAgent(agentId)?.name ?? "A bot";
      this.harness.patchAgent(room.id, { memberIds: room.memberIds.filter((id) => id !== agentId) });
      this.harness.append<EventEntry>(room.id, MAIN_SESSION, { kind: "event", event: { type: "members-changed", added: [], removed: [name] } });
    }
  }

  /** Before a room is deleted: its round stops and every member's room session goes. Its members stay. */
  deleteRoom(roomId: string): void {
    this.halt(roomId);
    this.forgetSessions(roomId, (agentId, sessionId) => this.harness.deleteSession(agentId, sessionId));
  }

  /** Clears the room's conversation and each member's room session. */
  startFresh(roomId: string): void {
    this.requireRoom(roomId);
    this.halt(roomId);
    this.harness.startFresh(roomId);
    this.forgetSessions(roomId, (agentId, sessionId) => this.harness.startFresh(agentId, sessionId));
    this.harness.patchAgent(roomId, { groupTurns: undefined, activeGroupMemberId: undefined });
  }

  /** Stops the round without a word, and drops what it would have answered next (the room is cleared or deleted). */
  private halt(roomId: string): void {
    const round = this.rounds.get(roomId);
    if (round == null) return;
    round.silent = true;
    round.next = null;
    this.stop(roomId);
  }

  private forgetSessions(roomId: string, each: (agentId: string, sessionId: string) => void): void {
    const sessionId = groupSessionId(roomId);
    for (const key of [...this.copies.keys()]) if (key.startsWith(`${roomId}\u0000`)) this.copies.delete(key);
    for (const key of [...this.memberLive.keys()]) if (key.startsWith(`${roomId}\u0000`)) this.memberLive.delete(key);
    for (const agent of this.store.rosterAgents()) if (this.store.sessionIds(agent.id).includes(sessionId)) each(agent.id, sessionId);
  }

  private requireRoom(roomId: string): AgentSummary {
    const room = this.store.getAgent(roomId);
    if (room == null || !room.isGroup) throw new RoomError("missing", "That group chat isn’t there any more.");
    return room;
  }

  private checkMembers(ids: string[]): AgentSummary[] {
    const unique = [...new Set(ids)];
    if (unique.length < 2) throw new RoomError("invalid", "A group chat needs at least two bots.");
    if (unique.length > MAX_GROUP_MEMBERS) throw new RoomError("invalid", `A group chat has at most ${MAX_GROUP_MEMBERS} bots.`);
    return unique.map((id) => {
      const agent = this.store.getAgent(id);
      if (agent == null) throw new RoomError("invalid", "One of those bots isn’t there any more.");
      if (agent.isGroup) throw new RoomError("invalid", "A group chat can’t be a member of another.");
      return agent;
    });
  }

  /** The room's members that are still bots, in the room's order. */
  private members(room: AgentSummary): AgentSummary[] {
    return room.memberIds.flatMap((id) => {
      const agent = this.store.getAgent(id);
      return agent != null && !agent.isGroup ? [agent] : [];
    });
  }

  // ---- messages and rounds ----------------------------------------------------------------

  /** The person's message in the room; false when its nonce was already accepted. A reply keeps its quote. */
  post(roomId: string, input: { prompt: string; clientNonce: string | null; replyToId?: string | null; replyQuote?: string | null }): boolean {
    const room = this.requireRoom(roomId);
    const nonce = input.clientNonce;
    if (nonce != null && this.store.entries(roomId).some((entry) => entry.kind === "message" && entry.role === "user" && entry.clientNonce === nonce)) return false;
    const replied = input.replyToId != null ? this.store.entry(roomId, input.replyToId) : undefined;
    const quote = clipQuote(input.replyQuote != null && input.replyQuote.trim().length > 0 ? input.replyQuote : replied != null ? quoteOf(replied) : "");
    const message = this.harness.append<MessageEntry>(roomId, MAIN_SESSION, {
      kind: "message",
      role: "user",
      content: input.prompt,
      isStreaming: false,
      ...(nonce != null ? { clientNonce: nonce } : {}),
      source: "user",
      ...(quote.length > 0 ? { replyQuote: quote, ...(replied != null ? { replyTo: replied.id, replyRole: replyRoleOf(replied) } : {}) } : {}),
    });
    this.harness.patchAgent(roomId, { lastEntry: { kind: "text", text: preview(input.prompt) }, lastMessagePreview: preview(input.prompt), lastMessageId: message.id, newestEntryId: message.id, lastActivityAt: Date.now() });
    const round = this.rounds.get(roomId);
    if (round != null) round.next = message;
    else if (this.members(room).length > 0) void this.run(roomId, message);
    return true;
  }

  /**
   * Stops every member's turn in the room; false when none was running. "Stopped." is posted now,
   * before anything sent while the turn under way winds down, which the next round answers.
   */
  stop(roomId: string): boolean {
    const round = this.rounds.get(roomId);
    if (round == null || round.stopped) return false;
    round.stopped = true;
    round.next = null;
    if (!round.silent) this.notice(roomId, "Stopped.", "info");
    const sessionId = groupSessionId(roomId);
    const room = this.store.getAgent(roomId);
    for (const id of new Set([...(room?.memberIds ?? []), ...(round.active != null ? [round.active.memberId] : [])])) this.harness.interrupt(id, sessionId);
    return true;
  }

  shutdown(): void {
    for (const roomId of [...this.rounds.keys()]) this.halt(roomId);
  }

  /**
   * A member's background command ended in its room session: it gets a turn to say so, the next
   * one if a round is running. True: the harness leaves the session to the room.
   */
  private memberWoken(agentId: string, sessionId: string): boolean {
    const roomId = roomIdOf(sessionId);
    if (roomId == null) return false;
    const room = this.store.getAgent(roomId);
    if (room == null || !room.isGroup || !room.memberIds.includes(agentId)) return true; // it isn't in the room any more: the message waits there
    const round = this.rounds.get(roomId);
    if (round == null) {
      void this.run(roomId, null, agentId);
      return true;
    }
    if (!round.stopped && !round.turns.some((turn) => turn.memberId === agentId && turn.outcome == null && !turn.running)) {
      round.turns.push({ memberId: agentId, hop: 0, running: false, woken: true });
      this.publish(roomId);
    }
    return true;
  }

  /** The member's room session ends with a message it hasn't answered (what it was told quietly). */
  private unanswered(roomId: string, memberId: string): boolean {
    return this.store.entries(memberId, groupSessionId(roomId)).findLast((entry) => entry.kind === "message")?.role === "user";
  }

  /** A round answering the person's message, or, with no message, a turn for the member that was woken. */
  private async run(roomId: string, trigger: MessageEntry | null, woken?: string): Promise<void> {
    const room = this.store.getAgent(roomId);
    if (room == null) return;
    const members = this.members(room);
    const mentioned = trigger != null ? mentionedMembers(trigger.content, members) : [];
    const round: Round = {
      trigger,
      turns:
        trigger == null
          ? woken != null
            ? [{ memberId: woken, hop: 0, running: false, woken: true }]
            : []
          : (mentioned.length > 0 ? mentioned : members.map((member) => member.id)).map((memberId) => ({ memberId, hop: 0, running: false })),
      posts: 0,
      maxPosts: 2 * members.length,
      stopped: false,
      silent: false,
      next: null,
      active: null,
      lastPost: null,
      failed: false,
    };
    this.rounds.set(roomId, round);
    this.publish(roomId);
    try {
      for (let index = 0; index < round.turns.length; index++) {
        const turn = round.turns[index];
        const current = this.store.getAgent(roomId);
        const member = this.store.getAgent(turn.memberId);
        if (round.stopped) {
          turn.outcome = "CANCELLED";
          continue;
        }
        const batch = current != null && member != null && current.memberIds.includes(member.id) ? this.batch(roomId, current, member) : null;
        // A woken member answers what it was told even with nothing new in the room.
        const told = turn.woken === true && member != null && current?.memberIds.includes(member.id) === true && this.unanswered(roomId, member.id);
        if (round.next != null || round.posts >= round.maxPosts || current == null || member == null || (batch == null && !told)) {
          turn.outcome = "SKIPPED";
          continue;
        }
        const windingDown = turn.hop >= MAX_BOT_HOPS || round.posts + 1 >= round.maxPosts;
        turn.running = true;
        round.active = turn;
        this.publish(roomId);
        const result = await this.take(roomId, member, batch, windingDown);
        turn.running = false;
        round.active = null;
        this.memberLive.delete(`${roomId}\u0000${member.id}`);
        // Stopped while it answered: nothing more is posted after "Stopped.".
        turn.outcome = round.stopped ? "CANCELLED" : result.outcome;
        if (round.stopped) {
          this.publish(roomId);
          continue;
        }
        if (result.outcome === "SENT") {
          round.posts++;
          this.postReply(roomId, member, result.text);
          round.lastPost = `${member.name}: ${preview(result.text)}`;
          if (!windingDown) {
            // Those it asked answer next, unless a turn of theirs is still to come.
            const asked = mentionedMembers(result.text, this.members(this.store.getAgent(roomId) ?? current)).filter((id) => id !== member.id);
            const waiting = new Set(round.turns.slice(index + 1).map((later) => later.memberId));
            round.turns.splice(index + 1, 0, ...asked.filter((id) => !waiting.has(id)).map((memberId) => ({ memberId, hop: turn.hop + 1, running: false })));
          }
        } else if (result.outcome === "TIMEOUT") {
          this.notice(roomId, `${member.name} didn’t answer in time.`, "info");
        } else if (result.outcome === "ERROR") {
          round.failed = true;
          this.notice(roomId, `${member.name} couldn’t answer: ${result.error ?? "the turn failed."}`, "error");
        }
        this.publish(roomId);
      }
    } catch (error) {
      round.failed = true;
      this.deps.log(`room ${roomId} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      for (const turn of round.turns) turn.outcome ??= round.stopped ? "CANCELLED" : "SKIPPED";
      this.rounds.delete(roomId);
      this.settle(roomId, round);
      // Stop dropped what was waiting; what came after it, also into a room started fresh, is answered now.
      if (round.next != null) void this.run(roomId, round.next);
    }
  }

  /** The room's new messages since the member's last turn, each after its author's name; null when there are none. */
  private batch(roomId: string, room: AgentSummary, member: AgentSummary): { text: string; throughSeq: number } | null {
    const seen = Math.max(0, ...this.store.entries(member.id, groupSessionId(roomId)).flatMap((entry) => (entry.kind === "message" && entry.role === "user" && entry.roomThroughSeq != null ? [entry.roomThroughSeq] : [])));
    const entries = this.store.entries(roomId);
    const fresh = entries.filter((entry): entry is MessageEntry => entry.kind === "message" && entry.seq > seen && entry.content.trim().length > 0 && entry.fromAgent?.id !== member.id && (entry.role === "user" || entry.fromAgent != null));
    if (fresh.length === 0) return null;
    const lines = fresh.slice(-BATCH_LIMIT).map((entry) => {
      const author = entry.role === "user" ? "User" : entry.fromAgent!.name;
      const replying = entry.replyQuote != null ? ` (replying to “${entry.replyQuote.replace(/\s+/g, " ").slice(0, 200)}”)` : "";
      return `${author}${replying}: ${entry.content.trim().replace(/\n/g, "\n  ")}`;
    });
    const header = fresh.length > BATCH_LIMIT ? `[Group chat “${room.name}”: the newest ${BATCH_LIMIT} of ${fresh.length} new messages]` : `[Group chat “${room.name}”: new messages]`;
    return { text: [header, ...lines].join("\n"), throughSeq: entries[entries.length - 1]?.seq ?? seen };
  }

  /** One member's turn: its session reads the batch and answers, within the deadline. */
  private async take(roomId: string, member: AgentSummary, batch: { text: string; throughSeq: number } | null, windingDown: boolean): Promise<TurnResult> {
    const sessionId = groupSessionId(roomId);
    const harness = this.harness;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    const arm = () => {
      timer = setTimeout(() => {
        // Waiting for the user's approval or answer doesn't count against the deadline.
        if (harness.isAwaiting(member.id, sessionId)) return arm();
        timedOut = true;
        harness.interrupt(member.id, sessionId);
      }, this.deps.deadlineMs ?? DEFAULT_DEADLINE_MS);
    };
    arm();
    let turn;
    try {
      // Nothing new in the room: a woken member answers what it was told in its session.
      turn =
        batch == null
          ? await harness.resumeTurn(member.id, sessionId)
          : await harness.runTurn(member.id, sessionId, {
              prompt: windingDown ? `${batch.text}\n\n${WINDING_DOWN}` : batch.text,
              attachmentPaths: [],
              attachmentNames: [],
              clientNonce: null,
              source: "user",
              roomThroughSeq: batch.throughSeq,
            });
    } catch (error) {
      return { outcome: "ERROR", error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (timer != null) clearTimeout(timer);
    }
    if (turn.outcome === "cancelled") return { outcome: timedOut ? "TIMEOUT" : "CANCELLED" };
    if (turn.outcome === "error") return { outcome: "ERROR", error: turn.error };
    const said = turn.texts.join("\n\n").trim();
    // A pass on its own line ends the post too: what came before it is still said.
    const text = said.replace(/(?:^|\n)\s*\[pass\]\.?\s*$/i, "").trim();
    if (text.length === 0 || PASS.test(text)) return { outcome: "PASS" };
    return { outcome: "SENT", text };
  }

  private postReply(roomId: string, member: AgentSummary, text: string): void {
    const entry = this.harness.append<MessageEntry>(roomId, MAIN_SESSION, { kind: "message", role: "assistant", content: text, isStreaming: false, fromAgent: { id: member.id, name: member.name, kind: "agent" } });
    const row = this.store.getAgent(roomId);
    const line = preview(`${member.name}: ${text}`);
    this.harness.patchAgent(roomId, { lastEntry: { kind: "text", text: line }, lastMessagePreview: line, lastMessageId: entry.id, newestEntryId: entry.id, lastActivityAt: Date.now(), hasUnread: true, unreadCount: (row?.unreadCount ?? 0) + 1 });
  }

  private notice(roomId: string, text: string, tone: NonNullable<NoticeEntry["tone"]>): void {
    this.harness.append<NoticeEntry>(roomId, MAIN_SESSION, { kind: "notice", text, tone });
  }

  // ---- the room's row ----------------------------------------------------------------------

  private turnsOf(roomId: string, round: Round): AgentGroupTurn[] {
    return round.turns.map((turn) => {
      const live = turn.running ? this.memberLive.get(`${roomId}\u0000${turn.memberId}`) : undefined;
      return {
        roomId,
        memberId: turn.memberId,
        hop: turn.hop,
        isComposingMessage: live?.isComposingMessage === true,
        isRunningTurn: turn.running,
        ...(live?.currentActivity != null ? { currentActivity: live.currentActivity } : {}),
        ...(turn.outcome != null ? { outcome: turn.outcome } : {}),
      };
    });
  }

  /** The round as the room's row shows it: who has the turn, what it's doing, and whether it waits for the user. */
  private publish(roomId: string): void {
    const round = this.rounds.get(roomId);
    const row = this.store.getAgent(roomId);
    if (round == null || row == null) return;
    const live = round.active != null ? this.memberLive.get(`${roomId}\u0000${round.active.memberId}`) : undefined;
    const asker = round.active != null ? this.store.getAgent(round.active.memberId)?.name : undefined;
    const awaiting = live?.awaitingUserResponse ?? null;
    const patch: Partial<AgentSummary> = {
      isRunning: true,
      activeGroupMemberId: round.active?.memberId,
      groupTurns: this.turnsOf(roomId, round),
      isComposingMessage: live?.isComposingMessage === true,
      currentActivity: live?.currentActivity,
      awaitingUserResponse: awaiting != null ? { ...awaiting, reasonCopy: `${asker ?? "A bot"}: ${awaiting.reasonCopy ?? ""}` } : null,
    };
    const keys = Object.keys(patch) as Array<keyof AgentSummary>;
    if (keys.every((key) => JSON.stringify(row[key]) === JSON.stringify(patch[key]))) return;
    this.harness.patchAgent(roomId, patch);
  }

  private settle(roomId: string, round: Round): void {
    const room = this.store.getAgent(roomId);
    if (room == null) return;
    const trigger = round.trigger;
    this.harness.patchAgent(roomId, {
      isRunning: false,
      activeGroupMemberId: undefined,
      groupTurns: round.silent ? undefined : this.turnsOf(roomId, round),
      isComposingMessage: false,
      currentActivity: undefined,
      awaitingUserResponse: null,
      lastActivityAt: Date.now(),
      // A woken member's turn answers no message of the person's.
      ...(trigger != null ? { lastTurnSettlement: { clientNonce: trigger.clientNonce ?? trigger.id, outcome: round.stopped ? "cancelled" : round.failed ? "error" : "success", settledAtMs: Date.now() } } : {}),
    });
    if (round.lastPost != null && !round.stopped) this.deps.emit("activity", { agentId: roomId, name: room.name, kind: "finished", preview: round.lastPost });
  }

  // ---- what members' room sessions tell the room ------------------------------------------------

  /** The room section of a member's system prompt: stable while the room's name and members are. */
  private instructions(agentId: string, sessionId: string): string[] | null {
    const roomId = roomIdOf(sessionId);
    const room = roomId != null ? this.store.getAgent(roomId) : undefined;
    if (room == null || !room.isGroup) return null;
    const others = this.members(room).filter((member) => member.id !== agentId);
    return [
      "## Group chat",
      `You're in a group chat called “${room.name}”${room.description.trim().length > 0 ? ` (${room.description.trim()})` : ""} with the user and ${others.length === 1 ? "another bot" : "other bots"}:`,
      ...others.map((other) => `- ${other.name}${other.description.trim().length > 0 ? `: ${other.description.trim().replace(/\s+/g, " ")}` : ""}`),
      "- Each message you get here holds the chat's new messages since your turn before, one per line after its author's name (\"User\" is the person).",
      "- Your reply is posted to the chat under your name. Keep it short and conversational: answer what's addressed to you, add what only you can add, and don't repeat what others said.",
      "- To ask another bot something, @mention it by name, as in @Name. Each mention gives that bot a turn, so mention one only when you need its answer.",
      "- If you have nothing to add, reply with exactly [pass] and nothing else. A pass isn't posted.",
      "- When a message says this is the last bot turn for now, answer without @mentioning anyone.",
      "- This chat is apart from your own conversation with the user: neither one sees the other.",
    ];
  }

  private memberLiveChanged(agentId: string, sessionId: string, live: SessionLiveState): void {
    const roomId = roomIdOf(sessionId);
    if (roomId == null || !this.rounds.has(roomId)) return;
    this.memberLive.set(`${roomId}\u0000${agentId}`, live);
    this.publish(roomId);
  }

  /** A member's approval or question: the room gets a copy marked with who asked, which follows the member's card. */
  private copyCard(agentId: string, sessionId: string, entry: TranscriptEntry): void {
    const roomId = roomIdOf(sessionId);
    if (roomId == null || entry.kind !== "send-message" || !COPIED_CARDS.has(entry.message.type)) return;
    const room = this.store.getAgent(roomId);
    const member = this.store.getAgent(agentId);
    if (room == null || !room.isGroup || member == null) return;
    const key = `${roomId}\u0000${agentId}\u0000${entry.id}`;
    const known = this.copies.get(key);
    // A page's card changes long after the turn (and after a restart, which forgets the copies' ids).
    const copy =
      (known != null ? this.store.entry(roomId, known) : undefined) ??
      this.store.entries(roomId).findLast((candidate) => candidate.kind === "send-message" && candidate.forwarded?.agentId === agentId && candidate.forwarded.sessionId === sessionId && candidate.forwarded.entryId === entry.id);
    const body = {
      kind: "send-message" as const,
      message: entry.message,
      ...(entry.requestId != null ? { requestId: entry.requestId } : {}),
      ...(entry.respondedValue != null ? { respondedValue: entry.respondedValue } : {}),
      ...(entry.widgetDismissed != null ? { widgetDismissed: entry.widgetDismissed } : {}),
      fromAgent: { id: member.id, name: member.name, kind: "agent" as const },
      forwarded: { agentId, sessionId, entryId: entry.id },
    };
    if (copy?.kind === "send-message") {
      this.copies.set(key, copy.id);
      this.harness.replace(roomId, MAIN_SESSION, { ...copy, ...body });
    } else this.copies.set(key, this.harness.append<SendMessageEntry>(roomId, MAIN_SESSION, body).id);
  }

  /** A member's question or approval notifies as the room's; a member's turn ending is the room's round to tell. */
  private memberActivity(agentId: string, sessionId: string, payload: ActivityPayload): void {
    const roomId = roomIdOf(sessionId);
    const room = roomId != null ? this.store.getAgent(roomId) : undefined;
    if (room == null || !room.isGroup || (payload.kind !== "needs-approval" && payload.kind !== "question")) return;
    this.deps.emit("activity", { agentId: room.id, name: room.name, kind: payload.kind, preview: preview(`${payload.name}: ${payload.preview}`) });
  }

  /** After a restart: rounds that were running ended, and the room's copies of cards no session waits on are closed out. */
  private recover(): void {
    for (const room of this.store.rosterAgents()) {
      if (!room.isGroup) continue;
      if (room.activeGroupMemberId != null || (room.groupTurns ?? []).some((turn) => turn.outcome == null)) {
        this.store.putAgent({ ...room, activeGroupMemberId: undefined, groupTurns: room.groupTurns?.map((turn) => ({ ...turn, isRunningTurn: false, isComposingMessage: false, currentActivity: undefined, outcome: turn.outcome ?? "CANCELLED" })) });
      }
      for (const entry of this.store.entries(room.id)) {
        if (entry.kind !== "send-message" || entry.forwarded == null) continue;
        if (entry.message.type === "local-tool-permission" && entry.message.ask.status === "pending") {
          this.store.upsertEntry(room.id, { ...entry, message: { ...entry.message, ask: { ...entry.message.ask, status: "expired" } } }, true);
        } else if (entry.message.type === "widget" && entry.respondedValue == null && entry.widgetDismissed !== true) {
          this.store.upsertEntry(room.id, { ...entry, widgetDismissed: true }, true);
        }
      }
    }
  }
}
