// Command palette. Ctrl+K ("Jump to") lists agents, the pages agents wrote, actions and messages;
// Ctrl+Shift+F ("Search agents") lists agents and messages. Pages come from the box's
// `libraryPages` and messages from its `findAcrossAgents`, across every conversation; what matches
// is decided in palette-match.ts. Arrows move, Enter or a click picks, Ctrl+1–9 picks that row, Esc
// closes.
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { type AgentSummary, isAgentWorking, type MessageMatch } from "../../shared/model";
import { type LibraryPage, pageId } from "../../shared/pages";
import { gateway, main } from "../bridge";
import { agentScore, canHaveAgentBrowser, pageMatches } from "../palette-match";
import { isModKey, MOD_LABEL, openPalette, shortcutKey, SHORTCUTS } from "../shortcuts";
import { app, closeDialog, closeSettings, openAsyncTasks, openConnectApps, openDialog, openOutline, openSettings, type PaletteMode, selectAgent, setShowHidden, type SettingsSection } from "../store/app";
import { openFind } from "../store/find";
import { openInfoTab, updateLayout } from "../store/layout";
import { allPages, drafts, loadAllPages, openPage, pageKey } from "../store/pages";
import { allAgents, roster } from "../store/roster";
import { useStore } from "../store/store";
import { AgentAvatar } from "./AgentAvatar";
import { focusComposer } from "./Composer";
import { Icon, type IconName } from "./icons";
import { Keys } from "./ShortcutsDialog";
import { relativeTime, statusLine } from "./Sidebar";

interface Action {
  id: string;
  label: string;
  icon: IconName;
  /** More words it is found by. */
  keywords?: string;
  /** Its entry in the shortcut table, for the keys shown beside it. */
  shortcut?: string;
  run(): void;
}

type Row =
  | { kind: "agent"; key: string; agent: AgentSummary }
  | { kind: "page"; key: string; page: LibraryPage; agent: AgentSummary }
  | { kind: "action"; key: string; action: Action }
  | { kind: "message"; key: string; hit: MessageMatch; agent: AgentSummary | undefined };

const SETTINGS: Array<{ section: SettingsSection; label: string; keywords?: string; shortcut?: string }> = [
  { section: "general", label: "General", keywords: "appearance notifications spell", shortcut: "openSettings" },
  { section: "box", label: "Box", keywords: "remote server" },
  { section: "model", label: "Models", keywords: "provider api key chatgpt claude default model" },
  { section: "cloud", label: "Cloud computer", keywords: "e2b sandbox" },
  { section: "permissions", label: "Permissions", keywords: "approvals tools" },
  { section: "vault", label: "Vault", keywords: "passwords logins contact info address import csv" },
  { section: "mcp", label: "MCP servers", keywords: "tools connectors apps" },
  { section: "about", label: "About", keywords: "version" },
];

function paletteActions(agent: AgentSummary | undefined, hiddenCount: number): Action[] {
  const actions: Action[] = [
    { id: "new-agent", label: "New agent", icon: "plus", keywords: "create add bot", shortcut: "newAgent", run: () => openDialog({ kind: "new-agent" }) },
    { id: "new-group", label: "New group chat", icon: "users", keywords: "create room bots together team members", shortcut: "newGroupChat", run: () => openDialog({ kind: "new-group" }) },
    { id: "add-bot", label: "Add bot from a template", icon: "download", keywords: "import template share file link", run: () => openDialog({ kind: "add-bot" }) },
    { id: "bot-templates", label: "Bot templates", icon: "sparkle", keywords: "starter gallery marketplace templates", run: () => openConnectApps({ tab: "bots" }) },
    { id: "connect-apps", label: "Connect Apps", icon: "plug", keywords: "mcp servers tools connectors integrations plugins github linear notion", shortcut: "openTools", run: () => openConnectApps() },
  ];
  if (agent != null && agent.isGroup) {
    // A group chat: its conversation and its members; it has no tools, skills or template of its own.
    actions.push(
      { id: "find", label: `Find in chat with ${agent.name}`, icon: "search", keywords: "search conversation", shortcut: "findInChat", run: () => (closeSettings(), openFind(agent.id)) },
      { id: "outline", label: `${agent.name}: Show full conversation`, icon: "outline", keywords: "outline", run: () => openOutline(agent.id) },
      { id: "members", label: `${agent.name}: Members`, icon: "users", keywords: "add remove bots rename group", run: () => (closeSettings(), updateLayout((state) => ({ ...state, infoPane: { ...state.infoPane, isOpen: true } }))) },
    );
  } else if (agent != null) {
    actions.push(
      { id: "find", label: `Find in chat with ${agent.name}`, icon: "search", keywords: "search conversation", shortcut: "findInChat", run: () => (closeSettings(), openFind(agent.id)) },
      { id: "outline", label: `${agent.name}: Show full conversation`, icon: "outline", keywords: "outline thinking tool calls reasoning", run: () => openOutline(agent.id) },
      { id: "background-work", label: `${agent.name}: Async tasks`, icon: "terminal", keywords: "background commands running jobs stop", run: () => openAsyncTasks(agent.id) },
      ...(canHaveAgentBrowser(agent)
        ? [{ id: "agent-browser", label: `${agent.name}: Show agent browser`, icon: "globe", keywords: "web browsing window tabs sites sign in", run: () => void main.showAgentBrowser({ agentId: agent.id }).catch(() => undefined) } satisfies Action]
        : []),
      { id: "skills", label: `${agent.name}: Skills`, icon: "bolt", keywords: "workflows commands", shortcut: "openSkills", run: () => (closeSettings(), openInfoTab("skills")) },
      { id: "automations", label: `${agent.name}: Automations`, icon: "clock", keywords: "schedule cron routines", run: () => (closeSettings(), openInfoTab("automations")) },
      { id: "edit-agent", label: `${agent.name}: Edit agent`, icon: "edit", keywords: "rename instructions model settings", shortcut: "agentSettings", run: () => openDialog({ kind: "edit-agent", agentId: agent.id }) },
      { id: "share-template", label: `${agent.name}: Share as template`, icon: "share", keywords: "export template file link publish", run: () => openDialog({ kind: "share-template", agentId: agent.id }) },
      {
        id: "notify",
        label: `${agent.name}: ${agent.notifyOnUpdatesEnabled ? "Mute" : "Unmute"} finished notifications`,
        icon: agent.notifyOnUpdatesEnabled ? "bellOff" : "bell",
        keywords: "notifications quiet",
        run: () => void gateway.changeAgentNotifications({ id: agent.id, isEnabled: !agent.notifyOnUpdatesEnabled }).catch(() => undefined),
      },
      {
        id: "hide",
        label: `${agent.name}: ${agent.isHiddenFromSidebar === true ? "Show in sidebar" : "Hide from sidebar"}`,
        icon: agent.isHiddenFromSidebar === true ? "eye" : "eyeOff",
        keywords: "sidebar visible",
        run: () => void gateway.changeAgentHidden({ id: agent.id, isHidden: agent.isHiddenFromSidebar !== true }).catch(() => undefined),
      },
    );
  }
  if (hiddenCount > 0) {
    actions.push({
      id: "show-hidden",
      label: `Show hidden agents (${hiddenCount})`,
      icon: "eye",
      keywords: "sidebar",
      run: () => {
        updateLayout((state) => ({ ...state, sidebar: { ...state.sidebar, isCollapsed: false } }));
        setShowHidden(true);
      },
    });
  }
  actions.push(
    ...SETTINGS.map(({ section, label, keywords, shortcut }): Action => ({ id: `settings-${section}`, label: `Settings: ${label}`, icon: section === "mcp" ? "plug" : "gear", keywords, shortcut, run: () => openSettings(section) })),
    ...(["system", "light", "dark"] as const).map(
      (preference): Action => ({
        id: `theme-${preference}`,
        label: `Theme: ${preference === "system" ? "System" : preference === "light" ? "Light" : "Dark"}`,
        icon: preference === "system" ? "contrast" : preference === "light" ? "sun" : "moon",
        keywords: "appearance mode color",
        run: () => void main.chooseTheme({ preference }).catch(() => undefined),
      }),
    ),
    { id: "shortcuts", label: "Keyboard shortcuts", icon: "keyboard", keywords: "keys hotkeys help", shortcut: "keyboardShortcuts", run: () => openDialog({ kind: "shortcuts" }) },
    { id: "sidebar", label: "Show or hide the sidebar", icon: "sidebar", shortcut: "toggleSidebar", run: () => updateLayout((state) => ({ ...state, sidebar: { ...state.sidebar, isCollapsed: !state.sidebar.isCollapsed } })) },
    { id: "details", label: "Show or hide the details pane", icon: "panelRight", keywords: "info", shortcut: "toggleInfo", run: () => updateLayout((state) => ({ ...state, infoPane: { ...state.infoPane, isOpen: !state.infoPane.isOpen } })) },
  );
  return actions;
}

/** Messages that contain the query, searched a moment after typing stops. */
function useMessageSearch(query: string): { status: "idle" | "searching" | "ready" | "error"; hits: MessageMatch[] } {
  const [state, setState] = useState<{ status: "idle" | "searching" | "ready" | "error"; hits: MessageMatch[] }>({ status: "idle", hits: [] });
  useEffect(() => {
    const wanted = query.trim();
    if (wanted.length < 2) {
      setState({ status: "idle", hits: [] });
      return;
    }
    setState((current) => ({ ...current, status: "searching" }));
    let stale = false;
    const timer = setTimeout(() => {
      gateway.findAcrossAgents({ query: wanted, limit: 20 }).then(
        (hits) => stale || setState({ status: "ready", hits }),
        () => stale || setState({ status: "error", hits: [] }),
      );
    }, 180);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query]);
  return state;
}

function Highlighted({ text, query }: { text: string; query: string }) {
  if (query.length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "giu"));
  return <>{parts.map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part))}</>;
}

export function Palette({ mode }: { mode: PaletteMode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [modHeld, setModHeld] = useState(false);
  const rosterState = useStore(roster);
  const currentId = useStore(app, (state) => state.agentId);
  const messages = useMessageSearch(query);
  const pages = useStore(allPages);
  const unsaved = useStore(drafts);
  const listId = useId();
  const needle = query.trim().toLowerCase();

  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  // Read again each time "Jump to" opens; "page-changed" keeps it current meanwhile.
  useEffect(() => {
    if (mode === "jump") void loadAllPages();
  }, [mode]);

  const groups = useMemo(() => {
    const everyone = allAgents(rosterState);
    const current = everyone.find((agent) => agent.id === currentId);
    let agents: AgentSummary[];
    if (needle.length === 0) agents = mode === "jump" ? rosterState.agents.slice(0, 6) : everyone.slice(0, 50);
    else
      agents = everyone
        .map((agent, order) => ({ agent, order, score: agentScore(agent, needle) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .slice(0, mode === "jump" ? 8 : 20)
        .map((item) => item.agent);
    const words = needle.split(/\s+/).filter((word) => word.length > 0);
    const actions = mode === "jump" ? paletteActions(current, rosterState.hidden.length).filter((action) => words.every((word) => `${action.label} ${action.keywords ?? ""}`.toLowerCase().includes(word))) : [];
    const found = mode === "jump" ? pageMatches(pages ?? [], { visible: rosterState.agents, hidden: rosterState.hidden }, needle, needle.length === 0 ? 4 : 8) : [];
    const result: Array<{ title: string; rows: Row[]; note?: string }> = [];
    if (agents.length > 0) result.push({ title: "Agents", rows: agents.map((agent) => ({ kind: "agent", key: `agent:${agent.id}`, agent })) });
    if (found.length > 0) result.push({ title: "Pages", rows: found.map(({ page, agent }) => ({ kind: "page", key: `page:${agent.id}:${pageId(page.page)}`, page, agent })) });
    if (actions.length > 0) result.push({ title: "Actions", rows: actions.map((action) => ({ kind: "action", key: `action:${action.id}`, action })) });
    if (messages.status !== "idle") {
      const rows: Row[] = messages.hits.map((hit) => ({ kind: "message", key: `message:${hit.agentId}:${hit.entryId}`, hit, agent: everyone.find((agent) => agent.id === hit.agentId) }));
      const note = messages.status === "error" ? "Search unavailable" : rows.length === 0 ? (messages.status === "searching" ? "Searching messages…" : "No messages match") : undefined;
      result.push({ title: "Messages", rows, note });
    }
    return result;
  }, [rosterState, currentId, needle, mode, messages, pages]);

  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const selected = Math.min(active, rows.length - 1);

  useEffect(() => {
    setActive(0);
  }, [needle, mode]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, rows]);

  const pick = (row: Row | undefined) => {
    if (row == null) return;
    closeDialog();
    if (row.kind === "agent") {
      selectAgent(row.agent.id);
      setTimeout(focusComposer, 0);
    } else if (row.kind === "page") {
      // Its agent's conversation first: the stage belongs to it.
      selectAgent(row.agent.id);
      openPage(row.agent.id, pageId(row.page.page));
    } else if (row.kind === "action") row.action.run();
    else {
      selectAgent(row.hit.agentId);
      openFind(row.hit.agentId, { query: query.trim(), entryId: row.hit.entryId });
    }
  };

  /** What a row shows. */
  const rowContent = (row: Row): ReactNode => {
    switch (row.kind) {
      case "agent":
        return (
          <>
            <AgentAvatar agent={row.agent} size={28} busy={isAgentWorking(row.agent)} />
            <span className="palette__text">
              <span className="palette__title">
                <Highlighted text={row.agent.name} query={needle} />
              </span>
              <span className="palette__detail">{statusLine(row.agent).text}</span>
            </span>
            {row.agent.isHiddenFromSidebar === true ? <span className="pill">Hidden</span> : null}
          </>
        );
      case "page":
        return (
          <>
            <span className="palette__icon">
              <Icon name={row.page.page.kind === "canvas" ? "code" : "file"} size={16} />
            </span>
            <span className="palette__text">
              <span className="palette__title">
                <Highlighted text={row.page.title} query={needle} />
              </span>
              <span className="palette__detail">
                {row.agent.name}
                {row.page.page.kind === "canvas" ? " · canvas" : ""}
                {row.page.updatedBy === "user" ? (row.page.page.kind === "canvas" ? " · restored by you" : " · edited by you") : ""} · {relativeTime(row.page.updatedAt)}
                {unsaved[pageKey(row.agent.id, pageId(row.page.page))] != null ? <span className="page-card__unsaved"> · unsaved changes</span> : null}
              </span>
            </span>
            {row.agent.isHiddenFromSidebar === true ? <span className="pill">Hidden</span> : null}
          </>
        );
      case "action":
        return (
          <>
            <span className="palette__icon">
              <Icon name={row.action.icon} size={16} />
            </span>
            <span className="palette__text">
              <span className="palette__title">
                <Highlighted text={row.action.label} query={needle} />
              </span>
            </span>
            {row.action.shortcut != null && !modHeld ? <Keys keys={SHORTCUTS.find((shortcut) => shortcut.id === row.action.shortcut)?.keys ?? []} /> : null}
          </>
        );
      case "message":
        return (
          <>
            {row.agent != null ? (
              <AgentAvatar agent={row.agent} size={28} />
            ) : (
              <span className="palette__icon">
                <Icon name="message" size={16} />
              </span>
            )}
            <span className="palette__text">
              <span className="palette__title">
                {row.agent?.name ?? "Deleted agent"}
                <span className="palette__meta">
                  {row.hit.role === "user" ? "You" : "Agent"} · {relativeTime(row.hit.timestampMs)}
                </span>
              </span>
              <span className="palette__detail palette__snippet">
                <Highlighted text={row.hit.snippet} query={query.trim()} />
              </span>
            </span>
          </>
        );
    }
  };

  const optionId = (index: number) => `${listId}-option-${index}`;
  let index = -1;
  const option = (row: Row, content: ReactNode) => {
    index++;
    const position = index;
    return (
      <div
        key={row.key}
        id={optionId(position)}
        role="option"
        aria-selected={position === selected}
        className={`palette__row${position === selected ? " palette__row--active" : ""}`}
        onMouseMove={() => position !== selected && setActive(position)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => pick(row)}
      >
        {content}
        {modHeld && position < 9 ? <kbd className="palette__number">{position + 1}</kbd> : null}
      </div>
    );
  };

  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-label={mode === "jump" ? "Jump to" : "Search agents"}
      onCancel={(event) => {
        event.preventDefault();
        closeDialog();
      }}
      onMouseDown={(event) => {
        if (event.target === dialog.current) closeDialog();
      }}
      onKeyDown={(event) => {
        if (event.key === "Control" || event.key === "Meta") setModHeld(isModKey(event));
      }}
      onKeyUp={(event) => {
        if (event.key === "Control" || event.key === "Meta") setModHeld(false);
      }}
    >
      <div className="palette__field">
        <Icon name="search" size={16} />
        <input
          autoFocus
          value={query}
          placeholder={mode === "jump" ? "Jump to an agent, page, action or message…" : "Search agents and messages…"}
          aria-label={mode === "jump" ? "Jump to" : "Search agents"}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={rows.length > 0 ? optionId(selected) : undefined}
          maxLength={500}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onBlur={() => setModHeld(false)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            const key = shortcutKey(event.nativeEvent);
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (rows.length > 0) setActive((selected + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
            } else if (event.key === "Enter") {
              event.preventDefault();
              pick(rows[selected]);
            } else if (isModKey(event) && !event.shiftKey && !event.altKey && /^[1-9]$/.test(key)) {
              event.preventDefault();
              pick(rows[Number(key) - 1]);
            } else if (isModKey(event) && !event.altKey && ((!event.shiftKey && key === "k") || (event.shiftKey && key === "f"))) {
              // The other palette's shortcut switches to it; its own closes it.
              event.preventDefault();
              const wanted: PaletteMode = key === "k" ? "jump" : "search";
              if (wanted === mode) closeDialog();
              else openPalette(wanted);
            }
          }}
        />
      </div>
      <div className="palette__results" ref={list} id={listId} role="listbox" aria-label="Results">
        {groups.map((group) => (
          <div key={group.title} role="group" aria-label={group.title} className="palette__group">
            <div className="palette__group-title" role="presentation">
              {group.title}
            </div>
            {group.rows.map((row) => option(row, rowContent(row)))}
            {group.note != null ? <div className={`palette__note${messages.status === "error" ? " palette__note--error" : ""}`}>{group.note}</div> : null}
          </div>
        ))}
        {groups.length === 0 ? <div className="palette__empty">{needle.length > 0 ? "No results" : "No agents yet"}</div> : null}
      </div>
      <div className="palette__footer" aria-hidden="true">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> move
        </span>
        <span>
          <kbd>Enter</kbd> open
        </span>
        <span>
          <Keys keys={[[MOD_LABEL, "1–9"]]} /> pick a row
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </div>
    </dialog>
  );
}
