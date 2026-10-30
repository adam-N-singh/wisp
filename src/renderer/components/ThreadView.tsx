// The open conversation: header, find bar, transcript, composer. Beside a page on the page stage it
// is the companion column (`companion`), and the details pane stays closed.
import { useEffect, useRef, useState } from "react";
import { type AgentSummary, isAgentWorking, isSessionRunning } from "../../shared/model";
import { main } from "../bridge";
import { openAsyncTasks, openOutline } from "../store/app";
import { openFind } from "../store/find";
import { layout, updateLayout } from "../store/layout";
import { getAgent, roster } from "../store/roster";
import { useStore } from "../store/store";
import { activityText, backgroundText } from "./activity";
import { AgentMenuItems, Menu } from "./AgentMenu";
import { AgentAvatar } from "./AgentAvatar";
import { groupActivityText, namesText } from "./GroupChat";
import { Composer } from "./Composer";
import { FindBar } from "./FindBar";
import { Icon } from "./icons";
import { Transcript } from "./Transcript";

function headerStatus(agent: AgentSummary): string {
  if (agent.awaitingUserResponse != null) return agent.awaitingUserResponse.reason === "approval" ? "Waiting for your approval" : "Waiting for your answer";
  if (agent.isGroup) return groupActivityText(agent) ?? namesText(agent.memberIds.map((id) => getAgent(id)?.name ?? "A bot"));
  if (isSessionRunning(agent)) return agent.isComposingMessage ? "Writing…" : activityText(agent.currentActivity);
  if (isAgentWorking(agent)) return backgroundText(agent);
  return agent.title || agent.description || "";
}

export function ThreadView({ agent, companion = false }: { agent: AgentSummary; companion?: boolean }) {
  const infoOpen = useStore(layout, (state) => state.infoPane.isOpen);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mounted, setMounted] = useState<string | null>(null);
  const more = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void main.getMountState().then((state) => setMounted(state.mountedAgentId));
    return main.subscribe({ "mount-state-changed": (state) => setMounted(state.mountedAgentId) });
  }, []);

  const isMounted = mounted === agent.id;
  useStore(roster); // a group chat's members' names

  return (
    <section className={`thread${companion ? " thread--companion" : ""}`} aria-label={`Conversation with ${agent.name}`}>
      <header className="thread__header">
        <AgentAvatar agent={agent} size={28} busy={isAgentWorking(agent)} />
        <div className="thread__title">
          <h1>{agent.name}</h1>
          <span className={`thread__status${agent.awaitingUserResponse != null ? " thread__status--attention" : ""}`}>{headerStatus(agent)}</span>
        </div>
        <div className="thread__actions">
          {agent.isHiddenFromSidebar === true ? (
            <span className="pill" title="Open it from the sidebar’s Hidden agents group or with Ctrl+K">
              Hidden from the sidebar
            </span>
          ) : null}
          {(agent.asyncTaskCount ?? 0) > 0 ? (
            <button type="button" className="pill pill--button" title="Show async tasks" onClick={() => openAsyncTasks(agent.id)}>
              <Icon name="terminal" size={12} /> {agent.asyncTaskCount} running
            </button>
          ) : null}
          <button type="button" className="icon-button" title="Find in chat (Ctrl+F)" aria-label="Find in chat" onClick={() => openFind(agent.id)}>
            <Icon name="search" />
          </button>
          <button type="button" className="icon-button" title="Show full conversation: thinking and tool calls" aria-label="Show full conversation" onClick={() => openOutline(agent.id)}>
            <Icon name="outline" />
          </button>
          {agent.isGroup ? null : (
            <button
              type="button"
              className={`icon-button${isMounted ? " icon-button--active" : ""}`}
              title={isMounted ? "Unmount from desktop" : "Mount on desktop"}
              aria-label={isMounted ? "Unmount from desktop" : "Mount on desktop"}
              onClick={() => void (isMounted ? main.unmountAgent() : main.mountAgent({ agentId: agent.id }))}
            >
              <Icon name="mount" />
            </button>
          )}
          {companion ? null : (
            <button type="button" className={`icon-button${infoOpen ? " icon-button--active" : ""}`} title="Details (Ctrl+Alt+B)" aria-label="Toggle details" onClick={() => updateLayout((state) => ({ ...state, infoPane: { ...state.infoPane, isOpen: !state.infoPane.isOpen } }))}>
              <Icon name="panelRight" />
            </button>
          )}
          <div className="menu-anchor">
            <button ref={more} type="button" className="icon-button" aria-label="More" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
              <Icon name="more" />
            </button>
            {menuOpen ? (
              <Menu label={`${agent.name} actions`} trigger={more} onClose={() => setMenuOpen(false)}>
                <AgentMenuItems agent={agent} onDone={() => setMenuOpen(false)} />
              </Menu>
            ) : null}
          </div>
        </div>
      </header>
      <FindBar agentId={agent.id} />
      <Transcript agent={agent} />
      <Composer agent={agent} />
    </section>
  );
}
