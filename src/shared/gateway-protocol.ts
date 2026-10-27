// HTTP surface of the box host: one POST per command plus a Server-Sent Events
// stream. baseUrl is http://127.0.0.1:<port> for the box on this PC, or the
// https:// address of a remote box server; every request except /livez carries
// `authorization: Bearer <token>`.
//
//   GET  /health                    {ok: true, version, protocol, localExec}
//   GET  /livez                     204, unauthenticated (container health checks)
//   POST /api/<method>              body = JSON args; 200 = JSON reply;
//                                   4xx/5xx = {error, failureCode?}
//   GET  /events                    SSE: `data: {"channel":…,"payload":…}` blocks;
//                                   `:echo <nonce>` blocks answer echo probes
//   POST /events/ping?nonce=<uuid>  204; writes `:echo <nonce>` on open streams
//   POST /attachments?name=<file>   body = the file's bytes (≤ 100 MB); 200 = {path, name, bytes}.
//                                   The coordinator uploads staged attachments here when the box is remote.
//   GET  /media?path=<abs path>     a file under the box's attachments folder (uploads, tool images)
//
// The local-exec daemon uses the same server:
//   POST /pc/register       {tools: LocalToolDescriptor[], label, machine?: LocalMachine,
//                                    tasks?: BackgroundShellStatus[]}: its background commands, so
//                                    what changed while it was offline reaches the box
//   GET  /pc/requests       SSE: `data: LocalExecRequest`
//   POST /pc/progress       {requestId, chunk}
//   POST /pc/responses      {requestId, result: ToolResult}
//   POST /pc/tasks          {tasks: BackgroundShellStatus[]}: background commands that
//                                   started or ended (src/shared/background-shell.ts)
//
// The standalone box server (src/box-server/) adds POST /admin/<method> for
// boxAdminEdge (src/shared/edges.ts), with the same bearer token.

import type { BackgroundShellStatus } from "./background-shell";
import type { LocalToolPermissionAsk } from "./model";

export const GATEWAY_PROTOCOL_VERSION = 1;
export const GATEWAY_CAPABILITIES = ["event-order/1", "send-receipts/1", "upload-sizes/1", "agent-voices/1", "mcp-stdio/1", "mcp-http/1", "cron-automations/1", "remote-box/1", "skills/1", "memory/1", "search/1", "mcp-catalog/1", "voice/1", "message-actions/1", "outline/1", "bot-templates/1", "async-tasks/1"];

/**
 * The computer the local-exec daemon runs on, as it describes itself when it registers. With a
 * remote box this is the only way the box learns the PC's OS and where the agents' folders are on it.
 */
export interface LocalMachine {
  hostname: string;
  platform: string;
  osType: string;
  osRelease: string;
  /** Parent folder of the agents' workspaces on that computer. */
  workspaceRoot: string;
}

export interface GatewayEventFrame {
  channel: string;
  payload: unknown;
}

export interface GatewayErrorBody {
  error: string;
  failureCode?: string;
}

/** Tool exposed by the local-exec daemon; `parameters` is JSON Schema for the model. */
export interface LocalToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Permission id these calls are governed by (several tools can share one). */
  permissionId: string;
  readOnly: boolean;
}

export interface ToolApproval {
  /** "never" asks the daemon to record a standing denial and refuse. */
  resolution: "allow-once" | "always" | "never";
  entryId: string;
  /**
   * The approval id the daemon issued with its needs-approval answer (the card's request id). The
   * daemon honors an approval only if the user gave this answer to that card on this PC, so a box,
   * possibly on another machine, can't approve on the user's behalf.
   */
  requestId?: string;
}

export type LocalExecRequest =
  | {
      type: "tool";
      requestId: string;
      agentId: string;
      tool: string;
      args: Record<string, unknown>;
      approval: ToolApproval | null;
      cwd: string;
      /** The user's answer to the question an "ask-user" result asked (browser_wait_for_user). */
      answer?: string | null;
    }
  | { type: "tool-cancel"; requestId: string }
  /** The user stops one of an agent's background commands, or the app reads the end of its output (answered like a tool). */
  | { type: "shell-control"; requestId: string; agentId: string; shellId: number; action: "stop" | "output"; tailChars?: number };

/** What the daemon needs the user to approve; becomes a `local-tool-permission` card. */
export type PermissionAsk = Omit<LocalToolPermissionAsk, "requestId" | "status">;

export type ToolResult =
  | {
      kind: "ok";
      output: string;
      image?: { mime: string; base64: string } | null;
      /** The background command the call started, waited for or stopped. */
      task?: BackgroundShellStatus;
      /** For a shell-control output read: whether `output` is only the end of it, and how long all of it is. */
      log?: { truncated: boolean; outputBytes: number };
    }
  | { kind: "error"; message: string }
  | { kind: "needs-approval"; ask: PermissionAsk; approvalId?: string }
  | { kind: "blocked"; message: string }
  /** Ask the user this in the chat (an ask_user card), then resend the call with their `answer`. */
  | { kind: "ask-user"; question: string; options: string[] };

export interface ToolPolicyVerdict {
  decision: "allow" | "ask" | "block";
  risk: LocalToolPermissionAsk["risk"];
  reasons: string[];
  scope: string;
}

/**
 * Splits an SSE byte stream into blocks; yields `{data}` or `{comment}` per block. Lines may end in
 * LF, CRLF or CR (MCP servers send all three).
 */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ data?: string; comment?: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let carriageReturn = false;
  try {
    while (signal == null || !signal.aborted) {
      const { value, done } = await reader.read();
      if (done) return;
      let text = decoder.decode(value, { stream: true });
      // A CR at the end of a chunk may be the first half of a CRLF.
      if (carriageReturn) text = `\r${text}`;
      carriageReturn = text.endsWith("\r");
      buffer += (carriageReturn ? text.slice(0, -1) : text).replace(/\r\n?/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block.startsWith(":")) {
          yield { comment: block.slice(1).trim() };
          continue;
        }
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (data.length > 0) yield { data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
