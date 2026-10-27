import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { approveClaudeCodeRequest, type BridgeRunState, ClaudeCodeEngine, describeApproval, type EngineHost, type Resolution } from "../../src/box/claude-code";
import type { AgentTodo, MessageEntry, ToolCallEntry } from "../../src/shared/model";

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A stand-in `claude` that records its arguments and stdin, then prints a scripted stream-json run. */
function fakeClaude(lines: unknown[]): { executable: string; record: string } {
  const dir = mkdtempSync(join(tmpdir(), "wisp-claude-"));
  dirs.push(dir);
  const record = join(dir, "record.json");
  const script = join(dir, "fake-claude.cjs");
  writeFileSync(
    script,
    `let input = "";
     process.stdin.on("data", (chunk) => (input += chunk));
     process.stdin.on("end", () => {
       require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), input, cwd: process.cwd() }));
       for (const line of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(line) + "\\n");
     });`,
  );
  if (process.platform === "win32") {
    const shim = join(dir, "claude.cmd");
    writeFileSync(shim, `@"${process.execPath}" "%~dp0fake-claude.cjs" %*\r\n`);
    return { executable: shim, record };
  }
  const shim = join(dir, "claude");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(shim, 0o755);
  return { executable: shim, record };
}

/** Records what the engine does to the transcript. */
function fakeHost(workspace: string, resolution: Resolution = "allow-once") {
  let step = 0;
  let seq = 0;
  const replies: MessageEntry[] = [];
  const tools: ToolCallEntry[] = [];
  const notices: string[] = [];
  const todos: AgentTodo[][] = [];
  const grants = new Map<string, "always" | "never">();
  const approvals: string[] = [];
  const activities: unknown[] = [];
  const entry = <T>(body: object) => ({ id: `e${++seq}`, seq, turn: 1, step, timestampMs: Date.now(), ...body }) as T;
  const host: EngineHost = {
    agentId: "a1",
    signal: new AbortController().signal,
    workspace: () => workspace,
    agentNotes: () => "You are working as Tester.",
    newStep: () => ++step,
    beginReply: (at) => {
      const reply = entry<MessageEntry>({ kind: "message", role: "assistant", content: "", isStreaming: true, step: at });
      replies.push(reply);
      return reply;
    },
    stream: () => undefined,
    commit: () => undefined,
    createToolEntry: (at, name, summary, callId, args) => {
      const tool = entry<ToolCallEntry>({ kind: "tool-call", name, status: "pending", summary, step: at, engine: "claude-code", detail: { callId, args, output: "", error: null, image: null, startedAt: 0, finishedAt: null } });
      tools.push(tool);
      return tool;
    },
    finishToolEntry: (tool, status, output, error) => Object.assign(tool, { status, detail: { ...tool.detail!, output, error } }),
    notice: (_tone, text) => void notices.push(text),
    setActivity: (activity) => void activities.push(activity),
    setTodos: (list) => void todos.push(list),
    requestApproval: async (_entry, ask) => (approvals.push(`${ask.action}:${ask.target}`), resolution),
    runAppTool: async () => ({ output: "ok", isError: false, image: null }),
    appTools: () => [],
    grant: (key) => grants.get(key) ?? null,
    setGrant: (key, value) => void grants.set(key, value),
  };
  return { host, replies, tools, notices, todos, grants, approvals, activities };
}

const bridge = { register: () => "bridge-token", unregister: () => undefined, baseUrl: () => "http://127.0.0.1:9", bridgeScript: "bridge.cjs" };

test("claude code engine: runs the CLI headless and maps stream-json into the transcript", async () => {
  const sessionId = "6f1f9d2e-5d6c-4c55-9a2b-6c7c1f0b8e11";
  const { executable, record } = fakeClaude([
    { type: "system", subtype: "init", session_id: sessionId, model: "claude-opus-5-5", mcp_servers: [{ name: "wisp", status: "connected" }] },
    // Hidden thinking arrives as empty deltas and must not leave an empty reply row.
    { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_0" } } },
    { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } } },
    { type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } },
    { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_1" } } },
    { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Look first." } } },
    { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Listing files." } } },
    { type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", content: [{ type: "text", text: "Listing files." }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" } }] } },
    { type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", content: [{ type: "tool_use", id: "toolu_2", name: "TodoWrite", input: { todos: [{ content: "List files", status: "completed", activeForm: "Listing files" }] } }] } },
    { type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", content: [{ type: "tool_use", id: "toolu_3", name: "WebSearch", input: { query: "ls flags" } }] } },
    { type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } },
    {
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt\nb.txt" }, { type: "tool_result", tool_use_id: "toolu_2", content: "ok" }, { type: "tool_result", tool_use_id: "toolu_3", content: "results" }] },
    },
    { type: "assistant", parent_tool_use_id: "toolu_sub", message: { id: "msg_sub", content: [{ type: "text", text: "subagent chatter" }] } },
    { type: "assistant", parent_tool_use_id: null, message: { id: "msg_2", content: [{ type: "text", text: "There are two files." }] } },
    { type: "result", subtype: "success", is_error: false, result: "There are two files.", session_id: sessionId, total_cost_usd: 0.01 },
  ]);
  const workspace = mkdtempSync(join(tmpdir(), "wisp-ws-"));
  dirs.push(workspace);
  const temp = mkdtempSync(join(tmpdir(), "wisp-cc-"));
  dirs.push(temp);
  const engine = new ClaudeCodeEngine({ bridge, tempDir: temp, mcpServers: () => [{ id: "echo", name: "echo", command: "node", args: ["echo.js"], env: {}, enabled: true }], log: () => undefined });
  const fake = fakeHost(workspace);
  const outcome = await engine.runTurn(fake.host, { kind: "claude-code", ref: { provider: "claude-code", model: "opus" }, executable, effort: "high" }, { prompt: "[Sent now]\nwhat's here?", sessionId: null });

  const recorded = JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; input: string; cwd: string };
  assert.equal(recorded.input, "[Sent now]\nwhat's here?", "the prompt goes over stdin");
  assert.equal(recorded.cwd.toLowerCase(), workspace.toLowerCase(), "runs in the agent workspace");
  const flag = (name: string) => recorded.argv[recorded.argv.indexOf(name) + 1];
  assert.ok(recorded.argv.includes("-p"));
  assert.equal(flag("--output-format"), "stream-json");
  assert.equal(flag("--permission-prompt-tool"), "mcp__wisp__approve");
  assert.equal(flag("--permission-mode"), "acceptEdits");
  assert.equal(flag("--model"), "opus");
  assert.equal(flag("--effort"), "high");
  assert.match(flag("--session-id"), /^[0-9a-f-]{36}$/);
  assert.equal(recorded.argv.includes("--resume"), false);
  assert.equal(recorded.argv.includes("--bare"), false, "bare mode would skip the user's own Claude Code sign-in");

  assert.equal(outcome.failed, null);
  assert.equal(outcome.sessionId, sessionId);
  assert.equal(outcome.text, "There are two files.");
  assert.deepEqual(
    fake.replies.map((reply) => [reply.content, reply.reasoning ?? ""]),
    [
      ["Listing files.", "Look first."],
      ["There are two files.", ""],
    ],
  );
  assert.deepEqual(
    fake.tools.map((tool) => [tool.name, tool.summary, tool.status, tool.detail?.output]),
    [
      ["Bash", "Ran ls -la", "done", "a.txt\nb.txt"],
      ["TodoWrite", "Updated the todo list", "done", "ok"],
      ["WebSearch", "Searched the web for “ls flags”", "done", "results"],
    ],
  );
  assert.ok(fake.activities.some((activity) => JSON.stringify(activity) === JSON.stringify({ kind: "searching", tool: "web_search", detail: "ls flags" })), "its WebSearch reads as searching");
  assert.equal(fake.todos[0][0].content, "List files", "Claude Code's todo list mirrors into the app's");
  assert.equal(fake.notices.length, 0);
});

test("claude code engine: a subagent's tool that asked for approval gets its result; the rest of the subagent stays inside its Task card", async () => {
  const { executable } = fakeClaude([
    { type: "system", subtype: "init", session_id: "s-4", mcp_servers: [{ name: "wisp", status: "connected" }] },
    { type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", content: [{ type: "tool_use", id: "toolu_task", name: "Task", input: { description: "Install deps", prompt: "npm install" } }] } },
    // Inside the subagent, Read ran without asking and Bash asked first (its card came from the bridge).
    {
      type: "assistant",
      parent_tool_use_id: "toolu_task",
      message: { id: "msg_sub", content: [{ type: "tool_use", id: "toolu_sub_read", name: "Read", input: { file_path: "package.json" } }, { type: "tool_use", id: "toolu_sub_bash", name: "Bash", input: { command: "npm install" } }] },
    },
    { type: "user", parent_tool_use_id: "toolu_task", message: { content: [{ type: "tool_result", tool_use_id: "toolu_sub_read", content: "{}" }, { type: "tool_result", tool_use_id: "toolu_sub_bash", content: "added 1 package" }] } },
    { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "toolu_task", content: "Installed." }] } },
    { type: "assistant", parent_tool_use_id: null, message: { id: "msg_2", content: [{ type: "text", text: "Done." }] } },
    { type: "result", subtype: "success", is_error: false, result: "Done.", session_id: "s-4" },
  ]);
  const workspace = mkdtempSync(join(tmpdir(), "wisp-ws-"));
  dirs.push(workspace);
  // The bridge's approve endpoint is called while the CLI runs, so the card exists before the subagent's result arrives.
  const approving = { ...bridge, register: (host: EngineHost, state: BridgeRunState) => (void approveClaudeCodeRequest(host, state, "Bash", { command: "npm install" }, "toolu_sub_bash"), "bridge-token") };
  const fake = fakeHost(workspace);
  await new ClaudeCodeEngine({ bridge: approving, tempDir: workspace, mcpServers: () => [], log: () => undefined }).runTurn(
    fake.host,
    { kind: "claude-code", ref: { provider: "claude-code", model: "default" }, executable, effort: "default" },
    { prompt: "install", sessionId: null },
  );
  assert.deepEqual(fake.approvals, ["run-command:npm install"]);
  assert.deepEqual(
    fake.tools.map((tool) => [tool.name, tool.status, tool.detail?.output, tool.detail?.error]),
    [
      ["Bash", "done", "added 1 package", null],
      ["Task", "done", "Installed.", null],
    ],
    "the approved Bash finishes with its output instead of failing as interrupted, and Read gets no row",
  );
  assert.deepEqual(
    fake.activities.map((activity) => (activity as { kind: string }).kind),
    ["tool", "thinking"],
    "the subagent's results leave the activity on its Task",
  );
});

test("claude code engine: a sign-in failure becomes an actionable notice and a resumed session reuses its id", async () => {
  const { executable, record } = fakeClaude([{ type: "result", subtype: "error_during_execution", is_error: true, result: "Not logged in · Please run /login", session_id: "s-1" }]);
  const workspace = mkdtempSync(join(tmpdir(), "wisp-ws-"));
  dirs.push(workspace);
  const engine = new ClaudeCodeEngine({ bridge, tempDir: workspace, mcpServers: () => [], log: () => undefined });
  const fake = fakeHost(workspace);
  const outcome = await engine.runTurn(fake.host, { kind: "claude-code", ref: { provider: "claude-code", model: "default" }, executable, effort: "default" }, { prompt: "hi", sessionId: "s-1" });
  const argv = (JSON.parse(readFileSync(record, "utf8")) as { argv: string[] }).argv;
  assert.equal(argv[argv.indexOf("--resume") + 1], "s-1");
  assert.equal(argv.includes("--model"), false, "the default model leaves Claude Code's own choice");
  assert.equal(argv.includes("--effort"), false);
  assert.equal(outcome.failed, "claude-code-error");
  assert.match(fake.notices[0], /isn't signed in/);
});

test("claude code engine: tools switched off in Connect Apps are removed from Claude's context", async () => {
  const { executable, record } = fakeClaude([{ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s-2" }]);
  const workspace = mkdtempSync(join(tmpdir(), "wisp-ws-"));
  dirs.push(workspace);
  const engine = new ClaudeCodeEngine({
    bridge,
    tempDir: workspace,
    mcpServers: () => [
      { id: "files", name: "files", command: "node", args: ["files.js"], env: {}, enabled: true, disabledTools: ["delete_file", "move.file"] },
      // Not given to Claude Code (it has no sign-in to pass on), so nothing of it is named either.
      { id: "notes", name: "Notes", transport: "http", url: "https://mcp.example.com/mcp", headers: {}, enabled: true, disabledTools: ["write"] },
      { id: "off", name: "off", command: "node", args: [], env: {}, enabled: false, disabledTools: ["x"] },
    ],
    mcpHttpHeaders: async () => null,
    log: () => undefined,
  });
  await engine.runTurn(fakeHost(workspace).host, { kind: "claude-code", ref: { provider: "claude-code", model: "default" }, executable, effort: "default" }, { prompt: "hi", sessionId: null });
  const argv = (JSON.parse(readFileSync(record, "utf8")) as { argv: string[] }).argv;
  const at = argv.indexOf("--disallowedTools");
  assert.deepEqual(argv.slice(at + 1, argv.indexOf("--mcp-config")), ["mcp__files__delete_file", "mcp__files__move_file"]);

  const none = fakeClaude([{ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s-3" }]);
  await new ClaudeCodeEngine({ bridge, tempDir: workspace, mcpServers: () => [{ id: "files", name: "files", command: "node", args: [], env: {}, enabled: true }], log: () => undefined }).runTurn(
    fakeHost(workspace).host,
    { kind: "claude-code", ref: { provider: "claude-code", model: "default" }, executable: none.executable, effort: "default" },
    { prompt: "hi", sessionId: null },
  );
  assert.equal((JSON.parse(readFileSync(none.record, "utf8")) as { argv: string[] }).argv.includes("--disallowedTools"), false);
});

test("claude code approvals: cards for permission prompts, standing grants remembered per command", async () => {
  const fake = fakeHost("/ws", "always");
  const state: BridgeRunState = { step: 1, toolEntries: new Map() };
  const first = await approveClaudeCodeRequest(fake.host, state, "Bash", { command: "npm install left-pad" }, "toolu_7");
  assert.deepEqual(first, { behavior: "allow", updatedInput: { command: "npm install left-pad" } });
  assert.deepEqual(fake.approvals, ["run-command:npm install left-pad"]);
  assert.equal(fake.grants.get("Bash:npm"), "always");
  // The same program is now allowed without another card.
  const second = await approveClaudeCodeRequest(fake.host, state, "Bash", { command: "npm test" }, "toolu_8");
  assert.equal(second.behavior, "allow");
  assert.equal(fake.approvals.length, 1);

  const denying = fakeHost("/ws", "deny");
  const denied = await approveClaudeCodeRequest(denying.host, { step: 1, toolEntries: new Map() }, "WebFetch", { url: "https://example.com" }, null);
  assert.equal(denied.behavior, "deny");
  assert.equal(denying.tools[0].name, "WebFetch", "a prompt without a known tool call still gets a row to attach the card to");

  assert.equal(describeApproval("Edit", { file_path: "/x/y.ts" }).ask.action, "write-file");
  assert.equal(describeApproval("Read", { file_path: "/etc/hosts" }).ask.action, "read-file");
  assert.equal(describeApproval("mcp__github__create_issue", {}).ask.action, "use-app");
});
