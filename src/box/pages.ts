// Documents an agent writes (create_document, edit_document) and the user edits on the page stage
// (gateway `writePage`), each change a revision: who made it, when, and its Markdown by content
// hash (store.ts). A change names the revision it was made on when it can, and a stale one is
// refused, so neither side writes over what it hasn't seen: the agent reads the page again, the user
// chooses between reloading and keeping theirs. A page keeps its last MAX_PAGE_REVISIONS revisions;
// restoring one adds it again as the newest.
//
// The model learns what the user changed from the next message they send (pageEditsSince), as it
// learns a reply's quote: the conversation it reads stays append-only.
import { randomBytes } from "node:crypto";
import type { PageMessage } from "../shared/model";
import {
  applyDocumentEdits,
  cleanPageTitle,
  documentExcerpt,
  documentTitle,
  type LibraryPage,
  MAX_PAGE_REVISIONS,
  MAX_PAGE_SOURCE,
  type PageAuthor,
  type PageDocument,
  type PageEditNote,
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

const newest = (record: PageRecord) => record.revisions[record.revisions.length - 1];

export function libraryPage(agentId: string, record: PageRecord): LibraryPage {
  const last = newest(record);
  return { page: { kind: "document", storeId: agentId, documentId: record.id }, title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt, revision: last.n, updatedBy: last.by };
}

/** The page's card in the conversation, as it is now. */
export function pageCard(agentId: string, record: PageRecord, source: string): PageMessage {
  const last = newest(record);
  return { type: "page", page: { kind: "document", storeId: agentId, documentId: record.id }, title: record.title, excerpt: documentExcerpt(source), revision: last.n, updatedBy: last.by, updatedAt: record.updatedAt };
}

export function requirePage(store: BoxStore, agentId: string, documentId: string): PageRecord {
  const record = store.getPage(agentId, documentId);
  if (record == null) throw new PageError("missing", "That page isn’t there any more.");
  return record;
}

/** Markdown as pages keep it: Unix line ends, within the size limit, not empty. */
function checkedSource(source: string): string {
  const text = source.replace(/\r\n?/g, "\n");
  if (text.trim().length === 0) throw new PageError("invalid", "The document is empty.");
  if (text.length > MAX_PAGE_SOURCE) throw new PageError("invalid", `The document is ${text.length} characters; keep it under ${MAX_PAGE_SOURCE}. Split it into several documents.`);
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
      ? `“${record.title}” is at revision ${last.n} now, not ${baseRevision}: ${who} since. Read it again with read_document and make your change on that.`
      : `“${record.title}” changed since you opened it (revision ${last.n} now, not ${baseRevision}).`,
  );
}

/** Adds a revision with this Markdown, unless the newest already says it; the title follows the first `# heading`. */
function addRevision(store: BoxStore, agentId: string, record: PageRecord, source: string, by: PageAuthor, now: number): { record: PageRecord; changed: boolean } {
  const sha256 = store.savePageSource(source);
  const last = newest(record);
  if (last.sha256 === sha256) return { record, changed: false };
  const revisions = [...record.revisions, { n: last.n + 1, sha256, by, atMs: now }].slice(-MAX_PAGE_REVISIONS);
  const next: PageRecord = { ...record, title: documentTitle(source) ?? record.title, updatedAt: now, revisions };
  return { record: store.putPage(agentId, next), changed: true };
}

export function createDocument(store: BoxStore, agentId: string, title: string, markdown: string, now = Date.now()): { record: PageRecord; source: string } {
  const source = checkedSource(markdown);
  const name = documentTitle(source) ?? cleanPageTitle(title);
  if (name.length === 0) throw new PageError("invalid", "Give the document a title.");
  const sha256 = store.savePageSource(source);
  const record = store.putPage(agentId, { id: newDocumentId(), kind: "document", title: name, createdAt: now, updatedAt: now, revisions: [{ n: 1, sha256, by: "agent", atMs: now }], cardId: null });
  return { record, source };
}

/** A revision's Markdown: the newest, or the one asked for while the page still keeps it. */
export function readDocument(store: BoxStore, agentId: string, documentId: string, revision?: number): { record: PageRecord; source: string; revision: number } {
  const record = requirePage(store, agentId, documentId);
  const kept = revision == null ? newest(record) : record.revisions.find((candidate) => candidate.n === revision);
  if (kept == null) throw new PageError("missing", `“${record.title}” no longer keeps revision ${revision}.`);
  const source = store.pageSource(kept.sha256);
  if (source == null) throw new PageError("missing", `Revision ${kept.n} of “${record.title}” is missing from the box.`);
  return { record, source, revision: kept.n };
}

/** `readPage`'s answer: the page, and the text of `sourceRevision` (by default its newest). */
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

/** The user's text from the page stage, made on `baseRevision`. */
export function writePage(store: BoxStore, agentId: string, documentId: string, text: string, baseRevision: number, now = Date.now()): { record: PageRecord; source: string; changed: boolean } {
  const record = requirePage(store, agentId, documentId);
  checkBase(record, baseRevision, "user");
  const source = checkedSource(text);
  return { ...addRevision(store, agentId, record, source, "user", now), source };
}

/** An older revision's text, again, as the user's newest revision. */
export function restoreRevision(store: BoxStore, agentId: string, documentId: string, revision: number, baseRevision: number, now = Date.now()): { record: PageRecord; source: string; changed: boolean } {
  const record = requirePage(store, agentId, documentId);
  checkBase(record, baseRevision, "user");
  const { source } = readDocument(store, agentId, documentId, revision);
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
    .map((record) => ({ documentId: record.id, title: record.title, revision: newest(record).n }));
}
