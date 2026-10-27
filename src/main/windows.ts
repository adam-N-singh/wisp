// Main window. Bounds persist in `window-state.json` as
// {version: 1, normalBounds: {x, y, width, height}, isMaximized}.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, nativeTheme, screen, shell } from "electron";
import { writeFileAtomic } from "./atomic-write";

interface WindowStateFile {
  version: 1;
  normalBounds: { x: number; y: number; width: number; height: number };
  isMaximized: boolean;
}

const DEFAULT_SIZE = { width: 1040, height: 760 };
export const TITLE_BAR_HEIGHT = 40;

export function overlayColors(dark: boolean) {
  return dark ? { color: "#00000000", symbolColor: "#e6e6e6", height: TITLE_BAR_HEIGHT } : { color: "#00000000", symbolColor: "#1f1f1f", height: TITLE_BAR_HEIGHT };
}

function readState(file: string): WindowStateFile | null {
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as WindowStateFile;
    if (state.version !== 1) return null;
    const { x, y, width, height } = state.normalBounds;
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      return x + width > area.x + 40 && x < area.x + area.width - 40 && y >= area.y - 10 && y < area.y + area.height - 40;
    });
    return visible ? state : { ...state, normalBounds: { ...state.normalBounds, x: Number.NaN, y: Number.NaN } };
  } catch {
    return null;
  }
}

export function createMainWindow(options: { userDataDir: string; distDir: string; spellCheck: boolean; dark: boolean }): BrowserWindow {
  const stateFile = join(options.userDataDir, "window-state.json");
  const saved = readState(stateFile);
  const bounds = saved?.normalBounds;
  const window = new BrowserWindow({
    ...(bounds != null && Number.isFinite(bounds.x) ? { x: bounds.x, y: bounds.y } : {}),
    width: bounds?.width ?? DEFAULT_SIZE.width,
    height: bounds?.height ?? DEFAULT_SIZE.height,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: "Wisp",
    backgroundColor: options.dark ? "#141414" : "#fafafa",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 14, y: 13 } } : { titleBarOverlay: overlayColors(options.dark) }),
    icon: join(options.distDir, "assets", "app-icon.png"),
    webPreferences: {
      preload: join(options.distDir, "preload", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: options.spellCheck,
      backgroundThrottling: false,
    },
  });
  if (saved?.isMaximized) window.maximize();

  window.once("ready-to-show", () => window.show());

  // Persist normal (un-maximized) bounds, debounced.
  let saveTimer: NodeJS.Timeout | null = null;
  const save = () => {
    if (saveTimer != null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (window.isDestroyed()) return;
      const state: WindowStateFile = { version: 1, normalBounds: window.getNormalBounds(), isMaximized: window.isMaximized() };
      void writeFileAtomic(stateFile, JSON.stringify(state, null, 2)).catch(() => undefined);
    }, 400);
  };
  for (const eventName of ["resize", "move", "maximize", "unmaximize"] as const) window.on(eventName as "resize", save);

  // Links open in the browser; the window itself never navigates away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(pathToFileURL(join(options.distDir, "renderer")).href)) event.preventDefault();
  });
  // Frames in the page (agents' visualizations) stay on their own scheme.
  window.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !event.url.startsWith("wisp-visualization://")) event.preventDefault();
  });

  void window.loadFile(join(options.distDir, "renderer", "index.html"));
  return window;
}

export function resolvedDark(preference: "system" | "light" | "dark"): boolean {
  return preference === "dark" || (preference === "system" && nativeTheme.shouldUseDarkColors);
}
