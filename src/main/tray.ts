// Tray icon, shown on every platform, with three states: idle, working (an
// agent is running) and attention (an agent is waiting on the user).
import { join } from "node:path";
import { Menu, nativeImage, Tray } from "electron";
import { type AgentSummary, isAgentWorking } from "../shared/model";

export interface TrayActions {
  showMain(): void;
  openAgent(agentId: string): void;
  newAgent(): void;
  installUpdate(): void;
  quit(): void;
}

export class TrayController {
  private tray: Tray | null = null;
  private state: "idle" | "working" | "attention" = "idle";
  private agents: AgentSummary[] = [];
  private updateVersion: string | null = null;

  constructor(
    private readonly assetsDir: string,
    private readonly actions: TrayActions,
  ) {}

  create(): void {
    if (this.tray != null) return;
    this.tray = new Tray(this.icon("idle"));
    this.tray.setToolTip("Wisp");
    this.tray.on("click", () => this.actions.showMain());
    this.rebuildMenu();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  update(counts: { running: number; unread: number; awaiting: number }, agents: AgentSummary[]): void {
    this.agents = agents;
    const next = counts.awaiting > 0 ? "attention" : counts.running > 0 ? "working" : "idle";
    if (next !== this.state) {
      this.state = next;
      this.tray?.setImage(this.icon(next));
    }
    const parts = [counts.running > 0 ? `${counts.running} working` : "", counts.awaiting > 0 ? `${counts.awaiting} need${counts.awaiting === 1 ? "s" : ""} you` : "", counts.unread > 0 ? `${counts.unread} unread` : ""].filter(Boolean);
    this.tray?.setToolTip(parts.length > 0 ? `Wisp — ${parts.join(", ")}` : "Wisp");
    this.rebuildMenu();
  }

  /** A downloaded update waiting to install, or null. */
  setUpdate(version: string | null): void {
    if (version === this.updateVersion) return;
    this.updateVersion = version;
    this.rebuildMenu();
  }

  private icon(state: "idle" | "working" | "attention") {
    const file = state === "idle" ? "tray.png" : state === "working" ? "tray-working.png" : "tray-attention.png";
    return nativeImage.createFromPath(join(this.assetsDir, file));
  }

  private rebuildMenu(): void {
    if (this.tray == null) return;
    const rows = this.agents.filter((agent) => agent.isHiddenFromSidebar !== true).slice(0, 8);
    const label = (agent: AgentSummary) => {
      const status = agent.awaitingUserResponse != null ? "  — needs you" : isAgentWorking(agent) ? "  — working…" : agent.hasUnread ? "  •" : "";
      return `${agent.name}${status}`;
    };
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Wisp", click: () => this.actions.showMain() },
        { type: "separator" },
        ...(rows.length > 0 ? rows.map((agent) => ({ label: label(agent), click: () => this.actions.openAgent(agent.id) })) : [{ label: "No agents yet", enabled: false }]),
        { type: "separator" },
        { label: "New agent…", click: () => this.actions.newAgent() },
        ...(this.updateVersion != null ? [{ label: `Restart to update to ${this.updateVersion}`, click: () => this.actions.installUpdate() }] : []),
        { label: "Quit", click: () => this.actions.quit() },
      ]),
    );
  }
}
