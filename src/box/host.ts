// The box host: it owns agents, transcripts and the harness, and serves them
// over the gateway the coordinator talks to — one POST per command plus a
// Server-Sent Events stream (see src/shared/gateway-protocol.ts). The local-exec
// daemon connects to the same server to provide tools on the user's computer.
//
// Two entries start it: src/box/main.ts, an Electron utility process on this
// PC that main configures over a MessagePort, and src/box-server/main.ts, plain
// Node on an always-on server, configured from env, a file and /admin.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { dirname, join, resolve } from "node:path";
import { type BackgroundShellStatus, parseShellStatus } from "../shared/background-shell";
import { botTemplateFileName, readBotTemplate, SHARE_ID_PATTERN } from "../shared/bot-template";
import { EdgeCallFailure } from "../shared/rpc/edge";
import { type BoxConfig, gatewayEdge } from "../shared/edges";
import { GATEWAY_CAPABILITIES, GATEWAY_PROTOCOL_VERSION, type LocalExecRequest, type LocalMachine, type LocalToolDescriptor, type ToolResult } from "../shared/gateway-protocol";
import { MAX_ATTACHMENT_BYTES, mimeFor, safeFileName } from "../shared/mime";
import { locatorPageId, pageKindOf } from "../shared/pages";
import {
  AVATAR_COLORS,
  AVATAR_SHAPES,
  type AgentSummary,
  type ConversationMatch,
  type McpSignInTarget,
  MAIN_SESSION,
  type MessageEntry,
  type MessageMatch,
  type ModelChoice,
  parseModelRef,
  parseVoiceId,
  type ProviderId,
  skillCommand,
  type SkillImportEvent,
  type SpokenAudio,
  type TranscriptEntry,
} from "../shared/model";
import {
  avatarColorOf,
  avatarShapeOf,
  botMarketplace,
  BotTemplateError,
  type CatalogLookup,
  importTemplate,
  isGalleryTemplate,
  publicTemplate,
  publishTemplate,
  requireTemplate,
  saveTemplateVersion,
  setTemplateVisibility,
  templateVersionFile,
  templateView,
} from "./bot-templates";
import { AsyncTaskError, AsyncTasks } from "./async-tasks";
import { approveClaudeCodeRequest, type BridgeRunState, ClaudeCodeEngine, type EngineHost } from "./claude-code";
import { CloudComputer } from "./cloud-computer";
import { Harness, type LocalToolCall, publicEntry } from "./harness";
import { bearerMatches, CommandError, isInside, openSse, readBody, readJson, sendJson as json } from "./http";
import { isSecureEndpoint } from "../shared/mcp-oauth";
import { GITHUB_HOSTS, type MarketplaceHosts } from "./marketplace";
import { listModels, type ResolveDeps } from "./models";
import { basicEnv, type McpAuthProvider, McpManager, parseMcpConfig } from "./mcp";
import { catalogApp, type CatalogFile, catalogServer, mcpCatalog } from "./mcp-catalog";
import { addMemory, editMemory, MemoryError, reviewMemory } from "./memory";
import { MessageActionError, nextFeedback, toggleReaction } from "./message-actions";
import { conversationOutline } from "./outline";
import { documentView, libraryPage, PageError, readCanvas, readDocument, storedPage, retitleCanvas, requirePage, restoreRevision, revisionList, writePage } from "./pages";
import { PluginError, PluginHost } from "./plugins";
import { RoomError, Rooms } from "./rooms";
import { buildAutomation, Scheduler } from "./scheduler";
import { buildSkill, fetchSkillText, skillFromMarkdown } from "./skills";
import { BoxStore } from "./store";
import { greetingText, speakableText, speaker, speechConnections, speechParts, synthesize, transcribe, voiceCapabilities, VoiceError } from "./voice";

export interface BoxHostOptions {
  dataDir: string;
  version: string;
  /** Bearer token every gateway client presents. */
  token: string;
  host: string;
  port: number;
  /** Serve HTTPS with this certificate; otherwise plain HTTP. */
  tls?: { cert: string | Buffer; key: string | Buffer } | null;
  /**
   * Where Claude Code's bridge reaches the box: "shared" uses the gateway's own port (the box on
   * this PC, which only listens on loopback); "loopback" opens a second, plain-HTTP listener on
   * 127.0.0.1 that serves only the bridge, so bridge calls never face the network.
   */
  bridgeListener: "shared" | "loopback";
  /** Configuration to start with, before the first configure(). */
  config?: BoxConfig | null;
  /** A valid ChatGPT plan access token; `force` refreshes even if the current one hasn't expired. */
  refreshChatGptToken(force: boolean): Promise<{ accessToken: string; expiresAt: number }>;
  /** Access tokens for HTTP MCP servers someone signed in to: main for the box on this PC, the server's own store otherwise. */
  mcpAuth: McpAuthProvider;
  /** The Connect Apps catalog; the bundled one unless a test gives its own. */
  mcpCatalog?: CatalogFile;
  /** Where plugin marketplaces are downloaded from; GitHub unless a test gives a fake. */
  marketplaceHosts?: MarketplaceHosts;
  /** The clock the daily plugin update check goes by; the real one unless a test moves it on. */
  marketplaceClock?: () => number;
  /** Extra routes behind the token (the standalone server's /admin); resolve true when handled. */
  routes?(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
  log(line: string): void;
}

export interface BoxHost {
  readonly port: number;
  configure(next: BoxConfig): void;
  config(): BoxConfig | null;
  listModels(provider: ProviderId): Promise<ModelChoice[]>;
  localExecReady(): boolean;
  /** What a sign-in to this HTTP MCP server needs (its address, a configured client, the server's last refusal). */
  mcpSignInTarget(serverId: string): McpSignInTarget;
  /** The server's sign-in was saved or removed: connect it again. */
  mcpSignInChanged(serverId: string): void;
  /** Runs the daily plugin update check now for the marketplaces it's due (it otherwise looks every hour). */
  checkPluginUpdates(): Promise<void>;
  close(): void;
}

interface LocalExecSession {
  stream: ServerResponse | null;
  tools: LocalToolDescriptor[];
  label: string;
  machine: LocalMachine | null;
}

/** Finds the query as typed, in any case. */
function literalPattern(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
}

/** Up to `limit` messages of a conversation that match, newest first, each with the text around its first match on one line. */
function messageMatches(entries: TranscriptEntry[], pattern: RegExp, limit: number, beforeSeq?: number): ConversationMatch[] {
  const matches: ConversationMatch[] = [];
  for (let index = entries.length - 1; index >= 0 && matches.length < limit; index--) {
    const entry = entries[index];
    // A message the chat doesn't show isn't found in it either.
    if (entry.kind !== "message" || entry.suppressed != null || (beforeSeq != null && entry.seq >= beforeSeq)) continue;
    const found = pattern.exec(entry.content);
    if (found == null) continue;
    const start = Math.max(0, found.index - 40);
    const end = Math.min(entry.content.length, found.index + found[0].length + 80);
    const around = entry.content.slice(start, end).replace(/\s+/g, " ").trim();
    matches.push({ entryId: entry.id, role: entry.role, seq: entry.seq, snippet: `${start > 0 ? "…" : ""}${around}${end < entry.content.length ? "…" : ""}`, timestampMs: entry.timestampMs });
  }
  return matches;
}

export async function startBoxHost(options: BoxHostOptions): Promise<BoxHost> {
  const { log } = options;
  const store = new BoxStore(options.dataDir);
  const attachmentsDir = join(options.dataDir, "attachments");
  let config: BoxConfig | null = options.config ?? null;
  const eventStreams = new Set<ServerResponse>();
  let localExec: LocalExecSession | null = null;
  const pendingTools = new Map<string, { resolve: (result: ToolResult) => void; onProgress: (chunk: string) => void }>();

  const broadcast = (channel: string, payload: unknown) => {
    const block = `data: ${JSON.stringify({ channel, payload })}\n\n`;
    for (const stream of eventStreams) stream.write(block);
  };
  const sendLocalExec = (request: LocalExecRequest): boolean => {
    if (localExec?.stream == null) return false;
    localExec.stream.write(`data: ${JSON.stringify(request)}\n\n`);
    return true;
  };

  const workspaceRoot = () => config?.workspaceRoot || join(options.dataDir, "workspaces");

  // ChatGPT plan tokens live an hour; whoever owns the sign-in (main, or the server's own credentials) refreshes them.
  let refreshing: Promise<string> | null = null;
  const resolveDeps: ResolveDeps = {
    chatGptToken: async (forceRefresh) => {
      const openai = config?.models.openai;
      if (openai == null || openai.auth !== "chatgpt") throw new Error("Sign in with ChatGPT is not connected.");
      if (!forceRefresh && openai.expiresAt - Date.now() > 60_000) return openai.accessToken;
      refreshing ??= options
        .refreshChatGptToken(forceRefresh)
        .then(({ accessToken, expiresAt }) => {
          const current = config?.models.openai;
          if (current?.auth === "chatgpt") Object.assign(current, { accessToken, expiresAt });
          return accessToken;
        })
        .finally(() => {
          refreshing = null;
        });
      return refreshing;
    },
  };

  const mcp = new McpManager(() => broadcast("apps-state", mcpState()), log, options.mcpAuth);
  /** The servers as clients see them, stamped with the change they reflect. */
  const mcpState = () => ({ servers: mcp.state(store.mcpServers()), ordered: mcp.ordered() });
  // The servers start once the plugins are read (below): a plugin turned off keeps its servers stopped.

  // Claude Code runs reach back into this box through the bridge MCP server.
  let bridgePort = 0;
  const bridgeRuns = new Map<string, { host: EngineHost; state: BridgeRunState }>();
  const claudeCode = new ClaudeCodeEngine({
    bridge: {
      register: (engineHost, state) => {
        const token = randomBytes(24).toString("hex");
        bridgeRuns.set(token, { host: engineHost, state });
        return token;
      },
      unregister: (token) => bridgeRuns.delete(token),
      baseUrl: () => `http://127.0.0.1:${bridgePort}`,
      bridgeScript: join(__dirname, "..", "claude-bridge", "main.cjs"),
    },
    tempDir: join(options.dataDir, "claude-code"),
    mcpServers: () => plugins.runnable(store.mcpServers()),
    mcpHttpHeaders: (server) => mcp.clientHeaders(server.id),
    log,
  });

  const callLocalTool = (call: LocalToolCall, signal: AbortSignal): Promise<ToolResult> =>
    new Promise((resolve) => {
      const requestId = randomUUID();
      pendingTools.set(requestId, { resolve, onProgress: call.onProgress });
      const sent = sendLocalExec({ type: "tool", requestId, agentId: call.agentId, tool: call.tool, args: call.args, approval: call.approval, cwd: call.cwd, ...(call.answer != null ? { answer: call.answer } : {}) });
      if (!sent) {
        pendingTools.delete(requestId);
        return resolve({ kind: "error", message: "The local tools are not connected." });
      }
      signal.addEventListener("abort", () => {
        if (!pendingTools.delete(requestId)) return;
        sendLocalExec({ type: "tool-cancel", requestId });
        resolve({ kind: "error", message: "interrupted" });
      });
    });

  /** Stops a background command on the PC or reads its output, through the daemon (answered on /pc/responses). */
  const controlLocal = (request: { agentId: string; shellId: number; action: "stop" | "output"; tailChars?: number }): Promise<ToolResult> =>
    new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        if (pendingTools.delete(requestId)) resolve({ kind: "error", message: "The PC's local tools didn't answer." });
      }, 20_000);
      pendingTools.set(requestId, { resolve: (result) => (clearTimeout(timer), resolve(result)), onProgress: () => undefined });
      if (!sendLocalExec({ type: "shell-control", requestId, ...request })) {
        clearTimeout(timer);
        pendingTools.delete(requestId);
        reject(new AsyncTaskError("offline", `${store.localMachine()?.hostname ?? "The PC"} isn’t connected, so its command can’t be reached now.`));
      }
    });

  const cloud = new CloudComputer({
    config: () => config?.cloud ?? null,
    load: () => store.cloudState(),
    save: (state) => store.setCloudState(state),
    onStatus: (status) => {
      broadcast("cloud-computer", status);
      asyncTasks.cloudChanged(status);
    },
    log,
  });

  const asyncTasks = new AsyncTasks({
    store,
    emit: broadcast,
    patchAgent: (agentId, patch) => harness.patchAgent(agentId, patch),
    // The session that started it hears how it ended (a group chat member's, in its room).
    ended: (record, text, wake) => harness.notifyQuietly(record.agentId, text, wake, record.sessionId ?? MAIN_SESSION),
    controlLocal,
    localHost: () => (localExec?.stream != null ? (localExec.machine?.hostname ?? localExec.label) : null),
    cloud,
    log,
  });

  const harness: Harness = new Harness({
    store,
    models: () => config?.models ?? null,
    resolveDeps,
    workspaceRoot,
    localTools: () => localExec?.tools ?? [],
    // The connected daemon's computer, or the last one that connected (with a remote box the PC may be off).
    localMachine: () => localExec?.machine ?? store.localMachine(),
    callLocalTool,
    mcp,
    claudeCode,
    cloud,
    cloudConfig: () => config?.cloud ?? null,
    asyncTasks,
    // Members' room sessions (rooms.ts); the hooks run only once the box is serving.
    sessions: {
      instructions: (agentId, sessionId) => rooms.hooks.instructions?.(agentId, sessionId) ?? null,
      live: (agentId, sessionId, live) => rooms.hooks.live?.(agentId, sessionId, live),
      entry: (agentId, sessionId, entry) => rooms.hooks.entry?.(agentId, sessionId, entry),
      activity: (agentId, sessionId, payload) => rooms.hooks.activity?.(agentId, sessionId, payload),
      wake: (agentId, sessionId) => rooms.hooks.wake?.(agentId, sessionId) ?? false,
    },
    emit: broadcast,
    log,
  });
  // Group chats: the rooms' turns, run in their members' `group:<roomId>` sessions.
  const rooms: Rooms = new Rooms({
    store,
    harness: () => harness,
    newRow: (input) => newAgent(input),
    emit: broadcast,
    log,
  });
  asyncTasks.start();
  const emitAutomations =(agentId: string) => broadcast("automations", { agentId, automations: store.listAutomations(agentId) });
  const emitSkills = (agentId: string) => broadcast("skills", { agentId, skills: store.listSkills(agentId) });
  const emitMemories = (agentId: string) => broadcast("memories", { agentId, memories: store.listMemories(agentId) });

  // Plugins from marketplaces: their skills are in every agent's list, their servers among the box's.
  // WISP_MARKETPLACE_GITHUB_URL names a GitHub mirror to download them from instead (https, or http on this machine).
  const mirror = process.env.WISP_MARKETPLACE_GITHUB_URL?.trim();
  if (mirror && !isSecureEndpoint(mirror)) log(`WISP_MARKETPLACE_GITHUB_URL ignored: use https, or http on this machine`);
  const plugins = new PluginHost({
    store,
    hosts: options.marketplaceHosts ?? (mirror && isSecureEndpoint(mirror) ? { github: mirror } : GITHUB_HOSTS),
    // `${VAR}` in a plugin's server reads only what the server itself gets: the basics, not the box's keys.
    env: basicEnv(),
    syncServers: () => syncMcp(),
    forgetServer: (serverId) => mcp.forget(serverId),
    newServerId: (name) => newMcpServerId(name),
    serverStatus: (serverId) => mcp.state(store.mcpServers()).find((server) => server.id === serverId)?.status ?? null,
    skillsChanged: () => {
      for (const agent of store.rosterAgents()) emitSkills(agent.id);
    },
    changed: () => broadcast("marketplaces", { marketplaces: plugins.marketplaces() }),
    now: options.marketplaceClock ?? Date.now,
    log,
  });
  /** Starts, stops and restarts the box's servers to match the store; a turned-off plugin's stay stopped. */
  const syncMcp = () => mcp.sync(plugins.runnable(store.mcpServers()));
  plugins.load();
  syncMcp();
  plugins.startChecks();

  const scheduler = new Scheduler(
    store,
    (automation) => {
      if (store.getAgent(automation.agentId) == null) return false;
      harness.recordAutomationEvent(automation, "ran");
      return harness.submitPrompt(automation.agentId, { prompt: `[Automation “${automation.name}”] ${automation.prompt}`, attachmentPaths: [], attachmentNames: [], clientNonce: null, source: "automation" });
    },
    emitAutomations,
    { fire: (skill, trigger) => harness.runSkill(skill, trigger === "schedule"), onChanged: emitSkills },
  );
  scheduler.start();

  // ---- commands (the gateway contract the coordinator relays) ------------------------------
  const newAgent = (input: { name: string; description?: string; title?: string; avatarShape?: AgentSummary["avatarShape"]; avatarColor?: AgentSummary["avatarColor"]; origin?: "dev" | "user" | null }): AgentSummary => {
    const now = Date.now();
    return {
      id: randomUUID(),
      name: input.name,
      description: input.description ?? "",
      path: "",
      ...(input.title ? { title: input.title } : {}),
      origin: input.origin ?? "user",
      isGroup: false,
      memberIds: [],
      isActive: false,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      isRunning: false,
      isComposingMessage: false,
      awaitingUserResponse: null,
      lastTurnSettlement: null,
      hasUnread: false,
      unreadCount: 0,
      lastMessageId: null,
      lastEntry: null,
      notificationsEnabled: true,
      notifyOnUpdatesEnabled: true,
      isHiddenFromSidebar: false,
      avatarDataUrl: null,
      avatarShape: input.avatarShape ?? AVATAR_SHAPES[Math.floor(Math.random() * AVATAR_SHAPES.length)],
      avatarColor: input.avatarColor ?? AVATAR_COLORS[Math.floor(Math.random() * (AVATAR_COLORS.length - 1))],
      instructions: "",
      model: null,
      isPinned: false,
    };
  };

  const requireAgent = (id: string) => {
    const agent = store.getAgent(id);
    if (agent == null) throw new CommandError(404, `No agent ${id}`, "message.no-agent");
    return agent;
  };
  /** An agent that isn't a group chat: a room has no skills, automations or template of its own. */
  const requireBot = (id: string, what: string) => {
    const agent = requireAgent(id);
    if (agent.isGroup) throw new CommandError(400, `A group chat has no ${what} of its own; its bots do.`, "group/refused");
    return agent;
  };
  /** A group chat call; its refusals are for the user. */
  const roomCall = <T>(run: () => T): T => {
    try {
      return run();
    } catch (error) {
      if (!(error instanceof RoomError)) throw error;
      throw new CommandError(error.code === "missing" ? 404 : 400, error.message, error.code === "missing" ? "group/not-found" : "group/refused");
    }
  };

  const tailPage = (id: string, beforeSeq: number | undefined, limit: number, sessionId: string = MAIN_SESSION) => {
    const entries = store.entries(id, sessionId);
    const end = beforeSeq == null ? entries.length : entries.findIndex((entry) => entry.seq >= beforeSeq);
    const stop = end < 0 ? entries.length : end;
    const startIndex = Math.max(0, stop - limit);
    const page = entries.slice(startIndex, stop).map((entry) => publicEntry(entry));
    return { entries: page, ...(startIndex > 0 ? { nextBeforeSeq: page[0]?.seq } : {}), ordered: store.ordered(id, sessionId) };
  };

  const upserted = (agent: AgentSummary | null) => {
    if (agent != null) broadcast("agent-saved", { agent, ordered: store.rosterStamp() });
    return agent;
  };

  /** Runs a check whose error message is for the user, as a 400. */
  const checked = <T>(build: () => T): T => {
    try {
      return build();
    } catch (error) {
      throw new CommandError(400, error instanceof Error ? error.message : String(error));
    }
  };

  /** Makes a change from the Memory tab and returns the agent's memories; refusals are for the user. */
  const changeMemories = (agentId: string, change: () => void) => {
    requireAgent(agentId);
    try {
      change();
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      throw new CommandError(error.code === "missing" ? 404 : error.code === "settled" ? 409 : 400, error.message);
    }
    emitMemories(agentId);
    return store.listMemories(agentId);
  };

  /** A background task call; its refusals are for the user. */
  const taskCall = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof AsyncTaskError)) throw error;
      throw new CommandError(error.code === "missing" ? 404 : error.code === "offline" ? 503 : 502, error.message, error.code === "offline" ? "async-task/offline" : undefined);
    }
  };
  /** The statuses a daemon sent, those that are statuses. */
  const shellStatuses = (value: unknown): BackgroundShellStatus[] => (Array.isArray(value) ? value.flatMap((item) => parseShellStatus(item) ?? []) : []);

  /** A template call; its refusals are for the user. */
  const templateCall = <T>(run: () => T): T => {
    try {
      return run();
    } catch (error) {
      if (!(error instanceof BotTemplateError)) throw error;
      throw new CommandError(error.code === "not-found" ? 404 : error.code === "stale" ? 409 : 400, error.message, error.code === "not-found" ? "template.not-found" : undefined);
    }
  };
  /** A page call on one agent's document; its refusals are for the user. */
  const pageCall = <T>(storeId: string, run: (agent: AgentSummary) => T): T => {
    const agent = requireAgent(storeId);
    try {
      return run(agent);
    } catch (error) {
      if (!(error instanceof PageError)) throw error;
      throw new CommandError(error.code === "missing" ? 404 : error.code === "stale" || error.code === "writing" ? 409 : 400, error.message, `page/${{ missing: "not-found", stale: "stale", writing: "agent-writing", invalid: "refused" }[error.code]}`);
    }
  };
  /** The user changes a page only while its agent isn't writing it. */
  const checkNotWriting = (agent: AgentSummary, documentId: string) => {
    if (harness.isWritingPage(agent.id, documentId)) throw new PageError("writing", `${agent.name} is writing this page. You can change it once ${agent.name} is done.`);
  };

  /** The apps a template can name: those in the Connect Apps catalog. */
  const catalogLookup: CatalogLookup = (pluginId) => {
    const app = catalogApp(pluginId, options.mcpCatalog);
    return app != null ? { name: app.name, description: app.description } : null;
  };

  /** A short id from the server's name, made unique; agents see it in tool names (`mcp__<id>__<tool>`). */
  const newMcpServerId = (name: string) => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24).replace(/-$/, "") || randomUUID().slice(0, 8);
    return store.mcpServers().some((server) => server.id === slug) ? `${slug}-${randomUUID().slice(0, 4)}` : slug;
  };
  const requireMcpServer = (serverId: string) => {
    const server = store.mcpServers().find((candidate) => candidate.id === serverId);
    if (server == null) throw new CommandError(404, "No such MCP server.");
    return server;
  };
  /** The server, if it is still the account the user saw (another window may have renamed it). */
  const requireMcpAccount = (serverId: string, accountKey: string) => {
    const server = requireMcpServer(serverId);
    if ((server.accountKey ?? "") !== accountKey) throw new CommandError(409, "That account was renamed meanwhile. Try again.");
    return server;
  };
  /** The accounts added from one catalog app. */
  const mcpAccounts = (pluginId: string) => store.mcpServers().filter((server) => server.pluginId === pluginId);
  /** A marketplace or plugin call; its refusals are for the user. */
  const pluginCall = async <T>(run: () => T | Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof PluginError)) throw error;
      throw new CommandError({ "not-found": 404, invalid: 400, conflict: 409, review: 409, unreachable: 502 }[error.code], error.message, `plugin/${error.code}`);
    }
  };
  /** A plugin's server goes with its plugin, not on its own. */
  const refusePluginServer = (serverId: string) => {
    const owner = plugins.pluginOfServer(serverId);
    if (owner != null) throw new CommandError(409, `It comes with the plugin ${owner.plugin.displayName}. Uninstall the plugin to remove it.`, "plugin/server");
  };
  /** A plugin's skill can be run and copied, not changed. */
  const refusePluginSkill = (agentId: string, skillId: string) => {
    const skill = store.pluginSkill(agentId, skillId);
    if (skill != null) throw new CommandError(409, `“${skill.name}” comes with the plugin ${skill.pluginName}. Copy it to the agent to change it.`, "plugin/skill");
  };
  /** A reaction or vote on one of the agent's entries; refusals are for the user. */
  const actOnMessage = (agentId: string, entryId: string, change: (entry: TranscriptEntry) => void, sessionId: string = MAIN_SESSION): null => {
    requireAgent(agentId);
    try {
      harness.annotate(agentId, entryId, change, sessionId);
    } catch (error) {
      if (!(error instanceof MessageActionError)) throw error;
      throw new CommandError(error.code === "missing" ? 404 : error.code === "streaming" ? 409 : 400, error.message);
    }
    return null;
  };

  /** Adds the skill a Markdown document holds, or reports why it was skipped. */
  const importSkill = (agentId: string, source: string, text: string, sourceRef: string | null, name: string | undefined): SkillImportEvent => {
    const result: SkillImportEvent["result"] = { imported: [], skipped: [] };
    try {
      const found = skillFromMarkdown(text, name);
      if ("reason" in found) throw new Error(found.reason);
      const skill = store.putSkill(buildSkill(agentId, { ...found.spec, sourceRef }, store.skillNamesInUse(agentId)), found.extra);
      result.imported.push({ id: skill.id, name: skill.name });
      emitSkills(agentId);
    } catch (error) {
      result.skipped.push({ source, reason: error instanceof Error ? error.message : String(error) });
    }
    return { result, skills: store.listSkills(agentId) };
  };

  /** The provider of the agent's model: its recordings and replies go there when it can do speech. */
  const agentProvider = (agentId: string | undefined): ProviderId | null => {
    const agent = agentId != null ? store.getAgent(agentId) : undefined;
    return agent != null && config != null ? parseModelRef(agent.model, config.models.defaultModel).provider : null;
  };

  /** Speech failures as gateway errors; their messages are for the user. */
  const voiceFailure = (error: unknown): never => {
    if (!(error instanceof VoiceError)) throw error;
    throw new CommandError({ unavailable: 409, empty: 400, "too-large": 413, provider: 424 }[error.code], error.message, `voice/${error.code}`);
  };

  /** A recording attached in the app (staged on this machine, or uploaded from the PC), never any other file. */
  const attachedRecording = (path: string): Buffer => {
    if (!isInside(path, attachmentsDir) || resolve(path) === resolve(attachmentsDir)) throw new CommandError(403, "Only recordings attached in the app can be transcribed.", "voice/refused");
    try {
      return readFileSync(path);
    } catch {
      throw new CommandError(404, "The recording isn’t there any more. Record it again.", "voice/missing");
    }
  };

  /** Deletes a dictation's recording, and its folder once that is empty. */
  const discardRecording = (path: string) => {
    rmSync(path, { force: true });
    const folder = dirname(resolve(path));
    if (folder === resolve(attachmentsDir)) return;
    try {
      rmdirSync(folder);
    } catch {
      // other files are in it
    }
  };

  /** The parts of replies read aloud lately, so reading one again doesn't pay the provider twice: at most 24, and 24 MB. */
  const spoken = new Map<string, Omit<SpokenAudio, "part" | "parts">>();
  const keepSpoken = (key: string, audio: Omit<SpokenAudio, "part" | "parts">) => {
    spoken.delete(key);
    spoken.set(key, audio);
    let size = [...spoken.values()].reduce((total, clip) => total + clip.audioBase64.length, 0);
    for (const [staleKey, stale] of spoken) {
      if (spoken.size <= 24 && size <= 24_000_000) break;
      spoken.delete(staleKey);
      size -= stale.audioBase64.length;
    }
  };

  const commands: { [K in keyof typeof gatewayEdge.methods]: (args: any) => unknown } = {
    // Hidden agents too: the renderer lists them apart so they can be shown again, and the tray, the
    // desktop panel and the roster counts leave them out.
    rosterAgents: () => store.rosterAgents(),
    addAgent: (args) => {
      if (args.clientNonce != null) {
        // Idempotent create: a resend with the same nonce returns the same agent.
        const existing = store.rosterAgents().find((agent) => (agent as AgentSummary & { createNonce?: string }).createNonce === args.clientNonce);
        if (existing != null) return { agent: existing, transcript: [] };
      }
      const agent = store.putAgent({ ...newAgent(args), ...(args.clientNonce != null ? { createNonce: args.clientNonce } : {}) } as AgentSummary);
      store.workspaceFor(agent.id, workspaceRoot());
      upserted(agent);
      return { agent, transcript: [] };
    },
    editAgent: ({ id, profile }) => {
      const before = requireAgent(id);
      const next = harness.patchAgent(id, { name: profile.name, description: profile.description, ...(profile.title != null ? { title: profile.title } : {}), ...(profile.avatarShape ? { avatarShape: profile.avatarShape } : {}), ...(profile.avatarColor ? { avatarColor: profile.avatarColor } : {}) });
      if (next != null && before.name !== next.name) {
        const turn = store.nextTurn(id);
        const entry = { kind: "event" as const, id: `t${turn}s0`, seq: store.nextSeq(id), turn, step: 0, timestampMs: Date.now(), event: { type: "name-changed" as const, from: before.name, to: next.name } };
        store.upsertEntry(id, entry, true);
        broadcast("transcript", { type: "appended", agentId: id, entry, ordered: store.stamp(id) });
      }
      return next;
    },
    updateAgentConfig: ({ id, instructions, model, isPinned, computer, memoryReview }) => {
      requireAgent(id);
      return harness.patchAgent(id, {
        ...(instructions != null ? { instructions } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(isPinned != null ? { isPinned } : {}),
        ...(computer != null ? { computer } : {}),
        ...(memoryReview != null ? { memoryReview } : {}),
      });
    },
    makeGroupChat: ({ name, description, memberAgentIds, humanMemberUserIds, clientNonce }) =>
      roomCall(() => {
        if ((humanMemberUserIds ?? []).length > 0) throw new CommandError(400, "Group chats with people aren't supported. Only bots can join.", "group/refused");
        return { agent: rooms.makeGroupChat({ name, description, memberAgentIds, clientNonce }), transcript: [] };
      }),
    changeGroupMembers: ({ id, memberAgentIds }) => roomCall(() => rooms.setMembers(id, memberAgentIds)),
    removeAgents: ({ ids }) => {
      for (const id of ids) {
        // A room's members stay; a member leaves its rooms.
        if (rooms.isRoom(id)) rooms.deleteRoom(id);
        else rooms.memberDeleted(id);
        harness.interrupt(id);
        asyncTasks.forgetAgent(id);
        store.deleteAgent(id);
      }
      broadcast("agent-deleted", { ids });
      return { transcript: [] };
    },
    copyAgent: ({ id }) => {
      const source = requireBot(id, "copy");
      const agent = store.putAgent({ ...newAgent({ name: `${source.name} (copy)`, description: source.description, avatarShape: source.avatarShape, avatarColor: source.avatarColor }), instructions: source.instructions, model: source.model, computer: source.computer });
      upserted(agent);
      return { agent, transcript: [] };
    },
    markAgentUnread: ({ id, isUnread, atMs }) => {
      const agent = requireAgent(id);
      if (agent.hasUnread === isUnread && (isUnread || (agent.unreadCount ?? 0) === 0)) return null;
      harness.patchAgent(id, isUnread ? { hasUnread: true, unreadCount: Math.max(1, agent.unreadCount ?? 0) } : { hasUnread: false, unreadCount: 0, lastViewedAt: atMs ?? Date.now() });
      return null;
    },
    changeAgentHidden: ({ id, isHidden }) => {
      requireAgent(id);
      harness.patchAgent(id, { isHiddenFromSidebar: isHidden });
      return null;
    },
    changeAgentNotifications: ({ id, isEnabled }) => {
      requireAgent(id);
      harness.patchAgent(id, { notifyOnUpdatesEnabled: isEnabled });
      return null;
    },
    followTranscript: ({ id, limit, sessionId }) => {
      const agent = requireAgent(id);
      // Another session is only read: opening it doesn't open the agent's chat.
      if (sessionId != null && sessionId !== MAIN_SESSION) return { ...tailPage(id, undefined, limit, sessionId), unreadAnchor: { kind: "none" } };
      const page = tailPage(id, undefined, limit);
      const unread = agent.unreadCount ?? 0;
      const firstUnread = unread > 0 && agent.lastViewedAt != null ? page.entries.find((entry) => entry.timestampMs > agent.lastViewedAt! && !(entry.kind === "message" && entry.role === "user")) : undefined;
      for (const other of store.rosterAgents()) if (other.isActive && other.id !== id) harness.patchAgent(other.id, { isActive: false });
      harness.patchAgent(id, { hasUnread: false, unreadCount: 0, lastViewedAt: Date.now(), isActive: true });
      return { ...page, unreadAnchor: firstUnread != null ? { kind: "at", entryId: firstUnread.id, seq: firstUnread.seq, newerRows: page.entries.filter((e) => e.seq >= firstUnread.seq).length } : { kind: "none" } };
    },
    readTranscriptEnd: ({ id, beforeSeq, limit, sessionId }) => {
      requireAgent(id);
      return tailPage(id, beforeSeq, limit, sessionId ?? MAIN_SESSION);
    },
    deliverMessage: (args) => {
      const agent = requireAgent(args.agentId);
      const attachmentPaths: string[] = args.attachmentPaths ?? [];
      if (args.prompt.trim().length === 0 && attachmentPaths.length === 0) throw new CommandError(400, "Nothing to send.", "message.rejected");
      if (args.prompt.length > 200_000) throw new CommandError(400, "Message too long.", "message.rejected");
      // A member's room session hears only from its room.
      if (args.sessionId?.startsWith("group:")) throw new CommandError(400, "A bot’s group chat session takes its messages from the group chat.", "send/refused");
      if (agent.isGroup) {
        if (attachmentPaths.length > 0 || args.voiceMemo != null) throw new CommandError(400, "Group chats take text messages only for now.", "send/refused");
        return { accepted: roomCall(() => rooms.post(agent.id, { prompt: args.prompt, clientNonce: args.clientNonce ?? null, replyToId: args.replyToId ?? null, replyQuote: args.replyQuote ?? null })) };
      }
      // A voice memo is one recording from the attachment store, which is all the UI plays from.
      if (args.voiceMemo != null && (attachmentPaths.length !== 1 || !isInside(attachmentPaths[0], attachmentsDir))) {
        throw new CommandError(400, "A voice memo is one recording attached in the app.", "send/voice-memo-refused");
      }
      const source: MessageEntry["source"] = args.origin === "desktop-mount" ? "desktop-mount" : "user";
      harness.submitPrompt(args.agentId, {
        prompt: args.prompt,
        attachmentPaths,
        attachmentNames: args.attachmentNames ?? [],
        clientNonce: args.clientNonce ?? null,
        source,
        voiceMemo: args.voiceMemo,
        replyToId: args.replyToId ?? null,
        replyQuote: args.replyQuote ?? null,
        ...(args.sessionId != null && args.sessionId !== MAIN_SESSION ? { sessionId: args.sessionId } : {}),
      });
      return { accepted: true };
    },
    // A group chat's Stop stops every member's turn in it.
    stopAgentRun: ({ id, sessionId }) => ({ hadActiveRun: rooms.isRoom(id) ? rooms.stop(id) : harness.interrupt(id, sessionId ?? MAIN_SESSION) }),
    resetConversation: ({ id, sessionId }) => {
      const agent = requireAgent(id);
      if (agent.isGroup) rooms.startFresh(id);
      else harness.startFresh(id, sessionId ?? MAIN_SESSION);
      return null;
    },
    answerCard: ({ agentId, entryId, value, sessionId }) => ({ accepted: harness.answerCard(agentId, entryId, value, sessionId ?? MAIN_SESSION) }),
    closeCard: ({ agentId, entryId, sessionId }) => ({ accepted: harness.closeCard(agentId, entryId, sessionId ?? MAIN_SESSION) }),
    answerToolApproval: ({ agentId, entryId, requestId, resolution, sessionId }) => {
      try {
        harness.resolvePermission(agentId, entryId, requestId, resolution, sessionId ?? MAIN_SESSION);
      } catch (error) {
        throw new CommandError(409, error instanceof Error ? error.message : String(error), "approval.stale");
      }
      return null;
    },
    setReaction: ({ agentId, entryId, emoji, sessionId }) =>
      actOnMessage(
        agentId,
        entryId,
        (entry) => {
          const reactions = toggleReaction(entry, emoji, "user");
          if (reactions.length > 0) entry.reactions = reactions;
          else delete entry.reactions;
        },
        sessionId ?? MAIN_SESSION,
      ),
    rateReply: ({ agentId, entryId, action, categories, comment, sessionId }) =>
      actOnMessage(
        agentId,
        entryId,
        (entry) => {
          const feedback = nextFeedback(entry, action, categories, comment);
          if (entry.kind !== "message") return;
          if (feedback != null) entry.feedback = feedback;
          else delete entry.feedback;
        },
        sessionId ?? MAIN_SESSION,
      ),
    findInConversation: ({ agentId, query, beforeSeq, limit }) => {
      requireAgent(agentId);
      const max = limit ?? 50;
      if (query.trim().length === 0) return { isComplete: true, matches: [] };
      // One more than asked for tells whether older matches remain.
      const matches = messageMatches(store.entries(agentId), literalPattern(query.trim()), max + 1, beforeSeq);
      return { isComplete: matches.length <= max, matches: matches.slice(0, max) };
    },
    findAcrossAgents: ({ query, limit }) => {
      const max = limit ?? 20;
      if (query.trim().length === 0) return [];
      const pattern = literalPattern(query.trim());
      const found: MessageMatch[] = store.rosterAgents().flatMap((agent) => messageMatches(store.entries(agent.id), pattern, max).map((match) => ({ agentId: agent.id, ...match })));
      return found.sort((a, b) => b.timestampMs - a.timestampMs || b.seq - a.seq).slice(0, max);
    },
    // There are no subagents yet, so a conversation's id is its agent's.
    readOutline: ({ id }) => {
      requireAgent(id);
      return conversationOutline(store.entries(id));
    },
    getToolCallDetail: ({ id, entryId }) => {
      requireAgent(id);
      const entry = store.entry(id, entryId);
      if (entry?.kind !== "tool-call") throw new CommandError(404, "That tool call isn’t in this conversation any more.");
      return entry.detail ?? null;
    },
    readAgentTodos: ({ id, sessionId }) => store.todos(id, sessionId ?? MAIN_SESSION),
    readAsyncTasks: ({ id }) => {
      requireAgent(id);
      return asyncTasks.info(id);
    },
    cancelAsyncTask: async ({ id, taskId }) => {
      requireAgent(id);
      await taskCall(() => asyncTasks.cancel(id, taskId));
      return null;
    },
    readAsyncTaskOutput: ({ id, taskId, tailChars }) => {
      requireAgent(id);
      return taskCall(() => asyncTasks.readOutput(id, taskId, tailChars ?? 4_000));
    },
    getEndedAsyncTasks: ({ id, limit }) => {
      requireAgent(id);
      return asyncTasks.ended(id, limit ?? 10);
    },
    cancelAllAsyncTasks: ({ id }) => {
      requireAgent(id);
      return asyncTasks.cancelAll(id);
    },
    listAgentAutomations: ({ id }) => store.listAutomations(id),
    addAgentAutomation: ({ id, spec }) => {
      requireBot(id, "automations");
      let automation;
      try {
        automation = buildAutomation(id, spec);
      } catch (error) {
        throw new CommandError(400, error instanceof Error ? error.message : String(error));
      }
      store.putAutomation(automation);
      harness.recordAutomationEvent(automation, "created");
      emitAutomations(id);
      return store.listAutomations(id);
    },
    editAgentAutomation: ({ id, automationId, spec }) => {
      const existing = store.listAutomations(id).find((a) => a.id === automationId);
      if (existing == null) throw new CommandError(404, "No such automation.");
      let automation;
      try {
        automation = buildAutomation(id, spec, existing);
      } catch (error) {
        throw new CommandError(400, error instanceof Error ? error.message : String(error));
      }
      store.putAutomation(automation);
      harness.recordAutomationEvent(automation, "updated");
      emitAutomations(id);
      return store.listAutomations(id);
    },
    removeAgentAutomation: ({ id, automationId }) => {
      const removed = store.deleteAutomation(automationId);
      if (removed != null) harness.recordAutomationEvent(removed, "deleted");
      emitAutomations(id);
      return store.listAutomations(id);
    },
    toggleAgentAutomation: ({ id, automationId, isEnabled }) => {
      const existing = store.listAutomations(id).find((a) => a.id === automationId);
      if (existing == null) throw new CommandError(404, "No such automation.");
      store.putAutomation(buildAutomation(id, { name: existing.name, prompt: existing.prompt, trigger: existing.trigger, isEnabled }, existing));
      emitAutomations(id);
      return store.listAutomations(id);
    },
    runAutomationNow: ({ automationId }) => {
      if (!scheduler.runNow(automationId)) throw new CommandError(404, "No such automation.", "automation.not-found");
      return null;
    },
    listAgentSkills: ({ id }) => store.listSkills(id),
    addAgentSkill: ({ id, spec }) => {
      requireBot(id, "skills");
      store.putSkill(checked(() => buildSkill(id, spec, store.skillNamesInUse(id))));
      emitSkills(id);
      return store.listSkills(id);
    },
    editAgentSkill: ({ id, skillId, spec }) => {
      refusePluginSkill(id, skillId);
      const existing = store.getSkill(id, skillId);
      if (existing == null) throw new CommandError(404, "No such skill.");
      store.putSkill(checked(() => buildSkill(id, spec, store.skillNamesInUse(id), existing)));
      emitSkills(id);
      return store.listSkills(id);
    },
    removeAgentSkill: ({ id, skillId }) => {
      refusePluginSkill(id, skillId);
      store.deleteSkill(id, skillId);
      emitSkills(id);
      return store.listSkills(id);
    },
    runAgentSkillNow: ({ id, skillId }) => {
      requireBot(id, "skills");
      // A plugin's skill keeps no runs: it just runs.
      const fromPlugin = store.pluginSkill(id, skillId);
      if (fromPlugin != null) harness.runSkill(fromPlugin, false);
      else if (!scheduler.runSkillNow(id, skillId)) throw new CommandError(404, "No such skill.");
      return null;
    },
    copyPluginSkill: ({ id, skillId }) => {
      requireBot(id, "skills");
      const skill = store.pluginSkills().find((candidate) => candidate.id === skillId);
      if (skill == null) throw new CommandError(404, "No such plugin skill.");
      // Its own name, made unique among the agent's skills and the plugins' commands.
      const taken = store.skillNamesInUse(id);
      const base = skill.name.slice(skill.name.indexOf(":") + 1);
      let name = base;
      for (let count = 2; taken.some((candidate) => skillCommand(candidate.name) === skillCommand(name)); count++) name = `${base}-${count}`;
      return importSkill(id, skill.name, skill.text, skill.sourceRef, name);
    },
    importSkillText: ({ id, markdown, name }) => {
      requireBot(id, "skills");
      return importSkill(id, "Pasted Markdown", markdown, null, name);
    },
    importSkillFromLink: async ({ id, url, name }) => {
      requireBot(id, "skills");
      if (!/^https?:$/.test(new URL(url).protocol)) throw new CommandError(400, "Only http(s) addresses can be imported.");
      let text: string;
      try {
        text = await fetchSkillText(url);
      } catch (error) {
        return { result: { imported: [], skipped: [{ source: url, reason: error instanceof Error ? error.message : String(error) }] }, skills: store.listSkills(id) };
      }
      return importSkill(id, url, text, url, name);
    },
    getAgentMemories: ({ id }) => store.listMemories(id),
    createAgentMemory: ({ id, text }) =>
      changeMemories(id, () => {
        const { memory, existing } = addMemory(store, id, text, "user", false);
        if (existing) throw new MemoryError("duplicate", memory.review?.action === "add" ? "That is already waiting for your review." : "That is already in this agent’s memory.");
      }),
    updateAgentMemory: ({ id, memoryId, text }) => changeMemories(id, () => editMemory(store, id, memoryId, text, "user", false)),
    deleteAgentMemory: ({ id, memoryId }) => changeMemories(id, () => store.deleteMemory(id, memoryId)),
    reviewAgentMemory: ({ id, memoryId, approve }) => changeMemories(id, () => reviewMemory(store, id, memoryId, approve)),
    listMyTemplates: () => store.listTemplates().flatMap((record) => templateView(store, record) ?? []),
    agentTemplate: ({ sourceAgentId }) => {
      const record = store.templateForAgent(sourceAgentId);
      return record != null ? templateView(store, record) : null;
    },
    readTemplateVersion: ({ shareId, version }) => templateCall(() => templateVersionFile(store, shareId, version)),
    shareTemplate: ({ shareId, version }) => templateCall(() => publishTemplate(store, shareId, version)),
    changeTemplateSharing: ({ shareId, visibility }) => templateCall(() => setTemplateVisibility(store, shareId, visibility)),
    removeTemplate: ({ shareId }) =>
      templateCall(() => {
        requireTemplate(store, shareId);
        store.deleteTemplate(shareId);
        return null;
      }),
    templateExportRules: () => ({ exportPolicy: "all" }),
    listStarterTemplates: ({ category }) => botMarketplace(undefined, category),
    createBotTemplateVersion: ({ sourceAgentId, include }) => {
      const agent = requireBot(sourceAgentId, "template");
      return templateCall(() => saveTemplateVersion(store, agent, include, catalogLookup));
    },
    addAgentFromTemplate: ({ template: sent, name, avatarShape, avatarColor }) => {
      // The renderer already showed this text cleaned; whatever sent it, the box cleans it again.
      const read = readBotTemplate(sent);
      if ("error" in read) throw new CommandError(400, read.error);
      const template = read.template;
      const agent = store.putAgent({
        ...newAgent({ name: name ?? template.name, description: template.description ?? "", title: template.title, avatarShape: avatarShape ?? avatarShapeOf(template.avatarShape), avatarColor: avatarColor ?? avatarColorOf(template.avatarColor) }),
        instructions: template.body.trim(),
        avatarDataUrl: template.avatarDataUrl ?? null,
        sourceTemplate: { shareId: template.shareId, version: template.version ?? null },
      });
      store.workspaceFor(agent.id, workspaceRoot());
      const setup = importTemplate(store, agent.id, template, isGalleryTemplate(template));
      upserted(agent);
      emitSkills(agent.id);
      emitAutomations(agent.id);
      emitMemories(agent.id);
      return { agent, setup, transcript: [] };
    },
    readAppsState: () => mcpState(),
    addMcpServer: ({ name, configJson }) => {
      let parsed: ReturnType<typeof parseMcpConfig>;
      try {
        parsed = parseMcpConfig(name, configJson);
      } catch (error) {
        throw new CommandError(400, error instanceof Error ? error.message : String(error), "mcp-config-refused");
      }
      store.putMcpServer({ id: newMcpServerId(name), ...parsed, enabled: true });
      syncMcp();
      return mcpState();
    },
    readAppCatalog: () => [...mcpCatalog(options.mcpCatalog), ...plugins.catalogEntries()],
    connectCatalogApp: ({ entryId, values, accountKey, serverId, approvalKey }) => {
      if (entryId.includes("@")) {
        return pluginCall(() => {
          const serverIds = plugins.install(entryId, values ?? {}, approvalKey);
          return { ...mcpState(), serverId: serverIds[0] ?? "" };
        });
      }
      const app = catalogApp(entryId, options.mcpCatalog);
      if (app == null) throw new CommandError(404, "That app isn't in the catalog.");
      let endpoint: ReturnType<typeof catalogServer>;
      try {
        endpoint = catalogServer(app, values ?? {});
      } catch (error) {
        throw new CommandError(400, error instanceof Error ? error.message : String(error), "mcp-config-refused");
      }
      let id = serverId;
      if (id != null) {
        // New values for an account already added (say, a fresh token): its settings stay.
        const existing = requireMcpServer(id);
        if (existing.pluginId !== entryId || existing.transport !== "http") throw new CommandError(409, `That server wasn't added from ${app.name}.`);
        store.putMcpServer({ ...existing, ...endpoint });
      } else {
        const key = (accountKey ?? "").trim();
        if (mcpAccounts(entryId).some((server) => (server.accountKey ?? "") === key)) {
          throw new CommandError(409, key.length > 0 ? `You already have a ${app.name} account called “${key}”.` : `${app.name} is already added. Name the new account to add another.`);
        }
        id = newMcpServerId(key.length > 0 ? `${entryId}-${key}` : entryId);
        store.putMcpServer({ id, name: app.name, transport: "http", ...endpoint, enabled: true, pluginId: entryId, accountKey: key });
      }
      syncMcp();
      return { ...mcpState(), serverId: id };
    },
    switchMcpTool: ({ serverId, toolName }) => {
      const server = requireMcpServer(serverId);
      const disabled = server.disabledTools ?? [];
      store.putMcpServer({ ...server, disabledTools: disabled.includes(toolName) ? disabled.filter((name) => name !== toolName) : [...disabled, toolName] });
      syncMcp();
      return mcp.toolsOf(serverId);
    },
    changeAppInstructions: ({ serverId, instructions }) => {
      const server = requireMcpServer(serverId);
      store.putMcpServer({ ...server, customInstructions: instructions.trim() });
      syncMcp();
      return mcpState();
    },
    relabelMcpAccount: ({ serverId, accountKey, newAccountKey }) => {
      const server = requireMcpAccount(serverId, accountKey);
      const key = newAccountKey.trim();
      if (server.pluginId != null && mcpAccounts(server.pluginId).some((other) => other.id !== serverId && (other.accountKey ?? "") === key)) {
        throw new CommandError(409, key.length > 0 ? `You already have a ${server.name} account called “${key}”.` : `Another ${server.name} account has no name. Name this one.`);
      }
      store.putMcpServer({ ...server, accountKey: key });
      syncMcp();
      return mcpState();
    },
    dropMcpAccount: ({ serverId, accountKey }) => {
      requireMcpAccount(serverId, accountKey);
      refusePluginServer(serverId);
      store.deleteMcpServer(serverId);
      syncMcp();
      mcp.forget(serverId);
      return mcpState();
    },
    readMarketplaces: () => plugins.marketplaces(),
    addMarketplace: ({ source }) => pluginCall(() => plugins.add(source)),
    refreshMarketplace: ({ id, plugin }) => pluginCall(() => plugins.refresh(id, plugin)),
    removeMarketplace: ({ id }) => pluginCall(() => plugins.remove(id)),
    skillCatalog: ({ pluginId }) => plugins.skillCatalog(pluginId),
    refreshPluginSkills: () => plugins.syncSkills(),
    readPluginUpdates: () => plugins.syncStatus(),
    listInstalledPlugins: () => plugins.effective(),
    applyPluginInstall: ({ pluginId, values, update, approvalKey }) =>
      pluginCall(() => {
        plugins.update(pluginId, values, update === true, approvalKey);
        return mcpState();
      }),
    getPluginUpdate: ({ pluginId }) => pluginCall(() => plugins.pluginUpdate(pluginId)),
    dropPlugin: ({ pluginId }) => ({ removed: plugins.uninstall(pluginId), reason: null, state: mcpState() }),
    setMcpPluginEnabled: ({ pluginId, enabled }) =>
      pluginCall(() => {
        plugins.setEnabled(pluginId, enabled);
        return mcpState();
      }),
    removeDeletedPlugins: ({ id, pluginIds }) => pluginCall(() => plugins.removeDeleted(id, pluginIds)),
    dropMcpServer: ({ serverId }) => {
      refusePluginServer(serverId);
      store.deleteMcpServer(serverId);
      syncMcp();
      mcp.forget(serverId);
      return mcpState();
    },
    setMcpServerEnabled: ({ serverId, enabled }) => {
      const server = requireMcpServer(serverId);
      store.putMcpServer({ ...server, enabled });
      syncMcp();
      return mcpState();
    },
    mcpServerTools: ({ serverId }) => mcp.toolsOf(serverId),
    readBoxStatus: () => ({
      capabilities: GATEWAY_CAPABILITIES,
      hostUpdateAvailable: false,
      hostVersion: options.version,
      isBusy: store.rosterAgents().some((agent) => harness.isRunning(agent.id)),
      latestHostVersion: null,
      localExec: localExec?.stream != null ? "ready" : "down",
      workspaceRoot: workspaceRoot(),
    }),
    getCloudComputer: () => cloud.status(),
    cloudComputerAction: async ({ action }) => {
      try {
        if (action === "start") await cloud.open();
        else if (action === "pause") await cloud.pause();
        else if (action === "delete") await cloud.destroy();
        else return { status: cloud.status(), viewerUrl: await cloud.viewerUrl() };
      } catch (error) {
        throw new CommandError(400, error instanceof Error ? error.message : String(error), "cloud-computer/failed");
      }
      return { status: cloud.status() };
    },
    speechToText: async ({ audioBase64, attachmentPath, mimeType, language, agentId, discard }) => {
      const bytes = attachmentPath != null ? attachedRecording(attachmentPath) : Buffer.from(audioBase64 ?? "", "base64");
      try {
        return await transcribe(config?.models ?? null, { bytes, mime: mimeType }, { language, prefer: agentProvider(agentId) });
      } catch (error) {
        return voiceFailure(error);
      } finally {
        if (discard === true && attachmentPath != null) discardRecording(attachmentPath);
      }
    },
    changeAgentVoice: ({ id, voiceId, voiceLanguage, voiceSpeed }) => {
      requireAgent(id);
      if (voiceId != null && parseVoiceId(voiceId) == null) throw new CommandError(400, `“${voiceId}” isn’t a voice like xai:eve.`);
      harness.patchAgent(id, { ...(voiceId !== undefined ? { voiceId } : {}), ...(voiceLanguage !== undefined ? { voiceLanguage } : {}), ...(voiceSpeed !== undefined ? { voiceSpeed } : {}) });
      return null;
    },
    sampleVoice: async ({ voiceId, greetingId }) => {
      const voice = parseVoiceId(voiceId);
      if (voice == null) throw new CommandError(400, `“${voiceId}” isn’t a voice like xai:eve.`);
      // Another provider's voice would be no preview of this one.
      if (!speechConnections(config?.models ?? null).some((connection) => connection.provider === voice.provider)) {
        throw new CommandError(409, `Connect ${voice.provider === "xai" ? "xAI" : "OpenAI"} with an API key to hear its voices.`, "voice/unavailable");
      }
      try {
        const audio = await synthesize(config?.models ?? null, { text: greetingText(greetingId), voiceId });
        return { audioBase64: audio.bytes.toString("base64"), mimeType: audio.mime };
      } catch (error) {
        return voiceFailure(error);
      }
    },
    getVoiceCapabilities: ({ agentId }) => voiceCapabilities(config?.models ?? null, agentProvider(agentId), agentId != null ? store.getAgent(agentId)?.voiceId : null),
    speakMessage: async ({ agentId, entryId, part }) => {
      const agent = requireAgent(agentId);
      const entry = store.entries(agentId).find((candidate) => candidate.id === entryId);
      const markdown = entry?.kind === "message" && entry.role === "assistant" ? entry.content : entry?.kind === "send-message" && entry.message.type === "text" ? entry.message.content : null;
      if (markdown == null) throw new CommandError(404, "That reply isn’t in the conversation any more.");
      const parts = speechParts(speakableText(markdown));
      const index = part ?? 0;
      if (parts.length === 0) throw new CommandError(400, "There’s nothing in this reply to read aloud.", "voice/empty");
      if (index >= parts.length) throw new CommandError(400, `This reply is read in ${parts.length} parts.`);
      const reader = speaker(config?.models ?? null, agent.voiceId, agentProvider(agentId));
      const key = createHash("sha256")
        .update(JSON.stringify([reader?.connection.provider, reader?.voice, agent.voiceLanguage ?? null, parts[index]]))
        .digest("hex");
      let audio = spoken.get(key);
      if (audio == null) {
        try {
          const result = await synthesize(config?.models ?? null, { text: parts[index], voiceId: agent.voiceId, language: agent.voiceLanguage, prefer: agentProvider(agentId) });
          audio = { audioBase64: result.bytes.toString("base64"), mimeType: result.mime, voiceId: result.voiceId };
        } catch (error) {
          return voiceFailure(error);
        }
      }
      keepSpoken(key, audio);
      return { ...audio, part: index, parts: parts.length };
    },
    readPage: ({ locator, revision }) =>
      pageCall(locator.storeId, (agent) => {
        const read = readDocument(store, agent.id, locator.documentId, revision);
        return documentView(agent.id, read.record, read.source, read.revision);
      }),
    pageEditAccess: ({ locator }) =>
      pageCall(locator.storeId, (agent) => {
        requirePage(store, agent.id, locatorPageId(locator));
        return harness.editRight(agent.id, locatorPageId(locator));
      }),
    writePage: ({ locator, source, baseRevision }) =>
      pageCall(locator.storeId, (agent) => {
        checkNotWriting(agent, locator.documentId);
        const saved = writePage(store, agent.id, locator.documentId, source, baseRevision);
        if (saved.changed) harness.pageChanged(agent.id, saved.record, saved.source, "edited", "user");
        return documentView(agent.id, saved.record, saved.source);
      }),
    canvasPage: ({ locator, revision }) =>
      pageCall(locator.storeId, (agent) => {
        const read = readCanvas(store, agent.id, locator.canvasId, revision);
        return documentView(agent.id, read.record, read.source, read.revision);
      }),
    retitleCanvas: ({ storeId, canvasId, title }) =>
      pageCall(storeId, (agent) => {
        checkNotWriting(agent, canvasId);
        const renamed = retitleCanvas(store, agent.id, canvasId, title);
        if (renamed.changed) harness.pageChanged(agent.id, renamed.record, readCanvas(store, agent.id, canvasId).source, "renamed", "user");
        return { title: renamed.record.title };
      }),
    libraryPages: ({ includeDocuments, agentId }) =>
      (agentId != null ? [requireAgent(agentId)] : store.rosterAgents())
        .flatMap((agent) => store.listPages(agent.id).filter((record) => includeDocuments || record.kind === "canvas").map((record) => libraryPage(agent.id, record)))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    libraryDocuments: ({ agentId }) => pageCall(agentId, (agent) => store.listPages(agent.id).filter((record) => record.kind === "document").map((record) => libraryPage(agent.id, record))),
    listPageRevisions: ({ locator }) => pageCall(locator.storeId, (agent) => revisionList(requirePage(store, agent.id, locatorPageId(locator)))),
    restorePageRevision: ({ locator, revision, baseRevision }) =>
      pageCall(locator.storeId, (agent) => {
        checkNotWriting(agent, locatorPageId(locator));
        const restored = restoreRevision(store, agent.id, locatorPageId(locator), revision, baseRevision);
        if (restored.changed) harness.pageChanged(agent.id, restored.record, restored.source, "restored", "user");
        return documentView(agent.id, restored.record, restored.source);
      }),
    deletePage: ({ locator }) =>
      pageCall(locator.storeId, (agent) => {
        checkNotWriting(agent, locatorPageId(locator));
        const removed = store.deletePage(agent.id, locatorPageId(locator));
        if (removed == null) throw new PageError("missing", "That page isn’t there any more.");
        harness.pageChanged(agent.id, removed, "", "deleted", "user");
        return null;
      }),
  };

  // ---- HTTP server ------------------------------------------------------------------------
  const tokenBytes = Buffer.from(options.token);

  const handleCommand = async (method: string, request: IncomingMessage, response: ServerResponse) => {
    const decl = (gatewayEdge.methods as Record<string, { schema: { safeParse(v: unknown): any } | null }>)[method];
    const handler = (commands as Record<string, (args: unknown) => unknown>)[method];
    if (decl == null || handler == null) return json(response, 404, { error: `unknown method ${method}`, failureCode: "gateway.unknown-method" });
    const body = await readJson(request);
    let args: unknown = body;
    if (decl.schema != null) {
      const parsed = decl.schema.safeParse(body);
      if (!parsed.success) return json(response, 400, { error: `${method}: ${parsed.error.message}` });
      args = parsed.data;
    }
    const value = await handler(args);
    json(response, 200, value ?? null);
  };

  /** Bridge requests carry their run's own token, not the gateway token. */
  const bridgeRun = (request: IncomingMessage) => {
    const header = request.headers.authorization ?? "";
    return header.startsWith("Bearer ") ? bridgeRuns.get(header.slice(7)) : undefined;
  };
  const handleBridge = async (path: string, request: IncomingMessage, response: ServerResponse) => {
    const run = bridgeRun(request);
    if (run == null) return json(response, 401, { error: "unknown or finished run" });
    const body = (await readJson(request)) as { name?: string; arguments?: Record<string, unknown> };
    if (path === "/bridge/tools") {
      const tools = run.host.appTools().map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters }));
      tools.push({
        name: "approve",
        description: "Internal permission check used by Wisp. Never call this tool yourself.",
        inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] },
      });
      return json(response, 200, { tools });
    }
    const args = typeof body.arguments === "object" && body.arguments != null ? body.arguments : {};
    if (body.name === "approve") {
      const toolName = String(args.tool_name ?? "");
      const input = typeof args.input === "object" && args.input != null ? (args.input as Record<string, unknown>) : {};
      const decision = await approveClaudeCodeRequest(run.host, run.state, toolName, input, typeof args.tool_use_id === "string" ? args.tool_use_id : null).catch(() => ({
        behavior: "deny" as const,
        message: "The approval request was interrupted.",
      }));
      return json(response, 200, { content: [{ type: "text", text: JSON.stringify(decision) }] });
    }
    if (!run.host.appTools().some((tool) => tool.name === body.name)) return json(response, 200, { content: [{ type: "text", text: `Unknown tool ${String(body.name)}` }], isError: true });
    const result = await run.host.runAppTool(run.state.step, String(body.name), args);
    return json(response, 200, {
      content: [{ type: "text", text: result.output }, ...(result.image != null ? [{ type: "image", data: result.image.base64, mimeType: result.image.mime }] : [])],
      isError: result.isError,
    });
  };

  /** A staged attachment sent from a PC to a remote box; the reply's path is what deliverMessage names. */
  const handleUpload = async (url: URL, request: IncomingMessage, response: ServerResponse) => {
    const name = safeFileName(url.searchParams.get("name") ?? "file");
    const bytes = await readBody(request, MAX_ATTACHMENT_BYTES);
    const dir = join(attachmentsDir, randomUUID());
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, bytes);
    json(response, 200, { path, name, bytes: bytes.length });
  };

  /** Uploads and tool images, for a PC whose `wisp-media://` can't read the box's disk. */
  const handleMedia = (url: URL, response: ServerResponse) => {
    const path = url.searchParams.get("path") ?? "";
    if (path.length === 0 || !isInside(path, attachmentsDir)) return json(response, 403, { error: "forbidden" });
    let size: number;
    try {
      const info = statSync(path);
      if (!info.isFile()) return json(response, 404, { error: "not found" });
      size = info.size;
    } catch {
      return json(response, 404, { error: "not found" });
    }
    response.writeHead(200, { "content-type": mimeFor(path), "content-length": size, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" });
    createReadStream(path).pipe(response);
  };

  /**
   * GET /pages/<agentId>/<pageId>[?rev=<n>]: a page and one revision's text (readPage's shape),
   * which main's `wisp-canvas://` reads to serve a canvas frame, from a box on this PC or a server.
   */
  const handlePage = (url: URL, response: ServerResponse) => {
    const [, , storeId = "", id = "", ...rest] = url.pathname.split("/");
    const rev = url.searchParams.get("rev");
    const agent = /^[\w-]+$/.test(storeId) ? store.getAgent(storeId) : undefined;
    if (rest.length > 0 || agent == null || pageKindOf(id) == null || (rev != null && !/^[1-9]\d{0,8}$/.test(rev))) return json(response, 404, { error: "There’s no such page.", failureCode: "page/not-found" });
    try {
      const read = storedPage(store, agent.id, id, rev != null ? Number(rev) : undefined);
      return json(response, 200, documentView(agent.id, read.record, read.source, read.revision));
    } catch (error) {
      if (!(error instanceof PageError)) throw error;
      return json(response, 404, { error: error.message, failureCode: "page/not-found" });
    }
  };

  const readMachine = (value: unknown): LocalMachine | null => {
    if (typeof value !== "object" || value == null) return null;
    const machine = value as Record<string, unknown>;
    const text = (key: string) => (typeof machine[key] === "string" ? (machine[key] as string).slice(0, 1024) : "");
    if (text("workspaceRoot").length === 0) return null;
    return { hostname: text("hostname"), platform: text("platform"), osType: text("osType"), osRelease: text("osRelease"), workspaceRoot: text("workspaceRoot") };
  };

  const handle = async (request: IncomingMessage, response: ServerResponse, bridgeOnly: boolean) => {
    const url = new URL(request.url ?? "/", "http://box.local");
    try {
      const bridgeRoute = request.method === "POST" && (url.pathname === "/bridge/tools" || url.pathname === "/bridge/call");
      if (bridgeOnly || (bridgeRoute && options.bridgeListener === "shared")) {
        if (bridgeRoute) return await handleBridge(url.pathname, request, response);
        return json(response, 404, { error: "not found" });
      }
      if (request.method === "GET" && url.pathname === "/livez") {
        response.writeHead(204).end();
        return;
      }
      // A template's link needs no token: it serves only a version published for anyone with the link.
      if (request.method === "GET" && url.pathname.startsWith("/t/")) {
        const shareId = url.pathname.slice(3);
        const template = SHARE_ID_PATTERN.test(shareId) ? publicTemplate(store, shareId) : null;
        if (template == null) return json(response, 404, { error: "There’s no published template at this link.", failureCode: "template.not-found" });
        const body = `${JSON.stringify(template, null, 2)}\n`;
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "content-disposition": `inline; filename="${botTemplateFileName(template.name).replace(/[^\x20-\x7e]|"/g, "_")}"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(body);
        return;
      }
      if (!bearerMatches(request, tokenBytes)) return json(response, 401, { error: "unauthorized" });
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { ok: true, version: options.version, protocol: GATEWAY_PROTOCOL_VERSION, localExec: localExec?.stream != null ? "ready" : "down" });
      }
      if (request.method === "POST" && url.pathname.startsWith("/api/")) return await handleCommand(decodeURIComponent(url.pathname.slice(5)), request, response);
      if (request.method === "GET" && url.pathname === "/events") {
        openSse(response);
        eventStreams.add(response);
        request.on("close", () => eventStreams.delete(response));
        return;
      }
      if (request.method === "POST" && url.pathname === "/events/ping") {
        const nonce = (url.searchParams.get("nonce") ?? "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
        for (const stream of eventStreams) stream.write(`:echo ${nonce}\n\n`);
        response.writeHead(204).end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/attachments") return await handleUpload(url, request, response);
      if (request.method === "GET" && url.pathname === "/media") return handleMedia(url, response);
      if (request.method === "GET" && url.pathname.startsWith("/pages/")) return handlePage(url, response);
      if (request.method === "POST" && url.pathname === "/pc/register") {
        const body = (await readJson(request)) as { tools?: LocalToolDescriptor[]; label?: string; machine?: unknown; tasks?: unknown };
        const machine = readMachine(body.machine);
        if (machine != null) store.setLocalMachine(machine);
        localExec = { stream: localExec?.stream ?? null, tools: Array.isArray(body.tools) ? body.tools : [], label: String(body.label ?? "local"), machine };
        log(`local-exec registered ${localExec.tools.length} tools (${localExec.label})`);
        // Its background commands as they are now, whatever the box missed meanwhile (a daemon from before them sends none).
        if (Array.isArray(body.tasks)) asyncTasks.reconcileLocal(machine?.hostname ?? localExec.label, shellStatuses(body.tasks));
        return json(response, 200, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/pc/tasks") {
        const body = (await readJson(request)) as { tasks?: unknown };
        for (const status of shellStatuses(body.tasks)) asyncTasks.noteShell("local", status, localExec?.machine?.hostname ?? localExec?.label ?? null);
        response.writeHead(204).end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/pc/requests") {
        openSse(response);
        localExec = { tools: localExec?.tools ?? [], label: localExec?.label ?? "local", machine: localExec?.machine ?? null, stream: response };
        request.on("close", () => {
          if (localExec?.stream !== response) return;
          localExec = null;
          for (const [requestId, waiter] of pendingTools) {
            pendingTools.delete(requestId);
            waiter.resolve({ kind: "error", message: "The local tools disconnected." });
          }
          log("local-exec disconnected");
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/pc/progress") {
        const body = (await readJson(request)) as { requestId?: string; chunk?: string };
        pendingTools.get(String(body.requestId))?.onProgress(String(body.chunk ?? ""));
        response.writeHead(204).end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/pc/responses") {
        const body = (await readJson(request)) as { requestId?: string; result?: ToolResult };
        const waiter = pendingTools.get(String(body.requestId));
        pendingTools.delete(String(body.requestId));
        if (waiter != null && body.result != null) waiter.resolve(body.result);
        response.writeHead(204).end();
        return;
      }
      if (options.routes != null && (await options.routes(request, response, url))) return;
      json(response, 404, { error: "not found" });
    } catch (error) {
      if (response.headersSent) return response.end();
      if (error instanceof CommandError) return json(response, error.status, { error: error.message, ...(error.failureCode ? { failureCode: error.failureCode } : {}) });
      if (error instanceof EdgeCallFailure) return json(response, 400, { error: error.detail, failureCode: error.code });
      log(`request ${url.pathname} failed: ${error instanceof Error ? error.stack : String(error)}`);
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const listener = (request: IncomingMessage, response: ServerResponse) => void handle(request, response, false);
  const server: Server = options.tls != null ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, listener) : createHttpServer(listener);
  server.keepAliveTimeout = 65_000;
  const bridgeServer = options.bridgeListener === "loopback" ? createHttpServer((request, response) => void handle(request, response, true)) : null;

  // Keep idle SSE streams alive through any intermediary.
  const keepAlive = setInterval(() => {
    for (const stream of eventStreams) stream.write(": ping\n\n");
    localExec?.stream?.write(": ping\n\n");
  }, 15_000);

  const listen = (target: Server, port: number, host: string) =>
    new Promise<number>((resolve, reject) => {
      target.once("error", reject);
      target.listen(port, host, () => {
        target.off("error", reject);
        const address = target.address();
        resolve(typeof address === "object" && address != null ? address.port : 0);
      });
    });
  let port: number;
  try {
    // The gateway listens last, so nothing reaches it before the box is complete.
    if (bridgeServer != null) bridgePort = await listen(bridgeServer, 0, "127.0.0.1");
    port = await listen(server, options.port, options.host);
    if (bridgeServer == null) bridgePort = port;
  } catch (error) {
    clearInterval(keepAlive);
    plugins.stopChecks();
    scheduler.stop();
    asyncTasks.stop();
    harness.shutdown();
    mcp.stopAll();
    store.close();
    server.close();
    bridgeServer?.close();
    throw error;
  }
  log(`gateway listening on ${options.tls != null ? "https" : "http"}://${options.host}:${port}`);

  /** Runs the box in the user's time zone, so "weekdays at 09:00" means 09:00 where the user is. */
  const applyTimeZone = (zone: string | null | undefined) => {
    if (zone == null || zone === process.env.TZ) return;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
    } catch {
      log(`ignoring unknown time zone ${JSON.stringify(zone)}`);
      return;
    }
    process.env.TZ = zone;
    scheduler.reschedule();
    log(`time zone ${zone}`);
  };
  applyTimeZone(config?.timeZone);

  let closed = false;
  return {
    port,
    configure: (next) => {
      const cloudChanged = JSON.stringify(config?.cloud ?? null) !== JSON.stringify(next.cloud);
      config = next;
      applyTimeZone(next.timeZone);
      if (cloudChanged) broadcast("cloud-computer", cloud.status());
    },
    config: () => config,
    listModels: (provider) => listModels(config?.models ?? null, provider, resolveDeps),
    localExecReady: () => localExec?.stream != null,
    mcpSignInTarget: (serverId) => {
      const server = store.mcpServers().find((candidate) => candidate.id === serverId);
      if (server == null) throw new CommandError(404, "No such MCP server.");
      if (server.transport !== "http") throw new CommandError(400, "Only remote (HTTP) MCP servers sign in.");
      return mcp.signInTarget(server);
    },
    mcpSignInChanged: (serverId) => mcp.restart(serverId),
    checkPluginUpdates: () => plugins.checkDue(),
    close: () => {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      plugins.stopChecks();
      scheduler.stop();
      asyncTasks.stop();
      rooms.shutdown();
      harness.shutdown();
      mcp.stopAll();
      store.close();
      for (const stream of eventStreams) stream.end();
      localExec?.stream?.end();
      server.close();
      server.closeAllConnections();
      bridgeServer?.close();
      bridgeServer?.closeAllConnections();
    },
  };
}
