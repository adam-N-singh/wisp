// Pages on the page stage (src/shared/pages.ts): which one is open, the documents and canvases read so
// far, the user's unsaved edits, and each agent's Library, all kept live from "page-changed". A
// canvas's HTML runs in its frame, which main serves (src/main/canvases.ts); this keeps what the stage
// says about it: its title, revision and who made it. Unsaved edits
// outlive the stage and the app: each is a client slice of its own (`page-draft.<agentId>.<documentId>`),
// so reopening the page, also after a restart, shows them again. An open document without unsaved
// edits reloads when its page changes; with them, the edits stay and the stage offers Reload or Keep
// mine, and a save names the revision the edits were made on, so the box refuses one that would
// write over a change the user hasn't seen. Every "page-changed" says whether the user may edit the
// page now, so it turns read-only while the agent writes it and editable when that run ends.
import { type DocumentEditRight, type LibraryPage, type PageChangedEvent, type PageDocument, pageId, pageKindOf, pageLocatorFor } from "../../shared/pages";
import { gateway } from "../bridge";
import { readSlice, readSlices, removeSlice, sliceKey, writeSlice } from "./slices";
import { Store } from "./store";

export interface OpenPage {
  agentId: string;
  /** A document's id or a canvas's. */
  pageId: string;
}

export interface StageState {
  open: OpenPage | null;
  /** The source and its preview are showing. */
  editing: boolean;
  /** An older revision shown instead of the newest. */
  viewing: number | null;
  /** On a stage too narrow for both, the chat shows instead of the page. */
  showChat: boolean;
}

export interface LoadedDocument {
  status: "loading" | "ready" | "missing" | "error";
  /** The newest revision, as last read. */
  doc?: PageDocument;
  error?: string;
  editRight?: DocumentEditRight;
}

/** A canvas, as last read: what its stage says about it (its HTML is its frame's). */
export interface LoadedCanvas {
  status: "loading" | "ready" | "missing" | "error";
  canvas?: LibraryPage;
  error?: string;
  editRight?: DocumentEditRight;
}

/** The user's text, made on `baseRevision`. */
export interface Draft {
  source: string;
  baseRevision: number;
}

export const pageKey = (agentId: string, documentId: string) => `${agentId}\u0000${documentId}`;
const locatorOf = (agentId: string, documentId: string) => ({ storeId: agentId, documentId });

export const stage = new Store<StageState>({ open: null, editing: false, viewing: null, showChat: false });
export const documents = new Store<Record<string, LoadedDocument>>({});
export const canvases = new Store<Record<string, LoadedCanvas>>({});
export const drafts = new Store<Record<string, Draft | undefined>>({});
/** Each agent's pages, newest first. */
export const library = new Store<Record<string, LibraryPage[] | undefined>>({});
/** Every agent's pages (`libraryPages`), newest first, once the palette has asked; null until then. */
export const allPages = new Store<LibraryPage[] | null>(null);

/** A gateway error's failure code and its message for the user. */
export function pageFailure(cause: unknown): { code: string | null; message: string } {
  const text = cause instanceof Error ? cause.message : String(cause);
  const code = /^([\w-]+\/[\w-]+): /.exec(text)?.[1] ?? null;
  return { code, message: code != null ? text.slice(code.length + 2) : text };
}

function setDocument(key: string, change: (current: LoadedDocument) => LoadedDocument): void {
  documents.set((state) => ({ ...state, [key]: change(state[key] ?? { status: "loading" }) }));
}

function setCanvas(key: string, change: (current: LoadedCanvas) => LoadedCanvas): void {
  canvases.set((state) => ({ ...state, [key]: change(state[key] ?? { status: "loading" }) }));
}

/** What a page view (`canvasPage`, a restore) says about the page, without its text. */
const pageOf = ({ page, title, createdAt, updatedAt, revision, updatedBy }: LibraryPage): LibraryPage => ({ page, title, createdAt, updatedAt, revision, updatedBy });

/** A draft as its slice keeps it: the page it belongs to as well. */
interface StoredDraft extends Draft {
  agentId: string;
  documentId: string;
}

const DRAFT_SLICE = "page-draft.";
const draftSlice = (agentId: string, documentId: string) => sliceKey(`${DRAFT_SLICE}${agentId}.${documentId}`);

/** Sets or clears the page's draft, here and in its slice. */
function putDraft(agentId: string, documentId: string, draft: Draft | undefined): void {
  const key = pageKey(agentId, documentId);
  if (draft == null && drafts.get()[key] == null) return;
  drafts.set((state) => ({ ...state, [key]: draft }));
  if (draft == null) removeSlice(draftSlice(agentId, documentId));
  else writeSlice<StoredDraft>(draftSlice(agentId, documentId), 1, { agentId, documentId, ...draft });
}

export function openPage(agentId: string, pageId: string): void {
  const current = stage.get().open;
  if (current?.agentId === agentId && current.pageId === pageId) {
    stage.set((state) => ({ ...state, showChat: false }));
    return;
  }
  stage.set({ open: { agentId, pageId }, editing: drafts.get()[pageKey(agentId, pageId)] != null, viewing: null, showChat: false });
  void loadPage(agentId, pageId);
}

/** Reads a document or a canvas, by its id. */
export function loadPage(agentId: string, pageId: string): Promise<void> {
  return pageKindOf(pageId) === "canvas" ? loadCanvas(agentId, pageId) : loadDocument(agentId, pageId);
}

export function closePage(): void {
  if (stage.get().open != null) stage.set({ open: null, editing: false, viewing: null, showChat: false });
}

export function setStage(patch: Partial<Omit<StageState, "open">>): void {
  stage.set((state) => ({ ...state, ...patch }));
}

/** Esc on the stage: out of the editor, back from an older revision, then closed. */
export function stageBack(): void {
  const state = stage.get();
  if (state.editing) setStage({ editing: false });
  else if (state.viewing != null) setStage({ viewing: null });
  else closePage();
}

/** Reads the page's newest revision and whether the user may edit it now. */
export async function loadDocument(agentId: string, documentId: string): Promise<void> {
  const key = pageKey(agentId, documentId);
  setDocument(key, (current) => ({ ...current, status: current.doc != null ? current.status : "loading" }));
  try {
    const [doc, editRight] = await Promise.all([gateway.readPage({ locator: locatorOf(agentId, documentId) }), gateway.pageEditAccess({ locator: locatorOf(agentId, documentId) })]);
    setDocument(key, () => ({ status: "ready", doc, editRight }));
    // Edits that say what the page now says are no edits.
    const draft = drafts.get()[key];
    if (draft != null && draft.source === doc.source) discardDraft(agentId, documentId);
  } catch (cause) {
    const failure = pageFailure(cause);
    setDocument(key, (current) => (failure.code === "page/not-found" ? { status: "missing" } : { ...current, status: current.doc != null ? "ready" : "error", error: failure.message }));
    // Edits to a page that's gone have nowhere to go.
    if (failure.code === "page/not-found") putDraft(agentId, documentId, undefined);
  }
}

/** Reads what the stage says about a canvas, and whether the user may change it now. */
export async function loadCanvas(agentId: string, canvasId: string): Promise<void> {
  const key = pageKey(agentId, canvasId);
  setCanvas(key, (current) => ({ ...current, status: current.canvas != null ? current.status : "loading" }));
  const locator = { storeId: agentId, canvasId };
  try {
    const [view, editRight] = await Promise.all([gateway.canvasPage({ locator }), gateway.pageEditAccess({ locator })]);
    setCanvas(key, () => ({ status: "ready", canvas: pageOf(view), editRight }));
  } catch (cause) {
    const failure = pageFailure(cause);
    setCanvas(key, (current) => (failure.code === "page/not-found" ? { status: "missing" } : { ...current, status: current.canvas != null ? "ready" : "error", error: failure.message }));
  }
}

export async function refreshEditRight(agentId: string, id: string): Promise<void> {
  try {
    const editRight = await gateway.pageEditAccess({ locator: pageLocatorFor(agentId, id) });
    if (pageKindOf(id) === "canvas") setCanvas(pageKey(agentId, id), (current) => ({ ...current, editRight }));
    else setDocument(pageKey(agentId, id), (current) => ({ ...current, editRight }));
  } catch {
    // the next change or reload says
  }
}

/** The user's title for a canvas; a refusal is for the user. */
export async function retitleCanvas(agentId: string, canvasId: string, title: string): Promise<string | null> {
  try {
    const renamed = await gateway.retitleCanvas({ storeId: agentId, canvasId, title });
    setCanvas(pageKey(agentId, canvasId), (current) => (current.canvas != null ? { ...current, canvas: { ...current.canvas, title: renamed.title } } : current));
    return null;
  } catch (cause) {
    void loadCanvas(agentId, canvasId);
    return pageFailure(cause).message;
  }
}

/** The user's text in the editor; text that is the newest revision's again leaves no draft. */
export function setDraft(agentId: string, documentId: string, source: string): void {
  const key = pageKey(agentId, documentId);
  const doc = documents.get()[key]?.doc;
  if (doc == null) return;
  const draft = drafts.get()[key];
  const baseRevision = draft?.baseRevision ?? doc.revision;
  putDraft(agentId, documentId, source === doc.source && baseRevision === doc.revision ? undefined : { source, baseRevision });
}

export function discardDraft(agentId: string, documentId: string): void {
  putDraft(agentId, documentId, undefined);
}

/** Keep mine: the user's edits go on top of the page as it is now. */
export function keepMine(agentId: string, documentId: string): void {
  const key = pageKey(agentId, documentId);
  const doc = documents.get()[key]?.doc;
  const draft = drafts.get()[key];
  if (doc != null && draft != null) putDraft(agentId, documentId, { ...draft, baseRevision: doc.revision });
}

/** Saves the draft on the revision it was made on; a refusal is for the user (a stale one reloads the page). */
export async function saveDraft(agentId: string, documentId: string): Promise<string | null> {
  const key = pageKey(agentId, documentId);
  const draft = drafts.get()[key];
  if (draft == null) return null;
  try {
    const doc = await gateway.writePage({ locator: locatorOf(agentId, documentId), source: draft.source, baseRevision: draft.baseRevision });
    setDocument(key, (current) => ({ ...current, status: "ready", doc }));
    // Unless the user typed on while it saved.
    const typed = drafts.get()[key];
    putDraft(agentId, documentId, typed == null || typed.source === draft.source ? undefined : { source: typed.source, baseRevision: doc.revision });
    return null;
  } catch (cause) {
    const failure = pageFailure(cause);
    if (failure.code === "page/stale" || failure.code === "page/agent-writing") void loadDocument(agentId, documentId);
    return failure.message;
  }
}

export async function restorePageRevision(agentId: string, id: string, revision: number, baseRevision: number): Promise<string | null> {
  try {
    const doc = await gateway.restorePageRevision({ locator: pageLocatorFor(agentId, id), revision, baseRevision });
    if (doc.page.kind === "canvas") setCanvas(pageKey(agentId, id), (current) => ({ ...current, status: "ready", canvas: pageOf(doc) }));
    else setDocument(pageKey(agentId, id), (current) => ({ ...current, status: "ready", doc }));
    return null;
  } catch (cause) {
    void loadPage(agentId, id);
    return pageFailure(cause).message;
  }
}

export async function deletePage(agentId: string, id: string): Promise<string | null> {
  try {
    await gateway.deletePage({ locator: pageLocatorFor(agentId, id) });
    if (pageKindOf(id) === "canvas") setCanvas(pageKey(agentId, id), () => ({ status: "missing" }));
    else {
      discardDraft(agentId, id);
      setDocument(pageKey(agentId, id), () => ({ status: "missing" }));
    }
    return null;
  } catch (cause) {
    return pageFailure(cause).message;
  }
}

/** The agent's documents and canvases, for its Library. */
export async function loadLibrary(agentId: string): Promise<void> {
  try {
    const pages = await gateway.libraryPages({ includeDocuments: true, agentId });
    library.set((state) => ({ ...state, [agentId]: pages }));
  } catch {
    // offline; events fill it in
  }
}

export async function loadAllPages(): Promise<void> {
  try {
    allPages.set(await gateway.libraryPages({ includeDocuments: true }));
  } catch {
    // offline; what was read before stays
  }
}

/** A list of pages with this one put in (newest first), changed or taken out. */
function withPage(list: readonly LibraryPage[], page: LibraryPage, deleted: boolean): LibraryPage[] {
  const rest = list.filter((item) => item.page.storeId !== page.page.storeId || pageId(item.page) !== pageId(page.page));
  return deleted ? rest : [page, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
}

function applyPageChanged(event: PageChangedEvent): void {
  const { agentId, page } = event;
  const known = library.get()[agentId];
  if (known != null) library.set((state) => ({ ...state, [agentId]: withPage(known, page, event.change === "deleted") }));
  const every = allPages.get();
  if (every != null) allPages.set(withPage(every, page, event.change === "deleted"));
  const id = pageId(page.page);
  const key = pageKey(agentId, id);
  if (page.page.kind === "canvas") {
    // The event says all the stage shows; the frame reads the new revision itself.
    if (canvases.get()[key] == null) return;
    if (event.change === "deleted") return setCanvas(key, () => ({ status: "missing" }));
    setCanvas(key, (current) => ({ ...current, status: "ready", canvas: page, editRight: event.editRight ?? current.editRight }));
    if (event.editRight == null) void refreshEditRight(agentId, id);
    return;
  }
  if (event.change === "deleted") putDraft(agentId, id, undefined);
  const loaded = documents.get()[key];
  if (loaded == null) return;
  if (event.change === "deleted") return setDocument(key, () => ({ status: "missing" }));
  if (event.editRight != null) setDocument(key, (current) => ({ ...current, editRight: event.editRight }));
  // A newer revision than the one read: read it (unsaved edits stay as they are).
  if (loaded.doc == null || loaded.doc.revision !== page.revision) void loadDocument(agentId, id);
  // A box that doesn't say is asked.
  else if (event.editRight == null) void refreshEditRight(agentId, id);
}

// The companion chat's width beside the page, per user.
const CHAT_WIDTH = sliceKey("ui-page-stage");
export const CHAT_MIN_WIDTH = 424;
export const stageLayout = new Store<{ chatWidth: number }>({ chatWidth: 440 });

export function setChatWidth(width: number): void {
  stageLayout.set({ chatWidth: Math.round(width) });
  writeSlice(CHAT_WIDTH, 1, stageLayout.get());
}

let started = false;
export function startPages(): void {
  if (started) return;
  started = true;
  void readSlice<{ chatWidth: number }>(CHAT_WIDTH, 1).then((saved) => {
    if (saved != null && Number.isFinite(saved.chatWidth)) stageLayout.set({ chatWidth: Math.max(CHAT_MIN_WIDTH, saved.chatWidth) });
  });
  // Edits left unsaved when the app last closed; one made since it started wins.
  void readSlices<StoredDraft>(DRAFT_SLICE, 1).then((stored) => {
    const found = stored.filter((draft) => typeof draft.agentId === "string" && typeof draft.documentId === "string" && typeof draft.source === "string" && Number.isInteger(draft.baseRevision));
    if (found.length === 0) return;
    drafts.set((state) => {
      const next = { ...state };
      for (const draft of found) next[pageKey(draft.agentId, draft.documentId)] ??= { source: draft.source, baseRevision: draft.baseRevision };
      return next;
    });
  });
  gateway.subscribe({
    "page-changed": applyPageChanged,
    "agent-deleted": ({ ids }) => {
      const every = allPages.get();
      if (every != null) allPages.set(every.filter((item) => !ids.includes(item.page.storeId)));
      for (const key of Object.keys(drafts.get())) {
        const [agentId, documentId] = key.split("\u0000");
        if (ids.includes(agentId)) putDraft(agentId, documentId, undefined);
      }
    },
    "gateway-link": ({ state }) => {
      if (state !== "connected") return;
      for (const key of [...Object.keys(documents.get()), ...Object.keys(canvases.get())]) {
        const [agentId, id] = key.split("\u0000");
        void loadPage(agentId, id);
      }
      for (const agentId of Object.keys(library.get())) void loadLibrary(agentId);
      if (allPages.get() != null) void loadAllPages();
    },
  });
}
