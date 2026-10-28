// What the command palette finds (components/Palette.tsx), kept apart from the component so it can be
// tested without a window: how well a name matches what was typed, the pages "Jump to" lists, and
// the agents that can have an agent browser.
import type { AgentSummary } from "../shared/model";
import type { LibraryPage } from "../shared/pages";

/** How well a name matches: its start, a word's start, anywhere in it, then every typed word somewhere in it. */
export function nameScore(name: string, needle: string): number {
  const text = name.toLowerCase();
  if (needle.length === 0) return 0;
  if (text.startsWith(needle)) return 4;
  if (text.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(needle))) return 3;
  if (text.includes(needle)) return 2;
  const words = needle.split(/\s+/).filter((word) => word.length > 0);
  return words.length > 1 && words.every((word) => text.includes(word)) ? 1 : 0;
}

/** How well an agent matches: by its name, else (below any name match) its title or role. */
export function agentScore(agent: AgentSummary, needle: string): number {
  const byName = nameScore(agent.name, needle);
  if (byName > 1) return byName + 1;
  if (byName === 1) return 2;
  return `${agent.title ?? ""} ${agent.description}`.toLowerCase().includes(needle) ? 1 : 0;
}

export interface PageMatch {
  page: LibraryPage;
  agent: AgentSummary;
}

/**
 * The pages "Jump to" lists: with nothing typed, the newest pages of agents in the sidebar; with a
 * query, the pages whose title matches, best first and then newest, hidden agents' too (as hidden
 * agents themselves are found only by a query). A page whose agent is gone isn't listed.
 */
export function pageMatches(pages: readonly LibraryPage[], agents: { visible: readonly AgentSummary[]; hidden: readonly AgentSummary[] }, needle: string, limit: number): PageMatch[] {
  const visible = new Map(agents.visible.map((agent) => [agent.id, agent]));
  const everyone = new Map([...visible, ...agents.hidden.map((agent) => [agent.id, agent] as const)]);
  const owned = (from: Map<string, AgentSummary>) =>
    pages.flatMap((page) => {
      const agent = from.get(page.page.storeId);
      return agent != null ? [{ page, agent }] : [];
    });
  if (needle.length === 0) return owned(visible).sort((a, b) => b.page.updatedAt - a.page.updatedAt).slice(0, limit);
  return owned(everyone)
    .map((match) => ({ match, score: nameScore(match.page.title, needle) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.match.page.updatedAt - a.match.page.updatedAt)
    .slice(0, limit)
    .map((item) => item.match);
}

/** The agent browser is a window on this PC (src/main/agent-browser.ts): only agents working on this PC have one. */
export function canHaveAgentBrowser(agent: Pick<AgentSummary, "computer">): boolean {
  return agent.computer !== "cloud";
}
