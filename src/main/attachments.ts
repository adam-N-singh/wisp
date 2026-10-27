// Attachment staging and the `wisp-media://` protocol. Staged files are copied
// into the box's attachment store so the harness can read them; the protocol
// serves only files under that store (user attachments and tool screenshots).
// With a remote box, the coordinator uploads staged files when a prompt is sent
// and the protocol fetches the box's own files through its /media route.
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { type CustomScheme, net, protocol } from "electron";
import type { StagedAttachment } from "../shared/edges";
import { MAX_ATTACHMENT_BYTES, mimeFor, safeFileName } from "../shared/mime";

export { mimeFor };

export class AttachmentStore {
  readonly root: string;

  constructor(boxDataDir: string) {
    this.root = join(boxDataDir, "attachments");
  }

  private safeName(filename: string): string {
    return safeFileName(filename);
  }

  async stageBytes(filename: string, bytes: Uint8Array): Promise<StagedAttachment> {
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("Attachments are limited to 100 MB.");
    const id = randomUUID();
    const name = this.safeName(filename);
    const dir = join(this.root, id);
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, bytes);
    return { id, name, mime: mimeFor(name), bytes: bytes.byteLength, path };
  }

  async stagePath(filename: string, sourcePath: string): Promise<StagedAttachment> {
    const info = await stat(sourcePath);
    if (!info.isFile()) throw new Error("Only files can be attached.");
    if (info.size > MAX_ATTACHMENT_BYTES) throw new Error("Attachments are limited to 100 MB.");
    const id = randomUUID();
    const name = this.safeName(filename || basename(sourcePath));
    const dir = join(this.root, id);
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await copyFile(sourcePath, path);
    return { id, name, mime: mimeFor(name), bytes: info.size, path };
  }

  async discard(path: string): Promise<void> {
    if (!this.contains(path)) return;
    await rm(resolve(path, ".."), { recursive: true, force: true });
  }

  contains(path: string): boolean {
    const rel = relative(this.root, resolve(path));
    return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel);
  }
}

/** For main's one `protocol.registerSchemesAsPrivileged` call, before `app.ready`. */
export const MEDIA_SCHEME: CustomScheme = { scheme: "wisp-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } };

/**
 * `wisp-media://file/<encodeURIComponent(absolute path)>` -> that file, if inside the store; with a
 * remote box, any other path is one of the box's own files and is fetched from its /media route.
 */
export function handleMediaProtocol(store: AttachmentStore, remoteBox: () => { baseUrl: string; token: string } | null): void {
  protocol.handle("wisp-media", async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "file") return new Response("not found", { status: 404 });
    const path = decodeURIComponent(url.pathname.slice(1));
    if (!store.contains(path)) {
      const box = remoteBox();
      if (box == null) return new Response("forbidden", { status: 403 });
      const upstream = await net.fetch(`${box.baseUrl}/media?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${box.token}` } }).catch(() => null);
      if (upstream == null) return new Response("the box is unreachable", { status: 502 });
      if (!upstream.ok) return new Response("not found", { status: upstream.status === 403 ? 403 : 404 });
      return new Response(upstream.body, { status: 200, headers: { "content-type": mimeFor(path), "x-content-type-options": "nosniff", "cache-control": "private, max-age=3600" } });
    }
    const response = await net.fetch(pathToFileURL(path).href);
    const headers = new Headers(response.headers);
    headers.set("content-type", mimeFor(path));
    headers.set("x-content-type-options", "nosniff");
    headers.set("cache-control", "private, max-age=3600");
    return new Response(response.body, { status: response.status, headers });
  });
}
