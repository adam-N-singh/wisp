// Web permissions. Only the app's own pages (files under dist/renderer) get any: the main window's
// top frame may capture audio, for dictation and voice memos, but never video; app pages may write
// to the clipboard and show notifications. Everything else is refused. The cloud computer's window,
// which shows a page from the internet (E2B's noVNC), has a session of its own that refuses all.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Session, WebContents } from "electron";

export interface PermissionAsk {
  permission: string;
  /** The page that asks. */
  url: string;
  /** For "media": what it wants to capture ("audio", "video"; "unknown" for some checks). */
  mediaTypes: string[];
  /** It asks from the main window's top frame. */
  mainWindowFrame: boolean;
}

/** Where the app's pages are: file URLs under this prefix. */
export const appPagePrefix = (distDir: string) => `${pathToFileURL(join(distDir, "renderer")).href}/`;

export function allowPermission(ask: PermissionAsk, appPrefix: string): boolean {
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
  const fromMainWindow = (contents: WebContents | null, isMainFrame: boolean | undefined) => contents != null && contents === options.mainWindow() && isMainFrame !== false;
  app.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = "mediaTypes" in details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    callback(allowPermission({ permission, url: details.requestingUrl ?? contents.getURL(), mediaTypes, mainWindowFrame: fromMainWindow(contents, details.isMainFrame) }, prefix));
  });
  app.setPermissionCheckHandler((contents, permission, _origin, details) =>
    allowPermission(
      { permission, url: details.requestingUrl ?? contents?.getURL() ?? "", mediaTypes: details.mediaType != null ? [details.mediaType] : [], mainWindowFrame: fromMainWindow(contents, details.isMainFrame) },
      prefix,
    ),
  );
  for (const session of others) {
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
  }
}
