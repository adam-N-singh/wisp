// The agent browser (README "Agent browser"): a window per agent on this PC, all in one saved
// profile (`persist:agent-browser`), so the user signs in to a site once, in that profile, and
// every agent finds the sign-in there. Nothing is ever read from the user's own Chrome or Edge.
//
// One window per agent rather than one shared window with a tab per agent: each agent's window
// names it, the user takes over (and hands back) one agent's browser while others keep going,
// and an agent's tabs (pages that open new windows become tabs) stay together.
//
// Main drives each tab over the DevTools protocol (webContents.debugger): the accessibility tree
// for snapshots (agent-browser-snapshot.ts), DOM quads and trusted mouse and key events for
// actions, and an isolated world for the few page reads that need script (form, focus, scroll),
// out of reach of the page's own scripts. A frame from the page's own origin runs in the page's
// renderer, so its tree is read into the snapshot and its elements are acted on like the page's,
// each in an isolated world of its own frame; any other frame is only named. The daemon has
// already planned and allowed each call (src/local-exec/browser-tools.ts); here a call also waits
// while the user has the browser, and is refused when the page has moved to another site since it
// was rated.
//
// The window's toolbar (src/renderer/agent-browser/) shows who drives, with Take over / Hand back.
// Page permission prompts are refused, downloads go to the agent's workspace, popups become tabs,
// and only http(s) pages open. Each agent's window opens where the user last left it
// (agent-browser-bounds.ts).
//
// The vault (src/main/vault.ts) fills logins and contact info through `vault()`: it reads the
// page's real origin and each field's own document here, and the values go straight into the page
// (Input.insertText), never through the daemon. A filled field stays masked for the agent: its
// snapshot line says "filled from your vault"; screenshots paint over it and anything else on screen
// holding a value (a restored or swapped field, a pasted copy, an echo on the next page); every value
// is blanked wherever a reply, an error or a card would repeat it (agent-browser-mask.ts); copying
// and cutting aren't pressed while the window holds values, nor pasting one; and read_clipboard
// gets the clipboard with them blanked.
//
// A page's alert and confirm come here instead of Electron's native message box, which isn't tied
// to the agent's window and stays on screen when the dialog is answered some other way: while the
// agent drives they're answered at once (alert accepted, confirm dismissed) and the agent is told;
// while the user drives they show in the toolbar, to answer there. Electron has no public hook for
// this; its WebContents emits "-run-dialog" (info, callback) and "-cancel-dialogs" for its own
// listener, which each tab replaces. Without that event (another Electron), the native box stays
// and the agent's turn answers over the DevTools protocol, as before. (window.prompt never comes:
// Electron throws in the page.)
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BaseWindow, clipboard, type IpcMain, nativeImage, screen, type Session, session as sessions, type WebContents, WebContentsView } from "electron";
import {
  AGENT_BROWSER_PARTITION,
  type BrowserPlanInfo,
  type BrowserRunReply,
  type BrowserTarget,
  type BrowserToolName,
  checkBrowserUrl,
  clipboardChord,
  type KeyChord,
  parseKeyChord,
  sensitiveField,
  siteLabel,
  siteOf,
  untrustedPage,
} from "../shared/agent-browser";
import type { EdgeEmitter } from "../shared/rpc/edge";
import { serveEdge } from "../shared/rpc/runtime";
import { ipcServerTransport } from "../shared/rpc/transports";
import { type AgentBrowserState, agentBrowserToolbarEdge, type AgentBrowserToolbarView } from "../shared/edges";
import { type AgentBrowserBounds, placeWindow } from "./agent-browser-bounds";
import { coverRegions, holdsValue, quadRegion, type Region, scaleRegion, type ScreenScan, scrubClipboard, scrubValues, valueRegions } from "./agent-browser-mask";
import { type AXNode, type FieldInfo, type FrameContent, needsFieldInfo, RefTable, renderSnapshot } from "./agent-browser-snapshot";
import { forgetFrameWorld, inWorld } from "./agent-browser-worlds";
import { fillable, type VaultBrowser, type VaultField, type VaultFill } from "./vault";

const TOOLBAR_HEIGHT = 80;
const WINDOW_SIZE = { width: 1200, height: 860, minWidth: 520, minHeight: 360 };
/** The toolbar's extra row while it shows a page's dialog. */
const DIALOG_ROW_HEIGHT = 48;
const MAX_TABS = 12;
const DOWNLOAD_LIMIT = 1024 ** 3;
const LOAD_TIMEOUT_MS = 30_000;
const CDP_TIMEOUT_MS = 15_000;
const WORLD = "wisp-agent-browser";
/** How many same-origin frames a snapshot reads, and how deep in frames within frames. */
const MAX_FRAMES = 20;
const MAX_FRAME_DEPTH = 3;

export interface AgentBrowserDeps {
  distDir: string;
  ipcMain: IpcMain;
  /** The agent's folder on this PC, where its downloads go. */
  workspaceFor(agentId: string): string;
  agentName(agentId: string): string;
  /** Opens the agent's conversation in the main window. */
  showChat(agentId: string): void;
  onChange(state: AgentBrowserState): void;
  /** Where each agent's window was, so it opens there again. */
  windowBounds: Pick<AgentBrowserBounds, "get" | "set" | "saveNow">;
}

interface Tab {
  id: number;
  view: WebContentsView;
  contents: WebContents;
  refs: RefTable;
  /** The isolated world's execution context in the current document ("") and in its same-origin frames, by frame id. */
  worlds: Map<string, number>;
  /** Each frame the last snapshot met: its element in the frame around it, and that frame (null for the page). */
  frameOwners: Map<string, { owner: number; parent: string | null }>;
  /** Counts documents, so a call can tell whether it navigated. */
  documents: number;
  /** This tab's alerts and confirms come to us (see the top of this file). */
  ownsDialogs: boolean;
  /** A dialog the page waits on while the user has the browser. */
  dialog: PendingDialog | null;
  /** Fields in this document filled from the vault (backend node ids): masked for the agent. */
  filled: Set<number>;
}

interface PendingDialog {
  kind: "alert" | "confirm" | "prompt";
  message: string;
  /** Answers the page, once; a no-op once Electron cancelled the dialog (navigation, a crash). */
  answer(accept: boolean): void;
}

interface AgentWindow {
  agentId: string;
  window: BaseWindow;
  toolbar: WebContentsView;
  tabs: Tab[];
  activeId: number | null;
  nextTabId: number;
  control: "agent" | "user";
  request: string | null;
  /** Things to tell the agent with its next result: downloads, dialogs, new tabs, the user's turn. */
  notes: string[];
  /** The agent's calls run one at a time. */
  queue: Promise<unknown>;
  /** Calls waiting while the user has the browser. */
  waiters: Set<() => void>;
  /** Values filled from the vault while this window is open, blanked in everything the agent reads. Never logged. */
  vaultValues: Set<string>;
}

interface Call {
  cancelled: boolean;
  /** Wakes the call if it waits for the user. */
  wake: (() => void) | null;
  /** Ends the daemon's wait for the call at once. */
  interrupt: (error: Error) => void;
}

class BrowserError extends Error {}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim();

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BrowserError(message)), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error) => (clearTimeout(timer), reject(error)),
    );
  });
}

/** Chromium, without the app's and Electron's names, which some sites refuse. */
function chromeUserAgent(userAgent: string): string {
  const platform = /\(([^)]+)\)/.exec(userAgent)?.[1] ?? "Windows NT 10.0; Win64; x64";
  const chrome = /Chrome\/[\d.]+/.exec(userAgent)?.[0] ?? "Chrome/140.0.0.0";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) ${chrome} Safari/537.36`;
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^[\s.]+|[\s.]+$/g, "").slice(0, 120);
  return cleaned.length > 0 && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(cleaned) ? cleaned : "download";
}

export class AgentBrowsers {
  private windows = new Map<string, AgentWindow>();
  private calls = new Map<string, Call>();
  /** Values of closed windows that were on the clipboard when they closed. Never logged. */
  private clipboardHeld = new Set<string>();
  private emitToolbar: EdgeEmitter<typeof agentBrowserToolbarEdge> | null = null;
  readonly session: Session;

  constructor(private readonly deps: AgentBrowserDeps) {
    this.session = sessions.fromPartition(AGENT_BROWSER_PARTITION);
  }

  /** Sets the profile's rules and serves the toolbars' edge; once, at startup. */
  install(): void {
    const session = this.session;
    session.setUserAgent(chromeUserAgent(session.getUserAgent()));
    session.setSpellCheckerEnabled(false);
    // Permission prompts (camera, microphone, location, notifications, …) are refused; main also
    // lists this session among those web-permissions.ts shuts out.
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.setDevicePermissionHandler(() => false);
    session.setDisplayMediaRequestHandler((_request, callback) => callback(null));
    session.on("select-hid-device", (event, _details, callback) => (event.preventDefault(), callback()));
    session.on("select-serial-port", (event, _ports, _contents, callback) => (event.preventDefault(), callback("")));
    session.on("select-usb-device", (event, _details, callback) => (event.preventDefault(), callback()));
    session.on("will-download", (event, item, contents) => {
      const owner = this.ownerOf(contents);
      if (owner == null) {
        event.preventDefault();
        return;
      }
      const name = safeFileName(item.getFilename());
      if (item.getTotalBytes() > DOWNLOAD_LIMIT) {
        event.preventDefault();
        owner.notes.push(`The page started downloading ${name}, which is over 1 GB, so it was refused.`);
        return;
      }
      const dir = join(this.deps.workspaceFor(owner.agentId), "downloads");
      mkdirSync(dir, { recursive: true });
      let path = join(dir, name);
      for (let n = 2; existsSync(path); n++) path = join(dir, name.replace(/(\.[^.]*)?$/, ` (${n})$1`));
      item.setSavePath(path);
      item.on("updated", () => {
        if (item.getReceivedBytes() > DOWNLOAD_LIMIT) item.cancel();
      });
      item.once("done", (_event, state) => {
        owner.notes.push(state === "completed" ? `Downloaded ${name} (${item.getReceivedBytes()} bytes) to ${path}.` : `The download of ${name} ${state === "cancelled" ? "was stopped" : "failed"}.`);
      });
    });

    const fromToolbar = (caller: string) => {
      const id = Number(caller.replace(/^webContents:/, ""));
      const win = [...this.windows.values()].find((candidate) => candidate.toolbar.webContents.id === id);
      if (win == null) throw new Error("This toolbar's window is gone.");
      return win;
    };
    const userOnly = (caller: string) => {
      const win = fromToolbar(caller);
      if (win.control !== "user") throw new Error("Take over first.");
      return win;
    };
    this.emitToolbar = serveEdge(
      agentBrowserToolbarEdge,
      {
        read: (_args, { caller }) => this.toolbarView(fromToolbar(caller)),
        answerDialog: ({ tabId, accept }, { caller }) => {
          const tab = fromToolbar(caller).tabs.find((candidate) => candidate.id === tabId);
          if (tab?.dialog == null) throw new Error("That dialog is gone.");
          tab.dialog.answer(accept);
        },
        takeOver: (_args, { caller }) => this.takeOver(fromToolbar(caller)),
        returnControl: (_args, { caller }) => this.returnControl(fromToolbar(caller)),
        showChat: (_args, { caller }) => this.deps.showChat(fromToolbar(caller).agentId),
        switchBrowserTab: ({ tabId }, { caller }) => this.activate(userOnly(caller), tabId),
        closeBrowserTab: ({ tabId }, { caller }) => this.closeBrowserTab(userOnly(caller), tabId),
        newTab: async (_args, { caller }) => {
          const win = userOnly(caller);
          this.activate(win, (await this.addTab(win)).id);
        },
        historyBack: (_args, { caller }) => this.activeTab(userOnly(caller))?.contents.navigationHistory.goBack(),
        goForward: (_args, { caller }) => this.activeTab(userOnly(caller))?.contents.navigationHistory.goForward(),
        reload: (_args, { caller }) => this.activeTab(userOnly(caller))?.contents.reload(),
        navigate: async ({ url }, { caller }) => {
          const win = userOnly(caller);
          const checked = checkBrowserUrl(url);
          if (!checked.ok) throw new Error(checked.reason);
          const tab = this.activeTab(win) ?? (await this.addTab(win));
          this.activate(win, tab.id);
          void tab.contents.loadURL(checked.url).catch(() => undefined);
        },
      },
      ipcServerTransport(
        this.deps.ipcMain,
        () => [...this.windows.values()].map((win) => win.toolbar.webContents),
        (event) => [...this.windows.values()].some((win) => event.senderFrame === win.toolbar.webContents.mainFrame),
      ),
      { onError: (method, error) => console.error(`agent-browser-toolbar ${method} failed:`, error) },
    );
  }

  state(agentId: string): AgentBrowserState {
    const win = this.windows.get(agentId);
    if (win == null) return { agentId, open: false, control: "agent", request: null, tabs: [] };
    return {
      agentId,
      open: true,
      control: win.control,
      request: win.request,
      tabs: win.tabs.map((tab) => ({ id: tab.id, title: tab.contents.getTitle(), url: tab.contents.getURL(), active: tab.id === win.activeId })),
    };
  }

  /** The user opened the agent's browser from the app: up front, with a tab to sign in to sites in. */
  async show(agentId: string): Promise<AgentBrowserState> {
    const win = this.ensureWindow(agentId);
    if (win.tabs.length === 0) this.activate(win, (await this.addTab(win)).id);
    this.bringUp(win);
    return this.state(agentId);
  }

  /** Up front with the page focused, ready to type in (focusing the window alone focuses its toolbar). */
  private bringUp(win: AgentWindow): void {
    if (win.window.isMinimized()) win.window.restore();
    win.window.show();
    win.window.focus();
    const focusPage = () => {
      const tab = this.activeTab(win);
      if (tab != null && !tab.contents.isDestroyed()) tab.contents.focus();
    };
    focusPage();
    // A toolbar that's still loading takes the focus when it's ready; the page takes it back.
    setTimeout(focusPage, 150);
    if (win.toolbar.webContents.isLoading()) win.toolbar.webContents.once("did-finish-load", () => setTimeout(focusPage, 50));
  }

  closeAll(): void {
    for (const win of [...this.windows.values()]) win.window.close();
  }

  /**
   * The roster changed: a deleted agent's window closes, and the others take a new name. An empty
   * roster is skipped, as the coordinator has one before it reaches the box; so the last agent's
   * window stays until the user closes it.
   */
  rosterChanged(agentIds: string[]): void {
    if (agentIds.length === 0) return;
    const present = new Set(agentIds);
    for (const win of [...this.windows.values()]) {
      if (!present.has(win.agentId)) win.window.close();
      else if (win.window.getTitle() !== this.title(win.agentId, win.control)) this.changed(win);
    }
  }

  // ---- calls from the daemon -----------------------------------------------------------------

  async plan(call: { agentId: string; tool: BrowserToolName; args: Record<string, unknown> }): Promise<BrowserPlanInfo> {
    const win = this.windows.get(call.agentId);
    const tab = win != null ? this.activeTab(win) : null;
    const info: BrowserPlanInfo = { open: win != null, url: tab != null ? tab.contents.getURL() || null : null, control: win?.control ?? "agent", target: null };
    try {
      if (call.tool === "browser_click" || call.tool === "browser_type") {
        if (tab == null) throw new BrowserError("The agent browser has no page open. Open one with browser_navigate first.");
        info.target = await this.describe(tab, String(call.args.ref ?? ""));
      } else if (call.tool === "browser_press") {
        // Refused before anyone is asked: no card for a key that would take a vault value out.
        const chord = parseKeyChord(String(call.args.key ?? ""));
        if (win != null && chord != null) await this.guardClipboard(win, chord);
        if (tab != null) info.target = await this.focused(tab);
      }
    } catch (error) {
      throw win != null ? this.scrubbedError(win, error) : error;
    }
    // What the approval card shows goes to the box too: a page repeating a vault value doesn't put it there.
    if (win != null && win.vaultValues.size > 0) {
      const scrub = (text: string) => scrubValues(text, win.vaultValues);
      if (info.url != null) info.url = scrub(info.url);
      if (info.target != null) info.target = { ...info.target, name: scrub(info.target.name), href: scrub(info.target.href) };
    }
    return info;
  }

  async run(call: { agentId: string; tool: BrowserToolName; args: Record<string, unknown>; expectSite: string | null; callId: string; answer: string | null }): Promise<BrowserRunReply> {
    let interrupt!: (error: Error) => void;
    const interrupted = new Promise<never>((_resolve, reject) => (interrupt = reject));
    interrupted.catch(() => undefined);
    const token: Call = { cancelled: false, wake: null, interrupt };
    this.calls.set(call.callId, token);
    try {
      if (call.tool === "browser_wait_for_user") {
        const reply = await this.waitForUser(call.agentId, String(call.args.reason ?? ""), call.answer);
        const owner = this.windows.get(call.agentId);
        return owner != null ? this.scrubbed(owner, reply) : reply;
      }
      // Only opening a page opens the window; anything else needs one already.
      const opens = call.tool === "browser_navigate" || (call.tool === "browser_tabs" && call.args.action === "new");
      const win = opens ? this.ensureWindow(call.agentId, false) : this.windows.get(call.agentId);
      if (win == null) throw new BrowserError("The agent browser has no page open. Open one with browser_navigate.");
      const task = win.queue.then(() => this.execute(win, call, token));
      win.queue = task.catch(() => undefined);
      return this.scrubbed(win, await Promise.race([task, interrupted]));
    } catch (error) {
      // An error can quote the page too (an element's name).
      const owner = this.windows.get(call.agentId);
      throw owner != null ? this.scrubbedError(owner, error) : error;
    } finally {
      this.calls.delete(call.callId);
    }
  }

  /** A reply with the window's vault values blanked, wherever the page put them. */
  private scrubbed(win: AgentWindow, reply: BrowserRunReply): BrowserRunReply {
    if (win.vaultValues.size === 0) return reply;
    const scrub = (text: string) => scrubValues(text, win.vaultValues);
    return { ...reply, output: scrub(reply.output), askUser: reply.askUser != null ? { ...reply.askUser, question: scrub(reply.askUser.question) } : reply.askUser };
  }

  private scrubbedError(win: AgentWindow, error: unknown): unknown {
    if (win.vaultValues.size > 0 && error instanceof Error) error.message = scrubValues(error.message, win.vaultValues);
    return error;
  }

  /** Every vault value the agent browser holds: each window's, and closed windows' the clipboard still held. */
  private allVaultValues(): Set<string> {
    const values = new Set(this.clipboardHeld);
    for (const win of this.windows.values()) for (const value of win.vaultValues) values.add(value);
    return values;
  }

  /**
   * Copying or cutting (any chord for it, wherever the focus is: a shadow root, a frame) while the
   * window holds vault values, or pasting while the clipboard holds one, would take a value out of
   * the page. A copy the page makes itself (a site's own Copy button) is caught at the other end:
   * read_clipboard blanks the values, and pasting one is refused.
   */
  private async guardClipboard(win: AgentWindow, chord: KeyChord): Promise<void> {
    const use = clipboardChord(chord);
    if (use === "copy" || use === "cut") {
      if (win.vaultValues.size > 0) throw new BrowserError(`${chord.label} would ${use} from the page, and this window holds values filled from the vault, so it isn't pressed.`);
    } else if (use === "paste") {
      const values = this.allVaultValues();
      if (values.size > 0 && holdsValue(await clipboard.readText(), values)) throw new BrowserError(`The clipboard holds a value from the vault, so ${chord.label} isn't pressed.`);
    }
  }

  /** The clipboard's text as read_clipboard gives it: vault values the agent browser holds are blanked. */
  scrubClipboard(text: string): string {
    // A closed window's values are kept only while the clipboard still has them.
    for (const value of this.clipboardHeld) if (!holdsValue(text, [value])) this.clipboardHeld.delete(value);
    return scrubClipboard(text, this.allVaultValues());
  }

  cancel(callId: string): void {
    const token = this.calls.get(callId);
    if (token == null) return;
    token.cancelled = true;
    token.wake?.();
    token.interrupt(new BrowserError("interrupted"));
  }

  /**
   * The trusted filler the vault uses (src/main/vault.ts): the page's real origin, the fields behind
   * refs, and filling values into them without them passing through the daemon, the box, the
   * transcript or the model. No edge the daemon or a box can call reaches it; the vault decides
   * what may be filled where. Values are neither logged nor returned.
   */
  vault(): VaultBrowser {
    return {
      page: async (agentId) => {
        const win = this.windows.get(agentId);
        const tab = win != null ? this.activeTab(win) : null;
        return tab != null ? await this.realPage(tab) : null;
      },
      fields: async (agentId, refs) => {
        const win = this.windows.get(agentId);
        const tab = win != null ? this.activeTab(win) : null;
        const found = new Map<string, VaultField>();
        if (win == null || tab == null) return found;
        for (const ref of refs) {
          if (tab.refs.get(ref) == null) continue;
          const backendNodeId = this.backendId(tab, ref);
          const field = { ...(await this.describe(tab, ref)), ...(await this.fieldHome(tab, backendNodeId)) };
          // A field's label is the page's, and goes on the card: a page repeating a value doesn't put it there.
          found.set(ref, { ...field, name: scrubValues(field.name, win.vaultValues), href: scrubValues(field.href, win.vaultValues) });
        }
        return found;
      },
      fill: (agentId, fills, options) => this.fillFromVault(agentId, fills, options),
      scrub: (agentId, text) => {
        const win = this.windows.get(agentId);
        return win != null ? scrubValues(text, win.vaultValues) : text;
      },
    };
  }

  /** The page as the DevTools protocol has it: its site only when the frame's URL, its origin and Electron's address agree. */
  private async realPage(tab: Tab): Promise<{ url: string; site: string | null }> {
    const { frameTree } = await this.cdp<{ frameTree: { frame: { url: string; urlFragment?: string; securityOrigin?: string } } }>(tab, "Page.getFrameTree");
    const url = `${frameTree.frame.url}${frameTree.frame.urlFragment ?? ""}`;
    const site = siteOf(url);
    return { url, site: site != null && site === frameTree.frame.securityOrigin && site === siteOf(tab.contents.getURL()) ? site : null };
  }

  /** Whether the element is in the page's own document (not a frame's) and that document's origin. */
  private async fieldHome(tab: Tab, backendNodeId: number): Promise<{ inPage: boolean; origin: string }> {
    // A ref in a same-origin frame is never the page's own field. The check runs in the main
    // frame's isolated world, where an element of another frame doesn't resolve.
    if (tab.refs.frameOf(backendNodeId) != null) return { inPage: false, origin: "" };
    const home = (await this.callOn(tab, backendNodeId, FIELD_HOME, [], [], null).catch(() => null)) as { inPage?: boolean; origin?: string } | null;
    return { inPage: home?.inPage === true, origin: String(home?.origin ?? "") };
  }

  private async fillFromVault(agentId: string, fills: VaultFill[], options: { site: string; submit: boolean; callId: string; stillOn(url: string): boolean }): ReturnType<VaultBrowser["fill"]> {
    const win = this.windows.get(agentId);
    if (win == null) return { filled: 0, submitted: false, navigated: false, error: "the agent has no browser open." };
    let interrupt!: (error: Error) => void;
    const interrupted = new Promise<never>((_resolve, reject) => (interrupt = reject));
    interrupted.catch(() => undefined);
    const token: Call = { cancelled: false, wake: null, interrupt };
    this.calls.set(options.callId, token);
    let filled = 0;
    let submitted = false;
    let navigated = false;
    const task = win.queue.then(async () => {
      await this.agentTurn(win, token);
      const tab = this.requireTab(win);
      const documents = tab.documents;
      let last: number | null = null;
      for (const fill of fills) {
        // Each field is checked again just before its value goes in: the page may have moved on.
        const page = await this.realPage(tab);
        if (tab.documents !== documents || page.site !== options.site || !options.stillOn(page.url)) throw new BrowserError(`the page isn't on ${siteLabel(options.site)} any more.`);
        const backendNodeId = this.backendId(tab, fill.ref);
        const target = await this.inspect(tab, backendNodeId);
        const home = await this.fieldHome(tab, backendNodeId);
        if (!home.inPage || home.origin !== options.site) throw new BrowserError(`${fill.ref} is in a frame from another site now.`);
        const password = target.inputType === "password" || /\b(current|new)-password\b/.test(target.autocomplete);
        const secret = sensitiveField(target);
        if (!fillable(target) || password !== fill.password || secret === "payment card" || secret === "one-time code") {
          throw new BrowserError(`${fill.ref} isn't the kind of field it was when you were asked.`);
        }
        if (token.cancelled) throw new BrowserError("interrupted");
        // Marked before the value goes in, and left marked if the call fails: a value that landed
        // while the protocol's answer timed out stays masked.
        tab.filled.add(backendNodeId);
        win.vaultValues.add(fill.value);
        if (target.tag === "select") {
          if ((await this.callOn(tab, backendNodeId, CHOOSE_EXACT, [fill.value])) !== true) {
            // No option is the value: the dropdown didn't change.
            tab.filled.delete(backendNodeId);
            continue;
          }
        } else {
          await this.replaceText(tab, backendNodeId, fill.value);
        }
        last = backendNodeId;
        filled++;
      }
      if (options.submit && last != null) {
        await this.cdp(tab, "DOM.focus", { backendNodeId: last });
        await this.press(tab, parseKeyChord("Enter")!);
        submitted = true;
        await this.settle(tab);
        navigated = tab.documents !== documents;
      }
    });
    win.queue = task.catch(() => undefined);
    try {
      await Promise.race([task, interrupted]);
      return { filled, submitted, navigated, error: null };
    } catch (error) {
      const message = error instanceof BrowserError ? error.message : "the page didn't take the value.";
      return { filled, submitted, navigated, error: message === "interrupted" ? "interrupted." : message };
    } finally {
      this.calls.delete(options.callId);
    }
  }

  // ---- windows and tabs -------------------------------------------------------------------------

  private ensureWindow(agentId: string, focus = true): AgentWindow {
    const existing = this.windows.get(agentId);
    if (existing != null) return existing;
    // Where this agent's window was last, if a screen still shows that place.
    const placed = placeWindow(
      this.deps.windowBounds.get(agentId),
      screen.getAllDisplays().map((display) => display.workArea),
      WINDOW_SIZE,
    );
    const window = new BaseWindow({
      ...(placed.x != null && placed.y != null ? { x: placed.x, y: placed.y } : {}),
      width: placed.width,
      height: placed.height,
      minWidth: WINDOW_SIZE.minWidth,
      minHeight: WINDOW_SIZE.minHeight,
      title: this.title(agentId, "agent"),
      show: false,
      backgroundColor: "#ffffff",
      icon: join(this.deps.distDir, "assets", "app-icon.png"),
    });
    // No menu: no developer tools, reload or zoom shortcuts the agent's pages could be mistaken for.
    window.setMenu(null);
    const toolbar = new WebContentsView({ webPreferences: { preload: join(this.deps.distDir, "preload", "agent-browser-preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    toolbar.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    toolbar.webContents.on("will-navigate", (event) => event.preventDefault());
    window.contentView.addChildView(toolbar);
    void toolbar.webContents.loadFile(join(this.deps.distDir, "renderer", "agent-browser", "toolbar.html"));
    const win: AgentWindow = { agentId, window, toolbar, tabs: [], activeId: null, nextTabId: 1, control: "agent", request: null, notes: [], queue: Promise.resolve(), waiters: new Set(), vaultValues: new Set() };
    this.windows.set(agentId, win);
    window.on("resize", () => this.layout(win));
    window.on("closed", () => this.closed(win));
    // Its size and place are remembered as the user leaves them. Maximizing on Windows takes the
    // focus, so a window the agent opens shows unmaximized, and keeps the user's choice for later.
    let maximized = placed.maximized;
    const remember = () => {
      if (!window.isDestroyed() && !window.isMinimized()) this.deps.windowBounds.set(agentId, { bounds: window.getNormalBounds(), maximized });
    };
    for (const name of ["resize", "move"] as const) window.on(name as "resize", remember);
    window.on("close", () => (remember(), this.deps.windowBounds.saveNow()));
    window.on("maximize", () => ((maximized = true), remember()));
    window.on("unmaximize", () => ((maximized = false), remember()));
    this.layout(win);
    // The agent's window shows up without taking focus, so the user sees it browse.
    if (focus) {
      if (placed.maximized) window.maximize();
      window.show();
    } else window.showInactive();
    this.changed(win);
    return win;
  }

  private title(agentId: string, control: "agent" | "user"): string {
    return `${this.deps.agentName(agentId)} · Agent browser${control === "user" ? " · you're in control" : ""}`;
  }

  private layout(win: AgentWindow): void {
    const [width, height] = win.window.getContentSize();
    const top = TOOLBAR_HEIGHT + (this.activeTab(win)?.dialog != null ? DIALOG_ROW_HEIGHT : 0);
    win.toolbar.setBounds({ x: 0, y: 0, width, height: top });
    for (const tab of win.tabs) {
      const active = tab.id === win.activeId;
      tab.view.setVisible(active);
      if (active) tab.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
    }
  }

  private closed(win: AgentWindow): void {
    if (this.windows.get(win.agentId) !== win) return;
    this.windows.delete(win.agentId);
    // Its values go, except those on the clipboard now: read_clipboard blanks them while they're there.
    if (win.vaultValues.size > 0) {
      for (const value of win.vaultValues) this.clipboardHeld.add(value);
      win.vaultValues.clear();
      void clipboard
        .readText()
        .then((text) => this.scrubClipboard(text))
        .catch(() => undefined);
    }
    for (const tab of win.tabs) if (!tab.contents.isDestroyed()) tab.contents.close();
    if (!win.toolbar.webContents.isDestroyed()) win.toolbar.webContents.close();
    for (const wake of win.waiters) wake();
    win.waiters.clear();
    this.deps.onChange(this.state(win.agentId));
  }

  private activeTab(win: AgentWindow): Tab | null {
    return win.tabs.find((tab) => tab.id === win.activeId) ?? null;
  }

  private requireTab(win: AgentWindow): Tab {
    const tab = this.activeTab(win);
    if (tab == null) throw new BrowserError("The agent browser has no page open. Open one with browser_navigate.");
    return tab;
  }

  private activate(win: AgentWindow, tabId: number): void {
    if (!win.tabs.some((tab) => tab.id === tabId)) throw new BrowserError(`There's no tab ${tabId}. List them with browser_tabs.`);
    win.activeId = tabId;
    this.layout(win);
    this.changed(win);
  }

  private closeBrowserTab(win: AgentWindow, tabId: number): void {
    const tab = win.tabs.find((candidate) => candidate.id === tabId);
    if (tab == null) throw new BrowserError(`There's no tab ${tabId}. List them with browser_tabs.`);
    win.tabs = win.tabs.filter((candidate) => candidate !== tab);
    win.window.contentView.removeChildView(tab.view);
    if (!tab.contents.isDestroyed()) tab.contents.close();
    if (win.activeId === tabId) win.activeId = win.tabs[win.tabs.length - 1]?.id ?? null;
    this.layout(win);
    this.changed(win);
  }

  /** A new tab, or one for a page's new window (`adopt`, the contents Chromium made for it). */
  private async addTab(win: AgentWindow, adopt?: WebContents): Promise<Tab> {
    if (win.tabs.length >= MAX_TABS) throw new BrowserError(`The agent browser has ${MAX_TABS} tabs open; close one with browser_tabs first.`);
    const view =
      adopt != null
        ? new WebContentsView({ webContents: adopt })
        : new WebContentsView({ webPreferences: { partition: AGENT_BROWSER_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false, safeDialogs: true } });
    const tab: Tab = { id: win.nextTabId++, view, contents: view.webContents, refs: new RefTable(), worlds: new Map(), frameOwners: new Map(), documents: 0, ownsDialogs: false, dialog: null, filled: new Set() };
    win.tabs.push(tab);
    win.window.contentView.addChildView(view);
    this.wire(win, tab);
    this.layout(win);
    // The DevTools protocol needs a document to attach to.
    if (adopt == null) await tab.contents.loadURL("about:blank").catch(() => undefined);
    this.changed(win);
    return tab;
  }

  private wire(win: AgentWindow, tab: Tab): void {
    const contents = tab.contents;
    contents.setWindowOpenHandler(({ url }) => {
      const checked = url === "" || url === "about:blank" ? ({ ok: true } as const) : checkBrowserUrl(url);
      if (!checked.ok || win.tabs.length >= MAX_TABS) {
        win.notes.push(`The page tried to open a new window (${url.slice(0, 200)}); it was refused${checked.ok ? ` (${MAX_TABS} tabs are open)` : ""}.`);
        return { action: "deny" };
      }
      return {
        action: "allow",
        outlivesOpener: true,
        createWindow: (options) => {
          const adopted = (options as { webContents?: WebContents }).webContents;
          if (adopted == null) throw new Error("no contents for the new window");
          void this.addTab(win, adopted).then((popup) => {
            win.notes.push(`The page opened a new tab, tab ${popup.id}. Switch to it with browser_tabs.`);
            // The user, signing in, sees a sign-in popup at once; the agent switches when it's ready.
            if (win.control === "user") this.activate(win, popup.id);
          });
          return adopted;
        },
      };
    });
    // Only web pages: no files, app or browser pages, or other apps' links, also when a page redirects.
    contents.on("will-frame-navigate", (event) => {
      const protocol = /^([a-z][a-z0-9+.-]*):/i.exec(event.url)?.[1]?.toLowerCase() ?? "";
      const allowed = event.isMainFrame ? ["http", "https"].includes(protocol) || event.url === "about:blank" : ["http", "https", "about", "data", "blob"].includes(protocol);
      if (!allowed) {
        event.preventDefault();
        win.notes.push(`The page tried to go to a ${protocol || "non-web"}: address; it was refused.`);
      }
    });
    contents.on("will-redirect", (event, url) => {
      if (!/^https?:/i.test(url)) event.preventDefault();
    });
    contents.on("did-navigate", () => {
      tab.refs.clear();
      tab.filled.clear();
      tab.worlds.clear();
      tab.frameOwners.clear();
      tab.documents++;
      this.changed(win);
    });
    for (const name of ["did-navigate-in-page", "page-title-updated", "did-start-loading", "did-stop-loading"] as const) contents.on(name as "did-stop-loading", () => this.changed(win));
    contents.on("render-process-gone", () => {
      tab.refs.clear();
      tab.worlds.clear();
      win.notes.push(`The page in tab ${tab.id} crashed; open it again with browser_navigate.`);
    });
    contents.debugger.on("detach", () => {
      tab.worlds.clear();
    });
    // A frame that navigates (a sign-in frame moving to its password step) takes its world with it.
    contents.debugger.on("message", (_event, method, params) => forgetFrameWorld(tab.worlds, method, params));
    this.takeDialogs(win, tab);
    contents.debugger.on("message", (_event, method, params) => {
      if (method !== "Page.javascriptDialogOpening" || tab.ownsDialogs || win.control === "user") return;
      // A confirm guards something the user should decide; the agent's turn dismisses it and says so.
      const accept = params.type === "alert" || params.type === "beforeunload";
      void contents.debugger.sendCommand("Page.handleJavaScriptDialog", { accept }).catch(() => undefined);
      win.notes.push(
        params.type === "confirm" || params.type === "prompt"
          ? `The page asked (a ${params.type} dialog): “${clean(params.message).slice(0, 300)}”. It was dismissed; if it should be accepted, ask the user to do it with browser_wait_for_user.`
          : `The page showed a message: “${clean(params.message).slice(0, 300)}”.`,
      );
    });
  }

  /** Replaces Electron's native alert and confirm boxes for this tab with ours (see the top of this file). */
  private takeDialogs(win: AgentWindow, tab: Tab): void {
    const events = tab.contents as unknown as NodeJS.EventEmitter;
    if (events.listenerCount("-run-dialog") === 0) return;
    events.removeAllListeners("-run-dialog");
    events.removeAllListeners("-cancel-dialogs");
    tab.ownsDialogs = true;
    let current: { settled: boolean } | null = null;
    events.on("-run-dialog", (info: { dialogType?: string; messageText?: string }, callback: (accept: boolean, text: string) => void) => {
      const state = { settled: false };
      current = state;
      const kind = info.dialogType === "confirm" || info.dialogType === "prompt" ? info.dialogType : "alert";
      const message = String(info.messageText ?? "").slice(0, 2_000);
      const answer = (accept: boolean) => {
        // Electron's callback after it cancelled the dialog (or twice) takes the app down.
        if (state.settled || tab.contents.isDestroyed()) return;
        state.settled = true;
        if (tab.dialog?.answer === answer) tab.dialog = null;
        callback(accept, "");
        this.layout(win);
        this.changed(win);
      };
      if (win.control === "agent") return this.answerForAgent(win, { kind, message, answer });
      tab.dialog = { kind, message, answer };
      // The user sees it at once: its tab comes forward, and the window flashes if it's behind.
      if (win.activeId !== tab.id) win.activeId = tab.id;
      if (!win.window.isFocused()) win.window.flashFrame(true);
      this.layout(win);
      this.changed(win);
    });
    events.on("-cancel-dialogs", () => {
      if (current != null) current.settled = true;
      if (tab.dialog == null) return;
      tab.dialog = null;
      this.layout(win);
      this.changed(win);
    });
  }

  /** The agent's turn: an alert is accepted, a confirm dismissed (the user decides those), and the agent is told. */
  private answerForAgent(win: AgentWindow, dialog: PendingDialog, when = ""): void {
    const message = clean(dialog.message).slice(0, 300);
    win.notes.push(
      dialog.kind === "alert"
        ? `The page showed a message${when}: “${message}”.`
        : `The page asked (a ${dialog.kind} dialog)${when}: “${message}”. It was dismissed; if it should be accepted, ask the user to do it with browser_wait_for_user.`,
    );
    dialog.answer(dialog.kind === "alert");
  }

  private ownerOf(contents: WebContents): AgentWindow | null {
    for (const win of this.windows.values()) if (win.tabs.some((tab) => tab.contents === contents)) return win;
    return null;
  }

  private changed(win: AgentWindow): void {
    if (this.windows.get(win.agentId) !== win) return;
    if (!win.window.isDestroyed()) win.window.setTitle(this.title(win.agentId, win.control));
    this.emitToolbar?.("changed", this.toolbarView(win));
    this.deps.onChange(this.state(win.agentId));
  }

  private toolbarView(win: AgentWindow): AgentBrowserToolbarView {
    const tab = this.activeTab(win);
    return {
      ...this.state(win.agentId),
      dialog: tab?.dialog != null ? { tabId: tab.id, kind: tab.dialog.kind, message: tab.dialog.message } : null,
      agentName: this.deps.agentName(win.agentId),
      canGoBack: tab?.contents.navigationHistory.canGoBack() ?? false,
      canGoForward: tab?.contents.navigationHistory.canGoForward() ?? false,
      loading: tab?.contents.isLoading() ?? false,
    };
  }

  // ---- control ----------------------------------------------------------------------------------

  private takeOver(win: AgentWindow): void {
    win.control = "user";
    this.activeTab(win)?.contents.focus();
    this.changed(win);
  }

  private returnControl(win: AgentWindow): void {
    if (win.control === "user") win.notes.push("The user had the browser and handed it back; the page may have changed. Take a snapshot.");
    // A dialog the user left open would hold up the agent's page: it's answered as the agent's turn would.
    for (const tab of win.tabs) if (tab.dialog != null) this.answerForAgent(win, tab.dialog, " while the user had the browser");
    win.control = "agent";
    win.request = null;
    for (const wake of win.waiters) wake();
    win.waiters.clear();
    this.changed(win);
  }

  /** Waits while the user has the browser. */
  private async agentTurn(win: AgentWindow, token: Call): Promise<void> {
    while (win.control === "user" && !token.cancelled && this.windows.get(win.agentId) === win) {
      await new Promise<void>((resolve) => {
        token.wake = resolve;
        win.waiters.add(resolve);
      });
      token.wake = null;
    }
    if (token.cancelled) throw new BrowserError("interrupted");
    if (this.windows.get(win.agentId) !== win) throw new BrowserError("The user closed the agent browser.");
  }

  /** browser_wait_for_user: first the hand-over (the chat then asks), then, with the answer, the hand-back. */
  private async waitForUser(agentId: string, reason: string, answer: string | null): Promise<BrowserRunReply> {
    if (answer == null) {
      const win = this.ensureWindow(agentId);
      if (win.tabs.length === 0) this.activate(win, (await this.addTab(win)).id);
      win.control = "user";
      win.request = clean(reason).slice(0, 300) || "Something only you can do";
      this.bringUp(win);
      this.changed(win);
      return {
        output: "Handed the browser to the user.",
        askUser: { question: `${win.request}: in my browser window, which is open on your screen. Select Done when you've finished.`, options: ["Done", "I can't now"] },
      };
    }
    const win = this.windows.get(agentId);
    const lead = `The user answered “${clean(answer).slice(0, 500)}”.`;
    if (win == null) return { output: `${lead} They closed the agent browser.` };
    if (win.control === "user") this.returnControl(win);
    win.notes = win.notes.filter((note) => !note.startsWith("The user had the browser"));
    const tab = this.activeTab(win);
    return { output: tab != null ? await this.pageReply(win, tab, lead, true) : `${lead} The agent browser has no page open.` };
  }

  // ---- running a call ---------------------------------------------------------------------------

  private async execute(win: AgentWindow, call: { tool: BrowserToolName; args: Record<string, unknown>; expectSite: string | null }, token: Call): Promise<BrowserRunReply> {
    await this.agentTurn(win, token);
    const args = call.args;
    const ensureSite = (tab: Tab) => {
      const site = siteOf(tab.contents.getURL());
      if (call.expectSite != null && site !== call.expectSite) {
        throw new BrowserError(`The page is on ${siteLabel(site)} now, not ${siteLabel(call.expectSite)} as when this was checked, so nothing was done. Take a snapshot and try again.`);
      }
    };

    switch (call.tool) {
      case "browser_navigate": {
        const checked = checkBrowserUrl(String(args.url ?? ""));
        if (!checked.ok) throw new BrowserError(checked.reason);
        let tab = args.new_tab === true ? null : this.activeTab(win);
        if (tab == null) {
          tab = await this.addTab(win);
          this.activate(win, tab.id);
        }
        const loaded = await this.load(tab, checked.url);
        return { output: await this.pageReply(win, tab, loaded, true) };
      }
      case "browser_snapshot": {
        const tab = this.requireTab(win);
        ensureSite(tab);
        const rootRef = typeof args.ref === "string" && args.ref.length > 0 ? args.ref : null;
        return { output: await this.pageReply(win, tab, rootRef != null ? `Part of the page (${rootRef}):` : "The page:", true, rootRef) };
      }
      case "browser_click": {
        const tab = this.requireTab(win);
        ensureSite(tab);
        const ref = String(args.ref ?? "");
        const backendNodeId = this.backendId(tab, ref);
        const before = tab.documents;
        const point = await this.clickPoint(tab, ref, backendNodeId);
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const) {
          await this.cdp(tab, "Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 });
        }
        await this.settle(tab);
        const navigated = tab.documents !== before;
        return { output: await this.pageReply(win, tab, navigated ? `Clicked ${ref}; the page changed:` : `Clicked ${ref}. Take a snapshot to see what changed.`, navigated) };
      }
      case "browser_type": {
        const tab = this.requireTab(win);
        ensureSite(tab);
        const ref = String(args.ref ?? "");
        const text = String(args.text ?? "");
        const target = await this.describe(tab, ref);
        if (!target.editable) throw new BrowserError(`${ref} (${target.role}${target.name ? ` “${target.name.slice(0, 60)}”` : ""}) isn't a field you can type into.`);
        const backendNodeId = this.backendId(tab, ref);
        let lead: string;
        if (target.tag === "select") {
          const chosen = await this.callOn(tab, backendNodeId, CHOOSE_OPTION, [text]);
          if (chosen == null) throw new BrowserError(`${ref} has no option “${text.slice(0, 60)}”. Its options are in the snapshot.`);
          lead = `Chose “${String(chosen).slice(0, 100)}” in ${ref}.`;
        } else {
          await this.replaceText(tab, backendNodeId, text);
          // What the agent typed over a vault value is its own.
          tab.filled.delete(backendNodeId);
          lead = `Typed ${[...text].length} characters into ${ref}.`;
        }
        if (args.submit === true) {
          const before = tab.documents;
          await this.press(tab, parseKeyChord("Enter")!);
          await this.settle(tab);
          const navigated = tab.documents !== before;
          return { output: await this.pageReply(win, tab, `${lead} Pressed Enter${navigated ? "; the page changed:" : ". Take a snapshot to see what changed."}`, navigated) };
        }
        return { output: await this.pageReply(win, tab, lead, false) };
      }
      case "browser_press": {
        const tab = this.requireTab(win);
        ensureSite(tab);
        const chord = parseKeyChord(String(args.key ?? ""));
        if (chord == null) throw new BrowserError(`Unknown key “${String(args.key ?? "").slice(0, 40)}”.`);
        // Checked again here: a fill may have come in since the call was planned.
        await this.guardClipboard(win, chord);
        const before = tab.documents;
        await this.press(tab, chord);
        await this.settle(tab);
        const navigated = tab.documents !== before;
        return { output: await this.pageReply(win, tab, navigated ? `Pressed ${chord.label}; the page changed:` : `Pressed ${chord.label}.`, navigated) };
      }
      case "browser_scroll": {
        const tab = this.requireTab(win);
        ensureSite(tab);
        if (typeof args.ref === "string" && args.ref.length > 0) {
          await this.cdp(tab, "DOM.scrollIntoViewIfNeeded", { backendNodeId: this.backendId(tab, args.ref) });
        } else {
          const metrics = await this.cdp<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>(tab, "Page.getLayoutMetrics");
          const { clientWidth: width, clientHeight: height } = metrics.cssLayoutViewport;
          const amount = Number(args.amount) > 0 ? Math.min(Number(args.amount), 100_000) : Math.round(height * 0.85);
          const direction = String(args.direction ?? "down");
          const [deltaX, deltaY] = direction === "up" ? [0, -amount] : direction === "left" ? [-amount, 0] : direction === "right" ? [amount, 0] : [0, amount];
          await this.cdp(tab, "Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.round(width / 2), y: Math.round(height / 2), deltaX, deltaY });
        }
        await delay(250);
        const position = await this.evaluate(tab, "({ y: Math.round(scrollY), height: document.documentElement.scrollHeight, view: innerHeight })");
        const where = position != null ? ` Now ${position.y} px down a page ${position.height} px long (a screen is ${position.view} px).` : "";
        return { output: await this.pageReply(win, tab, `Scrolled.${where} Take a snapshot or a screenshot to see it.`, false) };
      }
      case "browser_screenshot": {
        const tab = this.requireTab(win);
        ensureSite(tab);
        // A minimized or hidden window paints nothing, so it comes back on screen, without focus.
        if (win.window.isMinimized() || !win.window.isVisible()) {
          win.window.showInactive();
          await delay(400);
        }
        const shot = await this.cdp<{ data: string }>(tab, "Page.captureScreenshot", { format: "jpeg", quality: 80 }).catch(() => {
          throw new BrowserError("Couldn't capture the page. Is the agent browser window on screen?");
        });
        const covered = tab.filled.size > 0 || win.vaultValues.size > 0 ? await this.coverVaultValues(win, tab, shot.data) : { base64: shot.data, places: 0 };
        const lead = `A screenshot of tab ${tab.id}.${covered.places > 0 ? " What shows values from the vault (the filled fields, and anything else holding one) is painted over." : ""}`;
        return { output: await this.pageReply(win, tab, lead, false), image: { mime: "image/jpeg", base64: covered.base64 } };
      }
      case "browser_back": {
        const tab = this.requireTab(win);
        ensureSite(tab);
        if (!tab.contents.navigationHistory.canGoBack()) throw new BrowserError("There's no earlier page in this tab.");
        tab.contents.navigationHistory.goBack();
        await delay(150);
        await this.settle(tab);
        return { output: await this.pageReply(win, tab, "Went back:", true) };
      }
      case "browser_tabs": {
        const action = String(args.action ?? "list");
        if (action === "new") {
          const tab = await this.addTab(win);
          this.activate(win, tab.id);
          if (args.url == null) return { output: this.tabList(win, `Opened tab ${tab.id}.`) };
          const checked = checkBrowserUrl(String(args.url));
          if (!checked.ok) throw new BrowserError(checked.reason);
          return { output: await this.pageReply(win, tab, `Opened tab ${tab.id}. ${await this.load(tab, checked.url)}`, true) };
        }
        if (action === "select") {
          this.activate(win, Number(args.tab));
          return { output: await this.pageReply(win, this.requireTab(win), `Switched to tab ${Number(args.tab)}:`, true) };
        }
        if (action === "close") {
          this.closeBrowserTab(win, Number(args.tab));
          return { output: this.tabList(win, `Closed tab ${Number(args.tab)}.`) };
        }
        return { output: this.tabList(win, "") };
      }
      default:
        throw new BrowserError(`${call.tool} isn't a browser action.`);
    }
  }

  private tabList(win: AgentWindow, lead: string): string {
    const notes = win.notes.splice(0);
    const lines = win.tabs.map((tab) => `${tab.id === win.activeId ? "*" : " "} tab ${tab.id}: ${clean(tab.contents.getTitle()).slice(0, 120) || "(untitled)"} — ${tab.contents.getURL()}`);
    const body = lines.length > 0 ? `${lines.join("\n")}\n(* is the current tab)` : "No tabs are open.";
    return [lead, ...notes, untrustedPage({ url: "", title: "the agent browser's tabs" }, body)].filter((part) => part.length > 0).join("\n");
  }

  /** What a call tells the agent: the lead, any notes, and (with `snapshot`) the page itself. */
  private async pageReply(win: AgentWindow, tab: Tab, lead: string, snapshot: boolean, rootRef: string | null = null): Promise<string> {
    const page = { url: tab.contents.getURL(), title: tab.contents.getTitle() };
    let body = "";
    if (snapshot) {
      const { nodes } = await this.cdp<{ nodes: AXNode[] }>(tab, "Accessibility.getFullAXTree");
      const frames = await this.readFrames(tab, nodes);
      const all = [...nodes, ...[...frames.values()].flatMap((content) => ("nodes" in content ? content.nodes : []))];
      const fields = new Map<number, FieldInfo>();
      const wanted = all.filter((node) => node.backendDOMNodeId != null && needsFieldInfo(String(node.role?.value ?? ""))).slice(0, 300);
      await Promise.all(
        wanted.map(async (node) => {
          const described = await this.cdp<{ node: { localName: string; attributes?: string[] } }>(tab, "DOM.describeNode", { backendNodeId: node.backendDOMNodeId }).catch(() => null);
          if (described != null) fields.set(node.backendDOMNodeId!, fieldInfo(described.node));
        }),
      );
      body = renderSnapshot(nodes, tab.refs, { rootRef, pageUrl: page.url, fields, frames, filled: tab.filled }).text;
    }
    const notes = win.notes.splice(0);
    return [lead, ...notes, untrustedPage(page, body)].join("\n");
  }

  /**
   * What the page's frames hold, by their frame element: the tree of each frame from the page's own
   * origin (and of frames in those, a few levels down), and for any other frame where it's from.
   * Each frame's element is noted, so a click inside a frame isn't taken for one on its cover.
   */
  private async readFrames(tab: Tab, nodes: AXNode[]): Promise<Map<number, FrameContent>> {
    const frames = new Map<number, FrameContent>();
    tab.frameOwners.clear();
    const isFrame = (node: AXNode) => (node.role?.value === "Iframe" || node.role?.value === "IframePresentational") && node.backendDOMNodeId != null;
    if (!nodes.some(isFrame)) return frames;
    const tree = await this.frameTree(tab);
    const origin = tree.frames.get(tree.mainId)?.origin ?? "";
    let read = 0;
    const queue = [{ nodes, depth: 1 }];
    for (let next = queue.shift(); next != null; next = queue.shift()) {
      for (const node of next.nodes.filter(isFrame)) {
        const element = node.backendDOMNodeId!;
        if (frames.has(element)) continue;
        const described = await this.cdp<{ node: { frameId?: string; attributes?: string[] } }>(tab, "DOM.describeNode", { backendNodeId: element }).catch(() => null);
        const frameId = described?.node.frameId;
        const frame = frameId != null ? tree.frames.get(frameId) : undefined;
        if (frameId != null) tab.frameOwners.set(frameId, { owner: element, parent: frame?.parent ?? null });
        if (frameId == null || frame == null || origin === "" || origin === "null" || frame.origin !== origin) {
          const from = originOf(frame?.url ?? attribute(described?.node.attributes, "src"), tab.contents.getURL());
          frames.set(element, { unread: from != null ? `from ${from}: its contents aren't read` : "its contents aren't read" });
          continue;
        }
        const content = next.depth <= MAX_FRAME_DEPTH && read < MAX_FRAMES ? await this.cdp<{ nodes: AXNode[] }>(tab, "Accessibility.getFullAXTree", { frameId }).catch(() => null) : null;
        if (content == null) {
          frames.set(element, { unread: read >= MAX_FRAMES || next.depth > MAX_FRAME_DEPTH ? "its contents aren't read: the page has too many frames" : "its contents couldn't be read" });
          continue;
        }
        read++;
        frames.set(element, { frameId, nodes: content.nodes });
        queue.push({ nodes: content.nodes, depth: next.depth + 1 });
      }
    }
    return frames;
  }

  /** The page's frames by id: each one's origin and address, and the frame it's in. */
  private async frameTree(tab: Tab): Promise<{ mainId: string; frames: Map<string, { origin: string; url: string; parent: string | null }> }> {
    type Node = { frame: { id: string; url: string; securityOrigin?: string }; childFrames?: Node[] };
    const { frameTree } = await this.cdp<{ frameTree: Node }>(tab, "Page.getFrameTree");
    const frames = new Map<string, { origin: string; url: string; parent: string | null }>();
    const walk = (node: Node, parent: string | null) => {
      frames.set(node.frame.id, { origin: node.frame.securityOrigin ?? "", url: node.frame.url, parent });
      for (const child of node.childFrames ?? []) walk(child, node.frame.id);
    };
    walk(frameTree, null);
    return { mainId: frameTree.frame.id, frames };
  }

  /** Whether a frame is one of the page's own origin, whose elements the agent can read and act on. */
  private async sameOrigin(tab: Tab, frameId: string): Promise<boolean> {
    const tree = await this.frameTree(tab);
    const origin = tree.frames.get(tree.mainId)?.origin ?? "";
    return origin !== "" && origin !== "null" && tree.frames.get(frameId)?.origin === origin;
  }

  /** Loads a page; a slow one is reported, not waited for past 30 s. */
  private async load(tab: Tab, url: string): Promise<string> {
    try {
      await withTimeout(tab.contents.loadURL(url), LOAD_TIMEOUT_MS, "slow");
      return `Opened ${url}.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "slow") return `${url} is still loading after 30 seconds; what has loaded so far:`;
      // A redirect to a download or an aborted load still leaves a page (or the last one).
      if (/ERR_ABORTED/.test(message)) return `Loading ${url} stopped (it may have started a download).`;
      throw new BrowserError(`Couldn't open ${url}: ${message.replace(/^.*?(ERR_[A-Z_]+).*$/, "$1")}`);
    }
  }

  /** Waits for a navigation or load an action started, up to 10 s. */
  private async settle(tab: Tab): Promise<void> {
    await delay(200);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !tab.contents.isDestroyed() && tab.contents.isLoading()) await delay(100);
  }

  // ---- the DevTools protocol ----------------------------------------------------------------------

  private async cdp<T = any>(tab: Tab, method: string, params?: Record<string, unknown>): Promise<T> {
    if (tab.contents.isDestroyed()) throw new BrowserError("That tab is closed.");
    const debug = tab.contents.debugger;
    if (!debug.isAttached()) {
      if (tab.contents.getURL() === "") await tab.contents.loadURL("about:blank").catch(() => undefined);
      debug.attach("1.3");
      await debug.sendCommand("Page.enable");
    }
    return (await withTimeout(debug.sendCommand(method, params), CDP_TIMEOUT_MS, `The page didn't answer (${method}).`)) as T;
  }

  private backendId(tab: Tab, ref: string): number {
    const entry = tab.refs.get(ref);
    if (entry == null) throw new BrowserError(`${ref || "That"} isn't a ref on this page. Take a snapshot (browser_snapshot) first; refs from an earlier page don't carry over.`);
    return entry.backendNodeId;
  }

  /** Makes an isolated world in the page's document, or (`frameId`) in one of its same-origin frames; `inWorld` keeps it in `tab.worlds`. */
  private async createWorld(tab: Tab, frameId: string | null): Promise<number> {
    const target = frameId ?? (await this.cdp<{ frameTree: { frame: { id: string } } }>(tab, "Page.getFrameTree")).frameTree.frame.id;
    const { executionContextId } = await this.cdp<{ executionContextId: number }>(tab, "Page.createIsolatedWorld", { frameId: target, worldName: WORLD, grantUniveralAccess: false });
    return executionContextId;
  }

  /** Runs `run` in the frame's isolated world, making it again once if it went with its document. */
  private inWorld<T>(tab: Tab, frameId: string | null, run: (contextId: number) => Promise<T>): Promise<T> {
    return inWorld(tab.worlds, frameId, () => this.createWorld(tab, frameId), run);
  }

  /**
   * Runs `fn` on the element in the isolated world of its frame (the page's scripts can't reach or
   * change it); `others` are elements of the same frame, passed as arguments.
   */
  private async callOn(tab: Tab, backendNodeId: number, fn: string, args: unknown[] = [], others: number[] = [], frameId = tab.refs.frameOf(backendNodeId)): Promise<any> {
    try {
      return await this.inWorld(tab, frameId, async (executionContextId) => {
        const objects: string[] = [];
        try {
          for (const id of [backendNodeId, ...others]) objects.push((await this.cdp<{ object: { objectId: string } }>(tab, "DOM.resolveNode", { backendNodeId: id, executionContextId })).object.objectId);
          const result = await this.cdp<{ result: { value?: unknown }; exceptionDetails?: { text: string } }>(tab, "Runtime.callFunctionOn", {
            objectId: objects[0],
            functionDeclaration: fn,
            arguments: [...args.map((value) => ({ value })), ...objects.slice(1).map((objectId) => ({ objectId }))],
            returnByValue: true,
          });
          if (result.exceptionDetails != null) throw new BrowserError(result.exceptionDetails.text);
          return result.result.value;
        } finally {
          for (const objectId of objects) void this.cdp(tab, "Runtime.releaseObject", { objectId }).catch(() => undefined);
        }
      });
    } catch (error) {
      if (/No node|Could not find node|does not belong/i.test(String(error))) throw new BrowserError("That element is gone from the page. Take a new snapshot.");
      throw error;
    }
  }

  private async evaluate(tab: Tab, expression: string): Promise<any> {
    const result = await this.inWorld(tab, null, (contextId) => this.cdp<{ result: { value?: unknown } }>(tab, "Runtime.evaluate", { expression, contextId, returnByValue: true })).catch(() => null);
    return result?.result.value ?? null;
  }

  /** The element behind `ref` as the page has it now (its name may have changed since the snapshot). */
  private async describe(tab: Tab, ref: string): Promise<BrowserTarget> {
    const backendNodeId = this.backendId(tab, ref);
    return { ref, ...(await this.inspect(tab, backendNodeId)) };
  }

  /**
   * The focused element, for browser_press: inside an open shadow root, or a same-origin frame, when
   * the focus is there; null on the page itself. Throws when it can't be told, so a key press isn't
   * rated as if no field (a password field) had the focus.
   */
  private async focused(tab: Tab): Promise<BrowserTarget | null> {
    let frameId: string | null = null;
    for (let depth = 0; depth <= MAX_FRAME_DEPTH; depth++) {
      const { result }: { result: { objectId?: string } } = await this.inWorld(tab, frameId, (contextId) => this.cdp<{ result: { objectId?: string } }>(tab, "Runtime.evaluate", { expression: ACTIVE_ELEMENT, contextId })).catch(() => {
        throw new BrowserError("Couldn't tell which element has the focus. Take a snapshot and try again.");
      });
      if (result.objectId == null) return null;
      const { node }: { node: { backendNodeId: number; localName: string; frameId?: string } } = await this.cdp(tab, "DOM.describeNode", { objectId: result.objectId });
      void this.cdp(tab, "Runtime.releaseObject", { objectId: result.objectId }).catch(() => undefined);
      if (node.localName === "body" || node.localName === "html") return null;
      // A frame of the page's origin has the focus: the element focused in it.
      if ((node.localName === "iframe" || node.localName === "frame") && node.frameId != null && depth < MAX_FRAME_DEPTH && (await this.sameOrigin(tab, node.frameId))) {
        frameId = node.frameId;
        continue;
      }
      const target = await this.inspect(tab, node.backendNodeId, frameId);
      return { ref: tab.refs.refFor(node.backendNodeId, target.role, target.name, frameId), ...target };
    }
    return null;
  }

  private async inspect(tab: Tab, backendNodeId: number, frameId = tab.refs.frameOf(backendNodeId)): Promise<Omit<BrowserTarget, "ref">> {
    const described = await this.cdp<{ node: { localName: string; attributes?: string[] } }>(tab, "DOM.describeNode", { backendNodeId }).catch(() => {
      throw new BrowserError("That element is gone from the page. Take a new snapshot.");
    });
    const field = fieldInfo(described.node);
    const ax = await this.cdp<{ nodes: AXNode[] }>(tab, "Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false }).catch(() => ({ nodes: [] as AXNode[] }));
    const axNode = ax.nodes.find((node) => node.backendDOMNodeId === backendNodeId) ?? ax.nodes[0];
    const facts = ((await this.callOn(tab, backendNodeId, ELEMENT_FACTS, [], [], frameId)) ?? {}) as { submits?: boolean; editable?: boolean; href?: string };
    return {
      role: String(axNode?.role?.value ?? field.tag),
      name: clean(axNode?.name?.value),
      tag: field.tag,
      inputType: field.inputType,
      autocomplete: field.autocomplete,
      fieldName: field.fieldName,
      submits: facts.submits === true,
      editable: facts.editable === true,
      href: String(facts.href ?? ""),
    };
  }

  /** Where to click: the middle of the element on screen, if nothing covers it there. */
  private async clickPoint(tab: Tab, ref: string, backendNodeId: number): Promise<{ x: number; y: number }> {
    await this.cdp(tab, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => undefined);
    const { quads } = await this.cdp<{ quads: number[][] }>(tab, "DOM.getContentQuads", { backendNodeId }).catch(() => ({ quads: [] as number[][] }));
    const quad = quads.find((candidate) => Math.abs((candidate[4] - candidate[0]) * (candidate[5] - candidate[1])) > 1);
    if (quad == null) throw new BrowserError(`${ref} isn't visible on the page (it's hidden or has no size).`);
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    const hit = await this.cdp<{ backendNodeId: number }>(tab, "DOM.getNodeForLocation", { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: true }).catch(() => null);
    if (hit != null && hit.backendNodeId !== backendNodeId && !this.inFrameElement(tab, tab.refs.frameOf(backendNodeId), hit.backendNodeId)) {
      // An element in a frame can't be compared with one in another frame: that one covers it.
      const contains = this.callOn(tab, backendNodeId, CONTAINS, [], [hit.backendNodeId]);
      if ((await (tab.refs.frameOf(backendNodeId) != null ? contains.catch(() => false) : contains)) !== true) {
        throw new BrowserError(`${ref} is covered by something else at that spot (a dialog, banner or overlay?). Take a snapshot, deal with what covers it, and try again.`);
      }
    }
    return { x, y };
  }

  /**
   * Paints over, in a screenshot (JPEG, base64), the fields filled from the vault and anything else
   * on screen that holds one of the window's values: a field Back restored or a show-password toggle
   * swapped in, a pasted copy, the next page's "Signed in as …". Fails closed: a filled field that's
   * still on the page but can't be located, or a page that can't be checked, means no screenshot.
   */
  private async coverVaultValues(win: AgentWindow, tab: Tab, jpegBase64: string): Promise<{ base64: string; places: number }> {
    const failed = () => new BrowserError("Couldn't paint over what shows values from the vault, so no screenshot was taken. Take a snapshot instead.");
    const image = nativeImage.createFromBuffer(Buffer.from(jpegBase64, "base64"));
    if (image.isEmpty()) throw failed();
    const { width, height } = image.getSize();
    // Quads and the scan are in CSS pixels; the capture is in device pixels (zoom included).
    const ratio = Number(await this.evaluate(tab, "devicePixelRatio"));
    const scale = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    const regions: Region[] = [];
    let places = 0;
    for (const backendNodeId of tab.filled) {
      let quads: number[][];
      try {
        quads = (await this.cdp<{ quads: number[][] }>(tab, "DOM.getContentQuads", { backendNodeId })).quads;
      } catch (error) {
        // Gone from the page, or not laid out (hidden): nothing of it is on screen.
        if (/No node|Could not find node|not found|Could not compute/i.test(String(error))) continue;
        throw failed();
      }
      if (quads.length > 0) places++;
      for (const quad of quads) regions.push(quadRegion(quad, scale));
    }
    // What's on screen comes back to main and is matched here: no value goes into the page to look for it.
    const scan = (await this.inWorld(tab, null, (contextId) => this.cdp<{ result: { value?: ScreenScan }; exceptionDetails?: unknown }>(tab, "Runtime.evaluate", { expression: SCREEN_SCAN, contextId, returnByValue: true })).catch(() => null))?.result.value;
    if (scan == null || scan.truncated) throw failed();
    const found = valueRegions(scan, win.vaultValues);
    places += found.places;
    for (const region of found.regions) regions.push(scaleRegion(region, scale));
    if (regions.length === 0) return { base64: jpegBase64, places: 0 };
    try {
      const bitmap = image.toBitmap();
      coverRegions(bitmap, width, height, regions);
      return { base64: nativeImage.createFromBitmap(bitmap, { width, height }).toJPEG(80).toString("base64"), places };
    } catch {
      throw failed();
    }
  }

  /** Whether `element` is the frame element `frameId` is in, or one of the frames around that. */
  private inFrameElement(tab: Tab, frameId: string | null, element: number): boolean {
    for (let frame = frameId, depth = 0; frame != null && depth <= MAX_FRAME_DEPTH + 1; depth++) {
      const owner = tab.frameOwners.get(frame);
      if (owner == null) return false;
      if (owner.owner === element) return true;
      frame = owner.parent;
    }
    return false;
  }

  private async replaceText(tab: Tab, backendNodeId: number, text: string): Promise<void> {
    await this.cdp(tab, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => undefined);
    await this.cdp(tab, "DOM.focus", { backendNodeId });
    await this.callOn(tab, backendNodeId, SELECT_CONTENTS);
    if (text.length > 0) await this.cdp(tab, "Input.insertText", { text });
    else await this.press(tab, parseKeyChord("Backspace")!);
  }

  private async press(tab: Tab, chord: NonNullable<ReturnType<typeof parseKeyChord>>): Promise<void> {
    const base = { modifiers: chord.modifiers, key: chord.key, code: chord.code, windowsVirtualKeyCode: chord.keyCode, nativeVirtualKeyCode: chord.keyCode };
    await this.cdp(tab, "Input.dispatchKeyEvent", { type: chord.text.length > 0 ? "keyDown" : "rawKeyDown", ...base, ...(chord.text.length > 0 ? { text: chord.text, unmodifiedText: chord.text } : {}) });
    await this.cdp(tab, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
}

/** One attribute's value from DOM.describeNode's flat list (name, value, name, value, …). */
function attribute(list: string[] | undefined, name: string): string | null {
  for (let index = 0; list != null && index + 1 < list.length; index += 2) if (list[index].toLowerCase() === name) return list[index + 1];
  return null;
}

/** Where a frame the snapshot doesn't read is from: its address's origin (null for about:blank, data: and the like). */
function originOf(address: string | null | undefined, base: string): string | null {
  if (address == null || address.length === 0) return null;
  try {
    const url = new URL(address, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function fieldInfo(node: { localName: string; attributes?: string[] }): FieldInfo {
  const attributes = new Map<string, string>();
  const list = node.attributes ?? [];
  for (let index = 0; index + 1 < list.length; index += 2) attributes.set(list[index].toLowerCase(), list[index + 1]);
  return {
    tag: node.localName.toLowerCase(),
    inputType: (attributes.get("type") ?? "").toLowerCase(),
    autocomplete: (attributes.get("autocomplete") ?? "").toLowerCase(),
    fieldName: `${attributes.get("name") ?? ""} ${attributes.get("id") ?? ""}`.trim(),
  };
}

// What's on screen, for painting vault values over in a screenshot (a ScreenScan): what each field
// holds and each text node says, with their boxes in CSS pixels from the top left of the view, through
// open shadow roots and same-origin frames. Matching is main's: no value is passed into the page. A
// page with more text than the budget comes back `truncated`, and gets no screenshot.
const SCREEN_SCAN = `(() => {
  const out = { fields: [], texts: [], truncated: false };
  let budget = 500000;
  let nodes = 50000;
  const boxes = (list, dx, dy, view) => {
    const found = [];
    for (const rect of list) {
      if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= view.innerWidth || rect.top >= view.innerHeight) continue;
      found.push({ x: rect.left + dx, y: rect.top + dy, width: rect.width, height: rect.height });
    }
    return found;
  };
  const visit = (root, dx, dy, view, depth) => {
    const doc = root.ownerDocument || root;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node != null; node = walker.nextNode()) {
      if (--nodes < 0) { out.truncated = true; return; }
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue || "";
        if (text.trim().length === 0) continue;
        const range = doc.createRange();
        range.selectNodeContents(node);
        const rects = boxes(range.getClientRects(), dx, dy, view);
        if (rects.length === 0) continue;
        budget -= text.length;
        if (budget < 0) { out.truncated = true; return; }
        out.texts.push({ text, rects });
        continue;
      }
      if (node.shadowRoot != null) visit(node.shadowRoot, dx, dy, view, depth);
      if (out.truncated) return;
      const tag = node.localName;
      if (tag === "input" || tag === "textarea" || tag === "select") {
        const value = tag === "select" ? Array.from(node.selectedOptions || []).map((option) => option.label + "\\n" + option.value).join("\\n") : String(node.value || "");
        if (value.length === 0) continue;
        const rects = boxes(node.getClientRects(), dx, dy, view);
        if (rects.length === 0) continue;
        budget -= value.length;
        if (budget < 0) { out.truncated = true; return; }
        out.fields.push({ value, rects });
      } else if ((tag === "iframe" || tag === "frame") && depth < ${MAX_FRAME_DEPTH}) {
        let inner = null;
        try { inner = node.contentDocument; } catch (error) { inner = null; }
        if (inner == null || inner.defaultView == null) continue;
        const box = node.getBoundingClientRect();
        visit(inner, dx + box.left + node.clientLeft, dy + box.top + node.clientTop, inner.defaultView, depth + 1);
        if (out.truncated) return;
      }
    }
  };
  visit(document, 0, 0, window, 0);
  return out;
})()`;

// The focused element, through open shadow roots (an input in a web component focuses its host).
const ACTIVE_ELEMENT = `(() => {
  let element = document.activeElement;
  while (element != null && element.shadowRoot != null && element.shadowRoot.activeElement != null) element = element.shadowRoot.activeElement;
  return element;
})()`;

// Functions run on an element in the isolated world (`this` is the element).
const ELEMENT_FACTS = `function () {
  const tag = this.localName;
  const type = (this.getAttribute("type") || "").toLowerCase();
  const form = this.form || (this.closest ? this.closest("form") : null);
  const submits = form != null && ((tag === "button" && (type === "" || type === "submit")) || (tag === "input" && (type === "submit" || type === "image")));
  const noText = ["button", "submit", "reset", "checkbox", "radio", "file", "image", "hidden", "range", "color"];
  const editable = this.isContentEditable === true || tag === "textarea" || tag === "select" || (tag === "input" && !noText.includes(type || "text"));
  return { submits, editable, href: tag === "a" && typeof this.href === "string" ? this.href : "" };
}`;
const CONTAINS = `function (hit) {
  for (let node = hit; node != null; node = node.parentNode || node.host) if (node === this) return true;
  if (this.labels) for (const label of this.labels) if (label.contains(hit)) return true;
  return false;
}`;
const SELECT_CONTENTS = `function () {
  if (typeof this.select === "function" && this.localName !== "select") { this.select(); return; }
  const range = document.createRange();
  range.selectNodeContents(this);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}`;
// The vault's: where an element lives (run in the main frame's isolated world, where `document` is the page's).
const FIELD_HOME = `function () {
  const doc = this.ownerDocument;
  return { inPage: doc === document, origin: doc && doc.defaultView ? doc.defaultView.location.origin : "" };
}`;
// The vault's dropdown choice: only an option whose label or value is the value itself (no guessing).
const CHOOSE_EXACT = `function (text) {
  const want = String(text).trim().toLowerCase();
  const option = Array.from(this.options).find((o) => o.label.trim().toLowerCase() === want || o.value.trim().toLowerCase() === want);
  if (option == null) return false;
  this.value = option.value;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;
const CHOOSE_OPTION = `function (text) {
  const want = String(text).trim().toLowerCase();
  const options = Array.from(this.options);
  const option = options.find((o) => o.label.trim().toLowerCase() === want || o.value.toLowerCase() === want) || options.find((o) => o.label.toLowerCase().includes(want));
  if (option == null) return null;
  this.value = option.value;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return option.label;
}`;
