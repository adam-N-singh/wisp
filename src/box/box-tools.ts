// Tools that run inside the box host itself (no access to the user's
// computer): the agent's todo list, questions to the user, web fetches,
// automations, skills, memory, visualizations in the chat and the documents and canvases it writes. Tools that touch the user's machine live in the local-exec daemon.
import type { ToolSpec } from "./models";
import { canvasAddress, canvasIdFromAddress } from "../shared/canvas";
import { type AgentTodo, type Automation, type ChoiceOption, MAX_MEMORY_TEXT, type VisualizationMessage } from "../shared/model";
import { canvasTitle, cleanPageTitle, documentTitle, MAX_PAGE_SOURCE } from "../shared/pages";
import { clampVisualizationHeight, MAX_VISUALIZATION_HTML } from "../shared/visualization";
import type { BoxStore, PageRecord } from "./store";
import { describeCron, isValidCron } from "./cron";
import { addMemory, editMemory, findMemory, forgetMemory, MemoryError } from "./memory";
import { createDocument, editDocument, PageError, readCanvas, readDocument, writeCanvas } from "./pages";
import { buildAutomation } from "./scheduler";
import { findSkill } from "./skills";

export interface BoxToolContext {
  agentId: string;
  /** The session the call came from ("" is the agent's main one): its todos are its own. */
  sessionId: string;
  store: BoxStore;
  signal: AbortSignal;
  emitTodos(todos: AgentTodo[]): void;
  automationsChanged(automation: Automation, action: "created" | "deleted"): void;
  memoriesChanged(): void;
  askUser(prompt: string, options: ChoiceOption[], allowCustom: boolean): Promise<string>;
  /** Posts a visualization card in the conversation. */
  showVisualization(visual: VisualizationMessage): void;
  /** A document or canvas the agent wrote: its card is posted (or updated in place) and clients hear of the change. */
  pageChanged(record: PageRecord, source: string, change: "created" | "edited"): void;
}

export interface BoxToolResult {
  output: string;
  isError?: boolean;
}

interface BoxTool {
  spec: ToolSpec;
  /** The activity line for a call, written before it runs. */
  summary(args: Record<string, any>, context: { agentId: string; store: BoxStore }): string;
  run(args: Record<string, any>, context: BoxToolContext): Promise<BoxToolResult>;
}

const tool = (name: string, description: string, parameters: Record<string, unknown>): ToolSpec => ({
  type: "function",
  function: { name, description, parameters },
});

const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;

/** Whether what the agent saves to memory waits for the user's review. */
const reviewing = (context: { agentId: string; store: BoxStore }) => context.store.getAgent(context.agentId)?.memoryReview === true;

const quote = (value: unknown) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return `“${text.length > 80 ? `${text.slice(0, 79)}…` : text}”`;
};

/** What the agent can do about a refused memory change, after the reason. */
const MEMORY_HINTS: Record<MemoryError["code"], string> = {
  empty: "",
  "too-long": " Keep each memory to one short fact, and split longer notes into several memories.",
  full: " Make room first: merge related memories with update_memory or forget ones that no longer matter, then try again.",
  duplicate: "",
  missing: " Use an id from the memories listed in your instructions.",
  settled: "",
};

const memoryFailure = (error: unknown): BoxToolResult => {
  if (!(error instanceof MemoryError)) throw error;
  return { output: `${error.message}${MEMORY_HINTS[error.code]}`, isError: true };
};

const memoryId = { type: "string", description: "The memory's id, as listed in your instructions." };

const pageFailure = (error: unknown): BoxToolResult => {
  if (!(error instanceof PageError)) throw error;
  return { output: error.code === "missing" ? `${error.message} Use a document_id from a document you created in this conversation.` : error.message, isError: true };
};

/** The page a call names, for its activity line. */
const pageTitle = (args: Record<string, any>, context: { agentId: string; store: BoxStore }) => {
  const record = context.store.getPage(context.agentId, String(args.document_id ?? ""));
  return record != null ? quote(record.title) : "a document";
};

const documentId = { type: "string", description: "The document's id, as create_document returned it (doc-…)." };

const canvasFailure = (error: unknown): BoxToolResult => {
  if (!(error instanceof PageError)) throw error;
  return { output: error.code === "missing" ? `${error.message} Use a canvas_id that write_canvas returned in this conversation, or leave it out to write a new canvas.` : error.message, isError: true };
};

/** The canvas a read_canvas call names: by its id, or by the address write_canvas gave. */
const canvasArg = (args: Record<string, any>, agentId: string): string | null => {
  if (typeof args.canvas_id === "string" && args.canvas_id.length > 0) return args.canvas_id;
  const named = typeof args.url === "string" ? canvasIdFromAddress(args.url) : null;
  return named != null && named.storeId === agentId ? named.canvasId : null;
};

/** write_canvas's and read_canvas's result, with the canvas's revision. */
const canvasResult = (agentId: string, record: PageRecord) =>
  JSON.stringify({ canvas_id: record.id, title: record.title, url: canvasAddress(agentId, record.id), revision: record.revisions[record.revisions.length - 1].n });

export const BOX_TOOLS: Record<string, BoxTool> = {
  todo_write: {
    spec: tool(
      "todo_write",
      "Replace your todo list for this conversation. Use it for work with three or more steps: add every step up front, keep exactly one item in_progress, and mark items completed as soon as they are done.",
      {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Stable id; reuse it when updating an item." },
                content: { type: "string" },
                status: { type: "string", enum: [...TODO_STATUSES] },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    ),
    summary: (args) => `Updated the todo list (${Array.isArray(args.todos) ? args.todos.length : 0} items)`,
    async run(args, context) {
      const now = Date.now();
      const todos: AgentTodo[] = (Array.isArray(args.todos) ? args.todos : []).slice(0, 50).map((item: any, index: number) => ({
        id: typeof item.id === "string" && item.id.length > 0 ? item.id : `todo-${index + 1}`,
        content: String(item.content ?? item.text ?? "").slice(0, 500),
        status: TODO_STATUSES.includes(item.status) ? item.status : "pending",
        updatedAt: now,
      }));
      context.store.setTodos(context.agentId, todos, context.sessionId);
      context.emitTodos(todos);
      const done = todos.filter((todo) => todo.status === "completed").length;
      return { output: `Todo list saved: ${done}/${todos.length} completed.` };
    },
  },

  ask_user: {
    spec: tool(
      "ask_user",
      "Ask the user a question and wait for the answer. Use only when you cannot proceed without information or a decision only the user has. Offer up to four short options when the choices are clear; the user can also type their own answer.",
      {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" }, description: "Up to 4 suggested answers." },
        },
        required: ["question"],
      },
    ),
    summary: (args) => `Asked: ${String(args.question ?? "").slice(0, 100)}`,
    async run(args, context) {
      const options: ChoiceOption[] = (Array.isArray(args.options) ? args.options : []).slice(0, 4).map((label: unknown) => ({ label: String(label), value: String(label) }));
      const answer = await context.askUser(String(args.question ?? ""), options, true);
      return { output: `The user answered: ${answer}` };
    },
  },

  show_visualization: {
    spec: tool(
      "show_visualization",
      "Show the user an interactive visualization in the chat: a chart, a diagram or a small widget, written as an HTML fragment (what goes inside <body>) with inline <style> and <script>. It runs sandboxed: nothing loads from the network (no fetch, no external scripts, stylesheets, fonts or images; use inline SVG, canvas or data: URIs) and it can't reach the app. It gets the chat's width (up to 720 px) and grows to its content's height. Use the theme's colors so it reads in light and dark mode: CSS variables --viz-text, --viz-muted, --viz-border, --viz-surface, --viz-accent and --viz-series-1 to --viz-series-6, also in window.WispViz.tokens and window.WispViz.series. Prefer a Markdown table, a ```mermaid diagram or $$math$$ when one of those is enough.",
      {
        type: "object",
        properties: {
          title: { type: "string", description: "A short title shown above it." },
          html: { type: "string", description: `The HTML fragment, at most ${Math.round(MAX_VISUALIZATION_HTML / 1024)} KB.` },
          summary: { type: "string", description: "One sentence saying what it shows." },
          height: { type: "number", description: "Its height in pixels until it has rendered (default 360)." },
        },
        required: ["title", "html"],
      },
    ),
    summary: (args) => `Showed ${quote(args.title ?? "a visualization")}`,
    async run(args, context) {
      const html = typeof args.html === "string" ? args.html : "";
      const title = String(args.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (title.length === 0) return { output: "Give the visualization a title.", isError: true };
      if (html.trim().length === 0) return { output: "The visualization's html is empty.", isError: true };
      if (html.length > MAX_VISUALIZATION_HTML) return { output: `The html is ${html.length} characters; keep it under ${MAX_VISUALIZATION_HTML}. Draw less, or compute the data in the script instead of writing it out.`, isError: true };
      const { sha256, path } = context.store.saveVisualization(html);
      const summary = String(args.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 1_000);
      const height = Number(args.height);
      context.showVisualization({ type: "visualization", title, summary, documentSha256: sha256, path, ...(Number.isFinite(height) && height > 0 ? { heightPx: clampVisualizationHeight(height) } : {}) });
      return { output: `Shown in the chat as “${title}”. The user sees it below this step; don't repeat its contents in your reply.` };
    },
  },

  create_document: {
    spec: tool(
      "create_document",
      `Write a document for the user: Markdown they open beside the chat, read, edit and save as a file. Use it for something they'll keep, change or come back to (a plan, a report, notes, a draft, a checklist) rather than a long reply. The chat renders the same Markdown: GFM tables and task lists, math between $$ … $$ and \`\`\`mermaid diagrams. A card for it appears in the chat; change it later with edit_document. At most ${Math.round(MAX_PAGE_SOURCE / 1024)} KB.`,
      {
        type: "object",
        properties: {
          title: { type: "string", description: "Its title. A first-level # heading in the markdown is the title instead, and stays it as the heading changes." },
          markdown: { type: "string", description: "The document's Markdown." },
        },
        required: ["title", "markdown"],
      },
    ),
    summary: (args) => `Wrote ${quote((typeof args.markdown === "string" ? documentTitle(args.markdown) : null) ?? (args.title || "a document"))}`,
    async run(args, context) {
      try {
        const { record, source } = createDocument(context.store, context.agentId, String(args.title ?? ""), typeof args.markdown === "string" ? args.markdown : "");
        context.pageChanged(record, source, "created");
        return { output: `Created “${record.title}” as document ${record.id} (revision 1). The user sees its card below this step and can open it beside the chat; don't repeat its contents in your reply.` };
      } catch (error) {
        return pageFailure(error);
      }
    },
  },

  read_document: {
    spec: tool(
      "read_document",
      "Read one of your documents as it is now, with its revision number. The user can edit your documents: read one again before you change it if they may have (a message that starts with [I changed … since my last message] says which they changed).",
      { type: "object", properties: { document_id: documentId }, required: ["document_id"] },
    ),
    summary: (args, context) => `Read ${pageTitle(args, context)}`,
    async run(args, context) {
      try {
        const { record, source, revision } = readDocument(context.store, context.agentId, String(args.document_id ?? ""));
        const by = record.revisions[record.revisions.length - 1].by === "user" ? "the user" : "you";
        return { output: `“${record.title}” (${record.id}), revision ${revision}, last changed by ${by}:\n\n${source}` };
      } catch (error) {
        return pageFailure(error);
      }
    },
  },

  edit_document: {
    spec: tool(
      "edit_document",
      `Change one of your documents. Prefer edits: each quotes text that is in the document exactly once (find) and gives what replaces it, applied in order; or send markdown, the whole new text, which needs base_revision. Pass base_revision, the revision you last read or wrote, so a change the user made since isn't overwritten: the edit is refused if the document has moved on. At most ${Math.round(MAX_PAGE_SOURCE / 1024)} KB.`,
      {
        type: "object",
        properties: {
          document_id: documentId,
          edits: {
            type: "array",
            items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" } }, required: ["find", "replace"] },
            description: "Replacements, applied in order.",
          },
          markdown: { type: "string", description: "The whole new text, instead of edits; send base_revision with it." },
          base_revision: { type: "integer", description: "The revision your change is based on; required with markdown." },
        },
        required: ["document_id"],
      },
    ),
    summary: (args, context) => `Edited ${pageTitle(args, context)}`,
    async run(args, context) {
      const edits = Array.isArray(args.edits) ? args.edits.map((edit: any) => ({ find: String(edit?.find ?? ""), replace: String(edit?.replace ?? "") })) : undefined;
      const markdown = typeof args.markdown === "string" ? args.markdown : undefined;
      const baseRevision = Number.isInteger(args.base_revision) ? (args.base_revision as number) : undefined;
      try {
        const { record, source, changed } = editDocument(context.store, context.agentId, String(args.document_id ?? ""), { edits, markdown, baseRevision });
        const revision = record.revisions[record.revisions.length - 1].n;
        if (!changed) return { output: `“${record.title}” already says that (revision ${revision}).` };
        context.pageChanged(record, source, "edited");
        return { output: `Saved “${record.title}” as revision ${revision}. Its card in the chat shows the change.` };
      } catch (error) {
        return pageFailure(error);
      }
    },
  },

  write_canvas: {
    spec: tool(
      "write_canvas",
      `Write a canvas for the user: an interactive page they open beside the chat and use there, such as a tool, a calculator, a game, a dashboard or a form that works something out. contents is one self-contained HTML document (or just what goes in <body>) with inline <style> and <script>; nothing compiles or bundles it. It runs sandboxed: nothing loads from the network (no fetch, no external scripts, stylesheets, fonts or images; use inline SVG, <canvas> or data: URIs), it can't reach the app or keep anything between openings (no storage or cookies), and a link opens in the browser only when the user clicks it. It fills the page stage beside the chat: lay it out to the frame's width and height. Use the theme's colors so it reads in light and dark mode: CSS variables --viz-text, --viz-muted, --viz-border, --viz-surface, --viz-accent and --viz-series-1 to --viz-series-6, also in window.WispViz.tokens and window.WispViz.series. A card for it appears in the chat. To change it, call write_canvas again with its canvas_id and the whole new contents: each write is a revision the user can look back at and restore. Once the user has restored one, read the canvas with read_canvas and send base_revision with your next write. At most ${Math.round(MAX_PAGE_SOURCE / 1024)} KB. For a chart that belongs in the conversation use show_visualization, and for text the user will edit create_document.`,
      {
        type: "object",
        properties: {
          contents: { type: "string", description: "The canvas's HTML, whole: a write replaces what it showed." },
          canvas_id: { type: "string", description: "The canvas to replace, as write_canvas returned it (canvas-…); leave it out for a new canvas." },
          title: { type: "string", description: "Its title. A new canvas without one takes its <title> (or first <h1>); an existing one keeps its own unless you give another." },
          base_revision: { type: "integer", description: "The revision your HTML replaces, as read_canvas or your last write gave it. Needed once the user has restored an older revision (the write is refused otherwise, so their restore isn't undone); a stale one is refused." },
        },
        required: ["contents"],
      },
    ),
    summary: (args, context) => {
      const existing = typeof args.canvas_id === "string" ? context.store.getPage(context.agentId, args.canvas_id) : undefined;
      const given = cleanPageTitle(String(args.title ?? ""));
      const title = given.length > 0 ? given : (existing?.title ?? (typeof args.contents === "string" ? canvasTitle(args.contents) : null) ?? "a canvas");
      return `${existing != null ? "Updated" : "Made"} ${quote(title)}`;
    },
    async run(args, context) {
      const contents = typeof args.contents === "string" ? args.contents : "";
      const canvasId = typeof args.canvas_id === "string" && args.canvas_id.length > 0 ? args.canvas_id : undefined;
      try {
        const baseRevision = Number.isInteger(args.base_revision) ? (args.base_revision as number) : undefined;
        const { record, source, created, changed } = writeCanvas(context.store, context.agentId, { contents, canvasId, title: typeof args.title === "string" ? args.title : undefined, baseRevision });
        const revision = record.revisions[record.revisions.length - 1].n;
        if (!changed) return { output: `${canvasResult(context.agentId, record)}\n“${record.title}” already shows that (revision ${revision}).` };
        context.pageChanged(record, source, created ? "created" : "edited");
        return {
          output: created
            ? `${canvasResult(context.agentId, record)}\nMade “${record.title}” as canvas ${record.id} (revision 1). The user sees its card below this step and opens it beside the chat; don't repeat its contents in your reply. To change it, call write_canvas with this canvas_id and the whole new contents.`
            : `${canvasResult(context.agentId, record)}\nSaved “${record.title}” as revision ${revision}. Its card in the chat shows the change, and the stage shows it to the user if they have it open.`,
        };
      } catch (error) {
        return canvasFailure(error);
      }
    },
  },

  read_canvas: {
    spec: tool(
      "read_canvas",
      "Read one of your canvases as it is now: its HTML, title, address and revision. The user can restore an older revision of a canvas: read it before you write it again if they may have (a message that starts with [I changed … since my last message] says which pages they changed).",
      {
        type: "object",
        properties: {
          canvas_id: { type: "string", description: "The canvas's id, as write_canvas returned it (canvas-…)." },
          url: { type: "string", description: "Or its address, as write_canvas returned it (wisp-canvas://…)." },
        },
      },
    ),
    summary: (args, context) => {
      const id = canvasArg(args, context.agentId);
      const record = id != null ? context.store.getPage(context.agentId, id) : undefined;
      return `Read ${record != null ? quote(record.title) : "a canvas"}`;
    },
    async run(args, context) {
      const id = canvasArg(args, context.agentId);
      if (id == null) return { output: "Name the canvas: its canvas_id, or the url write_canvas returned.", isError: true };
      try {
        const { record, source, revision } = readCanvas(context.store, context.agentId, id);
        const by = record.revisions[record.revisions.length - 1].by === "user" ? "the user" : "you";
        return { output: `${canvasResult(context.agentId, record)}\n“${record.title}”, revision ${revision}, last changed by ${by}:\n\n${source}` };
      } catch (error) {
        return canvasFailure(error);
      }
    },
  },

  web_fetch: {
    spec: tool(
      "web_fetch",
      "Fetch a public web page or API over HTTP(S) and return its text (HTML is reduced to readable text). Use for documentation, articles and JSON APIs.",
      {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL." },
          max_chars: { type: "integer", description: "Truncate the returned text (default 20000)." },
        },
        required: ["url"],
      },
    ),
    summary: (args) => `Fetched ${String(args.url ?? "")}`,
    async run(args, context) {
      const url = new URL(String(args.url));
      if (url.protocol !== "https:" && url.protocol !== "http:") return { output: "Only http(s) URLs can be fetched.", isError: true };
      const response = await fetch(url, {
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]),
        headers: { "user-agent": "Wisp/0.1 (+desktop agent)" },
        redirect: "follow",
      });
      const type = response.headers.get("content-type") ?? "";
      const raw = await response.text();
      const text = /html/i.test(type) ? htmlToText(raw) : raw;
      const limit = Math.min(Math.max(Number(args.max_chars) || 20_000, 500), 100_000);
      const body = text.length > limit ? `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]` : text;
      return { output: `HTTP ${response.status} ${response.statusText}\n${type}\n\n${body}`, isError: !response.ok };
    },
  },

  schedule_automation: {
    spec: tool(
      "schedule_automation",
      "Create a recurring automation: the prompt is sent to you on a cron schedule in the user's local time (5 fields: minute hour day-of-month month day-of-week, e.g. \"0 9 * * 1-5\" for weekdays at 09:00).",
      {
        type: "object",
        properties: {
          name: { type: "string" },
          prompt: { type: "string", description: "What you should do each time it runs." },
          schedule: { type: "string", description: "Cron expression." },
        },
        required: ["name", "prompt", "schedule"],
      },
    ),
    summary: (args) => `Scheduled “${String(args.name ?? "automation")}” (${isValidCron(String(args.schedule ?? "")) ? describeCron(String(args.schedule)) : "invalid schedule"})`,
    async run(args, context) {
      const schedule = String(args.schedule ?? "");
      if (!isValidCron(schedule)) return { output: `"${schedule}" is not a valid 5-field cron expression.`, isError: true };
      const automation = buildAutomation(context.agentId, { name: String(args.name).slice(0, 120), prompt: String(args.prompt).slice(0, 20_000), trigger: { type: "cron", schedule } });
      context.store.putAutomation(automation);
      context.automationsChanged(automation, "created");
      return { output: `Automation "${automation.name}" scheduled (${automation.triggerDescription}); next run ${automation.nextRunAt == null ? "never" : new Date(automation.nextRunAt).toLocaleString()}.` };
    },
  },

  list_automations: {
    spec: tool("list_automations", "List your scheduled automations.", { type: "object", properties: {} }),
    summary: () => "Listed automations",
    async run(_args, context) {
      const automations = context.store.listAutomations(context.agentId);
      if (automations.length === 0) return { output: "No automations." };
      return { output: automations.map((a) => `${a.id}  ${a.isEnabled ? "on " : "off"}  ${a.name}  (${a.triggerDescription})`).join("\n") };
    },
  },

  delete_automation: {
    spec: tool("delete_automation", "Delete one of your automations by id.", { type: "object", properties: { id: { type: "string" } }, required: ["id"] }),
    summary: (args) => `Deleted automation ${String(args.id ?? "")}`,
    async run(args, context) {
      const existing = context.store.listAutomations(context.agentId).find((a) => a.id === args.id);
      if (existing == null) return { output: "No automation with that id.", isError: true };
      context.store.deleteAutomation(existing.id);
      context.automationsChanged(existing, "deleted");
      return { output: `Deleted "${existing.name}".` };
    },
  },

  // Offered only while the agent has skills it may load (see Harness.toolSpecs).
  load_skill: {
    spec: tool(
      "load_skill",
      "Load one of your skills: instructions the user saved for a kind of task. Call it when a request matches a skill listed in your instructions, then follow what it returns.",
      { type: "object", properties: { name: { type: "string", description: "The skill's name, as listed." } }, required: ["name"] },
    ),
    summary: (args) => `Loaded the “${String(args.name ?? "")}” skill`,
    async run(args, context) {
      const skills = context.store.listSkills(context.agentId).filter((skill) => skill.disableModelInvocation !== true);
      const skill = findSkill(skills, String(args.name ?? ""));
      if (skill == null) return { output: `No skill named "${String(args.name ?? "")}". Your skills: ${skills.map((s) => s.name).join(", ") || "none"}.`, isError: true };
      return { output: `# ${skill.name}\n\n${skill.body}` };
    },
  },

  save_memory: {
    spec: tool(
      "save_memory",
      "Save something to your memory, which you keep across conversations: a fact about the user or their work, a preference, or how they like work done. One short fact per call.",
      { type: "object", properties: { text: { type: "string", description: `The memory: one short fact, up to ${MAX_MEMORY_TEXT} characters.` } }, required: ["text"] },
    ),
    summary: (args, context) => `${reviewing(context) ? "Asked to remember" : "Remembered"} ${quote(args.text)}`,
    async run(args, context) {
      try {
        const { memory, existing } = addMemory(context.store, context.agentId, String(args.text ?? ""), "agent", reviewing(context));
        if (existing) return { output: memory.review?.action === "add" ? `That is already waiting for the user's review as [${memory.id}].` : `That is already in your memory as [${memory.id}].` };
        context.memoriesChanged();
        return { output: memory.review != null ? `Saved [${memory.id}] for the user's review; it takes effect once they approve it.` : `Saved to your memory as [${memory.id}].` };
      } catch (error) {
        return memoryFailure(error);
      }
    },
  },

  update_memory: {
    spec: tool("update_memory", "Rewrite one of your memories, by its id, when it is wrong, out of date, or can absorb a related memory.", {
      type: "object",
      properties: { id: memoryId, text: { type: "string", description: `Its new text: one short fact, up to ${MAX_MEMORY_TEXT} characters.` } },
      required: ["id", "text"],
    }),
    summary: (args, context) => `${reviewing(context) ? "Asked to change a memory to" : "Updated a memory:"} ${quote(args.text)}`,
    async run(args, context) {
      try {
        const { memory, outcome } = editMemory(context.store, context.agentId, String(args.id ?? ""), String(args.text ?? ""), "agent", reviewing(context));
        if (outcome === "unchanged") return { output: `[${memory.id}] already says that.` };
        context.memoriesChanged();
        if (outcome === "updated") return { output: `Updated [${memory.id}].` };
        return { output: memory.review?.action === "add" ? `Updated [${memory.id}]; it still waits for the user's review.` : `Asked the user to approve the change to [${memory.id}]; until then it keeps its current text.` };
      } catch (error) {
        return memoryFailure(error);
      }
    },
  },

  forget_memory: {
    spec: tool("forget_memory", "Remove one of your memories, by its id, when it no longer holds or the user asks you to forget it.", { type: "object", properties: { id: memoryId }, required: ["id"] }),
    summary: (args, context) => {
      let text: string | null = null;
      try {
        text = findMemory(context.store, context.agentId, String(args.id ?? "")).text;
      } catch {
        // an unknown id fails when the call runs
      }
      return `${reviewing(context) ? "Asked to forget" : "Forgot"} ${text != null ? quote(text) : "a memory"}`;
    },
    async run(args, context) {
      try {
        const { memory, outcome } = forgetMemory(context.store, context.agentId, String(args.id ?? ""), "agent", reviewing(context));
        context.memoriesChanged();
        return { output: outcome === "proposed" ? `Asked the user to approve forgetting [${memory.id}]; until then it stays in your memory.` : `Forgot [${memory.id}].` };
      } catch (error) {
        return memoryFailure(error);
      }
    },
  },
};

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|pre|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
