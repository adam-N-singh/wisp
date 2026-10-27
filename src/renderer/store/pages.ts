// Pages on the page stage (src/shared/pages.ts): which one is open, the documents read so far, the
// user's unsaved edits, and each agent's Library, all kept live from "page-changed". Unsaved edits
// outlive the stage and the app: each is a client slice of its own (`page-draft.<agentId>.<documentId>`),
// so reopening the page, also after a restart, shows them again. An open document without unsaved
// edits reloads when its page changes; with them, the edits stay and the stage offers Reload or Keep
// mine, and a save names the revision the edits were made on, so the box refuses one that would
// write over a change the user hasn't seen. Every "page-changed" says whether the user may edit the
// page now, so it turns read-only while the agent writes it and editable when that run ends.
import type { DocumentEditRight, LibraryPage, PageChangedEvent, PageDocument } from "../../shared/pages";
import { gateway } from "../bridge";
import { readSlice, readSlices, removeSlice, sliceKey, writeSlice } from "./slices";
import { Store } from "./store";

export interface OpenPage {
  agentId: string;
  documentId: string;
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

/** The user's text, made on `baseRevision`. */
export interface Draft {
  source: string;
  baseRevision: number;
}

export const pageKey = (agentId: string, documentId: string) => `${agentId}\u0000${documentId}`;
const locatorOf = (agentId: string, documentId: string) => ({ storeId: agentId, documentId });

export const stage = new Store<StageState>({ open: null, editing: false, viewing: null, showChat: false });
export const documents = new Store<Record<string, LoadedDocument>>({});
export const drafts = new Store<Record<string, Draft | undefined>>({});
/** Each agent's documents, newest first. */
export const library = new Store<Record<string, LibraryPage[] | undefined>>({});

/** A gateway error's failure code and its message for the user. */
export function pageFailure(cause: unknown): { code: string | null; message: string } {
  const text = cause instanceof Error ? cause.message : String(cause);
  const code = /^([\w-]+\/[\w-]+): /.exec(text)?.[1] ?? null;
  return { code, message: code != null ? text.slice(code.length + 2) : text };
}

function setDocument(key: string, change: (current: LoadedDocument) => LoadedDocument): void {
  documents.set((state) => ({ ...state, [key]: change(state[key] ?? { status: "loading" }) }));
}

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

export function openPage(agentId: string, documentId: string): void {
  const current = stage.get().open;
  if (current?.agentId === agentId && current.documentId === documentId) {
    stage.set((state) => ({ ...state, showChat: false }));
    return;
  }
  stage.set({ open: { agentId, documentId }, editing: drafts.get()[pageKey(agentId, documentId)] != null, viewing: null, showChat: false });
  void loadDocument(agentId, documentId);
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

export async function refreshEditRight(agentId: string, documentId: string): Promise<void> {
  try {
    const editRight = await gateway.pageEditAccess({ locator: locatorOf(agentId, documentId) });
    setDocument(pageKey(agentId, documentId), (current) => ({ ...current, editRight }));
  } catch {
    // the next change or reload says
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

export async function restorePageRevision(agentId: string, documentId: string, revision: number, baseRevision: number): Promise<string | null> {
  try {
    const doc = await gateway.restorePageRevision({ locator: locatorOf(agentId, documentId), revision, baseRevision });
    setDocument(pageKey(agentId, documentId), (current) => ({ ...current, status: "ready", doc }));
    return null;
  } catch (cause) {
    void loadDocument(agentId, documentId);
    return pageFailure(cause).message;
  }
}

export async function deletePage(agentId: string, documentId: string): Promise<string | null> {
  try {
    await gateway.deletePage({ locator: locatorOf(agentId, documentId) });
    discardDraft(agentId, documentId);
    setDocument(pageKey(agentId, documentId), () => ({ status: "missing" }));
    return null;
  } catch (cause) {
    return pageFailure(cause).message;
  }
}

export async function loadLibrary(agentId: string): Promise<void> {
  try {
    const pages = await gateway.libraryDocuments({ agentId });
    library.set((state) => ({ ...state, [agentId]: pages }));
  } catch {
    // offline; events fill it in
  }
}

function applyPageChanged(event: PageChangedEvent): void {
  const { agentId, page } = event;
  const known = library.get()[agentId];
  if (known != null) {
    const rest = known.filter((item) => item.page.documentId !== page.page.documentId);
    library.set((state) => ({ ...state, [agentId]: event.change === "deleted" ? rest : [page, ...rest].sort((a, b) => b.updatedAt - a.updatedAt) }));
  }
  const key = pageKey(agentId, page.page.documentId);
  if (event.change === "deleted") putDraft(agentId, page.page.documentId, undefined);
  const loaded = documents.get()[key];
  if (loaded == null) return;
  if (event.change === "deleted") return setDocument(key, () => ({ status: "missing" }));
  if (event.editRight != null) setDocument(key, (current) => ({ ...current, editRight: event.editRight }));
  // A newer revision than the one read: read it (unsaved edits stay as they are).
  if (loaded.doc == null || loaded.doc.revision !== page.revision) void loadDocument(agentId, page.page.documentId);
  // A box that doesn't say is asked.
  else if (event.editRight == null) void refreshEditRight(agentId, page.page.documentId);
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
      for (const key of Object.keys(drafts.get())) {
        const [agentId, documentId] = key.split("\u0000");
        if (ids.includes(agentId)) putDraft(agentId, documentId, undefined);
      }
    },
    "gateway-link": ({ state }) => {
      if (state !== "connected") return;
      for (const key of Object.keys(documents.get())) {
        const [agentId, documentId] = key.split("\u0000");
        void loadDocument(agentId, documentId);
      }
      for (const agentId of Object.keys(library.get())) void loadLibrary(agentId);
    },
  });
}
