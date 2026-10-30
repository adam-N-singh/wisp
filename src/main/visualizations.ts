// The `wisp-visualization://` protocol that serves agent visualizations:
// the HTML fragment an agent showed (show_visualization), read from the box's attachment store, or
// through the /media route of a remote box, and served as a document of its own with a strict
// CSP. The transcript loads it in an iframe sandboxed to scripts only, so it runs with an opaque
// origin and can reach neither the app nor the network.
import { readFile } from "node:fs/promises";
import { type CustomScheme, net, protocol } from "electron";
import { VISUALIZATION_FRAME_CSP, visualizationDocument } from "../shared/visualization";
import type { AttachmentStore } from "./attachments";

export const VISUALIZATION_SCHEME: CustomScheme = { scheme: "wisp-visualization", privileges: { standard: true, secure: true } };

/** Only the box's visualization files, which it names by their content hash. */
const VISUALIZATION_FILE = /[\\/]visualizations[\\/][0-9a-f]{64}\.html$/;

/** `wisp-visualization://doc/<encodeURIComponent(path)>?theme=light|dark` -> the fragment at path, in its document. */
export function handleVisualizationProtocol(store: AttachmentStore, remoteBox: () => { baseUrl: string; token: string } | null): void {
  protocol.handle("wisp-visualization", async (request) => {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname.slice(1));
    if (url.hostname !== "doc" || !VISUALIZATION_FILE.test(path)) return new Response("not found", { status: 404 });
    let fragment: string | null;
    if (store.contains(path)) {
      fragment = await readFile(path, "utf8").catch(() => null);
    } else {
      const box = remoteBox();
      if (box == null) return new Response("forbidden", { status: 403 });
      const upstream = await net.fetch(`${box.baseUrl}/media?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${box.token}` } }).catch(() => null);
      if (upstream == null) return new Response("the box is unreachable", { status: 502 });
      fragment = upstream.ok ? await upstream.text() : null;
    }
    if (fragment == null) return new Response("not found", { status: 404 });
    const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
    return new Response(visualizationDocument(fragment, theme), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Sandboxed however it is opened, not only in the transcript's frame, with Trusted Types.
        "content-security-policy": VISUALIZATION_FRAME_CSP,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  });
}
