// Pages: what an agent makes for the user to open on the main stage, beside the chat (the
// "page stage"). A document is Markdown an agent writes with create_document and changes with
// edit_document, which the user reads and edits on the stage. A canvas is an interactive HTML page an
// agent writes with write_canvas (src/shared/canvas.ts), which the user uses on the stage and only the
// agent changes. The box keeps both with every revision (src/box/pages.ts).
//
// A document is named `{kind: "document", storeId, documentId}` and a canvas `{kind: "canvas",
// storeId, canvasId}`. Each agent's box keeps its own store, so `storeId` is the agent's id. A
// document's title is its first `# heading`, derived from the source alone; a document without one
// keeps the title it was given. A canvas keeps the title it was given (its <title> when it was given
// none) until write_canvas or retitleCanvas gives it another.

/** Characters of Markdown, or of a canvas's HTML, one page may hold: its tool calls are replayed to the model with the conversation. */
export const MAX_PAGE_SOURCE = 256 * 1024;
/** Characters of a title (whitespace collapsed). */
export const MAX_PAGE_TITLE = 200;
/** Revisions a page keeps; the oldest go first. */
export const MAX_PAGE_REVISIONS = 50;
export const DOCUMENT_ID_PATTERN = /^doc-[a-z0-9]{6,40}$/;
export const CANVAS_ID_PATTERN = /^canvas-[a-z0-9]{6,40}$/;

export type PageKind = "document" | "canvas";

/** Names a page: a document or a canvas in an agent's store. */
export type PageRef = { kind: "document"; storeId: string; documentId: string } | { kind: "canvas"; storeId: string; canvasId: string };

/** The page's id in its agent's store; a document's and a canvas's never collide. */
export const pageId = (ref: PageRef): string => (ref.kind === "canvas" ? ref.canvasId : ref.documentId);

/** What kind of page an id names, or null when it names none. */
export function pageKindOf(id: string): PageKind | null {
  return DOCUMENT_ID_PATTERN.test(id) ? "document" : CANVAS_ID_PATTERN.test(id) ? "canvas" : null;
}

/** The ref of one of this agent's pages, by its id. */
export function pageRefFor(storeId: string, id: string): PageRef {
  return pageKindOf(id) === "canvas" ? { kind: "canvas", storeId, canvasId: id } : { kind: "document", storeId, documentId: id };
}

/** A page as gateway calls name one: its agent's store and its id. */
export type PageLocator = { storeId: string; documentId: string } | { storeId: string; canvasId: string };

export function pageLocatorFor(storeId: string, id: string): PageLocator {
  return pageKindOf(id) === "canvas" ? { storeId, canvasId: id } : { storeId, documentId: id };
}

export const locatorPageId = (locator: PageLocator): string => ("canvasId" in locator ? locator.canvasId : locator.documentId);

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

/**
 * Of what a client knows of a page and a view that just arrived (a read's answer, an event), the one
 * to keep: answers and events come by different routes, so an older revision never replaces a newer
 * one. At the same revision the one that arrived wins, unless it's a read that an event overtook
 * (`overtaken`), which may say less (a rename).
 */
export function newerPage<T extends Pick<LibraryPage, "revision">>(known: T | null | undefined, arrived: T, overtaken = false): T {
  if (known == null || arrived.revision > known.revision) return arrived;
  if (arrived.revision < known.revision) return known;
  return overtaken ? known : arrived;
}

/** `readPage`: the page and one revision's Markdown (`canvasPage`: a canvas's HTML), the newest unless another was asked for. */
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
  change: "created" | "edited" | "restored" | "renamed" | "deleted" | "editable";
  by: PageAuthor;
  editRight: DocumentEditRight;
}

/** A page the user changed, as the next message they send tells the agent. */
export interface PageEditNote {
  /** The page's id: a document's, or (with `kind`) a canvas's. */
  documentId: string;
  title: string;
  revision: number;
  kind?: "canvas";
}

/** A title as pages keep it: one line, whitespace collapsed, at most MAX_PAGE_TITLE characters. */
export function cleanPageTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= MAX_PAGE_TITLE ? line : `${line.slice(0, MAX_PAGE_TITLE - 1).trimEnd()}…`;
}

// Document text is read in one pass over each line. The patterns these replace rescanned the rest of
// a line from every place they could start (a heading's trailing spaces, a `[` that never made a link),
// so one long line in a document could hold up every agent in the box.

const isBlank = (char: string | undefined) => char === " " || char === "\t";

/**
 * A level-1 heading's text, as `/^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/` read it: without its
 * closing `#`s (only after a space) and trailing spaces; null when the line isn't one.
 */
function headingText(line: string): string | null {
  const open = /^ {0,3}#[ \t]+/.exec(line);
  if (open == null) return null;
  const rest = line.slice(open[0].length);
  // `.` doesn't take a line break, and nothing after it could, so such a line was never a heading.
  if (rest.length === 0 || /[\r\n\u2028\u2029]/.test(rest)) return null;
  let end = rest.length;
  while (end > 0 && isBlank(rest[end - 1])) end--;
  let hashes = end;
  while (hashes > 0 && rest[hashes - 1] === "#") hashes--;
  if (hashes < end && isBlank(rest[hashes - 1])) {
    let text = hashes - 1;
    while (text > 0 && isBlank(rest[text - 1])) text--;
    if (text > 0) end = text;
  }
  return rest.slice(0, end);
}

/** Where `char` next appears at or after each index of `text` (-1 when it doesn't). */
function nextOf(text: string, char: string): Int32Array {
  const next = new Int32Array(text.length + 1).fill(-1);
  for (let index = text.length - 1, at = -1; index >= 0; index--) {
    if (text[index] === char) at = index;
    next[index] = at;
  }
  return next;
}

/** Links and images as their labels: what `.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")` gave. */
function linkLabels(text: string): string {
  if (!text.includes("[")) return text;
  const bracket = nextOf(text, "]");
  const paren = nextOf(text, ")");
  let out = "";
  let kept = 0;
  for (let index = 0; index < text.length; index++) {
    const open = text[index] === "[" ? index : text[index] === "!" && text[index + 1] === "[" ? index + 1 : -1;
    if (open < 0) continue;
    const close = bracket[open + 1];
    if (close < 0 || text[close + 1] !== "(") continue;
    const end = paren[close + 2];
    if (end < 0) continue;
    out += text.slice(kept, index) + text.slice(open + 1, close);
    kept = end + 1;
    index = end;
  }
  return out + text.slice(kept);
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
    const heading = headingText(line);
    if (heading == null) continue;
    const text = cleanPageTitle(
      linkLabels(heading)
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
      .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "");
    const cells = linkLabels(line)
      .replace(/(\*\*|__|`|~~)/g, "")
      .replace(/^\||\|$/g, "")
      .split("|");
    // Each pipe and the spaces around it as one dot (what `/\s*\|\s*/g` did, which rescanned every run of spaces).
    const text = cells
      .map((cell, index) => {
        const start = index > 0 ? cell.trimStart() : cell;
        return index < cells.length - 1 ? start.trimEnd() : start;
      })
      .join(" · ");
    if (text.length > 0) lines.push(text);
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

/** The file a page is saved as (Save as Markdown, Save as HTML): its title, with what a file name can't hold left out. */
export function pageFileName(title: string, kind: PageKind = "document"): string {
  const base = title.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").replace(/^[\s.]+|[\s.]+$/g, "").slice(0, 80).trim() || (kind === "canvas" ? "Canvas" : "Document");
  return `${base}.${kind === "canvas" ? "html" : "md"}`;
}

// A canvas's text, title and excerpt are read from HTML the agent wrote, in the box host that every
// agent and the gateway share, so each is one pass from left to right: a lazy regex like
// `<!--[\s\S]*?-->` reads to the end again for every opener that never closes, which on 256 KB of
// `<!--` is billions of steps. Each scan here looks at each `<` once.

/** Elements whose content isn't text the page shows. */
const HIDDEN_ELEMENT = /<(script|style|template|svg|noscript)\b/iy;

/** Where `</name>` (any case, with space before its `>`) starts and ends, from `from` on; null when it never closes. */
function closingTag(html: string, name: string, from: number): { start: number; end: number } | null {
  const close = new RegExp(`<\\/${name}\\s*>`, "iy");
  for (let at = html.indexOf("<", from); at >= 0; at = html.indexOf("<", at + 1)) {
    close.lastIndex = at;
    if (close.test(html)) return { start: at, end: close.lastIndex };
  }
  return null;
}

/** Where the next `<name` (a whole tag name) starts, from `from` on, and where its name ends; null when there's none. */
function openingTag(html: string, name: string, from: number): { start: number; end: number } | null {
  const open = new RegExp(`<${name}\\b`, "iy");
  for (let at = html.indexOf("<", from); at >= 0; at = html.indexOf("<", at + 1)) {
    open.lastIndex = at;
    if (open.test(html)) return { start: at, end: open.lastIndex };
  }
  return null;
}

/** The HTML with every `<name …>…</name>` element left out (`all`) or only the first; an element that never closes stays. */
function withoutElements(html: string, name: string, all: boolean): string {
  const parts: string[] = [];
  let at = 0;
  for (let open = openingTag(html, name, 0); open != null; open = all ? openingTag(html, name, at) : null) {
    const close = closingTag(html, name, open.end);
    if (close == null) break;
    parts.push(html.slice(at, open.start), " ");
    at = close.end;
  }
  parts.push(html.slice(at));
  return parts.join("");
}

/**
 * Text from a canvas for its card and its title: what the page shows, without comments, script,
 * style or tags. A comment or a hidden element that never closes hides the rest, as it does on the page.
 */
function canvasText(html: string): string {
  const parts: string[] = [];
  let at = 0;
  while (at < html.length) {
    const lt = html.indexOf("<", at);
    if (lt < 0) {
      parts.push(html.slice(at));
      break;
    }
    parts.push(html.slice(at, lt), " ");
    HIDDEN_ELEMENT.lastIndex = lt;
    const hidden = HIDDEN_ELEMENT.exec(html);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      at = end < 0 ? html.length : end + 3;
    } else if (hidden != null) {
      at = closingTag(html, hidden[1], HIDDEN_ELEMENT.lastIndex)?.end ?? html.length;
    } else {
      const gt = html.indexOf(">", lt + 1);
      // A `<` with no `>` after it is text, and so is everything after it.
      if (gt < 0) {
        parts.push(html.slice(lt));
        break;
      }
      at = gt + 1;
    }
  }
  return parts
    .join("")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** The inner HTML of the first `<name …>…</name>`; null when there's none, or it never closes. */
function firstElement(html: string, name: string): string | null {
  const open = openingTag(html, name, 0);
  const gt = open != null ? html.indexOf(">", open.end) : -1;
  const close = gt >= 0 ? closingTag(html, name, gt + 1) : null;
  return close != null ? html.slice(gt + 1, close.start) : null;
}

/** A canvas's <title>, or else its first <h1>; null when it has neither. Read only within the size a page may have. */
export function canvasTitle(html: string): string | null {
  const page = html.length > MAX_PAGE_SOURCE ? html.slice(0, MAX_PAGE_SOURCE) : html;
  for (const name of ["title", "h1"]) {
    const found = firstElement(page, name);
    const text = found != null ? cleanPageTitle(canvasText(found)) : "";
    if (text.length > 0) return text;
  }
  return null;
}

/** A line or two of what a canvas shows, for its card; its title (the <head>) left out. */
export function canvasExcerpt(html: string, limit = 240): string {
  const page = html.length > MAX_PAGE_SOURCE ? html.slice(0, MAX_PAGE_SOURCE) : html;
  const text = canvasText(withoutElements(withoutElements(page, "head", false), "title", true));
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

/** What the model reads at the start of the next message the user sends after changing pages (in the user's voice, as a reply's quote is). */
export function pageEditsNote(edits: readonly PageEditNote[]): string {
  if (edits.length === 0) return "";
  const pages = edits.map((edit) => `“${edit.title}” (${edit.documentId}, now revision ${edit.revision})`).join(", ");
  const canvases = edits.filter((edit) => edit.kind === "canvas").length;
  const read = canvases === 0 ? "read_document" : canvases === edits.length ? "read_canvas" : "read_document or read_canvas";
  return `[I changed ${edits.length === 1 ? "this page" : "these pages"} since my last message: ${pages}. Read a page with ${read} before you ${canvases === 0 ? "edit" : "change"} it again.]\n`;
}
