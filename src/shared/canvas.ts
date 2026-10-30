// Canvases: interactive HTML pages an agent writes (write_canvas) and the user opens on the page
// stage, in `wisp-canvas:` frames. Nothing compiles agent code, so a canvas is self-contained HTML
// (inline script and style), kept in the box with every revision like a document (src/box/pages.ts). Main serves it on
// `wisp-canvas://frame/store/<agentId>/<canvasId>?theme=…[&rev=…]` with these headers: a CSP
// sandbox (scripts and pointer lock only, so an opaque origin that reaches neither the app nor the
// network) and a permissions policy denying sensors, devices, payment and the clipboard.
//
// Links can't leave the frame on their own. The shell turns `window.open` and clicks on links into
// a message to the page, which asks main to open them (`openLinkFromCanvas`); main opens only http,
// https, mailto and tel links, and only within a second of a real click or key press.
import { TRUSTED_TYPES_CSP, TRUSTED_TYPES_DEFAULT_POLICY, VISUALIZATION_TOKENS } from "./visualization";

export const CANVAS_SCHEME_NAME = "wisp-canvas";

/**
 * What a canvas may do: run its own script and style, show inline images and fonts, lock the pointer;
 * nothing it loads or sends leaves the frame. CSP doesn't cover WebRTC: the main window's preload
 * takes it out of the frame (src/shared/frame-lockdown.ts), and Trusted Types keep `javascript:`
 * child frames, which the preload doesn't reach, from running (src/shared/visualization.ts).
 */
export const CANVAS_CSP = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; ${TRUSTED_TYPES_CSP}; sandbox allow-scripts allow-pointer-lock`;

/** The permissions policy's deny list for canvas frames. */
export const CANVAS_PERMISSIONS_POLICY = ["accelerometer", "camera", "geolocation", "gyroscope", "magnetometer", "microphone", "payment", "usb", "clipboard-read", "clipboard-write"]
  .map((feature) => `${feature}=()`)
  .join(", ");

/** The headers a canvas frame is served with. */
export const CANVAS_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": CANVAS_CSP,
  "permissions-policy": CANVAS_PERMISSIONS_POLICY,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};

/** What a canvas frame posts to the page to open a link. */
export const CANVAS_LINK_MESSAGE = "wisp-canvas:open-link";
/** The links a canvas may open, in the browser or the system's mail and phone apps. */
export const CANVAS_LINK_SCHEMES: readonly string[] = ["http:", "https:", "mailto:", "tel:"];
/** How long after a click or key press a canvas may open a link. */
export const CANVAS_GESTURE_MS = 1_000;

export type CanvasTheme = "light" | "dark";

/** The canvas's address, as write_canvas and read_canvas give it (the stage adds the theme and revision). */
export function canvasAddress(storeId: string, canvasId: string): string {
  return `${CANVAS_SCHEME_NAME}://frame/store/${encodeURIComponent(storeId)}/${encodeURIComponent(canvasId)}`;
}

/** The frame's URL: the canvas in a theme, at a revision or (without one) as it is now. */
export function canvasFrameUrl(storeId: string, canvasId: string, theme: CanvasTheme, rev?: number | null): string {
  return `${canvasAddress(storeId, canvasId)}?theme=${theme}${rev != null ? `&rev=${rev}` : ""}`;
}

export interface CanvasFrameRequest {
  storeId: string;
  canvasId: string;
  theme: CanvasTheme;
  rev: number | null;
}

/** A frame URL main serves, or null: the store form only, `theme` first and then an optional `rev`. */
export function parseCanvasFrameUrl(url: string): CanvasFrameRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${CANVAS_SCHEME_NAME}:` || parsed.hostname !== "frame" || parsed.hash.length > 0) return null;
  const parts = parsed.pathname.split("/");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "store") return null;
  const [storeId, canvasId] = [parts[2], parts[3]].map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "";
    }
  });
  if (!/^[\w-]+$/.test(storeId) || !/^[\w-]+$/.test(canvasId)) return null;
  const keys = [...parsed.searchParams.keys()];
  if (keys.length === 0 || keys.length > 2 || keys[0] !== "theme" || (keys.length === 2 && keys[1] !== "rev")) return null;
  const theme = parsed.searchParams.get("theme");
  if (theme !== "light" && theme !== "dark") return null;
  const rev = parsed.searchParams.get("rev");
  if (rev != null && !/^[1-9]\d{0,8}$/.test(rev)) return null;
  return { storeId, canvasId, theme, rev: rev != null ? Number(rev) : null };
}

/** The canvas id an address names (read_canvas takes either). */
export function canvasIdFromAddress(url: string): { storeId: string; canvasId: string } | null {
  const match = /^wisp-canvas:\/\/frame\/store\/([\w-]+)\/([\w-]+)(?:\?.*)?$/.exec(url.trim());
  return match != null ? { storeId: match[1], canvasId: match[2] } : null;
}

// Runs first in every canvas: links go to the page (and main), not out of the frame.
const LINK_GUARD = [
  "(function () {",
  `  function post(url) { try { parent.postMessage({ type: "${CANVAS_LINK_MESSAGE}", url: String(url) }, "*"); } catch (error) {} }`,
  "  function resolve(href) { try { return new URL(String(href), location.href); } catch (error) { return null; } }",
  "  window.open = function (href) { var url = href == null ? null : resolve(href); if (url != null) post(url.href); return null; };",
  // After the canvas's own handlers, which may have handled the click themselves.
  "  addEventListener('click', function (event) {",
  "    if (event.defaultPrevented || event.button !== 0) return;",
  "    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;",
  "    if (link == null) return;",
  "    var href = link.getAttribute('href') || '';",
  "    if (href.charAt(0) === '#' || /^\\s*javascript:/i.test(href)) return;",
  "    var url = resolve(href);",
  "    if (url == null) return;",
  "    event.preventDefault();",
  "    post(url.href);",
  "  });",
  "})();",
].join("\n");

/**
 * The document a canvas runs as: a shell with the theme (the `--viz-*` colors visualizations get,
 * `window.WispViz`, `data-theme` on <html>) and the link guard, then the agent's HTML. A whole
 * document parses into the shell: its <head> elements join the shell's head, after it, so its own
 * styles win, and its <body> is the body.
 */
export function canvasDocument(html: string, theme: CanvasTheme): string {
  const tokens = VISUALIZATION_TOKENS[theme];
  const variables = [
    `--viz-text: ${tokens.text}`,
    `--viz-muted: ${tokens.muted}`,
    `--viz-border: ${tokens.border}`,
    `--viz-surface: ${tokens.surface}`,
    `--viz-accent: ${tokens.accent}`,
    ...tokens.series.map((color, index) => `--viz-series-${index + 1}: ${color}`),
  ].join("; ");
  const wispViz = JSON.stringify({ theme, tokens: { text: tokens.text, muted: tokens.muted, border: tokens.border, surface: tokens.surface, accent: tokens.accent }, series: tokens.series });
  return [
    "<!doctype html>",
    `<html lang="en" data-theme="${theme}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>:root { color-scheme: ${theme}; ${variables}; } html, body { margin: 0; background: transparent; color: var(--viz-text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }</style>`,
    `<script>${TRUSTED_TYPES_DEFAULT_POLICY}\nwindow.WispViz = Object.freeze(${wispViz.replace(/</g, "\\u003c")});\n${LINK_GUARD}</script>`,
    "</head>",
    html,
  ].join("\n");
}

/** Whether main opens a link a canvas asked for. */
export type CanvasLinkVerdict = { open: true; url: string } | { open: false; reason: "no-canvas" | "no-gesture" | "scheme" | "invalid" };

/**
 * main's gate for links canvases ask for (`openLinkFromCanvas`): a canvas must be on the
 * page, the user must have clicked or pressed a key (not Esc, not held) in the last second, and the
 * link must be http, https, mailto or tel. A click opens one link: the gate spends it.
 */
export class CanvasLinkGate {
  private gestureAtMs: number | null = null;

  /** A trusted input event in the window; a mouse-up, or a key going down, counts as a gesture. */
  noteInput(input: { type: string; key?: string; isAutoRepeat?: boolean }, atMs = Date.now()): void {
    if (input.type === "mouseUp" || (input.type === "keyDown" && input.isAutoRepeat !== true && input.key !== "Escape")) this.gestureAtMs = atMs;
  }

  admit(url: string, canvasOnPage: boolean, nowMs = Date.now()): CanvasLinkVerdict {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { open: false, reason: "invalid" };
    }
    if (!CANVAS_LINK_SCHEMES.includes(parsed.protocol)) return { open: false, reason: "scheme" };
    if (!canvasOnPage) return { open: false, reason: "no-canvas" };
    if (this.gestureAtMs == null || nowMs - this.gestureAtMs > CANVAS_GESTURE_MS || nowMs < this.gestureAtMs) return { open: false, reason: "no-gesture" };
    this.gestureAtMs = null;
    return { open: true, url: parsed.href };
  }
}
