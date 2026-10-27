// The full conversation outline ("Show full conversation"): the items of each conversation whose
// panel is open, read from the gateway when it opens and kept live from "outline" events. Events
// that come while the read is on its way are applied over its reply once it arrives, so nothing
// that changed meanwhile is lost. A conversation is named by its agent's id (a subagent's later).
import { applyOutlineEvent, type ConversationOutlineEvent, type ConversationOutlineItem } from "../../shared/model";
import { gateway } from "../bridge";
import { Store } from "./store";

export interface OutlineState {
  items: ConversationOutlineItem[];
  status: "loading" | "ready" | "error";
  error: string | null;
}

export const outlines = new Store<Record<string, OutlineState>>({});

/** Conversations with a panel open, and the read each is waiting for. */
const watched = new Set<string>();
const reads = new Map<string, { token: number; events: ConversationOutlineEvent[] }>();
let nextToken = 0;

/** Keeps the conversation's outline loaded and live until the returned function is called. */
export function watchOutline(id: string): () => void {
  watched.add(id);
  void loadOutline(id);
  return () => {
    watched.delete(id);
    reads.delete(id);
    outlines.set((state) => {
      const { [id]: _closed, ...rest } = state;
      return rest;
    });
  };
}

async function loadOutline(id: string): Promise<void> {
  const token = ++nextToken;
  reads.set(id, { token, events: [] });
  outlines.set((state) => ({ ...state, [id]: { items: state[id]?.items ?? [], status: "loading", error: null } }));
  let items: ConversationOutlineItem[] | null = null;
  let error: string | null = null;
  try {
    items = await gateway.readOutline({ id });
  } catch (cause) {
    error = (cause instanceof Error ? cause.message : String(cause)).replace(/^[\w/-]+: /, "");
  }
  const read = reads.get(id);
  if (read?.token !== token) return; // closed, or read again since
  reads.delete(id);
  outlines.set((state) => ({
    ...state,
    [id]: items != null ? { items: read.events.reduce(applyOutlineEvent, items), status: "ready", error: null } : { items: state[id]?.items ?? [], status: "error", error },
  }));
}

function applyEvent(event: ConversationOutlineEvent): void {
  const id = event.agentId;
  if (!watched.has(id)) return;
  const read = reads.get(id);
  if (read != null) {
    read.events.push(event);
    return;
  }
  outlines.set((state) => (state[id] != null ? { ...state, [id]: { ...state[id], items: applyOutlineEvent(state[id].items, event) } } : state));
}

let started = false;
export function startOutlines(): void {
  if (started) return;
  started = true;
  gateway.subscribe({
    outline: applyEvent,
    // Events may have been missed while the box was out of reach.
    "gateway-link": ({ state }) => {
      if (state !== "connected") return;
      for (const id of watched) void loadOutline(id);
    },
  });
}
