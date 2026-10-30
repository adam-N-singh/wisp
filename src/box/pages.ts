// Pages an agent writes: documents (create_document, edit_document), which the user also edits on the
// page stage (gateway `writePage`), and canvases (write_canvas), interactive HTML only the agent
// changes. Each change is a revision: who made it, when, and its text by content hash (store.ts). A
// change names the revision it was made on when it can, and a stale one is refused, so neither side
// writes over what it hasn't seen: the agent reads the page again, the user chooses between
// reloading and keeping theirs. A page keeps its last MAX_PAGE_REVISIONS revisions; restoring one
// adds it again as the newest.
//
// The model learns what the user changed from the next message they send (pageEditsSince), as it
// learns a reply's quote: the conversation it reads stays append-only.
import { randomBytes } from "node:crypto";
import type { PageMessage } from "../shared/model";
import {
  applyDocumentEdits,
  canvasExcerpt,
  canvasTitle,
  cleanPageTitle,
  documentExcerpt,
  documentTitle,
  type LibraryPage,
  MAX_PAGE_REVISIONS,
  MAX_PAGE_SOURCE,
  type PageAuthor,
  type PageDocument,
  type PageEditNote,
  type PageKind,
  pageRefFor,
  type PageRevisionInfo,
} from "../shared/pages";
import type { BoxStore, PageRecord } from "./store";

/** A refused page change; the gateway answers 404 for "missing", 409 for "stale" and "writing", and 400 otherwise. */
export class PageError extends Error {
  constructor(
    readonly code: "missing" | "stale" | "writing" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "PageError";
  }
}

export const newDocumentId = () => `doc-${randomBytes(6).toString("hex")}`;
export const newCanvasId = () => `canvas-${randomBytes(6).toString("hex")}`;

const newest = (record: PageRecord) => record.revisions[record.revisions.length - 1];

export function libraryPage(agentId: string, record: PageRecord): LibraryPage {
  const last = newest(record);
  return { page: pageRefFor(agentId, record.id), title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt, revision: last.n, updatedBy: last.by };
}

/** The page's card in the conversation, as it is now. */
export function pageCard(agentId: string, record: PageRecord, source: string): PageMessage {
  const last = newest(record);
  const excerpt = record.kind === "canvas" ? canvasExcerpt(source) : documentExcerpt(source);
  return { type: "page", page: pageRefFor(agentId, record.id), title: record.title, excerpt, revision: last.n, updatedBy: last.by, updatedAt: record.updatedAt };
}

/** The page, of the kind asked for when one is. */
export function requirePage(store: BoxStore, agentId: string, id: string, kind?: PageKind): PageRecord {
  const record = store.getPage(agentId, id);
  if (record == null) throw new PageError("missing", "That page isn’t there any more.");
  if (kind != null && record.kind !== kind) {
    throw new PageError("invalid", record.kind === "canvas" ? `“${record.title}” is a canvas: read it with read_canvas and change it with write_canvas.` : `“${record.title}” is a document: read it with read_document and change it with edit_document.`);
  }
  return record;
}

/** Text as pages keep it: Unix line ends, within the size limit, not empty. */
function checkedSource(source: string, kind: PageKind = "document"): string {
  const text = source.replace(/\r\n?/g, "\n");
  const name = kind === "canvas" ? "canvas" : "document";
  if (text.trim().length === 0) throw new PageError("invalid", `The ${name} is empty.`);
  if (text.length > MAX_PAGE_SOURCE) {
    throw new PageError(
      "invalid",
      kind === "canvas"
        ? `The canvas is ${text.length} characters; keep it under ${MAX_PAGE_SOURCE}. Compute in its script what it would write out, or leave something out.`
        : `The document is ${text.length} characters; keep it under ${MAX_PAGE_SOURCE}. Split it into several documents.`,
    );
  }
  return text;
}

/** Refuses a change made on a revision that isn't the newest. */
function checkBase(record: PageRecord, baseRevision: number | undefined, by: PageAuthor): void {
  const last = newest(record);
  if (baseRevision == null || baseRevision === last.n) return;
  const who = last.by === "user" ? "the user changed it" : "it changed";
  throw new PageError(
    "stale",
    by === "agent"
      ? `“${record.title}” is at revision ${last.n} now, not ${baseRevision}: ${who} since. Read it again with ${record.kind === "canvas" ? "read_canvas" : "read_document"} and make your change on that.`
      : `“${record.title}” changed since you opened it (revision ${last.n} now, not ${baseRevision}).`,
  );
}

/**
 * Adds a revision with this text, unless the newest already says it. A document's title follows its
 * first `# heading`; a canvas's changes only when one is given (which, alone, adds no revision).
 */
function addRevision(store: BoxStore, agentId: string, record: PageRecord, source: string, by: PageAuthor, now: number, title?: string): { record: PageRecord; changed: boolean } {
  const sha256 = store.savePageSource(source, record.kind);
  const last = newest(record);
  const name = record.kind === "canvas" ? (title ?? record.title) : (documentTitle(source) ?? record.title);
  if (last.sha256 === sha256) return name === record.title ? { record, changed: false } : { record: store.putPage(agentId, { ...record, title: name, updatedAt: now }), changed: true };
  const revisions = [...record.revisions, { n: last.n + 1, sha256, by, atMs: now }].slice(-MAX_PAGE_REVISIONS);
  return { record: store.putPage(agentId, { ...record, title: name, updatedAt: now, revisions }), changed: true };
}

export function createDocument(store: BoxStore, agentId: string, title: string, markdown: string, now = Date.now()): { record: PageRecord; source: string } {
  const source = checkedSource(markdown);
  const name = documentTitle(source) ?? cleanPageTitle(title);
  if (name.length === 0) throw new PageError("invalid", "Give the document a title.");
  const sha256 = store.savePageSource(source);
  const record = store.putPage(agentId, { id: newDocumentId(), kind: "document", title: name, createdAt: now, updatedAt: now, revisions: [{ n: 1, sha256, by: "agent", atMs: now }], cardId: null });
  return { record, source };
}

/** A revision's text: the newest, or the one asked for while the page still keeps it. */
export function storedPage(store: BoxStore, agentId: string, id: string, revision?: number, kind?: PageKind): { record: PageRecord; source: string; revision: number } {
  const record = requirePage(store, agentId, id, kind);
  const kept = revision == null ? newest(record) : record.revisions.find((candidate) => candidate.n === revision);
  if (kept == null) throw new PageError("missing", `“${record.title}” no longer keeps revision ${revision}.`);
  const source = store.pageSource(kept.sha256, record.kind);
  if (source == null) throw new PageError("missing", `Revision ${kept.n} of “${record.title}” is missing from the box.`);
  return { record, source, revision: kept.n };
}

/** A revision's Markdown: the newest, or the one asked for while the page still keeps it. */
export function readDocument(store: BoxStore, agentId: string, documentId: string, revision?: number): { record: PageRecord; source: string; revision: number } {
  return storedPage(store, agentId, documentId, revision, "document");
}

/** A revision's HTML: the newest, or the one asked for while the canvas still keeps it. */
export function readCanvas(store: BoxStore, agentId: string, canvasId: string, revision?: number): { record: PageRecord; source: string; revision: number } {
  return storedPage(store, agentId, canvasId, revision, "canvas");
}

/** `readPage`'s (and `canvasPage`'s) answer: the page, and the text of `sourceRevision` (by default its newest). */
export function documentView(agentId: string, record: PageRecord, source: string, sourceRevision = newest(record).n): PageDocument {
  return { ...libraryPage(agentId, record), source, sourceRevision };
}

/**
 * edit_document: quoted edits, on the newest revision or the one the agent names, or a whole new
 * text, which must name the revision it replaces: written blind, it would drop what the user changed.
 */
export function editDocument(
  store: BoxStore,
  agentId: string,
  documentId: string,
  change: { edits?: ReadonlyArray<{ find: string; replace: string }>; markdown?: string; baseRevision?: number },
  now = Date.now(),
): { record: PageRecord; source: string; changed: boolean } {
  const current = readDocument(store, agentId, documentId);
  checkBase(current.record, change.baseRevision, "agent");
  if ((change.edits != null) === (change.markdown != null)) throw new PageError("invalid", "Send either edits or markdown (the whole new text), not both.");
  if (change.markdown != null && change.baseRevision == null) {
    throw new PageError("invalid", `Replacing the whole text needs base_revision, the revision you last read or wrote, so nothing the user changed since is lost. “${current.record.title}” is at revision ${current.revision}: read it with read_document, then send its number.`);
  }
  let text: string;
  if (change.markdown != null) text = change.markdown;
  else {
    if (change.edits!.length === 0) throw new PageError("invalid", "There are no edits.");
    const edited = applyDocumentEdits(current.source, change.edits!);
    if ("error" in edited) throw new PageError("invalid", edited.error);
    text = edited.source;
  }
  const source = checkedSource(text);
  return { ...addRevision(store, agentId, current.record, source, "agent", now), source };
}

/**
 * write_canvas: a new canvas, or (with its id) the whole new HTML of one the agent wrote, as its
 * newest revision. The title is the one given, else the HTML's <title> (or first <h1>) for a new
 * canvas; an existing one keeps its own unless a new one is given. A write replaces the whole canvas,
 * so one on a canvas whose newest revision is the user's (a restore) must name that revision
 * (`baseRevision`): written blind, it would undo the restore. A stale base is refused, as for documents.
 */
export function writeCanvas(
  store: BoxStore,
  agentId: string,
  change: { contents: string; canvasId?: string; title?: string; baseRevision?: number },
  now = Date.now(),
): { record: PageRecord; source: string; created: boolean; changed: boolean } {
  const title = cleanPageTitle(change.title ?? "");
  if (change.canvasId != null) {
    const record = requirePage(store, agentId, change.canvasId, "canvas");
    const last = newest(record);
    if (change.baseRevision == null && last.by === "user") {
      throw new PageError("stale", `“${record.title}” is at revision ${last.n} now, which the user restored since you wrote it. Read it with read_canvas and write your change on that, with base_revision ${last.n}, so their restore isn't undone.`);
    }
    checkBase(record, change.baseRevision, "agent");
    const source = checkedSource(change.contents, "canvas");
    return { ...addRevision(store, agentId, record, source, "agent", now, title.length > 0 ? title : undefined), source, created: false };
  }
  const source = checkedSource(change.contents, "canvas");
  const name = title.length > 0 ? title : (canvasTitle(source) ?? "Untitled canvas");
  const sha256 = store.savePageSource(source, "canvas");
  const record = store.putPage(agentId, { id: newCanvasId(), kind: "canvas", title: name, createdAt: now, updatedAt: now, revisions: [{ n: 1, sha256, by: "agent", atMs: now }], cardId: null });
  return { record, source, created: true, changed: true };
}

/** `retitleCanvas`: the user's title for a canvas; it adds no revision. */
export function retitleCanvas(store: BoxStore, agentId: string, canvasId: string, title: string): { record: PageRecord; changed: boolean } {
  const record = requirePage(store, agentId, canvasId, "canvas");
  const name = cleanPageTitle(title);
  if (name.length === 0) throw new PageError("invalid", "Give the canvas a title.");
  if (name === record.title) return { record, changed: false };
  return { record: store.putPage(agentId, { ...record, title: name }), changed: true };
}

/** The user's text from the page stage, made on `baseRevision`. */
export function writePage(store: BoxStore, agentId: string, documentId: string, text: string, baseRevision: number, now = Date.now()): { record: PageRecord; source: string; changed: boolean } {
  const record = requirePage(store, agentId, documentId, "document");
  checkBase(record, baseRevision, "user");
  const source = checkedSource(text);
  return { ...addRevision(store, agentId, record, source, "user", now), source };
}

/** An older revision's text, again, as the user's newest revision. */
export function restoreRevision(store: BoxStore, agentId: string, id: string, revision: number, baseRevision: number, now = Date.now()): { record: PageRecord; source: string; changed: boolean } {
  const record = requirePage(store, agentId, id);
  checkBase(record, baseRevision, "user");
  const { source } = storedPage(store, agentId, id, revision);
  return { ...addRevision(store, agentId, record, source, "user", now), source };
}

/** Newest first. */
export function revisionList(record: PageRecord): PageRevisionInfo[] {
  return record.revisions.map((revision) => ({ n: revision.n, by: revision.by, atMs: revision.atMs })).reverse();
}

/** The pages the user changed after `sinceMs`, as the next message they send tells the agent. */
export function pageEditsSince(store: BoxStore, agentId: string, sinceMs: number): PageEditNote[] {
  return store
    .listPages(agentId)
    .filter((record) => record.revisions.some((revision) => revision.by === "user" && revision.atMs > sinceMs))
    .map((record) => ({ documentId: record.id, title: record.title, revision: newest(record).n, ...(record.kind === "canvas" ? { kind: "canvas" as const } : {}) }));
}
