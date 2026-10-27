// Background commands: a command an agent leaves running while it works on, on the user's PC (the
// local-exec daemon, src/local-exec/background.ts) or on the cloud computer (src/box/async-tasks.ts).
// Each has an id from 1000 to 999999 and a log file, `terminals/<id>.txt`:
//
//   ---
//   pid: 4242
//   cwd: C:\Users\me\…
//   command: npm run dev
//   title: npm run dev
//   status: running
//   started_at: 2026-10-26T14:00:00.000Z
//   running_for_ms: 5000
//   ---
//   …the output…
//   ---
//   exit_code: 0
//   elapsed_ms: 12345
//   ended_at: 2026-10-26T14:00:12.345Z
//   ---
//
// The header keeps its length (its changing values are padded), so it can be rewritten in place
// every 5 s while the output is appended after it; the footer is added when the command ends.
// Waiting on a command is a read of its file. This module holds what both computers share: the
// status the box is told, the log format, and what await_command says to the model.

export const SHELL_ID_MIN = 1000;
export const SHELL_ID_MAX = 999_999;
export const HEADER_REFRESH_MS = 5_000;
export const AWAIT_DEFAULT_MS = 30_000;
export const AWAIT_MAX_MS = 600_000;
const MAX_REGEX_LENGTH = 500;

/** The header's `status`, plus "lost": nothing saw it end (the app's local tools or the computer restarted). */
export type ShellState = "running" | "succeeded" | "failed" | "aborted" | "lost";

/** A background command as its computer reports it to the box. */
export interface BackgroundShellStatus {
  id: number;
  agentId: string;
  command: string;
  cwd: string;
  pid: number | null;
  /** The log file, on the computer it runs on. */
  logPath: string;
  state: ShellState;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  /** "spawned": started in the background; "adopted": a command that ran past its timeout and was left running. */
  origin: "spawned" | "adopted";
  /** Why it was stopped or lost, in words for the agent and the user. */
  detail?: string | null;
  /** The end of its output, once it has ended. */
  tail?: string | null;
}

const STATES: ShellState[] = ["running", "succeeded", "failed", "aborted", "lost"];

/** A status from another machine, checked field by field; null when it isn't one. */
export function parseShellStatus(value: unknown): BackgroundShellStatus | null {
  if (typeof value !== "object" || value == null) return null;
  const raw = value as Record<string, unknown>;
  const text = (key: string, max: number) => (typeof raw[key] === "string" ? (raw[key] as string).slice(0, max) : null);
  const number = (key: string) => (typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : null);
  const id = number("id");
  const agentId = text("agentId", 200);
  const command = text("command", 20_000);
  const logPath = text("logPath", 4096);
  const startedAt = number("startedAt");
  const state = STATES.find((candidate) => candidate === raw.state);
  if (id == null || !Number.isInteger(id) || id < SHELL_ID_MIN || id > SHELL_ID_MAX || agentId == null || command == null || logPath == null || startedAt == null || state == null) return null;
  return {
    id,
    agentId,
    command,
    cwd: text("cwd", 4096) ?? "",
    pid: number("pid"),
    logPath,
    state,
    exitCode: number("exitCode"),
    startedAt,
    endedAt: number("endedAt"),
    origin: raw.origin === "adopted" ? "adopted" : "spawned",
    detail: text("detail", 1000),
    tail: text("tail", 4000),
  };
}

/** A free id from 1000 to 999999. */
export function pickShellId(taken: (id: number) => boolean): number {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = SHELL_ID_MIN + Math.floor(Math.random() * (SHELL_ID_MAX - SHELL_ID_MIN + 1));
    if (!taken(id)) return id;
  }
  for (let id = SHELL_ID_MIN; id <= SHELL_ID_MAX; id++) if (!taken(id)) return id;
  throw new Error("Every background command id is in use.");
}

/** The command's first line, short: how lists name it. */
export function commandTitle(command: string): string {
  const line = command.split(/\r\n|\r|\n/).find((candidate) => candidate.trim().length > 0)?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

const oneLine = (text: string, max: number) => text.replace(/\r\n|\r|\n/g, "\\n").slice(0, max);

/** The header block. Its length doesn't change with the pid (up to 10 characters), the status or the running time. */
export function logHeader(fields: { pid: number | string | null; cwd: string; command: string; state: ShellState; startedAt: number; runningForMs: number }): string {
  return [
    "---",
    `pid: ${String(fields.pid ?? "").padEnd(10)}`,
    `cwd: ${oneLine(fields.cwd, 1000)}`,
    `command: ${oneLine(fields.command, 2000)}`,
    `title: ${commandTitle(fields.command)}`,
    `status: ${fields.state.padEnd(9)}`,
    `started_at: ${new Date(fields.startedAt).toISOString()}`,
    `running_for_ms: ${String(Math.max(0, Math.round(fields.runningForMs))).padEnd(13)}`,
    "---",
    "",
  ].join("\n");
}

export function logFooter(exitCode: number | null, elapsedMs: number, endedAt: number): string {
  return `\n---\nexit_code: ${exitCode ?? "unknown"}\nelapsed_ms: ${Math.max(0, Math.round(elapsedMs))}\nended_at: ${new Date(endedAt).toISOString()}\n---\n`;
}

const FOOTER = /\n---\nexit_code: (-?\d+|unknown)\nelapsed_ms: (\d+)\nended_at: ([^\n]*)\n---\n$/;

/** What a read of a log found. */
export interface LogView {
  /** The output, or its end when `truncated`. */
  output: string;
  /** Bytes of output in the file. */
  outputBytes: number;
  truncated: boolean;
  /** Once the command has ended. */
  footer: { exitCode: number | null; elapsedMs: number; endedAt: string } | null;
}

/** The header's length in bytes, from the file's first bytes (0 when there is none). */
export function headerLength(head: Buffer): number {
  if (!head.subarray(0, 4).equals(Buffer.from("---\n"))) return 0;
  const end = head.indexOf("\n---\n", 3);
  return end < 0 ? 0 : end + 5;
}

/** Reads a log from its first bytes, its last bytes (which start at `tailStart`) and its size. */
export function readLogView(head: Buffer, tail: Buffer, tailStart: number, size: number): LogView {
  const header = headerLength(head);
  const start = Math.max(tailStart, header);
  let text = tail.subarray(start - tailStart).toString("utf8");
  let footer: LogView["footer"] = null;
  let footerBytes = 0;
  const found = FOOTER.exec(text);
  if (found != null) {
    footerBytes = Buffer.byteLength(found[0]);
    footer = { exitCode: found[1] === "unknown" ? null : Number(found[1]), elapsedMs: Number(found[2]), endedAt: found[3] };
    text = text.slice(0, found.index);
  }
  const truncated = start > header;
  // A read that starts inside a character begins with replacement characters; Windows PowerShell may write byte order marks.
  if (truncated) text = text.replace(/^\uFFFD+/, "");
  return { output: text.replace(/\uFEFF/g, ""), outputBytes: Math.max(0, size - header - footerBytes), truncated, footer };
}

/** The last lines of a text, at most `maxChars` of them. */
export function lastLines(text: string, maxLines: number, maxChars: number): string {
  const lines = text.replace(/\s+$/, "").split(/\r?\n/);
  const kept = lines.slice(-maxLines).join("\n");
  return kept.length > maxChars ? kept.slice(-maxChars) : kept;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** The regular expression await_command waits for; matches line by line (^ and $ are line ends). */
export function compileAwaitRegex(pattern: string): RegExp {
  if (pattern.length > MAX_REGEX_LENGTH) throw new Error(`regex is longer than ${MAX_REGEX_LENGTH} characters.`);
  try {
    return new RegExp(pattern, "m");
  } catch (error) {
    throw new Error(`regex isn't a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function clampAwaitMs(value: unknown): number {
  const ms = Number(value);
  return Number.isFinite(ms) ? Math.min(Math.max(Math.round(ms), 0), AWAIT_MAX_MS) : AWAIT_DEFAULT_MS;
}

/** How it ended, in one line. */
export function endedLine(task: BackgroundShellStatus): string {
  const after = formatDuration((task.endedAt ?? Date.now()) - task.startedAt);
  switch (task.state) {
    case "running":
      return `Background command ${task.id} is still running (${after} so far).`;
    case "succeeded":
      return `Background command ${task.id} finished: exit code 0 after ${after}.`;
    case "failed":
      return `Background command ${task.id} failed: exit code ${task.exitCode ?? "unknown"} after ${after}.${task.detail ? ` ${task.detail}` : ""}`;
    case "aborted":
      return `Background command ${task.id} was stopped after ${after}.${task.detail ? ` ${task.detail}` : ""}`;
    case "lost":
      return `Background command ${task.id} was lost: ${task.detail ?? "its process is gone and nothing saw it end."}`;
  }
}

function outputBlock(view: LogView, running: boolean): string {
  if (view.output.trim().length === 0) return running ? "No output yet." : "No output.";
  return `Output${view.truncated ? ` (the end of ${formatBytes(view.outputBytes)})` : ""}:\n${view.output.replace(/\s+$/, "")}`;
}

/** What starting a background command tells the model. */
export function startedText(task: BackgroundShellStatus): string {
  return [
    `Started background command ${task.id}${task.pid != null ? ` (pid ${task.pid})` : ""}: ${commandTitle(task.command)}`,
    `Its output goes to ${task.logPath}. You'll get a message when it ends. Meanwhile await_command waits for it (or for a line of its output) and shows its output, and stop_command stops it.`,
  ].join("\n");
}

/** What a foreground command that ran past its timeout tells the model. */
export function adoptedText(task: BackgroundShellStatus, outputSoFar: string, timeoutMs: number): string {
  const output = outputSoFar.trim().length > 0 ? `${outputSoFar.replace(/\s+$/, "")}\n\n` : "";
  return `${output}Still running after ${formatDuration(timeoutMs)}, so it was left running as background command ${task.id} instead of being stopped. Its output goes to ${task.logPath}; you'll get a message when it ends. await_command waits for it, stop_command stops it.`;
}

/** What await_command found: the command, its output, and what the regex matched. */
export interface AwaitOutcome {
  task: BackgroundShellStatus;
  view: LogView;
  regexMatch: string | null;
  waitedMs: number;
}

export function awaitText(outcome: AwaitOutcome, regex: string | null): string {
  const running = outcome.task.state === "running";
  const lines = [endedLine(outcome.task)];
  if (regex != null) {
    lines.push(
      outcome.regexMatch != null
        ? `Its output matches /${regex}/: ${JSON.stringify(outcome.regexMatch.slice(0, 300))}`
        : `Its output doesn't match /${regex}/${running ? ` after waiting ${formatDuration(outcome.waitedMs)}` : ""}.`,
    );
  } else if (running) {
    lines.push(`Waited ${formatDuration(outcome.waitedMs)}.`);
  }
  lines.push(outputBlock(outcome.view, running), `Full output: ${outcome.task.logPath}`);
  return lines.join("\n");
}

/** What stop_command tells the model. */
export function stoppedText(task: BackgroundShellStatus): string {
  return task.state === "running" ? `Asked background command ${task.id} to stop; it hasn't ended yet. You'll get a message when it does.` : endedLine(task);
}

/** The tools' parameters, the same on the PC and the cloud computer. */
export const BACKGROUND_PARAMETER = {
  type: "boolean",
  description: "Start the command and return at once with its id, leaving it running: for servers, watchers and long builds. You get a message when it ends.",
};

export const AWAIT_COMMAND_DESCRIPTION =
  "Wait for a background command (one started with run_shell's background option, or one that ran past its timeout) to end, or for its output to match a regular expression; then show its status and the end of its output. block_until_ms 0 just checks.";

export const AWAIT_COMMAND_PARAMETERS = {
  type: "object",
  properties: {
    id: { type: "integer", description: "The background command's id." },
    block_until_ms: { type: "integer", description: `Wait at most this long (default ${AWAIT_DEFAULT_MS}, max ${AWAIT_MAX_MS}).` },
    regex: { type: "string", description: "Return as soon as the command's output so far matches this JavaScript regular expression (^ and $ match at line ends), e.g. a server's ready line." },
  },
  required: ["id"],
  additionalProperties: false,
};

export const STOP_COMMAND_DESCRIPTION = "Stop a background command you started, and every process it started.";

export const STOP_COMMAND_PARAMETERS = {
  type: "object",
  properties: { id: { type: "integer", description: "The background command's id." } },
  required: ["id"],
  additionalProperties: false,
};
