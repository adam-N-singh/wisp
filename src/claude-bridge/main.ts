// Stdio MCP server that Claude Code starts for agents run by the Claude Code
// engine (see src/box/claude-code.ts). It exposes the app's own tools and the
// permission-prompt tool, and forwards every call to the box host over HTTP:
//   POST {WISP_BRIDGE_URL}/bridge/tools   -> {tools: [{name, description, inputSchema}]}
//   POST {WISP_BRIDGE_URL}/bridge/call    {name, arguments} -> MCP CallToolResult
// Calls can wait on the user (approvals, questions), so requests have no timeout.
import { request } from "node:http";

const baseUrl = process.env.WISP_BRIDGE_URL ?? "";
const token = process.env.WISP_BRIDGE_TOKEN ?? "";

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function post(path: string, body: unknown): Promise<unknown> {
  const url = new URL(path, baseUrl);
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json", "content-length": payload.length, authorization: `Bearer ${token}` } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode ?? 500) >= 400) return reject(new Error(`box answered ${response.statusCode}: ${text.slice(0, 300)}`));
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error("box answered with invalid JSON"));
          }
        });
        response.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function handle(message: RpcMessage): Promise<void> {
  if (message.method == null || message.id == null) return; // responses and notifications need no answer
  try {
    switch (message.method) {
      case "initialize":
        return send({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "wisp", version: "1.0.0" } },
        });
      case "ping":
        return send({ jsonrpc: "2.0", id: message.id, result: {} });
      case "tools/list":
        return send({ jsonrpc: "2.0", id: message.id, result: await post("/bridge/tools", {}) });
      case "tools/call":
        return send({ jsonrpc: "2.0", id: message.id, result: await post("/bridge/call", { name: message.params?.name, arguments: message.params?.arguments ?? {} }) });
      default:
        return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (message.method === "tools/call") return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `The app couldn't run this tool: ${text}` }], isError: true } });
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: text } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length === 0) continue;
    try {
      void handle(JSON.parse(line) as RpcMessage);
    } catch {
      // not JSON-RPC; ignore
    }
  }
});
process.stdin.on("end", () => process.exit(0));
