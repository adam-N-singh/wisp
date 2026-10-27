// HTTP plumbing shared by the box host's gateway and the standalone box
// server's admin routes.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export { isInside } from "../shared/paths";

export const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** A request the box refuses, with the HTTP status and gateway failure code to answer with. */
export class CommandError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly failureCode?: string,
  ) {
    super(message);
  }
}

/** `authorization: Bearer <token>`, compared in constant time. */
export function bearerMatches(request: IncomingMessage, token: Buffer): boolean {
  const header = request.headers.authorization ?? "";
  const presented = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  return presented.length === token.length && timingSafeEqual(presented, token);
}

export function readBody(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new CommandError(413, "Request body too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/** The JSON body, or `{}` when there is none. */
export async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new CommandError(400, "Body is not JSON.");
  }
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export function openSse(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  response.write(": open\n\n");
}
