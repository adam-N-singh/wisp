// Transcript replicas, one per opened agent. Events are applied only when they
// continue the replica: same epoch and sequence === last + 1. Anything else
// (a gap, a new epoch) triggers a resync from the tail.
// Sends are optimistic: a local row shows immediately and is dropped once the
// box echoes a user message with the same clientNonce. Reactions and votes are
// too: the entry changes at once, the box's `updated` event replaces it, and a
// failed call puts it back.
import type { SendPromptArgs } from "../../shared/edges";
import type { MessageEntry, MessageFeedback, OrderedStamp, Reaction, TranscriptEntry, TranscriptEvent } from "../../shared/model";
import { gateway } from "../bridge";
import { Store } from "./store";

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
const replicas = new Map<string, Store<Replica>>();

const empty = (agentId: string): Replica => ({ agentId, status: "loading", epoch: null, sequence: 0, entries: [], loadingOlder: false, pending: [], unreadAnchorId: null });

export function replicaStore(agentId: string): Store<Replica> {
  let store = replicas.get(agentId);
  if (store == null) {
    store = new Store(empty(agentId));
    replicas.set(agentId, store);
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

export async function openTranscript(agentId: string): Promise<void> {
  const store = replicaStore(agentId);
  if (store.get().status !== "ready") store.set((replica) => ({ ...replica, status: "loading" }));
  try {
    adopt(store, await gateway.followTranscript({ id: agentId, limit: PAGE }));
  } catch (error) {
    store.set((replica) => ({ ...replica, status: "error", error: error instanceof Error ? error.message : String(error) }));
  }
}

async function resync(agentId: string): Promise<void> {
  const store = replicaStore(agentId);
  try {
    adopt(store, await gateway.readTranscriptEnd({ id: agentId, limit: Math.max(PAGE, store.get().entries.length) }));
  } catch {
    // a later event or reopen will retry
  }
}

const olderLoads = new Map<string, Promise<void>>();

/** Loads the page before the oldest loaded entry; callers during a load share it. */
export function loadOlder(agentId: string): Promise<void> {
  const running = olderLoads.get(agentId);
  if (running != null) return running;
  const store = replicaStore(agentId);
  const { nextBeforeSeq } = store.get();
  if (nextBeforeSeq == null) return Promise.resolve();
  store.set((replica) => ({ ...replica, loadingOlder: true }));
  const load = (async () => {
    try {
      const page = await gateway.readTranscriptEnd({ id: agentId, beforeSeq: nextBeforeSeq, limit: PAGE });
      store.set((replica) => {
        const known = new Set(replica.entries.map((entry) => entry.id));
        return { ...replica, loadingOlder: false, entries: sortBySeq([...page.entries.filter((entry) => !known.has(entry.id)), ...replica.entries]), nextBeforeSeq: page.nextBeforeSeq };
      });
    } catch {
      store.set((replica) => ({ ...replica, loadingOlder: false }));
    } finally {
      olderLoads.delete(agentId);
    }
  })();
  olderLoads.set(agentId, load);
  return load;
}

/**
 * Loads older pages, at most 20, until the entry (a search hit, say) is in the replica; false if
 * it still isn't (or no longer exists).
 */
export async function revealEntry(agentId: string, entryId: string, seq: number): Promise<boolean> {
  const store = replicaStore(agentId);
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
    await loadOlder(agentId);
    if (store.get().nextBeforeSeq === nextBeforeSeq) return false; // the page didn't load
  }
  return store.get().entries.some((entry) => entry.id === entryId);
}

export function applyTranscriptEvent(event: TranscriptEvent): void {
  const agentId = event.type === "snapshot" ? event.activeAgentId : event.agentId;
  const store = replicas.get(agentId);
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
    void resync(agentId);
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

/** `voiceMemo`: the one attachment is a recording and `content` its transcript. `reply`: the message it answers. */
export function deliverMessage(
  agentId: string,
  content: string,
  attachments: Array<{ path: string; name: string }>,
  { voiceMemo, reply }: { voiceMemo?: SendPromptArgs["voiceMemo"]; reply?: ReplyTarget } = {},
): void {
  const store = replicaStore(agentId);
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
async function optimistic(agentId: string, entryId: string, change: (entry: TranscriptEntry) => TranscriptEntry, call: () => Promise<unknown>): Promise<void> {
  const store = replicaStore(agentId);
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
export function toggleReaction(agentId: string, entryId: string, emoji: string): Promise<void> {
  return optimistic(
    agentId,
    entryId,
    (entry) => {
      const reactions: Reaction[] = entry.reactions ?? [];
      const mine = reactions.some((reaction) => reaction.emoji === emoji && reaction.by === "user");
      const next = mine ? reactions.filter((reaction) => !(reaction.emoji === emoji && reaction.by === "user")) : [...reactions, { emoji, by: "user" }];
      return { ...entry, reactions: next.length > 0 ? next : undefined };
    },
    () => gateway.setReaction({ agentId, entryId, emoji }),
  );
}

/** Good, Bad, the reasons for Bad, or taking the vote back, as `rateReply` records them. */
export function voteOnReply(agentId: string, entryId: string, action: "up" | "down" | "submit" | "revert", categories?: MessageFeedback["categories"], comment?: string): Promise<void> {
  return optimistic(
    agentId,
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
    () => gateway.rateReply({ agentId, entryId, action, ...(categories != null ? { categories: [...categories] } : {}), ...(comment != null ? { comment } : {}) }),
  );
}

export function discardPending(agentId: string, clientNonce: string): void {
  replicaStore(agentId).set((replica) => ({ ...replica, pending: replica.pending.filter((send) => send.clientNonce !== clientNonce) }));
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
      for (const [agentId, store] of replicas) if (store.get().status !== "loading") void resync(agentId);
    },
  });
}
