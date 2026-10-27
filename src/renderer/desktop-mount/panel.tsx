// Desktop-mount panel: the mounted agent's avatar floating on the desktop.
// Drag it anywhere; click it to open a mini composer.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { EdgeClient } from "../../shared/rpc/edge";
import type { desktopMountEdge, MountView } from "../../shared/edges";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/icons";
import "../styles/tokens.css";
import "./panel.css";

declare global {
  interface Window {
    desktopMount: EdgeClient<typeof desktopMountEdge>;
  }
}

const mount = window.desktopMount;
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => (document.documentElement.dataset.theme = dark.matches ? "dark" : "light");
applyTheme();
dark.addEventListener("change", applyTheme);

function useDrag(onClick: () => void) {
  const start = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  return {
    onPointerDown: (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      start.current = { x: event.screenX, y: event.screenY, moved: false };
    },
    onPointerMove: (event: React.PointerEvent) => {
      const origin = start.current;
      if (origin == null) return;
      const dx = event.screenX - origin.x;
      const dy = event.screenY - origin.y;
      if (!origin.moved && Math.hypot(dx, dy) < 4) return;
      origin.moved = true;
      origin.x = event.screenX;
      origin.y = event.screenY;
      void mount.dragPanel({ dx, dy });
    },
    onPointerUp: () => {
      const origin = start.current;
      start.current = null;
      if (origin == null) return;
      if (origin.moved) void mount.dropPanel();
      else onClick();
    },
  };
}

function Panel() {
  const [view, setView] = useState<MountView | null>(null);
  const [text, setText] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void mount.read().then(setView);
    return mount.subscribe({ changed: setView });
  }, []);

  useEffect(() => {
    if (view?.expanded) input.current?.focus();
  }, [view?.expanded]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void mount.changeExpanded({ expanded: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const drag = useDrag(() => void mount.changeExpanded({ expanded: !(view?.expanded ?? false) }));
  if (view?.agent == null) return null;
  const agent = view.agent;

  const send = () => {
    if (text.trim().length === 0 && view.staged.length === 0) return;
    void mount.sendFromPanel({ prompt: text.trim() });
    setText("");
  };

  if (!view.expanded) {
    return (
      <div className="panel panel--collapsed">
        <button type="button" className={`mark${view.isRunning ? " mark--working" : ""}`} title={`${agent.name}${view.preview ? `\n${view.preview}` : ""}`} aria-label={`Open ${agent.name}`} {...drag}>
          <Avatar shape={agent.avatarShape} color={agent.avatarColor} size={44} busy={view.isRunning} />
          {view.needsAttention ? <span className="mark__dot" /> : null}
        </button>
      </div>
    );
  }

  return (
    <div className="panel panel--expanded">
      <div className="panel__head" {...drag}>
        <Avatar shape={agent.avatarShape} color={agent.avatarColor} size={22} busy={view.isRunning} />
        <span className="panel__name">{agent.name}</span>
        <button type="button" className="panel__icon" aria-label="Switch agent" onPointerDown={(event) => event.stopPropagation()} onClick={() => setMenuOpen((open) => !open)}>
          <Icon name="chevronDown" size={14} />
        </button>
        <span className="panel__spacer" />
        <button type="button" className="panel__icon" aria-label="Open in app" title="Open in app" onPointerDown={(event) => event.stopPropagation()} onClick={() => void mount.openMainWindow()}>
          <Icon name="panelRight" size={14} />
        </button>
        <button type="button" className="panel__icon" aria-label="Collapse" title="Collapse (Esc)" onPointerDown={(event) => event.stopPropagation()} onClick={() => void mount.changeExpanded({ expanded: false })}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {menuOpen ? (
        <div className="panel__menu" role="menu">
          {view.agents.map((option) => (
            <button key={option.id} type="button" role="menuitemradio" aria-checked={option.id === agent.id} onClick={() => (setMenuOpen(false), void mount.openAgentInPanel({ agentId: option.id }))}>
              <Avatar shape={option.avatarShape} color={option.avatarColor} size={18} />
              <span>{option.name}</span>
              {option.id === agent.id ? <Icon name="check" size={12} /> : null}
            </button>
          ))}
          <button type="button" className="panel__menu-unmount" onClick={() => void mount.detachPanel()}>
            <Icon name="mount" size={14} />
            <span>Unmount from desktop</span>
          </button>
        </div>
      ) : (
        <>
          {view.preview ? <p className="panel__preview">{view.preview}</p> : null}
          {view.staged.length > 0 ? (
            <div className="panel__attachments">
              {view.staged.map((attachment) => (
                <span key={attachment.path} className="panel__chip">
                  <img src={`wisp-media://file/${encodeURIComponent(attachment.path)}`} alt="" />
                  <button type="button" aria-label="Remove capture" onClick={() => void mount.dropStagedUpload({ path: attachment.path })}>
                    <Icon name="close" size={10} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <form
            className="panel__composer"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <textarea
              ref={input}
              rows={2}
              value={text}
              placeholder={`Message ${agent.name}`}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <button type="button" className="panel__icon" aria-label="Capture a window or region" aria-keyshortcuts="Alt+Shift+Space" title="Capture a region (Alt+Shift+Space)" onClick={() => void mount.beginCapture()}>
              <Icon name="monitor" size={16} />
            </button>
            <button type="submit" className="panel__send" aria-label="Send" disabled={text.trim().length === 0 && view.staged.length === 0}>
              <Icon name="send" size={14} />
            </button>
          </form>
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Panel />);
