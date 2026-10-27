// A visualization the agent showed (show_visualization): its title and summary, and the HTML
// fragment running in a frame sandboxed to scripts only, served by main's `wisp-visualization://`
// with a strict CSP (src/shared/visualization.ts). The frame reports its content's height,
// which the card takes, within bounds; it reloads in the other theme's colors when the theme changes.
import { useEffect, useRef, useState } from "react";
import type { VisualizationMessage } from "../../shared/model";
import { clampVisualizationHeight, VISUALIZATION_HEIGHT, VISUALIZATION_HEIGHT_MESSAGE } from "../../shared/visualization";
import { desktop } from "../bridge";
import { Icon } from "./icons";
import { useTheme } from "./RichContent";

export function VisualizationCard({ message }: { message: VisualizationMessage }) {
  const theme = useTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(() => clampVisualizationHeight(message.heightPx ?? VISUALIZATION_HEIGHT.initial));
  const [loaded, setLoaded] = useState(false);
  const src = desktop.local.visualizationUrl(message.path, theme);

  useEffect(() => {
    setLoaded(false);
    const onMessage = (event: MessageEvent) => {
      // Only this card's frame; its origin is opaque, so the window it posts from is what identifies it.
      if (event.source == null || event.source !== frame.current?.contentWindow) return;
      const data = event.data as { type?: unknown; height?: unknown } | null;
      if (data?.type === VISUALIZATION_HEIGHT_MESSAGE && typeof data.height === "number") setHeight(clampVisualizationHeight(data.height));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [src]);

  return (
    <figure className="viz-card">
      <figcaption className="viz-card__head">
        <Icon name="chart" size={14} />
        <span className="viz-card__title">{message.title}</span>
      </figcaption>
      {message.summary.length > 0 ? <p className="viz-card__summary">{message.summary}</p> : null}
      <iframe
        ref={frame}
        className={`viz-card__frame${loaded ? "" : " viz-card__frame--loading"}`}
        title={message.title}
        src={src}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
        style={{ height }}
        onLoad={() => setLoaded(true)}
      />
    </figure>
  );
}
