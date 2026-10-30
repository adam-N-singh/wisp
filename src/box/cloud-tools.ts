// Tools for agents whose computer is the cloud computer. They keep the names
// and argument shapes of the local tools (run_shell, read_file, …) so the
// model sees the same toolset, but act on the E2B sandbox; the desktop kind adds
// screenshot, mouse and keyboard tools. Background commands (run_shell's
// background option, await_command, stop_command) are the box's async tasks.
import { posix } from "node:path";
import {
  AWAIT_COMMAND_DESCRIPTION,
  AWAIT_COMMAND_PARAMETERS,
  type AwaitOutcome,
  awaitText,
  BACKGROUND_PARAMETER,
  type BackgroundShellStatus,
  startedText,
  STOP_COMMAND_DESCRIPTION,
  STOP_COMMAND_PARAMETERS,
  stoppedText,
} from "../shared/background-shell";
import type { CloudComputer } from "./cloud-computer";
import { CLOUD_HOME, cloudWorkspace } from "./cloud-computer";
import type { ToolSpec } from "./models";

/** Background commands on the cloud computer (the box's async tasks, async-tasks.ts). */
export interface CloudShells {
  /** `sessionId`: the session the call came from, which hears how the command ended (none: the main one). */
  startCloud(agentId: string, command: string, cwd: string, sessionId?: string): Promise<BackgroundShellStatus>;
  awaitCloud(agentId: string, shellId: number, options: { blockUntilMs?: unknown; regex: string | null; signal: AbortSignal }): Promise<AwaitOutcome>;
  stopCloud(agentId: string, shellId: number, by: "agent" | "user"): Promise<BackgroundShellStatus>;
}

export interface CloudToolContext {
  agentId: string;
  /** The session the call came from, when not the agent's main one. */
  sessionId?: string;
  cloud: CloudComputer;
  signal: AbortSignal;
  progress(chunk: string): void;
  shells?: CloudShells;
}

function requireShells(context: CloudToolContext): CloudShells {
  if (context.shells == null) throw new Error("Background commands aren't available on this box.");
  return context.shells;
}

export interface CloudToolResult {
  output: string;
  image?: { mime: string; base64: string } | null;
  isError?: boolean;
}

interface CloudTool {
  spec: ToolSpec;
  desktopOnly?: boolean;
  /** Changes the machine (asks first when the user wants approvals for the cloud computer). */
  mutating: boolean;
  run(args: Record<string, any>, context: CloudToolContext): Promise<CloudToolResult>;
}

const SHELL_OUTPUT_LIMIT = 100_000;
const READ_LINE_LIMIT = 2000;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const SKIP_DIRS = ["node_modules", ".git", "dist", "build", ".venv", "venv", "__pycache__", "target", ".next", ".cache"];

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const tool = (name: string, description: string, parameters: Record<string, unknown>): ToolSpec => ({ type: "function", function: { name, description, parameters } });

export function resolveCloudPath(path: unknown, agentId: string): string {
  const raw = String(path ?? "").trim();
  if (raw.length === 0) return cloudWorkspace(agentId);
  if (raw === "~") return CLOUD_HOME;
  if (raw.startsWith("~/")) return posix.join(CLOUD_HOME, raw.slice(2));
  return posix.isAbsolute(raw) ? posix.normalize(raw) : posix.join(cloudWorkspace(agentId), raw);
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export const CLOUD_TOOLS: Record<string, CloudTool> = {
  run_shell: {
    spec: tool(
      "run_shell",
      "Run a bash command on your cloud computer (an Ubuntu Linux VM you have to yourself; it is not the user's PC) and return its combined output and exit code. Commands run non-interactively; avoid anything that waits for input. You can install packages with apt-get (sudo works) or pip/npm. With background, it starts the command and returns at once.",
      object(
        {
          command: { type: "string", description: "The command line to run." },
          cwd: { type: "string", description: "Working directory (defaults to your workspace)." },
          timeout_ms: { type: "integer", description: "Kill the command after this long (default 120000, max 600000); not for background commands." },
          background: BACKGROUND_PARAMETER,
        },
        ["command"],
      ),
    ),
    mutating: true,
    async run(args, context) {
      const cwd = resolveCloudPath(args.cwd, context.agentId);
      if (args.background === true) {
        await context.cloud.ensureDir(cwd);
        return { output: startedText(await requireShells(context).startCloud(context.agentId, String(args.command ?? ""), cwd, context.sessionId)) };
      }
      const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 120_000, 1_000), 600_000);
      const result = await context.cloud.exec(String(args.command ?? ""), { cwd, timeoutMs, signal: context.signal, onOutput: context.progress });
      const tail = result.output.length > SHELL_OUTPUT_LIMIT ? `…[earlier output truncated]\n${result.output.slice(-SHELL_OUTPUT_LIMIT)}` : result.output;
      const status = result.killedBy != null ? `Command ${result.killedBy}.` : `Exit code ${result.exitCode}.`;
      return { output: `${tail.trimEnd()}\n\n${status}`.trim(), isError: result.killedBy != null };
    },
  },

  await_command: {
    spec: tool("await_command", AWAIT_COMMAND_DESCRIPTION, AWAIT_COMMAND_PARAMETERS),
    mutating: false,
    async run(args, context) {
      const regex = typeof args.regex === "string" && args.regex.length > 0 ? args.regex : null;
      const outcome = await requireShells(context).awaitCloud(context.agentId, Number(args.id), { blockUntilMs: args.block_until_ms, regex, signal: context.signal });
      return { output: awaitText(outcome, regex) };
    },
  },

  stop_command: {
    spec: tool("stop_command", STOP_COMMAND_DESCRIPTION, STOP_COMMAND_PARAMETERS),
    mutating: false,
    async run(args, context) {
      return { output: stoppedText(await requireShells(context).stopCloud(context.agentId, Number(args.id), "agent")) };
    },
  },

  read_file: {
    spec: tool(
      "read_file",
      "Read a text file (returned with line numbers) or an image from your cloud computer. For large files, page with offset/limit.",
      object(
        {
          path: { type: "string", description: "Absolute path, or relative to your workspace. ~ is /home/user." },
          offset: { type: "integer", description: "1-based line to start at." },
          limit: { type: "integer", description: `Maximum lines to return (default ${READ_LINE_LIMIT}).` },
        },
        ["path"],
      ),
    ),
    mutating: false,
    async run(args, context) {
      const path = resolveCloudPath(args.path, context.agentId);
      const imageType = IMAGE_TYPES[posix.extname(path).toLowerCase()];
      if (imageType != null) {
        const bytes = await context.cloud.readBytes(path);
        return { output: `Image ${path} (${bytes.byteLength} bytes).`, image: { mime: imageType, base64: Buffer.from(bytes).toString("base64") } };
      }
      const text = await context.cloud.readText(path);
      if (text.slice(0, 8192).includes("\u0000")) return { output: `${path} is a binary file.` };
      const lines = text.split(/\r?\n/);
      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Math.min(Math.max(Number(args.limit) || READ_LINE_LIMIT, 1), 10_000);
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const body = slice.map((line, index) => `${String(offset + index).padStart(6)}\t${line.length > 2000 ? `${line.slice(0, 2000)}…` : line}`).join("\n");
      const more = offset - 1 + limit < lines.length ? `\n…(${lines.length - (offset - 1 + limit)} more lines; continue with offset ${offset + limit})` : "";
      return { output: `${path} (${lines.length} lines)\n${body}${more}` };
    },
  },

  list_directory: {
    spec: tool("list_directory", "List a folder's contents on your cloud computer (names, types, sizes). depth 2-3 shows nested folders.", object({ path: { type: "string" }, depth: { type: "integer", description: "1-3, default 1." } })),
    mutating: false,
    async run(args, context) {
      const root = resolveCloudPath(args.path, context.agentId);
      if (root === cloudWorkspace(context.agentId)) await context.cloud.ensureDir(root);
      const depth = Math.min(Math.max(Number(args.depth) || 1, 1), 3);
      const entries = (await context.cloud.list(root, depth)).filter((entry) => !SKIP_DIRS.some((skip) => entry.path.includes(`/${skip}/`)));
      entries.sort((a, b) => a.path.localeCompare(b.path));
      const lines = entries.slice(0, 500).map((entry) => {
        const relative = posix.relative(root, entry.path);
        const level = relative.split("/").length - 1;
        return `${"  ".repeat(level)}${entry.name}${entry.isDir ? "/" : ` (${formatBytes(entry.size)})`}`;
      });
      return { output: `${root}\n${lines.join("\n")}${entries.length > 500 ? "\n…(truncated at 500 entries)" : ""}` };
    },
  },

  search_files: {
    spec: tool(
      "search_files",
      "Search file contents under a folder on your cloud computer with a regular expression (grep -E). Returns path:line: text matches, skipping dependency/build folders and binary files.",
      object(
        {
          pattern: { type: "string", description: "Extended regular expression." },
          path: { type: "string", description: "Folder to search (default: your workspace)." },
          glob: { type: "string", description: "Only files matching this glob, e.g. *.ts" },
          case_insensitive: { type: "boolean" },
          max_results: { type: "integer", description: "Default 100, max 500." },
        },
        ["pattern"],
      ),
    ),
    mutating: false,
    async run(args, context) {
      const root = resolveCloudPath(args.path, context.agentId);
      const max = Math.min(Math.max(Number(args.max_results) || 100, 1), 500);
      const command = [
        "grep -rnIE",
        args.case_insensitive ? "-i" : "",
        ...SKIP_DIRS.map((dir) => `--exclude-dir=${quote(dir)}`),
        args.glob ? `--include=${quote(String(args.glob).replace(/^\*\*\//, ""))}` : "",
        "-e",
        quote(String(args.pattern ?? "")),
        quote(root),
        `| head -n ${max}`,
      ]
        .filter(Boolean)
        .join(" ");
      const result = await context.cloud.exec(command, { cwd: cloudWorkspace(context.agentId), timeoutMs: 60_000, signal: context.signal, onOutput: () => undefined });
      const lines = result.output
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => (line.startsWith(`${root}/`) ? line.slice(root.length + 1) : line).slice(0, 400));
      return { output: lines.length === 0 ? `No matches under ${root}.` : `${lines.join("\n")}${lines.length >= max ? `\n…(stopped at ${max} matches)` : ""}` };
    },
  },

  write_file: {
    spec: tool("write_file", "Create or overwrite a text file on your cloud computer. Parent folders are created. Prefer edit_file for small changes to existing files.", object({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"])),
    mutating: true,
    async run(args, context) {
      const path = resolveCloudPath(args.path, context.agentId);
      const existed = await context.cloud.exists(path);
      const content = String(args.content ?? "");
      await context.cloud.writeText(path, content);
      return { output: `${existed ? "Overwrote" : "Created"} ${path} (${Buffer.byteLength(content)} bytes).` };
    },
  },

  edit_file: {
    spec: tool(
      "edit_file",
      "Replace exact text in a file on your cloud computer. old_string must match exactly once (including whitespace) unless replace_all is true.",
      object({ path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, ["path", "old_string", "new_string"]),
    ),
    mutating: true,
    async run(args, context) {
      const path = resolveCloudPath(args.path, context.agentId);
      const original = await context.cloud.readText(path);
      const oldString = String(args.old_string ?? "");
      if (oldString.length === 0) return { output: "old_string is empty.", isError: true };
      const count = original.split(oldString).length - 1;
      if (count === 0) return { output: "old_string was not found. Read the file again and copy the exact text.", isError: true };
      if (count > 1 && args.replace_all !== true) return { output: `old_string appears ${count} times; add surrounding context or set replace_all.`, isError: true };
      const next = args.replace_all === true ? original.split(oldString).join(String(args.new_string ?? "")) : original.replace(oldString, () => String(args.new_string ?? ""));
      await context.cloud.writeText(path, next);
      return { output: `Edited ${path} (${args.replace_all === true ? count : 1} replacement${count > 1 && args.replace_all === true ? "s" : ""}).` };
    },
  },

  take_screenshot: {
    spec: tool("take_screenshot", "Capture your cloud computer's screen (1280x800) so you can see it. Coordinates in the image are the ones the mouse tools use.", object({})),
    desktopOnly: true,
    mutating: false,
    async run(_args, context) {
      const png = await context.cloud.screenshot();
      return { output: "Screenshot of the cloud computer (1280x800).", image: { mime: "image/png", base64: Buffer.from(png).toString("base64") } };
    },
  },

  computer_click: {
    spec: tool(
      "computer_click",
      "Click on your cloud computer's screen at pixel (x, y). Take a screenshot first to find the target.",
      object({ x: { type: "integer" }, y: { type: "integer" }, button: { type: "string", enum: ["left", "right", "middle"], description: "Default left." }, double: { type: "boolean", description: "Double-click." } }, ["x", "y"]),
    ),
    desktopOnly: true,
    mutating: true,
    async run(args, context) {
      const x = Math.round(Number(args.x));
      const y = Math.round(Number(args.y));
      await context.cloud.act((desktop) => (args.double === true ? desktop.doubleClick(x, y) : args.button === "right" ? desktop.rightClick(x, y) : args.button === "middle" ? desktop.middleClick(x, y) : desktop.leftClick(x, y)));
      return { output: `${args.double === true ? "Double-clicked" : "Clicked"} at (${x}, ${y}).` };
    },
  },

  computer_type: {
    spec: tool("computer_type", "Type text at the cursor on your cloud computer.", object({ text: { type: "string" } }, ["text"])),
    desktopOnly: true,
    mutating: true,
    async run(args, context) {
      const text = String(args.text ?? "");
      await context.cloud.act((desktop) => desktop.write(text));
      return { output: `Typed ${text.length} characters.` };
    },
  },

  computer_key: {
    spec: tool(
      "computer_key",
      'Press a key or key combination on your cloud computer, e.g. "enter", "ctrl+c" or ["ctrl", "l"].',
      object({ keys: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } }, ["keys"]),
    ),
    desktopOnly: true,
    mutating: true,
    async run(args, context) {
      const keys: string | string[] = Array.isArray(args.keys) ? args.keys.map(String) : String(args.keys ?? "").includes("+") ? String(args.keys).split("+") : String(args.keys ?? "");
      await context.cloud.act((desktop) => desktop.press(keys));
      return { output: `Pressed ${Array.isArray(keys) ? keys.join("+") : keys}.` };
    },
  },

  computer_scroll: {
    spec: tool("computer_scroll", "Scroll on your cloud computer's screen.", object({ direction: { type: "string", enum: ["up", "down"] }, amount: { type: "integer", description: "Wheel clicks, default 3." } }, ["direction"])),
    desktopOnly: true,
    mutating: false,
    async run(args, context) {
      const amount = Math.min(Math.max(Number(args.amount) || 3, 1), 30);
      await context.cloud.act((desktop) => desktop.scroll(args.direction === "up" ? "up" : "down", amount));
      return { output: `Scrolled ${args.direction === "up" ? "up" : "down"} ${amount}.` };
    },
  },

  computer_move: {
    spec: tool("computer_move", "Move the mouse on your cloud computer to (x, y), e.g. to hover.", object({ x: { type: "integer" }, y: { type: "integer" } }, ["x", "y"])),
    desktopOnly: true,
    mutating: false,
    async run(args, context) {
      await context.cloud.act((desktop) => desktop.moveMouse(Math.round(Number(args.x)), Math.round(Number(args.y))));
      return { output: `Moved the mouse to (${args.x}, ${args.y}).` };
    },
  },

  computer_drag: {
    spec: tool("computer_drag", "Drag with the left mouse button on your cloud computer.", object({ from_x: { type: "integer" }, from_y: { type: "integer" }, to_x: { type: "integer" }, to_y: { type: "integer" } }, ["from_x", "from_y", "to_x", "to_y"])),
    desktopOnly: true,
    mutating: true,
    async run(args, context) {
      await context.cloud.act((desktop) => desktop.drag([Number(args.from_x), Number(args.from_y)], [Number(args.to_x), Number(args.to_y)]));
      return { output: `Dragged from (${args.from_x}, ${args.from_y}) to (${args.to_x}, ${args.to_y}).` };
    },
  },

  open_url: {
    spec: tool("open_url", "Open a web page or file in your cloud computer's default application (a browser for links).", object({ url: { type: "string" } }, ["url"])),
    desktopOnly: true,
    mutating: true,
    async run(args, context) {
      const target = String(args.url ?? "");
      await context.cloud.act((desktop) => desktop.open(target));
      return { output: `Opened ${target}. Take a screenshot to see it.` };
    },
  },
};

export function cloudToolSpecs(kind: "headless" | "desktop"): ToolSpec[] {
  return Object.values(CLOUD_TOOLS)
    .filter((entry) => kind === "desktop" || entry.desktopOnly !== true)
    .map((entry) => entry.spec);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
