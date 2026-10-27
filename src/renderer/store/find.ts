// Find in chat (Ctrl+F). The box searches the whole conversation (`findInConversation`), so hits in
// pages that aren't loaded yet count too; the transcript loads older pages to reveal the current hit
// and paints every match with the CSS Custom Highlight API. Hits are newest first, as the transcript
// is read from the bottom: Enter steps to an older hit, Shift+Enter back to a newer one.
import type { ConversationMatch } from "../../shared/model";
import { gateway } from "../bridge";
import { Store } from "./store";

export interface FindState {
  /** The conversation the bar is open on; null while it is closed. */
  agentId: string | null;
  query: string;
  hits: ConversationMatch[];
  /** False while older hits remain past the last one fetched. */
  complete: boolean;
  /** The current hit, or -1. */
  index: number;
  status: "idle" | "searching" | "ready" | "error";
  error: string | null;
  /** Bumped when the bar's field should take focus (Ctrl+F while it is open). */
  focusTick: number;
  /** Bumped when the transcript should scroll to the current hit. */
  revealTick: number;
}

const PAGE = 100;

export const find = new Store<FindState>({ agentId: null, query: "", hits: [], complete: true, index: -1, status: "idle", error: null, focusTick: 0, revealTick: 0 });

/** Ignores replies to searches that a newer one replaced. */
let generation = 0;
let typing: ReturnType<typeof setTimeout> | null = null;
let paging: Promise<void> | null = null;

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message.replace(/^[\w/-]+: /, "") : String(cause));

/** Opens the bar on this conversation, or focuses it again; `entryId` makes that message the current hit. */
export function openFind(agentId: string, options: { query?: string; entryId?: string } = {}): void {
  const state = find.get();
  const sameView = state.agentId === agentId && (options.query == null || options.query === state.query);
  find.set({
    ...state,
    agentId,
    query: options.query ?? state.query,
    focusTick: state.focusTick + 1,
    ...(sameView ? {} : { hits: [], index: -1, complete: true, status: "idle" as const }),
  });
  if (!sameView || options.entryId != null) void search({ prefer: options.entryId, reveal: true });
}

export function closeFind(): void {
  generation++;
  if (typing != null) clearTimeout(typing);
  typing = null;
  find.set((state) => (state.agentId == null ? state : { ...state, agentId: null, hits: [], index: -1, complete: true, status: "idle", error: null }));
}

export function setFindQuery(query: string): void {
  find.set((state) => ({ ...state, query, status: query.trim().length > 0 ? "searching" : "idle" }));
  if (typing != null) clearTimeout(typing);
  typing = setTimeout(() => {
    typing = null;
    void search({ reveal: true });
  }, 150);
}

/** Searches again as new messages arrive, keeping the current hit without scrolling to it. */
export function refreshFind(): void {
  if (find.get().agentId != null && find.get().query.trim().length > 0 && typing == null) void search({ reveal: false });
}

async function search({ prefer, reveal }: { prefer?: string; reveal: boolean }): Promise<void> {
  const { agentId, query } = find.get();
  if (agentId == null) return;
  const mine = ++generation;
  if (query.trim().length === 0) {
    find.set((state) => ({ ...state, hits: [], index: -1, complete: true, status: "idle", error: null }));
    return;
  }
  find.set((state) => ({ ...state, status: "searching", error: null }));
  try {
    const keep = prefer ?? find.get().hits[find.get().index]?.entryId;
    let { isComplete, matches } = await gateway.findInConversation({ agentId, query, limit: PAGE });
    // A message picked elsewhere (the palette) may be older than the first page of hits.
    for (let pages = 1; prefer != null && !isComplete && pages < 10 && !matches.some((match) => match.entryId === prefer); pages++) {
      const more = await gateway.findInConversation({ agentId, query, limit: PAGE, beforeSeq: matches[matches.length - 1].seq });
      if (mine !== generation) return;
      ({ isComplete } = more);
      matches = [...matches, ...more.matches];
    }
    if (mine !== generation) return;
    const at = keep == null ? -1 : matches.findIndex((match) => match.entryId === keep);
    find.set((state) => {
      const index = matches.length === 0 ? -1 : Math.max(0, at);
      const moved = matches[index]?.entryId !== state.hits[state.index]?.entryId;
      return { ...state, hits: matches, complete: isComplete, index, status: "ready", revealTick: state.revealTick + (reveal || moved ? 1 : 0) };
    });
  } catch (cause) {
    if (mine !== generation) return;
    find.set((state) => ({ ...state, hits: [], index: -1, complete: true, status: "error", error: errorText(cause) }));
  }
}

/** Fetches the hits older than the last one, once at a time. */
function moreHits(): Promise<void> {
  paging ??= (async () => {
    const { agentId, query, hits } = find.get();
    const mine = generation;
    try {
      if (agentId == null || hits.length === 0) return;
      const more = await gateway.findInConversation({ agentId, query, limit: PAGE, beforeSeq: hits[hits.length - 1].seq });
      if (mine === generation) find.set((state) => ({ ...state, hits: [...state.hits, ...more.matches], complete: more.isComplete }));
    } catch {
      if (mine === generation) find.set((state) => ({ ...state, complete: true }));
    } finally {
      paging = null;
    }
  })();
  return paging;
}

/** 1 steps to the next older hit, -1 to the next newer one, wrapping around. */
export async function stepFind(direction: 1 | -1): Promise<void> {
  if (find.get().hits.length === 0) return;
  if (direction === 1 && find.get().index === find.get().hits.length - 1 && !find.get().complete) await moreHits();
  find.set((state) => {
    if (state.hits.length === 0) return state;
    const index = (state.index + direction + state.hits.length) % state.hits.length;
    return { ...state, index, revealTick: state.revealTick + 1 };
  });
}
