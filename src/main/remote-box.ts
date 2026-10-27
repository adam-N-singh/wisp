// Main's side of a remote box (the user's own box server). It checks the
// address and token before the app switches, pushes the configuration the box
// on this PC would get over box-control (the app's provider keys among it) to
// POST /admin/configure, lists models there, and moves ChatGPT and MCP
// sign-ins to it. Every request carries the box token; anything but loopback
// must be HTTPS.
import type { MethodDecl } from "../shared/rpc/edge";
import { type BoxConfig, boxAdminEdge, type BoxServerStatus } from "../shared/edges";
import { GATEWAY_PROTOCOL_VERSION } from "../shared/gateway-protocol";

type AdminMethods = typeof boxAdminEdge.methods;
type ArgsOf<K extends keyof AdminMethods> = AdminMethods[K] extends MethodDecl<infer A, any> ? A : never;
type ResultOf<K extends keyof AdminMethods> = AdminMethods[K] extends MethodDecl<any, infer R> ? R : never;

export interface RemoteBoxAddress {
  baseUrl: string;
  token: string;
}

export class RemoteBoxError extends Error {
  constructor(
    message: string,
    /** "unreachable" and "server" are worth retrying; the rest need the user. */
    readonly kind: "unreachable" | "server" | "unauthorized" | "admin-off" | "incompatible" | "refused",
  ) {
    super(message);
  }
}

const CHECK_TIMEOUT_MS = 8_000;
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
/** Admin methods that answer with something other than the box's status. */
const OTHER_REPLIES = new Set<string>(["listModels", "mcpSignInTarget"]);

const isLoopback = (hostname: string) => hostname === "localhost" || hostname === "[::1]" || /^127\./.test(hostname);

/** "box.example.com/" -> "https://box.example.com"; plain http only for this PC's own loopback (an SSH tunnel). */
export function normalizeBoxUrl(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) throw new RemoteBoxError("Enter the box server's address.", "refused");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new RemoteBoxError(`“${text}” isn't a web address.`, "refused");
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) throw new RemoteBoxError("Use an https:// address: the box token and your API keys must not cross the network unencrypted.", "refused");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new RemoteBoxError("Use an https:// address.", "refused");
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new RemoteBoxError("Use just the server's address, without a user name, query or #fragment.", "refused");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

async function request(address: RemoteBoxAddress, path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(`${address.baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${address.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    throw new RemoteBoxError(`Couldn't reach ${address.baseUrl} (${cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error))}).`, "unreachable");
  }
}

/** Is this a box server, does it take the token, and does it speak this app's protocol? */
export async function probeBox(address: RemoteBoxAddress): Promise<{ version: string }> {
  const response = await request(address, "/health", {}, CHECK_TIMEOUT_MS);
  if (response.status === 401) throw new RemoteBoxError("The box refused the token.", "unauthorized");
  let body: { ok?: unknown; version?: unknown; protocol?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // not JSON: not a box
  }
  if (!response.ok || body.ok !== true) throw new RemoteBoxError(`${address.baseUrl} doesn't look like a Wisp box (HTTP ${response.status}).`, response.status >= 500 ? "server" : "refused");
  if (body.protocol !== GATEWAY_PROTOCOL_VERSION) throw new RemoteBoxError(`The box speaks protocol ${String(body.protocol)}; this app needs ${GATEWAY_PROTOCOL_VERSION}. Update the box server.`, "incompatible");
  return { version: String(body.version ?? "?") };
}

export class RemoteBoxClient {
  /** The box's last report about itself. */
  status: BoxServerStatus | null = null;
  /** Why the last request failed; null after a success. */
  error: string | null = null;
  checkedAt = 0;
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();
  private retryTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    readonly address: RemoteBoxAddress,
    private readonly options: { onChange(): void; log(line: string): void },
  ) {}

  async call<K extends keyof AdminMethods>(method: K, args: ArgsOf<K>, timeoutMs = 60_000): Promise<ResultOf<K>> {
    const response = await request(this.address, `/admin/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args ?? {}) }, timeoutMs);
    const text = await response.text();
    let body: { error?: string; failureCode?: string } | null = null;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON
    }
    if (!response.ok) {
      const kind = response.status === 401 ? "unauthorized" : body?.failureCode === "admin/disabled" ? "admin-off" : response.status >= 500 ? "server" : "refused";
      throw new RemoteBoxError(kind === "unauthorized" ? "The box refused the token." : (body?.error ?? `The box answered HTTP ${response.status}.`), kind);
    }
    const value = body as ResultOf<K>;
    if (!OTHER_REPLIES.has(method)) this.applyStatus(value as BoxServerStatus);
    return value;
  }

  applyStatus(status: BoxServerStatus): void {
    this.status = status;
    this.error = null;
    this.checkedAt = Date.now();
    this.options.onChange();
  }

  async refreshStatus(): Promise<BoxServerStatus | null> {
    try {
      return await this.call("status", {}, CHECK_TIMEOUT_MS);
    } catch (error) {
      this.fail(error);
      return null;
    }
  }

  /**
   * Sends the latest configuration. Pushes run one at a time and a newer one supersedes an older
   * one; the box saves each, so it keeps working with the PC off. Resolves after the first attempt;
   * a box that can't be reached is retried in the background.
   */
  pushConfig(build: () => Promise<BoxConfig>): Promise<void> {
    const generation = ++this.generation;
    if (this.retryTimer != null) clearTimeout(this.retryTimer);
    const run = this.queue.then(() => this.attempt(generation, build, 0));
    this.queue = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.closed = true;
    this.generation++;
    if (this.retryTimer != null) clearTimeout(this.retryTimer);
  }

  private async attempt(generation: number, build: () => Promise<BoxConfig>, retry: number): Promise<void> {
    if (generation !== this.generation || this.closed) return;
    try {
      await this.call("configure", await build());
    } catch (error) {
      this.fail(error);
      if (!(error instanceof RemoteBoxError) || (error.kind !== "unreachable" && error.kind !== "server")) return;
      const delay = RETRY_MS[Math.min(retry, RETRY_MS.length - 1)];
      this.retryTimer = setTimeout(() => {
        this.queue = this.queue.then(() => this.attempt(generation, build, retry + 1)).catch(() => undefined);
      }, delay);
    }
  }

  private fail(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    this.checkedAt = Date.now();
    this.options.log(`remote box: ${this.error}`);
    this.options.onChange();
  }
}
