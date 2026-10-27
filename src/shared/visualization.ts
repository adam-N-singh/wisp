// Visualizations: an HTML fragment an agent writes (show_visualization) runs as its own document in
// a sandboxed iframe in the transcript. The document gets the frame's CSP, so it can run inline
// script and style but load nothing and reach nothing: no network, no other frames. It reports its
// height to the page, which sizes the frame, and it gets the app's colors for the current theme as
// CSS variables and `window.WispViz`.

/** The content security policy for visualization frames. */
export const VISUALIZATION_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'";

/** What a visualization frame posts to the page when its content's height changes. */
export const VISUALIZATION_HEIGHT_MESSAGE = "wisp-visualization:height";

/** Characters of HTML one visualization may hold (its tool call is replayed to the model with the conversation). */
export const MAX_VISUALIZATION_HTML = 256 * 1024;

/** The frame's height before the document reports one, and the bounds it is kept within. */
export const VISUALIZATION_HEIGHT = { initial: 360, min: 80, max: 1200 } as const;

export function clampVisualizationHeight(height: number): number {
  if (!Number.isFinite(height)) return VISUALIZATION_HEIGHT.initial;
  return Math.round(Math.min(VISUALIZATION_HEIGHT.max, Math.max(VISUALIZATION_HEIGHT.min, height)));
}

/** The app's colors as a visualization sees them: `--viz-<name>` CSS variables and `WispViz.tokens`. */
export const VISUALIZATION_TOKENS = {
  light: {
    text: "#1c1c1c",
    muted: "#1c1c1c8f",
    border: "#1c1c1c1f",
    surface: "#1c1c1c0a",
    accent: "#1680f3",
    series: ["#1680f3", "#7547d0", "#10ab61", "#da830e", "#e72e3b", "#008273"],
  },
  dark: {
    text: "#f5f5f5",
    muted: "#f5f5f58a",
    border: "#f5f5f51a",
    surface: "#f5f5f50a",
    accent: "#4d9bff",
    series: ["#4d9bff", "#a582ff", "#29cb78", "#e28600", "#ff6463", "#59c8b5"],
  },
} as const;

/** The document a fragment runs in: the theme's colors, a transparent page, and the height reporter. */
export function visualizationDocument(fragment: string, theme: "light" | "dark"): string {
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
    `<style>:root { color-scheme: ${theme}; ${variables}; } html, body { margin: 0; background: transparent; color: var(--viz-text); font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; } body { padding: 1px 0; overflow-x: auto; }</style>`,
    `<script>window.WispViz = Object.freeze(${wispViz.replace(/</g, "\\u003c")});`,
    // The body's height, which the page makes the frame's; a body sized to the frame (height: 100%) keeps it as it is.
    `(function () { var last = 0; function report() { var body = document.body; if (!body) return; var height = Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height)); if (height !== last) { last = height; parent.postMessage({ type: "${VISUALIZATION_HEIGHT_MESSAGE}", height: height }, "*"); } }`,
    "  addEventListener('DOMContentLoaded', function () { report(); if (typeof ResizeObserver === 'function') new ResizeObserver(report).observe(document.body); }); addEventListener('load', report); })();</script>",
    "</head>",
    "<body>",
    fragment,
    "</body>",
    "</html>",
  ].join("\n");
}
