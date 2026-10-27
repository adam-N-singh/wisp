// Tools the local-exec daemon offers on the user's computer. `plan` describes
// the action for the policy (risk, grant scope, write targets); `execute` runs
// it. Descriptors (name/description/JSON Schema) are what the model sees.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  adoptedText,
  AWAIT_COMMAND_DESCRIPTION,
  AWAIT_COMMAND_PARAMETERS,
  awaitText,
  BACKGROUND_PARAMETER,
  type BackgroundShellStatus,
  startedText,
  STOP_COMMAND_DESCRIPTION,
  STOP_COMMAND_PARAMETERS,
  stoppedText,
} from "../shared/background-shell";
import type { BrowserPlanInfo, BrowserRunReply, BrowserToolName } from "../shared/agent-browser";
import type { LocalToolDescriptor } from "../shared/gateway-protocol";
import type { LocalToolAction, Risk } from "../shared/model";
import { type BackgroundShells, killProcessTree } from "./background";
import { classifyBash } from "./bash-classify";
import { BROWSER_TOOLS } from "./browser-tools";
import { classifyPowerShell } from "./powershell-classify";
import { dirScope, isInside } from "./policy";
import { mentionsSensitiveLocation } from "./sensitive";

/** Reads inside the agent's workspace are read-only; elsewhere they ask; credential stores are dangerous. */
function readRisk(path: string, workspace: string): { risk: Risk; reasons: string[] } {
  if (mentionsSensitiveLocation(path)) return { risk: "dangerous", reasons: [`${path} may contain credentials or keys`] };
  if (isInside(path, workspace)) return { risk: "read-only", reasons: [] };
  return { risk: "unknown", reasons: [`reads outside the agent's workspace: ${path}`] };
}

export interface ToolContext {
  agentId: string;
  cwd: string;
  wasmDir: string;
  signal: AbortSignal;
  progress(chunk: string): void;
  /** Background commands on this computer (background.ts). */
  shells: BackgroundShells;
  /** What the policy rated this call as; set before it runs. */
  plan?: ToolPlan;
  /** The user's answer, when the call comes back after asking them (ToolOutput.askUser). */
  answer?: string | null;
  host: {
    grabScreen(): Promise<{ pngBase64: string; width: number; height: number } | null>;
    getClipboardText(): Promise<string>;
    putClipboardText(text: string): Promise<void>;
    openInBrowser(url: string): Promise<void>;
    /** The agent browser, which main drives (src/main/agent-browser.ts). */
    browser: {
      plan(call: { agentId: string; tool: BrowserToolName; args: Record<string, unknown> }): Promise<BrowserPlanInfo>;
      run(call: { agentId: string; tool: BrowserToolName; args: Record<string, unknown>; expectSite: string | null; callId: string; answer: string | null }): Promise<BrowserRunReply>;
      cancel(call: { callId: string }): Promise<void>;
    };
  };
}

export interface ToolPlan {
  risk: Risk;
  reasons: string[];
  scope: string;
  paths: string[];
  /** How the approval card describes the action. */
  action: LocalToolAction;
  target: string;
  title: string;
}

export interface ToolOutput {
  output: string;
  image?: { mime: string; base64: string } | null;
  /** The background command the call started, waited for or stopped. */
  task?: BackgroundShellStatus;
  /** Ask the user this in the chat, then run the call again with their answer. */
  askUser?: { question: string; options: string[] } | null;
}

export interface LocalTool {
  descriptor: LocalToolDescriptor;
  /** Acts only on background commands the agent started, whose start was approved: it asks nothing of its own. */
  skipsPolicy?: true;
  plan(args: any, context: ToolContext): Promise<ToolPlan> | ToolPlan;
  execute(args: any, context: ToolContext): Promise<ToolOutput>;
}

const SHELL_OUTPUT_LIMIT = 100_000;
const READ_LINE_LIMIT = 2000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "build", "out", ".next", ".cache", "__pycache__", ".venv", "venv", "target"]);
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

const usesPowerShell = process.platform === "win32" && process.env.WISP_SHELL !== "bash";

/** The shell a command line runs in, as a program and its arguments. */
export function shellInvocation(command: string): [string, string[]] {
  return usesPowerShell
    ? ["powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`]]
    : [process.env.SHELL || "/bin/bash", ["-lc", command]];
}

const shellEnv = (): NodeJS.ProcessEnv => ({ ...process.env, TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" });

export function resolvePath(path: unknown, cwd: string): string {
  const raw = String(path ?? "").trim();
  if (raw.length === 0) return cwd;
  const expanded = raw === "~" ? homedir() : raw.startsWith("~/") || raw.startsWith("~\\") ? join(homedir(), raw.slice(2)) : raw;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

export const LOCAL_TOOLS: Record<string, LocalTool> = {
  run_shell: {
    descriptor: {
      name: "run_shell",
      description: usesPowerShell
        ? "Run a PowerShell command on the user's Windows computer and return its combined output and exit code. Commands run non-interactively; avoid anything that waits for input. Read-only commands usually run immediately; others may need the user's approval. With background, it starts the command and returns at once; a command still running at its timeout is left running in the background too."
        : "Run a shell command on the user's computer (login shell, non-interactive) and return its combined output and exit code. Avoid anything that waits for input. Read-only commands usually run immediately; others may need the user's approval. With background, it starts the command and returns at once; a command still running at its timeout is left running in the background too.",
      parameters: object(
        {
          command: { type: "string", description: "The command line to run." },
          cwd: { type: "string", description: "Working directory (defaults to your workspace)." },
          timeout_ms: { type: "integer", description: "Wait this long for it to finish (default 120000, max 600000); after that it goes on in the background." },
          background: BACKGROUND_PARAMETER,
        },
        ["command"],
      ),
      permissionId: "shell",
      readOnly: false,
    },
    async plan(args, context) {
      const command = String(args.command ?? "");
      const verdict = usesPowerShell ? classifyPowerShell(command) : await classifyBash(command, context.wasmDir);
      const program = verdict.commands[0]?.name ?? "";
      const singleProgram = verdict.commands.every((finding) => finding.name === program);
      const sensitive = mentionsSensitiveLocation(command);
      return {
        risk: sensitive ? "dangerous" : verdict.risk,
        reasons: sensitive ? ["touches a location that may hold credentials or keys", ...verdict.reasons] : verdict.reasons,
        scope: program && singleProgram ? `cmd:${program}` : `exact:${command}`,
        paths: [],
        action: "run-command",
        target: command,
        title: verdict.risk === "dangerous" ? "Run a risky command" : args.background === true ? "Run a command in the background" : "Run a command",
      };
    },
    async execute(args, context) {
      const command = String(args.command ?? "");
      const cwd = resolvePath(args.cwd, context.cwd);
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
      const [file, argv] = shellInvocation(command);
      if (args.background === true) {
        const task = context.shells.start({ agentId: context.agentId, command, cwd, file, args: argv, env: shellEnv() });
        return { output: startedText(task), task };
      }
      const timeout = Math.min(Math.max(Number(args.timeout_ms) || 120_000, 1_000), 600_000);
      const startedAt = Date.now();
      return await new Promise<ToolOutput>((resolveOutput, reject) => {
        const child = spawn(file, argv, { cwd, env: shellEnv(), detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let total = 0;
        let pending = "";
        let flushTimer: NodeJS.Timeout | null = null;
        const flush = () => {
          flushTimer = null;
          if (pending.length > 0) context.progress(pending);
          pending = "";
        };
        const onData = (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          total += text.length;
          output = (output + text).slice(-SHELL_OUTPUT_LIMIT * 2);
          pending += text;
          flushTimer ??= setTimeout(flush, 100);
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        const tailOf = () => (output.length > SHELL_OUTPUT_LIMIT ? `…[earlier output truncated]\n${output.slice(-SHELL_OUTPUT_LIMIT)}` : output);
        let interrupted = false;
        let adopted = false;
        // Past its timeout the command isn't stopped: it goes on as a background command.
        const timer = setTimeout(() => {
          adopted = true;
          context.signal.removeEventListener("abort", onAbort);
          child.stdout?.off("data", onData);
          child.stderr?.off("data", onData);
          if (flushTimer != null) clearTimeout(flushTimer);
          flush();
          const task = context.shells.adopt({ agentId: context.agentId, command, cwd, child, startedAt, output, truncated: total > output.length });
          resolveOutput({ output: adoptedText(task, tailOf(), timeout), task });
        }, timeout);
        const onAbort = () => {
          interrupted = true;
          killTree(child);
        };
        context.signal.addEventListener("abort", onAbort);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code, signal) => {
          if (adopted) return;
          clearTimeout(timer);
          context.signal.removeEventListener("abort", onAbort);
          if (flushTimer != null) clearTimeout(flushTimer);
          flush();
          const status = interrupted ? "Command interrupted." : `Exit code ${code ?? signal}.`;
          resolveOutput({ output: `${tailOf().trimEnd()}\n\n${status}`.trim() });
        });
      });
    },
  },

  await_command: {
    descriptor: { name: "await_command", description: AWAIT_COMMAND_DESCRIPTION, parameters: AWAIT_COMMAND_PARAMETERS, permissionId: "shell", readOnly: true },
    skipsPolicy: true,
    plan: (args) => ({ risk: "read-only", reasons: [], scope: "all", paths: [], action: "run-command", target: `background command ${String(args.id ?? "")}`, title: "Wait for a background command" }),
    async execute(args, context) {
      const regex = typeof args.regex === "string" && args.regex.length > 0 ? args.regex : null;
      const outcome = await context.shells.await(context.agentId, Number(args.id), { blockUntilMs: args.block_until_ms, regex, signal: context.signal });
      return { output: awaitText(outcome, regex), task: outcome.task };
    },
  },

  stop_command: {
    descriptor: { name: "stop_command", description: STOP_COMMAND_DESCRIPTION, parameters: STOP_COMMAND_PARAMETERS, permissionId: "shell", readOnly: false },
    skipsPolicy: true,
    plan: (args) => ({ risk: "read-only", reasons: [], scope: "all", paths: [], action: "run-command", target: `background command ${String(args.id ?? "")}`, title: "Stop a background command" }),
    async execute(args, context) {
      const task = await context.shells.stop(context.agentId, Number(args.id), "Stopped by the agent.");
      return { output: stoppedText(task), task };
    },
  },

  read_file: {
    descriptor: {
      name: "read_file",
      description: "Read a text file (returned with line numbers) or an image from the user's computer. For large files, page with offset/limit.",
      parameters: object(
        {
          path: { type: "string", description: "Absolute path, or relative to your workspace. ~ is the home folder." },
          offset: { type: "integer", description: "1-based line to start at." },
          limit: { type: "integer", description: `Maximum lines to return (default ${READ_LINE_LIMIT}).` },
        },
        ["path"],
      ),
      permissionId: "files.read",
      readOnly: true,
    },
    plan: (args, context) => {
      const path = resolvePath(args.path, context.cwd);
      // Its own background commands' logs read like its workspace.
      const risk = context.shells.ownsLog(context.agentId, path) ? { risk: "read-only" as const, reasons: [] } : readRisk(path, context.cwd);
      return { ...risk, scope: dirScope([path]), paths: [], action: "read-file", target: path, title: "Read a file" };
    },
    async execute(args, context) {
      const path = resolvePath(args.path, context.cwd);
      const stat = statSync(path);
      if (stat.isDirectory()) throw new Error(`${path} is a folder; use list_directory.`);
      const imageType = IMAGE_TYPES[extname(path).toLowerCase()];
      if (imageType != null && stat.size <= 8 * 1024 * 1024) return { output: `Image ${path} (${stat.size} bytes).`, image: { mime: imageType, base64: readFileSync(path).toString("base64") } };
      if (stat.size > 50 * 1024 * 1024) throw new Error(`File is ${stat.size} bytes; too large to read.`);
      const buffer = readFileSync(path);
      if (buffer.subarray(0, 8192).includes(0)) return { output: `${path} is a binary file (${stat.size} bytes).` };
      const lines = buffer.toString("utf8").split(/\r?\n/);
      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Math.min(Math.max(Number(args.limit) || READ_LINE_LIMIT, 1), 10_000);
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const body = slice.map((line, index) => `${String(offset + index).padStart(6)}\t${line.length > 2000 ? `${line.slice(0, 2000)}…` : line}`).join("\n");
      const more = offset - 1 + limit < lines.length ? `\n…(${lines.length - (offset - 1 + limit)} more lines; continue with offset ${offset + limit})` : "";
      return { output: `${path} (${lines.length} lines)\n${body}${more}` };
    },
  },

  list_directory: {
    descriptor: {
      name: "list_directory",
      description: "List a folder's contents (names, types, sizes). depth 2-3 shows nested folders, skipping dependency and build folders.",
      parameters: object({ path: { type: "string" }, depth: { type: "integer", description: "1-3, default 1." } }),
      permissionId: "files.read",
      readOnly: true,
    },
    plan: (args, context) => {
      const root = resolvePath(args.path, context.cwd);
      return { ...readRisk(root, context.cwd), scope: `dir:${root}`, paths: [], action: "list-directory", target: root, title: "List a folder" };
    },
    async execute(args, context) {
      const root = resolvePath(args.path, context.cwd);
      const depth = Math.min(Math.max(Number(args.depth) || 1, 1), 3);
      const lines: string[] = [];
      const walk = (dir: string, level: number) => {
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch (error) {
          lines.push(`${"  ".repeat(level)}[unreadable: ${(error as Error).message}]`);
          return;
        }
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (lines.length >= 500) return;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            lines.push(`${"  ".repeat(level)}${entry.name}/`);
            if (level + 1 < depth && !SKIP_DIRS.has(entry.name)) walk(full, level + 1);
          } else {
            let size = "";
            try {
              size = ` (${formatBytes(statSync(full).size)})`;
            } catch {
              // broken link
            }
            lines.push(`${"  ".repeat(level)}${entry.name}${size}`);
          }
        }
      };
      walk(root, 0);
      return { output: `${root}\n${lines.join("\n")}${lines.length >= 500 ? "\n…(truncated at 500 entries)" : ""}` };
    },
  },

  search_files: {
    descriptor: {
      name: "search_files",
      description: "Search file contents under a folder with a regular expression. Returns path:line: text matches, skipping dependency/build folders and binary files.",
      parameters: object(
        {
          pattern: { type: "string", description: "JavaScript regular expression." },
          path: { type: "string", description: "Folder to search (default: your workspace)." },
          glob: { type: "string", description: "Only files matching this glob, e.g. **/*.ts" },
          case_insensitive: { type: "boolean" },
          max_results: { type: "integer", description: "Default 100, max 500." },
        },
        ["pattern"],
      ),
      permissionId: "files.read",
      readOnly: true,
    },
    plan: (args, context) => {
      const root = resolvePath(args.path, context.cwd);
      return { ...readRisk(root, context.cwd), scope: `dir:${root}`, paths: [], action: "list-directory", target: root, title: "Search files" };
    },
    async execute(args, context) {
      const root = resolvePath(args.path, context.cwd);
      const regex = new RegExp(String(args.pattern), args.case_insensitive ? "i" : "");
      const globRegex = args.glob ? globToRegex(String(args.glob)) : null;
      const max = Math.min(Math.max(Number(args.max_results) || 100, 1), 500);
      const results: string[] = [];
      let filesScanned = 0;
      const walk = (dir: string) => {
        if (results.length >= max || context.signal.aborted) return;
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (results.length >= max) return;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) walk(full);
            continue;
          }
          const rel = relative(root, full).replace(/\\/g, "/");
          if (globRegex != null && !globRegex.test(rel) && !globRegex.test(entry.name)) continue;
          let buffer: Buffer;
          try {
            if (statSync(full).size > 2 * 1024 * 1024) continue;
            buffer = readFileSync(full);
          } catch {
            continue;
          }
          if (buffer.subarray(0, 4096).includes(0)) continue;
          filesScanned++;
          const lines = buffer.toString("utf8").split(/\r?\n/);
          for (let i = 0; i < lines.length && results.length < max; i++) {
            if (regex.test(lines[i])) results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
          }
        }
      };
      walk(root);
      return { output: results.length === 0 ? `No matches in ${filesScanned} files under ${root}.` : `${results.join("\n")}${results.length >= max ? `\n…(stopped at ${max} matches)` : ""}` };
    },
  },

  write_file: {
    descriptor: {
      name: "write_file",
      description: "Create or overwrite a text file on the user's computer. Parent folders are created. Prefer edit_file for small changes to existing files.",
      parameters: object({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
      permissionId: "files.write",
      readOnly: false,
    },
    plan(args, context) {
      const path = resolvePath(args.path, context.cwd);
      const exists = existsSync(path);
      return { risk: "mutating", reasons: [`${exists ? "overwrites" : "creates"} ${path}`], scope: dirScope([path]), paths: [path], action: "write-file", target: path, title: exists ? "Overwrite a file" : "Create a file" };
    },
    async execute(args, context) {
      const path = resolvePath(args.path, context.cwd);
      const existed = existsSync(path);
      mkdirSync(dirname(path), { recursive: true });
      const content = String(args.content ?? "");
      writeFileSync(path, content);
      return { output: `${existed ? "Overwrote" : "Created"} ${path} (${Buffer.byteLength(content)} bytes).` };
    },
  },

  edit_file: {
    descriptor: {
      name: "edit_file",
      description: "Replace exact text in a file. old_string must match exactly once (including whitespace) unless replace_all is true.",
      parameters: object(
        { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } },
        ["path", "old_string", "new_string"],
      ),
      permissionId: "files.write",
      readOnly: false,
    },
    plan(args, context) {
      const path = resolvePath(args.path, context.cwd);
      return { risk: "mutating", reasons: [`edits ${path}`], scope: dirScope([path]), paths: [path], action: "write-file", target: path, title: "Edit a file" };
    },
    async execute(args, context) {
      const path = resolvePath(args.path, context.cwd);
      const original = readFileSync(path, "utf8");
      const oldString = String(args.old_string ?? "");
      if (oldString.length === 0) throw new Error("old_string is empty.");
      const count = original.split(oldString).length - 1;
      if (count === 0) throw new Error("old_string was not found. Read the file again and copy the exact text.");
      if (count > 1 && args.replace_all !== true) throw new Error(`old_string appears ${count} times; add surrounding context or set replace_all.`);
      const next = args.replace_all === true ? original.split(oldString).join(String(args.new_string ?? "")) : original.replace(oldString, () => String(args.new_string ?? ""));
      writeFileSync(path, next);
      return { output: `Edited ${path} (${args.replace_all === true ? count : 1} replacement${count > 1 && args.replace_all === true ? "s" : ""}).` };
    },
  },

  list_processes: {
    descriptor: {
      name: "list_processes",
      description: "List running processes on the user's computer, largest memory users first.",
      parameters: object({ filter: { type: "string", description: "Only processes whose name contains this text." } }),
      permissionId: "processes",
      readOnly: true,
    },
    plan: () => ({ risk: "read-only", reasons: [], scope: "all", paths: [], action: "use-app", target: "running processes", title: "See running apps" }),
    async execute(args) {
      const rows = await listProcesses();
      const filter = typeof args.filter === "string" ? args.filter.toLowerCase() : "";
      const selected = rows.filter((row) => row.name.toLowerCase().includes(filter)).sort((a, b) => b.memoryKb - a.memoryKb);
      const lines = selected.slice(0, 60).map((row) => `${String(row.pid).padStart(7)}  ${formatBytes(row.memoryKb * 1024).padStart(9)}  ${row.name}`);
      return { output: `${selected.length} processes${filter ? ` matching "${filter}"` : ""}:\n    PID     MEMORY  NAME\n${lines.join("\n")}` };
    },
  },

  take_screenshot: {
    descriptor: {
      name: "take_screenshot",
      description: "Capture the user's primary screen so you can see what is on it.",
      parameters: object({}),
      permissionId: "screen",
      readOnly: true,
    },
    plan: () => ({ risk: "unknown", reasons: ["captures everything visible on the screen"], scope: "all", paths: [], action: "use-app", target: "your screen", title: "Take a screenshot" }),
    async execute(_args, context) {
      const capture = await context.host.grabScreen();
      if (capture == null) throw new Error("Screen capture is unavailable (permission denied or no display).");
      return { output: `Screenshot ${capture.width}×${capture.height}.`, image: { mime: "image/png", base64: capture.pngBase64 } };
    },
  },

  read_clipboard: {
    descriptor: { name: "read_clipboard", description: "Read the text currently on the clipboard.", parameters: object({}), permissionId: "clipboard.read", readOnly: true },
    plan: () => ({ risk: "unknown", reasons: ["reads whatever you last copied"], scope: "all", paths: [], action: "use-app", target: "the clipboard", title: "Read the clipboard" }),
    async execute(_args, context) {
      const text = await context.host.getClipboardText();
      return { output: text.length === 0 ? "(clipboard is empty)" : text.slice(0, 50_000) };
    },
  },

  write_clipboard: {
    descriptor: { name: "write_clipboard", description: "Put text on the clipboard so the user can paste it.", parameters: object({ text: { type: "string" } }, ["text"]), permissionId: "clipboard.write", readOnly: false },
    plan: () => ({ risk: "mutating", reasons: ["replaces the clipboard contents"], scope: "all", paths: [], action: "use-app", target: "the clipboard", title: "Copy to the clipboard" }),
    async execute(args, context) {
      await context.host.putClipboardText(String(args.text ?? ""));
      return { output: "Copied to the clipboard." };
    },
  },

  open_url: {
    descriptor: { name: "open_url", description: "Open an http(s) link in the user's default browser.", parameters: object({ url: { type: "string" } }, ["url"]), permissionId: "open", readOnly: false },
    plan: (args) => ({ risk: "mutating", reasons: [`opens ${String(args.url ?? "")}`], scope: "all", paths: [], action: "use-app", target: String(args.url ?? ""), title: "Open a link" }),
    async execute(args, context) {
      const url = new URL(String(args.url));
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http(s) links can be opened.");
      await context.host.openInBrowser(url.toString());
      return { output: `Opened ${url.toString()}` };
    },
  },

  ...BROWSER_TOOLS,
};

function killTree(child: ChildProcess): void {
  if (child.pid == null || child.exitCode != null) return;
  killProcessTree(child.pid);
}

async function listProcesses(): Promise<Array<{ pid: number; name: string; memoryKb: number }>> {
  const run = (file: string, args: string[]) =>
    new Promise<string>((resolveRun, reject) => execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolveRun(stdout))));
  if (process.platform === "win32") {
    const csv = await run("tasklist", ["/fo", "csv", "/nh"]);
    return csv
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const cells = [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
        return { name: cells[0] ?? "?", pid: Number(cells[1]) || 0, memoryKb: Number((cells[4] ?? "0").replace(/[^\d]/g, "")) || 0 };
      });
  }
  const out = await run("ps", ["-axo", "pid=,rss=,comm="]);
  return out
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match != null)
    .map((match) => ({ pid: Number(match[1]), memoryKb: Number(match[2]), name: basename(match[3]) }));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function globToRegex(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else pattern += "[^/]*";
    } else if (char === "?") pattern += "[^/]";
    else if (char === "{") {
      const close = glob.indexOf("}", i);
      if (close > i) {
        pattern += `(${glob.slice(i + 1, close).split(",").map(escapeRegex).join("|")})`;
        i = close;
      } else pattern += "\\{";
    } else pattern += escapeRegex(char);
  }
  return new RegExp(`^${pattern}$`, "i");
}

function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}
