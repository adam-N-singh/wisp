// The 127.0.0.1 listener that catches an OAuth redirect in the system browser, for Sign in with
// ChatGPT and MCP server sign-ins (RFC 8252 loopback redirects).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Listens on 127.0.0.1:`port` (0 picks a free one). */
export function listenLoopback(port: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

/** The page the browser shows once the redirect arrives. */
export function callbackPage(ok: boolean): string {
  const message = ok ? "You're signed in. You can close this tab and return to Wisp." : "Sign-in didn't complete. Return to Wisp and try again.";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Wisp</title><style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f6f6f4;color:#1d1d1b}@media(prefers-color-scheme:dark){body{background:#1b1b1a;color:#ececea}}</style></head><body><p>${message}</p></body></html>`;
}
