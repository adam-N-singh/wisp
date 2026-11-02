// Web permissions. Only the app's own pages (files under dist/renderer) get any: the main window's
// top frame may capture audio, for dictation and voice memos, but never video; app pages may write
// to the clipboard and show notifications. A canvas on the page stage may lock the pointer (its frame's
// `allow-pointer-lock`): Chromium asks only from a click or key in it, and Esc lets the pointer go.
// Everything else is refused. The cloud computer's window,
// which shows a page from the internet (E2B's noVNC), has a session of its own that refuses all.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Session, WebContents } from "electron";
import { parseCanvasFrameUrl } from "../shared/canvas";

export interface PermissionAsk {
  permission: string;
  /** The page that asks. */
  url: string;
  /** For "media": what it wants to capture ("audio", "video"; "unknown" for some checks). */
  mediaTypes: string[];
  /** It asks from the main window's top frame. */
  mainWindowFrame: boolean;
  /** It asks from the main window, from any of its frames. */
  inMainWindow?: boolean;
}

/** Where the app's pages are: file URLs under this prefix. */
export const appPagePrefix = (distDir: string) => `${pathToFileURL(join(distDir, "renderer")).href}/`;

export function allowPermission(ask: PermissionAsk, appPrefix: string): boolean {
  // Electron names the frame that asks: only a canvas's own frame, in the main window, not a frame it made.
  if (ask.permission === "pointerLock") return ask.inMainWindow === true && !ask.mainWindowFrame && parseCanvasFrameUrl(ask.url) != null;
  if (!ask.url.startsWith(appPrefix)) return false;
  switch (ask.permission) {
    case "media":
      return ask.mainWindowFrame && ask.mediaTypes.length > 0 && ask.mediaTypes.every((type) => type === "audio");
    case "clipboard-sanitized-write":
    case "notifications":
      return true;
    default:
      return false;
  }
}

/** Applies the rules to the app's session, and shuts `others` (sessions showing outside pages) out completely. */
export function installWebPermissions(app: Session, others: Session[], options: { distDir: string; mainWindow: () => WebContents | null }): void {
  const prefix = appPagePrefix(options.distDir);
  const inMainWindow = (contents: WebContents | null) => contents != null && contents === options.mainWindow();
  const fromMainWindow = (contents: WebContents | null, isMainFrame: boolean | undefined) => inMainWindow(contents) && isMainFrame !== false;
  app.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = "mediaTypes" in details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    callback(allowPermission({ permission, url: details.requestingUrl ?? contents.getURL(), mediaTypes, mainWindowFrame: fromMainWindow(contents, details.isMainFrame), inMainWindow: inMainWindow(contents) }, prefix));
  });
  app.setPermissionCheckHandler((contents, permission, _origin, details) =>
    allowPermission(
      {
        permission,
        url: details.requestingUrl ?? contents?.getURL() ?? "",
        mediaTypes: details.mediaType != null ? [details.mediaType] : [],
        mainWindowFrame: fromMainWindow(contents, details.isMainFrame),
        inMainWindow: inMainWindow(contents),
      },
      prefix,
    ),
  );
  for (const session of others) {
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
  }
}
