// Archives the box reads marketplaces from: a .tar.gz downloaded to a file (GitHub's archive of a
// commit), read entry by entry. Only the files a caller asks for are read, everything else is
// skipped as it streams past, and limits stop an archive that is too large or unpacks to too much.
// Paths come back as the archive names them (pax and GNU long names included); writing them out
// safely is the caller's job (see safeRelativePath).
import { createReadStream, createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { createGunzip } from "node:zlib";

/** A download larger than this is refused. */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
/** Everything the archive unpacks to, read or skipped. */
const MAX_UNPACKED_BYTES = 768 * 1024 * 1024;
/** A wanted file larger than this is passed on as skipped. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

export class ArchiveError extends Error {}

/** Downloads `url` to `file` (redirects followed, at most MAX_ARCHIVE_BYTES); throws a message for the user. */
export async function downloadFile(url: string, file: string, describe: { notFound: string }): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000), headers: { "user-agent": "Wisp/0.1 (+desktop agent)" } });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new ArchiveError("The download didn’t finish within 3 minutes.");
    const cause = error instanceof Error ? (error.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
    throw new ArchiveError(`Couldn’t reach ${new URL(url).host} (${typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : String(error)}).`);
  }
  if (response.status === 404) throw new ArchiveError(describe.notFound);
  if (!response.ok || response.body == null) throw new ArchiveError(`${new URL(url).host} answered HTTP ${response.status}.`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_ARCHIVE_BYTES) throw new ArchiveError(`The archive is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MiB.`);
  const out = createWriteStream(file);
  let size = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > MAX_ARCHIVE_BYTES) throw new ArchiveError(`The archive is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MiB.`);
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
    }
  } finally {
    out.end();
    await finished(out).catch(() => undefined);
  }
}

/** Reads exactly as many bytes as asked from a stream of chunks. */
class Bytes {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly source: AsyncIterator<Buffer>) {}

  /** Exactly `count` bytes, or null if the stream ends first. */
  async take(count: number): Promise<Buffer | null> {
    while (this.size < count) {
      const next = await this.source.next();
      if (next.done) return null;
      this.chunks.push(next.value);
      this.size += next.value.length;
    }
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    this.chunks = all.length > count ? [all.subarray(count)] : [];
    this.size -= count;
    return all.subarray(0, count);
  }

  async skip(count: number): Promise<boolean> {
    for (let left = count; left > 0; ) {
      const step = Math.min(left, 1024 * 1024);
      if ((await this.take(step)) == null) return false;
      left -= step;
    }
    return true;
  }
}

const field = (block: Buffer, start: number, length: number) => block.toString("utf8", start, start + length).replace(/\0[\s\S]*$/, "");

/** A numeric header field: octal text, or base-256 when its first byte has the high bit set. */
function numeric(block: Buffer, start: number, length: number): number {
  if ((block[start] & 0x80) !== 0) {
    let value = block[start] & 0x7f;
    for (let index = start + 1; index < start + length; index++) value = value * 256 + block[index];
    return value;
  }
  const text = field(block, start, length).trim();
  return text.length === 0 ? 0 : Number.parseInt(text, 8);
}

/** Pax records: "<length> <key>=<value>\n", the length counting the whole record. */
function paxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const length = Number.parseInt(data.toString("utf8", offset, space), 10);
    if (!Number.isInteger(length) || length <= space - offset) break;
    const record = data.toString("utf8", space + 1, offset + length).replace(/\n$/, "");
    const equals = record.indexOf("=");
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

export interface TarFile {
  path: string;
  size: number;
}

/**
 * Reads a .tar.gz file: `wanted` picks the regular files whose contents `onFile` gets (null for
 * one larger than MAX_FILE_BYTES); links, devices and the rest are skipped. Returns the pax
 * global header's `comment`, where git (and so GitHub) writes the archive's commit.
 */
export async function readTarGz(file: string, wanted: (path: string) => boolean, onFile: (entry: TarFile, data: Buffer | null) => void): Promise<{ comment: string | null }> {
  const input = createReadStream(file);
  const source = createGunzip();
  input.on("error", (error) => source.destroy(error));
  input.pipe(source);
  const bytes = new Bytes(source[Symbol.asyncIterator]() as AsyncIterator<Buffer>);
  let unpacked = 0;
  let comment: string | null = null;
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  try {
    for (;;) {
      const header = await bytes.take(512);
      if (header == null || header.every((byte) => byte === 0)) break;
      let sum = 0;
      for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 0x20 : header[index];
      if (sum !== numeric(header, 148, 8)) throw new ArchiveError("The archive is damaged (a header’s checksum is wrong).");
      const size = numeric(header, 124, 12);
      const padded = Math.ceil(size / 512) * 512;
      unpacked += 512 + padded;
      if (unpacked > MAX_UNPACKED_BYTES) throw new ArchiveError(`The archive unpacks to more than ${MAX_UNPACKED_BYTES / 1024 / 1024} MiB.`);
      const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
      const body = async () => {
        if (size > MAX_FILE_BYTES) throw new ArchiveError("The archive has a header larger than the box reads.");
        const data = await bytes.take(size);
        if (data == null || !(await bytes.skip(padded - size))) throw new ArchiveError("The archive ends too early.");
        return data;
      };
      if (type === "g" || type === "x") {
        const records = paxRecords(await body());
        if (type === "g") comment = records.comment ?? comment;
        else pax = records;
        continue;
      }
      if (type === "L") {
        longName = (await body()).toString("utf8").replace(/\0[\s\S]*$/, "");
        continue;
      }
      if (type === "K") {
        await body(); // a long link target: links aren't unpacked
        continue;
      }
      const prefix = field(header, 257, 6) === "ustar" ? field(header, 345, 155) : "";
      const name = field(header, 0, 100);
      const path = pax.path ?? longName ?? (prefix.length > 0 ? `${prefix}/${name}` : name);
      pax = {};
      longName = null;
      const regular = type === "0" || type === "7";
      if (regular && wanted(path)) {
        if (size > MAX_FILE_BYTES) {
          if (!(await bytes.skip(padded))) throw new ArchiveError("The archive ends too early.");
          onFile({ path, size }, null);
        } else {
          onFile({ path, size }, await body());
        }
      } else if (!(await bytes.skip(padded))) {
        throw new ArchiveError("The archive ends too early.");
      }
    }
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError(`The archive couldn’t be read (${error instanceof Error ? error.message : String(error)}).`);
  } finally {
    // pipe() leaves the file open when the gunzip side stops early: close it, so Windows can delete the archive and its folder.
    source.destroy();
    if (!input.closed) {
      input.destroy();
      await new Promise<void>((resolve) => input.once("close", () => resolve()));
    }
  }
  return { comment };
}

/**
 * A path from an archive as segments to write under a folder, or null when it isn't one that is
 * safe to write anywhere: absolute, "..", a drive or stream name, characters Windows refuses, or a
 * device name.
 */
export function safeRelativePath(path: string): string[] | null {
  if (path.length === 0 || path.length > 400 || path.startsWith("/") || path.includes("\\")) return null;
  const segments = path.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (segment === ".." || /[<>:"|?*\u0000-\u001f]/.test(segment) || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(segment)) return null;
  }
  return segments;
}
