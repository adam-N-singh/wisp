import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildSync } from "esbuild";

const cleanup: Array<() => void> = [];
after(() => cleanup.forEach((fn) => fn()));

test("claude bridge: speaks MCP over stdio and forwards tools/list and tools/call to the box", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wisp-bridge-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "bridge.cjs");
  buildSync({ entryPoints: [join(process.cwd(), "src/claude-bridge/main.ts")], outfile: script, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });

  const seen: Array<{ path: string; auth: string; body: any }> = [];
  const box = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      seen.push({ path: request.url ?? "", auth: String(request.headers.authorization), body: JSON.parse(raw) });
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url === "/bridge/tools") return response.end(JSON.stringify({ tools: [{ name: "ask_user", description: "Ask", inputSchema: { type: "object" } }] }));
      // Answer slowly, like an approval waiting on the user.
      setTimeout(() => response.end(JSON.stringify({ content: [{ type: "text", text: `ran ${JSON.parse(raw).name}` }] })), 50);
    });
  });
  await new Promise<void>((resolve) => box.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => box.close());

  const child = spawn(process.execPath, [script], { env: { ...process.env, WISP_BRIDGE_URL: `http://127.0.0.1:${(box.address() as AddressInfo).port}`, WISP_BRIDGE_TOKEN: "run-token" }, stdio: ["pipe", "pipe", "inherit"] });
  cleanup.push(() => child.kill());
  const replies = new Map<number, any>();
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      replies.set(message.id, message);
    }
  });
  const call = async (id: number, method: string, params: unknown = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    for (const deadline = Date.now() + 5_000; !replies.has(id); ) {
      if (Date.now() > deadline) throw new Error(`no reply to ${method}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return replies.get(id);
  };

  const init = await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } });
  assert.equal(init.result.serverInfo.name, "wisp");
  assert.equal(init.result.protocolVersion, "2025-06-18");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const list = await call(2, "tools/list");
  assert.deepEqual(list.result.tools.map((tool: { name: string }) => tool.name), ["ask_user"]);
  const result = await call(3, "tools/call", { name: "approve", arguments: { tool_name: "Bash", input: { command: "ls" } } });
  assert.equal(result.result.content[0].text, "ran approve");
  assert.deepEqual(seen.map((entry) => [entry.path, entry.auth]), [
    ["/bridge/tools", "Bearer run-token"],
    ["/bridge/call", "Bearer run-token"],
  ]);
  assert.deepEqual(seen[1].body, { name: "approve", arguments: { tool_name: "Bash", input: { command: "ls" } } });
  const unknown = await call(4, "resources/list");
  assert.equal(unknown.error.code, -32601);
});
