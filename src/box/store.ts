// Box host persistence. Layout under <dataDir>:
//   agents.json                      {schemaVersion, agents: AgentSummary[]}
//   transcripts/<agentId>.jsonl      one JSON object per line: {epoch, entry} upserts (folded by id)
//                                    or {epoch, cleared: true}: the agent's main session
//   todos/<agentId>.json             AgentTodo[]
//   sessions/<agentId>/<session>.jsonl        another session's transcript (`group:<roomId>`, later
//                                    `task:<id>`), the same way; the file is the id with ":" as "~"
//   sessions/<agentId>/<session>.todos.json   its todos
//   sessions/<agentId>/index.json    {schemaVersion, sessions: {sessionId: SessionState}}: what else a
//                                    session keeps (its Claude Code session)
//   automations.json                 {schemaVersion, automations: Automation[]}
//   skills/<agentId>/<skillId>.md    a SKILL.md: `name` and `description` front matter, then the instructions
//                                    (a .md file added by hand is picked up on the next start)
//   skills/<agentId>/index.json      {schemaVersion, skills: {skillId: SkillState}}: what the files don't hold
//   memories/<agentId>.json          {schemaVersion, memories: AgentMemory[]}: what the agent remembers, oldest first
//   templates/index.json             {schemaVersion, templates: TemplateRecord[]}: bot templates made from agents,
//                                    their versions, which one is published and who may fetch it
//   templates/<shareId>/v<N>.json    version N of a template: its content as a template file holds it
//                                    (src/shared/bot-template.ts), without the publishing fields
//   pages/<agentId>/index.json       {schemaVersion, pages: PageRecord[]}: the documents and canvases the agent
//                                    wrote (src/box/pages.ts): {id, kind, title, createdAt, updatedAt,
//                                    revisions: [{n, sha256, by: "agent" | "user", atMs}], cardId, sessionCards?:
//                                    {sessionId: cardId}}, oldest revision first; each revision's Markdown or HTML
//                                    is a file below, by its hash
//   mcp.json                         {schemaVersion, servers: McpServerConfig[], allowedTools: string[]}
//   marketplaces.json                {schemaVersion, marketplaces: MarketplaceRecord[]}: plugin marketplaces added by link
//                                    (src/box/marketplace.ts): the repository and branch or the link, the last refresh's error,
//                                    and the updates the daily check last found
//   marketplaces/<id>/index.json     what the last refresh read (MarketplaceIndex): the commit, and each plugin with its files'
//                                    commit, skills, MCP servers, options and what the box doesn't support
//   marketplaces/<id>/<snapshot>/plugins/<name>/   each plugin's files at that commit, unpacked from its repository's archive
//   plugins.json                     {schemaVersion, plugins: InstalledPlugin[]}: installed plugins, each at the commit the user
//                                    confirmed, with the values it asked for, its MCP servers' ids and whether it's turned on
//                                    (src/box/plugins.ts)
//   plugins/<marketplace>/<plugin>/<commit>/   an installed plugin's files: its skills, and its servers' ${CLAUDE_PLUGIN_ROOT}
//   plugin-data/<marketplace>/<plugin>/        its servers' ${CLAUDE_PLUGIN_DATA}, kept across updates; only uninstalling deletes it
//   engine.json                      {schemaVersion, claudeGrants: {agentId: {grantKey: "always" | "never"}}}
//   cloud.json                       {schemaVersion, sandboxId, kind, createdAt}: the cloud computer
//   local-machine.json               {schemaVersion, machine: LocalMachine}: the PC local tools last ran on
//   tasks.json                       {schemaVersion, tasks: AsyncTaskRecord[]}: agents' background commands
//                                    (async-tasks.ts), running ones and those ended in the last 7 days
//   attachments/, workspaces/        user attachments and per-agent working folders
//   attachments/visualizations/<sha256>.html   HTML fragments agents showed (show_visualization), by content
//   attachments/pages/<sha256>.md    document revisions' Markdown, by content, and canvas revisions' HTML as
//   attachments/pages/<sha256>.html  <sha256>.html; a file goes when no revision of any agent's pages names it.
//                                    Pages stay in the box, never in the agent's workspace, which may be on
//                                    the PC while the box is remote, or in E2B.
//
// Ordered replicas: each session's transcript has an epoch (new on clear or box
// restart) and a sequence that advances once per emitted event, so a reader can
// apply events whose sequence is last+1 and resync from a page otherwise. An
// entry changed later (a reaction, a vote, a card answered) is upserted again
// under its id; the newest line for an id wins when the log is read back.
// Transcript methods take a session id last; without one they mean the main session.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BotTemplate, type BotTemplateVersionInfo, readBotTemplate, SHARE_ID_PATTERN } from "../shared/bot-template";
import type { LocalMachine } from "../shared/gateway-protocol";
import { isPluginName, parsePluginId } from "../shared/marketplace";
import { type AgentMemory, type AgentSummary, type AgentTodo, type Automation, isSessionId, MAIN_SESSION, type McpServerConfig, type OrderedStamp, type Skill, type TranscriptEntry, transcriptReplicaKey } from "../shared/model";
import { type PageAuthor, type PageKind, pageKindOf } from "../shared/pages";
import { replaceFileSync } from "../shared/replace-file";
import type { AsyncTaskRecord } from "./async-tasks";
import { describeCron } from "./cron";
import type { IndexedPlugin, MarketplaceIndex, MarketplaceRecord } from "./marketplace";
import { parseSkillFile, skillFileText, skillFromMarkdown } from "./skills";

/** What a skill's SKILL.md doesn't hold. */
type SkillState = Pick<Skill, "createdAt" | "sourceRef" | "trigger" | "lastRunAt" | "nextRunAt" | "runs">;

/** A bot template as the box keeps it; each version's content is a file of its own. */
export interface TemplateRecord {
  shareId: string;
  sourceAgentId: string;
  createdAtMs: number;
  updatedAtMs: number;
  /** The version a link serves, once one is published. */
  activeVersion: number | null;
  published: boolean;
  /** "public": anyone with the link may fetch the published version (GET /t/<shareId>); "team" or null: only through the gateway. */
  visibility: "public" | "team" | null;
  versions: BotTemplateVersionInfo[];
}

/** A page as the box keeps it (src/box/pages.ts); each revision's Markdown (a canvas's HTML) is a file of its own, named by its hash. */
export interface PageRecord {
  id: string;
  kind: PageKind;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Oldest first: the last is the page as it is now. */
  revisions: Array<{ n: number; sha256: string; by: PageAuthor; atMs: number }>;
  /** The transcript entry of the page's card in the main session, as last posted (a cleared conversation no longer has it). */
  cardId?: string | null;
  /** Its cards in the agent's other sessions (a group chat member's), by session id. */
  sessionCards?: Record<string, string>;
}

/** What a session other than the main one keeps besides its transcript and todos. */
export interface SessionState {
  /** The Claude Code session it continues, and the last user message that has seen (the main session's is on the agent's row). */
  claudeCodeSession?: { id: string; lastUserSeq: number } | null;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PAGE_FILE_PATTERN = /^[0-9a-f]{64}\.(md|html)$/;
/** A revision's file in attachments/pages: Markdown for a document, HTML for a canvas. */
const pageFile = (sha256: string, kind: PageKind) => `${sha256}.${kind === "canvas" ? "html" : "md"}`;
const pageFiles = (page: PageRecord) => page.revisions.map((revision) => pageFile(revision.sha256, page.kind));
/** A plugin installed from a marketplace, at the commit the user confirmed. */
export interface InstalledPlugin {
  pluginId: string;
  marketplaceId: string;
  name: string;
  commit: string;
  /** Hash of its files, so a marketplace commit that didn't touch them isn't an update. */
  hash: string;
  installedAt: number;
  updatedAt: number;
  /** The plugin as read when it was installed: its skills, servers and options. */
  plugin: IndexedPlugin;
  /** The values it asked for, sensitive ones too (the box keeps them as it keeps app tokens in mcp.json). */
  values: Record<string, string>;
  /** Box server id of each of its MCP servers, by the server's name in the plugin. */
  serverIds: Record<string, string>;
  /** False while the user has it turned off (its servers stopped, its skills hidden); absent means on. */
  enabled?: boolean;
  /** Its name before its marketplace renamed it (`renames` in marketplace.json). */
  renamedFrom?: string;
}

/** A skill an installed plugin gives every agent: read-only, and never written to an agent's folder. */
export interface PluginSkill {
  id: string;
  pluginId: string;
  pluginName: string;
  /** `<plugin>:<skill>`, as Claude Code names a plugin's skill. */
  name: string;
  description: string;
  body: string;
  /** Its SKILL.md with the plugin's values filled in, front matter included (Copy to agent keeps it). */
  text: string;
  filePath: string;
  sourceRef: string | null;
  disableModelInvocation: boolean;
  createdAt: number;
}

interface StoredSkill {
  skill: Skill;
  /** Front matter other than name and description, kept verbatim. */
  extra: string;
  /** The file as last read or written, so a skill whose text didn't change isn't rewritten. */
  text: string;
}

interface Transcript {
  epoch: string;
  sequence: number;
  entries: TranscriptEntry[];
  byId: Map<string, number>;
  lineCount: number;
  /** Its log file. */
  file: string;
}

/**
 * A stored page's cards: the main session's `cardId`, and the others' `sessionCards`. A page saved
 * before pages had a card per session named one card and the session it was in (`cardSessionId`).
 */
function pageCardsOf(page: Partial<PageRecord> & { cardSessionId?: unknown }): Pick<PageRecord, "cardId" | "sessionCards"> {
  const sessionCards: Record<string, string> = {};
  for (const [sessionId, cardId] of Object.entries(page.sessionCards ?? {})) {
    if (sessionId !== MAIN_SESSION && isSessionId(sessionId) && typeof cardId === "string") sessionCards[sessionId] = cardId;
  }
  let cardId = typeof page.cardId === "string" ? page.cardId : null;
  if (typeof page.cardSessionId === "string" && page.cardSessionId !== MAIN_SESSION && isSessionId(page.cardSessionId) && cardId != null) {
    sessionCards[page.cardSessionId] ??= cardId;
    cardId = null;
  }
  return { cardId, ...(Object.keys(sessionCards).length > 0 ? { sessionCards } : {}) };
}

/** In-memory key of an agent's session: the agent's id for its main one. */
const sessionKey = (agentId: string, sessionId: string) => (sessionId === MAIN_SESSION ? agentId : `${agentId}\u0000${sessionId}`);
/** A session's files are named after its id, with ":" (not allowed in Windows file names) as "~" (not allowed in session ids). */
const sessionFileName = (sessionId: string) => sessionId.replace(/:/g, "~");

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeTextSync(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  replaceFileSync(temp, path);
}

function writeJsonSync(path: string, value: unknown): void {
  writeTextSync(path, JSON.stringify(value, null, 1));
}

/** A plugin's skill in an agent's list: no schedule, and nothing to save. */
function pluginSkillFor(skill: PluginSkill, agentId: string): Skill {
  return {
    id: skill.id,
    agentId,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    createdAt: skill.createdAt,
    filePath: skill.filePath,
    disableModelInvocation: skill.disableModelInvocation || null,
    sourceRef: skill.sourceRef,
    trigger: null,
    scheduleDescription: null,
    lastRunAt: null,
    nextRunAt: null,
    runs: [],
    source: "plugin",
    pluginId: skill.pluginId,
    pluginName: skill.pluginName,
  };
}

export class BoxStore {
  private agents = new Map<string, AgentSummary>();
  private transcripts = new Map<string, Transcript>();
  private automations: Automation[] = [];
  /** By agent, then by skill id. */
  private skills = new Map<string, Map<string, StoredSkill>>();
  /** By agent, oldest first; each agent's file is read on first use. */
  private memories = new Map<string, AgentMemory[]>();
  /** By share id. */
  private templates = new Map<string, TemplateRecord>();
  /** By agent, in the order they were made; read on start, since deleting a page's Markdown needs every agent's. */
  private pages = new Map<string, PageRecord[]>();
  private mcp: { servers: McpServerConfig[]; allowedTools: string[] } = { servers: [], allowedTools: [] };
  /** Standing answers to Claude Code permission prompts, per agent. */
  private claudeGrants: Record<string, Record<string, "always" | "never">> = {};
  private saveTimer: NodeJS.Timeout | null = null;
  private roster = { epoch: randomUUID(), sequence: 0 };
  /** Epoch prefix for this box boot, so a restarted box never reuses stamps. */
  private readonly bootId = randomUUID().slice(0, 8);
  /** Read on first use (undefined until then). */
  private machine: LocalMachine | null | undefined = undefined;
  /** By id (the marketplace's name). */
  private marketplaceRecords = new Map<string, MarketplaceRecord>();
  /** Each marketplace's index.json, read on first use. */
  private marketplaceIndexes = new Map<string, MarketplaceIndex | null>();
  /** By plugin id. */
  private plugins = new Map<string, InstalledPlugin>();
  /**
   * plugins.json was read at startup and every plugin in it kept, so a plugin's folder that none of
   * them names is a leftover. False when the file was missing, unreadable or had an entry that
   * didn't check out: then nothing on disk may be taken for a leftover.
   */
  readonly installedPluginsWhole: boolean;
  private pluginSkillList: PluginSkill[] = [];

  constructor(readonly dataDir: string) {
    for (const sub of ["transcripts", "todos", "attachments", "workspaces", "skills", "memories", "templates", "pages", "marketplaces", "plugins"]) mkdirSync(join(dataDir, sub), { recursive: true });
    for (const agent of readJson<{ agents?: AgentSummary[] }>(join(dataDir, "agents.json"), {}).agents ?? []) {
      this.agents.set(agent.id, { ...agent, isRunning: false, isComposingMessage: false, currentActivity: undefined, awaitingUserResponse: null, asyncTaskCount: undefined, runningSessionIds: undefined, awaitingSessionIds: undefined });
    }
    this.automations = readJson<{ automations?: Automation[] }>(join(dataDir, "automations.json"), {}).automations ?? [];
    for (const agentId of readdirSync(join(dataDir, "skills"))) this.loadSkills(agentId);
    const mcp = readJson<{ servers?: McpServerConfig[]; allowedTools?: string[] }>(join(dataDir, "mcp.json"), {});
    this.mcp = { servers: mcp.servers ?? [], allowedTools: mcp.allowedTools ?? [] };
    this.claudeGrants = readJson<{ claudeGrants?: Record<string, Record<string, "always" | "never">> }>(join(dataDir, "engine.json"), {}).claudeGrants ?? {};
    for (const record of readJson<{ templates?: TemplateRecord[] }>(join(dataDir, "templates", "index.json"), {}).templates ?? []) {
      // The id names a folder: only a plain one is kept.
      if (typeof record.shareId === "string" && SHARE_ID_PATTERN.test(record.shareId) && Array.isArray(record.versions)) this.templates.set(record.shareId, record);
    }
    for (const agentId of readdirSync(join(dataDir, "pages"))) this.loadPages(agentId);
    // Ids name folders: only plain ones are kept.
    for (const record of readJson<{ marketplaces?: MarketplaceRecord[] }>(join(dataDir, "marketplaces.json"), {}).marketplaces ?? []) {
      if (typeof record.id === "string" && isPluginName(record.id) && record.source != null) this.marketplaceRecords.set(record.id, record);
    }
    // Read apart from readJson, which can't tell a missing or unreadable file from an empty one: plugins.ts
    // deletes installed plugins' leftover files only when this list is known whole.
    let installed: { plugins?: unknown } | null = null;
    try {
      const read: unknown = JSON.parse(readFileSync(join(dataDir, "plugins.json"), "utf8"));
      installed = typeof read === "object" && read !== null && Array.isArray((read as { plugins?: unknown }).plugins) ? read : null;
    } catch {
      // missing (no plugin was ever installed) or unreadable: not known whole either way
    }
    let skipped = 0;
    for (const plugin of (installed?.plugins as InstalledPlugin[] | undefined) ?? []) {
      const id = typeof plugin?.pluginId === "string" ? parsePluginId(plugin.pluginId) : null;
      if (id != null && id.marketplace === plugin.marketplaceId && id.plugin === plugin.name && typeof plugin.commit === "string" && /^[\w:]+$/.test(plugin.commit) && plugin.plugin != null) this.plugins.set(plugin.pluginId, plugin);
      else skipped++;
    }
    this.installedPluginsWhole = installed != null && skipped === 0;
  }

  // ---- agents ----------------------------------------------------------------

  rosterAgents(): AgentSummary[] {
    return [...this.agents.values()].sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt));
  }

  getAgent(id: string): AgentSummary | undefined {
    return this.agents.get(id);
  }

  putAgent(agent: AgentSummary): AgentSummary {
    this.agents.set(agent.id, agent);
    this.scheduleSave();
    return agent;
  }

  deleteAgent(id: string): void {
    this.agents.delete(id);
    this.transcripts.delete(id);
    rmSync(join(this.dataDir, "transcripts", `${id}.jsonl`), { force: true });
    rmSync(join(this.dataDir, "todos", `${id}.json`), { force: true });
    for (const key of [...this.transcripts.keys()]) if (key.startsWith(`${id}\u0000`)) this.transcripts.delete(key);
    if (/^[\w-]+$/.test(id)) rmSync(join(this.dataDir, "sessions", id), { recursive: true, force: true });
    this.automations = this.automations.filter((automation) => automation.agentId !== id);
    this.saveAutomations();
    this.skills.delete(id);
    rmSync(join(this.dataDir, "skills", id), { recursive: true, force: true });
    this.memories.delete(id);
    rmSync(join(this.dataDir, "memories", `${id}.json`), { force: true });
    const pages = this.pages.get(id) ?? [];
    this.pages.delete(id);
    if (/^[\w-]+$/.test(id)) rmSync(join(this.dataDir, "pages", id), { recursive: true, force: true });
    this.dropPageSources(pages.flatMap(pageFiles));
    if (this.claudeGrants[id] != null) {
      delete this.claudeGrants[id];
      this.saveEngine();
    }
    this.scheduleSave();
  }

  rosterStamp(): OrderedStamp {
    this.roster.sequence++;
    return { replicaKey: "roster", epoch: this.roster.epoch, sequence: this.roster.sequence };
  }

  workspaceFor(agentId: string, root: string): string {
    const dir = join(root, agentId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private scheduleSave(): void {
    if (this.saveTimer != null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        this.flush();
      } catch (error) {
        process.stderr.write(`box-host: roster save failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }, 250);
  }

  /** Flush pending writes and stop timers (shutdown and tests). */
  close(): void {
    if (this.saveTimer != null) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.flush();
  }

  flush(): void {
    const agents = [...this.agents.values()].map((agent) => ({ ...agent, isRunning: false, isComposingMessage: false, currentActivity: undefined, runningSessionIds: undefined, awaitingSessionIds: undefined }));
    writeJsonSync(join(this.dataDir, "agents.json"), { schemaVersion: 1, agents });
  }

  // ---- transcripts -------------------------------------------------------------

  /** A session's folder; its id and the agent's name files, so only plain ones are allowed. */
  private sessionDir(agentId: string, sessionId: string): string {
    if (!/^[\w-]+$/.test(agentId) || sessionId === MAIN_SESSION || !isSessionId(sessionId)) throw new Error(`Bad session ${agentId}/${sessionId}`);
    return join(this.dataDir, "sessions", agentId);
  }

  private transcript(agentId: string, sessionId: string = MAIN_SESSION): Transcript {
    const key = sessionKey(agentId, sessionId);
    let transcript = this.transcripts.get(key);
    if (transcript != null) return transcript;
    const file = sessionId === MAIN_SESSION ? join(this.dataDir, "transcripts", `${agentId}.jsonl`) : join(this.sessionDir(agentId, sessionId), `${sessionFileName(sessionId)}.jsonl`);
    transcript = { epoch: `${this.bootId}:${randomUUID()}`, sequence: 0, entries: [], byId: new Map(), lineCount: 0, file };
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line.trim().length === 0) continue;
        let record: { entry?: TranscriptEntry; cleared?: boolean };
        try {
          record = JSON.parse(line);
        } catch {
          continue; // a torn final line from a crash
        }
        transcript.lineCount++;
        if (record.cleared === true) {
          transcript.entries = [];
          transcript.byId.clear();
        }
        if (record.entry != null) this.fold(transcript, record.entry);
      }
    }
    this.transcripts.set(key, transcript);
    return transcript;
  }

  private fold(transcript: Transcript, entry: TranscriptEntry): void {
    const index = transcript.byId.get(entry.id);
    if (index == null) {
      transcript.byId.set(entry.id, transcript.entries.length);
      transcript.entries.push(entry);
    } else {
      transcript.entries[index] = entry;
    }
  }

  entries(agentId: string, sessionId: string = MAIN_SESSION): TranscriptEntry[] {
    return this.transcript(agentId, sessionId).entries;
  }

  hasEntry(agentId: string, id: string, sessionId: string = MAIN_SESSION): boolean {
    return this.transcript(agentId, sessionId).byId.has(id);
  }

  /** The entry with this id as stored: the same object a run that is still writing it holds. */
  entry(agentId: string, id: string, sessionId: string = MAIN_SESSION): TranscriptEntry | undefined {
    const transcript = this.transcript(agentId, sessionId);
    const index = transcript.byId.get(id);
    return index == null ? undefined : transcript.entries[index];
  }

  ordered(agentId: string, sessionId: string = MAIN_SESSION): OrderedStamp {
    const transcript = this.transcript(agentId, sessionId);
    return { replicaKey: transcriptReplicaKey(agentId, sessionId), epoch: transcript.epoch, sequence: transcript.sequence };
  }

  /** Advance the session's sequence for one emitted event. */
  stamp(agentId: string, sessionId: string = MAIN_SESSION): OrderedStamp {
    this.transcript(agentId, sessionId).sequence++;
    return this.ordered(agentId, sessionId);
  }

  nextSeq(agentId: string, sessionId: string = MAIN_SESSION): number {
    const entries = this.transcript(agentId, sessionId).entries;
    return entries.length === 0 ? 1 : entries[entries.length - 1].seq + 1;
  }

  nextTurn(agentId: string, sessionId: string = MAIN_SESSION): number {
    const entries = this.transcript(agentId, sessionId).entries;
    return entries.length === 0 ? 1 : Math.max(...entries.slice(-50).map((entry) => entry.turn)) + 1;
  }

  /** Upsert in memory; `persist` also appends to the log (streaming partials skip this). */
  upsertEntry(agentId: string, entry: TranscriptEntry, persist: boolean, sessionId: string = MAIN_SESSION): void {
    const transcript = this.transcript(agentId, sessionId);
    this.fold(transcript, entry);
    if (!persist) return;
    if (sessionId !== MAIN_SESSION) mkdirSync(this.sessionDir(agentId, sessionId), { recursive: true });
    appendFileSync(transcript.file, `${JSON.stringify({ epoch: transcript.epoch, entry })}\n`);
    transcript.lineCount++;
    if (transcript.lineCount > 400 && transcript.lineCount > transcript.entries.length * 3) this.compact(transcript);
  }

  clearTranscript(agentId: string, sessionId: string = MAIN_SESSION): OrderedStamp {
    const transcript = this.transcript(agentId, sessionId);
    transcript.epoch = `${this.bootId}:${randomUUID()}`;
    transcript.sequence = 0;
    transcript.entries = [];
    transcript.byId.clear();
    if (sessionId !== MAIN_SESSION) mkdirSync(this.sessionDir(agentId, sessionId), { recursive: true });
    writeFileSync(transcript.file, `${JSON.stringify({ epoch: transcript.epoch, cleared: true })}\n`);
    transcript.lineCount = 1;
    return this.ordered(agentId, sessionId);
  }

  private compact(transcript: Transcript): void {
    const lines = [JSON.stringify({ epoch: transcript.epoch, cleared: true }), ...transcript.entries.map((entry) => JSON.stringify({ epoch: transcript.epoch, entry }))];
    writeFileSync(`${transcript.file}.tmp`, `${lines.join("\n")}\n`);
    replaceFileSync(`${transcript.file}.tmp`, transcript.file);
    transcript.lineCount = lines.length;
  }

  // ---- sessions other than the main one -----------------------------------------------------

  /** The agent's sessions other than the main one that have a transcript, by id. */
  sessionIds(agentId: string): string[] {
    if (!/^[\w-]+$/.test(agentId)) return [];
    let files: string[];
    try {
      files = readdirSync(join(this.dataDir, "sessions", agentId));
    } catch {
      return [];
    }
    return files
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.slice(0, -".jsonl".length).replace(/~/g, ":"))
      .filter((sessionId) => sessionId !== MAIN_SESSION && isSessionId(sessionId))
      .sort();
  }

  /** Deletes one of the agent's other sessions: its transcript, todos and state. */
  deleteSession(agentId: string, sessionId: string): void {
    const dir = this.sessionDir(agentId, sessionId);
    this.transcripts.delete(sessionKey(agentId, sessionId));
    rmSync(join(dir, `${sessionFileName(sessionId)}.jsonl`), { force: true });
    rmSync(join(dir, `${sessionFileName(sessionId)}.todos.json`), { force: true });
    const states = this.sessionStates(agentId);
    if (states[sessionId] != null) {
      delete states[sessionId];
      writeJsonSync(join(dir, "index.json"), { schemaVersion: 1, sessions: states });
    }
  }

  sessionState(agentId: string, sessionId: string): SessionState {
    return this.sessionStates(agentId)[sessionId] ?? {};
  }

  setSessionState(agentId: string, sessionId: string, state: SessionState): void {
    const dir = this.sessionDir(agentId, sessionId);
    mkdirSync(dir, { recursive: true });
    writeJsonSync(join(dir, "index.json"), { schemaVersion: 1, sessions: { ...this.sessionStates(agentId), [sessionId]: state } });
  }

  private sessionStates(agentId: string): Record<string, SessionState> {
    if (!/^[\w-]+$/.test(agentId)) return {};
    return readJson<{ sessions?: Record<string, SessionState> }>(join(this.dataDir, "sessions", agentId, "index.json"), {}).sessions ?? {};
  }

  // ---- visualizations ----------------------------------------------------------------

  /** Keeps a visualization's HTML under its content hash (once), in the attachment store the frame is served from. */
  saveVisualization(html: string): { sha256: string; path: string } {
    const sha256 = createHash("sha256").update(html).digest("hex");
    const dir = join(this.dataDir, "attachments", "visualizations");
    const path = join(dir, `${sha256}.html`);
    if (!existsSync(path)) {
      mkdirSync(dir, { recursive: true });
      writeTextSync(path, html);
    }
    return { sha256, path };
  }

  // ---- pages -------------------------------------------------------------------------
  // A revision's Markdown (a canvas's HTML) is kept under its hash, so revisions that say the same share a file.

  /** Most recently changed first. */
  listPages(agentId: string): PageRecord[] {
    return [...(this.pages.get(agentId) ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getPage(agentId: string, id: string): PageRecord | undefined {
    return this.pages.get(agentId)?.find((page) => page.id === id);
  }

  /** Adds the page or replaces it; files its old revisions named and no page names now go. */
  putPage(agentId: string, record: PageRecord): PageRecord {
    if (!/^[\w-]+$/.test(agentId) || pageKindOf(record.id) !== record.kind) throw new Error(`Bad page id ${agentId}/${record.id}`);
    const list = this.pages.get(agentId) ?? [];
    const index = list.findIndex((page) => page.id === record.id);
    const before = index >= 0 ? pageFiles(list[index]) : [];
    if (index < 0) list.push(record);
    else list[index] = record;
    this.pages.set(agentId, list);
    this.savePages(agentId);
    this.dropPageSources(before);
    return record;
  }

  deletePage(agentId: string, id: string): PageRecord | undefined {
    const list = this.pages.get(agentId) ?? [];
    const index = list.findIndex((page) => page.id === id);
    if (index < 0) return undefined;
    const [removed] = list.splice(index, 1);
    this.savePages(agentId);
    this.dropPageSources(pageFiles(removed));
    return removed;
  }

  /** Keeps a revision's text under its content hash (once); the hash names it in the page's revisions. */
  savePageSource(source: string, kind: PageKind = "document"): string {
    const sha256 = createHash("sha256").update(source).digest("hex");
    const path = this.pageSourcePath(pageFile(sha256, kind));
    if (!existsSync(path)) {
      mkdirSync(join(this.dataDir, "attachments", "pages"), { recursive: true });
      writeTextSync(path, source);
    }
    return sha256;
  }

  /** A revision's text, or null when its file is gone. */
  pageSource(sha256: string, kind: PageKind = "document"): string | null {
    if (!SHA256_PATTERN.test(sha256)) return null;
    try {
      return readFileSync(this.pageSourcePath(pageFile(sha256, kind)), "utf8");
    } catch {
      return null;
    }
  }

  private pageSourcePath(file: string): string {
    return join(this.dataDir, "attachments", "pages", file);
  }

  /** Deletes the files among these that no revision of any agent's pages names. */
  private dropPageSources(files: Iterable<string>): void {
    const candidates = new Set(files);
    if (candidates.size === 0) return;
    for (const list of this.pages.values()) for (const page of list) for (const file of pageFiles(page)) candidates.delete(file);
    for (const file of candidates) if (PAGE_FILE_PATTERN.test(file)) rmSync(this.pageSourcePath(file), { force: true });
  }

  private savePages(agentId: string): void {
    const dir = join(this.dataDir, "pages", agentId);
    mkdirSync(dir, { recursive: true });
    writeJsonSync(join(dir, "index.json"), { schemaVersion: 1, pages: this.pages.get(agentId) ?? [] });
  }

  /** An index edited by hand keeps the pages that still parse. */
  private loadPages(agentId: string): void {
    if (!/^[\w-]+$/.test(agentId)) return;
    const stored = readJson<{ pages?: Array<Partial<PageRecord>> }>(join(this.dataDir, "pages", agentId, "index.json"), {}).pages ?? [];
    const list: PageRecord[] = [];
    for (const page of Array.isArray(stored) ? stored : []) {
      const kind = typeof page.id === "string" ? pageKindOf(page.id) : null;
      if (kind == null || (page.kind != null && page.kind !== kind) || list.some((other) => other.id === page.id)) continue;
      const revisions = (Array.isArray(page.revisions) ? page.revisions : []).filter(
        (revision) => Number.isInteger(revision?.n) && typeof revision.sha256 === "string" && SHA256_PATTERN.test(revision.sha256) && (revision.by === "agent" || revision.by === "user"),
      );
      if (revisions.length === 0) continue;
      const atMs = revisions[revisions.length - 1].atMs ?? 0;
      list.push({
        id: page.id!,
        kind,
        title: typeof page.title === "string" && page.title.trim().length > 0 ? page.title : "Untitled",
        createdAt: page.createdAt ?? revisions[0].atMs ?? 0,
        updatedAt: page.updatedAt ?? atMs,
        revisions: revisions.map((revision) => ({ n: revision.n, sha256: revision.sha256, by: revision.by, atMs: revision.atMs ?? atMs })),
        ...pageCardsOf(page),
      });
    }
    if (list.length > 0) this.pages.set(agentId, list);
  }

  // ---- todos -------------------------------------------------------------------

  todos(agentId: string, sessionId: string = MAIN_SESSION): AgentTodo[] {
    return readJson<AgentTodo[]>(this.todosFile(agentId, sessionId), []);
  }

  setTodos(agentId: string, todos: AgentTodo[], sessionId: string = MAIN_SESSION): void {
    if (sessionId !== MAIN_SESSION) mkdirSync(this.sessionDir(agentId, sessionId), { recursive: true });
    writeJsonSync(this.todosFile(agentId, sessionId), todos);
  }

  private todosFile(agentId: string, sessionId: string): string {
    return sessionId === MAIN_SESSION ? join(this.dataDir, "todos", `${agentId}.json`) : join(this.sessionDir(agentId, sessionId), `${sessionFileName(sessionId)}.todos.json`);
  }

  // ---- automations ----------------------------------------------------------------

  listAutomations(agentId?: string): Automation[] {
    return agentId == null ? [...this.automations] : this.automations.filter((automation) => automation.agentId === agentId);
  }

  putAutomation(automation: Automation): Automation {
    const index = this.automations.findIndex((existing) => existing.id === automation.id);
    if (index < 0) this.automations.push(automation);
    else this.automations[index] = automation;
    this.saveAutomations();
    return automation;
  }

  deleteAutomation(id: string): Automation | undefined {
    const found = this.automations.find((automation) => automation.id === id);
    this.automations = this.automations.filter((automation) => automation.id !== id);
    this.saveAutomations();
    return found;
  }

  private saveAutomations(): void {
    writeJsonSync(join(this.dataDir, "automations.json"), { schemaVersion: 1, automations: this.automations });
  }

  // ---- skills --------------------------------------------------------------------------

  /**
   * Sorted by name. An agent's list ends with the skills installed plugins give every agent, so
   * one of its own wins a name both use; without an agent, only agents' own skills.
   */
  listSkills(agentId?: string): Skill[] {
    const groups = agentId == null ? [...this.skills.values()] : [this.skills.get(agentId) ?? new Map<string, StoredSkill>()];
    const own = groups.flatMap((group) => [...group.values()].map((stored) => stored.skill)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return agentId == null ? own : [...own, ...this.pluginSkillList.map((skill) => pluginSkillFor(skill, agentId))];
  }

  /**
   * The names a new or renamed skill of the agent can't take (skills.ts buildSkill): its own skills',
   * and every installed plugin's skills' (`<plugin>:<skill>`), also a plugin turned off, whose
   * commands come back with it.
   */
  skillNamesInUse(agentId: string): Array<{ id: string; name: string; pluginName?: string }> {
    const own = [...(this.skills.get(agentId)?.values() ?? [])].map(({ skill }) => ({ id: skill.id, name: skill.name }));
    const fromPlugins = this.installedPlugins().flatMap((installed) =>
      installed.plugin.skills.map((skill) => ({ id: `${installed.pluginId}/${skill.name}`, name: `${installed.name}:${skill.name}`, pluginName: installed.plugin.displayName })),
    );
    return [...own, ...fromPlugins];
  }

  getSkill(agentId: string, id: string): Skill | undefined {
    return this.skills.get(agentId)?.get(id)?.skill;
  }

  /** The skill's SKILL.md as last read or written, front matter included. */
  skillFile(agentId: string, id: string): string | undefined {
    return this.skills.get(agentId)?.get(id)?.text;
  }

  /** `extra` is front matter to keep besides name and description; by default the skill's current one. */
  putSkill(skill: Skill, extra?: string): Skill {
    if (skill.source === "plugin") throw new Error("A plugin’s skill is read-only; copy it to the agent to change it.");
    let group = this.skills.get(skill.agentId);
    if (group == null) this.skills.set(skill.agentId, (group = new Map()));
    const previous = group.get(skill.id);
    const frontMatter = extra ?? previous?.extra ?? "";
    const text = skillFileText(skill, frontMatter);
    const dir = join(this.dataDir, "skills", skill.agentId);
    mkdirSync(dir, { recursive: true });
    if (text !== previous?.text) writeTextSync(join(dir, `${skill.id}.md`), text);
    const stored: Skill = { ...skill, disableModelInvocation: parseSkillFile(text).disableModelInvocation || null };
    group.set(skill.id, { skill: stored, extra: frontMatter, text });
    this.saveSkillIndex(skill.agentId);
    return stored;
  }

  deleteSkill(agentId: string, id: string): Skill | undefined {
    const found = this.skills.get(agentId)?.get(id);
    if (found == null) return undefined;
    this.skills.get(agentId)!.delete(id);
    rmSync(join(this.dataDir, "skills", agentId, `${id}.md`), { force: true });
    this.saveSkillIndex(agentId);
    return found.skill;
  }

  private saveSkillIndex(agentId: string): void {
    const skills: Record<string, SkillState> = {};
    for (const { skill } of this.skills.get(agentId)?.values() ?? []) {
      skills[skill.id] = { createdAt: skill.createdAt, sourceRef: skill.sourceRef, trigger: skill.trigger, lastRunAt: skill.lastRunAt, nextRunAt: skill.nextRunAt, runs: skill.runs };
    }
    writeJsonSync(join(this.dataDir, "skills", agentId, "index.json"), { schemaVersion: 1, skills });
  }

  /** Every .md file in the agent's folder is a skill; its id is the file name. */
  private loadSkills(agentId: string): void {
    const dir = join(this.dataDir, "skills", agentId);
    let files: string[];
    try {
      files = readdirSync(dir).filter((name) => name.endsWith(".md"));
    } catch {
      return; // not a folder
    }
    const index = readJson<{ skills?: Record<string, Partial<SkillState>> }>(join(dir, "index.json"), {}).skills ?? {};
    const group = new Map<string, StoredSkill>();
    for (const file of files) {
      const id = file.slice(0, -3);
      let text: string;
      let modifiedAt: number;
      try {
        text = readFileSync(join(dir, file), "utf8");
        modifiedAt = statSync(join(dir, file)).mtimeMs;
      } catch {
        continue;
      }
      const parsed = parseSkillFile(text);
      // A file added by hand may lack front matter: name it like an import would, or after the file.
      const found = skillFromMarkdown(text);
      const state = index[id] ?? {};
      const trigger = state.trigger ?? null;
      group.set(id, {
        skill: {
          id,
          agentId,
          name: parsed.name ?? ("spec" in found ? found.spec.name : id),
          description: parsed.description ?? ("spec" in found ? found.spec.description : ""),
          body: parsed.body,
          createdAt: state.createdAt ?? Math.round(modifiedAt),
          filePath: `skills/${agentId}/${file}`,
          disableModelInvocation: parsed.disableModelInvocation || null,
          sourceRef: state.sourceRef ?? null,
          trigger,
          scheduleDescription: trigger == null ? null : describeCron(trigger.schedule),
          lastRunAt: state.lastRunAt ?? null,
          nextRunAt: state.nextRunAt ?? null,
          runs: state.runs ?? [],
        },
        extra: parsed.extra,
        text,
      });
    }
    if (group.size > 0) this.skills.set(agentId, group);
  }

  // ---- memory ---------------------------------------------------------------------

  /** Oldest first. */
  listMemories(agentId: string): AgentMemory[] {
    return [...this.memoryList(agentId)];
  }

  getMemory(agentId: string, id: string): AgentMemory | undefined {
    return this.memoryList(agentId).find((memory) => memory.id === id);
  }

  putMemory(memory: AgentMemory): AgentMemory {
    const list = this.memoryList(memory.agentId);
    const index = list.findIndex((existing) => existing.id === memory.id);
    if (index < 0) list.push(memory);
    else list[index] = memory;
    this.saveMemories(memory.agentId);
    return memory;
  }

  deleteMemory(agentId: string, id: string): AgentMemory | undefined {
    const list = this.memoryList(agentId);
    const index = list.findIndex((memory) => memory.id === id);
    if (index < 0) return undefined;
    const [removed] = list.splice(index, 1);
    this.saveMemories(agentId);
    return removed;
  }

  private memoryList(agentId: string): AgentMemory[] {
    let list = this.memories.get(agentId);
    if (list != null) return list;
    // The id names a file, and gateway reads can carry any id: only a plain name is looked up.
    const stored = /^[\w-]+$/.test(agentId) ? (readJson<{ memories?: Array<Partial<AgentMemory>> }>(join(this.dataDir, "memories", `${agentId}.json`), {}).memories ?? []) : [];
    // A file edited by hand keeps what parses.
    list = stored
      .filter((memory) => typeof memory.id === "string" && typeof memory.text === "string")
      .map((memory) => ({
        id: memory.id!,
        agentId,
        text: memory.text!,
        createdAt: memory.createdAt ?? 0,
        updatedAt: memory.updatedAt ?? memory.createdAt ?? 0,
        source: memory.source === "user" ? ("user" as const) : ("agent" as const),
        review: memory.review ?? null,
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
    this.memories.set(agentId, list);
    return list;
  }

  private saveMemories(agentId: string): void {
    writeJsonSync(join(this.dataDir, "memories", `${agentId}.json`), { schemaVersion: 1, memories: this.memoryList(agentId) });
  }

  // ---- bot templates -----------------------------------------------------------------
  // A template outlives its agent: a link someone was given keeps working until the template is deleted.

  /** Most recently changed first. */
  listTemplates(): TemplateRecord[] {
    return [...this.templates.values()].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  getTemplate(shareId: string): TemplateRecord | undefined {
    return this.templates.get(shareId);
  }

  /** The template made from this agent. */
  templateForAgent(agentId: string): TemplateRecord | undefined {
    return this.listTemplates().find((record) => record.sourceAgentId === agentId);
  }

  putTemplate(record: TemplateRecord): TemplateRecord {
    if (!SHARE_ID_PATTERN.test(record.shareId)) throw new Error(`Bad template id ${record.shareId}`);
    this.templates.set(record.shareId, record);
    this.saveTemplates();
    return record;
  }

  /** Writes one version's content (once: versions don't change). */
  putTemplateVersion(shareId: string, version: number, content: BotTemplate): void {
    const dir = join(this.dataDir, "templates", shareId);
    mkdirSync(dir, { recursive: true });
    writeJsonSync(join(dir, `v${version}.json`), content);
  }

  /** A version's content, checked as any template is (a file edited by hand may not be one any more). */
  templateVersion(shareId: string, version: number): BotTemplate | null {
    const record = this.templates.get(shareId);
    if (record == null || !record.versions.some((info) => info.version === version)) return null;
    const read = readBotTemplate(readJson<unknown>(join(this.dataDir, "templates", shareId, `v${version}.json`), null));
    return "template" in read ? read.template : null;
  }

  deleteTemplate(shareId: string): TemplateRecord | undefined {
    const record = this.templates.get(shareId);
    if (record == null) return undefined;
    this.templates.delete(shareId);
    rmSync(join(this.dataDir, "templates", shareId), { recursive: true, force: true });
    this.saveTemplates();
    return record;
  }

  private saveTemplates(): void {
    writeJsonSync(join(this.dataDir, "templates", "index.json"), { schemaVersion: 1, templates: [...this.templates.values()] });
  }

  // ---- plugin marketplaces ---------------------------------------------------------------

  /** By name. */
  marketplaces(): MarketplaceRecord[] {
    return [...this.marketplaceRecords.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  getMarketplace(id: string): MarketplaceRecord | undefined {
    return this.marketplaceRecords.get(id);
  }

  putMarketplace(record: MarketplaceRecord): void {
    if (!isPluginName(record.id)) throw new Error(`Bad marketplace id ${record.id}`);
    this.marketplaceRecords.set(record.id, record);
    writeJsonSync(join(this.dataDir, "marketplaces.json"), { schemaVersion: 1, marketplaces: this.marketplaces() });
  }

  /** Forgets the marketplace and deletes what its refreshes downloaded. */
  deleteMarketplace(id: string): void {
    if (!this.marketplaceRecords.delete(id)) return;
    this.marketplaceIndexes.delete(id);
    writeJsonSync(join(this.dataDir, "marketplaces.json"), { schemaVersion: 1, marketplaces: this.marketplaces() });
    rmSync(this.marketplaceDir(id), { recursive: true, force: true });
  }

  marketplaceDir(id: string): string {
    if (!isPluginName(id)) throw new Error(`Bad marketplace id ${id}`);
    return join(this.dataDir, "marketplaces", id);
  }

  marketplaceIndex(id: string): MarketplaceIndex | null {
    if (!this.marketplaceRecords.has(id)) return null;
    if (!this.marketplaceIndexes.has(id)) {
      const read = readJson<MarketplaceIndex | null>(join(this.marketplaceDir(id), "index.json"), null);
      this.marketplaceIndexes.set(id, read != null && Array.isArray(read.plugins) && typeof read.snapshot === "string" ? read : null);
    }
    return this.marketplaceIndexes.get(id) ?? null;
  }

  setMarketplaceIndex(id: string, index: MarketplaceIndex): void {
    writeJsonSync(join(this.marketplaceDir(id), "index.json"), index);
    this.marketplaceIndexes.set(id, index);
  }

  installedPlugins(): InstalledPlugin[] {
    return [...this.plugins.values()].sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  }

  getInstalledPlugin(pluginId: string): InstalledPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  putInstalledPlugin(plugin: InstalledPlugin): void {
    this.plugins.set(plugin.pluginId, plugin);
    writeJsonSync(join(this.dataDir, "plugins.json"), { schemaVersion: 1, plugins: this.installedPlugins() });
  }

  deleteInstalledPlugin(pluginId: string): void {
    if (!this.plugins.delete(pluginId)) return;
    writeJsonSync(join(this.dataDir, "plugins.json"), { schemaVersion: 1, plugins: this.installedPlugins() });
  }

  /** An installed plugin's files at a commit (the first 12 characters name the folder, keeping paths short on Windows). */
  pluginFolder(marketplaceId: string, name: string, commit: string): string {
    if (!isPluginName(marketplaceId) || !isPluginName(name)) throw new Error(`Bad plugin ${name}@${marketplaceId}`);
    return join(this.dataDir, "plugins", marketplaceId, name, commit.replace(/^sha256:/, "").replace(/[^\w]/g, "").slice(0, 12));
  }

  pluginDataFolder(marketplaceId: string, name: string): string {
    if (!isPluginName(marketplaceId) || !isPluginName(name)) throw new Error(`Bad plugin ${name}@${marketplaceId}`);
    return join(this.dataDir, "plugin-data", marketplaceId, name);
  }

  /** The skills installed plugins give every agent (src/box/plugins.ts reads them from their files). */
  setPluginSkills(skills: PluginSkill[]): void {
    this.pluginSkillList = [...skills].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  pluginSkills(): PluginSkill[] {
    return [...this.pluginSkillList];
  }

  /** A plugin's skill as one of this agent's skills. */
  pluginSkill(agentId: string, id: string): Skill | undefined {
    const found = this.pluginSkillList.find((skill) => skill.id === id);
    return found != null ? pluginSkillFor(found, agentId) : undefined;
  }

  // ---- MCP ----------------------------------------------------------------------

  mcpServers(): McpServerConfig[] {
    return [...this.mcp.servers];
  }

  /** Adds the server at the end, or replaces it where it is. */
  putMcpServer(server: McpServerConfig): void {
    const known = this.mcp.servers.some((existing) => existing.id === server.id);
    this.mcp.servers = known ? this.mcp.servers.map((existing) => (existing.id === server.id ? server : existing)) : [...this.mcp.servers, server];
    this.saveMcp();
  }

  deleteMcpServer(id: string): void {
    this.mcp.servers = this.mcp.servers.filter((server) => server.id !== id);
    this.mcp.allowedTools = this.mcp.allowedTools.filter((name) => !name.startsWith(`mcp__${id}__`));
    this.saveMcp();
  }

  isMcpToolAllowed(name: string): boolean {
    return this.mcp.allowedTools.includes(name);
  }

  allowMcpTool(name: string): void {
    if (!this.mcp.allowedTools.includes(name)) this.mcp.allowedTools.push(name);
    this.saveMcp();
  }

  private saveMcp(): void {
    writeJsonSync(join(this.dataDir, "mcp.json"), { schemaVersion: 1, ...this.mcp });
  }

  // ---- Claude Code engine --------------------------------------------------------

  claudeGrant(agentId: string, key: string): "always" | "never" | null {
    return this.claudeGrants[agentId]?.[key] ?? null;
  }

  setClaudeGrant(agentId: string, key: string, value: "always" | "never"): void {
    this.claudeGrants[agentId] = { ...this.claudeGrants[agentId], [key]: value };
    this.saveEngine();
  }

  clearClaudeGrants(agentId: string): void {
    if (this.claudeGrants[agentId] == null) return;
    delete this.claudeGrants[agentId];
    this.saveEngine();
  }

  private saveEngine(): void {
    writeJsonSync(join(this.dataDir, "engine.json"), { schemaVersion: 1, claudeGrants: this.claudeGrants });
  }

  // ---- cloud computer ---------------------------------------------------------------

  cloudState(): { sandboxId: string | null; kind: "headless" | "desktop" | null; createdAt: number | null } {
    const stored = readJson<{ sandboxId?: string | null; kind?: "headless" | "desktop" | null; createdAt?: number | null }>(join(this.dataDir, "cloud.json"), {});
    return { sandboxId: stored.sandboxId ?? null, kind: stored.kind ?? null, createdAt: stored.createdAt ?? null };
  }

  setCloudState(state: { sandboxId: string | null; kind: "headless" | "desktop" | null; createdAt: number | null }): void {
    writeJsonSync(join(this.dataDir, "cloud.json"), { schemaVersion: 1, ...state });
  }

  // ---- background tasks ----------------------------------------------------------------

  /** As last saved; a record that doesn't look like one is dropped. */
  tasks(): AsyncTaskRecord[] {
    const stored = readJson<{ tasks?: AsyncTaskRecord[] }>(join(this.dataDir, "tasks.json"), {}).tasks;
    return (Array.isArray(stored) ? stored : []).filter((record) => typeof record?.key === "string" && typeof record.agentId === "string" && typeof record.shellId === "number");
  }

  saveTasks(tasks: AsyncTaskRecord[]): void {
    writeJsonSync(join(this.dataDir, "tasks.json"), { schemaVersion: 1, tasks });
  }

  // ---- the user's computer ----------------------------------------------------------

  /** The computer the local-exec daemon last registered from, kept so prompts stay the same while it's offline. */
  localMachine(): LocalMachine | null {
    if (this.machine === undefined) this.machine = readJson<{ machine?: LocalMachine | null }>(join(this.dataDir, "local-machine.json"), {}).machine ?? null;
    return this.machine;
  }

  setLocalMachine(machine: LocalMachine): void {
    if (JSON.stringify(machine) === JSON.stringify(this.localMachine())) return;
    this.machine = machine;
    writeJsonSync(join(this.dataDir, "local-machine.json"), { schemaVersion: 1, machine });
  }
}
