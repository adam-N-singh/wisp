// A popup menu (arrows move, Esc closes, a click outside closes) and the agent actions the sidebar
// rows and the conversation header share.
import { type CSSProperties, type ReactNode, type RefObject, useEffect, useRef } from "react";
import type { AgentSummary } from "../../shared/model";
import { gateway } from "../bridge";
import { openAsyncTasks, openDialog, openOutline } from "../store/app";
import { Icon } from "./icons";

export function Menu({
  label,
  onClose,
  trigger,
  className,
  style,
  children,
}: {
  label: string;
  onClose(): void;
  trigger?: RefObject<HTMLElement | null>;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger?.current?.contains(event.target as Node)) close.current();
    };
    window.addEventListener("mousedown", outside);
    menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => window.removeEventListener("mousedown", outside);
  }, [trigger]);

  return (
    <div
      ref={menu}
      className={`menu${className != null ? ` ${className}` : ""}`}
      style={style}
      role="menu"
      aria-label={label}
      onKeyDown={(event) => {
        const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
        const at = items.indexOf(document.activeElement as HTMLElement);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          items[event.key === "Home" ? 0 : items.length - 1]?.focus();
        } else if (event.key === "Escape") {
          event.preventDefault();
          close.current();
          trigger?.current?.focus();
        } else if (event.key === "Tab") close.current();
      }}
    >
      {children}
    </div>
  );
}

/** Edit, pin, read state, notifications, sidebar visibility, the full conversation, fresh start, duplicate, share as template, delete. */
export function AgentMenuItems({ agent, onDone }: { agent: AgentSummary; onDone(): void }) {
  const act = (run: () => unknown) => () => {
    onDone();
    void Promise.resolve(run()).catch(() => undefined);
  };
  const hidden = agent.isHiddenFromSidebar === true;
  return (
    <>
      <button type="button" role="menuitem" onClick={act(() => openDialog({ kind: "edit-agent", agentId: agent.id }))}>
        <Icon name="edit" size={14} /> Edit agent
      </button>
      <button type="button" role="menuitem" onClick={act(() => gateway.updateAgentConfig({ id: agent.id, isPinned: !agent.isPinned }))}>
        <Icon name="pin" size={14} /> {agent.isPinned ? "Unpin" : "Pin to top"}
      </button>
      <button type="button" role="menuitem" onClick={act(() => gateway.markAgentUnread({ id: agent.id, isUnread: !agent.hasUnread }))}>
        <Icon name="info" size={14} /> {agent.hasUnread ? "Mark read" : "Mark unread"}
      </button>
      <button
        type="button"
        role="menuitem"
        title={agent.notifyOnUpdatesEnabled ? "No notification when this agent finishes; questions and approvals still notify" : undefined}
        onClick={act(() => gateway.changeAgentNotifications({ id: agent.id, isEnabled: !agent.notifyOnUpdatesEnabled }))}
      >
        <Icon name={agent.notifyOnUpdatesEnabled ? "bellOff" : "bell"} size={14} /> {agent.notifyOnUpdatesEnabled ? "Mute finished notifications" : "Unmute finished notifications"}
      </button>
      <button type="button" role="menuitem" onClick={act(() => gateway.changeAgentHidden({ id: agent.id, isHidden: !hidden }))}>
        <Icon name={hidden ? "eye" : "eyeOff"} size={14} /> {hidden ? "Show in sidebar" : "Hide from sidebar"}
      </button>
      <button type="button" role="menuitem" onClick={act(() => openOutline(agent.id))}>
        <Icon name="outline" size={14} /> Show full conversation
      </button>
      <button type="button" role="menuitem" onClick={act(() => openAsyncTasks(agent.id))}>
        <Icon name="terminal" size={14} /> Async tasks{(agent.asyncTaskCount ?? 0) > 0 ? ` (${agent.asyncTaskCount})` : ""}
      </button>
      <button type="button" role="menuitem" onClick={act(() => gateway.resetConversation({ id: agent.id }))}>
        <Icon name="refresh" size={14} /> Start fresh conversation
      </button>
      <button type="button" role="menuitem" onClick={act(() => gateway.copyAgent({ id: agent.id }))}>
        <Icon name="plus" size={14} /> Duplicate
      </button>
      <button type="button" role="menuitem" onClick={act(() => openDialog({ kind: "share-template", agentId: agent.id }))}>
        <Icon name="share" size={14} /> Share as template…
      </button>
      <div className="menu__separator" role="separator" />
      <button type="button" role="menuitem" className="menu__danger" onClick={act(() => openDialog({ kind: "delete-agent", agentId: agent.id }))}>
        <Icon name="trash" size={14} /> Delete agent
      </button>
    </>
  );
}
