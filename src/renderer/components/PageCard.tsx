// Where pages show outside the stage: a document's or canvas's card in the chat (opening it on the page stage,
// updated in place as it changes), the "Pages you changed" line on the message that told the agent
// about the user's edits, and the agent's Library in the info pane's Overview.
import { useEffect } from "react";
import type { AgentSummary, PageMessage } from "../../shared/model";
import { type PageEditNote, pageId } from "../../shared/pages";
import { drafts, library, loadLibrary, openPage, pageKey, stage } from "../store/pages";
import { useStore } from "../store/store";
import { Icon } from "./icons";
import { timestampLabel } from "./time";

/** `agent` wrote the page; in a group chat that's the member, and the page opens beside the room's chat. */
export function PageCard({ agent, message }: { agent: AgentSummary; message: PageMessage }) {
  const open = useStore(stage, (state) => state.open);
  const id = pageId(message.page);
  // The page is in its writer's store, which is what it opens from.
  const storeId = message.page.storeId;
  const isOpen = open?.agentId === storeId && open.pageId === id;
  const unsaved = useStore(drafts, (state) => state[pageKey(storeId, id)] != null);
  const canvas = message.page.kind === "canvas";
  const kind = canvas ? "Canvas" : "Document";
  const icon = canvas ? "code" : "file";
  const who = message.updatedBy === "user" ? "edited by you" : message.revision === 1 ? `by ${agent.name}` : `edited by ${agent.name}`;
  if (message.deleted === true) {
    return (
      <div className="page-card page-card--deleted">
        <span className="page-card__icon">
          <Icon name={icon} size={18} />
        </span>
        <span className="page-card__body">
          <span className="page-card__title">{message.title}</span>
          <span className="page-card__meta">{kind} · deleted</span>
        </span>
      </div>
    );
  }
  return (
    <button type="button" className={`page-card${isOpen ? " page-card--open" : ""}`} aria-label={`Open ${message.title}`} aria-current={isOpen || undefined} onClick={() => openPage(storeId, id)}>
      <span className="page-card__icon">
        <Icon name={icon} size={18} />
      </span>
      <span className="page-card__body">
        <span className="page-card__title">{message.title}</span>
        {message.excerpt.length > 0 ? <span className="page-card__excerpt">{message.excerpt}</span> : null}
        <span className="page-card__meta">
          {kind} · {message.revision === 1 ? "" : `revision ${message.revision}, `}
          {who} · {timestampLabel(message.updatedAt)}
          {unsaved ? <span className="page-card__unsaved"> · your changes aren’t saved</span> : null}
        </span>
      </span>
      <span className="page-card__open">{isOpen ? "Showing" : <Icon name="expand" size={14} />}</span>
    </button>
  );
}

/** On a user message: the pages it told the agent the user had changed. */
export function PageEditsLine({ agentId, edits }: { agentId: string; edits: PageEditNote[] }) {
  return (
    <div className="page-edits" data-find-skip>
      <Icon name="edit" size={12} />
      <span>{edits.length === 1 ? "Page you changed:" : "Pages you changed:"}</span>
      {edits.map((edit, index) => (
        <span key={edit.documentId}>
          <button type="button" className="link-button" title={`Open ${edit.title} (revision ${edit.revision} when you sent this)`} onClick={() => openPage(agentId, edit.documentId)}>
            {edit.title}
          </button>
          {index < edits.length - 1 ? "," : ""}
        </span>
      ))}
    </div>
  );
}

/** Overview's Library: the documents and canvases the agent wrote, newest first. */
export function LibrarySection({ agent }: { agent: AgentSummary }) {
  const pages = useStore(library, (state) => state[agent.id]);
  const unsaved = useStore(drafts);
  useEffect(() => {
    void loadLibrary(agent.id);
  }, [agent.id]);
  return (
    <section className="library">
      <h3>Library</h3>
      {pages == null || pages.length === 0 ? (
        <p className="muted">Documents and canvases {agent.name} writes show up here. They’re yours alone; save one as a file to share it.</p>
      ) : (
        <ul className="library__list">
          {pages.map((page) => {
            const id = pageId(page.page);
            const changed = unsaved[pageKey(agent.id, id)] != null;
            return (
              <li key={id}>
                <button type="button" className="library__item" onClick={() => openPage(agent.id, id)} title={page.page.kind === "canvas" ? "Canvas" : "Document"}>
                  <Icon name={page.page.kind === "canvas" ? "code" : "file"} size={14} />
                  <span className="library__title">{page.title}</span>
                  <span className={`library__meta${changed ? " page-card__unsaved" : ""}`}>{changed ? "Unsaved changes" : timestampLabel(page.updatedAt)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
