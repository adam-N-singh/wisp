// Background commands on this computer (see src/shared/background-shell.ts for the log format).
// run_shell starts one when asked, or keeps a command that runs past its timeout going as one;
// await_command and stop_command act on them, and the box hears of each change (onChange) and
// gets the whole list when the daemon registers.
//
// A started command writes its output straight to its log file; a command kept past its timeout
// had pipes to the daemon, which go on into the file. Every 5 s the daemon rewrites the header in
// place; when the command ends it adds the footer. The list (terminals/index.json) survives a
// restart of the daemon. A command still alive after one (its process group, on macOS and Linux)
// is watched again, but its exit code is lost; one that is gone is "lost". On Windows a command
// dies with the daemon (Node puts its children in a job that closes with it), and the processes
// it had started, which outlive it there, are stopped when the daemon starts again.
//
// Stopping one stops its whole process tree (taskkill /t on Windows, the process group elsewhere).
import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import {
  type AwaitOutcome,
  type BackgroundShellStatus,
  clampAwaitMs,
  compileAwaitRegex,
  HEADER_REFRESH_MS,
  lastLines,
  logFooter,
  logHeader,
  type LogView,
  pickShellId,
  readLogView,
  type ShellState,
} from "../shared/background-shell";
import { replaceFileSync } from "../shared/replace-file";

/** Past this the log keeps only its last KEEP_LOG_BYTES of output. */
const MAX_LOG_BYTES = 50 * 1024 * 1024;
const KEEP_LOG_BYTES = 8 * 1024 * 1024;
/** What await_command shows of the output, and what a regex is matched against. */
const AWAIT_TAIL_CHARS = 10_000;
const REGEX_WINDOW_BYTES = 4 * 1024 * 1024;
const POLL_MS = 500;
/** How often a command from before a restart is checked on. */
const WATCH_MS = 2_000;
/** Ended commands are kept this long (at most MAX_KEPT of them), with their logs. */
const KEEP_ENDED_MS = 7 * 24 * 3_600_000;
const MAX_KEPT = 200;

export class ShellError extends Error {}

interface Entry {
  status: BackgroundShellStatus;
  /** Ours to wait on: null for a command from before a restart. */
  child: ChildProcess | null;
  headerBytes: number;
  timers: NodeJS.Timeout[];
  /** Stop asked for, and why. */
  stopping: string | null;
  ended: Promise<void>;
  markEnded(): void;
}

interface StoredList {
  schemaVersion: 1;
  /** When this computer booted, to tell a restart of the daemon from a restart of the computer. */
  bootedAt: number;
  shells: BackgroundShellStatus[];
}

const bootTime = () => Math.round(Date.now() - os.uptime() * 1000);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function newEntry(status: BackgroundShellStatus, child: ChildProcess | null): Entry {
  let markEnded = () => undefined as void;
  const ended = new Promise<void>((done) => (markEnded = done));
  return { status, child, headerBytes: 0, timers: [], stopping: null, ended, markEnded };
}

/** Whether two paths name the same file, their case folded only where the file system folds it (Windows, macOS). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = platform === "win32" || platform === "darwin" ? (path: string) => path.toLowerCase() : (path: string) => path;
  return fold(resolve(a)) === fold(resolve(b));
}

/** Whether the process (on macOS and Linux: its process group) still exists. */
export function processAlive(pid: number): boolean {
  const probe = (target: number) => {
    try {
      process.kill(target, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  return process.platform === "win32" ? probe(pid) : probe(-pid) || probe(pid);
}

/** Stops a process and every process it started: taskkill /t on Windows, the process group elsewhere. */
export function killProcessTree(pid: number, options: { sync?: boolean } = {}): void {
  if (process.platform === "win32") {
    const args = ["/pid", String(pid), "/t", "/f"];
    if (options.sync === true) spawnSync("taskkill", args, { windowsHide: true, timeout: 5_000 });
    else execFile("taskkill", args, { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return; // already gone
    }
  }
  if (options.sync === true) return;
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // gone
    }
  }, 2_000).unref();
}

/**
 * Windows: stops what a command that died with an earlier daemon had started (processes whose
 * parent was it and that started after it did; Windows keeps a dead parent's id on its children).
 */
function stopOrphans(pid: number, startedAt: number): void {
  const script = [
    `$since = [DateTime]::Parse('${new Date(startedAt).toISOString()}').ToUniversalTime()`,
    "$all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate)",
    "$ids = New-Object 'System.Collections.Generic.HashSet[int]'",
    `[void]$ids.Add(${pid})`,
    "do { $count = $ids.Count; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $p.CreationDate -and $p.CreationDate.ToUniversalTime() -ge $since) { [void]$ids.Add([int]$p.ProcessId) } } } while ($ids.Count -gt $count)",
    `[void]$ids.Remove(${pid})`,
    "foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }",
  ].join("; ");
  execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 30_000 }, () => undefined);
}

export class BackgroundShells {
  private entries = new Map<number, Entry>();
  private readonly listPath: string;
  private readonly bootedAt = bootTime();

  constructor(
    private readonly options: {
      /** The terminals folder: index.json and one <id>.txt log per command. */
      dir: string;
      /** A command started, ended, or was found lost. */
      onChange(status: BackgroundShellStatus): void;
      log(line: string): void;
    },
  ) {
    mkdirSync(options.dir, { recursive: true });
    this.listPath = join(options.dir, "index.json");
    this.recover();
  }

  // ---- starting ---------------------------------------------------------------------------

  /** Starts a command whose output goes straight to its log. */
  start(spec: { agentId: string; command: string; cwd: string; file: string; args: string[]; env: NodeJS.ProcessEnv }): BackgroundShellStatus {
    const entry = this.create(spec.agentId, spec.command, spec.cwd, Date.now(), "spawned");
    const fd = openSync(entry.status.logPath, "a");
    let child: ChildProcess;
    try {
      // Windows: not detached, so the command keeps a (hidden) console for what it starts.
      child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", fd, fd] });
    } catch (error) {
      this.finish(entry, "failed", null, `It couldn't start: ${error instanceof Error ? error.message : String(error)}`, true);
      throw error;
    } finally {
      closeSync(fd);
    }
    entry.child = child;
    entry.status.pid = child.pid ?? null;
    child.once("error", (error) => this.finish(entry, "failed", null, `It couldn't start: ${error.message}`));
    child.once("exit", (code, signal) => this.exited(entry, code, signal));
    return this.started(entry);
  }

  /** Keeps a command that ran past its timeout going in the background; its pipes go on into the log. */
  adopt(spec: { agentId: string; command: string; cwd: string; child: ChildProcess; startedAt: number; output: string; truncated: boolean }): BackgroundShellStatus {
    const entry = this.create(spec.agentId, spec.command, spec.cwd, spec.startedAt, "adopted");
    entry.child = spec.child;
    entry.status.pid = spec.child.pid ?? null;
    appendFileSync(entry.status.logPath, `${spec.truncated ? "…[earlier output was cut]\n" : ""}${spec.output}`);
    const fd = openSync(entry.status.logPath, "a");
    const write = (chunk: Buffer) => {
      try {
        writeSync(fd, chunk);
      } catch {
        // the disk filled up or the file went away; the command keeps running
      }
    };
    spec.child.stdout?.on("data", write);
    spec.child.stderr?.on("data", write);
    // "close" comes after the pipes have drained, so the footer follows all of the output.
    spec.child.once("close", (code, signal) => {
      closeSync(fd);
      this.exited(entry, code, signal);
    });
    return this.started(entry);
  }

  private create(agentId: string, command: string, cwd: string, startedAt: number, origin: BackgroundShellStatus["origin"]): Entry {
    const id = pickShellId((candidate) => this.entries.has(candidate) || existsSync(this.logPath(candidate)));
    const status: BackgroundShellStatus = { id, agentId, command, cwd, pid: null, logPath: this.logPath(id), state: "running", exitCode: null, startedAt, endedAt: null, origin };
    const header = this.header(status);
    writeFileSync(status.logPath, header);
    const entry = newEntry(status, null);
    entry.headerBytes = Buffer.byteLength(header);
    this.entries.set(id, entry);
    return entry;
  }

  private started(entry: Entry): BackgroundShellStatus {
    this.refreshHeader(entry);
    entry.timers.push(setInterval(() => this.tick(entry), HEADER_REFRESH_MS).unref());
    this.prune();
    this.save();
    this.options.onChange(this.copy(entry));
    return this.copy(entry);
  }

  private exited(entry: Entry, code: number | null, signal: NodeJS.Signals | null): void {
    if (entry.stopping != null) return this.finish(entry, "aborted", code, entry.stopping);
    this.finish(entry, code === 0 ? "succeeded" : "failed", code, code == null && signal != null ? `It was ended by ${signal}.` : null);
  }

  private finish(entry: Entry, state: Exclude<ShellState, "running">, exitCode: number | null, detail: string | null, quiet = false): void {
    if (entry.status.state !== "running") return;
    for (const timer of entry.timers) clearInterval(timer);
    entry.timers = [];
    entry.child = null;
    const endedAt = Date.now();
    entry.status = { ...entry.status, state, exitCode, endedAt, detail };
    try {
      appendFileSync(entry.status.logPath, logFooter(exitCode, endedAt - entry.status.startedAt, endedAt));
      this.refreshHeader(entry);
      entry.status.tail = lastLines(this.view(entry.status, 4_000).output, 20, 2_000);
    } catch (error) {
      this.options.log(`background command ${entry.status.id}: couldn't finish its log (${error instanceof Error ? error.message : String(error)})`);
    }
    this.save();
    entry.markEnded();
    if (!quiet) this.options.onChange(this.copy(entry));
  }

  // ---- the agent's tools ------------------------------------------------------------------

  /** Waits for the command to end, or its output to match `regex`, for at most `blockUntilMs`. */
  async await(agentId: string, id: number, options: { blockUntilMs?: unknown; regex?: string | null; signal: AbortSignal }): Promise<AwaitOutcome> {
    const entry = this.own(agentId, id);
    const pattern = options.regex != null && options.regex.length > 0 ? compileAwaitRegex(options.regex) : null;
    const started = Date.now();
    const deadline = started + clampAwaitMs(options.blockUntilMs ?? undefined);
    let searchedBytes = -1;
    for (;;) {
      if (options.signal.aborted) throw new ShellError("interrupted");
      const running = entry.status.state === "running";
      if (pattern != null) {
        const size = this.size(entry.status);
        if (size !== searchedBytes) {
          searchedBytes = size;
          const found = pattern.exec(this.view(entry.status, REGEX_WINDOW_BYTES).output);
          if (found != null) return this.outcome(entry, found[0], started);
        }
      }
      if (!running || Date.now() >= deadline) return this.outcome(entry, null, started);
      await Promise.race([entry.ended, sleep(Math.min(POLL_MS, deadline - Date.now()))]);
    }
  }

  private outcome(entry: Entry, regexMatch: string | null, started: number): AwaitOutcome {
    const view = this.view(entry.status, AWAIT_TAIL_CHARS * 3);
    if (view.output.length > AWAIT_TAIL_CHARS) Object.assign(view, { output: view.output.slice(-AWAIT_TAIL_CHARS), truncated: true });
    return { task: this.copy(entry), view, regexMatch, waitedMs: Date.now() - started };
  }

  /** Stops the command's whole process tree; resolves once it has ended, or after 5 s. */
  async stop(agentId: string, id: number, why: string): Promise<BackgroundShellStatus> {
    const entry = this.own(agentId, id);
    if (entry.status.state !== "running") return this.copy(entry);
    entry.stopping = why;
    if (entry.status.pid != null) killProcessTree(entry.status.pid);
    await Promise.race([entry.ended, sleep(5_000)]);
    // One from before a restart has no exit to wait for.
    if (entry.status.state === "running" && entry.child == null && (entry.status.pid == null || !processAlive(entry.status.pid))) this.finish(entry, "aborted", null, why);
    return this.copy(entry);
  }

  /** The end of the command's output so far. */
  read(agentId: string, id: number, tailChars: number): { task: BackgroundShellStatus; view: LogView } {
    const entry = this.own(agentId, id);
    const view = this.view(entry.status, tailChars * 3);
    if (view.output.length > tailChars) Object.assign(view, { output: view.output.slice(-tailChars), truncated: true });
    return { task: this.copy(entry), view };
  }

  /** The agent's own command logs may be read like its workspace. */
  ownsLog(agentId: string, path: string): boolean {
    return [...this.entries.values()].some((entry) => entry.status.agentId === agentId && samePath(entry.status.logPath, path));
  }

  /** Every command the box may want to hear about: those running and those ended lately. */
  snapshot(): BackgroundShellStatus[] {
    return [...this.entries.values()].map((entry) => this.copy(entry));
  }

  /** The app is quitting: stop every command now, so none outlives it unseen. */
  shutdown(): void {
    for (const entry of this.entries.values()) {
      if (entry.status.state !== "running") continue;
      entry.stopping = "Stopped when the app quit.";
      if (entry.status.pid != null) killProcessTree(entry.status.pid, { sync: true });
      this.finish(entry, "aborted", null, entry.stopping, true);
    }
  }

  // ---- logs, the list, restarts -------------------------------------------------------------

  private logPath(id: number): string {
    return join(this.options.dir, `${id}.txt`);
  }

  private header(status: BackgroundShellStatus): string {
    return logHeader({ pid: status.pid, cwd: status.cwd, command: status.command, state: status.state, startedAt: status.startedAt, runningForMs: (status.endedAt ?? Date.now()) - status.startedAt });
  }

  /** Rewrites the header in place; it keeps its length, so the output after it stays where it is. */
  private refreshHeader(entry: Entry): void {
    const header = this.header(entry.status);
    if (Buffer.byteLength(header) !== entry.headerBytes) return;
    const fd = openSync(entry.status.logPath, "r+");
    try {
      writeSync(fd, header, 0, "utf8");
    } finally {
      closeSync(fd);
    }
  }

  private tick(entry: Entry): void {
    try {
      this.refreshHeader(entry);
      this.trim(entry);
    } catch (error) {
      this.options.log(`background command ${entry.status.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A log that grew past 50 MB keeps its header and the last 8 MB of output. */
  private trim(entry: Entry): void {
    const size = this.size(entry.status);
    if (size <= MAX_LOG_BYTES) return;
    const fd = openSync(entry.status.logPath, "r+");
    try {
      const kept = Buffer.alloc(KEEP_LOG_BYTES);
      const read = readSync(fd, kept, 0, KEEP_LOG_BYTES, size - KEEP_LOG_BYTES);
      ftruncateSync(fd, entry.headerBytes);
      writeSync(fd, Buffer.concat([Buffer.from("…[earlier output was removed: the log reached 50 MB]\n"), kept.subarray(0, read)]), 0, undefined, entry.headerBytes);
    } finally {
      closeSync(fd);
    }
  }

  private size(status: BackgroundShellStatus): number {
    try {
      return statSync(status.logPath).size;
    } catch {
      return 0;
    }
  }

  /** The log's output, its last `tailBytes` of it when it is longer. */
  private view(status: BackgroundShellStatus, tailBytes: number): LogView {
    let fd: number;
    try {
      fd = openSync(status.logPath, "r");
    } catch {
      return { output: "", outputBytes: 0, truncated: false, footer: null };
    }
    try {
      const size = statSync(status.logPath).size;
      const head = Buffer.alloc(Math.min(size, 8_192));
      readSync(fd, head, 0, head.length, 0);
      const tailStart = Math.max(0, size - tailBytes);
      const tail = Buffer.alloc(size - tailStart);
      readSync(fd, tail, 0, tail.length, tailStart);
      return readLogView(head, tail, tailStart, size);
    } finally {
      closeSync(fd);
    }
  }

  private own(agentId: string, id: number): Entry {
    const entry = Number.isInteger(id) ? this.entries.get(id) : undefined;
    if (entry == null || entry.status.agentId !== agentId) throw new ShellError(`There's no background command ${id} of yours on this computer.`);
    return entry;
  }

  private copy(entry: Entry): BackgroundShellStatus {
    return { ...entry.status };
  }

  /** Commands left from an earlier daemon: still alive (watched again), or lost. */
  private recover(): void {
    let stored: Partial<StoredList> = {};
    try {
      stored = JSON.parse(readFileSync(this.listPath, "utf8"));
    } catch {
      // first start, or a torn file
    }
    const rebooted = typeof stored.bootedAt !== "number" || Math.abs(stored.bootedAt - this.bootedAt) > 120_000;
    for (const status of Array.isArray(stored.shells) ? stored.shells : []) {
      if (typeof status?.id !== "number" || typeof status.logPath !== "string") continue;
      const entry = newEntry({ ...status, logPath: this.logPath(status.id) }, null);
      this.entries.set(status.id, entry);
      if (status.state !== "running") {
        entry.markEnded();
        continue;
      }
      try {
        entry.headerBytes = Buffer.byteLength(this.header(entry.status));
      } catch {
        entry.headerBytes = 0;
      }
      const alive = !rebooted && status.pid != null && processAlive(status.pid);
      // Windows: a command doesn't outlive the daemon, so a live process with its id is another one.
      if (alive && process.platform !== "win32") {
        entry.timers.push(setInterval(() => this.tick(entry), HEADER_REFRESH_MS).unref());
        entry.timers.push(
          setInterval(() => {
            if (status.pid != null && processAlive(status.pid)) return;
            this.finish(entry, entry.stopping != null ? "aborted" : "lost", null, entry.stopping ?? "Its exit code is unknown: it was started before the app's local tools last restarted.");
          }, WATCH_MS).unref(),
        );
        continue;
      }
      if (process.platform === "win32" && !rebooted && status.pid != null && !alive) stopOrphans(status.pid, status.startedAt);
      this.finish(entry, "lost", null, rebooted ? "The computer restarted while it was running." : "It stopped when the app's local tools restarted.", true);
    }
    this.prune();
    this.save();
  }

  private prune(): void {
    const ended = [...this.entries.values()].filter((entry) => entry.status.state !== "running").sort((a, b) => (b.status.endedAt ?? 0) - (a.status.endedAt ?? 0));
    ended.forEach((entry, index) => {
      if (index < MAX_KEPT && Date.now() - (entry.status.endedAt ?? 0) < KEEP_ENDED_MS) return;
      this.entries.delete(entry.status.id);
      rmSync(entry.status.logPath, { force: true });
    });
  }

  private save(): void {
    const list: StoredList = { schemaVersion: 1, bootedAt: this.bootedAt, shells: this.snapshot() };
    const temp = `${this.listPath}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(list, null, 1));
      replaceFileSync(temp, this.listPath);
    } catch (error) {
      this.options.log(`couldn't save the background command list: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
