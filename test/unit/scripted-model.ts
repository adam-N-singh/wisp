// A local OpenAI-compatible `/chat/completions` server for tests: each request is recorded as sent,
// and a script decides the reply (text, tool calls, a wait, or a failure). Agents reach it as the
// "custom" provider, so tests see the exact model requests the harness builds.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { BoxModelConfig } from "../../src/shared/edges";

export interface ScriptedRequest {
  /** The request body as sent. */
  body: any;
  system: string;
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }>;
  /** The newest user message's text, or "" when the request ends with tool results. */
  lastUser: string;
  /** True when the request ends with tool results. */
  afterTools: boolean;
}

export interface ScriptedReply {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  /** Waits this long before answering; the request's abort ends the wait. */
  delayMs?: number;
  /** Never answers (until the request is aborted). */
  hang?: boolean;
  /** Answers with this HTTP status and message instead. */
  error?: { status: number; message: string };
}

export interface ScriptedModel {
  baseUrl: string;
  requests: ScriptedRequest[];
  models: BoxModelConfig;
  close(): Promise<void>;
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n") : "";

export async function startScriptedModel(script: (request: ScriptedRequest) => ScriptedReply | Promise<ScriptedReply>): Promise<ScriptedModel> {
  const requests: ScriptedRequest[] = [];
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = JSON.parse(raw);
      const messages = body.messages as ScriptedRequest["messages"];
      const last = messages[messages.length - 1];
      const recorded: ScriptedRequest = {
        body,
        system: textOf(messages[0]?.content),
        messages,
        lastUser: last?.role === "user" ? textOf(last.content) : "",
        afterTools: last?.role === "tool",
      };
      requests.push(recorded);
      void (async () => {
        const reply = await script(recorded);
        let closed = false;
        response.on("close", () => (closed = true));
        if (reply.hang === true) return;
        if (reply.delayMs != null) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
        if (closed) return;
        if (reply.error != null) {
          response.writeHead(reply.error.status, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: reply.error.message } }));
          return;
        }
        const chunks: unknown[] = [];
        if (reply.text != null && reply.text.length > 0) chunks.push({ choices: [{ delta: { content: reply.text } }] });
        (reply.toolCalls ?? []).forEach((call, index) => chunks.push({ choices: [{ delta: { tool_calls: [{ index, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }));
        chunks.push({ choices: [{ delta: {}, finish_reason: (reply.toolCalls ?? []).length > 0 ? "tool_calls" : "stop" }] });
        // All at once, so the harness's streaming throttle never splits a reply differently between runs.
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    requests,
    models: {
      defaultModel: { provider: "custom", model: "scripted-1" },
      reasoningEffort: "default",
      temperature: null,
      xai: null,
      openai: null,
      anthropic: null,
      custom: { baseUrl, apiKey: "" },
      claudeCode: null,
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Polls until the condition holds (wall-clock time, so a test may pin Date.now). */
export async function until(predicate: () => boolean, timeoutMs = 5_000, what = "the condition"): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
