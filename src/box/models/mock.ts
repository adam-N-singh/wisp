// Deterministic "mock" model for tests and offline demos:
//   "/tool <name> <json args>"  -> calls that tool, then summarizes its result
//   "/system"                   -> replies with its system prompt (what the agent is told)
//   "/search <query>"           -> acts out a web search (with web search on): the
//                                  activity, a cited reply and its sources, no network
//   "/echo <text>"              -> streams the text back as its reply, word by word
//                                  (Markdown, math and diagrams to look at in the app)
//   anything else               -> streams an acknowledgement word by word
import type { ModelRequest, ResolvedModel, StreamEvent } from "./types";

export async function* streamMock(request: ModelRequest, model?: Extract<ResolvedModel, { kind: "mock" }>): AsyncGenerator<StreamEvent> {
  const last = request.items[request.items.length - 1];
  if (last?.kind === "tool-results") {
    const output = last.results.map((result) => result.output).join("\n\n");
    yield* streamWords(`Tool finished. Output:\n\n\`\`\`\n${output.slice(0, 1200)}\n\`\`\``, request.signal);
    yield { type: "done", finishReason: "stop" };
    return;
  }
  const lastUser = [...request.items].reverse().find((item) => item.kind === "user");
  const text = lastUser?.kind === "user" ? lastUser.parts.filter((part) => part.type === "text").map((part) => (part.type === "text" ? part.text : "")).join("\n") : "";
  // User messages start with a "[Sent …]" line, and a note on the pages the user changed after it; the command is what follows.
  const prompt = text
    .replace(/^\[Sent [^\]]*\]\n?/, "")
    .replace(/^\[I changed (this page|these pages) since my last message: [^\n]*\]\n?/, "")
    .trim();
  const toolMatch = /^\/tool\s+([a-z0-9_-]+)\s*(\{[\s\S]*\})?\s*$/i.exec(prompt);
  if (toolMatch != null && request.tools.some((tool) => tool.function.name === toolMatch[1])) {
    yield { type: "reasoning", delta: `The user asked me to run ${toolMatch[1]}.` };
    yield { type: "text", delta: `Running \`${toolMatch[1]}\`…` };
    yield { type: "tool-call", call: { id: `mock_${Date.now().toString(36)}`, type: "function", function: { name: toolMatch[1], arguments: toolMatch[2] ?? "{}" } } };
    yield { type: "done", finishReason: "tool_calls" };
    return;
  }
  if (prompt === "/system") {
    yield { type: "text", delta: `My system prompt:\n\n${request.system}` };
    yield { type: "done", finishReason: "stop" };
    return;
  }
  const searchMatch = /^\/search\s+(.+)$/is.exec(prompt);
  if (searchMatch != null && model?.webSearch === true) {
    yield* mockSearch(searchMatch[1].trim(), request.signal);
    return;
  }
  const echoMatch = /^\/echo\s+([\s\S]+)$/.exec(prompt);
  if (echoMatch != null) {
    yield* streamWords(echoMatch[1], request.signal);
    yield { type: "done", finishReason: "stop" };
    return;
  }
  yield* streamWords(`Mock model here. You said: "${prompt}". Configure a real model in Settings → Models to get real answers.`, request.signal);
  yield { type: "usage", inputTokens: 42, outputTokens: 24, cachedTokens: 0 };
  yield { type: "done", finishReason: "stop" };
}

async function* mockSearch(query: string, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  const slug = encodeURIComponent(query.toLowerCase().replace(/\s+/g, "-")).slice(0, 60);
  yield { type: "search", source: "web", query };
  await pause(600, signal);
  yield { type: "search", source: "x", query };
  await pause(400, signal);
  yield* streamWords(`Here's what turned up for “${query}” (a mock search: nothing went over the network). [[1]](https://example.com/${slug}) Posts on X were quieter. [[2]](https://x.com/example/status/1)`, signal);
  yield {
    type: "sources",
    sources: [
      { url: `https://example.com/${slug}`, title: `Example: ${query}`, cited: true },
      { url: "https://x.com/example/status/1", cited: true },
      { url: "https://example.org/background", title: "Example background reading", cited: false },
    ],
  };
  yield { type: "done", finishReason: "stop" };
}

const pause = (ms: number, signal: AbortSignal) => (signal.aborted ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms)));

async function* streamWords(text: string, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  for (const word of text.split(/(?<=\s)/)) {
    if (signal.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, 12));
    yield { type: "text", delta: word };
  }
}
