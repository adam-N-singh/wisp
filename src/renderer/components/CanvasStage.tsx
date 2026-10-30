// A canvas on the page stage: the agent's HTML running in a frame of its own, served by main's
// `wisp-canvas://` and sandboxed to scripts and pointer lock, so it
// has an opaque origin and reaches neither the app nor the network. Each revision and theme loads
// into a new frame, and a write by the agent shows at once. There's no editor: the agent changes a
// canvas; the user renames it, looks back through its revisions, restores one, saves it as an HTML
// file or deletes it. Links the canvas asks to open go to main (`openLinkFromCanvas`) while it has the
// focus, and main opens them only right after a real click or key press.
import { useEffect, useRef, useState } from "react";
import { CANVAS_LINK_MESSAGE, canvasFrameUrl } from "../../shared/canvas";
import type { AgentSummary } from "../../shared/model";
import type { LibraryPage, PageRevisionInfo } from "../../shared/pages";
import { gateway, main } from "../bridge";
import { canvases, closePage, deletePage, loadCanvas, type OpenPage, pageFailure, pageKey, retitleCanvas, restorePageRevision, setStage, stage } from "../store/pages";
import { useStore } from "../store/store";
import { Menu } from "./AgentMenu";
import { Icon } from "./icons";
import { useTheme } from "./RichContent";
import { timestampLabel } from "./time";

const whoMade = (canvas: Pick<LibraryPage, "updatedBy">, agent: AgentSummary) => (canvas.updatedBy === "user" ? "Restored by you" : `Made by ${agent.name}`);

export function CanvasStage({ agent, open, narrow }: { agent: AgentSummary; open: OpenPage; narrow: boolean }) {
  const loaded = useStore(canvases, (state) => state[pageKey(open.agentId, open.pageId)]);
  const viewing = useStore(stage, (state) => state.viewing);
  const theme = useTheme();
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<"history" | "more" | null>(null);
  const [revisions, setRevisions] = useState<PageRevisionInfo[] | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const locator = { storeId: open.agentId, canvasId: open.pageId };

  useEffect(() => {
    if (notice?.tone !== "info") return;
    const timer = setTimeout(() => setNotice(null), 3_000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const failed = (cause: unknown) => setNotice({ tone: "error", text: pageFailure(cause).message });
  const openHistory = async () => {
    if (menu === "history") return setMenu(null);
    try {
      setRevisions(await gateway.listPageRevisions({ locator }));
      setMenu("history");
    } catch (cause) {
      failed(cause);
    }
  };

  const canvas = loaded?.canvas;
  const close = (
    <button type="button" className="icon-button" aria-label="Close the page" title="Close (Esc)" onClick={closePage}>
      <Icon name="close" />
    </button>
  );
  if (loaded == null || loaded.status === "loading" || (canvas == null && loaded.status !== "missing" && loaded.status !== "error")) {
    return (
      <section className="page-stage page-stage--empty" aria-label="Page">
        <header className="page-stage__header page-stage__header--plain">{close}</header>
        <p className="page-stage__placeholder">Opening the canvas…</p>
      </section>
    );
  }
  if (loaded.status === "missing" || canvas == null) {
    return (
      <section className="page-stage page-stage--empty" aria-label="Page">
        <header className="page-stage__header page-stage__header--plain">{close}</header>
        <div className="page-stage__placeholder">
          <p>{loaded.status === "missing" ? "This canvas was deleted." : `Couldn’t open this canvas: ${loaded.error ?? "the box didn’t answer"}`}</p>
          {loaded.status === "error" ? (
            <button type="button" className="button" onClick={() => void loadCanvas(open.agentId, open.pageId)}>
              Try again
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  const canChange = loaded.editRight?.canEdit !== false;
  const older = viewing != null && viewing !== canvas.revision ? viewing : null;
  const viewed = older != null ? revisions?.find((revision) => revision.n === older) : undefined;
  const src = canvasFrameUrl(open.agentId, open.pageId, theme, older ?? canvas.revision);

  const exportFile = async () => {
    setMenu(null);
    try {
      const view = await gateway.canvasPage({ locator, revision: older ?? undefined });
      const path = await main.savePageFile({ title: older != null ? `${canvas.title} (revision ${older})` : canvas.title, source: view.source, kind: "canvas" });
      if (path != null) setNotice({ tone: "info", text: `Saved as ${path}` });
    } catch (cause) {
      failed(cause);
    }
  };
  const copy = async () => {
    setMenu(null);
    try {
      const view = await gateway.canvasPage({ locator, revision: older ?? undefined });
      await navigator.clipboard.writeText(view.source);
      setNotice({ tone: "info", text: "Copied as HTML" });
    } catch {
      setNotice({ tone: "error", text: "Couldn’t copy to the clipboard." });
    }
  };
  const rename = async () => {
    if (renaming == null) return;
    const title = renaming.trim();
    if (title.length === 0 || title === canvas.title) return setRenaming(null);
    setBusy(true);
    const error = await retitleCanvas(open.agentId, open.pageId, title);
    setBusy(false);
    if (error != null) setNotice({ tone: "error", text: error });
    else setRenaming(null);
  };
  const restore = async () => {
    if (older == null) return;
    setBusy(true);
    const error = await restorePageRevision(open.agentId, open.pageId, older, canvas.revision);
    setBusy(false);
    if (error != null) setNotice({ tone: "error", text: error });
    else {
      setStage({ viewing: null });
      setNotice({ tone: "info", text: `Restored revision ${older}` });
    }
  };
  const remove = async () => {
    setBusy(true);
    const error = await deletePage(open.agentId, open.pageId);
    setBusy(false);
    setConfirmingDelete(false);
    if (error != null) setNotice({ tone: "error", text: error });
  };

  const meta = older != null ? `Revision ${older} of ${canvas.revision}` : `Canvas · Revision ${canvas.revision} · ${whoMade(canvas, agent)} · ${timestampLabel(canvas.updatedAt)}`;
  return (
    <section className="page-stage page-stage--canvas" aria-label={`Page: ${canvas.title}`}>
      <header className="page-stage__header">
        <Icon name="code" size={16} />
        <div className="page-stage__title">
          <h2 ref={heading} tabIndex={-1}>
            {canvas.title}
          </h2>
          <span className="page-stage__meta">{meta}</span>
        </div>
        <div className="page-stage__actions">
          {narrow ? (
            <button type="button" className="button button--small button--ghost" onClick={() => setStage({ showChat: true })} title={`The chat with ${agent.name}`}>
              <Icon name="message" size={14} /> Chat
            </button>
          ) : null}
          <div className="menu-anchor">
            <button ref={historyButton} type="button" className="icon-button" aria-label="History" title="Revisions" aria-haspopup="menu" aria-expanded={menu === "history"} onClick={() => void openHistory()}>
              <Icon name="clock" />
            </button>
            {menu === "history" ? (
              <Menu label="Revisions" trigger={historyButton} onClose={() => setMenu(null)} className="page-stage__menu">
                {(revisions ?? []).map((revision) => {
                  const current = revision.n === canvas.revision;
                  return (
                    <button
                      key={revision.n}
                      type="button"
                      role="menuitem"
                      aria-current={(older ?? canvas.revision) === revision.n || undefined}
                      onClick={() => {
                        setMenu(null);
                        setStage({ viewing: current ? null : revision.n });
                      }}
                    >
                      <span className="page-revision__n">Revision {revision.n}</span>
                      <span className="page-revision__meta">
                        {revision.by === "user" ? "You" : agent.name} · {timestampLabel(revision.atMs)}
                        {current ? " · current" : ""}
                      </span>
                    </button>
                  );
                })}
              </Menu>
            ) : null}
          </div>
          <div className="menu-anchor">
            <button ref={moreButton} type="button" className="icon-button" aria-label="Page actions" aria-haspopup="menu" aria-expanded={menu === "more"} onClick={() => setMenu(menu === "more" ? null : "more")}>
              <Icon name="more" />
            </button>
            {menu === "more" ? (
              <Menu label="Page actions" trigger={moreButton} onClose={() => setMenu(null)} className="page-stage__menu">
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canChange}
                  onClick={() => {
                    setMenu(null);
                    setRenaming(canvas.title);
                  }}
                >
                  <Icon name="edit" size={14} /> Rename…
                </button>
                <button type="button" role="menuitem" onClick={() => void exportFile()}>
                  <Icon name="download" size={14} /> Save as HTML…
                </button>
                <button type="button" role="menuitem" onClick={() => void copy()}>
                  <Icon name="copy" size={14} /> Copy as HTML
                </button>
                <div className="menu__separator" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="menu__danger"
                  disabled={!canChange}
                  onClick={() => {
                    setMenu(null);
                    setConfirmingDelete(true);
                  }}
                >
                  <Icon name="trash" size={14} /> Delete page…
                </button>
              </Menu>
            ) : null}
          </div>
          {close}
        </div>
      </header>
      {renaming != null ? (
        <form
          className="page-banner"
          onSubmit={(event) => {
            event.preventDefault();
            void rename();
          }}
        >
          <input
            aria-label="Canvas title"
            className="page-banner__input"
            value={renaming}
            maxLength={200}
            autoFocus
            onChange={(event) => setRenaming(event.target.value)}
            onKeyDown={(event) => {
              // Esc leaves the title as it was, not the stage.
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              setRenaming(null);
            }}
          />
          <button type="submit" className="button button--small button--primary" disabled={busy || renaming.trim().length === 0}>
            Rename
          </button>
          <button type="button" className="button button--small button--ghost" onClick={() => setRenaming(null)}>
            Cancel
          </button>
        </form>
      ) : null}
      {confirmingDelete ? (
        <div className="page-banner page-banner--danger" role="alert">
          <span>Delete “{canvas.title}” and all its revisions? Its card stays in the chat.</span>
          <button type="button" className="button button--small button--danger" disabled={busy} onClick={() => void remove()}>
            Delete
          </button>
          <button type="button" className="button button--small button--ghost" onClick={() => setConfirmingDelete(false)}>
            Cancel
          </button>
        </div>
      ) : null}
      {!canChange ? (
        <div className="page-banner" role="status">
          <span className="working__dots">
            <i />
            <i />
            <i />
          </span>
          <span>{agent.name} is writing this canvas. You can restore or delete it when it’s done.</span>
        </div>
      ) : null}
      {older != null ? (
        <div className="page-banner" role="status">
          <span>
            You’re looking at revision {older}
            {viewed != null ? `, by ${viewed.by === "user" ? "you" : agent.name}, ${timestampLabel(viewed.atMs)}` : ""}.
          </span>
          <button type="button" className="button button--small" disabled={busy || !canChange} onClick={() => void restore()}>
            Restore this revision
          </button>
          <button type="button" className="button button--small button--ghost" onClick={() => setStage({ viewing: null })}>
            Back to the latest
          </button>
        </div>
      ) : null}
      {notice != null ? (
        <div className={`page-banner${notice.tone === "error" ? " page-banner--error" : " page-banner--info"}`} role={notice.tone === "error" ? "alert" : "status"}>
          <span>{notice.text}</span>
          {notice.tone === "error" ? (
            <button type="button" className="icon-button icon-button--small" aria-label="Dismiss" onClick={() => setNotice(null)}>
              <Icon name="close" size={12} />
            </button>
          ) : null}
        </div>
      ) : null}
      <CanvasFrame
        key={src}
        src={src}
        title={canvas.title}
        onLinkRefused={() => setNotice({ tone: "error", text: "The canvas asked to open a link, which opens only from a click on it, and only for web, mail and phone links." })}
      />
    </section>
  );
}

/**
 * The canvas's frame. A link it asks for goes to main, which decides, but only while the frame has
 * the focus: a click elsewhere in the window doesn't let it open one.
 */
function CanvasFrame({ src, title, onLinkRefused }: { src: string; title: string; onLinkRefused(): void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const refused = useRef(onLinkRefused);
  refused.current = onLinkRefused;
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only this frame's; its origin is opaque, so the window it posts from is what identifies it.
      if (event.source == null || event.source !== frame.current?.contentWindow) return;
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (data?.type !== CANVAS_LINK_MESSAGE || typeof data.url !== "string") return;
      if (document.activeElement !== frame.current) return refused.current();
      void main.openLinkFromCanvas({ url: data.url.slice(0, 8192) }).then(
        (opened) => !opened && refused.current(),
        () => refused.current(),
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <iframe
      ref={frame}
      className={`page-stage__canvas${loaded ? "" : " page-stage__canvas--loading"}`}
      title={title}
      src={src}
      sandbox="allow-scripts allow-pointer-lock"
      referrerPolicy="no-referrer"
      onLoad={() => setLoaded(true)}
    />
  );
}
