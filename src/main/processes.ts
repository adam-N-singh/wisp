// Supervises the three utility processes:
//   wisp-box           agents, transcripts, harness, gateway
//   wisp-coordinator  gateway edge for renderers, roster cache
//   wisp-local-exec  tools on this computer
// Each child gets one MessagePort to main at bootstrap; renderers get their own
// port to the coordinator (`wisp:coordinator-port`). Crashed children restart
// with exponential backoff; the coordinator and daemon re-dial the box gateway.
//
// With a remote box (the user's own box server) no box process runs here:
// gatewayAddress hands out the server's address, and the coordinator
// and daemon dial it instead.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { MessageChannelMain, type UtilityProcess, utilityProcess, type WebContents } from "electron";
import { createPortPeer, mainPort, type PortPeer } from "../shared/rpc/transports";
import { createEdgeClient } from "../shared/rpc/runtime";
import { boxControlEdge, coordinatorMainEdge, type GatewayConnectionInfo } from "../shared/edges";
import type { RemoteBoxAddress } from "./remote-box";

type Kind = "box" | "coordinator" | "local-exec";

const ENTRY: Record<Kind, string> = { box: "box/main.cjs", coordinator: "coordinator/main.cjs", "local-exec": "local-exec/main.cjs" };
const SERVICE: Record<Kind, string> = { box: "wisp-box", coordinator: "wisp-coordinator", "local-exec": "wisp-local-exec" };

interface Child {
  proc: UtilityProcess;
  peer: PortPeer;
}

export interface ProcessHostOptions {
  version: string;
  distDir: string;
  boxDataDir: string;
  wasmDir: string;
  /** Where main stages attachments; the coordinator uploads only files from here to a remote box. */
  attachmentsRoot: string;
  /** Parent of the agents' folders on this PC, where local tools work. */
  workspaceRoot: string;
  /** The local-exec daemon's own folder (its background commands' logs). */
  localExecDataDir: string;
  /** Serve main's side of the edges on a freshly connected child. */
  onBox(peer: PortPeer): void;
  onCoordinator(peer: PortPeer): void;
  onLocalExec(peer: PortPeer): void;
  onBoxReady(): void;
  onStatus(kind: Kind, state: "starting" | "ready" | "down"): void;
}

export class ProcessHost {
  readonly token = randomBytes(32).toString("hex");
  private children = new Map<Kind, Child>();
  private restarts = new Map<Kind, number>();
  /** Kinds being restarted on purpose: respawn at once, without backoff. */
  private restarting = new Set<Kind>();
  private spawnWaiters = new Map<Kind, Array<() => void>>();
  private boxPort: number | null = null;
  private boxWaiters = new Set<() => void>();
  private renderers = new Map<string, WebContents>();
  private stopping = false;
  private remote: RemoteBoxAddress | null = null;
  boxControl: ReturnType<typeof createEdgeClient<typeof boxControlEdge>> | null = null;
  coordinatorMain: ReturnType<typeof createEdgeClient<typeof coordinatorMainEdge>> | null = null;

  constructor(private readonly options: ProcessHostOptions) {}

  /** `remote`: the box server to use instead of a box process on this PC. */
  start(remote: RemoteBoxAddress | null): void {
    this.remote = remote;
    if (remote == null) this.spawn("box");
    this.spawn("coordinator");
    this.spawn("local-exec");
  }

  /**
   * Moves to another box: stops or starts the box process, then restarts the coordinator and the
   * daemon so their connections, roster cache and pending requests start over against the new one.
   * Resolves once both replacements are running, so renderers attach to the new coordinator.
   */
  async switchBox(remote: RemoteBoxAddress | null): Promise<void> {
    const wasRemote = this.remote != null;
    this.remote = remote;
    if (remote != null && !wasRemote) {
      this.kill("box");
      // Callers still waiting for the box on this PC get the server instead.
      for (const waiter of this.boxWaiters) waiter();
      this.boxWaiters.clear();
    }
    if (remote == null && !this.children.has("box")) this.spawn("box");
    await Promise.all([this.restart("coordinator"), this.restart("local-exec")]);
  }

  get isRemote(): boolean {
    return this.remote != null;
  }

  async gatewayAddress(): Promise<GatewayConnectionInfo> {
    if (this.remote != null) return { ...this.remote, remote: true };
    if (this.boxPort == null) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.boxWaiters.delete(done);
          reject(new Error("box host is not ready"));
        }, 20_000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        this.boxWaiters.add(done);
      });
    }
    // The box may have moved to a server while this waited.
    const remote = this.remote as RemoteBoxAddress | null;
    if (remote != null) return { ...remote, remote: true };
    return { baseUrl: `http://127.0.0.1:${this.boxPort}`, token: this.token };
  }

  /** The box on this PC is up (a remote box is reached over HTTP instead). */
  get boxReady(): boolean {
    return this.remote == null && this.boxPort != null;
  }

  /** Give a renderer its own MessagePort to the coordinator. */
  attachRenderer(contents: WebContents): void {
    const id = String(contents.id);
    this.renderers.set(id, contents);
    contents.once("destroyed", () => this.renderers.delete(id));
    this.sendRendererPort(id, contents);
  }

  private sendRendererPort(id: string, contents: WebContents): void {
    const coordinator = this.children.get("coordinator");
    if (coordinator == null || contents.isDestroyed()) return;
    const { port1, port2 } = new MessageChannelMain();
    coordinator.proc.postMessage({ type: "renderer-port", id }, [port1]);
    contents.postMessage("wisp:coordinator-port", null, [port2]);
  }

  stop(): void {
    this.stopping = true;
    for (const child of this.children.values()) {
      child.peer.close();
      child.proc.kill();
    }
    this.children.clear();
  }

  /** Stops a child for good (until something spawns it again). */
  private kill(kind: Kind): void {
    const child = this.children.get(kind);
    if (child == null) return;
    this.children.delete(kind);
    if (kind === "box") {
      this.boxPort = null;
      this.boxControl = null;
    }
    child.peer.close();
    child.proc.kill();
  }

  /** Replaces a running child; resolves when the new one has spawned (or after 10 s regardless). */
  private restart(kind: Kind): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      this.spawnWaiters.set(kind, [...(this.spawnWaiters.get(kind) ?? []), () => (clearTimeout(timer), resolve())]);
      const child = this.children.get(kind);
      if (child == null) return this.spawn(kind);
      this.restarting.add(kind);
      child.proc.kill();
    });
  }

  private spawn(kind: Kind): void {
    if (this.stopping) return;
    this.options.onStatus(kind, "starting");
    const startedAt = Date.now();
    const proc = utilityProcess.fork(join(this.options.distDir, ENTRY[kind]), [], {
      serviceName: SERVICE[kind],
      stdio: "pipe",
      env: { ...process.env, WISP_CHILD: kind },
    });
    proc.once("spawn", () => {
      for (const done of this.spawnWaiters.get(kind) ?? []) done();
      this.spawnWaiters.delete(kind);
    });
    proc.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[${kind}] ${chunk}`));
    proc.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[${kind}] ${chunk}`));

    const { port1, port2 } = new MessageChannelMain();
    const peer = createPortPeer(mainPort(port1), kind);
    this.children.set(kind, { proc, peer });

    if (kind === "box") {
      this.boxPort = null;
      this.boxControl = createEdgeClient(boxControlEdge, peer.client);
      this.options.onBox(peer);
      proc.on("message", (message: { type?: string; port?: number }) => {
        if (message?.type !== "ready" || typeof message.port !== "number" || this.children.get("box")?.proc !== proc) return;
        this.boxPort = message.port;
        for (const waiter of this.boxWaiters) waiter();
        this.boxWaiters.clear();
        this.options.onStatus("box", "ready");
        this.options.onBoxReady();
      });
      proc.postMessage({ type: "bootstrap", dataDir: this.options.boxDataDir, token: this.token, version: this.options.version }, [port2]);
    } else if (kind === "coordinator") {
      this.coordinatorMain = createEdgeClient(coordinatorMainEdge, peer.client);
      this.options.onCoordinator(peer);
      proc.postMessage({ type: "bootstrap", attachmentsRoot: this.options.attachmentsRoot }, [port2]);
      proc.once("spawn", () => {
        this.options.onStatus(kind, "ready");
        for (const [id, contents] of this.renderers) this.sendRendererPort(id, contents);
      });
    } else {
      this.options.onLocalExec(peer);
      proc.postMessage({ type: "bootstrap", wasmDir: this.options.wasmDir, workspaceRoot: this.options.workspaceRoot, dataDir: this.options.localExecDataDir }, [port2]);
      proc.once("spawn", () => this.options.onStatus(kind, "ready"));
    }

    proc.once("exit", (code) => {
      peer.close();
      const current = this.children.get(kind)?.proc === proc;
      if (current) this.children.delete(kind);
      if (kind === "box" && current) this.boxPort = null;
      this.options.onStatus(kind, "down");
      if (this.stopping || !current) return;
      if (this.restarting.delete(kind)) return this.spawn(kind);
      // Backoff 250 ms -> 10 s; a child that stayed up for a minute starts
      // over from the bottom.
      const uptime = Date.now() - startedAt;
      const attempt = uptime > 60_000 ? 1 : (this.restarts.get(kind) ?? 0) + 1;
      this.restarts.set(kind, attempt);
      const delay = Math.min(10_000, 250 * 2 ** (attempt - 1));
      console.error(`[${kind}] exited with code ${code}; restarting in ${delay} ms`);
      setTimeout(() => {
        if (kind !== "box" || this.remote == null) this.spawn(kind);
      }, delay);
    });
  }
}
