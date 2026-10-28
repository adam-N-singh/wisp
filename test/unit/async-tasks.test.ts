import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AsyncTaskError, AsyncTasks } from "../../src/box/async-tasks";
import { CLOUD_PID_PLACEHOLDER, type CloudComputer } from "../../src/box/cloud-computer";
import { CLOUD_TOOLS } from "../../src/box/cloud-tools";
import { Harness } from "../../src/box/harness";
import { McpManager } from "../../src/box/mcp";
import { conversationOutline } from "../../src/box/outline";
import { BoxStore } from "../../src/box/store";
import { type BoxServer, startBoxServer } from "../../src/box-server/server";
import { BackgroundShells, processAlive, samePath, ShellError } from "../../src/local-exec/background";
import { LOCAL_TOOLS, type ToolContext } from "../../src/local-exec/tools";
import { type BackgroundShellStatus, headerLength, logFooter, logHeader, readLogView } from "../../src/shared/background-shell";
import type { BoxModelConfig } from "../../src/shared/edges";
import { readSse, type ToolResult } from "../../src/shared/gateway-protocol";
import type { AgentSummary, AsyncTaskInfo, CloudComputerStatus, EndedAsyncTask, MessageEntry, TranscriptEntry } from "../../src/shared/model";

const cleanup: Array<() => void> = [];
after(() => {
  for (const fn of cleanup.reverse()) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wisp-async-tasks-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const node = (script: string, ...args: string[]) => ({ file: process.execPath, args: ["-e", script, ...args], env: { ...process.env } });

function daemonShells(dir = tempDir()) {
  const changes: BackgroundShellStatus[] = [];
  const shells = new BackgroundShells({ dir, onChange: (status) => changes.push(status), log: () => undefined });
  cleanup.push(() => shells.shutdown());
  return { dir, shells, changes };
}

// ---- the daemon: background commands on the PC ------------------------------------------------

test("background command: started into its log, awaited for a line of output, then to its end", async () => {
  const { dir, shells, changes } = daemonShells();
  const script = "console.log('starting'); setTimeout(() => console.log('ready on 4000'), 300); setTimeout(() => { console.log('bye'); process.exit(3); }, 3000);";
  const task = shells.start({ agentId: "a1", command: "node server.js", cwd: dir, ...node(script) });
  assert.ok(task.id >= 1000 && task.id <= 999_999);
  assert.equal(task.state, "running");
  assert.equal(task.origin, "spawned");
  assert.equal(task.logPath, join(dir, `${task.id}.txt`));
  assert.ok(task.pid != null && task.pid > 0);
  assert.deepEqual(
    changes.map((change) => change.state),
    ["running"],
    "the box hears of the start",
  );
  assert.match(readFileSync(task.logPath, "utf8"), /^---\npid: \d+ *\ncwd: .+\ncommand: node server\.js\ntitle: node server\.js\nstatus: running *\nstarted_at: \d{4}-\d\d-\d\dT[\d:.]+Z\nrunning_for_ms: \d+ *\n---\n/);

  const signal = new AbortController().signal;
  const ready = await shells.await("a1", task.id, { blockUntilMs: 10_000, regex: "ready on (\\d+)", signal });
  assert.equal(ready.regexMatch, "ready on 4000");
  assert.equal(ready.task.state, "running", "the match comes before the command ends");

  const ended = await shells.await("a1", task.id, { blockUntilMs: 15_000, signal });
  assert.equal(ended.task.state, "failed");
  assert.equal(ended.task.exitCode, 3);
  assert.equal(ended.view.footer?.exitCode, 3);
  assert.match(ended.view.output, /starting\r?\nready on 4000\r?\nbye/);
  assert.doesNotMatch(ended.view.output, /exit_code|running_for_ms/, "the header and footer aren't output");
  const log = readFileSync(task.logPath, "utf8");
  assert.match(log, /\nstatus: failed *\n/, "the header is rewritten with the end");
  assert.match(log, /\n---\nexit_code: 3\nelapsed_ms: \d+\nended_at: [^\n]+Z\n---\n$/);
  assert.deepEqual(
    changes.map((change) => change.state),
    ["running", "failed"],
  );
  assert.match(changes[1].tail ?? "", /bye/);

  // Only the agent that started it can wait for it.
  await assert.rejects(shells.await("a2", task.id, { blockUntilMs: 0, signal }), ShellError);
  await assert.rejects(shells.await("a1", 999_999, { blockUntilMs: 0, signal }), /no background command 999999/);
  assert.equal(shells.ownsLog("a1", task.logPath), true);
  assert.equal(shells.ownsLog("a2", task.logPath), false);
});

test("background command: stop_command stops it and every process it started", async () => {
  const { dir, shells } = daemonShells();
  const pidFile = join(dir, "grandchild.pid");
  const grandchild = "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);";
  const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, process.argv[1]], { stdio: 'ignore' }); console.log('parent up'); setInterval(() => {}, 1000);`;
  const task = shells.start({ agentId: "a1", command: "npm run watch", cwd: dir, ...node(parent, pidFile) });
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0);
  const grandchildPid = Number(readFileSync(pidFile, "utf8"));
  assert.equal(processAlive(grandchildPid), true);

  const stopped = await shells.stop("a1", task.id, "Stopped by the agent.");
  assert.equal(stopped.state, "aborted");
  assert.equal(stopped.detail, "Stopped by the agent.");
  await until(() => !processAlive(grandchildPid), 10_000);
  assert.match(readFileSync(task.logPath, "utf8"), /\nstatus: aborted *\n[\s\S]*parent up[\s\S]*\nexit_code: /);
  // Stopping it again just reports how it ended.
  assert.equal((await shells.stop("a1", task.id, "again")).detail, "Stopped by the agent.");
});

const usesPowerShell = process.platform === "win32" && process.env.WISP_SHELL !== "bash";

test("run_shell: background starts at once, and a command past its timeout goes on in the background", async () => {
  const { dir, shells } = daemonShells();
  const progress: string[] = [];
  const context = { agentId: "a1", cwd: dir, wasmDir: process.env.TEST_WASM_DIR!, signal: new AbortController().signal, progress: (chunk: string) => progress.push(chunk), shells, host: {} } as unknown as ToolContext;
  const signal = new AbortController().signal;

  const quick = await LOCAL_TOOLS.run_shell.execute({ command: usesPowerShell ? "Write-Output 'hello from the background'" : "echo hello from the background", background: true }, context);
  assert.equal(quick.task?.origin, "spawned");
  assert.match(quick.output, /^Started background command \d+ \(pid \d+\): /);
  const quickEnd = await shells.await("a1", quick.task!.id, { blockUntilMs: 20_000, signal });
  assert.equal(quickEnd.task.state, "succeeded");
  assert.match(quickEnd.view.output, /hello from the background/);

  const slow = usesPowerShell ? "Write-Output 'first'; Start-Sleep -Seconds 3; Write-Output 'second'" : "echo first; sleep 3; echo second";
  const started = Date.now();
  const adopted = await LOCAL_TOOLS.run_shell.execute({ command: slow, timeout_ms: 1_000 }, context);
  assert.ok(Date.now() - started < 2_500, "the call returns at its timeout");
  assert.equal(adopted.task?.origin, "adopted");
  assert.equal(adopted.task?.state, "running");
  assert.match(adopted.output, /left running as background command \d+ instead of being stopped/);
  const end = await shells.await("a1", adopted.task!.id, { blockUntilMs: 20_000, signal });
  assert.equal(end.task.state, "succeeded");
  assert.equal(end.task.exitCode, 0);
  assert.match(end.view.output, /first[\s\S]*second/, "its output went on into the log");
});

test("background commands: a restarted daemon marks those it can't see as lost", () => {
  const bootedAt = Math.round(Date.now() - os.uptime() * 1000);
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  const seed = (dir: string, booted: number) => {
    const status: BackgroundShellStatus = { id: 4242, agentId: "a1", command: "npm run dev", cwd: dir, pid: deadPid, logPath: join(dir, "4242.txt"), state: "running", exitCode: null, startedAt: Date.now() - 60_000, endedAt: null, origin: "spawned" };
    writeFileSync(status.logPath, `${logHeader({ pid: deadPid, cwd: dir, command: status.command, state: "running", startedAt: status.startedAt, runningForMs: 5_000 })}some output\n`);
    writeFileSync(join(dir, "index.json"), JSON.stringify({ schemaVersion: 1, bootedAt: booted, shells: [status] }));
  };

  const restarted = tempDir();
  seed(restarted, bootedAt);
  const { shells, changes } = daemonShells(restarted);
  const [lost] = shells.snapshot();
  assert.equal(lost.state, "lost");
  assert.match(lost.detail ?? "", /local tools restarted/);
  assert.equal(changes.length, 0, "the box hears of it with the next registration");
  const log = readFileSync(lost.logPath, "utf8");
  assert.match(log, /\nstatus: lost *\n/);
  assert.match(log, /some output\n\n---\nexit_code: unknown\n/);
  assert.equal(readLogView(Buffer.from(log), Buffer.from(log), 0, Buffer.byteLength(log)).output, "some output\n");
  // It stays lost.
  assert.equal(daemonShells(restarted).shells.snapshot()[0].state, "lost");

  const rebooted = tempDir();
  seed(rebooted, 0);
  assert.match(daemonShells(rebooted).shells.snapshot()[0].detail ?? "", /computer restarted/);
});

test("background command logs: an agent's own log matches with case folded only where the file system folds it", () => {
  assert.equal(samePath("/x/terminals/1234.txt", "/x/terminals/1234.TXT", "linux"), false);
  assert.equal(samePath("/x/terminals/../terminals/1234.txt", "/x/terminals/1234.txt", "linux"), true);
  assert.equal(samePath("/x/terminals/1234.txt", "/x/terminals/1234.TXT", "darwin"), true);
  assert.equal(samePath("C:\\x\\terminals\\1234.txt", "c:\\X\\Terminals\\1234.TXT", "win32"), true);
});

// ---- the box: the registry, the completion wake, restarts ------------------------------------------

const MOCK_MODELS: BoxModelConfig = { defaultModel: { provider: "mock", model: "mock-1" }, reasoningEffort: "default", temperature: null, xai: null, openai: null, anthropic: null, custom: null, claudeCode: null };

function agent(id: string): AgentSummary {
  const now = Date.now();
  return {
    id, name: "Tester", description: "", path: "", origin: "user", isGroup: false, memberIds: [], isActive: false, createdAt: now, updatedAt: now,
    isRunning: false, isComposingMessage: false, awaitingUserResponse: null, hasUnread: false, lastMessageId: null, lastEntry: null,
    notificationsEnabled: true, notifyOnUpdatesEnabled: true, avatarDataUrl: null, instructions: "", model: null, isPinned: false,
  };
}

function shell(id: number, state: BackgroundShellStatus["state"], extra: Partial<BackgroundShellStatus> = {}): BackgroundShellStatus {
  const ended = state !== "running";
  return {
    id, agentId: "a1", command: "npm run build", cwd: "C:\\work", pid: 7000 + (id % 1000), logPath: `C:\\app\\local-exec\\terminals\\${id}.txt`, state,
    exitCode: state === "succeeded" ? 0 : null, startedAt: Date.now() - 65_000, endedAt: ended ? Date.now() : null, origin: "spawned", ...extra,
  };
}

function setupBox(dir = tempDir(), options: { cloud?: CloudComputer; cloudPollMs?: number; controlLocal?: (request: { agentId: string; shellId: number; action: "stop" | "output" }) => ToolResult } = {}) {
  const store = new BoxStore(dir);
  cleanup.push(() => store.close());
  if (store.getAgent("a1") == null) store.putAgent(agent("a1"));
  const events: Array<{ channel: string; payload: any }> = [];
  const controls: Array<{ agentId: string; shellId: number; action: string }> = [];
  const emit = (channel: string, payload: unknown) => events.push({ channel, payload });
  let harness: Harness;
  const tasks = new AsyncTasks({
    store,
    emit,
    patchAgent: (agentId, patch) => harness.patchAgent(agentId, patch),
    ended: (record, text, wake) => harness.notifyQuietly(record.agentId, text, wake),
    controlLocal: async (request) => {
      controls.push(request);
      return options.controlLocal?.(request) ?? { kind: "error", message: "no daemon" };
    },
    localHost: () => "TESTPC",
    cloud: options.cloud ?? null,
    log: () => undefined,
    cloudPollMs: options.cloudPollMs,
  });
  cleanup.push(() => tasks.stop());
  harness = new Harness({
    store,
    models: () => MOCK_MODELS,
    resolveDeps: { chatGptToken: async () => "unused" },
    workspaceRoot: () => join(dir, "workspaces"),
    localTools: () => [],
    callLocalTool: async () => ({ kind: "error", message: "no local tools" }),
    mcp: new McpManager(() => undefined, () => undefined),
    claudeCode: null,
    cloud: options.cloud ?? null,
    cloudConfig: () => null,
    asyncTasks: tasks,
    emit,
    log: () => undefined,
  });
  cleanup.push(() => harness.shutdown());
  tasks.start();
  const quiet = () => store.entries("a1").filter((entry): entry is MessageEntry => entry.kind === "message" && entry.suppressed === "quiet-wake");
  const replies = () => store.entries("a1").filter((entry): entry is MessageEntry => entry.kind === "message" && entry.role === "assistant" && !entry.isStreaming && entry.content.length > 0);
  return { dir, store, harness, tasks, events, controls, quiet, replies };
}

test("async tasks: a background command that ends unseen wakes its agent with a hidden message", async () => {
  const { dir, store, harness, tasks, events, quiet, replies } = setupBox();
  tasks.noteShell("local", shell(1234, "running"), "TESTPC");
  const [info] = tasks.info("a1");
  assert.deepEqual(
    { ...info, startedAtMs: 0 },
    {
      id: "local:1234", kind: "shell", label: "npm run build", labelKind: "shell_command", labelParams: { id: "1234" }, startedAtMs: 0, status: "running", detailKind: null,
      command: "npm run build", computer: "local", computerLabel: "TESTPC", outputPath: "C:\\app\\local-exec\\terminals\\1234.txt",
    } satisfies AsyncTaskInfo,
  );
  assert.equal(store.getAgent("a1")!.asyncTaskCount, 1, "the agent shows as working");
  assert.deepEqual(events.filter((event) => event.channel === "background-work").at(-1)?.payload.tasks.map((task: AsyncTaskInfo) => task.id), ["local:1234"]);

  tasks.noteShell("local", shell(1234, "succeeded", { tail: "Build complete" }), "TESTPC");
  assert.deepEqual(tasks.info("a1"), []);
  assert.equal(store.getAgent("a1")!.asyncTaskCount, 0);
  assert.deepEqual(events.filter((event) => event.channel === "background-work").at(-1)?.payload, { parentAgentId: "a1", tasks: [] });
  const [message] = quiet();
  assert.equal(message.role, "user");
  assert.match(message.content, /^\[Background command 1234 finished: exit code 0 after 1m \d+s\]\nCommand: npm run build\nLast output:\nBuild complete\nFull output: C:\\app\\local-exec\\terminals\\1234\.txt\.$/);

  // The agent is woken: it reads the message as a user message and replies.
  await until(() => !store.getAgent("a1")!.isRunning && replies().length === 1);
  assert.match(replies()[0].content, /You said: "\[Background command 1234 finished/);
  assert.equal(store.getAgent("a1")!.lastTurnSettlement?.outcome, "success");
  const conversation = harness.buildConversation("a1");
  const user = conversation.find((item) => item.kind === "user");
  assert.match(user?.kind === "user" && user.parts[0].type === "text" ? user.parts[0].text : "", /\[Background command 1234 finished/);
  const outlined = conversationOutline(store.entries("a1")).find((item) => item.id === message.id);
  assert.equal(outlined?.kind === "user" ? outlined.hidden : null, true, "the outline lists it as hidden");

  // The same news again (a daemon's list) tells it nothing new.
  tasks.reconcileLocal("TESTPC", [shell(1234, "succeeded")]);
  assert.equal(quiet().length, 1);
  const saved = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"));
  assert.deepEqual(saved.tasks.map((record: { key: string; status: string; notified: boolean }) => [record.key, record.status, record.notified]), [["local:1234", "succeeded", true]]);
});

test("async tasks: a stop or an await says how it ended, so it neither wakes the agent nor tells it twice", async () => {
  const { store, tasks, controls, quiet, replies } = setupBox(undefined, { controlLocal: (request) => ({ kind: "ok", output: "", task: shell(request.shellId, "aborted", { detail: "Stopped by the user." }) }) });

  // The panel's Stop: the agent hears of it, but isn't woken.
  tasks.noteShell("local", shell(2000, "running"), "TESTPC");
  await tasks.cancel("a1", "local:2000");
  assert.deepEqual(controls, [{ agentId: "a1", shellId: 2000, action: "stop" }]);
  assert.equal(tasks.record("local:2000")?.status, "stopped");
  assert.match(quiet()[0].content, /^\[Background command 2000 was stopped by the user after /);
  await sleep(300);
  assert.equal(store.getAgent("a1")!.isRunning, false);
  assert.equal(replies().length, 0);

  // stop_command: the agent did it, and its tool result said so.
  tasks.noteShell("local", shell(2001, "running"), "TESTPC");
  tasks.noteShell("local", shell(2001, "aborted"), "TESTPC", { stoppedBy: "agent" });
  assert.equal(tasks.record("local:2001")?.status, "stopped");
  assert.equal(quiet().length, 1);

  // An await_command that reports the end: nothing else is said.
  tasks.noteShell("local", shell(3000, "running"), "TESTPC");
  const release = tasks.awaiting("local", 3000);
  tasks.noteShell("local", shell(3000, "failed", { exitCode: 2 }), "TESTPC");
  assert.equal(quiet().length, 1, "the await's to report");
  release(true);
  assert.equal(quiet().length, 1);

  // One that returned before the end (say at a regex match) leaves it to the message.
  tasks.noteShell("local", shell(3001, "running"), "TESTPC");
  const early = tasks.awaiting("local", 3001);
  tasks.noteShell("local", shell(3001, "failed", { exitCode: 1 }), "TESTPC");
  early(false);
  assert.match(quiet()[1].content, /^\[Background command 3001 failed: exit code 1 after /);
  await until(() => !store.getAgent("a1")!.isRunning && replies().length === 1);
});

test("async tasks: after a restart of the box or the PC, lost tasks are marked lost instead of hanging", async () => {
  const dir = tempDir();
  const first = setupBox(dir);
  first.tasks.noteShell("local", shell(4000, "running"), "TESTPC");
  first.tasks.noteShell("local", shell(4001, "running"), "TESTPC");
  first.tasks.noteShell("local", shell(4002, "running"), "OTHERPC");
  first.tasks.stop();
  first.store.close();

  // The box restarts: they are picked up again.
  const { store, tasks, quiet, replies } = setupBox(dir);
  assert.equal(store.getAgent("a1")!.asyncTaskCount, 3);
  const reattached = tasks.info("a1").find((task) => task.id === "local:4000")!;
  assert.equal(reattached.detailKind, "reattached");
  assert.equal(reattached.detail, "Picked up again after the box restarted.");

  // The PC registers again: 4000 is gone from its list, 4001 ended while the box was down; 4002 is another PC's.
  tasks.reconcileLocal("TESTPC", [shell(4001, "failed", { exitCode: 1, tail: "error TS2345" })]);
  assert.equal(tasks.record("local:4000")?.status, "lost");
  assert.equal(tasks.record("local:4001")?.status, "failed");
  assert.equal(tasks.record("local:4002")?.status, "running");
  assert.deepEqual(tasks.info("a1").map((task) => task.id), ["local:4002"]);
  assert.equal(store.getAgent("a1")!.asyncTaskCount, 1);
  const texts = quiet().map((message) => message.content);
  assert.equal(texts.length, 2);
  assert.ok(texts.some((text) => /^\[Background command 4000 was lost: The PC's local tools have no record of it any more\.\]/.test(text)));
  assert.ok(texts.some((text) => /^\[Background command 4001 failed: exit code 1 after [^\]]+\][\s\S]*Last output:\nerror TS2345/.test(text)));
  await until(() => !store.getAgent("a1")!.isRunning && replies().length >= 1);

  // A command the daemon itself found lost after its own restart says why.
  tasks.noteShell("local", shell(4003, "running"), "TESTPC");
  tasks.reconcileLocal("TESTPC", [shell(4003, "lost", { detail: "It stopped when the app's local tools restarted." })]);
  assert.match(quiet().at(-1)!.content, /^\[Background command 4003 was lost: It stopped when the app's local tools restarted\.\]/);
  // Old news of a command the box never knew stays old.
  tasks.reconcileLocal("TESTPC", [shell(4004, "succeeded", { endedAt: Date.now() - 2 * 3_600_000 })]);
  assert.equal(tasks.record("local:4004"), undefined);
  await until(() => !store.getAgent("a1")!.isRunning);
});

test("async tasks: the Ended list says how each ended, newest first, beside the running list", async () => {
  const base = Date.now() - 600_000;
  const { store, tasks } = setupBox(undefined, { controlLocal: (request) => ({ kind: "ok", output: "", task: shell(request.shellId, "aborted", { startedAt: base, endedAt: base + 240_000 }) }) });
  const run = (id: number) => tasks.noteShell("local", shell(id, "running", { startedAt: base }), "TESTPC");
  run(7001);
  tasks.noteShell("local", shell(7001, "succeeded", { startedAt: base, endedAt: base + 60_000, tail: "built" }), "TESTPC");
  run(7002);
  tasks.noteShell("local", shell(7002, "failed", { startedAt: base, endedAt: base + 120_000, exitCode: 2 }), "TESTPC");
  run(7003);
  tasks.noteShell("local", shell(7003, "aborted", { startedAt: base, endedAt: base + 180_000 }), "TESTPC", { stoppedBy: "agent" });
  run(7004);
  await tasks.cancel("a1", "local:7004");
  run(7005);
  tasks.noteShell("local", shell(7005, "lost", { startedAt: base, endedAt: base + 300_000, detail: "It stopped when the app's local tools restarted." }), "TESTPC");
  run(7006);

  assert.deepEqual(tasks.info("a1").map((task) => task.id), ["local:7006"], "readAsyncTasks still lists only what runs");
  const ended = tasks.ended("a1");
  assert.deepEqual(
    ended.map((task) => [task.id, task.status, task.exitCode, task.stoppedBy ?? null, task.endedAtMs - task.startedAtMs]),
    [
      ["local:7005", "lost", null, null, 300_000],
      ["local:7004", "stopped", null, "user", 240_000],
      ["local:7003", "stopped", null, "agent", 180_000],
      ["local:7002", "failed", 2, null, 120_000],
      ["local:7001", "succeeded", 0, null, 60_000],
    ],
  );
  assert.deepEqual(
    { ...ended[4], endedAtMs: 0, startedAtMs: 0 },
    {
      id: "local:7001", kind: "shell", label: "npm run build", labelKind: "shell_command", labelParams: { id: "7001" }, command: "npm run build", computer: "local", computerLabel: "TESTPC",
      outputPath: "C:\\app\\local-exec\\terminals\\7001.txt", status: "succeeded", exitCode: 0, startedAtMs: 0, endedAtMs: 0, tail: "built", logExists: true,
    } satisfies EndedAsyncTask,
  );
  assert.equal(ended[0].detail, "It stopped when the app's local tools restarted.");
  assert.equal(tasks.ended("a1", 2).length, 2);

  // The daemon drops ended commands with their logs: those missing from its list have none to open.
  tasks.reconcileLocal("TESTPC", [7003, 7004, 7005].map((id) => shell(id, "aborted", { startedAt: base, endedAt: base })).concat(shell(7006, "running", { startedAt: base })));
  assert.deepEqual(
    tasks.ended("a1").map((task) => [task.id, task.logExists]),
    [
      ["local:7005", true],
      ["local:7004", true],
      ["local:7003", true],
      ["local:7002", false],
      ["local:7001", false],
    ],
  );
  assert.deepEqual(tasks.info("a1").map((task) => task.id), ["local:7006"]);
  await until(() => !store.getAgent("a1")!.isRunning);
});

test("async tasks: Stop all stops each running one on the PC and the cloud computer, tells the agent of each without waking it, and reports what it can't reach", async () => {
  const fake = new FakeCloud();
  const cloud = fake as unknown as CloudComputer;
  const offline = new Set<number>();
  const { store, tasks, controls, quiet, replies } = setupBox(undefined, {
    cloud,
    cloudPollMs: 200,
    controlLocal: (request) => {
      if (offline.has(request.shellId)) throw new AsyncTaskError("offline", "TESTPC isn’t connected, so its command can’t be reached now.");
      return { kind: "ok", output: "", task: shell(request.shellId, "aborted") };
    },
  });
  tasks.noteShell("local", shell(8001, "running"), "TESTPC");
  tasks.noteShell("local", shell(8002, "running"), "TESTPC");
  const started = await CLOUD_TOOLS.run_shell.run({ command: "npm run watch", background: true }, { agentId: "a1", cloud, signal: new AbortController().signal, progress: () => undefined, shells: tasks });
  const cloudId = `cloud:${/background command (\d+)/.exec(started.output)?.[1]}`;
  assert.equal(store.getAgent("a1")!.asyncTaskCount, 3);

  const result = await tasks.cancelAll("a1");
  assert.deepEqual([...result.stopped].sort(), [cloudId, "local:8001", "local:8002"].sort());
  assert.deepEqual(result.failed, []);
  assert.deepEqual(tasks.info("a1"), []);
  assert.equal(store.getAgent("a1")!.asyncTaskCount, 0);
  assert.deepEqual(controls.map((control) => [control.action, control.shellId]).sort(), [["stop", 8001], ["stop", 8002]]);
  assert.equal(quiet().length, 3);
  for (const message of quiet()) assert.match(message.content, /^\[Background command \d+ was stopped by the user after /);
  await sleep(300);
  assert.equal(store.getAgent("a1")!.isRunning, false, "a stop wakes no one");
  assert.equal(replies().length, 0);
  assert.deepEqual(
    tasks.ended("a1").map((task) => task.stoppedBy),
    ["user", "user", "user"],
  );

  // One the box can't reach is reported and goes on running, not taken for stopped.
  tasks.noteShell("local", shell(8003, "running"), "TESTPC");
  tasks.noteShell("local", shell(8004, "running"), "TESTPC");
  offline.add(8004);
  const partial = await tasks.cancelAll("a1");
  assert.deepEqual(partial.stopped, ["local:8003"]);
  assert.deepEqual(partial.failed.map((failure) => failure.id), ["local:8004"]);
  assert.match(partial.failed[0].error, /isn’t connected/);
  assert.deepEqual(tasks.info("a1").map((task) => task.id), ["local:8004"]);
  assert.equal(tasks.record("local:8004")?.stoppedBy ?? null, null);
  // When it ends on its own, the agent hears that it finished, and is woken.
  tasks.noteShell("local", shell(8004, "succeeded"), "TESTPC");
  assert.match(quiet().at(-1)!.content, /^\[Background command 8004 finished: exit code 0/);
  await until(() => !store.getAgent("a1")!.isRunning && replies().length === 1);
  assert.deepEqual(await tasks.cancelAll("a1"), { stopped: [], failed: [] });
});

/** A cloud computer whose background commands are files in memory. */
class FakeCloud {
  logs = new Map<string, string>();
  alive = new Set<number>();
  pid = 500;
  state: CloudComputerStatus["state"] = "running";
  /** How often the box read a log, and checked on the commands. */
  reads = 0;
  checks = 0;
  status(): CloudComputerStatus {
    return { configured: true, state: this.state, sandboxId: "sbx-1", kind: "headless", createdAt: 1, error: null };
  }
  /** As `dd conv=notrunc` does; the box must keep the header's length. */
  private overwriteHeader(path: string, header: string) {
    const bytes = Buffer.from(this.logs.get(path)!);
    if (Buffer.byteLength(header) !== headerLength(bytes)) throw new Error(`the header changed length: ${Buffer.byteLength(header)} for ${headerLength(bytes)}`);
    this.logs.set(path, Buffer.concat([Buffer.from(header), bytes.subarray(headerLength(bytes))]).toString());
  }
  async rewriteLogHeader(path: string, header: string) {
    this.overwriteHeader(path, header);
  }
  async ensureDir() {}
  async startBackground(options: { logPath: string; header: string }) {
    const pid = this.pid++;
    this.logs.set(options.logPath, options.header.replace(CLOUD_PID_PLACEHOLDER, String(pid).padEnd(10)));
    this.alive.add(pid);
    return { pid };
  }
  write(path: string, text: string) {
    this.logs.set(path, (this.logs.get(path) ?? "") + text);
  }
  exit(path: string, pid: number, code: number) {
    this.write(path, logFooter(code, 1234, Date.now()));
    this.alive.delete(pid);
  }
  async backgroundStates(commands: Array<{ id: number; pid: number; logPath: string; header?: string }>) {
    this.checks++;
    for (const command of commands) if (command.header != null && this.alive.has(command.pid)) this.overwriteHeader(command.logPath, command.header);
    return new Map(
      commands.map((command) => {
        const code = /\nexit_code: (-?\d+)\n/.exec(this.logs.get(command.logPath) ?? "")?.[1];
        return [command.id, { alive: this.alive.has(command.pid), exitCode: code != null ? Number(code) : null }];
      }),
    );
  }
  async readLog(path: string, tailBytes: number) {
    this.reads++;
    const text = this.logs.get(path);
    if (text == null) return null;
    const bytes = Buffer.from(text);
    const tailStart = Math.max(0, bytes.length - tailBytes);
    return { head: bytes.subarray(0, 8192), tail: bytes.subarray(tailStart), tailStart, size: bytes.length };
  }
  async stopBackground(pid: number) {
    const path = [...this.logs.keys()].find((key) => this.logs.get(key)!.includes(`pid: ${pid} `));
    if (path != null) this.exit(path, pid, 143);
  }
  async appendText(path: string, text: string) {
    this.write(path, text);
  }
}

test("async tasks on the cloud computer: started, awaited for a line, stopped, and their end noticed while the agent waits on nothing", async () => {
  const fake = new FakeCloud();
  const cloud = fake as unknown as CloudComputer;
  const { store, tasks, quiet } = setupBox(undefined, { cloud, cloudPollMs: 200 });
  const context = { agentId: "a1", cloud, signal: new AbortController().signal, progress: () => undefined, shells: tasks };

  const started = await CLOUD_TOOLS.run_shell.run({ command: "npm run dev", background: true }, context);
  const id = Number(/background command (\d+)/.exec(started.output)?.[1]);
  assert.match(started.output, /^Started background command \d+ \(pid 500\): npm run dev\nIts output goes to \/home\/user\/\.wisp\/terminals\/\d+\.txt\./);
  assert.deepEqual(tasks.info("a1").map((task) => [task.id, task.computer, task.computerLabel]), [[`cloud:${id}`, "cloud", "Cloud computer"]]);
  const log = `/home/user/.wisp/terminals/${id}.txt`;
  assert.match(fake.logs.get(log)!, /^---\npid: 500 /);

  setTimeout(() => fake.write(log, "compiling…\nlistening on 3000\n"), 300);
  const ready = await CLOUD_TOOLS.await_command.run({ id, regex: "listening on (\\d+)", block_until_ms: 10_000 }, context);
  assert.match(ready.output, /^Background command \d+ is still running[^\n]*\nIts output matches \/listening on \(\\d\+\)\/: "listening on 3000"\nOutput:\ncompiling…\nlistening on 3000\nFull output: /);
  assert.equal((await tasks.readOutput("a1", `cloud:${id}`, 1_000)).text, "compiling…\nlistening on 3000\n");

  const stopped = await CLOUD_TOOLS.stop_command.run({ id }, context);
  assert.match(stopped.output, /^Background command \d+ was stopped after/);
  assert.equal(tasks.record(`cloud:${id}`)?.status, "stopped");
  assert.equal(quiet().length, 0, "the agent stopped it itself");
  // Ended, it is listed; its log stays on the cloud computer, so there's none to open here.
  assert.deepEqual(
    tasks.ended("a1").map((task) => [task.id, task.computer, task.computerLabel, task.status, task.stoppedBy, task.logExists]),
    [[`cloud:${id}`, "cloud", "Cloud computer", "stopped", "agent", false]],
  );

  // One that ends on its own is noticed by the box's checks, and the agent is told.
  const next = await CLOUD_TOOLS.run_shell.run({ command: "pytest", background: true }, context);
  const nextId = Number(/background command (\d+)/.exec(next.output)?.[1]);
  fake.write(`/home/user/.wisp/terminals/${nextId}.txt`, "3 passed\n");
  fake.exit(`/home/user/.wisp/terminals/${nextId}.txt`, 501, 0);
  await until(() => quiet().length === 1, 15_000);
  assert.match(quiet()[0].content, new RegExp(`^\\[Background command ${nextId} finished: exit code 0 after [^\\]]+\\]\\nCommand: pytest\\nLast output:\\n3 passed\\nFull output: /home/user/\\.wisp/terminals/${nextId}\\.txt on the cloud computer\\.$`));
  assert.equal(store.getAgent("a1")!.asyncTaskCount, 0);

  // Deleting the cloud computer loses what ran on it.
  await CLOUD_TOOLS.run_shell.run({ command: "sleep infinity", background: true }, context);
  tasks.cloudChanged({ ...fake.status(), state: "none", sandboxId: null });
  assert.match(quiet().at(-1)!.content, /was lost: The cloud computer it ran on was deleted\./);
  await until(() => !store.getAgent("a1")!.isRunning);
});

test("async tasks on the cloud computer: the log's header is kept current in place, and a paused cloud computer isn't woken to read output", async () => {
  const fake = new FakeCloud();
  const cloud = fake as unknown as CloudComputer;
  const { store, tasks, quiet } = setupBox(undefined, { cloud, cloudPollMs: 100 });
  const context = { agentId: "a1", cloud, signal: new AbortController().signal, progress: () => undefined, shells: tasks };
  const started = await CLOUD_TOOLS.run_shell.run({ command: "npm run dev", background: true }, context);
  const id = Number(/background command (\d+)/.exec(started.output)?.[1]);
  const log = `/home/user/.wisp/terminals/${id}.txt`;
  const header = () => fake.logs.get(log)!.slice(0, headerLength(Buffer.from(fake.logs.get(log)!)));
  const length = header().length;
  // The wrapper's padded pid gives the header the length the box rewrites it at (the fake refuses any other).
  assert.match(header(), /\npid: 500 {7}\n/);
  fake.write(log, "listening on 3000\n");

  // Each check rewrites it, as the daemon does on the PC.
  await until(() => Number(/\nrunning_for_ms: (\d+)/.exec(header())?.[1]) > 0);
  assert.match(header(), /\nstatus: running {2}\n/);
  assert.equal(header().length, length);
  assert.equal((await tasks.readOutput("a1", `cloud:${id}`, 1_000)).text, "listening on 3000\n");

  // Paused, the panel's reads show the output read last and leave the sandbox alone, and so do the checks.
  fake.state = "paused";
  fake.write(log, "more output\n");
  const [reads, checks] = [fake.reads, fake.checks];
  const paused = await tasks.readOutput("a1", `cloud:${id}`, 1_000);
  assert.equal(paused.text, "listening on 3000\n");
  assert.match(paused.note ?? "", /cloud computer is paused/);
  await sleep(400);
  assert.deepEqual([fake.reads, fake.checks], [reads, checks]);

  // Running again, it ends: the header says how, and for how long it ran.
  fake.state = "running";
  fake.exit(log, 500, 0);
  await until(() => /\nstatus: succeeded\n/.test(header()));
  const record = tasks.record(`cloud:${id}`)!;
  assert.equal(Number(/\nrunning_for_ms: (\d+)/.exec(header())?.[1]), record.endedAtMs! - record.startedAtMs);
  assert.equal(header().length, length);
  const bytes = Buffer.from(fake.logs.get(log)!);
  const view = readLogView(bytes, bytes, 0, bytes.length);
  assert.deepEqual([view.output, view.footer?.exitCode], ["listening on 3000\nmore output\n", 0]);
  assert.match(quiet()[0].content, /finished: exit code 0/);
  await until(() => !store.getAgent("a1")!.isRunning);
});

// ---- the remote box: the PC's daemon dials in, drops and comes back ---------------------------------

const TOKEN = randomBytes(24).toString("hex");

test("box gateway: a PC's background commands survive its connection dropping, and come back with its registration", async () => {
  const dir = tempDir();
  mkdirSync(join(dir, "workspaces"), { recursive: true });
  const server: BoxServer = await startBoxServer({
    settings: { dataDir: dir, host: "127.0.0.1", port: 0, token: TOKEN, tls: null, behindTlsProxy: false, admin: true, configFile: join(dir, "box-config.json"), workspaceRoot: join(dir, "workspaces") },
    env: { WISP_BOX_DEFAULT_MODEL: "mock:mock-1" },
    version: "9.9.9-test",
    detectClaudeCode: async () => ({ executable: null, installed: false, version: null, signedIn: false, authMethod: null, checkedAt: 1 }),
    log: () => undefined,
  });
  cleanup.push(() => server.close());
  const call = (path: string, body: unknown) => fetch(`${server.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const api = async <T = any>(method: string, args: unknown): Promise<T> => {
    const response = await call(`/api/${method}`, args);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as T;
  };
  const events: Array<{ channel: string; payload: any }> = [];
  const abort = new AbortController();
  cleanup.push(() => abort.abort());
  const stream = await fetch(`${server.url}/events`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: abort.signal });
  void (async () => {
    for await (const block of readSse(stream.body!, abort.signal)) if (block.data != null) events.push(JSON.parse(block.data));
  })().catch(() => undefined);

  const descriptor = (name: string) => ({ name, description: name, parameters: { type: "object", properties: {} }, permissionId: "shell", readOnly: false });
  const machine = { hostname: "TESTPC", platform: "win32", osType: "Windows_NT", osRelease: "10.0.26200", workspaceRoot: "C:\\pc\\workspaces" };
  const { agent: created } = await api<{ agent: AgentSummary }>("addAgent", { name: "Remote", description: "" });
  const id = created.id;
  const running = { ...shell(5150, "running"), agentId: id, command: "npm run dev" };

  /** A daemon connection: registers with its list, then answers requests until dropped. */
  const connect = async (tasks: BackgroundShellStatus[], answer: (request: any) => ToolResult) => {
    const register = await call("/pc/register", { tools: ["run_shell", "await_command", "stop_command"].map(descriptor), label: "TESTPC", machine, tasks });
    assert.equal(register.status, 200);
    const drop = new AbortController();
    const requests: any[] = [];
    const daemon = await fetch(`${server.url}/pc/requests`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: drop.signal });
    void (async () => {
      for await (const block of readSse(daemon.body!, drop.signal)) {
        if (block.data == null) continue;
        const request = JSON.parse(block.data);
        requests.push(request);
        await call("/pc/responses", { requestId: request.requestId, result: answer(request) });
      }
    })().catch(() => undefined);
    await until(() => server.status().localExec === "ready");
    return { requests, drop: () => drop.abort() };
  };

  const first = await connect([], (request) =>
    request.type === "tool"
      ? { kind: "ok", output: "Started background command 5150 (pid 7150): npm run dev", task: running }
      : { kind: "ok", output: "line 1\nline 2\n", task: running, log: { truncated: false, outputBytes: 14 } },
  );
  await api("deliverMessage", { agentId: id, prompt: '/tool run_shell {"command":"npm run dev","background":true}', clientNonce: "n1" });
  await until(async () => (await api<AsyncTaskInfo[]>("readAsyncTasks", { id })).length === 1);
  const [task] = await api<AsyncTaskInfo[]>("readAsyncTasks", { id });
  assert.equal(task.id, "local:5150");
  assert.equal(task.label, "npm run dev");
  assert.equal(task.computerLabel, "TESTPC");
  assert.ok(events.some((event) => event.channel === "background-work" && event.payload.parentAgentId === id && event.payload.tasks.length === 1));
  await until(async () => (await api<AgentSummary[]>("rosterAgents", {})).find((row) => row.id === id)?.asyncTaskCount === 1);
  assert.deepEqual(await api("readAsyncTaskOutput", { id, taskId: "local:5150" }), { text: "line 1\nline 2\n", truncated: false, outputBytes: 14, status: "running", exitCode: null });
  assert.equal(first.requests.at(-1).type, "shell-control");

  // The PC goes offline: the task is still listed, and its output can't be read meanwhile.
  first.drop();
  await until(() => server.status().localExec === "down");
  const [offline] = await api<AsyncTaskInfo[]>("readAsyncTasks", { id });
  assert.match(offline.detail ?? "", /TESTPC is offline/);
  const unreachable = await call("/api/readAsyncTaskOutput", { id, taskId: "local:5150" });
  assert.equal(unreachable.status, 503);
  assert.equal((await unreachable.json()).failureCode, "async-task/offline");

  // It comes back with the command ended meanwhile: the agent hears of it and is woken.
  const entries = async () => (await api<{ entries: TranscriptEntry[] }>("readTranscriptEnd", { id, limit: 100 })).entries;
  const second = await connect([{ ...running, state: "succeeded", exitCode: 0, endedAt: Date.now(), tail: "Compiled successfully" }], (request) => ({ kind: "ok", output: "", task: { ...shell(request.shellId, "aborted"), agentId: id } }));
  assert.deepEqual(await api("readAsyncTasks", { id }), []);
  await until(async () => (await entries()).some((entry) => entry.kind === "message" && entry.role === "assistant" && /You said: "\[Background command 5150 finished: exit code 0/.test(entry.content)));
  const hidden = (await entries()).find((entry): entry is MessageEntry => entry.kind === "message" && entry.suppressed === "quiet-wake")!;
  assert.match(hidden.content, /Last output:\nCompiled successfully/);

  // A report of a start (POST /pc/tasks), then the user's Stop through the daemon.
  const report = await call("/pc/tasks", { tasks: [{ ...shell(6000, "running"), agentId: id, command: "npm test -- --watch" }, { bogus: true }] });
  assert.equal(report.status, 204);
  assert.deepEqual((await api<AsyncTaskInfo[]>("readAsyncTasks", { id })).map((info) => info.id), ["local:6000"]);
  assert.equal(await api("cancelAsyncTask", { id, taskId: "local:6000" }), null);
  assert.deepEqual(second.requests.map((request) => [request.type, request.action, request.shellId]), [["shell-control", "stop", 6000]]);
  assert.deepEqual(await api("readAsyncTasks", { id }), []);
  await until(async () => (await entries()).some((entry) => entry.kind === "message" && entry.suppressed != null && /^\[Background command 6000 was stopped by the user/.test(entry.content)));
  assert.equal((await call("/api/cancelAsyncTask", { id, taskId: "local:1" })).status, 404);
  // Both are listed as ended, newest first; Stop all has nothing left to stop.
  assert.deepEqual(
    (await api<EndedAsyncTask[]>("getEndedAsyncTasks", { id })).map((ended) => [ended.id, ended.status, ended.stoppedBy ?? null]),
    [
      ["local:6000", "stopped", "user"],
      ["local:5150", "succeeded", null],
    ],
  );
  assert.deepEqual(await api("cancelAllAsyncTasks", { id }), { stopped: [], failed: [] });
  await until(async () => (await api<AgentSummary[]>("rosterAgents", {})).find((row) => row.id === id)?.isRunning === false);
  second.drop();
});
