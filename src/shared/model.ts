// Data model shared by every process: the agent roster, transcripts and outlines,
// background tasks, automations, skills, memory, MCP servers, model providers and voice.
import type { PageAuthor, PageEditNote, PageRef } from "./pages";
import type { CatalogPlugin, PluginSkillDescriptor } from "./marketplace";

/** Avatar silhouettes. */
export const AVATAR_SHAPES = [
  "arch", "bean", "blob", "capsule", "cloud", "clover", "crystal", "cylinder", "dome", "egg", "flower", "gem", "heart",
  "hex", "house", "leaf", "pebble", "pumpkin", "shield", "sparkle", "square", "squircle", "star", "tablet", "teardrop", "wedge",
] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];

export const AVATAR_COLORS = ["blue", "green", "orange", "pink", "purple", "red", "teal", "yellow", "gray"] as const;
export type AvatarColor = (typeof AVATAR_COLORS)[number];

export type AgentId = string;

export interface OrderedStamp {
  replicaKey: string;
  epoch: string;
  sequence: number;
}

// ---- sessions ----------------------------------------------------------------
// An agent has more than one conversation: its main one, the chat the user has with it, and one per
// group chat it's in (`group:<roomId>`), later one per task thread (`task:<taskId>[:<parent>]`).
// Memory, skills, apps, the workspace and the computer are the agent's; the run, a pending question
// or approval, todos, the Claude Code session and turn numbers are each session's.

/** The main session's id. */
export const MAIN_SESSION = "";
const SESSION_ID = /^(group|task):[\w-]{1,100}(:[\w:-]{1,200})?$/;

/** "", or `group:<roomId>` / `task:<id>` made of letters, digits, `_`, `-` and `:`. */
export function isSessionId(value: string): boolean {
  return value === MAIN_SESSION || SESSION_ID.test(value);
}

export const groupSessionId = (roomId: AgentId) => `group:${roomId}`;

/** The room a `group:<roomId>` session belongs to. */
export function roomIdOf(sessionId: string): AgentId | null {
  return sessionId.startsWith("group:") && SESSION_ID.test(sessionId) ? sessionId.slice(6) : null;
}

/** `transcript:<agentId>` for the main session, `transcript:<agentId>\0<sessionId>` for the others. */
export function transcriptReplicaKey(agentId: AgentId, sessionId: string = MAIN_SESSION): string {
  return sessionId === MAIN_SESSION ? `transcript:${agentId}` : `transcript:${agentId}\u0000${sessionId}`;
}

export function parseReplicaKey(key: string): { agentId: AgentId; sessionId: string } | null {
  if (!key.startsWith("transcript:")) return null;
  const rest = key.slice("transcript:".length);
  const split = rest.indexOf("\u0000");
  return split < 0 ? { agentId: rest, sessionId: MAIN_SESSION } : { agentId: rest.slice(0, split), sessionId: rest.slice(split + 1) };
}

// ---- roster ----------------------------------------------------------------

export interface CurrentActivity {
  /** "searching" is the provider's own web or X search ("Searching the web"). */
  kind: "thinking" | "tool" | "searching";
  /** For "searching": "web_search" or "x_search". */
  tool?: string;
  /** For "searching": the query, once the provider reports it. */
  detail?: string;
  target?: string;
  callId?: string;
}

/** An agent as the roster lists it. */
export interface AgentSummary {
  id: AgentId;
  name: string;
  description: string;
  path: string;
  title?: string;
  origin: "dev" | "user";
  isGroup: boolean;
  memberIds: AgentId[];
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  lastActivityAt?: number;
  lastViewedAt?: number;
  /** A session is running a turn: the main one, or another (`runningSessionIds`). */
  isRunning: boolean;
  /** The main session's live state; other sessions' is their own. */
  isComposingMessage: boolean;
  currentActivity?: CurrentActivity;
  awaitingUserResponse: { reason: "approval" | "question"; reasonCopy?: string; since: number; tabId: string } | null;
  /**
   * While a session other than the main one runs: every running session, the main one ("") too.
   * Missing otherwise, when `isRunning` is the main session's alone (see isSessionRunning).
   */
  runningSessionIds?: string[];
  /** Sessions other than the main one waiting for the user's approval or answer (the main one's is `awaitingUserResponse`). */
  awaitingSessionIds?: string[];
  /** On a group chat's row: the member taking its turn now. */
  activeGroupMemberId?: AgentId;
  /** On a group chat's row: the turns its latest message gave members, in order (src/box/rooms.ts). */
  groupTurns?: AgentGroupTurn[];
  lastTurnSettlement?: { clientNonce: string; outcome: "success" | "cancelled" | "error"; settledAtMs: number; errorCode?: string } | null;
  hasUnread: boolean;
  unreadCount?: number;
  newestEntryId?: string;
  lastMessageId: string | null;
  lastMessagePreview?: string;
  lastEntry: { kind: "text"; text: string } | { kind: "attachment"; count: number } | null;
  notificationsEnabled: boolean;
  notifyOnUpdatesEnabled: boolean;
  isHiddenFromSidebar?: boolean;
  avatarDataUrl: string | null;
  avatarShape?: AvatarShape;
  avatarColor?: AvatarColor;
  /** Extra system instructions for this agent. */
  instructions: string;
  /** Per-agent model override as "provider:model" (null = app default). */
  model: string | null;
  /** The Claude Code session this agent continues, and the last user message it has seen. */
  claudeCodeSession?: { id: string; lastUserSeq: number } | null;
  /** Where the agent's tools run: this PC (default) or the cloud computer. */
  computer?: "local" | "cloud";
  /** Pinned to the top of the sidebar. */
  isPinned: boolean;
  /** What the agent saves to, changes in or forgets from its memory waits for the user's Approve or Reject. */
  memoryReview?: boolean;
  /** The voice its replies are read aloud in ("provider:voice", e.g. "xai:eve"); null or missing = the provider's default. */
  voiceId?: string | null;
  /** Language for reading aloud (a BCP-47 code); missing = detected. */
  voiceLanguage?: string;
  /** Playback speed for reading aloud, 1 = normal. */
  voiceSpeed?: number;
  /** The bot template the agent was made from (addAgentFromTemplate), and its version. */
  sourceTemplate?: { shareId: string; version: number | null } | null;
  /** Background work of its still running (readAsyncTasks); the agent shows as working meanwhile. */
  asyncTaskCount?: number;
}

/** Running a turn, or with background work still running: what the app shows as working. */
export function isAgentWorking(agent: Pick<AgentSummary, "isRunning" | "asyncTaskCount">): boolean {
  return agent.isRunning || (agent.asyncTaskCount ?? 0) > 0;
}

/** How a member's turn in a group chat ended. */
export type GroupTurnOutcome = "SENT" | "PASS" | "SKIPPED" | "TIMEOUT" | "CANCELLED" | "ERROR";

/** A member's turn in a group chat. */
export interface AgentGroupTurn {
  roomId: AgentId;
  isComposingMessage: boolean;
  isRunningTurn?: boolean | null;
  currentActivity?: CurrentActivity;
  /** Whose turn it is, the bot hop it's on (0 answers the person; each @mention by a member is one more), and how it ended (missing while it waits or runs). */
  memberId: AgentId;
  hop: number;
  outcome?: GroupTurnOutcome;
}

/** The session is running a turn; for the main session, what its chat shows as working. */
export function isSessionRunning(agent: Pick<AgentSummary, "isRunning" | "runningSessionIds">, sessionId: string = MAIN_SESSION): boolean {
  return agent.runningSessionIds == null ? sessionId === MAIN_SESSION && agent.isRunning : agent.runningSessionIds.includes(sessionId);
}

// ---- transcript ---------------------------------------------------------------

/** An emoji someone put on an entry. */
export interface Reaction {
  emoji: string;
  /** Who reacted; always "user", the person using the app. */
  by: string;
  name?: string;
}

interface EntryBase {
  id: string;
  seq: number;
  timestampMs: number;
  /** Harness bookkeeping — the turn (user prompt) and model step this row belongs to. */
  turn: number;
  step: number;
  /** In the order they were added; `setReaction` adds one or takes it back. */
  reactions?: Reaction[];
}

/** The reasons a Bad vote can give, as the feedback card offers them. */
export const FEEDBACK_CATEGORIES = ["Not what I asked", "Inaccurate", "Low quality", "Too slow"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/**
 * Good or Bad on an assistant reply.
 * "improve" is a Bad vote waiting for its reasons; "voted" is settled.
 */
export interface MessageFeedback {
  sentiment: "up" | "down";
  state: "improve" | "voted";
  categories: FeedbackCategory[];
  comment?: string;
  votedAt: number;
}

/**
 * A model step's raw output (Anthropic content blocks with thinking
 * signatures and search results, OpenAI and xAI Responses items with encrypted
 * reasoning and search calls) kept so the next request can replay it verbatim.
 * Box-internal: stripped before entries leave the box.
 */
export interface ReplayState {
  provider: "anthropic" | "openai" | "xai";
  model: string;
  items: unknown[];
}

/** A page or X post that the provider's own search returned for a reply, or that the reply cites. */
export interface WebSource {
  url: string;
  title?: string;
  /** The reply cites it; otherwise the search only returned it. */
  cited: boolean;
}

export interface MessageEntry extends EntryBase {
  kind: "message";
  role: "user" | "assistant";
  content: string;
  isStreaming: boolean;
  clientNonce?: string;
  requestId?: string;
  /** The model's reasoning for this reply, shown collapsed. */
  reasoning?: string;
  reasoningMs?: number;
  /** Where a user message came from. */
  source?: "user" | "automation" | "desktop-mount";
  /** Which model wrote an assistant reply, e.g. "anthropic:claude-opus-5-5". */
  modelRef?: string;
  /** See ReplayState. */
  replay?: ReplayState;
  /** What the provider's web or X search found for this reply, cited sources first. */
  sources?: WebSource[];
  /** A user message sent as a recording; `content` is its transcript. */
  voiceMemo?: VoiceMemo;
  /** The skill a user message ran ("/name", Run now or its schedule). */
  skill?: InvokedSkill;
  /** The entry a user message replies to, and the text it quotes from it. */
  replyTo?: string;
  replyQuote?: string;
  /** Who wrote the entry `replyTo` names, when the box still had it. */
  replyRole?: "user" | "assistant";
  /** The user's Good or Bad on an assistant reply. */
  feedback?: MessageFeedback;
  /** Pages the user changed since their previous message, which this one tells the agent about. */
  pageEdits?: PageEditNote[];
  /**
   * A message the box wrote to the agent, which the chat doesn't show: how a background
   * task ended. The outline lists it as a `hidden` user item.
   */
  suppressed?: "quiet-wake";
  /** In a group chat: the member that posted an assistant message. */
  fromAgent?: MessageAuthor;
  /** In a member's group session, the room's last entry this turn's message brings it up to. */
  roomThroughSeq?: number;
}

/** Who wrote a message, when it isn't the conversation's own agent. */
export interface MessageAuthor {
  id: AgentId;
  name: string;
  kind?: "agent" | "cloud-agent" | "group" | null;
}

export interface ToolCallDetail {
  callId: string;
  args: Record<string, unknown>;
  output: string;
  error: string | null;
  /** Path of an image the tool returned (served via wisp-media://). */
  image: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface ToolCallEntry extends EntryBase {
  kind: "tool-call";
  name: string;
  status: "pending" | "done" | "failed";
  summary?: string;
  /** Full call details for the expandable tool card. */
  detail?: ToolCallDetail;
  /** Set when Claude Code ran the tool itself (its built-in tools are not ours to replay). */
  engine?: "claude-code";
}

export interface UserAttachmentEntry extends EntryBase {
  kind: "user-attachment";
  file_path: string;
  file_name?: string;
  byteSize?: number;
  clientNonce?: string;
  /** MIME type, for previews. */
  mime?: string;
}

export interface NoticeEntry extends EntryBase {
  kind: "notice";
  text: string;
  /** Notices carry a tone so failures stand out. */
  tone?: "info" | "error";
}

export type TimelineEvent =
  | { type: "automation-changed"; action: "created" | "updated" | "deleted" | "ran"; automationId: string; automationName: string }
  | { type: "name-changed"; from: string; to: string }
  /** Bots joined or left a group chat (by name). */
  | { type: "members-changed"; added: string[]; removed: string[] };

export interface EventEntry extends EntryBase {
  kind: "event";
  event: TimelineEvent;
}

export interface ChoiceOption {
  label: string;
  value?: string;
  description?: string;
  style?: "default" | "primary" | "danger" | null;
}

export interface Widget {
  prompt: string;
  options: ChoiceOption[];
  allowCustom?: boolean | null;
  multiSelect?: boolean | null;
  helpText?: string;
}

export type LocalToolAction = "list-directory" | "read-file" | "run-command" | "write-file" | "use-app";

export interface LocalToolPermissionAsk {
  action: LocalToolAction;
  description?: string;
  machineLabel?: string;
  requestId: string;
  standingGrant?: { kind: "offered"; recipient: string } | { kind: "unavailable"; reason: string } | null;
  status: "allowed" | "always" | "denied" | "expired" | "never" | "pending";
  target: string;
  title?: string;
  toolId?: string;
  /** Risk rating and reasons from the command classifier. */
  risk?: Risk;
  reasons?: string[];
}

/** An HTML fragment the agent showed (show_visualization), run in a sandboxed frame (src/shared/visualization.ts). */
export interface VisualizationMessage {
  type: "visualization";
  title: string;
  summary: string;
  documentSha256: string;
  heightPx?: number;
  /** The fragment's file in the box's attachment store, served to the frame as `wisp-visualization://doc/<path>`. */
  path: string;
}

/**
 * A page the agent wrote (create_document, write_canvas), as a card that opens it on the page stage
 * (src/shared/pages.ts). Its changes update the card in place.
 */
export interface PageMessage {
  type: "page";
  page: PageRef;
  title: string;
  /** A line or two of its text. */
  excerpt: string;
  revision: number;
  updatedBy: PageAuthor;
  updatedAt: number;
  /** The page was deleted; the card stays, as a record. */
  deleted?: boolean;
}

export type SendMessage =
  | { type: "text"; content: string }
  | { type: "widget"; widget: Widget }
  | { type: "local-tool-permission"; ask: LocalToolPermissionAsk }
  | VisualizationMessage
  | PageMessage;

export interface SendMessageEntry extends EntryBase {
  kind: "send-message";
  message: SendMessage;
  requestId?: string;
  respondedValue?: string;
  widgetDismissed?: boolean | null;
  streaming?: boolean | null;
  /** In a group chat: the member whose card this is. */
  fromAgent?: MessageAuthor;
  /**
   * In a group chat, a member's approval or question shown in the room. It's answered in the
   * member's own session, on that session's entry; the room's copy follows it.
   */
  forwarded?: { agentId: AgentId; sessionId: string; entryId: string };
}

export type TranscriptEntry = MessageEntry | ToolCallEntry | UserAttachmentEntry | NoticeEntry | EventEntry | SendMessageEntry;

export type TranscriptEvent =
  | { type: "snapshot"; activeAgentId: AgentId; entries: TranscriptEntry[]; ordered: OrderedStamp }
  | { type: "appended"; agentId: AgentId; entry: TranscriptEntry; ordered: OrderedStamp }
  | { type: "updated"; agentId: AgentId; entry: TranscriptEntry; ordered: OrderedStamp }
  | { type: "removed"; agentId: AgentId; id: string; ordered: OrderedStamp }
  | { type: "cleared"; agentId: AgentId; ordered: OrderedStamp };

export interface TranscriptPage {
  entries: TranscriptEntry[];
  nextBeforeSeq?: number;
  ordered?: OrderedStamp;
  unreadAnchor?: { kind: "at"; entryId: string; seq?: number; newerRows: number } | { kind: "none" } | null;
}

/**
 * A row of the full conversation outline: what the user sent, the model's readable thinking, the
 * reply's text, the cards the agent posted and the tools it called. Tool calls carry no arguments
 * or output; `getToolCallDetail` loads them for one call, whose item id is its entry's id. `seq` is
 * the transcript entry's, so a client puts an item it hasn't seen yet in its place (an entry's
 * items come in this order).
 */
export type ConversationOutlineItem = (
  | { id: string; kind: "thinking"; text: string; durationMs?: number }
  | { id: string; kind: "user"; text: string; hidden?: boolean | null; steer?: boolean | null; timestampMs?: number }
  | { id: string; kind: "assistant-text"; text: string }
  | { id: string; kind: "send-message"; message: SendMessage; timestampMs?: number }
  | { id: string; kind: "tool-call"; name: string; status: "done" | "failed" | "pending"; summary?: string }
) & { seq: number };

/**
 * A change to a conversation's outline, on the "outline" channel. `agentId` names the conversation, as
 * `readOutline`'s `id` does; a subagent's would be its own.
 */
export type ConversationOutlineEvent =
  | { type: "appended"; agentId: string; item: ConversationOutlineItem }
  | { type: "updated"; agentId: string; item: ConversationOutlineItem }
  | { type: "snapshot"; agentId: string; items: ConversationOutlineItem[] };

/**
 * An outline after an event. An item replaces the one with its id, or goes in its place in the
 * conversation: after the entries before it, and after its reply's thinking when it is the reply's text.
 */
export function applyOutlineEvent(items: ConversationOutlineItem[], event: ConversationOutlineEvent): ConversationOutlineItem[] {
  if (event.type === "snapshot") return event.items;
  const item = event.item;
  const at = items.findIndex((candidate) => candidate.id === item.id);
  if (at >= 0) return items.with(at, item);
  const rank = (candidate: ConversationOutlineItem) => (candidate.kind === "thinking" ? 0 : 1);
  let index = items.length;
  while (index > 0 && (items[index - 1].seq > item.seq || (items[index - 1].seq === item.seq && rank(items[index - 1]) > rank(item)))) index--;
  return items.toSpliced(index, 0, item);
}

/** A message `findInConversation` found; the snippet is the text around the match, on one line. */
export interface ConversationMatch {
  entryId: string;
  role: "assistant" | "user";
  seq: number;
  snippet: string;
  timestampMs: number;
}

/** A message `findAcrossAgents` found in any agent's conversation. */
export interface MessageMatch extends ConversationMatch {
  agentId: AgentId;
}

// ---- async tasks ------------------------------------------------------------------

/**
 * Background work an agent has running: background commands (`kind` "shell") on the user's PC or
 * the cloud computer. Only running tasks are listed.
 */
export interface AsyncTaskInfo {
  detail?: string;
  detailKind?: "wake_pending" | "reattached" | null;
  detailParams?: { subagentType?: string };
  id: string;
  kind: "cloud-agent" | "shell" | "subagent";
  /** What it runs: a command's first line. */
  label: string;
  /** "shell_command" reads "Background command {labelParams.id}". */
  labelKind?: "shell_command" | "task" | "remote_agent" | null;
  labelParams?: { id: string };
  startedAtMs: number;
  status: "running";
  subagentType?: string;
  /** The whole command, the computer it runs on and its log there. */
  command?: string;
  computer?: "local" | "cloud";
  computerLabel?: string;
  outputPath?: string;
}

/** The agent's running tasks now, on the "background-work" channel. */
export interface AsyncTasksEvent {
  parentAgentId: AgentId;
  tasks: AsyncTaskInfo[];
}

/** `readAsyncTaskOutput`'s reply, the end of a task's output so far. */
export interface AsyncTaskOutput {
  text: string;
  /** `text` is only the end of it. */
  truncated: boolean;
  outputBytes: number;
  status: "running" | "succeeded" | "failed" | "stopped" | "lost";
  exitCode: number | null;
  /** Why `text` may be out of date: the cloud computer is paused, and reading it would wake it. */
  note?: string;
}

/**
 * A background task that ended (`getEndedAsyncTasks`; `readAsyncTasks` lists only running ones). The box keeps
 * them for a week.
 */
export interface EndedAsyncTask {
  id: string;
  kind: AsyncTaskInfo["kind"];
  label: string;
  labelKind?: AsyncTaskInfo["labelKind"];
  labelParams?: { id: string };
  command: string;
  computer: "local" | "cloud";
  computerLabel: string;
  outputPath: string;
  status: Exclude<AsyncTaskOutput["status"], "running">;
  exitCode: number | null;
  startedAtMs: number;
  endedAtMs: number;
  /** Who stopped it, when it was stopped. */
  stoppedBy?: "agent" | "user" | null;
  /** Why it was lost, or how it was stopped. */
  detail?: string;
  /** The last lines of its output, as the box kept them. */
  tail?: string;
  /** Its log is still on the PC, to open; a cloud command's stays on the cloud computer. */
  logExists: boolean;
}

/** What `cancelAllAsyncTasks` stopped (task ids), and those it couldn't reach. */
export interface StopAllAsyncTasksResult {
  stopped: string[];
  failed: Array<{ id: string; error: string }>;
}

// ---- todos, automations ---------------------------------------------------------

export interface AgentTodo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  updatedAt: number;
}

export interface CronTrigger {
  type: "cron";
  schedule: string;
}

export interface AutomationRun {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: "ok" | "error" | "running";
  trigger: "schedule" | "manual";
  detail?: string;
}

export interface AutomationSpec {
  name: string;
  prompt: string;
  trigger: CronTrigger;
  isEnabled?: boolean | null;
}

/** A prompt an agent runs on a schedule, and its runs. */
export interface Automation {
  id: string;
  agentId: AgentId;
  name: string;
  prompt: string;
  isEnabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  schedule: string;
  trigger: CronTrigger;
  triggerDescription: string;
  runs: AutomationRun[];
  filePath: string;
  /** Where it came from: "from_template" for a routine a bot template brought, added switched off. */
  provenance?: "from_template" | "untrusted" | "user" | null;
}

// ---- skills ---------------------------------------------------------------------------

export interface SkillTrigger {
  isEnabled: boolean;
  schedule: string;
}

export interface SkillSpec {
  name: string;
  description: string;
  body: string;
  sourceRef?: string | null;
  trigger: SkillTrigger | null;
}

/** Named Markdown instructions an agent loads when relevant, optionally run on a schedule. */
export interface Skill {
  id: string;
  /** The agent that keeps it. */
  agentId: AgentId;
  name: string;
  description: string;
  body: string;
  createdAt: number;
  /** Its SKILL.md file in the box's store, e.g. "skills/<agentId>/<id>.md". */
  filePath: string;
  /** Set by `disable-model-invocation: true` in its front matter: only the user runs it. */
  disableModelInvocation?: boolean | null;
  /** The address it was imported from. */
  sourceRef: string | null;
  trigger: SkillTrigger | null;
  scheduleDescription: string | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  runs: AutomationRun[];
  /** "plugin": an installed plugin gives it to every agent, read-only. Absent for the agent's own. */
  source?: "workflow" | "plugin";
  /** The plugin it comes from, `<plugin>@<marketplace>`. */
  pluginId?: string | null;
  /** That plugin's name. */
  pluginName?: string;
}

export interface SkillImportEvent {
  result: { imported: Array<{ id: string; name: string }>; skipped: Array<{ reason: string; source: string }> };
  skills: Skill[];
}

/** What a message that runs a skill carries, as the skill read when it was sent. */
export interface InvokedSkill {
  id: string;
  name: string;
  body: string;
}

/** The command that runs a skill from the composer: its name in lowercase with dashes ("Morning briefing" → "morning-briefing"). */
export function skillCommand(name: string): string {
  return name
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The command with its first colon kept: "notes:summarize" for a plugin's skill, as Claude Code
 * writes it. Typed that way, it names that skill exactly; skillCommand folds the colon into a dash.
 */
export function qualifiedSkillCommand(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? skillCommand(name) : `${skillCommand(name.slice(0, colon))}:${skillCommand(name.slice(colon + 1))}`;
}

// ---- memory -----------------------------------------------------------------

/** Characters in one memory, a single short fact. */
export const MAX_MEMORY_TEXT = 500;
/** The most memories one agent keeps. */
export const MAX_MEMORIES = 100;
/** Characters of memory text one agent keeps; all of it goes in the agent's prompt. */
export const MEMORY_BUDGET = 8_000;

/** A change the agent asked for while its memory review was on, waiting for the user's Approve or Reject. */
export interface MemoryReview {
  /** "add": the memory itself is new and not in effect yet; "edit": `text` would replace its text; "forget": it would be removed. */
  action: "add" | "edit" | "forget";
  text?: string;
  requestedAt: number;
}

/**
 * Something an agent remembers across conversations: a fact about the user or their work, a
 * preference, or how they like work done.
 */
export interface AgentMemory {
  /** Short and unique within the agent; the agent names a memory by it. */
  id: string;
  agentId: AgentId;
  /** One line. */
  text: string;
  createdAt: number;
  /** When its text last changed. */
  updatedAt: number;
  /** Who wrote the text: the agent (its memory tools) or the user (the Memory tab). */
  source: "agent" | "user";
  review: MemoryReview | null;
}

/** Characters an agent's memories use of MEMORY_BUDGET: each memory's text, or a pending edit's text when that is longer. */
export function memoryUsage(memories: AgentMemory[]): number {
  return memories.reduce((total, memory) => total + Math.max(memory.text.length, memory.review?.text?.length ?? 0), 0);
}

/** What Import memory sends the agent: the user's notes, from which it saves what's worth keeping. */
export function memoryImportPrompt(notes: string): string {
  return [
    "Please add these notes to your memory. Save each lasting fact about me, my work, my preferences or how I like things done as a memory of its own. Skip anything temporary, anything already in your memory, and secrets such as passwords or keys. Then tell me briefly what you saved.",
    "",
    notes.trim(),
  ].join("\n");
}

// ---- MCP --------------------------------------------------------------------

interface McpServerConfigBase {
  id: string;
  name: string;
  enabled: boolean;
  /** The Connect Apps catalog entry the server was added from. */
  pluginId?: string;
  /** Tells one app's accounts apart ("Work", "Personal"); empty for an app's only account. */
  accountKey?: string;
  /** Tools the model is never offered. */
  disabledTools?: string[];
  /** Added to agents' prompts while this server's tools are available to them. */
  customInstructions?: string;
}

/** A server the box starts and talks to over stdin/stdout (configs saved before HTTP servers have no `transport`). */
export interface McpStdioServerConfig extends McpServerConfigBase {
  transport?: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Starts with only the basics of the box's environment, not its keys and tokens (a marketplace plugin's server). */
  basicEnv?: boolean;
}

/** A remote server reached over MCP Streamable HTTP. */
export interface McpHttpServerConfig extends McpServerConfigBase {
  transport: "http";
  url: string;
  /** Sent with every request; an Authorization header here turns OAuth sign-in off. */
  headers: Record<string, string>;
  /** An OAuth client registered for the app ahead of time; without one the app registers itself. */
  oauth?: McpOAuthClientConfig | null;
}

export interface McpOAuthClientConfig {
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  /** Loopback port the client's redirect URI was registered with; any free port otherwise. */
  callbackPort?: number;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** What an HTTP server said when it refused a request (`WWW-Authenticate: Bearer …`). */
export interface McpAuthChallenge {
  resourceMetadataUrl: string | null;
  scope: string | null;
  error: string | null;
}

/** What main needs from the box to sign in to an HTTP server. */
export interface McpSignInTarget {
  serverId: string;
  name: string;
  url: string;
  oauth: McpOAuthClientConfig | null;
  /** From the server's last refusal, when it gave one. */
  challenge: McpAuthChallenge | null;
}

/** An MCP server as the app lists it. */
export interface McpServerSummary {
  id: string;
  name: string;
  serverIdentifier: string;
  rowServerIdentifier: string;
  accountKey: string;
  customInstructions: string;
  isTeamServer: false;
  status: "connected" | "disconnected" | "error" | "initializing" | "needsAuth";
  statusDetail?: { kind: "load_error"; technicalDetail?: string } | { kind: "sign_in_needed" } | null;
  /** Every tool the server lists, switched off ones included. */
  toolCount: number;
  disabledToolCount: number;
  transport: "http" | "stdio";
  command?: string;
  url?: string;
  pluginId?: string;
  /** Enabled flag, and whether the box uses an OAuth sign-in for this server. */
  enabled: boolean;
  signedIn: boolean;
}

/**
 * The box's MCP servers. `ordered` counts the box's changes, so a reply that was overtaken by a
 * newer "apps-state" event (a server connecting while the reply was on its way) is dropped.
 */
export interface McpState {
  servers: McpServerSummary[];
  ordered?: OrderedStamp;
}

/** A tool an MCP server lists. */
export interface McpServerTool {
  name: string;
  title?: string;
  description: string;
  isReadOnly?: boolean;
  /** Switched off: agents are never offered it. */
  isDisabled: boolean;
}

/** Something the user fills in to connect an app, such as a token. */
export interface McpCatalogField {
  key: string;
  label: string;
  type: "string";
  isSecret?: boolean;
  isRequired?: boolean;
  placeholder?: string;
  hint?: string;
  /** Where to get the value, such as the service's token page. */
  hintUrl?: string;
}

/** An app in the Connect Apps gallery. */
export interface McpCatalogEntry {
  id: string;
  displayName: string;
  description: string;
  /** The category's label, and its key. */
  category: string;
  categoryKey: string;
  publisher: { name: string; displayName: string; isUserOwned: false };
  websiteUrl: string;
  /** Lower comes first: the gallery's order. */
  popularityRank: number;
  fields?: McpCatalogField[];
  /** The vendor's page about its MCP server. */
  docsUrl: string;
  /** The server's Streamable HTTP address, before any field is filled in. */
  url: string;
  /** How it connects: a browser sign-in, a token or key the user pastes, or nothing. */
  auth: "oauth" | "token" | "none";
  featured: boolean;
  /** The logo is a monogram in the brand's color. */
  monogram: string;
  color: string;
  /** Set for a plugin from a marketplace the user added (its id is `<plugin>@<marketplace>`). */
  marketplace?: { displayName: string; name: string; ownership?: "team" | "user" | null };
  pluginName?: string;
  repositoryUrl?: string;
  skills?: PluginSkillDescriptor[];
  unsupportedFieldKeys?: string[];
  /** The plugin's commit, servers, options and whether it's installed. */
  plugin?: CatalogPlugin;
}

// ---- host status, permissions, model --------------------------------------------

/** What the box host reports about itself. */
export interface HostStatus {
  capabilities?: string[];
  hostUpdateAvailable: boolean | null;
  hostVersion: string | null;
  isBusy: boolean;
  latestHostVersion: string | null;
  localExec: "ready" | "down";
  workspaceRoot: string;
}

export type Risk = "read-only" | "mutating" | "dangerous" | "unknown";
export type ToolPermission = "guarded" | "trusted" | "ask_always" | "blocked";

export interface LocalToolInfo {
  id: string;
  label: string;
  description: string;
  defaultPermission: ToolPermission;
}

// ---- model providers ------------------------------------------------------------
//
// Several providers can be connected at once. A model is named by a ModelRef
// ({provider, model}); agents store an optional override as "provider:model".

export const PROVIDER_IDS = ["xai", "openai", "anthropic", "claude-code", "custom", "mock"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
/** Providers whose API key the user pastes into Settings. */
export const KEYED_PROVIDERS = ["xai", "openai", "anthropic", "custom"] as const;
export type KeyedProvider = (typeof KEYED_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  xai: "xAI",
  openai: "OpenAI",
  anthropic: "Anthropic",
  "claude-code": "Claude Code",
  custom: "Custom endpoint",
  mock: "Offline mock",
};

/** Suggested model per provider (also what onboarding picks). */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  xai: "grok-4.7",
  openai: "gpt-6.1-sol",
  anthropic: "claude-opus-5-5",
  "claude-code": "default",
  custom: "",
  mock: "mock-1",
};

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

export type ReasoningEffort = "default" | "low" | "medium" | "high";

export interface ModelChoice {
  id: string;
  label?: string;
}

/** Sign in with ChatGPT state; tokens never leave the main process. */
export interface ChatGptStatus {
  connected: boolean;
  /** The user granted plan usage (chatgpt.tokens.use.direct). */
  planUsage: boolean;
  email: string | null;
  welcomeSeen: boolean;
  signingIn: boolean;
}

/** The locally installed Claude Code CLI, which signs in through its own flow. */
export interface ClaudeCodeStatus {
  executable: string | null;
  installed: boolean;
  version: string | null;
  signedIn: boolean;
  /** none | claude.ai | oauth_token | api_key | api_key_helper | third_party */
  authMethod: string | null;
  checkedAt: number;
}

export interface ModelSettings {
  defaultModel: ModelRef;
  reasoningEffort: ReasoningEffort;
  /** Sampling temperature; only sent to xAI and custom endpoints. */
  temperature: number | null;
  /** Let xAI, OpenAI and Anthropic models search the web themselves (Claude Code has its own WebSearch tool). */
  webSearch: boolean;
  /** With web search on, xAI's Grok models also search X. */
  xSearch: boolean;
  xai: { baseUrl: string; hasApiKey: boolean };
  openai: { auth: "api-key" | "chatgpt"; hasApiKey: boolean; chatgpt: ChatGptStatus };
  anthropic: { hasApiKey: boolean };
  custom: { baseUrl: string; hasApiKey: boolean };
  claudeCode: ClaudeCodeStatus;
  /** Where model requests are made from. With a remote box, the ChatGPT and Claude Code status are the box's. */
  boxLocation: "local" | "remote";
}

// ---- cloud computer -------------------------------------------------------------------

export interface CloudSettings {
  hasApiKey: boolean;
  kind: "headless" | "desktop";
  idleMinutes: number;
  askBeforeCommands: boolean;
}

export interface CloudComputerStatus {
  configured: boolean;
  state: "none" | "starting" | "running" | "paused" | "error";
  sandboxId: string | null;
  kind: "headless" | "desktop" | null;
  createdAt: number | null;
  error: string | null;
}

export const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}:${ref.model}`;
}

/**
 * Parses "provider:model". A value without a known provider prefix is a model
 * name under the fallback's provider (agent overrides saved before providers existed).
 */
export function parseModelRef(value: string | null | undefined, fallback: ModelRef): ModelRef {
  const raw = (value ?? "").trim();
  if (raw.length === 0) return fallback;
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const provider = raw.slice(0, colon) as ProviderId;
    if ((PROVIDER_IDS as readonly string[]).includes(provider)) return { provider, model: raw.slice(colon + 1) };
  }
  return { provider: fallback.provider, model: raw };
}

/** True when requests for this ref draw on the user's ChatGPT plan. */
export function usesChatGptPlan(ref: ModelRef, settings: Pick<ModelSettings, "openai">): boolean {
  return ref.provider === "openai" && settings.openai.auth === "chatgpt";
}

// ---- voice: dictation, voice memos, reading replies aloud ----------------------------------
//
// Speech goes through a connected provider's own speech APIs: xAI's (speech to text and text to
// speech with an API key) and OpenAI's (with an API key; a ChatGPT plan sign-in may only call
// /v1/responses, so it can neither transcribe nor speak).

export const SPEECH_PROVIDERS = ["xai", "openai"] as const;
export type SpeechProvider = (typeof SPEECH_PROVIDERS)[number];

/** The largest recording the app transcribes (OpenAI's limit per file). */
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;

/** A word of a transcript and where it is in the recording. */
export interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** `speechToText`'s reply: the text, who transcribed it and, from xAI, word timings. */
export interface VoiceTranscription {
  text: string;
  transcriptionTimeMs: number;
  provider: SpeechProvider;
  durationMs?: number;
  language?: string;
  words?: TranscriptWord[];
}

/** What a user message sent as a recording carries; the message's content is the transcript. */
export interface VoiceMemo {
  /** The recording in the box's attachment store (served via wisp-media://). */
  path: string;
  name: string;
  mime: string;
  byteSize?: number;
  durationMs: number;
  /** Who transcribed it, and the words' timings when the provider gives them. */
  provider?: SpeechProvider;
  words?: TranscriptWord[];
}

/** A voice replies can be read aloud in: `id` is "provider:voice". */
export interface VoiceOption {
  id: string;
  provider: SpeechProvider;
  voice: string;
  label: string;
}

/** What speech the box can do right now, and why not when it can't. */
export interface VoiceCapabilities {
  transcription: { provider: SpeechProvider } | null;
  /** Why nothing can transcribe, for the user. */
  transcriptionUnavailable: string | null;
  /** Who reads the agent's replies, in which voice, and the voice it gets when none is chosen. */
  speech: { provider: SpeechProvider; voiceId: string; defaultVoiceId: string } | null;
  speechUnavailable: string | null;
  /** Every voice of the connected providers that can speak. */
  voices: VoiceOption[];
}

/** One part of a reply read aloud; replies are read in parts, the first one short. */
export interface SpokenAudio {
  audioBase64: string;
  mimeType: string;
  part: number;
  parts: number;
  voiceId: string;
}

/** "xai:eve" -> {provider, voice}; null for anything else. */
export function parseVoiceId(value: string | null | undefined): { provider: SpeechProvider; voice: string } | null {
  const match = /^(xai|openai):([A-Za-z0-9_.-]{1,100})$/.exec(value?.trim() ?? "");
  return match != null ? { provider: match[1] as SpeechProvider, voice: match[2] } : null;
}
