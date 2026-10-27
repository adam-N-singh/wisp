// Claude Code engine: an agent whose model is "claude-code:…" is run by the
// user's own, unmodified Claude Code CLI in headless mode
// (`claude -p --output-format stream-json`) with the agent's workspace as its
// working directory. Claude Code signs in through its own flow (a Claude
// subscription or an API key it manages); the app never sees those credentials.
//
// The app's own tools (questions, automations, screenshots, clipboard, …) and
// approval cards reach Claude Code through a small stdio MCP server
// (dist/claude-bridge/main.cjs) that calls back into this box over HTTP:
//   mcp__wisp__approve   is the --permission-prompt-tool; it becomes an approval card
//   mcp__wisp__<tool>    runs one of the app's tools like any other tool call
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTodo, McpHttpServerConfig, McpServerConfig, MessageEntry, ToolCallEntry } from "../shared/model";
import type { PermissionAsk } from "../shared/gateway-protocol";
import { blankedEnv } from "./mcp";
import type { ImagePart, ResolvedModel } from "./models";

export type Resolution = "allow-once" | "always" | "deny" | "never";

/** What the engine needs from the harness for one run. */
export interface EngineHost {
  readonly agentId: string;
  readonly signal: AbortSignal;
  workspace(): string;
  /** Persona, role and the user's instructions for --append-system-prompt-file. */
  agentNotes(): string;
  newStep(): number;
  beginReply(step: number): MessageEntry;
  stream(entry: MessageEntry | ToolCallEntry): void;
  commit(entry: MessageEntry | ToolCallEntry): void;
  createToolEntry(step: number, name: string, summary: string, callId: string, args: Record<string, unknown>): ToolCallEntry;
  finishToolEntry(entry: ToolCallEntry, status: "done" | "failed", output: string, error: string | null): void;
  notice(tone: "info" | "error", text: string): void;
  setActivity(activity: { kind: "thinking" } | { kind: "tool" | "searching"; tool: string; detail?: string } | null): void;
  setTodos(todos: AgentTodo[]): void;
  requestApproval(entry: ToolCallEntry, ask: PermissionAsk): Promise<Resolution>;
  /** Runs one of the app's tools (box, local or MCP) with its usual approvals and transcript row. */
  runAppTool(step: number, name: string, args: Record<string, unknown>): Promise<{ output: string; isError: boolean; image: ImagePart | null }>;
  appTools(): Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  grant(key: string): "always" | "never" | null;
  setGrant(key: string, value: "always" | "never"): void;
}

export interface BridgeRegistry {
  /** Makes the run reachable from the bridge process; returns its token. */
  register(host: EngineHost, state: BridgeRunState): string;
  unregister(token: string): void;
  baseUrl(): string;
  bridgeScript: string;
}

/** Per-run state the bridge endpoints need. */
export interface BridgeRunState {
  step: number;
  toolEntries: Map<string, ToolCallEntry>;
}

export interface ClaudeTurnInput {
  prompt: string;
  sessionId: string | null;
}

export interface ClaudeTurnOutcome {
  sessionId: string | null;
  /** Error code for lastTurnSettlement, or null on success. */
  failed: string | null;
  text: string;
}

const APP_TOOL_PREFIX = "mcp__wisp__";
const OUTPUT_LIMIT = 100_000;

export class ClaudeCodeEngine {
  constructor(
    private readonly options: {
      bridge: BridgeRegistry;
      tempDir: string;
      mcpServers(): McpServerConfig[];
      /** Headers Claude Code sends to an HTTP server (the box's sign-in among them); null leaves the server out. */
      mcpHttpHeaders?(server: McpHttpServerConfig): Promise<Record<string, string> | null>;
      log(line: string): void;
    },
  ) {}

  async runTurn(host: EngineHost, model: Extract<ResolvedModel, { kind: "claude-code" }>, input: ClaudeTurnInput): Promise<ClaudeTurnOutcome> {
    const runId = randomUUID();
    const dir = join(this.options.tempDir, runId);
    mkdirSync(dir, { recursive: true });
    const state: BridgeRunState = { step: host.newStep(), toolEntries: new Map() };
    const token = this.options.bridge.register(host, state);
    const promptFile = join(dir, "agent.md");
    const mcpFile = join(dir, "mcp.json");
    writeFileSync(promptFile, host.agentNotes(), "utf8");
    const mcp = await this.mcpConfig(token);
    writeFileSync(mcpFile, JSON.stringify(mcp.config), "utf8");

    const sessionId = input.sessionId ?? randomUUID();
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "acceptEdits",
      "--permission-prompt-tool",
      `${APP_TOOL_PREFIX}approve`,
      // Bare names remove the tools from Claude's context, as the box's own runs never offer them.
      ...(mcp.disallowed.length > 0 ? ["--disallowedTools", ...mcp.disallowed] : []),
      "--mcp-config",
      mcpFile,
      "--append-system-prompt-file",
      promptFile,
      ...(input.sessionId != null ? ["--resume", input.sessionId] : ["--session-id", sessionId]),
      ...(model.ref.model !== "default" && model.ref.model.length > 0 ? ["--model", model.ref.model] : []),
      ...(model.effort !== "default" ? ["--effort", model.effort] : []),
    ];

    const outcome: ClaudeTurnOutcome = { sessionId, failed: null, text: "" };
    let child: ChildProcess;
    try {
      child = spawnClaude(model.executable, args, host.workspace());
    } catch (error) {
      this.options.bridge.unregister(token);
      rmSync(dir, { recursive: true, force: true });
      host.notice("error", `Couldn't start Claude Code: ${error instanceof Error ? error.message : String(error)}`);
      return { ...outcome, failed: "claude-code-spawn" };
    }

    const onAbort = () => killTree(child);
    host.signal.addEventListener("abort", onAbort);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8000);
    });
    child.stdin?.end(input.prompt, "utf8");

    const parser = new StreamParser(host, state, outcome);
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) continue;
        try {
          parser.handle(JSON.parse(line));
        } catch (error) {
          this.options.log(`claude-code: unparsed line (${error instanceof Error ? error.message : String(error)})`);
        }
      }
    });

    const code = await new Promise<number | null>((resolve) => {
      child.once("error", (error) => {
        stderr += `\n${error.message}`;
        resolve(-1);
      });
      child.once("close", (exitCode) => resolve(exitCode));
    });
    host.signal.removeEventListener("abort", onAbort);
    parser.finish();
    this.options.bridge.unregister(token);
    rmSync(dir, { recursive: true, force: true });

    if (host.signal.aborted) return outcome;
    if (!parser.sawResult && code !== 0) {
      const detail = stderr.trim().split(/\r?\n/).slice(-4).join(" ").slice(0, 600);
      host.notice("error", describeFailure(detail || `Claude Code exited with code ${code}.`));
      outcome.failed = "claude-code-exit";
    }
    if (parser.sessionMissing && input.sessionId != null) outcome.sessionId = null;
    return outcome;
  }

  /** The servers Claude Code loads, and the tools of theirs the user switched off (Claude Code's names for them). */
  private async mcpConfig(token: string): Promise<{ config: unknown; disallowed: string[] }> {
    const servers: Record<string, unknown> = {};
    const disallowed: string[] = [];
    for (const server of this.options.mcpServers()) {
      if (!server.enabled || server.id === "wisp") continue;
      if (server.transport === "http") {
        // Claude Code can't sign in from -p, so it gets the box's sign-in as a header; a server that needs one is left out.
        const headers = (await this.options.mcpHttpHeaders?.(server).catch(() => null)) ?? null;
        if (headers == null) continue;
        servers[server.id] = { type: "http", url: server.url, headers };
      } else {
        // A plugin's server gets the box's keys and tokens blanked, as the box itself leaves them out.
        servers[server.id] = { type: "stdio", command: server.command, args: server.args, env: server.basicEnv === true ? { ...blankedEnv(), ...server.env } : server.env };
      }
      for (const tool of server.disabledTools ?? []) disallowed.push(`mcp__${server.id}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_"));
    }
    servers.wisp = {
      type: "stdio",
      command: process.execPath,
      args: [this.options.bridge.bridgeScript],
      env: { ELECTRON_RUN_AS_NODE: "1", WISP_BRIDGE_URL: this.options.bridge.baseUrl(), WISP_BRIDGE_TOKEN: token },
    };
    return { config: { mcpServers: servers }, disallowed };
  }
}

/** Turns Claude Code's stream-json lines into transcript rows. */
class StreamParser {
  sawResult = false;
  sessionMissing = false;
  private replies = new Map<string, { entry: MessageEntry; streamed: boolean }>();
  private current: string | null = null;

  constructor(
    private readonly host: EngineHost,
    private readonly state: BridgeRunState,
    private readonly outcome: ClaudeTurnOutcome,
  ) {}

  handle(message: any): void {
    if (message?.parent_tool_use_id != null) {
      // Subagent traffic stays inside its Task card, except the results of its tools that asked for approval:
      // the bridge gave those a card of their own (approveClaudeCodeRequest), which waits for its result.
      if (message.type === "user") this.settleToolResults(message.message);
      return;
    }
    switch (message?.type) {
      case "system":
        if (message.subtype === "init") {
          if (typeof message.session_id === "string") this.outcome.sessionId = message.session_id;
          const bridge = (message.mcp_servers ?? []).find((server: { name?: string }) => server.name === "wisp");
          if (bridge != null && bridge.status !== "connected" && bridge.status !== "pending") {
            this.host.notice("info", "Claude Code couldn't load the app's tools (questions, automations, screenshots) for this turn.");
          }
        }
        return;
      case "stream_event":
        return this.onStreamEvent(message.event);
      case "assistant":
        return this.onAssistant(message.message);
      case "user":
        return this.onToolResults(message.message);
      case "result":
        return this.onResult(message);
    }
  }

  private reply(messageId: string): { entry: MessageEntry; streamed: boolean } {
    let reply = this.replies.get(messageId);
    if (reply == null) {
      this.state.step = this.host.newStep();
      reply = { entry: this.host.beginReply(this.state.step), streamed: false };
      this.replies.set(messageId, reply);
    }
    return reply;
  }

  private onStreamEvent(event: any): void {
    if (event?.type === "message_start") {
      this.current = String(event.message?.id ?? randomUUID());
      this.host.setActivity({ kind: "thinking" });
      return;
    }
    if (event?.type === "message_stop" && this.current != null) {
      const reply = this.replies.get(this.current);
      if (reply != null) this.close(reply.entry);
      return;
    }
    if (event?.type !== "content_block_delta" || this.current == null) return;
    const delta = event.delta ?? {};
    // Hidden thinking streams empty deltas; those must not open an empty reply row.
    if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
      const reply = this.reply(this.current);
      reply.streamed = true;
      reply.entry.content += delta.text;
      this.host.stream(reply.entry);
    } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
      const reply = this.reply(this.current);
      reply.streamed = true;
      reply.entry.reasoning = (reply.entry.reasoning ?? "") + delta.thinking;
      this.host.stream(reply.entry);
    }
  }

  private onAssistant(message: any): void {
    const id = String(message?.id ?? this.current ?? randomUUID());
    const blocks: any[] = Array.isArray(message?.content) ? message.content : [];
    const texts = blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text as string);
    if (texts.length > 0) {
      const reply = this.reply(id);
      // Without partial messages, the complete text arrives here.
      if (!reply.streamed) {
        reply.entry.content += texts.join("\n\n");
        this.close(reply.entry);
      }
    }
    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      const name = String(block.name ?? "tool");
      const input = typeof block.input === "object" && block.input != null ? (block.input as Record<string, unknown>) : {};
      if (name === "TodoWrite") this.host.setTodos(mapTodos(input));
      if (name.startsWith(APP_TOOL_PREFIX)) continue; // the bridge records the app's own tools
      if (this.state.toolEntries.has(block.id)) continue;
      const entry = this.host.createToolEntry(this.state.step, name, summarize(name, input), String(block.id), input);
      this.state.toolEntries.set(String(block.id), entry);
      // Claude Code's own WebSearch reads as the provider searches do: "Searching the web".
      if (name === "WebSearch") this.host.setActivity({ kind: "searching", tool: "web_search", ...(typeof input.query === "string" && input.query.length > 0 ? { detail: input.query } : {}) });
      else this.host.setActivity({ kind: "tool", tool: name, detail: entry.summary });
    }
  }

  private onToolResults(message: any): void {
    this.settleToolResults(message);
    this.host.setActivity({ kind: "thinking" });
  }

  /** Finishes the pending cards whose tool calls this message answers. */
  private settleToolResults(message: any): void {
    const blocks: any[] = Array.isArray(message?.content) ? message.content : [];
    for (const block of blocks) {
      if (block.type !== "tool_result") continue;
      const entry = this.state.toolEntries.get(String(block.tool_use_id));
      if (entry == null || entry.status !== "pending") continue;
      const text = resultText(block.content);
      this.host.finishToolEntry(entry, block.is_error === true ? "failed" : "done", text, block.is_error === true ? text.slice(0, 500) || "The tool failed." : null);
    }
  }

  private onResult(message: any): void {
    this.sawResult = true;
    if (typeof message.session_id === "string") this.outcome.sessionId = message.session_id;
    if (typeof message.result === "string") this.outcome.text = message.result;
    if (message.is_error === true || (typeof message.subtype === "string" && message.subtype !== "success")) {
      const text = typeof message.result === "string" && message.result.length > 0 ? message.result : String(message.subtype ?? "error");
      if (/no conversation found|session.*not found/i.test(text)) this.sessionMissing = true;
      this.host.notice("error", describeFailure(text));
      this.outcome.failed = message.subtype === "error_max_turns" ? "claude-code-max-turns" : "claude-code-error";
    }
  }

  private close(entry: MessageEntry): void {
    if (!entry.isStreaming) return;
    entry.isStreaming = false;
    this.host.commit(entry);
  }

  finish(): void {
    for (const { entry } of this.replies.values()) this.close(entry);
    for (const entry of this.state.toolEntries.values()) {
      if (entry.status === "pending") this.host.finishToolEntry(entry, "failed", entry.detail?.output ?? "", "Interrupted.");
    }
  }
}

function describeFailure(text: string): string {
  if (/not logged in|please run \/login|invalid api key|authentication|oauth/i.test(text)) {
    return "Claude Code isn't signed in. Open Settings → Models → Claude Code and select Sign in, then try again.";
  }
  return `Claude Code: ${text.slice(0, 600)}`;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content.slice(0, OUTPUT_LIMIT);
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (part?.type === "text" ? String(part.text ?? "") : part?.type === "image" ? "[image]" : ""))
    .filter((text) => text.length > 0)
    .join("\n")
    .slice(0, OUTPUT_LIMIT);
}

function mapTodos(input: Record<string, unknown>): AgentTodo[] {
  const now = Date.now();
  const list = Array.isArray(input.todos) ? input.todos : [];
  return list.slice(0, 50).map((item: any, index: number) => ({
    id: typeof item?.id === "string" && item.id.length > 0 ? item.id : `todo-${index + 1}`,
    content: String(item?.content ?? item?.activeForm ?? "").slice(0, 500),
    status: ["pending", "in_progress", "completed", "cancelled"].includes(item?.status) ? item.status : "pending",
    updatedAt: now,
  }));
}

export function summarize(name: string, input: Record<string, unknown>): string {
  const s = (key: string) => String(input[key] ?? "").replace(/\s+/g, " ").slice(0, 160);
  switch (name) {
    case "Bash":
    case "PowerShell":
      return `Ran ${s("command")}`;
    case "Read":
      return `Read ${s("file_path")}`;
    case "Write":
      return `Wrote ${s("file_path")}`;
    case "Edit":
    case "MultiEdit":
      return `Edited ${s("file_path")}`;
    case "NotebookEdit":
      return `Edited ${s("notebook_path")}`;
    case "Glob":
      return `Found files matching ${s("pattern")}`;
    case "Grep":
      return `Searched for “${s("pattern")}”`;
    case "WebFetch":
      return `Fetched ${s("url")}`;
    case "WebSearch":
      return `Searched the web for “${s("query")}”`;
    case "TodoWrite":
      return "Updated the todo list";
    case "Task":
    case "Agent":
      return `Started a subagent: ${s("description")}`;
  }
  if (name.startsWith("mcp__")) {
    const [, server, tool] = name.split("__");
    return `${server}: ${tool}`;
  }
  return name;
}

/** Bridge entry point: answers a Claude Code permission prompt with a standing grant or an approval card. */
export async function approveClaudeCodeRequest(
  host: EngineHost,
  state: BridgeRunState,
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string | null,
): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> {
  const { ask, grantKey } = describeApproval(toolName, input);
  const standing = host.grant(grantKey);
  if (standing === "always") return { behavior: "allow", updatedInput: input };
  if (standing === "never") return { behavior: "deny", message: "The user has asked not to allow this." };
  let entry = toolUseId != null ? state.toolEntries.get(toolUseId) : undefined;
  if (entry == null) {
    entry = host.createToolEntry(state.step, toolName, summarize(toolName, input), toolUseId ?? `approval_${randomUUID()}`, input);
    if (toolUseId != null) state.toolEntries.set(toolUseId, entry);
  }
  const resolution = await host.requestApproval(entry, ask);
  if (resolution === "always" || resolution === "never") host.setGrant(grantKey, resolution);
  if (resolution === "allow-once" || resolution === "always") return { behavior: "allow", updatedInput: input };
  return { behavior: "deny", message: "The user denied this action. Don't retry it; explain or suggest an alternative." };
}

/** Approval card for a Claude Code permission prompt, and the key "always/never" decisions are stored under. */
export function describeApproval(toolName: string, input: Record<string, unknown>): { ask: PermissionAsk; grantKey: string } {
  const s = (key: string) => String(input[key] ?? "");
  const firstWord = (command: string) => command.trim().split(/\s+/)[0] ?? "";
  if (toolName === "Bash" || toolName === "PowerShell") {
    const command = s("command");
    return {
      ask: { action: "run-command", target: command, title: "Run a command", description: s("description") || undefined, risk: "unknown", reasons: ["Claude Code asked to run this command."], standingGrant: { kind: "offered", recipient: `${firstWord(command)} commands` } },
      grantKey: `${toolName}:${firstWord(command)}`,
    };
  }
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) {
    const path = s("file_path") || s("notebook_path");
    return { ask: { action: "write-file", target: path, title: "Edit a file", risk: "mutating", reasons: ["Claude Code asked to change this file."], standingGrant: { kind: "offered", recipient: `${toolName} anywhere` } }, grantKey: toolName };
  }
  if (["Read", "Glob", "Grep"].includes(toolName)) {
    const path = s("file_path") || s("path") || s("pattern");
    return { ask: { action: "read-file", target: path, title: "Read files", risk: "unknown", reasons: ["Claude Code asked to read outside its workspace."], standingGrant: { kind: "offered", recipient: `${toolName} anywhere` } }, grantKey: toolName };
  }
  const target = s("url") || s("query") || toolName;
  return { ask: { action: "use-app", target, title: `Use ${toolName}`, risk: "unknown", reasons: [`Claude Code asked to use ${toolName}.`], standingGrant: { kind: "offered", recipient: toolName } }, grantKey: toolName };
}

function spawnClaude(executable: string, args: string[], cwd: string): ChildProcess {
  // Approvals and questions can wait on the user for a long time.
  const env: NodeJS.ProcessEnv = { ...process.env, MCP_TOOL_TIMEOUT: "3600000" };
  delete env.ELECTRON_RUN_AS_NODE;
  // npm installs a .cmd shim on Windows, which only runs through the shell;
  // the arguments are app-controlled flags and paths (the prompt goes over stdin).
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
    const quote = (value: string) => (/[\s"&|<>^%]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
    return spawn([executable, ...args].map(quote).join(" "), { cwd, env, shell: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  }
  return spawn(executable, args, { cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
}

function killTree(child: ChildProcess): void {
  if (child.pid == null || child.exitCode != null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, "SIGINT");
  } catch {
    child.kill("SIGINT");
  }
}
