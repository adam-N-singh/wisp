// Background work agents leave running: async tasks (`readAsyncTasks`, `AsyncTaskInfo`, the
// "background-work" channel, the "Async tasks" panel). For now that is background commands
// (`kind` "shell"), on the user's PC, where the local-exec daemon runs them
// (src/local-exec/background.ts), or on the cloud computer, where this box runs them; `kind`
// leaves room for subagents.
//
// The box keeps a record of each (tasks.json). The daemon reports a command's start and end as
// they happen, and its whole list each time it registers, so what changed while the PC was
// offline, or while this box was down, still arrives; a running command the daemon has no record
// of any more is lost. Cloud commands are checked on every 5 s while they run (which also keeps
// the sandbox from pausing under them), unless the user paused the cloud computer.
//
// The checks also rewrite a cloud command's log header in place, and say how it
// ended in it, as the daemon does on the PC; the panel's output reads leave a
// paused cloud computer paused.
//
// When a task ends without the agent seeing it, the agent gets a hidden message saying how, and
// is woken unless the task was stopped. An await_command waiting on the task reports its end
// instead. The agent's roster row counts its running tasks (`asyncTaskCount`), so it shows as
// working meanwhile.
//
// Beside the running list, the box lists the tasks that ended in the last week
// (`getEndedAsyncTasks`, the panel's Ended section) and stops all of an agent's at once
// (`cancelAllAsyncTasks`), each told to the agent as one Stop is.
import {
  type AwaitOutcome,
  type BackgroundShellStatus,
  clampAwaitMs,
  commandTitle,
  compileAwaitRegex,
  formatDuration,
  lastLines,
  logFooter,
  logHeader,
  type LogView,
  pickShellId,
  readLogView,
  type ShellState,
} from "../shared/background-shell";
import type { ToolResult } from "../shared/gateway-protocol";
import type { AgentSummary, AsyncTaskInfo, AsyncTaskOutput, CloudComputerStatus, EndedAsyncTask, StopAllAsyncTasksResult } from "../shared/model";
import { CLOUD_PID_PLACEHOLDER, CLOUD_TERMINALS, type CloudComputer } from "./cloud-computer";
import type { CloudShells } from "./cloud-tools";
import type { BoxStore } from "./store";

export type AsyncTaskStatus = AsyncTaskOutput["status"];

/** A task as tasks.json keeps it. */
export interface AsyncTaskRecord {
  /** "local:<shell id>" or "cloud:<shell id>"; the id `readAsyncTasks` gives it. */
  key: string;
  agentId: string;
  kind: AsyncTaskInfo["kind"];
  computer: "local" | "cloud";
  shellId: number;
  command: string;
  cwd: string;
  /** Its log, on the computer it runs on. */
  outputPath: string;
  /** The PC's host name, or the cloud computer's sandbox id. */
  machine: string | null;
  pid: number | null;
  origin: BackgroundShellStatus["origin"];
  status: AsyncTaskStatus;
  exitCode: number | null;
  startedAtMs: number;
  endedAtMs: number | null;
  detail: string | null;
  /** The end of its output, once it has ended. */
  tail: string | null;
  /** It was running when the box last stopped, and was picked up again. */
  reattached?: boolean;
  /** Who asked it to stop. */
  stoppedBy?: "agent" | "user" | null;
  /** The agent knows how it ended: it waited for it, stopped it, or was told. */
  notified: boolean;
  /** The PC's daemon no longer keeps its log (it dropped the command from its list). */
  logGone?: boolean;
}

export class AsyncTaskError extends Error {
  constructor(
    readonly code: "missing" | "offline" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export interface AsyncTaskDeps {
  store: BoxStore;
  emit(channel: string, payload: unknown): void;
  patchAgent(agentId: string, patch: Partial<AgentSummary>): void;
  /** A task ended without the agent seeing it: tell it, and wake it when `wake`. */
  ended(record: AsyncTaskRecord, text: string, wake: boolean): void;
  /** Stops a command on the PC, or reads its output, through the daemon; throws an "offline" AsyncTaskError when it isn't connected. */
  controlLocal(request: { agentId: string; shellId: number; action: "stop" | "output"; tailChars?: number }): Promise<ToolResult>;
  /** The connected PC's name, or null while none is. */
  localHost(): string | null;
  cloud: CloudComputer | null;
  log(line: string): void;
  /** How often running cloud commands are checked on (tests shorten it). */
  cloudPollMs?: number;
}

const CLOUD_POLL_MS = 5_000;
const CLOUD_AWAIT_POLL_MS = 2_000;
const AWAIT_TAIL_CHARS = 10_000;
/** What a cloud await matches its regex against (it's read over the network every 2 s). */
const CLOUD_REGEX_WINDOW_BYTES = 256 * 1024;
const KEEP_ENDED_MS = 7 * 24 * 3_600_000;
const MAX_KEPT = 500;
/** An ended command the box first hears of in a daemon's list is only told of while it's this recent. */
const LATE_NEWS_MS = 3_600_000;

const statusFor = (state: Exclude<ShellState, "running">, stopped: boolean): Exclude<AsyncTaskStatus, "running"> => (stopped || state === "aborted" ? "stopped" : state);
const stateFor = (status: AsyncTaskStatus): ShellState => (status === "stopped" ? "aborted" : status);
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true });
  });

/** What the agent is told when a task ended without it seeing. */
export function completionText(record: AsyncTaskRecord): string {
  const after = formatDuration((record.endedAtMs ?? Date.now()) - record.startedAtMs);
  const name = `Background command ${record.shellId}`;
  const head =
    record.status === "succeeded"
      ? `${name} finished: exit code 0 after ${after}`
      : record.status === "failed"
        ? `${name} failed: exit code ${record.exitCode ?? "unknown"} after ${after}`
        : record.status === "stopped"
          ? `${name} was stopped${record.stoppedBy === "user" ? " by the user" : ""} after ${after}`
          : `${name} was lost: ${record.detail ?? "its process is gone and nothing saw it end."}`;
  const lines = [`[${head}]`, `Command: ${record.command.replace(/\s+/g, " ").slice(0, 300)}`];
  if (record.detail != null && record.status !== "lost" && record.stoppedBy !== "user") lines.push(record.detail);
  if (record.tail != null && record.tail.trim().length > 0) lines.push("Last output:", record.tail);
  lines.push(`Full output: ${record.outputPath}${record.computer === "cloud" ? " on the cloud computer" : ""}.`);
  return lines.join("\n");
}

export class AsyncTasks implements CloudShells {
  private records = new Map<string, AsyncTaskRecord>();
  /** Tasks an await_command is waiting on, by key, and how many such waits there are. */
  private waits = new Map<string, number>();
  private pollTimer: NodeJS.Timeout | null = null;
  /** Cloud commands were running when the box stopped: the first check resumes the cloud computer for them. */
  private reattachCloud = false;
  /** Each cloud task's output as last read, shown while the cloud computer is paused. */
  private cloudOutputs = new Map<string, Pick<AsyncTaskOutput, "text" | "truncated" | "outputBytes">>();

  constructor(private readonly deps: AsyncTaskDeps) {
    for (const record of deps.store.tasks()) {
      if (record.status === "running") record.reattached = true;
      this.records.set(record.key, record);
    }
    this.reattachCloud = [...this.records.values()].some((record) => record.computer === "cloud" && record.status === "running");
  }

  /** Once the harness is up: the roster counts again, and the cloud computer's commands checked on. */
  start(): void {
    for (const agentId of new Set(this.runningRecords().map((record) => record.agentId))) this.changed(agentId);
    this.schedulePoll();
  }

  stop(): void {
    if (this.pollTimer != null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  // ---- what the gateway reads ------------------------------------------------------------

  /** The agent's running tasks, oldest first. */
  info(agentId: string): AsyncTaskInfo[] {
    const host = this.deps.localHost();
    return this.runningRecords(agentId).map((record) => {
      const detail =
        record.computer === "local" && host == null
          ? `${record.machine ?? "The PC"} is offline; this updates when it connects again.`
          : record.reattached === true
            ? "Picked up again after the box restarted."
            : undefined;
      return {
        id: record.key,
        kind: record.kind,
        label: commandTitle(record.command),
        labelKind: "shell_command",
        labelParams: { id: String(record.shellId) },
        startedAtMs: record.startedAtMs,
        status: "running",
        detailKind: record.reattached === true ? "reattached" : null,
        ...(detail != null ? { detail } : {}),
        command: record.command,
        computer: record.computer,
        computerLabel: record.computer === "cloud" ? "Cloud computer" : (record.machine ?? "This PC"),
        outputPath: record.outputPath,
      };
    });
  }

  /** The agent's tasks that ended (in the last week, as the box keeps them), newest first. */
  ended(agentId: string, limit = 10): EndedAsyncTask[] {
    return [...this.records.values()]
      .filter((record) => record.agentId === agentId && record.status !== "running")
      .sort((a, b) => (b.endedAtMs ?? 0) - (a.endedAtMs ?? 0))
      .slice(0, limit)
      .map((record) => ({
        id: record.key,
        kind: record.kind,
        label: commandTitle(record.command),
        labelKind: "shell_command",
        labelParams: { id: String(record.shellId) },
        command: record.command,
        computer: record.computer,
        computerLabel: record.computer === "cloud" ? "Cloud computer" : (record.machine ?? "This PC"),
        outputPath: record.outputPath,
        status: record.status as EndedAsyncTask["status"],
        exitCode: record.exitCode,
        startedAtMs: record.startedAtMs,
        endedAtMs: record.endedAtMs ?? record.startedAtMs,
        ...(record.stoppedBy != null ? { stoppedBy: record.stoppedBy } : {}),
        ...(record.detail != null ? { detail: record.detail } : {}),
        ...(record.tail != null && record.tail.length > 0 ? { tail: record.tail } : {}),
        logExists: record.computer === "local" && record.logGone !== true,
      }));
  }

  record(key: string): AsyncTaskRecord | undefined {
    return this.records.get(key);
  }

  // ---- news from the computers -------------------------------------------------------------

  /**
   * A command's status, from the tool call that started it, a daemon's report or a check here.
   * Its record only moves forward: once ended it stays as it ended.
   */
  noteShell(computer: "local" | "cloud", status: BackgroundShellStatus, machine: string | null, options: { told?: boolean; stoppedBy?: "agent" } = {}): AsyncTaskRecord | null {
    const key = `${computer}:${status.id}`;
    let record = this.records.get(key);
    if (record != null && record.agentId !== status.agentId) return null;
    const isNew = record == null;
    if (record == null) {
      if (this.deps.store.getAgent(status.agentId) == null) return null;
      record = {
        key,
        agentId: status.agentId,
        kind: "shell",
        computer,
        shellId: status.id,
        command: status.command,
        cwd: status.cwd,
        outputPath: status.logPath,
        machine,
        pid: status.pid,
        origin: status.origin,
        status: "running",
        exitCode: null,
        startedAtMs: status.startedAt,
        endedAtMs: null,
        detail: null,
        tail: null,
        notified: false,
      };
      this.records.set(key, record);
    }
    if (options.stoppedBy != null) {
      record.stoppedBy ??= options.stoppedBy;
      record.notified = true;
    }
    if (record.status === "running") {
      record.pid = status.pid ?? record.pid;
      record.outputPath = status.logPath;
      if (machine != null) record.machine = machine;
    }
    if (record.status === "running" && status.state !== "running") {
      this.end(record, statusFor(status.state, record.stoppedBy != null), status.exitCode, status.endedAt ?? Date.now(), status.detail ?? null, status.tail ?? null, options.told === true);
    } else {
      this.save();
      if (isNew) this.changed(record.agentId);
    }
    return record;
  }

  /**
   * A daemon registered with its list. Each command in it counts as news; a running command of
   * that PC's that isn't in it is lost (the daemon's own list was cleared). The daemon drops an
   * ended command with its log, so one missing from the list has no log to open any more.
   */
  reconcileLocal(machine: string | null, list: BackgroundShellStatus[]): void {
    const listed = new Set(list.map((status) => `local:${status.id}`));
    for (const status of list) {
      // Old news of a command the box never knew stays old.
      if (!this.records.has(`local:${status.id}`) && status.state !== "running" && Date.now() - (status.endedAt ?? 0) > LATE_NEWS_MS) continue;
      this.noteShell("local", status, machine);
    }
    let logsGone = false;
    for (const record of [...this.records.values()]) {
      if (record.computer !== "local" || listed.has(record.key) || record.logGone === true) continue;
      if (machine != null && record.machine != null && record.machine !== machine) continue; // another PC's
      record.logGone = true;
      logsGone = true;
      if (record.status === "running") this.end(record, record.stoppedBy != null ? "stopped" : "lost", null, Date.now(), "The PC's local tools have no record of it any more.", null, false);
    }
    if (logsGone) this.save();
  }

  /** The cloud computer changed: deleted, its commands are lost; running, they're checked on. */
  cloudChanged(status: CloudComputerStatus): void {
    if (status.state === "none") {
      for (const record of this.runningRecords()) if (record.computer === "cloud") this.end(record, "lost", null, Date.now(), "The cloud computer it ran on was deleted.", null, false);
    }
    if (status.state === "running") this.schedulePoll();
  }

  /**
   * An await_command on the task begins: an end that comes meanwhile is the await's to report.
   * Call what this returns when the await does, saying whether its result told the agent the end.
   */
  awaiting(computer: "local" | "cloud", shellId: number): (told: boolean) => void {
    const key = `${computer}:${shellId}`;
    this.waits.set(key, (this.waits.get(key) ?? 0) + 1);
    let released = false;
    return (told) => {
      if (released) return;
      released = true;
      const left = (this.waits.get(key) ?? 1) - 1;
      if (left > 0) this.waits.set(key, left);
      else this.waits.delete(key);
      const record = this.records.get(key);
      if (record == null || record.status === "running") return;
      if (told && !record.notified) {
        record.notified = true;
        this.save();
      }
      if (left <= 0) this.tell(record);
    };
  }

  // ---- the user's actions --------------------------------------------------------------------

  /** Stops the task (the panel's Stop): the agent is told, but not woken. */
  async cancel(agentId: string, key: string): Promise<void> {
    const record = this.own(agentId, key);
    if (record.status !== "running") return;
    if (record.computer === "cloud") {
      await this.stopCloud(agentId, record.shellId, "user");
      return;
    }
    const before = record.stoppedBy ?? null;
    record.stoppedBy ??= "user";
    this.save();
    try {
      const result = await this.deps.controlLocal({ agentId, shellId: record.shellId, action: "stop" });
      if (result.kind !== "ok") throw new AsyncTaskError("failed", "message" in result ? result.message : "The command couldn't be stopped.");
      if (result.task != null) this.noteShell("local", result.task, record.machine);
    } catch (error) {
      this.unstop(record, before);
      throw error;
    }
  }

  /** Stops each of the agent's running tasks as `cancel` does; those that can't be reached are reported, not thrown. */
  async cancelAll(agentId: string): Promise<StopAllAsyncTasksResult> {
    const running = this.runningRecords(agentId);
    const outcomes = await Promise.allSettled(running.map((record) => this.cancel(agentId, record.key)));
    const result: StopAllAsyncTasksResult = { stopped: [], failed: [] };
    outcomes.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") result.stopped.push(running[index].key);
      else result.failed.push({ id: running[index].key, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
    });
    return result;
  }

  /** A stop that never reached the command: it may still end on its own, and should be told as that. */
  private unstop(record: AsyncTaskRecord, before: AsyncTaskRecord["stoppedBy"], notified = record.notified): void {
    if (record.status !== "running") return;
    record.stoppedBy = before;
    record.notified = notified;
    this.save();
  }

  /** The end of the task's output so far. */
  async readOutput(agentId: string, key: string, tailChars: number): Promise<AsyncTaskOutput> {
    const record = this.own(agentId, key);
    if (record.computer === "cloud") {
      // Reading would wake a paused cloud computer, so a paused one shows what was read last.
      const state = this.requireCloud().status().state;
      if (state !== "running" && state !== "starting") {
        const last = this.cloudOutputs.get(key);
        return { text: last?.text ?? record.tail ?? "", truncated: last?.truncated ?? false, outputBytes: last?.outputBytes ?? 0, status: record.status, exitCode: record.exitCode, note: "The cloud computer is paused, so this is the output from before. It updates once the cloud computer runs again." };
      }
      const view = await this.cloudView(record, tailChars * 3);
      const output = view.output.length > tailChars ? view.output.slice(-tailChars) : view.output;
      const read = { text: output, truncated: view.truncated || output.length < view.output.length, outputBytes: view.outputBytes };
      this.cloudOutputs.set(key, read);
      return { ...read, status: record.status, exitCode: record.exitCode };
    }
    const result = await this.deps.controlLocal({ agentId, shellId: record.shellId, action: "output", tailChars });
    if (result.kind !== "ok") throw new AsyncTaskError("failed", "message" in result ? result.message : "The output couldn't be read.");
    if (result.task != null) this.noteShell("local", result.task, record.machine);
    return { text: result.output, truncated: result.log?.truncated ?? false, outputBytes: result.log?.outputBytes ?? Buffer.byteLength(result.output), status: record.status, exitCode: record.exitCode };
  }

  /** The agent was deleted: its running tasks are stopped (as far as they can be) and forgotten. */
  forgetAgent(agentId: string): void {
    for (const record of [...this.records.values()]) {
      if (record.agentId !== agentId) continue;
      this.records.delete(record.key);
      this.cloudOutputs.delete(record.key);
      if (record.status !== "running") continue;
      const stopping = record.computer === "cloud" ? this.deps.cloud?.stopBackground(record.pid ?? 0) : this.deps.controlLocal({ agentId, shellId: record.shellId, action: "stop" });
      void Promise.resolve(stopping).catch((error) => this.deps.log(`couldn't stop background command ${record.shellId} of a deleted agent: ${error instanceof Error ? error.message : String(error)}`));
    }
    this.save();
  }

  // ---- the cloud computer's commands (CloudShells, for cloud-tools.ts) -------------------------------

  async startCloud(agentId: string, command: string, cwd: string): Promise<BackgroundShellStatus> {
    const cloud = this.requireCloud();
    const id = pickShellId((candidate) => this.records.has(`cloud:${candidate}`));
    const logPath = `${CLOUD_TERMINALS}/${id}.txt`;
    const startedAt = Date.now();
    // The wrapper puts its pid in, padded to the placeholder's 10 characters, so the header keeps its length.
    const header = logHeader({ pid: CLOUD_PID_PLACEHOLDER, cwd, command, state: "running", startedAt, runningForMs: 0 });
    const { pid } = await cloud.startBackground({ command, cwd, logPath, header });
    const status: BackgroundShellStatus = { id, agentId, command, cwd, pid, logPath, state: "running", exitCode: null, startedAt, endedAt: null, origin: "spawned" };
    this.noteShell("cloud", status, cloud.status().sandboxId);
    this.schedulePoll();
    return status;
  }

  async awaitCloud(agentId: string, shellId: number, options: { blockUntilMs?: unknown; regex: string | null; signal: AbortSignal }): Promise<AwaitOutcome> {
    const record = this.ownShell(agentId, "cloud", shellId);
    const pattern = options.regex != null ? compileAwaitRegex(options.regex) : null;
    const started = Date.now();
    const deadline = started + clampAwaitMs(options.blockUntilMs);
    const release = this.awaiting("cloud", shellId);
    let told = false;
    try {
      for (;;) {
        if (options.signal.aborted) throw new Error("interrupted");
        const view = await this.cloudView(record, pattern != null ? CLOUD_REGEX_WINDOW_BYTES : AWAIT_TAIL_CHARS * 3);
        if (record.status === "running" && view.footer != null) this.endCloud(record, view.footer.exitCode, view);
        const match = pattern?.exec(view.output) ?? null;
        if (match != null || record.status !== "running" || Date.now() >= deadline) {
          told = record.status !== "running";
          const shown = view.output.length > AWAIT_TAIL_CHARS ? { ...view, output: view.output.slice(-AWAIT_TAIL_CHARS), truncated: true } : view;
          return { task: this.statusOf(record), view: shown, regexMatch: match?.[0] ?? null, waitedMs: Date.now() - started };
        }
        await sleep(Math.min(CLOUD_AWAIT_POLL_MS, deadline - Date.now()), options.signal);
      }
    } finally {
      release(told);
    }
  }

  async stopCloud(agentId: string, shellId: number, by: "agent" | "user"): Promise<BackgroundShellStatus> {
    const record = this.ownShell(agentId, "cloud", shellId);
    if (record.status !== "running") return this.statusOf(record);
    const before = record.stoppedBy ?? null;
    const notified = record.notified;
    record.stoppedBy ??= by;
    if (by === "agent") record.notified = true;
    this.save();
    const cloud = this.requireCloud();
    try {
      if (record.pid != null) await cloud.stopBackground(record.pid);
    } catch (error) {
      this.unstop(record, before, notified);
      throw error;
    }
    const view = await this.cloudView(record, 4_000).catch(() => null);
    const now = Date.now();
    // Its wrapper writes the footer when it gets to; one stopped outright gets one here.
    if (view != null && view.footer == null) await cloud.appendText(record.outputPath, logFooter(null, now - record.startedAtMs, now)).catch(() => undefined);
    if (record.status === "running") this.end(record, "stopped", view?.footer?.exitCode ?? null, now, by === "user" ? "Stopped by the user." : "Stopped by the agent.", view != null ? lastLines(view.output, 20, 2_000) : null, by === "agent");
    return this.statusOf(record);
  }

  // ---- inside -------------------------------------------------------------------------------

  private runningRecords(agentId?: string): AsyncTaskRecord[] {
    return [...this.records.values()].filter((record) => record.status === "running" && (agentId == null || record.agentId === agentId)).sort((a, b) => a.startedAtMs - b.startedAtMs);
  }

  private own(agentId: string, key: string): AsyncTaskRecord {
    const record = this.records.get(key);
    if (record == null || record.agentId !== agentId) throw new AsyncTaskError("missing", "That task isn’t there any more.");
    return record;
  }

  private ownShell(agentId: string, computer: "local" | "cloud", shellId: number): AsyncTaskRecord {
    const record = Number.isInteger(shellId) ? this.records.get(`${computer}:${shellId}`) : undefined;
    if (record == null || record.agentId !== agentId) throw new AsyncTaskError("missing", `There's no background command ${shellId} of yours on the ${computer === "cloud" ? "cloud computer" : "user's computer"}.`);
    return record;
  }

  private statusOf(record: AsyncTaskRecord): BackgroundShellStatus {
    return {
      id: record.shellId,
      agentId: record.agentId,
      command: record.command,
      cwd: record.cwd,
      pid: record.pid,
      logPath: record.outputPath,
      state: stateFor(record.status),
      exitCode: record.exitCode,
      startedAt: record.startedAtMs,
      endedAt: record.endedAtMs,
      origin: record.origin,
      detail: record.detail,
      tail: record.tail,
    };
  }

  private end(record: AsyncTaskRecord, status: Exclude<AsyncTaskStatus, "running">, exitCode: number | null, endedAt: number, detail: string | null, tail: string | null, told: boolean): void {
    if (record.status !== "running") return;
    Object.assign(record, { status, exitCode, endedAtMs: endedAt, detail, tail });
    if (told) record.notified = true;
    this.cloudOutputs.delete(record.key);
    this.save();
    this.changed(record.agentId);
    this.tell(record);
    if (record.computer === "cloud") void this.finishCloudHeader(record);
  }

  /** The cloud log's header as the PC's daemon writes its own: the same length whatever the status and time. */
  private cloudHeader(record: AsyncTaskRecord, state: ShellState, runningForMs: number): string {
    return logHeader({ pid: record.pid, cwd: record.cwd, command: record.command, state, startedAt: record.startedAtMs, runningForMs });
  }

  /** An ended cloud command's header says how it ended, while its sandbox is still there to write to. */
  private async finishCloudHeader(record: AsyncTaskRecord): Promise<void> {
    const cloud = this.deps.cloud;
    const state = cloud?.status();
    if (cloud == null || state?.state !== "running" || state.sandboxId == null || (record.machine != null && record.machine !== state.sandboxId)) return;
    try {
      await cloud.rewriteLogHeader(record.outputPath, this.cloudHeader(record, stateFor(record.status), (record.endedAtMs ?? Date.now()) - record.startedAtMs));
    } catch (error) {
      this.deps.log(`couldn't finish background command ${record.shellId}'s log: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Tells the agent how the task ended, unless it knows or an await on it will say. */
  private tell(record: AsyncTaskRecord): void {
    if (record.notified || (this.waits.get(record.key) ?? 0) > 0 || this.deps.store.getAgent(record.agentId) == null) return;
    record.notified = true;
    this.save();
    this.deps.ended(record, completionText(record), record.status !== "stopped");
  }

  private changed(agentId: string): void {
    if (this.deps.store.getAgent(agentId) == null) return;
    const tasks = this.info(agentId);
    if ((this.deps.store.getAgent(agentId)?.asyncTaskCount ?? 0) !== tasks.length) this.deps.patchAgent(agentId, { asyncTaskCount: tasks.length });
    this.deps.emit("background-work", { parentAgentId: agentId, tasks });
  }

  private save(): void {
    const now = Date.now();
    const ended = [...this.records.values()].filter((record) => record.status !== "running").sort((a, b) => (b.endedAtMs ?? 0) - (a.endedAtMs ?? 0));
    ended.forEach((record, index) => {
      if (index >= MAX_KEPT || now - (record.endedAtMs ?? 0) > KEEP_ENDED_MS) this.records.delete(record.key);
    });
    this.deps.store.saveTasks([...this.records.values()]);
  }

  private requireCloud(): CloudComputer {
    if (this.deps.cloud == null) throw new AsyncTaskError("failed", "The cloud computer isn't available in this box.");
    return this.deps.cloud;
  }

  private async cloudView(record: AsyncTaskRecord, tailBytes: number): Promise<LogView> {
    const read = await this.requireCloud().readLog(record.outputPath, tailBytes);
    return read == null ? { output: "", outputBytes: 0, truncated: false, footer: null } : readLogView(read.head, read.tail, read.tailStart, read.size);
  }

  private endCloud(record: AsyncTaskRecord, exitCode: number | null, view: LogView | null): void {
    this.end(record, record.stoppedBy != null ? "stopped" : exitCode === 0 ? "succeeded" : "failed", exitCode, Date.now(), null, view != null ? lastLines(view.output, 20, 2_000) : null, false);
  }

  private schedulePoll(): void {
    if (this.pollTimer != null || !this.runningRecords().some((record) => record.computer === "cloud")) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollCloud()
        .catch((error) => this.deps.log(`cloud background check failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => this.schedulePoll());
    }, this.deps.cloudPollMs ?? CLOUD_POLL_MS);
    this.pollTimer.unref?.();
  }

  private async pollCloud(): Promise<void> {
    const cloud = this.deps.cloud;
    const running = this.runningRecords().filter((record) => record.computer === "cloud");
    if (cloud == null || running.length === 0) return;
    const state = cloud.status();
    // A cloud computer the user paused stays paused: its commands wait, frozen, until it runs again.
    if (state.state !== "running" && !this.reattachCloud) return;
    this.reattachCloud = false;
    const live = running.filter((record) => {
      if (state.sandboxId != null && (record.machine == null || record.machine === state.sandboxId)) return true;
      this.end(record, "lost", null, Date.now(), "The cloud computer it ran on was deleted.", null, false);
      return false;
    });
    if (live.length === 0) return;
    // The same check rewrites each live one's header, as the daemon does on the PC every 5 s.
    const now = Date.now();
    const states = await cloud.backgroundStates(live.map((record) => ({ id: record.shellId, pid: record.pid ?? 0, logPath: record.outputPath, header: this.cloudHeader(record, "running", now - record.startedAtMs) })));
    for (const record of live) {
      const found = states.get(record.shellId);
      if (found == null || record.status !== "running" || (found.alive && found.exitCode == null)) continue;
      const view = await this.cloudView(record, 4_000).catch(() => null);
      if (found.exitCode != null) this.endCloud(record, found.exitCode, view);
      else this.end(record, record.stoppedBy != null ? "stopped" : "lost", null, Date.now(), "Its process on the cloud computer is gone, and its log has no exit code.", view != null ? lastLines(view.output, 20, 2_000) : null, false);
    }
  }
}
