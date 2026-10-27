// Agent roster: seeded from the persisted `roster.last-roster` slice so the
// sidebar paints immediately, then kept live from gateway events. Agents hidden
// from the sidebar are kept apart, so they can still be opened and shown again.
import type { AgentSummary } from "../../shared/model";
import { gateway } from "../bridge";
import { readSlice, sliceKey, writeSlice } from "./slices";
import { Store } from "./store";

export interface RosterState {
  agents: AgentSummary[];
  /** Agents with `isHiddenFromSidebar`, in the same order. */
  hidden: AgentSummary[];
  loaded: boolean;
  connection: "connected" | "down" | "unknown";
}

const ROSTER_SLICE = sliceKey("roster.last-roster");
const ROSTER_SCHEMA = 4;

export const roster = new Store<RosterState>({ agents: [], hidden: [], loaded: false, connection: "unknown" });

const order = (agents: AgentSummary[]) =>
  [...agents].sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt));

const split = (agents: AgentSummary[]) => {
  const sorted = order(agents);
  return { agents: sorted.filter((agent) => agent.isHiddenFromSidebar !== true), hidden: sorted.filter((agent) => agent.isHiddenFromSidebar === true) };
};

/** Every agent, hidden ones last. */
export const allAgents = (state: RosterState = roster.get()) => [...state.agents, ...state.hidden];

function setAgents(agents: AgentSummary[]): void {
  roster.set((state) => ({ ...state, ...split(agents), loaded: true }));
  writeSlice(ROSTER_SLICE, ROSTER_SCHEMA, { rows: allAgents() }, 1500);
}

export function upsertAgent(agent: AgentSummary): void {
  setAgents([...allAgents().filter((existing) => existing.id !== agent.id), agent]);
}

export async function refreshRoster(): Promise<void> {
  try {
    setAgents(await gateway.rosterAgents({}));
    // A successful read proves the box is reachable even if the initial
    // transport-state event fired before this page subscribed.
    roster.set((state) => (state.connection === "connected" ? state : { ...state, connection: "connected" }));
  } catch {
    roster.set((state) => ({ ...state, connection: "down" }));
  }
}

export function getAgent(agentId: string | null): AgentSummary | undefined {
  return agentId == null ? undefined : allAgents().find((agent) => agent.id === agentId);
}

let started = false;
export async function startRoster(): Promise<void> {
  if (started) return;
  started = true;
  const cached = await readSlice<{ rows: AgentSummary[] }>(ROSTER_SLICE, ROSTER_SCHEMA);
  if (cached != null && !roster.get().loaded) roster.set((state) => ({ ...state, ...split(cached.rows.map((row) => ({ ...row, isRunning: false, awaitingUserResponse: null }))) }));
  gateway.subscribe({
    agents: ({ agents }) => setAgents(agents),
    "agent-saved": ({ agent }) => upsertAgent(agent),
    "agent-deleted": ({ ids }) => setAgents(allAgents().filter((agent) => !ids.includes(agent.id))),
    "gateway-link": ({ state }) => {
      roster.set((current) => ({ ...current, connection: state }));
      if (state === "connected") void refreshRoster();
    },
  });
  await refreshRoster();
}
