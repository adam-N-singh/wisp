// The `wisp-canvas://` protocol, the frames canvases run in:
// `wisp-canvas://frame/store/<agentId>/<canvasId>?theme=light|dark[&rev=<n>]`, the canvas's HTML read
// from the box over its token-guarded GET /pages/<agentId>/<canvasId> (the box on this PC and a box
// server alike), in its themed shell (src/shared/canvas.ts), with the frame headers. A revision
// never changes, so the last frames asked for by revision are kept; the newest is read each time.
// It answers 499 for a cancelled read, 404 when the read fails and 422 when what came back
// doesn't parse.
//
// Links a canvas asks for come through the page to `openLinkFromCanvas`; the gate here (CanvasLinkGate)
// hears the window's trusted input, which includes clicks and keys inside the canvas frame.
// Nothing here imports Electron at run time, so the unit tests drive it against a real box.
import type { CustomScheme, Protocol, WebContents } from "electron";
import { CANVAS_HEADERS, CANVAS_SCHEME_NAME, type CanvasLinkGate, canvasDocument, parseCanvasFrameUrl } from "../shared/canvas";
import { CANVAS_ID_PATTERN, type PageDocument } from "../shared/pages";

export const CANVAS_SCHEME: CustomScheme = { scheme: CANVAS_SCHEME_NAME, privileges: { standard: true, secure: true } };

/** Where the box answers, and its gateway token. */
export interface CanvasBox {
  baseUrl: string;
  token: string;
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

/** Revisioned frames kept, by box, canvas and revision. */
const KEPT_REVISIONS = 32;

const plain = (status: number, text: string) => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" } });

export class CanvasFrames {
  private readonly kept = new Map<string, string>();

  constructor(
    private readonly box: () => Promise<CanvasBox | null>,
    private readonly fetchPage: Fetch = (url, init) => fetch(url, init),
  ) {}

  /** The frame a `wisp-canvas://` request asks for. */
  async respond(url: string, signal?: AbortSignal): Promise<Response> {
    const frame = parseCanvasFrameUrl(url);
    if (frame == null || !CANVAS_ID_PATTERN.test(frame.canvasId)) return plain(404, "not found");
    const box = await this.box().catch(() => null);
    if (box == null) return plain(404, "the box isn't running");
    const key = frame.rev != null ? JSON.stringify([box.baseUrl, frame.storeId, frame.canvasId, frame.rev]) : null;
    let html = key != null ? this.kept.get(key) : undefined;
    if (html == null) {
      let upstream: Response;
      try {
        upstream = await this.fetchPage(`${box.baseUrl}/pages/${encodeURIComponent(frame.storeId)}/${encodeURIComponent(frame.canvasId)}${frame.rev != null ? `?rev=${frame.rev}` : ""}`, {
          headers: { authorization: `Bearer ${box.token}` },
          signal,
        });
      } catch {
        return signal?.aborted === true ? plain(499, "cancelled") : plain(404, "the box is unreachable");
      }
      if (!upstream.ok) return plain(404, "not found");
      let page: Partial<PageDocument> | null;
      try {
        page = (await upstream.json()) as Partial<PageDocument> | null;
      } catch {
        return signal?.aborted === true ? plain(499, "cancelled") : plain(422, "the box's answer doesn't parse");
      }
      if (page?.page?.kind !== "canvas" || typeof page.source !== "string") return plain(422, "the box's answer isn't a canvas");
      html = page.source;
    }
    if (key != null) {
      this.kept.delete(key);
      this.kept.set(key, html);
      for (const old of this.kept.keys()) {
        if (this.kept.size <= KEPT_REVISIONS) break;
        this.kept.delete(old);
      }
    }
    return new Response(canvasDocument(html, frame.theme), { status: 200, headers: { ...CANVAS_HEADERS } });
  }
}

export function handleCanvasProtocol(protocol: Protocol, frames: CanvasFrames): void {
  protocol.handle(CANVAS_SCHEME_NAME, (request) => frames.respond(request.url, request.signal));
}

/** The gate hears the window's trusted clicks and keys: these events come from the browser process, not the page. */
export function watchCanvasGestures(contents: WebContents, gate: CanvasLinkGate): void {
  contents.on("before-input-event", (_event, input) => gate.noteInput(input));
  contents.on("before-mouse-event", (_event, mouse) => gate.noteInput(mouse));
}

/** A canvas frame is on the window's page. */
export function canvasOnPage(contents: WebContents): boolean {
  try {
    return contents.mainFrame.framesInSubtree.some((frame) => frame.url.startsWith(`${CANVAS_SCHEME_NAME}://`));
  } catch {
    return false;
  }
}
