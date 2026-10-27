// The optional cloud computer: one E2B sandbox (a Linux VM) shared by every
// agent set to "cloud", each in its own folder under /home/user/agents.
//
// Cost model: E2B bills per second while the sandbox runs and nothing for
// compute while it is paused. The sandbox is created with
// `lifecycle.onTimeout: "pause"` and a sliding timeout of `idleMinutes`, so it
// pauses itself after that long without activity; `Sandbox.connect(id)` resumes
// it (about a second) with its disk, memory and processes intact. The "desktop"
// kind adds an Xfce desktop with screenshots, mouse/keyboard control and a live
// noVNC view (@e2b/desktop).
//
// Background commands (async-tasks.ts) run under a small bash wrapper that
// writes their log in the PC daemon's format (src/shared/background-shell.ts:
// a header, the output, a footer with the exit code), so the box needn't hold
// a stream open: it reads the log and checks the process. While one runs, the
// box's checks keep the sandbox from pausing.
import { Sandbox as DesktopSandbox } from "@e2b/desktop";
import { CommandExitError, type CommandHandle, FileType, Sandbox } from "e2b";
import type { CloudComputerStatus } from "../shared/model";

export interface CloudConfig {
  apiKey: string;
  kind: "headless" | "desktop";
  idleMinutes: number;
  askBeforeCommands: boolean;
}

export interface CloudState {
  sandboxId: string | null;
  kind: "headless" | "desktop" | null;
  createdAt: number | null;
}

export const CLOUD_HOME = "/home/user";
export const cloudWorkspace = (agentId: string) => `${CLOUD_HOME}/agents/${agentId}`;
/** Background commands' logs on the cloud computer. */
export const CLOUD_TERMINALS = `${CLOUD_HOME}/.wisp/terminals`;
/** Where a background command's header has its pid, as wide as the header's padded pid (10 characters). */
export const CLOUD_PID_PLACEHOLDER = "__PID_____";

const TOUCH_INTERVAL_MS = 60_000;
const OUTPUT_LIMIT = 200_000;

/**
 * Runs a background command (envs WISP_LOG, WISP_COMMAND, WISP_HEADER) with its log's header and footer.
 * Its pid goes in padded, so the header keeps the length the box rewrites it at.
 */
const BACKGROUND_WRAPPER = [
  'log="$WISP_LOG"; command="$WISP_COMMAND"; header="$WISP_HEADER"; unset WISP_LOG WISP_COMMAND WISP_HEADER',
  'mkdir -p "$(dirname "$log")"',
  `pid=$(printf '%-10s' "$$")`,
  `printf "%s" "\${header/${CLOUD_PID_PLACEHOLDER}/$pid}" > "$log"`,
  "start=$(date +%s%3N)",
  'bash -c "$command" >> "$log" 2>&1 < /dev/null',
  "code=$?",
  "end=$(date +%s%3N)",
  `printf '\\n---\\nexit_code: %s\\nelapsed_ms: %s\\nended_at: %s\\n---\\n' "$code" "$((end - start))" "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" >> "$log"`,
  "exit $code",
].join("\n");

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** A shell command writing `text` over a file's first bytes, in place (the file isn't cut short). */
const overwriteStart = (path: string, text: string) => `printf '%s' ${quote(Buffer.from(text).toString("base64"))} | base64 -d | dd of=${quote(path)} conv=notrunc status=none 2>/dev/null`;

export class CloudComputer {
  private sandbox: Sandbox | null = null;
  private opening: Promise<Sandbox> | null = null;
  private state: CloudComputerStatus["state"] = "none";
  private error: string | null = null;
  private lastActiveAt = 0;
  private lastTouchAt = 0;
  private madeDirs = new Set<string>();

  constructor(
    private readonly options: {
      config(): CloudConfig | null;
      load(): CloudState;
      save(state: CloudState): void;
      onStatus(status: CloudComputerStatus): void;
      log(line: string): void;
    },
  ) {
    // Whatever was running before the app quit has paused itself by now.
    if (options.load().sandboxId != null) this.state = "paused";
  }

  status(): CloudComputerStatus {
    const saved = this.options.load();
    return { configured: this.options.config() != null, state: this.state, sandboxId: saved.sandboxId, kind: saved.kind, createdAt: saved.createdAt, error: this.error };
  }

  private setState(state: CloudComputerStatus["state"], error: string | null = null): void {
    this.state = state;
    this.error = error;
    this.options.onStatus(this.status());
  }

  /** Connects to (resuming if paused) or creates the sandbox. */
  async open(): Promise<Sandbox> {
    const config = this.requireConfig();
    const idleMs = config.idleMinutes * 60_000;
    // Past the idle window the cached handle is stale: E2B has paused the sandbox.
    if (this.sandbox != null && Date.now() - this.lastActiveAt > idleMs - 30_000) this.sandbox = null;
    if (this.sandbox != null) {
      await this.touch(idleMs);
      return this.sandbox;
    }
    this.opening ??= (async () => {
      this.setState("starting");
      const saved = this.options.load();
      const Kind = config.kind === "desktop" ? DesktopSandbox : Sandbox;
      let sandbox: Sandbox | null = null;
      if (saved.sandboxId != null && saved.kind === config.kind) {
        try {
          sandbox = await Kind.connect(saved.sandboxId, { apiKey: config.apiKey, timeoutMs: idleMs });
        } catch (error) {
          this.options.log(`cloud: couldn't resume ${saved.sandboxId} (${describe(error)}); creating a new one`);
        }
      } else if (saved.sandboxId != null) {
        // The kind changed (headless <-> desktop): retire the old machine.
        await Sandbox.kill(saved.sandboxId, { apiKey: config.apiKey }).catch(() => false);
      }
      if (sandbox == null) {
        const options = { apiKey: config.apiKey, timeoutMs: idleMs, lifecycle: { onTimeout: "pause" as const }, metadata: { app: "wisp" } };
        sandbox = config.kind === "desktop" ? await DesktopSandbox.create({ ...options, resolution: [1280, 800] }) : await Sandbox.create(options);
        this.options.save({ sandboxId: sandbox.sandboxId, kind: config.kind, createdAt: Date.now() });
        this.madeDirs.clear();
      }
      this.sandbox = sandbox;
      this.lastActiveAt = Date.now();
      this.lastTouchAt = Date.now();
      this.setState("running");
      return sandbox;
    })()
      .catch((error) => {
        this.setState("error", describe(error));
        throw error;
      })
      .finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  /** Slides the auto-pause window forward (at most once a minute). */
  private async touch(idleMs: number): Promise<void> {
    this.lastActiveAt = Date.now();
    if (Date.now() - this.lastTouchAt < TOUCH_INTERVAL_MS || this.sandbox == null) return;
    this.lastTouchAt = Date.now();
    await this.sandbox.setTimeout(idleMs).catch((error) => this.options.log(`cloud: setTimeout failed: ${describe(error)}`));
  }

  /** Runs an operation, reconnecting once if the sandbox paused underneath us. */
  private async withSandbox<T>(operation: (sandbox: Sandbox) => Promise<T>): Promise<T> {
    const sandbox = await this.open();
    try {
      return await operation(sandbox);
    } catch (error) {
      if (!/not running|not found|paused|502|503|connect/i.test(describe(error))) throw error;
      this.sandbox = null;
      return operation(await this.open());
    } finally {
      this.lastActiveAt = Date.now();
    }
  }

  async ensureDir(path: string): Promise<void> {
    if (this.madeDirs.has(path)) return;
    await this.withSandbox((sandbox) => sandbox.files.makeDir(path));
    this.madeDirs.add(path);
  }

  async exec(command: string, options: { cwd: string; timeoutMs: number; signal: AbortSignal; onOutput(chunk: string): void }): Promise<{ exitCode: number; output: string; killedBy: string | null }> {
    await this.ensureDir(options.cwd);
    return this.withSandbox(async (sandbox) => {
      let output = "";
      const collect = (chunk: string) => {
        output = (output + chunk).slice(-OUTPUT_LIMIT);
        options.onOutput(chunk);
      };
      const handle: CommandHandle = await sandbox.commands.run(command, {
        background: true,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        envs: { TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat", CI: "1" },
        onStdout: collect,
        onStderr: collect,
      });
      let killedBy: string | null = null;
      const onAbort = () => {
        killedBy = "interrupted";
        void handle.kill().catch(() => false);
      };
      options.signal.addEventListener("abort", onAbort);
      try {
        const result = await handle.wait();
        return { exitCode: result.exitCode, output, killedBy };
      } catch (error) {
        if (error instanceof CommandExitError) return { exitCode: error.exitCode, output, killedBy };
        if (/timed? ?out|deadline/i.test(describe(error))) return { exitCode: -1, output, killedBy: `timed out after ${options.timeoutMs} ms` };
        throw error;
      } finally {
        options.signal.removeEventListener("abort", onAbort);
      }
    });
  }

  // ---- background commands ------------------------------------------------------------

  /** Starts a command in the background, its output going to `logPath` after `header` (whose CLOUD_PID_PLACEHOLDER becomes its pid). */
  async startBackground(options: { command: string; cwd: string; logPath: string; header: string }): Promise<{ pid: number }> {
    await this.ensureDir(options.cwd);
    return this.withSandbox(async (sandbox) => {
      const handle = await sandbox.commands.run(BACKGROUND_WRAPPER, {
        background: true,
        cwd: options.cwd,
        timeoutMs: 0,
        envs: { TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat", CI: "1", WISP_LOG: options.logPath, WISP_COMMAND: options.command, WISP_HEADER: options.header },
      });
      // Its log tells how it goes; there's no stream to hold open.
      await handle.disconnect().catch(() => undefined);
      return { pid: handle.pid };
    });
  }

  /**
   * For each background command: whether its process is alive, and its exit code once its log has the footer. A live
   * one's log gets `header` written over its own (the same length) at once.
   */
  async backgroundStates(commands: Array<{ id: number; pid: number; logPath: string; header?: string }>): Promise<Map<number, { alive: boolean; exitCode: number | null }>> {
    // Alive is checked first: a process found gone has already written its footer, if it got to.
    const script = commands
      .map((command) => {
        const rewrite = command.header != null ? `[ "$alive" = 1 ] && ${overwriteStart(command.logPath, command.header)}; ` : "";
        return `alive=0; kill -0 ${command.pid} 2>/dev/null && alive=1; ${rewrite}code=$(tail -c 300 ${quote(command.logPath)} 2>/dev/null | sed -n 's/^exit_code: //p' | tail -n 1); echo "${command.id} $alive \${code:--}"`;
      })
      .join("\n");
    const result = await this.withSandbox((sandbox) => sandbox.commands.run(script, { timeoutMs: 30_000 }));
    const states = new Map<number, { alive: boolean; exitCode: number | null }>();
    for (const line of result.stdout.split("\n")) {
      const [id, alive, code] = line.trim().split(" ");
      if (id == null || alive == null || code == null) continue;
      states.set(Number(id), { alive: alive === "1", exitCode: /^-?\d+$/.test(code) ? Number(code) : null });
    }
    return states;
  }

  /** A log's first 8 KB, its last `tailBytes` and its size; null when it isn't there. */
  async readLog(path: string, tailBytes: number): Promise<{ head: Buffer; tail: Buffer; tailStart: number; size: number } | null> {
    const file = quote(path);
    const script = `size=$(stat -c %s ${file} 2>/dev/null) || { echo missing; exit 0; }; echo "$size"; head -c 8192 ${file} | base64 -w0; echo; tail -c ${Math.max(1, Math.round(tailBytes))} ${file} | base64 -w0; echo`;
    const result = await this.withSandbox((sandbox) => sandbox.commands.run(script, { timeoutMs: 30_000 }));
    const [first, head = "", tail = ""] = result.stdout.split("\n");
    if (first?.trim() === "missing") return null;
    const size = Number(first);
    const tailBytesRead = Buffer.from(tail.trim(), "base64");
    return { head: Buffer.from(head.trim(), "base64"), tail: tailBytesRead, tailStart: Math.max(0, size - tailBytesRead.length), size };
  }

  /** Stops what a background command started, deepest first, so its wrapper still writes the footer; then the wrapper too if it lingers. */
  async stopBackground(pid: number): Promise<void> {
    const script = [
      'k() { for child in $(pgrep -P "$1"); do k "$child" "$2"; kill -"$2" "$child" 2>/dev/null; done; }',
      `k ${pid} TERM`,
      `for i in 1 2 3 4; do pgrep -P ${pid} > /dev/null || exit 0; sleep 0.5; done`,
      `k ${pid} KILL; sleep 0.5; kill -0 ${pid} 2>/dev/null && kill -KILL ${pid}; true`,
    ].join("\n");
    await this.withSandbox((sandbox) => sandbox.commands.run(script, { timeoutMs: 30_000 }));
  }

  /** Writes `header` over a log's own header, which has the same length, leaving the output after it alone. */
  async rewriteLogHeader(path: string, header: string): Promise<void> {
    await this.withSandbox((sandbox) => sandbox.commands.run(overwriteStart(path, header), { timeoutMs: 30_000 }));
  }

  async appendText(path: string, text: string): Promise<void> {
    await this.withSandbox((sandbox) => sandbox.commands.run(`printf '%s' ${quote(Buffer.from(text).toString("base64"))} | base64 -d >> ${quote(path)}`, { timeoutMs: 30_000 }));
  }

  async readText(path: string): Promise<string> {
    return this.withSandbox((sandbox) => sandbox.files.read(path));
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return this.withSandbox((sandbox) => sandbox.files.read(path, { format: "bytes" }));
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.withSandbox((sandbox) => sandbox.files.write(path, content));
  }

  async exists(path: string): Promise<boolean> {
    return this.withSandbox((sandbox) => sandbox.files.exists(path));
  }

  async list(path: string, depth: number): Promise<Array<{ path: string; name: string; isDir: boolean; size: number }>> {
    const entries = await this.withSandbox((sandbox) => sandbox.files.list(path, { depth }));
    return entries.map((entry) => ({ path: entry.path, name: entry.name, isDir: entry.type === FileType.DIR, size: entry.size }));
  }

  // ---- desktop ----------------------------------------------------------------------

  private async desktop(): Promise<DesktopSandbox> {
    if (this.requireConfig().kind !== "desktop") throw new Error("The cloud computer has no desktop. Switch it to the Desktop kind in Settings → Cloud computer.");
    return (await this.open()) as DesktopSandbox;
  }

  async screenshot(): Promise<Uint8Array> {
    const desktop = await this.desktop();
    this.lastActiveAt = Date.now();
    return desktop.screenshot();
  }

  async act(action: (desktop: DesktopSandbox) => Promise<unknown>): Promise<void> {
    const desktop = await this.desktop();
    await action(desktop);
    this.lastActiveAt = Date.now();
  }

  /** A noVNC page showing the desktop (password-protected; the key is in the URL). */
  async viewerUrl(): Promise<string> {
    const desktop = await this.desktop();
    try {
      await desktop.stream.start({ requireAuth: true });
    } catch (error) {
      if (!/already/i.test(describe(error))) throw error;
    }
    return desktop.stream.getUrl({ autoConnect: true, resize: "scale", authKey: desktop.stream.getAuthKey() });
  }

  // ---- lifecycle ------------------------------------------------------------------------

  async pause(): Promise<void> {
    const config = this.requireConfig();
    const saved = this.options.load();
    if (saved.sandboxId == null) return;
    await Sandbox.pause(saved.sandboxId, { apiKey: config.apiKey });
    this.sandbox = null;
    this.setState("paused");
  }

  async destroy(): Promise<void> {
    const config = this.options.config();
    const saved = this.options.load();
    if (saved.sandboxId != null && config != null) await Sandbox.kill(saved.sandboxId, { apiKey: config.apiKey }).catch(() => false);
    this.sandbox = null;
    this.madeDirs.clear();
    this.options.save({ sandboxId: null, kind: null, createdAt: null });
    this.setState("none");
  }

  private requireConfig(): CloudConfig {
    const config = this.options.config();
    if (config == null) throw new Error("The cloud computer isn't set up. Add an E2B API key in Settings → Cloud computer.");
    return config;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
