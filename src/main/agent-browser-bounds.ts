// Where each agent's browser window was (agent-browser.ts): its size and place on screen, and
// whether it was maximized, so it opens there again, after a restart too. Kept in
// `agent-browser-windows.json` beside the main window's `window-state.json`:
// {version: 1, windows: {agentId: {bounds: {x, y, width, height}, maximized, savedAt}}}, the
// newest 200. A place no screen shows any more (a monitor unplugged) is dropped and the size kept,
// as for the main window. Electron-free, so it's unit-tested.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { replaceFileSync } from "../shared/replace-file";
import { writeFileAtomic } from "./atomic-write";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SavedWindow {
  /** Its normal (unmaximized) bounds. */
  bounds: Rect;
  maximized: boolean;
}

/** Where a window opens: a place only when a screen shows it, and a size that fits the largest screen. */
export interface Placement {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const MAX_WINDOWS = 200;
const SAVE_DELAY_MS = 400;

/** Whether enough of a window's top shows on a screen to grab it (the main window's rule, windows.ts). */
const onScreen = ({ x, y, width }: Rect, area: Rect) => x + width > area.x + 40 && x < area.x + area.width - 40 && y >= area.y - 10 && y < area.y + area.height - 40;

/** Where to open a window saved as `saved`, on screens whose work areas are `areas`. */
export function placeWindow(saved: SavedWindow | null, areas: Rect[], size: { width: number; height: number; minWidth: number; minHeight: number }): Placement {
  if (saved == null) return { width: size.width, height: size.height, maximized: false };
  const { x, y, width, height } = saved.bounds;
  const widest = Math.max(size.minWidth, ...areas.map((area) => area.width));
  const tallest = Math.max(size.minHeight, ...areas.map((area) => area.height));
  const fitted = { width: Math.round(Math.min(Math.max(width, size.minWidth), widest)), height: Math.round(Math.min(Math.max(height, size.minHeight), tallest)), maximized: saved.maximized };
  return areas.some((area) => onScreen({ x, y, width: fitted.width, height: fitted.height }, area)) ? { x: Math.round(x), y: Math.round(y), ...fitted } : fitted;
}

const isRect = (value: unknown): value is Rect =>
  typeof value === "object" && value !== null && ["x", "y", "width", "height"].every((key) => Number.isFinite((value as Record<string, unknown>)[key])) && (value as Rect).width > 0 && (value as Rect).height > 0;

export class AgentBrowserBounds {
  private windows = new Map<string, SavedWindow & { savedAt: number }>();
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {
    try {
      const read = JSON.parse(readFileSync(file, "utf8")) as { version?: number; windows?: Record<string, { bounds?: unknown; maximized?: unknown; savedAt?: unknown }> };
      if (read.version !== 1 || read.windows == null) return;
      for (const [agentId, saved] of Object.entries(read.windows)) {
        if (isRect(saved.bounds)) this.windows.set(agentId, { bounds: saved.bounds, maximized: saved.maximized === true, savedAt: Number(saved.savedAt) || 0 });
      }
    } catch {
      // none yet, or unreadable: windows open at the default size
    }
  }

  get(agentId: string): SavedWindow | null {
    const saved = this.windows.get(agentId);
    return saved != null ? { bounds: { ...saved.bounds }, maximized: saved.maximized } : null;
  }

  /** Remembers the window, written shortly after (a drag sends many moves). */
  set(agentId: string, saved: SavedWindow): void {
    if (!isRect(saved.bounds)) return;
    this.windows.delete(agentId);
    this.windows.set(agentId, { bounds: { ...saved.bounds }, maximized: saved.maximized, savedAt: Date.now() });
    // The oldest go first: the map keeps the order windows were last saved in.
    for (const oldest of this.windows.keys()) {
      if (this.windows.size <= MAX_WINDOWS) break;
      this.windows.delete(oldest);
    }
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
  }

  /** Writes what's waiting now; resolves once it's on disk. */
  flush(): Promise<void> {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
    const text = this.text();
    this.writing = this.writing.then(() => writeFileAtomic(this.file, text)).catch(() => undefined);
    return this.writing;
  }

  /** Writes what's waiting before returning: a window closing may be the app quitting, which wouldn't wait for a write. */
  saveNow(): void {
    if (this.timer == null) return;
    clearTimeout(this.timer);
    this.timer = null;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, this.text());
      replaceFileSync(temp, this.file);
    } catch {
      // the place isn't remembered this once
    }
  }

  private text(): string {
    return JSON.stringify({ version: 1, windows: Object.fromEntries(this.windows) }, null, 1);
  }
}
