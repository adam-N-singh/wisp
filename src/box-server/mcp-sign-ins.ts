// MCP server sign-ins on the box server. Their OAuth redirect goes to a 127.0.0.1 loopback, which
// can't reach a browser on a server, so (as with Sign in with ChatGPT) the user signs in on their
// PC and the app hands the finished sign-in here (/admin/importMcpSignIn). This server keeps it in
// <data>/mcp-auth.json (mode 0600) and owns every refresh from then on; the PC keeps no copy.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type McpCredentials, McpSignIns } from "../shared/mcp-oauth";
import { writePrivateFile } from "./chatgpt-sign-in";

export function serverMcpSignIns(dataDir: string, log: (line: string) => void): McpSignIns {
  const file = join(dataDir, "mcp-auth.json");
  return new McpSignIns(
    {
      read: () => {
        try {
          const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: number; servers?: Record<string, McpCredentials> };
          return parsed.version === 1 && parsed.servers != null ? parsed.servers : {};
        } catch {
          return {};
        }
      },
      write: (servers) => writePrivateFile(file, JSON.stringify({ version: 1, servers }, null, 1)),
    },
    log,
  );
}
