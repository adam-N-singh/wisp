// Moving between agents from the keyboard, in the sidebar's order: Alt+Up/Down, Ctrl+1–9, and
// Ctrl+Tab cycling, which moves a cursor while Ctrl is held and opens that agent when it's released.
import type { AgentSummary } from "../../shared/model";
import { app, selectAgent } from "./app";
import { layout } from "./layout";
import { roster } from "./roster";
import { Store } from "./store";

/** The sidebar's rows: its search and unread filters applied (the open agent always stays). */
export function sidebarRows(agents: AgentSummary[], search: string, unreadOnly: boolean, selected: string | null): AgentSummary[] {
  const needle = search.trim().toLowerCase();
  return agents.filter((agent) => (!unreadOnly || agent.hasUnread || agent.awaitingUserResponse != null || agent.id === selected) && (needle.length === 0 || agent.name.toLowerCase().includes(needle) || agent.description.toLowerCase().includes(needle)));
}

const shownAgents = () => sidebarRows(roster.get().agents, app.get().search, layout.get().isSidebarUnreadOnly, app.get().agentId);

/** The agent Ctrl+Tab points at while Ctrl is held. */
export const cycle = new Store<string | null>(null);

/** Opens the agent above (-1) or below (1) the open one. */
export function stepAgent(direction: 1 | -1): void {
  const rows = shownAgents();
  if (rows.length === 0) return;
  const at = rows.findIndex((agent) => agent.id === app.get().agentId);
  const next = at < 0 ? (direction === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + direction));
  if (rows[next].id !== app.get().agentId || app.get().view !== "chat") selectAgent(rows[next].id);
}

/** Opens the nth agent in the sidebar (1-based). */
export function openAgentAt(position: number): boolean {
  const target = shownAgents()[position - 1];
  if (target == null) return false;
  selectAgent(target.id);
  return true;
}

export function cycleAgents(direction: 1 | -1): void {
  const rows = shownAgents();
  if (rows.length === 0) return;
  const from = rows.findIndex((agent) => agent.id === (cycle.get() ?? app.get().agentId));
  const next = from < 0 ? (direction === 1 ? 0 : rows.length - 1) : (from + direction + rows.length) % rows.length;
  cycle.set(rows[next].id);
}

/** Ctrl was released: open the agent the cursor is on. */
export function finishCycle(): void {
  const target = cycle.get();
  if (target == null) return;
  cycle.set(null);
  selectAgent(target);
}

export function cancelCycle(): void {
  cycle.set(null);
}
