// Transcript replicas, one per opened conversation: an agent's main session, or another of its
// sessions, keyed `transcript:<agentId>` and `transcript:<agentId>\0<sessionId>`.
// An event's session is its stamp's replica key. Events are applied only when they
// continue the replica: same epoch and sequence === last + 1. Anything else
// (a gap, a new epoch) triggers a resync from the tail.
// Sends are optimistic: a local row shows immediately and is dropped once the
// box echoes a user message with the same clientNonce. Reactions and votes are
// too: the entry changes at once, the box's `updated` event replaces it, and a
// failed call puts it back.
import type { SendPromptArgs } from "../../shared/edges";
import { MAIN_SESSION, type MessageEntry, type MessageFeedback, type OrderedStamp, parseReplicaKey, type Reaction, type TranscriptEntry, type TranscriptEvent, transcriptReplicaKey } from "../../shared/model";
import { gateway } from "../bridge";
import { Store } from "./store";

/** The session argument a gateway call carries: none for the main session, so its calls stay as they were. */
const sessionArg = (sessionId: string) => (sessionId === MAIN_SESSION ? {} : { sessionId });

/** The message a reply answers, and what it quotes from it. */
export interface ReplyTarget {
  entryId: string;
  quote: string;
  role: "user" | "assistant";
}

export interface PendingSend {
  clientNonce: string;
  content: string;
  attachmentNames: string[];
  /** A voice memo being sent: its length; `content` is its transcript. */
  voiceMemo?: { durationMs: number };
  reply?: ReplyTarget;
  state: "sending" | "failed";
  error?: string;
  createdAt: number;
  retry: () => void;
}

export interface Replica {
  agentId: string;
  sessionId: string;
  status: "loading" | "ready" | "error";
  error?: string;
  epoch: string | null;
  sequence: number;
  entries: TranscriptEntry[];
  nextBeforeSeq?: number;
  loadingOlder: boolean;
  pending: PendingSend[];
  unreadAnchorId: string | null;
}

const PAGE = 120;
/** By replica key. */
const replicas = new Map<string, Store<Replica>>();

const empty = (agentId: string, sessionId: string): Replica => ({ agentId, sessionId, status: "loading", epoch: null, sequence: 0, entries: [], loadingOlder: false, pending: [], unreadAnchorId: null });

export function replicaStore(agentId: string, sessionId: string = MAIN_SESSION): Store<Replica> {
  const key = transcriptReplicaKey(agentId, sessionId);
  let store = replicas.get(key);
  if (store == null) {
    store = new Store(empty(agentId, sessionId));
    replicas.set(key, store);
  }
  return store;
}

function sortBySeq(entries: TranscriptEntry[]): TranscriptEntry[] {
  return [...entries].sort((a, b) => a.seq - b.seq);
}

function adopt(store: Store<Replica>, page: { entries: TranscriptEntry[]; nextBeforeSeq?: number; ordered?: OrderedStamp; unreadAnchor?: { kind: "at"; entryId: string } | { kind: "none" } | null }): void {
  const echoed = new Set(page.entries.flatMap((entry) => (entry.kind === "message" && entry.role === "user" && entry.clientNonce != null ? [entry.clientNonce] : [])));
  store.set((replica) => ({
    ...replica,
    status: "ready",
    error: undefined,
    epoch: page.ordered?.epoch ?? replica.epoch,
    sequence: page.ordered?.sequence ?? replica.sequence,
    entries: sortBySeq(page.entries),
    nextBeforeSeq: page.nextBeforeSeq,
    pending: replica.pending.filter((send) => !echoed.has(send.clientNonce)),
    unreadAnchorId: page.unreadAnchor?.kind === "at" ? page.unreadAnchor.entryId : replica.unreadAnchorId,
  }));
}

export async function openTranscript(agentId: string, sessionId: string = MAIN_SESSION): Promise<void> {
  const store = replicaStore(agentId, sessionId);
  if (store.get().status !== "ready") store.set((replica) => ({ ...replica, status: "loading" }));
  try {
    adopt(store, await gateway.followTranscript({ id: agentId, limit: PAGE, ...sessionArg(sessionId) }));
  } catch (error) {
    store.set((replica) => ({ ...replica, status: "error", error: error instanceof Error ? error.message : String(error) }));
  }
}

async function resync(agentId: string, sessionId: string): Promise<void> {
  const store = replicaStore(agentId, sessionId);
  try {
    adopt(store, await gateway.readTranscriptEnd({ id: agentId, limit: Math.max(PAGE, store.get().entries.length), ...sessionArg(sessionId) }));
  } catch {
    // a later event or reopen will retry
  }
}

/** By replica key. */
const olderLoads = new Map<string, Promise<void>>();

/** Loads the page before the oldest loaded entry; callers during a load share it. */
export function loadOlder(agentId: string, sessionId: string = MAIN_SESSION): Promise<void> {
  const key = transcriptReplicaKey(agentId, sessionId);
  const running = olderLoads.get(key);
  if (running != null) return running;
  const store = replicaStore(agentId, sessionId);
  const { nextBeforeSeq } = store.get();
  if (nextBeforeSeq == null) return Promise.resolve();
  store.set((replica) => ({ ...replica, loadingOlder: true }));
  const load = (async () => {
    try {
      const page = await gateway.readTranscriptEnd({ id: agentId, beforeSeq: nextBeforeSeq, limit: PAGE, ...sessionArg(sessionId) });
      store.set((replica) => {
        const known = new Set(replica.entries.map((entry) => entry.id));
        return { ...replica, loadingOlder: false, entries: sortBySeq([...page.entries.filter((entry) => !known.has(entry.id)), ...replica.entries]), nextBeforeSeq: page.nextBeforeSeq };
      });
    } catch {
      store.set((replica) => ({ ...replica, loadingOlder: false }));
    } finally {
      olderLoads.delete(key);
    }
  })();
  olderLoads.set(key, load);
  return load;
}

/**
 * Loads older pages, at most 20, until the entry (a search hit, say) is in the replica; false if
 * it still isn't (or no longer exists).
 */
export async function revealEntry(agentId: string, entryId: string, seq: number, sessionId: string = MAIN_SESSION): Promise<boolean> {
  const store = replicaStore(agentId, sessionId);
  if (store.get().status === "loading") {
    await new Promise<void>((resolve) => {
      const off = store.subscribe(() => {
        if (store.get().status === "loading") return;
        off();
        resolve();
      });
    });
  }
  for (let pages = 0; pages < 20; pages++) {
    const { entries, nextBeforeSeq } = store.get();
    if (entries.some((entry) => entry.id === entryId)) return true;
    if (nextBeforeSeq == null || (entries.length > 0 && entries[0].seq <= seq)) return false;
    await loadOlder(agentId, sessionId);
    if (store.get().nextBeforeSeq === nextBeforeSeq) return false; // the page didn't load
  }
  return store.get().entries.some((entry) => entry.id === entryId);
}

export function applyTranscriptEvent(event: TranscriptEvent): void {
  // The stamp says which replica: the agent's main session, or another of its sessions.
  const named = parseReplicaKey(event.ordered.replicaKey);
  const agentId = named?.agentId ?? (event.type === "snapshot" ? event.activeAgentId : event.agentId);
  const sessionId = named?.sessionId ?? MAIN_SESSION;
  const store = replicas.get(transcriptReplicaKey(agentId, sessionId));
  if (store == null || store.get().status === "loading") return; // not opened yet; the tail read will include it
  const replica = store.get();
  const stamp = event.ordered;

  if (event.type === "cleared") {
    store.set({ ...replica, epoch: stamp.epoch, sequence: stamp.sequence, entries: [], nextBeforeSeq: undefined, unreadAnchorId: null });
    return;
  }
  if (event.type === "snapshot") {
    adopt(store, { entries: event.entries, ordered: stamp });
    return;
  }
  if (stamp.epoch !== replica.epoch || stamp.sequence > replica.sequence + 1) {
    void resync(agentId, sessionId);
    return;
  }
  if (stamp.sequence <= replica.sequence) return; // already applied

  let entries = replica.entries;
  let pending = replica.pending;
  if (event.type === "removed") {
    entries = entries.filter((entry) => entry.id !== event.id);
  } else {
    const index = entries.findIndex((entry) => entry.id === event.entry.id);
    entries = index >= 0 ? entries.map((entry, i) => (i === index ? event.entry : entry)) : sortBySeq([...entries, event.entry]);
    const entry = event.entry;
    if (entry.kind === "message" && entry.role === "user" && entry.clientNonce != null) pending = pending.filter((send) => send.clientNonce !== entry.clientNonce);
  }
  store.set({ ...replica, sequence: stamp.sequence, entries, pending });
}

/** `voiceMemo`: the one attachment is a recording and `content` its transcript. `reply`: the message it answers. `sessionId`: the conversation, the main one by default. */
export function deliverMessage(
  agentId: string,
  content: string,
  attachments: Array<{ path: string; name: string }>,
  { voiceMemo, reply, sessionId = MAIN_SESSION }: { voiceMemo?: SendPromptArgs["voiceMemo"]; reply?: ReplyTarget; sessionId?: string } = {},
): void {
  const store = replicaStore(agentId, sessionId);
  const clientNonce = crypto.randomUUID();
  const attempt = async () => {
    store.set((replica) => ({ ...replica, pending: replica.pending.map((send) => (send.clientNonce === clientNonce ? { ...send, state: "sending", error: undefined } : send)) }));
    try {
      await gateway.deliverMessage({
        agentId,
        prompt: content,
        clientNonce,
        attachmentPaths: attachments.map((a) => a.path),
        attachmentNames: attachments.map((a) => a.name),
        source: "desktop",
        sendSource: "chat",
        ...(voiceMemo != null ? { voiceMemo } : {}),
        ...(reply != null ? { replyToId: reply.entryId, replyQuote: reply.quote } : {}),
        ...sessionArg(sessionId),
      });
    } catch (error) {
      store.set((replica) => ({ ...replica, pending: replica.pending.map((send) => (send.clientNonce === clientNonce ? { ...send, state: "failed", error: error instanceof Error ? error.message : String(error) } : send)) }));
    }
  };
  const pendingSend: PendingSend = {
    clientNonce,
    content,
    attachmentNames: voiceMemo != null ? [] : attachments.map((a) => a.name),
    ...(voiceMemo != null ? { voiceMemo: { durationMs: voiceMemo.durationMs } } : {}),
    ...(reply != null ? { reply } : {}),
    state: "sending",
    createdAt: Date.now(),
    retry: () => void attempt(),
  };
  store.set((replica) => ({ ...replica, pending: [...replica.pending, pendingSend] }));
  void attempt();
}

// ---- replies, reactions and votes ------------------------------------------------------------

/** The reply each agent's composer is writing, by agent. */
export const replyTargets = new Store<Record<string, ReplyTarget | undefined>>({});

export function startReply(agentId: string, target: ReplyTarget): void {
  replyTargets.set((targets) => ({ ...targets, [agentId]: target }));
}

export function cancelReply(agentId: string): void {
  if (replyTargets.get()[agentId] == null) return;
  replyTargets.set((targets) => ({ ...targets, [agentId]: undefined }));
}

/** Shows a change to an entry before the box confirms it; its `updated` event replaces the entry, and a failed call puts it back. */
async function optimistic(agentId: string, sessionId: string, entryId: string, change: (entry: TranscriptEntry) => TranscriptEntry, call: () => Promise<unknown>): Promise<void> {
  const store = replicaStore(agentId, sessionId);
  const before = store.get().entries.find((entry) => entry.id === entryId);
  if (before == null) return;
  const after = change(before);
  store.set((replica) => ({ ...replica, entries: replica.entries.map((entry) => (entry.id === entryId ? after : entry)) }));
  try {
    await call();
  } catch (error) {
    // Unless the box sent a newer version meanwhile.
    store.set((replica) => ({ ...replica, entries: replica.entries.map((entry) => (entry === after ? before : entry)) }));
    throw error;
  }
}

/** Adds the user's emoji to the entry, or takes it back if it's already there. */
export function toggleReaction(agentId: string, entryId: string, emoji: string, sessionId: string = MAIN_SESSION): Promise<void> {
  return optimistic(
    agentId,
    sessionId,
    entryId,
    (entry) => {
      const reactions: Reaction[] = entry.reactions ?? [];
      const mine = reactions.some((reaction) => reaction.emoji === emoji && reaction.by === "user");
      const next = mine ? reactions.filter((reaction) => !(reaction.emoji === emoji && reaction.by === "user")) : [...reactions, { emoji, by: "user" }];
      return { ...entry, reactions: next.length > 0 ? next : undefined };
    },
    () => gateway.setReaction({ agentId, entryId, emoji, ...sessionArg(sessionId) }),
  );
}

/** Good, Bad, the reasons for Bad, or taking the vote back, as `rateReply` records them. */
export function voteOnReply(
  agentId: string,
  entryId: string,
  action: "up" | "down" | "submit" | "revert",
  categories?: MessageFeedback["categories"],
  comment?: string,
  sessionId: string = MAIN_SESSION,
): Promise<void> {
  return optimistic(
    agentId,
    sessionId,
    entryId,
    (entry) => {
      if (entry.kind !== "message") return entry;
      const current = entry.feedback;
      const now = Date.now();
      const feedback: MessageFeedback | undefined =
        action === "revert"
          ? undefined
          : action === "up"
            ? { sentiment: "up", state: "voted", categories: [], votedAt: now }
            : action === "down"
              ? { sentiment: "down", state: "improve", categories: current?.sentiment === "down" ? current.categories : [], votedAt: now }
              : current != null
                ? { ...current, state: "voted", categories: categories ?? [], ...(comment != null && comment.trim().length > 0 ? { comment: comment.trim() } : {}), votedAt: now }
                : undefined;
      return { ...entry, feedback };
    },
    () => gateway.rateReply({ agentId, entryId, action, ...(categories != null ? { categories: [...categories] } : {}), ...(comment != null ? { comment } : {}), ...sessionArg(sessionId) }),
  );
}

export function discardPending(agentId: string, clientNonce: string, sessionId: string = MAIN_SESSION): void {
  replicaStore(agentId, sessionId).set((replica) => ({ ...replica, pending: replica.pending.filter((send) => send.clientNonce !== clientNonce) }));
}

export function lastAssistantText(entries: TranscriptEntry[]): string {
  const last = [...entries].reverse().find((entry): entry is MessageEntry => entry.kind === "message" && entry.role === "assistant" && entry.content.length > 0);
  return last?.content ?? "";
}

let started = false;
export function startTranscripts(): void {
  if (started) return;
  started = true;
  gateway.subscribe({
    transcript: applyTranscriptEvent,
    "gateway-link": ({ state }) => {
      if (state !== "connected") return;
      for (const store of replicas.values()) {
        const { agentId, sessionId, status } = store.get();
        if (status !== "loading") void resync(agentId, sessionId);
      }
    },
  });
}
