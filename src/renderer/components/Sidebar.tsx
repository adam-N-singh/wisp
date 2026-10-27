// Agent roster sidebar. Each row has an actions menu (its … button, or a right-click); agents hidden
// from the sidebar are listed in a "Hidden agents" group at the end, from which they can be shown again.
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { type AgentSummary, isAgentWorking } from "../../shared/model";
import { MOD_LABEL } from "../shortcuts";
import { app, openConnectApps, openDialog, openSettings, selectAgent, setShowHidden } from "../store/app";
import { layout, updateLayout } from "../store/layout";
import { cycle, sidebarRows } from "../store/navigation";
import { roster } from "../store/roster";
import { useStore } from "../store/store";
import { activityText, backgroundText } from "./activity";
import { AgentMenuItems, Menu } from "./AgentMenu";
import { Avatar } from "./Avatar";
import { Icon } from "./icons";

export function statusLine(agent: AgentSummary): { text: string; tone: "default" | "working" | "attention" } {
  if (agent.awaitingUserResponse != null) return { text: agent.awaitingUserResponse.reason === "approval" ? "Needs your approval" : "Has a question for you", tone: "attention" };
  if (agent.isRunning) {
    const activity = agent.currentActivity;
    return { text: activity?.kind === "tool" || activity?.kind === "searching" ? activityText(activity) : agent.isComposingMessage ? "Writing…" : "Thinking…", tone: "working" };
  }
  if (isAgentWorking(agent)) return { text: backgroundText(agent), tone: "working" };
  const preview = agent.lastMessagePreview ?? (agent.lastEntry?.kind === "text" ? agent.lastEntry.text : agent.lastEntry?.kind === "attachment" ? `${agent.lastEntry.count} attachment(s)` : "");
  return { text: preview || agent.description || "No messages yet", tone: "default" };
}

export function relativeTime(ms: number | undefined): string {
  if (ms == null) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function Sidebar() {
  const { agents, hidden, connection } = useStore(roster);
  const selected = useStore(app, (state) => state.agentId);
  const search = useStore(app, (state) => state.search);
  const showHidden = useStore(app, (state) => state.showHidden);
  const unreadOnly = useStore(layout, (state) => state.isSidebarUnreadOnly);
  const width = useStore(layout, (state) => state.sidebar.expandedWidth);
  const cursor = useStore(cycle);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const hiddenGroup = useRef<HTMLLIElement>(null);

  const rows = useMemo(() => sidebarRows(agents, search, unreadOnly, selected), [agents, search, unreadOnly, selected]);
  const hiddenRows = useMemo(() => sidebarRows(hidden, search, false, selected), [hidden, search, selected]);

  // "Show hidden agents" from the palette scrolls the group into view.
  useEffect(() => {
    if (showHidden) hiddenGroup.current?.scrollIntoView({ block: "nearest" });
  }, [showHidden]);

  const row = (agent: AgentSummary) => <AgentRow key={agent.id} agent={agent} selected={agent.id === selected} cursor={agent.id === cursor} menuOpen={menuFor === agent.id} onMenu={(open) => setMenuFor(open ? agent.id : null)} />;

  return (
    <nav className="sidebar" style={{ width }} aria-label="Agents">
      <div className="sidebar__header">
        <div className="sidebar__search">
          <Icon name="search" size={14} />
          <input value={search} placeholder="Search agents" onChange={(event) => app.set((state) => ({ ...state, search: event.target.value }))} aria-label="Search agents" />
        </div>
        <button type="button" className="icon-button" aria-label="New agent" title="New agent (Ctrl+N)" onClick={() => openDialog({ kind: "new-agent" })}>
          <Icon name="plus" />
        </button>
      </div>

      <div className="sidebar__filters">
        <button type="button" className={`chip${unreadOnly ? "" : " chip--active"}`} onClick={() => updateLayout((state) => ({ ...state, isSidebarUnreadOnly: false }))}>
          All
        </button>
        <button type="button" className={`chip${unreadOnly ? " chip--active" : ""}`} onClick={() => updateLayout((state) => ({ ...state, isSidebarUnreadOnly: true }))}>
          Unread
        </button>
      </div>

      <ul className="sidebar__list" role="list">
        {rows.map(row)}
        {rows.length === 0 ? <li className="sidebar__empty">{agents.length === 0 && hidden.length === 0 ? "No agents yet. Create one to get started." : agents.length === 0 ? "Every agent is hidden." : "Nothing matches."}</li> : null}
        {hiddenRows.length > 0 ? (
          <li ref={hiddenGroup} className="sidebar__group">
            <button type="button" className="sidebar__group-toggle" aria-expanded={showHidden} onClick={() => setShowHidden(!showHidden)}>
              <Icon name={showHidden ? "chevronDown" : "chevronRight"} size={12} />
              Hidden agents
              <span className="sidebar__group-count">{hiddenRows.length}</span>
            </button>
            {showHidden ? (
              <ul className="sidebar__hidden" role="list">
                {hiddenRows.map(row)}
              </ul>
            ) : null}
          </li>
        ) : null}
      </ul>

      <div className="sidebar__footer">
        <button type="button" className="sidebar__footer-button" onClick={() => openSettings()}>
          <Icon name="gear" />
          <span>Settings</span>
        </button>
        <button type="button" className="sidebar__footer-button sidebar__footer-button--apps" onClick={() => openConnectApps()} aria-label="Connect Apps" title={`Connect Apps (${MOD_LABEL}+Shift+M)`}>
          <Icon name="plug" />
          <span>Connect Apps</span>
        </button>
        <span className="grow" />
        <span className={`connection-dot connection-dot--${connection}`} title={connection === "connected" ? "Connected to your box" : connection === "down" ? "Reconnecting to your box…" : "Connecting…"} />
      </div>
    </nav>
  );
}

/** Rows can sit low in a scrolled list: the menu is placed against the window, below the … button or above it. */
const MENU_HEIGHT = 300;

function AgentRow({ agent, selected, cursor, menuOpen, onMenu }: { agent: AgentSummary; selected: boolean; cursor: boolean; menuOpen: boolean; onMenu(open: boolean): void }) {
  const more = useRef<HTMLButtonElement>(null);
  const element = useRef<HTMLLIElement>(null);
  const [place, setPlace] = useState<CSSProperties>({});
  const status = statusLine(agent);

  useEffect(() => {
    if (cursor) element.current?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const openMenu = () => {
    const rect = (more.current ?? element.current)?.getBoundingClientRect();
    if (rect != null) setPlace(rect.bottom + MENU_HEIGHT < window.innerHeight ? { top: rect.bottom + 4, left: rect.left } : { bottom: window.innerHeight - rect.top + 4, left: rect.left });
    onMenu(true);
  };

  return (
    <li
      ref={element}
      className={`agent-row-item${menuOpen ? " agent-row-item--menu" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu();
      }}
    >
      <button
        type="button"
        className={`agent-row${selected ? " agent-row--selected" : ""}${cursor ? " agent-row--cursor" : ""}${agent.isHiddenFromSidebar === true ? " agent-row--hidden" : ""}`}
        onClick={() => selectAgent(agent.id)}
        aria-current={selected ? "page" : undefined}
      >
        <Avatar shape={agent.avatarShape} color={agent.avatarColor} size={32} busy={isAgentWorking(agent)} image={agent.avatarDataUrl} />
        <span className="agent-row__text">
          <span className="agent-row__top">
            <span className={`agent-row__name${agent.hasUnread ? " agent-row__name--unread" : ""}`}>{agent.name}</span>
            {agent.isPinned ? <Icon name="pin" size={12} className="agent-row__pin" /> : null}
            {!agent.notifyOnUpdatesEnabled ? <Icon name="bellOff" size={12} className="agent-row__pin" role="img" aria-hidden={false} aria-label="Finished notifications muted" /> : null}
            <span className="agent-row__time">{relativeTime(agent.lastActivityAt)}</span>
          </span>
          <span className={`agent-row__status agent-row__status--${status.tone}`}>{status.text}</span>
        </span>
        {agent.awaitingUserResponse != null ? <span className="badge badge--attention" aria-label="Needs you" /> : agent.hasUnread ? <span className="badge">{agent.unreadCount && agent.unreadCount > 1 ? agent.unreadCount : ""}</span> : null}
      </button>
      <button ref={more} type="button" className="icon-button icon-button--small agent-row__more" aria-label={`${agent.name} actions`} aria-haspopup="menu" aria-expanded={menuOpen} title="Agent actions" onClick={() => (menuOpen ? onMenu(false) : openMenu())}>
        <Icon name="more" size={14} />
      </button>
      {menuOpen ? (
        <Menu label={`${agent.name} actions`} trigger={more} className="menu--row" style={place} onClose={() => onMenu(false)}>
          <AgentMenuItems agent={agent} onDone={() => onMenu(false)} />
        </Menu>
      ) : null}
    </li>
  );
}
