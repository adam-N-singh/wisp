// Client for the box host's gateway: commands are `POST /api/<method>`, events
// arrive on one `GET /events` SSE stream.
//   - connect deadline 15 s; after 35 s without bytes the stream is probed with
//     POST /events/ping?nonce=…, and dropped unless `:echo <nonce>` arrives in 1.5 s
//   - reconnect backoff 1 s, 2 s, 4 s, 8 s, then 10 s
//   - /health is probed (1.5 s deadline) before commands unless the stream is
//     live or the last probe is under 5 s old
// A remote box (the user's own box server) is the same protocol over HTTPS; it
// can't read this PC's disk, so attachments are uploaded before a send, and a
// recording before it's transcribed. A voice memo is transcribed, then sent:
// its recording goes up once, and the send names the box's copy.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { EdgeCallFailure } from "../shared/rpc/edge";
import type { GatewayConnectionInfo } from "../shared/edges";
import { type GatewayErrorBody, type GatewayEventFrame, readSse } from "../shared/gateway-protocol";
import { isInside } from "../shared/paths";

export type GatewayConnection = GatewayConnectionInfo;

export interface GatewayClientOptions {
  resolveConnection(): Promise<GatewayConnection>;
  onEvent(channel: string, payload: unknown): void;
  onState(state: "connected" | "down"): void;
  log(line: string): void;
}

const CONNECT_DEADLINE_MS = 15_000;
const STALL_IDLE_MS = 35_000;
const ECHO_WAIT_MS = 1_500;
const HEALTH_DEADLINE_MS = 1_500;
const HEALTH_TTL_MS = 5_000;
const COMMAND_TIMEOUT_MS = 120_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000];
const UPLOADS_KEPT = 100;

export class GatewayClient {
  private connection: GatewayConnection | null = null;
  private live = false;
  private stopped = false;
  private lastHealthyAt = 0;
  private streamAbort: AbortController | null = null;
  private echoWaiters = new Map<string, () => void>();
  /** Staged files already uploaded to a remote box (its address and the file's path -> the box's path). */
  private uploads = new Map<string, string>();

  constructor(private readonly options: GatewayClientOptions) {}

  get isConnected(): boolean {
    return this.live;
  }

  start(): void {
    void this.eventLoop();
  }

  stop(): void {
    this.stopped = true;
    this.streamAbort?.abort();
  }

  async dispatchCommand<T = unknown>(method: string, args: unknown): Promise<T> {
    const connection = await this.ensureConnection();
    let response: Response;
    try {
      response = await fetch(`${connection.baseUrl}/api/${encodeURIComponent(method)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
        body: JSON.stringify(args ?? {}),
        signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
      });
    } catch (error) {
      this.connection = null;
      throw new EdgeCallFailure({ code: "gateway-unreachable", detail: error instanceof Error ? error.message : String(error) });
    }
    const text = await response.text();
    if (!response.ok) {
      let body: Partial<GatewayErrorBody> = {};
      try {
        body = JSON.parse(text);
      } catch {
        // non-JSON error body
      }
      if (response.status >= 500) this.lastHealthyAt = 0;
      throw new EdgeCallFailure({ code: body.failureCode ?? (response.status >= 500 ? "gateway-unreachable" : "gateway-command-failed"), detail: body.error ?? `HTTP ${response.status}` });
    }
    return (text.length === 0 ? null : JSON.parse(text)) as T;
  }

  /**
   * For a remote box: uploads each staged attachment (only files from `stagingRoot`, where main
   * stages them) and returns the arguments with the box's own paths. Unchanged for a local box.
   */
  async withUploadedAttachments<T extends { attachmentPaths?: string[]; attachmentNames?: string[] }>(args: T, stagingRoot: string): Promise<T> {
    const paths = args.attachmentPaths ?? [];
    if (paths.length === 0) return args;
    const connection = await this.ensureConnection();
    if (connection.remote !== true) return args;
    const uploaded: string[] = [];
    for (const [index, path] of paths.entries()) uploaded.push(await this.upload(connection, path, args.attachmentNames?.[index] ?? basename(path), stagingRoot, false));
    return { ...args, attachmentPaths: uploaded };
  }

  /**
   * For a remote box: uploads the recording a speechToText call names and returns the arguments
   * with the box's path. A kept recording (a voice memo) isn't uploaded again when it's sent.
   */
  async withUploadedRecording<T extends { attachmentPath?: string; discard?: boolean }>(args: T, stagingRoot: string): Promise<T> {
    if (args.attachmentPath == null) return args;
    const connection = await this.ensureConnection();
    if (connection.remote !== true) return args;
    return { ...args, attachmentPath: await this.upload(connection, args.attachmentPath, basename(args.attachmentPath), stagingRoot, args.discard !== true) };
  }

  /** Sends a file from `stagingRoot` (where main stages attachments) to the box; staged files never change, so one upload serves every later use. */
  private async upload(connection: GatewayConnection, path: string, name: string, stagingRoot: string, keep: boolean): Promise<string> {
    if (stagingRoot.length === 0 || !isInside(path, stagingRoot)) throw new EdgeCallFailure({ code: "send/attachment-refused", detail: "Only files attached in the app can be sent to the box." });
    const key = `${connection.baseUrl}\u0000${resolve(path)}`;
    const known = this.uploads.get(key);
    if (known != null) {
      this.uploads.delete(key);
      return known;
    }
    let response: Response;
    try {
      response = await fetch(`${connection.baseUrl}/attachments?name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/octet-stream" },
        body: new Uint8Array(await readFile(path)),
        signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
      });
    } catch (error) {
      throw new EdgeCallFailure({ code: "gateway-unreachable", detail: error instanceof Error ? error.message : String(error) });
    }
    if (!response.ok) throw new EdgeCallFailure({ code: "upload.failed", detail: `Sending ${name} to the box failed (HTTP ${response.status}).` });
    const boxPath = ((await response.json()) as { path: string }).path;
    if (keep) {
      this.uploads.set(key, boxPath);
      for (const stale of [...this.uploads.keys()].slice(0, Math.max(0, this.uploads.size - UPLOADS_KEPT))) this.uploads.delete(stale);
    }
    return boxPath;
  }

  private async ensureConnection(): Promise<GatewayConnection> {
    if (this.connection != null && (this.live || Date.now() - this.lastHealthyAt < HEALTH_TTL_MS)) return this.connection;
    if (this.connection != null && (await this.healthy(this.connection))) return this.connection;
    this.connection = await this.options.resolveConnection();
    if (!(await this.healthy(this.connection))) throw new EdgeCallFailure({ code: "gateway-unreachable", detail: "The box gateway is not answering." });
    return this.connection;
  }

  private async healthy(connection: GatewayConnection): Promise<boolean> {
    try {
      const response = await fetch(`${connection.baseUrl}/health`, { headers: { authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(HEALTH_DEADLINE_MS) });
      const body = (await response.json()) as { ok?: boolean };
      if (response.ok && body.ok === true) {
        this.lastHealthyAt = Date.now();
        return true;
      }
    } catch {
      // unreachable
    }
    return false;
  }

  private async eventLoop(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      const outcome = await this.streamOnce();
      if (this.stopped) return;
      if (outcome === "connected-then-dropped") failures = 0;
      const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
      failures++;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private async streamOnce(): Promise<"connected-then-dropped" | "failed"> {
    const abort = new AbortController();
    this.streamAbort = abort;
    let connected = false;
    let lastByteAt = Date.now();
    let watchdog: NodeJS.Timeout | null = null;
    try {
      const connectTimer = setTimeout(() => abort.abort(new Error("connect deadline")), CONNECT_DEADLINE_MS);
      let connection: GatewayConnection;
      try {
        connection = await this.options.resolveConnection();
      } catch (error) {
        clearTimeout(connectTimer);
        this.options.log(`gateway not resolvable: ${error instanceof Error ? error.message : String(error)}`);
        return "failed";
      }
      const response = await fetch(`${connection.baseUrl}/events`, { headers: { authorization: `Bearer ${connection.token}`, accept: "text/event-stream" }, signal: abort.signal });
      clearTimeout(connectTimer);
      if (!response.ok || response.body == null) throw new Error(`events HTTP ${response.status}`);

      this.connection = connection;
      this.lastHealthyAt = Date.now();
      connected = true;
      this.live = true;
      this.options.onState("connected");

      watchdog = setInterval(async () => {
        if (Date.now() - lastByteAt < STALL_IDLE_MS) return;
        const nonce = randomUUID();
        const answered = new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            this.echoWaiters.delete(nonce);
            resolve(false);
          }, ECHO_WAIT_MS);
          this.echoWaiters.set(nonce, () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
        void fetch(`${connection.baseUrl}/events/ping?nonce=${nonce}`, { method: "POST", headers: { authorization: `Bearer ${connection.token}` } }).catch(() => undefined);
        if (!(await answered)) {
          this.options.log("event stream stalled; reconnecting");
          abort.abort(new Error("stall-timeout"));
        }
      }, 5_000);

      for await (const block of readSse(response.body, abort.signal)) {
        lastByteAt = Date.now();
        if (block.comment != null) {
          if (block.comment.startsWith("echo ")) this.echoWaiters.get(block.comment.slice(5))?.();
          continue;
        }
        let frame: Partial<GatewayEventFrame>;
        try {
          frame = JSON.parse(block.data ?? "");
        } catch {
          continue;
        }
        if (typeof frame.channel === "string") this.options.onEvent(frame.channel, frame.payload);
      }
    } catch (error) {
      if (!this.stopped && !connected) this.options.log(`event stream failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (watchdog != null) clearInterval(watchdog);
      if (this.live) {
        this.live = false;
        this.lastHealthyAt = 0;
        this.options.onState("down");
      }
    }
    return connected ? "connected-then-dropped" : "failed";
  }
}
