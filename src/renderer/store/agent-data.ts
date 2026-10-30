// Per-agent side data shown in the info pane (todos, automations, skills, memory), the box-wide
// MCP server list, the Connect Apps catalog and the plugin marketplaces, each fetched on demand
// and kept live from events.
import type { MarketplaceView } from "../../shared/marketplace";
import type { AgentMemory, AgentTodo, Automation, McpCatalogEntry, McpServerSummary, McpState, OrderedStamp, Skill } from "../../shared/model";
import { gateway, main } from "../bridge";
import { Store } from "./store";

export const todos = new Store<Record<string, AgentTodo[]>>({});
export const automations = new Store<Record<string, Automation[]>>({});
export const skills = new Store<Record<string, Skill[]>>({});
export const memories = new Store<Record<string, AgentMemory[]>>({});
export const mcpServers = new Store<{ servers: McpServerSummary[]; loaded: boolean; ordered?: OrderedStamp }>({ servers: [], loaded: false });

/** Takes the MCP servers from a reply or an event, unless an event already brought a newer state. */
export function setMcpState(state: McpState): void {
  const current = mcpServers.get().ordered;
  if (current != null && state.ordered != null && state.ordered.epoch === current.epoch && state.ordered.sequence < current.sequence) return;
  mcpServers.set({ servers: state.servers, loaded: true, ordered: state.ordered });
}
/** MCP sign-ins and sign-outs started here: pending while they run, then the error if one failed. */
export const mcpSignIns = new Store<Record<string, { pending: "sign-in" | "sign-out" | null; error: string | null }>>({});
/**
 * The box's Connect Apps catalog: the bundled apps, which change only with the box's version, and
 * the plugins of the marketplaces the user added, read again whenever those change.
 */
export const mcpCatalog = new Store<{ entries: McpCatalogEntry[]; status: "idle" | "loading" | "ready" | "error" }>({ entries: [], status: "idle" });
/** Counts reads, so only the latest one lands. */
let catalogReads = 0;

/** Reads the catalog once; `force` reads it again (marketplaces or installed plugins changed). */
export async function loadMcpCatalog(force = false): Promise<void> {
  if (!force && (mcpCatalog.get().status === "ready" || mcpCatalog.get().status === "loading")) return;
  const read = ++catalogReads;
  if (mcpCatalog.get().status !== "ready") mcpCatalog.set((state) => ({ ...state, status: "loading" }));
  try {
    const entries = await gateway.readAppCatalog({});
    if (read === catalogReads) mcpCatalog.set({ entries, status: "ready" });
  } catch {
    if (read === catalogReads && mcpCatalog.get().status !== "ready") mcpCatalog.set((state) => ({ ...state, status: "error" }));
  }
}

/** The plugin marketplaces the user added. */
export const marketplaces = new Store<{ list: MarketplaceView[]; status: "idle" | "loading" | "ready" | "error" }>({ list: [], status: "idle" });

export async function loadMarketplaces(): Promise<void> {
  if (marketplaces.get().status === "idle") marketplaces.set((state) => ({ ...state, status: "loading" }));
  try {
    setMarketplaces(await gateway.readMarketplaces({}));
  } catch {
    if (marketplaces.get().status !== "ready") marketplaces.set((state) => ({ ...state, status: "error" }));
  }
}

export function setMarketplaces(list: MarketplaceView[]): void {
  marketplaces.set({ list, status: "ready" });
}

export async function loadTodos(agentId: string): Promise<void> {
  try {
    const list = await gateway.readAgentTodos({ id: agentId });
    todos.set((state) => ({ ...state, [agentId]: list }));
  } catch {
    // offline; events will fill it in
  }
}

export async function loadAutomations(agentId: string): Promise<void> {
  try {
    const list = await gateway.listAgentAutomations({ id: agentId });
    automations.set((state) => ({ ...state, [agentId]: list }));
  } catch {
    // offline
  }
}

export function setAutomations(agentId: string, list: Automation[]): void {
  automations.set((state) => ({ ...state, [agentId]: list }));
}

export async function loadSkills(agentId: string): Promise<void> {
  try {
    setSkills(agentId, await gateway.listAgentSkills({ id: agentId }));
  } catch {
    // offline, or a box without skills
  }
}

export function setSkills(agentId: string, list: Skill[]): void {
  skills.set((state) => ({ ...state, [agentId]: list }));
}

export async function loadMemories(agentId: string): Promise<void> {
  try {
    setMemories(agentId, await gateway.getAgentMemories({ id: agentId }));
  } catch {
    // offline, or a box without memory
  }
}

export function setMemories(agentId: string, list: AgentMemory[]): void {
  memories.set((state) => ({ ...state, [agentId]: list }));
}

export async function loadMcpServers(): Promise<void> {
  try {
    setMcpState(await gateway.readAppsState({}));
  } catch {
    // offline
  }
}

/** Main runs the sign-in in the system browser; the server's row turns connected from the box's events. */
export function signInToMcpServer(serverId: string): Promise<void> {
  return trackMcpSignIn(serverId, "sign-in", () => main.startMcpSignIn({ serverId }));
}

export function signOutOfMcpServer(serverId: string): Promise<void> {
  return trackMcpSignIn(serverId, "sign-out", () => main.signOutMcpServer({ serverId }));
}

async function trackMcpSignIn(serverId: string, kind: "sign-in" | "sign-out", action: () => Promise<void>): Promise<void> {
  mcpSignIns.set((state) => ({ ...state, [serverId]: { pending: kind, error: null } }));
  let error: string | null = null;
  try {
    await action();
  } catch (cause) {
    error = (cause instanceof Error ? cause.message : String(cause)).replace(/^[\w/-]+: /, "");
  }
  mcpSignIns.set((state) => ({ ...state, [serverId]: { pending: null, error } }));
}

let started = false;
export function startAgentData(): void {
  if (started) return;
  started = true;
  gateway.subscribe({
    // The agent's main session's; another session's todos are its own.
    todos: ({ agentId, sessionId, todos: list }) => {
      if (sessionId == null || sessionId === "") todos.set((state) => ({ ...state, [agentId]: list }));
    },
    automations: ({ agentId, automations: list }) => setAutomations(agentId, list),
    skills: ({ agentId, skills }) => setSkills(agentId, skills),
    memories: ({ agentId, memories: list }) => setMemories(agentId, list),
    "apps-state": setMcpState,
    marketplaces: ({ marketplaces: list }) => {
      setMarketplaces(list);
      // Their plugins are in the catalog; a gallery that was never opened reads it when it is.
      if (mcpCatalog.get().status !== "idle") void loadMcpCatalog(true);
    },
  });
}
