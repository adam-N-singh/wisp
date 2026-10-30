// App shell: title bar, sidebar, thread or settings (or a page on the page stage beside the thread), info pane, dialogs, keyboard shortcuts.
import { useEffect } from "react";
import { desktop, main } from "./bridge";
import { AgentDialog, DeleteAgentDialog } from "./components/AgentDialog";
import { AsyncTasksPanel } from "./components/AsyncTasks";
import { AgentAvatar } from "./components/AgentAvatar";
import { AddBotDialog, ShareTemplateDialog } from "./components/BotTemplates";
import { ConnectApps } from "./components/ConnectApps";
import { NewGroupDialog } from "./components/GroupChat";
import { Icon } from "./components/icons";
import { InfoPane } from "./components/InfoPane";
import { Onboarding } from "./components/Onboarding";
import { Outline } from "./components/Outline";
import { PageWorkspace } from "./components/PageStage";
import { Palette } from "./components/Palette";
import { SettingsView } from "./components/SettingsView";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import { MOD_LABEL, onShortcutKeyDown, onShortcutKeyUp, openPalette } from "./shortcuts";
import { app, openDialog, openSettings, restoreSelection, selectAgent, type SettingsSection } from "./store/app";
import { startAgentData } from "./store/agent-data";
import { layout, updateLayout } from "./store/layout";
import { startCloud } from "./store/cloud";
import { modelSettings, startModels } from "./store/models";
import { cancelCycle, cycle } from "./store/navigation";
import { allAgents, roster, startRoster } from "./store/roster";
import { useStore } from "./store/store";
import { startOutlines } from "./store/outline";
import { stage, startPages } from "./store/pages";
import { startAsyncTasks } from "./store/async-tasks";
import { startTranscripts } from "./store/transcripts";
import { Modal } from "./components/AgentDialog";
import { CHATGPT_USAGE_URL } from "../shared/model";

function applyTheme(resolved: "light" | "dark") {
  document.documentElement.dataset.theme = resolved;
  void main.setTitlebarColors({ tone: resolved }).catch(() => undefined);
}

export function App() {
  const state = useStore(app);
  const agents = useStore(roster, (value) => value.agents);
  const hidden = useStore(roster, (value) => value.hidden);
  const loaded = useStore(roster, (value) => value.loaded);
  const sidebarCollapsed = useStore(layout, (value) => value.sidebar.isCollapsed);
  const infoOpen = useStore(layout, (value) => value.infoPane.isOpen);
  // A hidden agent stays open: it can be reached from the palette, a notification or the hidden group.
  const agent = agents.find((item) => item.id === state.agentId) ?? hidden.find((item) => item.id === state.agentId);
  const openPage = useStore(stage, (value) => value.open);
  // A page on the stage takes the details pane's place, with the agent's chat beside it.
  // In a group chat, a member's page (from its card in the room) opens beside the room's chat.
  const page = state.view === "chat" && agent != null && openPage != null && (openPage.agentId === agent.id || (agent.isGroup && agent.memberIds.includes(openPage.agentId))) ? openPage : null;

  useEffect(() => {
    applyTheme(desktop.boot.theme.resolved);
    const offTheme = main.subscribe({ "theme-updated": (theme) => applyTheme(theme.resolved) });
    const offLinks = main.subscribe({
      "link-opened": (link) => {
        if (link.route === "agent") selectAgent(link.agentId);
        else if (link.route === "settings") openSettings(link.section as SettingsSection);
        else if (link.route === "bot-template") openDialog({ kind: "add-bot", source: link.source });
        else openDialog({ kind: "new-agent" });
      },
    });
    startTranscripts();
    startOutlines();
    startPages();
    startAsyncTasks();
    startAgentData();
    startModels();
    startCloud();
    void startRoster().then(async () => {
      if (app.get().agentId == null) await restoreSelection();
      void main.acceptDeepLinks();
      if (!desktop.boot.onboardingSeen && allAgents().length === 0) openDialog({ kind: "onboarding" });
    });
    return () => {
      offTheme();
      offLinks();
    };
  }, []);

  // Pick a sensible agent when the current one disappears.
  useEffect(() => {
    if (loaded && state.agentId != null && agent == null && agents.length > 0) selectAgent(agents[0].id);
    if (loaded && state.agentId == null && agents.length > 0 && state.dialog == null) selectAgent(agents[0].id);
  }, [loaded, agents, agent, state.agentId, state.dialog]);

  useEffect(() => {
    window.addEventListener("keydown", onShortcutKeyDown);
    window.addEventListener("keyup", onShortcutKeyUp);
    window.addEventListener("pointermove", onShortcutKeyUp);
    window.addEventListener("blur", cancelCycle);
    return () => {
      window.removeEventListener("keydown", onShortcutKeyDown);
      window.removeEventListener("keyup", onShortcutKeyUp);
      window.removeEventListener("pointermove", onShortcutKeyUp);
      window.removeEventListener("blur", cancelCycle);
    };
  }, []);

  return (
    <div className={`app app--${desktop.environment.platform}`}>
      <header className="titlebar">
        <button type="button" className="icon-button titlebar__button" aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"} title={`Toggle sidebar (${MOD_LABEL}+B)`} onClick={() => updateLayout((value) => ({ ...value, sidebar: { ...value.sidebar, isCollapsed: !value.sidebar.isCollapsed } }))}>
          <Icon name="sidebar" />
        </button>
        <span className="titlebar__title">Wisp</span>
        <button type="button" className="titlebar__jump" title={`Jump to an agent, action or message (${MOD_LABEL}+K)`} onClick={() => openPalette("jump")}>
          <Icon name="search" size={13} />
          <span>Jump to…</span>
          <kbd>{MOD_LABEL}+K</kbd>
        </button>
      </header>
      <div className="shell">
        {sidebarCollapsed ? null : <Sidebar />}
        <main className="workspace">
          {state.view === "settings" ? (
            <SettingsView />
          ) : agent != null && page != null ? (
            <PageWorkspace agent={agent} open={page} />
          ) : agent != null ? (
            <ThreadView agent={agent} />
          ) : (
            <div className="empty-state">
              <h2>{loaded ? "No agent selected" : "Connecting…"}</h2>
              {loaded ? (
                <button type="button" className="button button--primary" onClick={() => openDialog({ kind: "new-agent" })}>
                  <Icon name="plus" size={14} /> New agent
                </button>
              ) : null}
            </div>
          )}
        </main>
        {state.view === "chat" && agent != null && infoOpen && page == null ? <InfoPane agent={agent} /> : null}
      </div>
      {sidebarCollapsed ? <CycleCursor /> : null}
      {state.dialog?.kind === "new-agent" ? <AgentDialog /> : null}
      {state.dialog?.kind === "new-group" ? <NewGroupDialog /> : null}
      {state.dialog?.kind === "edit-agent" ? <AgentDialog agentId={state.dialog.agentId} /> : null}
      {state.dialog?.kind === "delete-agent" ? <DeleteAgentDialog agentId={state.dialog.agentId} /> : null}
      {state.dialog?.kind === "onboarding" ? <Onboarding /> : null}
      {state.dialog?.kind === "palette" ? <Palette mode={state.dialog.mode} /> : null}
      {state.dialog?.kind === "shortcuts" ? <ShortcutsDialog /> : null}
      {state.dialog?.kind === "connect-apps" ? <ConnectApps appId={state.dialog.appId} serverId={state.dialog.serverId} tab={state.dialog.tab} /> : null}
      {state.dialog?.kind === "outline" ? <Outline agentId={state.dialog.agentId} /> : null}
      {state.dialog?.kind === "background-work" ? <AsyncTasksPanel agentId={state.dialog.agentId} /> : null}
      {state.dialog?.kind === "share-template" ? <ShareTemplateDialog key={state.dialog.agentId} agentId={state.dialog.agentId} /> : null}
      {state.dialog?.kind === "add-bot" ? <AddBotDialog key={JSON.stringify(state.dialog.source ?? null)} source={state.dialog.source} sourceLabel={state.dialog.sourceLabel} /> : null}
      <ChatGptWelcome />
    </div>
  );
}

/** Ctrl+Tab's cursor while the sidebar is hidden: the agent that opens when Ctrl is released. */
function CycleCursor() {
  const target = useStore(cycle);
  const agent = useStore(roster, (state) => state.agents.find((item) => item.id === target));
  if (agent == null) return null;
  return (
    <div className="cycle-cursor" role="status">
      <AgentAvatar agent={agent} size={24} />
      <span>{agent.name}</span>
    </div>
  );
}

/** Shown once, after the first sign-in that allows ChatGPT plan usage. */
function ChatGptWelcome() {
  const chatgpt = useStore(modelSettings, (settings) => settings.openai.chatgpt);
  if (!chatgpt.connected || !chatgpt.planUsage || chatgpt.welcomeSeen) return null;
  return (
    <Modal title="You're using your ChatGPT plan" onClose={() => void main.markChatGptWelcomeSeen()}>
      <p>Requests from agents set to OpenAI models now use your ChatGPT plan’s included usage instead of API billing. You can see and cap this app’s usage in ChatGPT settings.</p>
      <div className="modal__actions">
        <button type="button" className="button button--ghost" onClick={() => void main.openInBrowser({ url: CHATGPT_USAGE_URL })}>
          Manage usage
        </button>
        <button type="button" className="button button--primary" onClick={() => void main.markChatGptWelcomeSeen()}>
          Got it
        </button>
      </div>
    </Modal>
  );
}
