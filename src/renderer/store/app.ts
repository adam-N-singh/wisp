// App-level UI state: the selected agent (persisted as `selection.last-agent`),
// the current view, and open dialogs.
import type { BotTemplateSource } from "../../shared/edges";
import { gateway, main } from "../bridge";
import { closeFind } from "./find";
import { closePage, stage } from "./pages";
import { getAgent, roster } from "./roster";
import { readSlice, sliceKey, writeSlice } from "./slices";
import { Store } from "./store";
import { openTranscript } from "./transcripts";

export type SettingsSection = "general" | "box" | "model" | "cloud" | "permissions" | "vault" | "mcp" | "about";

/**
 * Connect Apps' front page: the apps (with marketplaces' plugins), their skills, the marketplaces
 * the user added, or the bot templates.
 */
export type ConnectAppsTab = "apps" | "skills" | "marketplaces" | "bots";

/** "jump" is Ctrl+K (agents, actions and messages); "search" is Ctrl+Shift+F (agents and messages). */
export type PaletteMode = "jump" | "search";

export type Dialog =
  | { kind: "new-agent" }
  /** New group chat (Mod+Shift+N). */
  | { kind: "new-group" }
  | { kind: "edit-agent"; agentId: string }
  | { kind: "delete-agent"; agentId: string }
  | { kind: "onboarding" }
  | { kind: "palette"; mode: PaletteMode }
  | { kind: "shortcuts" }
  /** Connect Apps, at the gallery or at one app or server. */
  | { kind: "connect-apps"; appId?: string; serverId?: string; tab?: ConnectAppsTab }
  /** The agent's full conversation: thinking, replies, cards and tool calls. */
  | { kind: "outline"; agentId: string }
  /** The agent's background work still running ("Async tasks"). */
  | { kind: "background-work"; agentId: string }
  /** Share as template, from an agent's menu. */
  | { kind: "share-template"; agentId: string }
  /** Add Bot: a template from a link, a file or pasted text, previewed before anything is created. */
  | { kind: "add-bot"; source?: BotTemplateSource; sourceLabel?: string }
  | null;

export interface AppState {
  agentId: string | null;
  view: "chat" | "settings";
  settingsSection: SettingsSection;
  dialog: Dialog;
  search: string;
  /** The sidebar's "Hidden agents" group is expanded. */
  showHidden: boolean;
}

const LAST_AGENT = sliceKey("selection.last-agent");

export const app = new Store<AppState>({ agentId: null, view: "chat", settingsSection: "general", dialog: null, search: "", showHidden: false });

export function selectAgent(agentId: string | null): void {
  // The find bar belongs to one conversation, and the page stage to one agent's chat.
  if (agentId !== app.get().agentId) closeFind();
  if (agentId !== stage.get().open?.agentId) closePage();
  app.set((state) => ({ ...state, agentId, view: "chat" }));
  void main.noteOpenAgent({ agentId }).catch(() => undefined);
  if (agentId == null) return;
  writeSlice(LAST_AGENT, 1, { agentId });
  void openTranscript(agentId);
  if (getAgent(agentId)?.hasUnread) void gateway.markAgentUnread({ id: agentId, isUnread: false }).catch(() => undefined);
}

export function openSettings(section: SettingsSection = "general"): void {
  app.set((state) => ({ ...state, view: "settings", settingsSection: section }));
}

export function closeSettings(): void {
  app.set((state) => ({ ...state, view: "chat" }));
}

export function openDialog(dialog: Dialog): void {
  app.set((state) => ({ ...state, dialog }));
}

export function closeDialog(): void {
  app.set((state) => ({ ...state, dialog: null }));
}

export function openConnectApps(at: { appId?: string; serverId?: string; tab?: ConnectAppsTab } = {}): void {
  openDialog({ kind: "connect-apps", ...at });
}

export function openOutline(agentId: string): void {
  openDialog({ kind: "outline", agentId });
}

export function openAsyncTasks(agentId: string): void {
  openDialog({ kind: "background-work", agentId });
}

export function setShowHidden(showHidden: boolean): void {
  app.set((state) => ({ ...state, showHidden }));
}

/** Restore the last agent once the roster is known; otherwise pick the first one. */
export async function restoreSelection(): Promise<void> {
  const last = await readSlice<{ agentId: string }>(LAST_AGENT, 1);
  const agents = roster.get().agents;
  const target = getAgent(last?.agentId ?? null) ?? agents[0];
  if (target != null) selectAgent(target.id);
}

// Keep the viewed agent's unread state clear while the window is focused.
roster.subscribe(() => {
  const { agentId, view } = app.get();
  if (agentId == null || view !== "chat" || !document.hasFocus()) return;
  if (getAgent(agentId)?.hasUnread) void gateway.markAgentUnread({ id: agentId, isUnread: false }).catch(() => undefined);
});
window.addEventListener("focus", () => {
  const { agentId } = app.get();
  if (agentId != null && getAgent(agentId)?.hasUnread) void gateway.markAgentUnread({ id: agentId, isUnread: false }).catch(() => undefined);
});
