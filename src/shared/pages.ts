// Pages: what an agent makes for the user to open on the main stage, beside the chat (the
// "page stage"). Documents come first: Markdown an agent writes with create_document and changes with
// edit_document, kept in the box with every revision (src/box/pages.ts), which the user reads and
// edits on the stage. Canvases (agent-written HTML pages) are pages too; agents don't make them
// yet, so a page's `kind` is only "document" for now.
//
// A document is named `{kind: "document", storeId, documentId}`. Each agent's box keeps its own
// store, so `storeId` is the agent's id. A document's title is its first `# heading`, derived from
// the source alone; a document without one keeps the title it was given.

/** Characters of Markdown one document may hold: its tool calls are replayed to the model with the conversation. */
export const MAX_PAGE_SOURCE = 256 * 1024;
/** Characters of a title (whitespace collapsed). */
export const MAX_PAGE_TITLE = 200;
/** Revisions a page keeps; the oldest go first. */
export const MAX_PAGE_REVISIONS = 50;
export const DOCUMENT_ID_PATTERN = /^doc-[a-z0-9]{6,40}$/;

/** Names a page. */
export interface PageRef {
  kind: "document";
  storeId: string;
  documentId: string;
}

/** Who made a revision: the agent (its tools) or the user (the page stage). */
export type PageAuthor = "agent" | "user";

/** One of a page's revisions (`listPageRevisions`), newest first. */
export interface PageRevisionInfo {
  n: number;
  by: PageAuthor;
  atMs: number;
}

/** A page in the Library (`libraryPages`, `libraryDocuments`) and on `page-changed`. */
export interface LibraryPage {
  page: PageRef;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Its newest revision, and who made it. */
  revision: number;
  updatedBy: PageAuthor;
}

/** `readPage`: the page and one revision's Markdown, the newest unless another was asked for. */
export interface PageDocument extends LibraryPage {
  source: string;
  sourceRevision: number;
}

/** `pageEditAccess`: the user may edit the page, except while the agent is writing it. */
export interface DocumentEditRight {
  canEdit: boolean;
  /** Why not: the agent wrote it in the run that is still going. */
  reason?: "agent-writing";
}

/**
 * The "page-changed" event, for every change to a page. "editable": the run that wrote the page
 * ended, and nothing else changed. Each says whether the user may edit the page now.
 */
export interface PageChangedEvent {
  agentId: string;
  page: LibraryPage;
  change: "created" | "edited" | "restored" | "deleted" | "editable";
  by: PageAuthor;
  editRight: DocumentEditRight;
}

/** A page the user changed, as the next message they send tells the agent. */
export interface PageEditNote {
  documentId: string;
  title: string;
  revision: number;
}

/** A title as pages keep it: one line, whitespace collapsed, at most MAX_PAGE_TITLE characters. */
export function cleanPageTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= MAX_PAGE_TITLE ? line : `${line.slice(0, MAX_PAGE_TITLE - 1).trimEnd()}…`;
}

/** The text of a document's first level-1 heading (`# Title`) outside code, without its inline marks; null if it has none. */
export function documentTitle(source: string): string | null {
  let fence: string | null = null;
  for (const line of source.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker != null) {
      if (fence == null) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence != null) continue;
    const heading = /^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line)?.[1];
    if (heading == null) continue;
    const text = cleanPageTitle(
      heading
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__|`)/g, "")
        .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$)/g, "$1$2"),
    );
    if (text.length > 0) return text;
  }
  return null;
}

/** A line or two of a document's text for its card: Markdown marks, code and the title heading left out. */
export function documentExcerpt(source: string, limit = 240): string {
  const lines: string[] = [];
  let fence = false;
  let skippedTitle = false;
  for (const raw of source.split("\n")) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || /^([-*_]\s*){3,}$/.test(trimmed) || /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(trimmed) || /^\$\$/.test(trimmed)) continue;
    if (!skippedTitle && /^#\s/.test(trimmed)) {
      skippedTitle = true;
      continue;
    }
    const line = trimmed
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|`|~~)/g, "")
      .replace(/^\||\|$/g, "")
      .replace(/\s*\|\s*/g, " · ");
    if (line.length > 0) lines.push(line);
    if (lines.join(" ").length >= limit) break;
  }
  const text = lines.join(" ").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

const clip = (text: string, length = 60) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= length ? line : `${line.slice(0, length - 1)}…`;
};

/**
 * The document after edit_document's edits, each applied to what the ones before it left: every
 * `find` must be in it exactly once, so an edit lands where the agent meant it.
 */
export function applyDocumentEdits(source: string, edits: ReadonlyArray<{ find: string; replace: string }>): { source: string } | { error: string } {
  let text = source;
  for (const [index, edit] of edits.entries()) {
    const label = edits.length > 1 ? `Edit ${index + 1}: ` : "";
    if (edit.find.length === 0) return { error: `${label}find is empty. Quote the text to change.` };
    const first = text.indexOf(edit.find);
    if (first < 0) return { error: `${label}“${clip(edit.find)}” isn’t in the document${index > 0 ? " after the edits before it" : ""}. Read it with read_document and quote its text exactly.` };
    let count = 0;
    for (let at = first; at >= 0; at = text.indexOf(edit.find, at + edit.find.length)) count++;
    if (count > 1) return { error: `${label}“${clip(edit.find)}” is in the document ${count} times. Quote more of the text around the one to change, so it matches once.` };
    text = `${text.slice(0, first)}${edit.replace}${text.slice(first + edit.find.length)}`;
  }
  return { source: text };
}

/** The file a document is saved as (Save as Markdown): its title, with what a file name can't hold left out. */
export function pageFileName(title: string): string {
  const base = title.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").replace(/^[\s.]+|[\s.]+$/g, "").slice(0, 80).trim() || "Document";
  return `${base}.md`;
}

/** What the model reads at the start of the next message the user sends after changing pages (in the user's voice, as a reply's quote is). */
export function pageEditsNote(edits: readonly PageEditNote[]): string {
  if (edits.length === 0) return "";
  const pages = edits.map((edit) => `“${edit.title}” (${edit.documentId}, now revision ${edit.revision})`).join(", ");
  return `[I changed ${edits.length === 1 ? "this page" : "these pages"} since my last message: ${pages}. Read a page with read_document before you edit it again.]\n`;
}
