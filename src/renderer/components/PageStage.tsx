// The page stage: a page the agent wrote, open on the main stage with the agent's chat beside it
// as a companion column (at least 424 px).
// Where there's no room for both, the page takes the stage and a Chat button swaps to the chat. Esc
// leaves the editor, then an older revision, then closes the stage.
//
// A document renders through the chat's own Markdown, so it reads as the agent's replies do. Edit
// shows its Markdown source beside a live preview (one or the other when the stage is narrow).
// Saves name the revision the edits were made on (store/pages.ts).
import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentSummary } from "../../shared/model";
import { MAX_PAGE_SOURCE, type PageDocument, type PageRevisionInfo } from "../../shared/pages";
import { gateway, main } from "../bridge";
import {
  CHAT_MIN_WIDTH,
  closePage,
  deletePage,
  discardDraft,
  documents,
  drafts,
  keepMine,
  loadDocument,
  type OpenPage,
  pageKey,
  restorePageRevision,
  saveDraft,
  setChatWidth,
  setDraft,
  setStage,
  stage,
  stageLayout,
} from "../store/pages";
import { useStore } from "../store/store";
import { Menu } from "./AgentMenu";
import { Icon } from "./icons";
import { Markdown } from "./Markdown";
import { ThreadView } from "./ThreadView";
import { timestampLabel } from "./time";

/** The companion chat beside the page; below twice the chat's least width the page takes the stage. */
export function PageWorkspace({ agent, open }: { agent: AgentSummary; open: OpenPage }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const chatWidth = useStore(stageLayout, (state) => state.chatWidth);
  const showChat = useStore(stage, (state) => state.showChat);
  useLayoutEffect(() => {
    const element = container.current;
    if (element == null) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const narrow = width > 0 && width < CHAT_MIN_WIDTH * 2;
  // The chat keeps its least width and leaves the page as much.
  const chat = Math.max(CHAT_MIN_WIDTH, Math.min(chatWidth, width - CHAT_MIN_WIDTH));

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = chat;
    const move = (moved: PointerEvent) => setChatWidth(Math.max(CHAT_MIN_WIDTH, Math.min(startWidth + moved.clientX - startX, width - CHAT_MIN_WIDTH)));
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const nudge = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setChatWidth(Math.max(CHAT_MIN_WIDTH, Math.min(chat + (event.key === "ArrowLeft" ? -24 : 24), width - CHAT_MIN_WIDTH)));
  };

  // Both stay mounted on a narrow stage, so the message being written and the page's scroll survive the swap.
  return (
    <div className={`page-workspace${narrow ? " page-workspace--narrow" : ""}`} ref={container}>
      <div className={`page-workspace__chat${narrow && !showChat ? " page-workspace__pane--away" : ""}`} style={narrow ? undefined : { width: chat }}>
        {narrow ? (
          <button type="button" className="page-workspace__back" onClick={() => setStage({ showChat: false })}>
            <Icon name="chevronLeft" size={14} /> Back to the page
          </button>
        ) : null}
        <ThreadView agent={agent} companion />
      </div>
      {!narrow && width > 0 ? (
        <div
          className="page-workspace__handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the chat"
          aria-valuemin={CHAT_MIN_WIDTH}
          aria-valuemax={width - CHAT_MIN_WIDTH}
          aria-valuenow={chat}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={nudge}
        />
      ) : null}
      <div className={`page-workspace__page${narrow && showChat ? " page-workspace__pane--away" : ""}`}>
        <PageStage key={pageKey(open.agentId, open.documentId)} agent={agent} open={open} narrow={narrow} />
      </div>
    </div>
  );
}

const whoWrote = (doc: Pick<PageDocument, "updatedBy">, agent: AgentSummary) => (doc.updatedBy === "user" ? "Edited by you" : `Written by ${agent.name}`);

function PageStage({ agent, open, narrow }: { agent: AgentSummary; open: OpenPage; narrow: boolean }) {
  const key = pageKey(open.agentId, open.documentId);
  const loaded = useStore(documents, (state) => state[key]);
  const draft = useStore(drafts, (state) => state[key]);
  const editing = useStore(stage, (state) => state.editing);
  const viewing = useStore(stage, (state) => state.viewing);
  const [older, setOlder] = useState<PageDocument | null>(null);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<"history" | "more" | null>(null);
  const [revisions, setRevisions] = useState<PageRevisionInfo[] | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const historyButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (viewing == null) return setOlder(null);
    let cancelled = false;
    void gateway.readPage({ locator: { storeId: open.agentId, documentId: open.documentId }, revision: viewing }).then(
      (doc) => !cancelled && setOlder(doc),
      () => !cancelled && setStage({ viewing: null }),
    );
    return () => {
      cancelled = true;
    };
  }, [viewing, open.agentId, open.documentId]);
  useEffect(() => {
    if (notice?.tone !== "info") return;
    const timer = setTimeout(() => setNotice(null), 3_000);
    return () => clearTimeout(timer);
  }, [notice]);
  // The menu opens once its rows are there, so it takes the focus (and Esc) from the start.
  const openHistory = async () => {
    if (menu === "history") return setMenu(null);
    try {
      setRevisions(await gateway.listPageRevisions({ locator: { storeId: open.agentId, documentId: open.documentId } }));
      setMenu("history");
    } catch (cause) {
      setNotice({ tone: "error", text: cause instanceof Error ? cause.message.replace(/^[\w/-]+: /, "") : String(cause) });
    }
  };
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);

  const doc = loaded?.doc;
  const close = (
    <button type="button" className="icon-button" aria-label="Close the page" title="Close (Esc)" onClick={closePage}>
      <Icon name="close" />
    </button>
  );
  if (loaded == null || loaded.status === "loading" || (doc == null && loaded.status !== "missing" && loaded.status !== "error")) {
    return (
      <section className="page-stage page-stage--empty" aria-label="Page">
        <header className="page-stage__header page-stage__header--plain">{close}</header>
        <p className="page-stage__placeholder">Opening the page…</p>
      </section>
    );
  }
  if (loaded.status === "missing" || doc == null) {
    return (
      <section className="page-stage page-stage--empty" aria-label="Page">
        <header className="page-stage__header page-stage__header--plain">{close}</header>
        <div className="page-stage__placeholder">
          <p>{loaded.status === "missing" ? "This page was deleted." : `Couldn’t open this page: ${loaded.error ?? "the box didn’t answer"}`}</p>
          {loaded.status === "error" ? (
            <button type="button" className="button" onClick={() => void loadDocument(open.agentId, open.documentId)}>
              Try again
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  const canEdit = loaded.editRight?.canEdit !== false;
  const conflict = draft != null && draft.baseRevision !== doc.revision;
  const text = draft?.source ?? doc.source;
  const shown = older?.source ?? text;
  const tooLong = text.length > MAX_PAGE_SOURCE;
  const viewed = older != null ? revisions?.find((revision) => revision.n === older.sourceRevision) : undefined;
  const canSave = draft != null && canEdit && !conflict && !busy && !tooLong && text.trim().length > 0;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    const error = await saveDraft(open.agentId, open.documentId);
    setBusy(false);
    setNotice(error != null ? { tone: "error", text: error } : { tone: "info", text: "Saved" });
  };
  const exportFile = async () => {
    setMenu(null);
    try {
      const path = await main.savePageFile({ title: older != null ? `${doc.title} (revision ${older.sourceRevision})` : doc.title, source: shown });
      if (path != null) setNotice({ tone: "info", text: `Saved as ${path}` });
    } catch (cause) {
      setNotice({ tone: "error", text: cause instanceof Error ? cause.message : String(cause) });
    }
  };
  const copy = () => {
    setMenu(null);
    void navigator.clipboard.writeText(shown).then(
      () => setNotice({ tone: "info", text: "Copied as Markdown" }),
      () => setNotice({ tone: "error", text: "Couldn’t copy to the clipboard." }),
    );
  };
  const restore = async () => {
    if (older == null) return;
    setBusy(true);
    const error = await restorePageRevision(open.agentId, open.documentId, older.sourceRevision, doc.revision);
    setBusy(false);
    if (error != null) setNotice({ tone: "error", text: error });
    else {
      setStage({ viewing: null });
      setNotice({ tone: "info", text: `Restored revision ${older.sourceRevision}` });
    }
  };
  const remove = async () => {
    setBusy(true);
    const error = await deletePage(open.agentId, open.documentId);
    setBusy(false);
    setConfirmingDelete(false);
    if (error != null) setNotice({ tone: "error", text: error });
  };

  const meta = older != null ? `Revision ${older.sourceRevision} of ${doc.revision}` : `Revision ${doc.revision} · ${whoWrote(doc, agent)} · ${timestampLabel(doc.updatedAt)}${draft != null ? " · Unsaved changes" : ""}`;
  return (
    <section className="page-stage" aria-label={`Page: ${doc.title}`}>
      <header className="page-stage__header">
        <Icon name="file" size={16} />
        <div className="page-stage__title">
          <h2 ref={heading} tabIndex={-1}>
            {doc.title}
          </h2>
          <span className="page-stage__meta">{meta}</span>
        </div>
        <div className="page-stage__actions">
          {narrow ? (
            <button type="button" className="button button--small button--ghost" onClick={() => setStage({ showChat: true })} title={`The chat with ${agent.name}`}>
              <Icon name="message" size={14} /> Chat
            </button>
          ) : null}
          {older == null ? (
            editing ? (
              <button type="button" className="button button--small" onClick={() => setStage({ editing: false })} title="Back to the page (Esc); your changes stay until you save or discard them">
                Done
              </button>
            ) : (
              <button type="button" className="button button--small" disabled={!canEdit} onClick={() => setStage({ editing: true })} title={canEdit ? "Edit the Markdown" : `${agent.name} is writing this page`}>
                <Icon name="edit" size={14} /> Edit
              </button>
            )
          ) : null}
          {draft != null && older == null ? (
            <button type="button" className="button button--small button--primary" disabled={!canSave} onClick={() => void save()} title={conflict ? "Reload the page or keep yours first" : "Save (Ctrl+S)"}>
              {busy ? "Saving…" : "Save"}
            </button>
          ) : null}
          <div className="menu-anchor">
            <button ref={historyButton} type="button" className="icon-button" aria-label="History" title="Revisions" aria-haspopup="menu" aria-expanded={menu === "history"} onClick={() => void openHistory()}>
              <Icon name="clock" />
            </button>
            {menu === "history" ? (
              <Menu label="Revisions" trigger={historyButton} onClose={() => setMenu(null)} className="page-stage__menu">
                {(revisions ?? []).map((revision) => {
                  const current = revision.n === doc.revision;
                  return (
                    <button
                      key={revision.n}
                      type="button"
                      role="menuitem"
                      aria-current={(older?.sourceRevision ?? doc.revision) === revision.n || undefined}
                      onClick={() => {
                        setMenu(null);
                        setStage({ viewing: current ? null : revision.n, editing: false });
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
                <button type="button" role="menuitem" onClick={() => void exportFile()}>
                  <Icon name="download" size={14} /> Save as Markdown…
                </button>
                <button type="button" role="menuitem" onClick={copy}>
                  <Icon name="copy" size={14} /> Copy as Markdown
                </button>
                {draft != null ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(null);
                      discardDraft(open.agentId, open.documentId);
                    }}
                  >
                    <Icon name="refresh" size={14} /> Discard my changes
                  </button>
                ) : null}
                <div className="menu__separator" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="menu__danger"
                  disabled={!canEdit}
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
      {confirmingDelete ? (
        <div className="page-banner page-banner--danger" role="alert">
          <span>Delete “{doc.title}” and all its revisions? Its card stays in the chat.</span>
          <button type="button" className="button button--small button--danger" disabled={busy} onClick={() => void remove()}>
            Delete
          </button>
          <button type="button" className="button button--small button--ghost" onClick={() => setConfirmingDelete(false)}>
            Cancel
          </button>
        </div>
      ) : null}
      {conflict && older == null ? (
        <div className="page-banner page-banner--warn" role="alert">
          <span>Updated by {doc.updatedBy === "agent" ? agent.name : "you, in another window"} while you were editing.</span>
          <button type="button" className="button button--small" onClick={() => discardDraft(open.agentId, open.documentId)}>
            Reload
          </button>
          <button type="button" className="button button--small button--ghost" onClick={() => keepMine(open.agentId, open.documentId)} title="Keep your text; saving it replaces theirs">
            Keep mine
          </button>
        </div>
      ) : null}
      {!canEdit ? (
        <div className="page-banner" role="status">
          <span className="working__dots">
            <i />
            <i />
            <i />
          </span>
          <span>{agent.name} is writing this page. You can edit it when it’s done.</span>
        </div>
      ) : null}
      {older != null ? (
        <div className="page-banner" role="status">
          <span>
            You’re looking at revision {older.sourceRevision}
            {viewed != null ? `, by ${viewed.by === "user" ? "you" : agent.name}, ${timestampLabel(viewed.atMs)}` : ""}.
          </span>
          <button type="button" className="button button--small" disabled={busy || !canEdit} onClick={() => void restore()}>
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
      {editing && older == null ? (
        <PageEditor value={text} readOnly={!canEdit} tooLong={tooLong} onChange={(source) => setDraft(open.agentId, open.documentId, source)} onSave={() => void save()} />
      ) : (
        <div className="page-stage__scroll">
          <article className="page-stage__doc">
            <Markdown text={shown} />
          </article>
        </div>
      )}
    </section>
  );
}

/** The Markdown source beside its live preview; one at a time, with tabs, when there isn't room for both. */
function PageEditor({ value, readOnly, tooLong, onChange, onSave }: { value: string; readOnly: boolean; tooLong: boolean; onChange(source: string): void; onSave(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(true);
  const [pane, setPane] = useState<"source" | "preview">("source");
  // Typing stays quick in a long document: the preview catches up.
  const preview = useDeferredValue(value);
  useLayoutEffect(() => {
    const element = box.current;
    if (element == null) return;
    const measure = () => setSplit(element.clientWidth >= 680);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className={`page-editor${split ? " page-editor--split" : ""}`} ref={box}>
      {!split ? (
        <div className="page-editor__tabs" role="tablist" aria-label="Editor">
          {(["source", "preview"] as const).map((name) => (
            <button key={name} type="button" role="tab" aria-selected={pane === name} className={`tab${pane === name ? " tab--active" : ""}`} onClick={() => setPane(name)}>
              {name === "source" ? "Markdown" : "Preview"}
            </button>
          ))}
        </div>
      ) : null}
      {split || pane === "source" ? (
        <div className="page-editor__source">
          <textarea
            aria-label="Markdown"
            value={value}
            readOnly={readOnly}
            spellCheck
            autoFocus
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
                event.preventDefault();
                onSave();
              }
            }}
          />
          {tooLong ? (
            <p className="page-editor__limit" role="alert">
              {value.length.toLocaleString()} characters: a page holds at most {MAX_PAGE_SOURCE.toLocaleString()}.
            </p>
          ) : null}
        </div>
      ) : null}
      {split || pane === "preview" ? (
        <div className="page-editor__preview" aria-label="Preview">
          <article className="page-stage__doc">
            <Markdown text={preview} />
          </article>
        </div>
      ) : null}
    </div>
  );
}
