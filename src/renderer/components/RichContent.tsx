// Math and diagrams in messages. KaTeX (for $$…$$ and ```math, never single-dollar math) and
// Mermaid (for ```mermaid, securityLevel "strict") load on first use, so the main bundle stays
// small; until then, and when a formula or diagram doesn't parse, the source shows instead. Both follow the app's light or dark theme.
import { useEffect, useState } from "react";
import { Store, useStore } from "../store/store";
import { CodeBlock } from "./CodeBlock";
import { Icon } from "./icons";

/** Keeps `map` to its newest `limit` entries. */
function remember<V>(map: Map<string, V>, key: string, value: V, limit: number): V {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
  return value;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();

// ---- the theme, which the app sets on <html data-theme> -----------------------------------------

type Theme = "light" | "dark";
const readTheme = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
let themeStore: Store<Theme> | null = null;

export function useTheme(): Theme {
  if (themeStore == null) {
    const store = new Store<Theme>(readTheme());
    new MutationObserver(() => store.set(readTheme())).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    themeStore = store;
  }
  return useStore(themeStore);
}

// ---- math ------------------------------------------------------------------------------------

type Katex = typeof import("katex").default;
let katex: Katex | null = null;
let katexLoad: Promise<Katex> | null = null;
const formulas = new Map<string, { html: string } | { error: string }>();

function loadKatex(): Promise<Katex> {
  katexLoad ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([module]) => (katex = module.default));
  return katexLoad;
}

function renderFormula(engine: Katex, tex: string, display: boolean): { html: string } | { error: string } {
  const key = `${display ? "D" : "I"}${tex}`;
  const cached = formulas.get(key);
  if (cached != null) return cached;
  let result: { html: string } | { error: string };
  try {
    // trust stays off (no \href, \includegraphics or \html… commands); a parse error shows the source.
    result = { html: engine.renderToString(tex, { displayMode: display, throwOnError: true, strict: "ignore", output: "htmlAndMathml" }) };
  } catch (error) {
    result = { error: errorText(error) };
  }
  return remember(formulas, key, result, 200);
}

export function MathView({ tex, display }: { tex: string; display: boolean }) {
  const [engine, setEngine] = useState(katex);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (engine == null) void loadKatex().then(setEngine, () => setFailed(true));
  }, [engine]);
  const rendered = engine != null ? renderFormula(engine, tex, display) : null;
  if (rendered == null || "error" in rendered) {
    const title = rendered != null && "error" in rendered ? `This formula didn’t parse: ${rendered.error}` : failed ? "Math couldn’t be loaded." : undefined;
    return display ? (
      <pre className={`math-source math-source--display${rendered != null || failed ? " math-source--error" : ""}`} title={title}>
        {tex}
      </pre>
    ) : (
      <code className={`math-source${rendered != null || failed ? " math-source--error" : ""}`} title={title}>
        {tex}
      </code>
    );
  }
  return display ? <div className="math math--display" dangerouslySetInnerHTML={{ __html: rendered.html }} /> : <span className="math math--inline" dangerouslySetInnerHTML={{ __html: rendered.html }} />;
}

// ---- diagrams --------------------------------------------------------------------------------

type Mermaid = typeof import("mermaid").default;
let mermaidLoad: Promise<Mermaid> | null = null;
let mermaidTheme: Theme | null = null;
let queue: Promise<unknown> = Promise.resolve();
let diagramCount = 0;
const diagrams = new Map<string, string>();

const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;

/** Mermaid's "base" theme in the app's colors; Mermaid derives the rest of each palette from these. */
const THEME_VARIABLES: Record<Theme, Record<string, string | boolean>> = {
  light: {
    darkMode: false,
    background: "#ffffff",
    fontFamily: FONT,
    fontSize: "13px",
    primaryColor: "#e8f1fd",
    primaryBorderColor: "#7fb0ec",
    primaryTextColor: "#1c1c1c",
    secondaryColor: "#f1ecfd",
    secondaryBorderColor: "#b6a1ea",
    secondaryTextColor: "#1c1c1c",
    tertiaryColor: "#f5f5f5",
    tertiaryBorderColor: "#cfcfcf",
    tertiaryTextColor: "#1c1c1c",
    lineColor: "#7a7a7a",
    textColor: "#1c1c1c",
    noteBkgColor: "#fff6e0",
    noteBorderColor: "#e0b65a",
    noteTextColor: "#1c1c1c",
    edgeLabelBackground: "#ffffff",
    pie1: "#7fb0ec",
    pie2: "#b6a1ea",
    pie3: "#86cfa6",
    pie4: "#f1c46b",
    pie5: "#ef9d8f",
    pie6: "#8dd2dc",
    pie7: "#c9c9c9",
    pieStrokeColor: "#ffffff",
    pieOuterStrokeColor: "#d6d6d6",
    pieSectionTextColor: "#1c1c1c",
  },
  dark: {
    darkMode: true,
    background: "#161616",
    fontFamily: FONT,
    fontSize: "13px",
    primaryColor: "#1b2a40",
    primaryBorderColor: "#4d82c4",
    primaryTextColor: "#f5f5f5",
    secondaryColor: "#29213d",
    secondaryBorderColor: "#7d64c2",
    secondaryTextColor: "#f5f5f5",
    tertiaryColor: "#222222",
    tertiaryBorderColor: "#4a4a4a",
    tertiaryTextColor: "#f5f5f5",
    lineColor: "#a8a8a8",
    textColor: "#f5f5f5",
    noteBkgColor: "#3b3220",
    noteBorderColor: "#8a7034",
    noteTextColor: "#f5f5f5",
    edgeLabelBackground: "#161616",
    pie1: "#3f72b0",
    pie2: "#6d58ad",
    pie3: "#2f8a5f",
    pie4: "#a67d2a",
    pie5: "#a85a4e",
    pie6: "#2f8794",
    pie7: "#5a5a5a",
    pieStrokeColor: "#161616",
    pieOuterStrokeColor: "#4a4a4a",
    pieSectionTextColor: "#f5f5f5",
  },
};

/** One diagram at a time, each with the theme it's drawn in; the newest 64 drawings are kept. */
function drawDiagram(code: string, theme: Theme): Promise<string> {
  const key = `${theme}\n${code}`;
  const cached = diagrams.get(key);
  if (cached != null) return Promise.resolve(cached);
  const job = queue.then(async () => {
    mermaidLoad ??= import("mermaid").then((module) => module.default);
    const mermaid = await mermaidLoad;
    if (mermaidTheme !== theme) {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables: THEME_VARIABLES[theme], fontFamily: FONT, suppressErrorRendering: true });
      mermaidTheme = theme;
    }
    const id = `mermaid-diagram-${++diagramCount}`;
    try {
      const { svg } = await mermaid.render(id, code);
      return remember(diagrams, key, svg, 64);
    } finally {
      // Mermaid draws in a scratch element on <body>; a failed drawing can leave it behind.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = job.catch(() => undefined);
  return job;
}

/** A ```mermaid block: its source while the reply is still being written, then the drawing. */
export function MermaidDiagram({ code, streaming }: { code: string; streaming: boolean }) {
  const theme = useTheme();
  const [drawn, setDrawn] = useState<{ key: string; svg: string } | { key: string; error: string } | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState(false);
  const key = `${theme}\n${code}`;
  const current = drawn?.key === key ? drawn : diagrams.has(key) ? { key, svg: diagrams.get(key)! } : null;

  useEffect(() => {
    if (streaming || current != null) return;
    let cancelled = false;
    drawDiagram(code, theme).then(
      (svg) => !cancelled && setDrawn({ key, svg }),
      (error) => !cancelled && setDrawn({ key, error: (error instanceof Error ? error.message : String(error)).trim() }),
    );
    return () => {
      cancelled = true;
    };
  }, [key, streaming, current != null]);

  if (streaming || current == null || "error" in current || showCode) {
    return (
      <div className="diagram diagram--source">
        {current != null && "error" in current && !streaming ? (
          <div className="diagram__error" title={current.error.replace(/\s+/g, " ")}>
            Couldn’t draw this diagram: {current.error.split("\n")[0].replace(/:\s*$/, "")}
          </div>
        ) : null}
        {showCode ? (
          <button type="button" className="link-button diagram__back" onClick={() => setShowCode(false)}>
            Show the diagram
          </button>
        ) : null}
        <CodeBlock language="mermaid" code={code} plain />
      </div>
    );
  }
  return (
    <figure className="diagram">
      <div className="diagram__bar">
        <span>Diagram</span>
        <button type="button" className="icon-button icon-button--small" aria-label="Show the diagram’s code" title="Show the code" onClick={() => setShowCode(true)}>
          <Icon name="code" size={14} />
        </button>
        <button
          type="button"
          className="icon-button icon-button--small"
          aria-label="Copy the diagram’s code"
          title="Copy the code"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={14} />
        </button>
      </div>
      <div className="diagram__canvas" dangerouslySetInnerHTML={{ __html: current.svg }} />
    </figure>
  );
}
