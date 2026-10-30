// Local-exec daemon utility process: gives agents tools on the user's
// computer. It never listens on a port; it dials out to
// the box host (register, then hold an SSE stream of requests, answering each
// with POSTs), and runs every request through plan -> policy -> execute.
// Requests needing consent are answered "needs-approval"; the box host shows a
// `local-tool-permission` card and resends with the user's resolution, which
// counts only if the user gave it in the app on this PC (approvals.ts). A tool
// that needs the user to do something first (browser_wait_for_user) is answered
// "ask-user"; the box asks in the chat and resends the call with the answer.
//
// The agent browser's tools (browser-tools.ts) are planned and checked here like
// the rest, and run by main, which drives the browser (src/main/agent-browser.ts).
// So are the vault's (vault-tools.ts): main keeps the vault and fills from it, and
// checks a fill's approval again itself, so no value ever passes through here.
//
// The box may be the user's own server rather than a process on this PC, so
// the daemon tells it which computer it is (OS, folder of the agents'
// workspaces), and decides each agent's working folder itself (workspace.ts).
//
// Background commands (background.ts) outlive the request that started them,
// and the connection too: their starts and ends go to the box as they happen,
// and the whole list goes with every registration, so a box that missed some
// while this PC was offline (or while it was down itself) catches up.
import { randomUUID } from "node:crypto";
import os from "node:os";
import { dirname, join } from "node:path";
import type { BackgroundShellStatus } from "../shared/background-shell";
import { createPortPeer, mainPort, type MessagePortMainLike } from "../shared/rpc/transports";
import { createEdgeClient } from "../shared/rpc/runtime";
import { localHostEdge } from "../shared/edges";
import { type LocalExecRequest, type LocalMachine, readSse, type ToolResult } from "../shared/gateway-protocol";
import type { ToolPermission } from "../shared/model";
import { IssuedApprovals } from "./approvals";
import { BackgroundShells } from "./background";
import { evaluate, type Grant, grantRecipient } from "./policy";
import { LOCAL_TOOLS, type ToolContext } from "./tools";
import { agentWorkspace } from "./workspace";

interface Bootstrap {
  type: "bootstrap";
  wasmDir: string;
  /** Parent of the agents' folders on this PC. */
  workspaceRoot: string;
  /** The daemon's own folder: background commands' logs and list. */
  dataDir?: string;
}

interface ParentPort {
  on(event: "message", listener: (event: { data: unknown; ports: MessagePortMainLike[] }) => void): void;
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort;
const log = (line: string) => process.stderr.write(`local-exec: ${line}\n`);
const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];

parentPort.on("message", ({ data, ports }) => {
  if ((data as Bootstrap)?.type === "bootstrap" && ports[0] != null) start(data as Bootstrap, ports[0]);
});

function start(boot: Bootstrap, hostPort: MessagePortMainLike): void {
  const peer = createPortPeer(mainPort(hostPort), "local-host");
  const host = createEdgeClient(localHostEdge, peer.client);
  const machine: LocalMachine = { hostname: os.hostname(), platform: process.platform, osType: os.type(), osRelease: os.release(), workspaceRoot: boot.workspaceRoot };
  let permissions: Record<string, ToolPermission> = {};
  let grants: Grant[] = [];
  const refreshPolicy = async () => {
    [permissions, grants] = await Promise.all([host.toolPermissionModes(), host.listStandingGrants()]);
  };
  host.subscribe({ "permissions-changed": () => void refreshPolicy().catch((error) => log(`policy refresh failed: ${String(error)}`)) });

  const running = new Map<string, AbortController>();
  let stopped = false;
  let streamAbort: AbortController | null = null;

  const approvals = new IssuedApprovals((requestId) => host.takeToolApproval({ requestId }));

  const post = async (connection: { baseUrl: string; token: string }, path: string, body: unknown) => {
    const response = await fetch(`${connection.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
  };

  /** The box this daemon is registered with, while it is. */
  let registered: { baseUrl: string; token: string } | null = null;
  /** A report didn't arrive: the whole list goes again. */
  let resync = false;
  let reports = Promise.resolve();
  const report = (tasks: BackgroundShellStatus[]) => {
    reports = reports.then(async () => {
      const connection = registered;
      if (connection == null) {
        resync = true;
        return;
      }
      try {
        await post(connection, "/pc/tasks", { tasks });
      } catch (error) {
        resync = true;
        log(`background command report failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  };
  const shells = new BackgroundShells({ dir: join(boot.dataDir ?? join(dirname(boot.workspaceRoot), "local-exec"), "terminals"), onChange: (status) => report([status]), log });
  setInterval(() => {
    if (!resync || registered == null) return;
    resync = false;
    report(shells.snapshot());
  }, 10_000).unref();

  const handleTool = async (connection: { baseUrl: string; token: string }, request: Extract<LocalExecRequest, { type: "tool" }>) => {
    const tool = LOCAL_TOOLS[request.tool];
    const controller = new AbortController();
    running.set(request.requestId, controller);
    let progressChain = Promise.resolve();
    let result: ToolResult;
    try {
      if (tool == null) throw new Error(`Unknown tool ${request.tool}`);
      const cwd = agentWorkspace(boot.workspaceRoot, request.agentId);
      const context: ToolContext = {
        agentId: request.agentId,
        cwd,
        wasmDir: boot.wasmDir,
        signal: controller.signal,
        answer: request.answer ?? null,
        progress: (chunk) => {
          progressChain = progressChain.then(() => post(connection, "/pc/progress", { requestId: request.requestId, chunk })).catch(() => undefined);
        },
        shells,
        host: {
          grabScreen: () => host.grabScreen(),
          getClipboardText: () => host.getClipboardText(),
          putClipboardText: (text) => host.putClipboardText({ text }),
          openInBrowser: (url) => host.openInBrowser({ url }),
          browser: {
            plan: (call) => host.browserPlan(call),
            run: (call) => host.browserRun(call),
            cancel: (call) => host.browserCancel(call),
          },
          vault: {
            list: (call) => host.vaultList(call),
            plan: (call) => host.vaultPlan(call),
            fill: (call) => host.vaultFill(call),
          },
        },
      };
      const run = async (): Promise<ToolResult> => {
        const output = await tool.execute(request.args, context);
        return output.askUser != null && request.answer == null
          ? { kind: "ask-user", question: output.askUser.question, options: output.askUser.options }
          : { kind: "ok", output: output.output, image: output.image ?? null, ...(output.task != null ? { task: output.task } : {}) };
      };
      const plan = tool.skipsPolicy === true ? null : await tool.plan(request.args, context);
      if (plan != null) context.plan = plan;
      const permissionId = tool.descriptor.permissionId;
      const verdict = plan != null ? evaluate({ permissionId, ...plan, workspace: cwd }, permissions, grants) : null;
      const recipient = plan != null ? grantRecipient(permissionId, plan.scope, plan.risk) : null;
      // What the call would act on now; an approval for something else doesn't carry over (a page that changed).
      const subject = plan != null ? `${plan.risk}\n${plan.scope}\n${plan.target}` : "";
      // A resend with the user's answer to the call's question carries the approval it ran on: once, for
      // the same call on the same subject (approvals.ts). Otherwise it has none, and the policy decides again.
      const resumed = request.answer != null && approvals.resume(request, subject);
      const approval = request.answer == null || resumed ? request.approval : null;
      const changed = !resumed && approval?.requestId != null && approvals.changed(approval.requestId, subject);
      const approved = resumed || (approval != null && (await approvals.confirm({ ...request, approval }, subject)));
      if (approved && approval?.requestId != null) context.approvalId = approval.requestId;

      if (plan == null || verdict == null) {
        result = await run();
      } else if (approval != null && !approved) {
        result = { kind: "error", message: changed ? "What this would act on changed after you were asked (the page moved on), so nothing was done." : "That approval wasn't given in the app on this computer." };
      } else if (approval?.resolution === "never") {
        if (recipient != null) {
          await host.rememberGrant({ toolId: permissionId, scope: `deny:${plan.scope}` });
          grants = [...grants, { toolId: permissionId, scope: `deny:${plan.scope}` }];
        }
        result = { kind: "blocked", message: "Denied; you won't be asked again for this." };
      } else if (verdict.decision === "block") {
        result = { kind: "blocked", message: `This action is blocked by your settings for “${permissionId}”.` };
      } else if (verdict.decision === "ask" && approval == null) {
        const ask = {
          action: plan.action,
          target: plan.target,
          title: plan.title,
          ...(plan.description != null ? { description: plan.description } : {}),
          machineLabel: machine.hostname,
          toolId: permissionId,
          risk: plan.risk,
          reasons: plan.reasons.length > 0 ? plan.reasons : ["changes something on this computer"],
          standingGrant: recipient != null ? { kind: "offered" as const, recipient } : { kind: "unavailable" as const, reason: plan.risk === "dangerous" ? "dangerous_command" : "compound_command" },
        };
        // The card is registered on this PC first, so its text and the user's answer don't depend on the box.
        const approvalId = randomUUID();
        await host.offerToolApproval({ requestId: approvalId, ask });
        approvals.issue(approvalId, request, subject);
        result = { kind: "needs-approval", ask, approvalId };
      } else {
        if (approval?.resolution === "always" && recipient != null && !resumed) {
          await host.rememberGrant({ toolId: permissionId, scope: plan.scope });
          grants = [...grants, { toolId: permissionId, scope: plan.scope }];
        }
        result = await run();
        if (result.kind === "ask-user" && approved && approval?.requestId != null) approvals.carryOver(approval.requestId, request, subject);
      }
    } catch (error) {
      result = { kind: "error", message: controller.signal.aborted ? "interrupted" : error instanceof Error ? error.message : String(error) };
    } finally {
      running.delete(request.requestId);
    }
    await progressChain;
    await post(connection, "/pc/responses", { requestId: request.requestId, result }).catch((error) => log(`response post failed: ${String(error)}`));
  };

  /** The app stops a background command or reads its output: no approval, as it only touches what an agent ran. */
  const handleShellControl = async (connection: { baseUrl: string; token: string }, request: Extract<LocalExecRequest, { type: "shell-control" }>) => {
    let result: ToolResult;
    try {
      if (request.action === "stop") {
        const task = await shells.stop(request.agentId, request.shellId, "Stopped by the user.");
        result = { kind: "ok", output: "", task };
      } else {
        const { task, view } = shells.read(request.agentId, request.shellId, Math.min(Math.max(Number(request.tailChars) || 4_000, 100), 200_000));
        result = { kind: "ok", output: view.output, task, log: { truncated: view.truncated, outputBytes: view.outputBytes } };
      }
    } catch (error) {
      result = { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
    await post(connection, "/pc/responses", { requestId: request.requestId, result }).catch((error) => log(`response post failed: ${String(error)}`));
  };

  const session = async (): Promise<boolean> => {
    await refreshPolicy();
    const connection = await host.gatewayAddress();
    // The list goes with the registration: whatever the box missed while this PC was away.
    // (Changes while it's on its way are sent again.)
    resync = false;
    await post(connection, "/pc/register", { tools: Object.values(LOCAL_TOOLS).map((tool) => tool.descriptor), label: machine.hostname, machine, tasks: shells.snapshot() });
    registered = connection;
    const abort = new AbortController();
    streamAbort = abort;
    const response = await fetch(`${connection.baseUrl}/pc/requests`, { headers: { authorization: `Bearer ${connection.token}`, accept: "text/event-stream" }, signal: abort.signal });
    if (!response.ok || response.body == null) throw new Error(`requests HTTP ${response.status}`);
    log("connected to box gateway");
    let delivered = false;
    for await (const block of readSse(response.body, abort.signal)) {
      delivered = true;
      if (block.data == null) continue;
      let request: LocalExecRequest;
      try {
        request = JSON.parse(block.data);
      } catch {
        continue;
      }
      if (request.type === "tool") void handleTool(connection, request);
      else if (request.type === "tool-cancel") running.get(request.requestId)?.abort();
      else if (request.type === "shell-control") void handleShellControl(connection, request);
    }
    return delivered;
  };

  void (async () => {
    let failures = 0;
    while (!stopped) {
      try {
        if (await session()) failures = 0;
      } catch (error) {
        if (!stopped) log(`gateway session ended: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Background commands go on; what they do meanwhile goes with the next registration.
      registered = null;
      for (const controller of running.values()) controller.abort();
      running.clear();
      if (stopped) return;
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)]));
    }
  })();

  peer.closed.then(() => {
    stopped = true;
    streamAbort?.abort();
    shells.shutdown();
    process.exit(0);
  });
}
