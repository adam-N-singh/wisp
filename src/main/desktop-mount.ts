// Desktop mount: an agent "mounted" on the desktop as a small always-on-top
// panel — its avatar, a hover preview of its latest message, a bot switcher,
// and a mini composer that can attach a capture of the screen. Also hosts the
// capture overlay (Alt+Shift+Space).
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BrowserWindow, desktopCapturer, globalShortcut, type IpcMain, screen } from "electron";
import type { EdgeEmitter } from "../shared/rpc/edge";
import { serveEdge } from "../shared/rpc/runtime";
import { ipcServerTransport } from "../shared/rpc/transports";
import { captureOverlayEdge, desktopMountEdge, type MountAgent, type MountView, type StagedAttachment } from "../shared/edges";
import { type AgentSummary, isAgentWorking } from "../shared/model";
import type { AttachmentStore } from "./attachments";
import type { SettingsStore } from "./settings";

const COLLAPSED = { width: 76, height: 76 };
const EXPANDED = { width: 380, height: 248 };
const CAPTURE_SHORTCUT = "Alt+Shift+Space";

export interface MountDeps {
  distDir: string;
  ipcMain: IpcMain;
  settings: SettingsStore;
  attachments: AttachmentStore;
  rosterAgents(): Promise<AgentSummary[]>;
  deliverMessage(args: { agentId: string; prompt: string; attachmentPaths: string[]; attachmentNames: string[] }): Promise<void>;
  showMainWindow(agentId?: string): void;
  onMountChanged(agentId: string | null): void;
}

export class DesktopMount {
  private panel: BrowserWindow | null = null;
  private overlay: BrowserWindow | null = null;
  private agents: AgentSummary[] = [];
  private staged: StagedAttachment[] = [];
  private expanded = false;
  private emitPanel: EdgeEmitter<typeof desktopMountEdge> | null = null;

  constructor(private readonly deps: MountDeps) {}

  /** Register both edges once; handlers resolve the current windows lazily. */
  install(): void {
    const panelTargets = () => (this.panel != null && !this.panel.isDestroyed() ? [this.panel.webContents] : []);
    this.emitPanel = serveEdge(
      desktopMountEdge,
      {
        read: () => this.view(),
        sendFromPanel: async ({ prompt }) => {
          const agentId = this.mountedId();
          if (agentId == null) return;
          if (prompt.trim().length === 0 && this.staged.length === 0) return;
          const staged = this.staged;
          this.staged = [];
          await this.deps.deliverMessage({ agentId, prompt, attachmentPaths: staged.map((a) => a.path), attachmentNames: staged.map((a) => a.name) });
          this.changeExpanded(false);
          this.push();
        },
        beginCapture: () => this.beginCapture(),
        dropStagedUpload: async ({ path }) => {
          this.staged = this.staged.filter((attachment) => attachment.path !== path);
          await this.deps.attachments.discard(path);
          this.push();
        },
        openAgentInPanel: ({ agentId }) => this.mount(agentId),
        detachPanel: () => this.unmount(),
        changeExpanded: ({ expanded }) => this.changeExpanded(expanded),
        dragPanel: ({ dx, dy }) => {
          if (this.panel == null) return;
          const [x, y] = this.panel.getPosition();
          this.panel.setPosition(Math.round(x + dx), Math.round(y + dy));
        },
        dropPanel: () => {
          if (this.panel == null) return;
          const [x, y] = this.panel.getPosition();
          const [width, height] = this.panel.getSize();
          this.deps.settings.update({ panelPosition: { x: x + width, y: y + height } });
        },
        openMainWindow: () => this.deps.showMainWindow(this.mountedId() ?? undefined),
      },
      ipcServerTransport(this.deps.ipcMain, panelTargets, (event) => this.panel != null && !this.panel.isDestroyed() && event.senderFrame === this.panel.webContents.mainFrame),
    );

    serveEdge(
      captureOverlayEdge,
      {
        overlayView: () => {
          const display = screen.getPrimaryDisplay();
          return { width: display.bounds.width, height: display.bounds.height, scaleFactor: display.scaleFactor };
        },
        chooseRegion: (region) => this.finishCapture(region),
        pickScreen: () => this.finishCapture(null),
        cancel: () => this.closeOverlay(true),
      },
      ipcServerTransport(
        this.deps.ipcMain,
        () => (this.overlay != null && !this.overlay.isDestroyed() ? [this.overlay.webContents] : []),
        (event) => this.overlay != null && !this.overlay.isDestroyed() && event.senderFrame === this.overlay.webContents.mainFrame,
      ),
    );

    const restored = this.deps.settings.get().mountedAgentId;
    if (restored != null) void this.refreshAgents().then(() => (this.agents.some((a) => a.id === restored) ? this.mount(restored) : this.unmount()));
  }

  mountedId(): string | null {
    return this.deps.settings.get().mountedAgentId;
  }

  async mount(agentId: string): Promise<void> {
    this.deps.settings.update({ mountedAgentId: agentId });
    await this.refreshAgents();
    this.ensurePanel();
    if (!globalShortcut.isRegistered(CAPTURE_SHORTCUT)) globalShortcut.register(CAPTURE_SHORTCUT, () => void this.beginCapture());
    this.deps.onMountChanged(agentId);
    this.push();
  }

  unmount(): void {
    this.deps.settings.update({ mountedAgentId: null });
    if (globalShortcut.isRegistered(CAPTURE_SHORTCUT)) globalShortcut.unregister(CAPTURE_SHORTCUT);
    this.panel?.destroy();
    this.panel = null;
    for (const attachment of this.staged) void this.deps.attachments.discard(attachment.path);
    this.staged = [];
    this.deps.onMountChanged(null);
  }

  /** Called when the roster changes so the panel's mark, preview and menu stay current. */
  async rosterChanged(): Promise<void> {
    if (this.panel == null) return;
    await this.refreshAgents();
    const mounted = this.mountedId();
    if (mounted != null && !this.agents.some((agent) => agent.id === mounted)) return this.unmount();
    this.push();
  }

  private async refreshAgents(): Promise<void> {
    try {
      this.agents = await this.deps.rosterAgents();
    } catch {
      // coordinator not ready; keep the last list
    }
  }

  private view(): MountView {
    const mountedId = this.mountedId();
    const mounted = this.agents.find((agent) => agent.id === mountedId) ?? null;
    const toMountAgent = (agent: AgentSummary): MountAgent => ({ id: agent.id, name: agent.name, avatarShape: agent.avatarShape, avatarColor: agent.avatarColor });
    return {
      agent: mounted != null ? toMountAgent(mounted) : null,
      preview: mounted?.awaitingUserResponse?.reasonCopy ?? mounted?.lastMessagePreview ?? (mounted?.lastEntry?.kind === "text" ? mounted.lastEntry.text : ""),
      isRunning: mounted != null && isAgentWorking(mounted),
      needsAttention: mounted?.awaitingUserResponse != null || (mounted?.hasUnread ?? false),
      agents: this.agents.filter((agent) => agent.isHiddenFromSidebar !== true).map(toMountAgent),
      staged: this.staged,
      expanded: this.expanded,
    };
  }

  private push(): void {
    this.emitPanel?.("changed", this.view());
  }

  private ensurePanel(): void {
    if (this.panel != null && !this.panel.isDestroyed()) return;
    const area = screen.getPrimaryDisplay().workArea;
    const anchor = this.deps.settings.get().panelPosition ?? { x: area.x + area.width - 24, y: area.y + area.height - 24 };
    this.panel = new BrowserWindow({
      x: anchor.x - COLLAPSED.width,
      y: anchor.y - COLLAPSED.height,
      ...COLLAPSED,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      webPreferences: { preload: join(this.deps.distDir, "preload", "panel-preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    this.panel.setAlwaysOnTop(true, "floating");
    this.panel.once("ready-to-show", () => this.panel?.showInactive());
    this.panel.on("closed", () => (this.panel = null));
    void this.panel.loadFile(join(this.deps.distDir, "renderer", "desktop-mount", "panel.html"));
  }

  private changeExpanded(expanded: boolean): void {
    this.expanded = expanded;
    if (this.panel == null) return;
    const [x, y] = this.panel.getPosition();
    const [width, height] = this.panel.getSize();
    const right = x + width;
    const bottom = y + height;
    const size = expanded ? EXPANDED : COLLAPSED;
    this.panel.setBounds({ x: right - size.width, y: bottom - size.height, ...size });
    if (expanded) this.panel.focus();
    this.push();
  }

  private async beginCapture(): Promise<void> {
    if (this.overlay != null || this.mountedId() == null) return;
    const display = screen.getPrimaryDisplay();
    this.panel?.hide();
    this.overlay = new BrowserWindow({
      ...display.bounds,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      fullscreenable: false,
      hasShadow: false,
      enableLargerThanScreen: true,
      webPreferences: { preload: join(this.deps.distDir, "preload", "overlay-preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    this.overlay.setAlwaysOnTop(true, "screen-saver");
    this.overlay.on("closed", () => (this.overlay = null));
    await this.overlay.loadFile(join(this.deps.distDir, "renderer", "desktop-mount", "overlay.html"));
    this.overlay.focus();
  }

  private closeOverlay(showPanel: boolean): void {
    this.overlay?.destroy();
    this.overlay = null;
    if (showPanel) this.panel?.showInactive();
  }

  private async finishCapture(region: { x: number; y: number; width: number; height: number } | null): Promise<void> {
    const display = screen.getPrimaryDisplay();
    this.overlay?.hide();
    await new Promise((resolve) => setTimeout(resolve, 180)); // let the overlay leave the screen
    try {
      const scale = display.scaleFactor;
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) } });
      const source = sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0];
      if (source == null) throw new Error("no screen source");
      let image = source.thumbnail;
      if (region != null) {
        const ratio = image.getSize().width / display.bounds.width;
        image = image.crop({ x: Math.round(region.x * ratio), y: Math.round(region.y * ratio), width: Math.max(1, Math.round(region.width * ratio)), height: Math.max(1, Math.round(region.height * ratio)) });
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const staged = await this.deps.attachments.stageBytes(`capture-${stamp}-${randomUUID().slice(0, 4)}.png`, image.toPNG());
      this.staged = [...this.staged, staged].slice(-6);
    } catch (error) {
      console.error("desktop capture failed", error);
    }
    this.closeOverlay(true);
    this.changeExpanded(true);
  }
}
