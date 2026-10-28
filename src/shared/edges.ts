// Edge contracts between the app's processes (renderer, main, coordinator, box
// host, local-exec daemon, agent browser toolbar, desktop mount): each edge's
// methods with their argument schemas and reply types, and the events it carries.
import { z } from "zod";
import { BROWSER_TOOL_NAMES, type BrowserPlanInfo, type BrowserRunReply } from "./agent-browser";
import { type BotMarketplace, botTemplateInclude, botTemplateSchema, type BotTemplateFile, type BotTemplateView, type CreateAgentFromTemplateResult, type FetchedBotTemplate, shareIdSchema } from "./bot-template";
import { defineEdge, event, method } from "./rpc/edge";
import type { PermissionAsk } from "./gateway-protocol";
import { DOCUMENT_ID_PATTERN, type DocumentEditRight, type LibraryPage, MAX_PAGE_SOURCE, type PageChangedEvent, type PageDocument, type PageRevisionInfo } from "./pages";
import type { EffectivePlugin, MarketplaceView, McpRemoveResult, PluginSkillInfo, PluginSyncStatus, PluginUpdate, SkillCatalogEntry } from "./marketplace";
import {
  AVATAR_COLORS,
  AVATAR_SHAPES,
  KEYED_PROVIDERS,
  PROVIDER_IDS,
  type AgentMemory,
  type AgentSummary,
  type AgentTodo,
  type AsyncTaskInfo,
  type AsyncTaskOutput,
  type AsyncTasksEvent,
  type EndedAsyncTask,
  type StopAllAsyncTasksResult,
  type Automation,
  type ClaudeCodeStatus,
  type CloudComputerStatus,
  type CloudSettings,
  type ConversationMatch,
  type ConversationOutlineEvent,
  type ConversationOutlineItem,
  type HostStatus,
  type LocalToolInfo,
  type McpCatalogEntry,
  type McpState,
  type McpServerTool,
  type McpSignInTarget,
  type MessageMatch,
  type ModelChoice,
  type ModelRef,
  type ModelSettings,
  type OrderedStamp,
  type ReasoningEffort,
  type Skill,
  type SkillImportEvent,
  SPEECH_PROVIDERS,
  type SpokenAudio,
  type ToolCallDetail,
  type ToolPermission,
  type TranscriptEntry,
  type TranscriptEvent,
  type TranscriptPage,
  type VoiceCapabilities,
  type VoiceTranscription,
} from "./model";

const agentId = z.string().min(1).max(200);
/** An agent's conversation now; a subagent's has an id of its own. */
const conversationId = z.string().min(1).max(200);
const entryId = z.string().min(1).max(200);
const mcpServerId = z.string().min(1).max(200);
const mcpAccountKey = z.string().max(40);
const providerId = z.enum(PROVIDER_IDS);
const modelRef = z.object({ provider: providerId, model: z.string().max(200) });
const reasoningEffort = z.enum(["default", "low", "medium", "high"]);
const themePreference = z.enum(["system", "light", "dark"]);
const toolPermission = z.enum(["guarded", "trusted", "ask_always", "blocked"]);
const browserTool = z.enum(BROWSER_TOOL_NAMES);
/** A browser call's arguments as the model gave them; main reads each one itself. */
const browserArgs = z.record(z.string(), z.unknown()).refine((args) => JSON.stringify(args).length <= 100_000, { message: "Arguments are too large." });
const cronTrigger = z.object({ type: z.literal("cron"), schedule: z.string().min(9).max(120) });
const automationSpec = z.object({ name: z.string().min(1).max(120), prompt: z.string().min(1).max(20000), trigger: cronTrigger, isEnabled: z.boolean().nullable().optional() });
const skillSpec = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000),
  body: z.string().max(200000),
  sourceRef: z.string().max(2048).nullable().optional(),
  trigger: z.object({ isEnabled: z.boolean(), schedule: z.string().min(1).max(120) }).nullable(),
});
const skillId = z.string().min(1).max(200);
const memoryId = z.string().min(1).max(200);
const asyncTaskId = z.string().min(1).max(200);
const marketplaceName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
/** `<plugin>@<marketplace>`. */
const pluginId = z.string().max(260).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/);
/** What the user reviewed before installing or updating a plugin (its catalog entry's `plugin.approvalKey`). */
const approvalKey = z.string().regex(/^[0-9a-f]{32}$/);
const optionValues = z.record(z.string(), z.union([z.string().max(4000), z.number(), z.boolean()]));
const requestId = z.string().min(1).max(200);
const permissionResolution = z.enum(["allow-once", "always", "deny", "never"]);
/** What the local-exec daemon asks the user to approve (a local-tool-permission card's content). */
const permissionAsk = z.object({
  action: z.enum(["list-directory", "read-file", "run-command", "write-file", "use-app"]),
  target: z.string().max(20000),
  title: z.string().max(500).optional(),
  description: z.string().max(2000).optional(),
  machineLabel: z.string().max(300).optional(),
  toolId: z.string().max(200).optional(),
  risk: z.enum(["read-only", "mutating", "dangerous", "unknown"]).optional(),
  reasons: z.array(z.string().max(1000)).max(20).optional(),
  standingGrant: z
    .discriminatedUnion("kind", [z.object({ kind: z.literal("offered"), recipient: z.string().max(2000) }), z.object({ kind: z.literal("unavailable"), reason: z.string().max(200) })])
    .nullable()
    .optional(),
});
/** A document in an agent's store (src/shared/pages.ts). */
const pageLocator = z.object({ storeId: agentId, documentId: z.string().regex(DOCUMENT_ID_PATTERN) });
const pageRevision = z.number().int().min(1);
const agentProfile = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(2000),
  title: z.string().max(200).optional(),
  avatarShape: z.enum(AVATAR_SHAPES).optional(),
  avatarColor: z.enum(AVATAR_COLORS).optional(),
});

export interface ThemeState {
  preference: z.infer<typeof themePreference>;
  resolved: "light" | "dark";
}

export interface WindowState {
  isMaximized: boolean;
  isFocused: boolean;
  isFullScreen: boolean;
}

export interface NotificationPreferences {
  enabled: boolean;
  onlyWhenUnfocused: boolean;
  sound: boolean;
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  platform: NodeJS.Platform;
  userDataDir: string;
  workspaceRoot: string;
}

/** The installed app's updates (src/main/updater.ts), from the releases on GitHub. */
export interface UpdateStatus {
  /** "unsupported": a development build, which has no installer to update. "ready": downloaded, installs when the app restarts. */
  state: "unsupported" | "idle" | "checking" | "up-to-date" | "downloading" | "ready" | "error";
  currentVersion: string;
  /** The newer version being downloaded, or ready to install. */
  version: string | null;
  /** Download progress, 0-100, while downloading. */
  percent: number | null;
  error: string | null;
  /** When a check last reached the releases; null before the first. */
  checkedAt: number | null;
  /** Check every few hours and download new versions in the background. */
  automatic: boolean;
}

export interface StagedAttachment {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  path: string;
}

export interface ScreenCapture {
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: number;
}

export interface MountState {
  mountedAgentId: string | null;
}

/** Where Add Bot gets a template: a published one on the user's own box, by its share id, or an address. */
export type BotTemplateSource = { shareId: string } | { url: string };

export type DeepLink = { route: "agent"; agentId: string } | { route: "settings"; section: string } | { route: "new-agent" } | { route: "bot-template"; source: BotTemplateSource };

/** Where the box runs: in a utility process on this PC, or on the user's own always-on server. */
export interface BoxLocationState {
  location: "local" | "remote";
  remoteUrl: string;
  hasToken: boolean;
  /** The remote box as last checked; null while the box runs on this PC. */
  remote: { reachable: boolean; error: string | null; status: BoxServerStatus | null; checkedAt: number } | null;
  /** A ChatGPT sign-in is saved on this PC (it can move to the remote box). */
  chatGptOnThisPc: boolean;
}

/** Address of the box gateway as main hands it to the coordinator and the local-exec daemon. */
export interface GatewayConnectionInfo {
  baseUrl: string;
  token: string;
  /** The box runs on another machine: staged attachments must be uploaded to it. */
  remote?: boolean;
}

// ---------------------------------------------------------------------------
// renderer -> main  (window.desktop.main)

export const mainEdge = defineEdge("main", {
  methods: {
    getAppInfo: method<AppInfo>().noArgs,
    openInBrowser: method<void>().args(z.object({ url: z.string().url() })),
    openWithDefaultApp: method<void>().args(z.object({ path: z.string() })),
    showItemInFolder: method<void>().args(z.object({ path: z.string() })),

    readWindowState: method<WindowState>().noArgs,
    windowMinimize: method<void>().noArgs,
    windowToggleMaximize: method<void>().noArgs,
    windowClose: method<void>().noArgs,
    raiseWindow: method<void>().noArgs,
    setTitlebarColors: method<void>().args(z.object({ tone: z.enum(["light", "dark"]) })),
    noteOpenAgent: method<void>().args(z.object({ agentId: agentId.nullable() })),
    acceptDeepLinks: method<void>().noArgs,

    themeInfo: method<ThemeState>().noArgs,
    chooseTheme: method<ThemeState>().args(z.object({ preference: themePreference })),
    readSpellCheck: method<boolean>().noArgs,
    changeSpellCheck: method<void>().args(z.object({ enabled: z.boolean() })),
    readGpuAcceleration: method<{ enabled: boolean; pendingRelaunch: boolean }>().noArgs,
    changeGpuAcceleration: method<void>().args(z.object({ enabled: z.boolean() })),
    readNotificationSettings: method<NotificationPreferences>().noArgs,
    changeNotificationSettings: method<NotificationPreferences>().args(
      z.object({ enabled: z.boolean(), onlyWhenUnfocused: z.boolean(), sound: z.boolean() }),
    ),
    restartApp: method<void>().noArgs,
    getUpdateStatus: method<UpdateStatus>().noArgs,
    /** Asks the releases for a newer version, which then downloads in the background; resolves once the check answers. */
    checkForUpdates: method<UpdateStatus>().noArgs,
    /** Quits, installs the downloaded update and starts the app again. */
    installUpdate: method<void>().noArgs,
    changeAutomaticUpdates: method<UpdateStatus>().args(z.object({ enabled: z.boolean() })),
    readOnboardingSeen: method<boolean>().noArgs,
    changeOnboardingSeen: method<void>().args(z.object({ seen: z.boolean() })),

    getModelSettings: method<ModelSettings>().noArgs,
    updateModelSettings: method<ModelSettings>().args(
      z.object({
        defaultModel: modelRef.optional(),
        reasoningEffort: reasoningEffort.optional(),
        temperature: z.number().min(0).max(2).nullable().optional(),
        webSearch: z.boolean().optional(),
        xSearch: z.boolean().optional(),
        xaiBaseUrl: z.string().url().optional(),
        customBaseUrl: z.string().url().optional(),
        openaiAuth: z.enum(["api-key", "chatgpt"]).optional(),
        claudeCodeExecutable: z.string().max(1024).nullable().optional(),
      }),
    ),
    setProviderApiKey: method<ModelSettings>().args(z.object({ provider: z.enum(KEYED_PROVIDERS), apiKey: z.string().min(1).max(4096) })),
    clearProviderApiKey: method<ModelSettings>().args(z.object({ provider: z.enum(KEYED_PROVIDERS) })),
    listProviderModels: method<ModelChoice[]>().args(z.object({ provider: providerId })),
    /** Sign in with ChatGPT: opens the system browser and resolves once the flow finishes. */
    startChatGptSignIn: method<ModelSettings>().noArgs,
    cancelChatGptSignIn: method<void>().noArgs,
    signOutChatGpt: method<ModelSettings>().noArgs,
    markChatGptWelcomeSeen: method<void>().noArgs,
    /** Re-detects the Claude Code CLI and whether it is signed in. */
    checkClaudeCode: method<ModelSettings>().noArgs,
    /** Opens a terminal running `claude auth login` (Anthropic's own sign-in flow). */
    openClaudeCodeSignIn: method<void>().noArgs,

    getCloudSettings: method<CloudSettings>().noArgs,
    updateCloudSettings: method<CloudSettings>().args(
      z.object({ kind: z.enum(["headless", "desktop"]).optional(), idleMinutes: z.number().int().min(1).max(60).optional(), askBeforeCommands: z.boolean().optional() }),
    ),
    setCloudApiKey: method<CloudSettings>().args(z.object({ apiKey: z.string().min(1).max(4096) })),
    clearCloudApiKey: method<CloudSettings>().noArgs,
    /** Shows the cloud computer's desktop (a noVNC page) in an app window. */
    openCloudDesktop: method<void>().args(z.object({ url: z.string().url() })),

    getBoxLocation: method<BoxLocationState>().noArgs,
    /** Switches where the box runs; a remote box is checked (address and token) before anything changes. */
    setBoxLocation: method<BoxLocationState>().args(
      z.object({ location: z.enum(["local", "remote"]), url: z.string().max(2048).optional(), token: z.string().max(4096).optional() }),
    ),
    checkBoxConnection: method<BoxLocationState>().noArgs,
    /** Copies this PC's ChatGPT sign-in to the remote box, which refreshes it from then on; this PC forgets it. */
    moveChatGptSignInToBox: method<BoxLocationState>().noArgs,

    /**
     * Signs in to a remote (HTTP) MCP server: opens the system browser and resolves once the flow
     * finishes and the box has the sign-in. A remote box gets it to keep; this PC keeps no copy.
     */
    startMcpSignIn: method<void>().args(z.object({ serverId: mcpServerId })),
    cancelMcpSignIn: method<void>().args(z.object({ serverId: mcpServerId })),
    /** Revokes and forgets the server's sign-in, wherever the box keeps it. */
    signOutMcpServer: method<void>().args(z.object({ serverId: mcpServerId })),

    /** What local-exec asked for an approval card on this PC, shown instead of the box's copy; null for asks from the box itself. */
    describeToolApproval: method<PermissionAsk | null>().args(z.object({ requestId })),
    listLocalTools: method<LocalToolInfo[]>().noArgs,
    readToolPermission: method<Record<string, ToolPermission>>().noArgs,
    changeToolPermission: method<void>().args(z.object({ toolId: z.string().min(1), permission: toolPermission })),
    listLocalToolStandingGrants: method<Array<{ toolId: string; scope: string; grantedAt: number }>>().noArgs,
    forgetToolApprovals: method<void>().noArgs,

    loadUiState: method<string | null>().args(z.object({ key: z.string().min(1) })),
    loadUiStates: method<Record<string, string>>().args(z.object({ include: z.array(z.string()), exclude: z.array(z.string()) })),
    saveUiState: method<void>().args(z.object({ key: z.string().min(1), value: z.string().max(4 * 1024 * 1024) })),
    deleteUiState: method<void>().args(z.object({ key: z.string().min(1) })),
    listUiStateKeys: method<string[]>().args(z.object({ prefix: z.string() })),

    stageUploadBytes: method<StagedAttachment>().args(z.object({ filename: z.string().min(1).max(255), bytes: z.instanceof(Uint8Array) })),
    stageUploadFile: method<StagedAttachment>().args(z.object({ filename: z.string().min(1).max(255), sourcePath: z.string().min(1) })),
    dropStagedUpload: method<void>().args(z.object({ path: z.string() })),

    grabScreen: method<ScreenCapture | null>().noArgs,

    /**
     * A template for the Add Bot preview: a published one on the user's own box by its share id
     * (the box's GET /t/<shareId>), or one at an https address. Nothing is created from it.
     */
    fetchSharedTemplate: method<FetchedBotTemplate>().args(
      z
        .object({ shareId: shareIdSchema.optional(), url: z.string().url().max(2048).optional() })
        .refine((args) => (args.shareId != null) !== (args.url != null), { message: "Give a share id or an address, not both." }),
    ),
    /** A template file the user picks; null when they cancel. */
    openBotTemplateFile: method<FetchedBotTemplate | null>().noArgs,
    /** Writes a template where the user picks; the path, or null when they cancel. */
    saveBotTemplateFile: method<string | null>().args(z.object({ template: botTemplateSchema })),
    /** Writes a document's Markdown to a .md file where the user picks (Save as Markdown); the path, or null when they cancel. */
    savePageFile: method<string | null>().args(z.object({ title: z.string().max(400), source: z.string().max(MAX_PAGE_SOURCE + 1024) })),

    getMountState: method<MountState>().noArgs,
    mountAgent: method<MountState>().args(z.object({ agentId })),
    unmountAgent: method<MountState>().noArgs,

    /** The agent's browser window on this PC (src/main/agent-browser.ts). */
    getAgentBrowser: method<AgentBrowserState>().args(z.object({ agentId })),
    /** Brings the agent's browser window up, opening an empty one (to sign in to sites ahead) if it has none. */
    showAgentBrowser: method<AgentBrowserState>().args(z.object({ agentId })),
  },
  events: {
    "theme-updated": event<ThemeState>(),
    "window-state-changed": event<WindowState>(),
    "link-opened": event<DeepLink>(),
    "mount-state-changed": event<MountState>(),
    "model-settings-changed": event<ModelSettings>(),
    "cloud-settings-changed": event<CloudSettings>(),
    "box-location-changed": event<BoxLocationState>(),
    "agent-browser-changed": event<AgentBrowserState>(),
    "update-status-changed": event<UpdateStatus>(),
  },
});

// ---------------------------------------------------------------------------
// renderer -> coordinator ("gateway"); the coordinator relays these to the
// box host as POST /api/<method>.

export const sendPromptArgs = z.object({
  agentId,
  prompt: z.string().max(200000),
  clientNonce: z.string().min(1).max(100).optional(),
  attachmentPaths: z.array(z.string()).max(20).optional(),
  attachmentNames: z.array(z.string()).max(20).optional(),
  source: z.enum(["desktop", "mobile"]).optional(),
  sendSource: z.enum(["chat", "push", "shortcut", "unknown", "dictation_button"]).optional(),
  /** Marks prompts typed into the desktop-mount panel. */
  origin: z.enum(["desktop-mount"]).optional(),
  /** The one attachment is a recording sent as a voice memo, and `prompt` is its transcript. */
  voiceMemo: z
    .object({
      durationMs: z.number().int().min(0).max(24 * 3_600_000),
      provider: z.enum(SPEECH_PROVIDERS).optional(),
      words: z.array(z.object({ text: z.string().max(200), startMs: z.number().int().min(0), endMs: z.number().int().min(0) })).max(20_000).optional(),
    })
    .optional(),
  /** A reply: the entry it answers and the text it quotes from it. */
  replyToId: entryId.optional(),
  replyQuote: z.string().max(4000).optional(),
});
export type SendPromptArgs = z.infer<typeof sendPromptArgs>;

export const transcribeAudioArgs = z
  .object({
    audioBase64: z.string().max(36_000_000).optional(),
    /** A file attached in the app instead; the coordinator uploads it to a remote box first. */
    attachmentPath: z.string().min(1).max(4096).optional(),
    mimeType: z.string().min(1).max(100),
    language: z.string().max(35).optional(),
    /** The agent the recording is for; its provider transcribes when it can. */
    agentId: agentId.optional(),
    /** Delete the attached file afterwards (dictation keeps no recording). */
    discard: z.boolean().optional(),
  })
  .refine((args) => (args.audioBase64 != null) !== (args.attachmentPath != null), { message: "Send the audio inline or as an attached file, not both." });
export type TranscribeAudioArgs = z.infer<typeof transcribeAudioArgs>;

export const gatewayEdge = defineEdge("gateway", {
  methods: {
    /** Every agent, including those hidden from the sidebar (`isHiddenFromSidebar`), which the UI lists apart. */
    rosterAgents: method<AgentSummary[]>().args(z.object({})),
    addAgent: method<{ agent: AgentSummary; transcript: TranscriptEntry[] }>().args(
      agentProfile.extend({ clientNonce: z.string().max(100).optional(), origin: z.enum(["dev", "user"]).nullable().optional() }),
    ),
    editAgent: method<AgentSummary | null>().args(z.object({ id: agentId, profile: agentProfile, editedFields: z.array(z.string()).optional() })),
    /** Agent settings beyond its profile. */
    updateAgentConfig: method<AgentSummary | null>().args(
      z.object({
        id: agentId,
        instructions: z.string().max(20000).optional(),
        model: z.string().max(200).nullable().optional(),
        isPinned: z.boolean().optional(),
        computer: z.enum(["local", "cloud"]).optional(),
        memoryReview: z.boolean().optional(),
      }),
    ),
    removeAgents: method<{ transcript: TranscriptEntry[]; failedAgentIds?: string[] }>().args(z.object({ ids: z.array(agentId).min(1) })),
    copyAgent: method<{ agent: AgentSummary; transcript: TranscriptEntry[] }>().args(z.object({ id: agentId })),
    markAgentUnread: method<null>().args(z.object({ id: agentId, isUnread: z.boolean(), atMs: z.number().optional() })),
    changeAgentHidden: method<null>().args(z.object({ id: agentId, isHidden: z.boolean() })),
    changeAgentNotifications: method<null>().args(z.object({ id: agentId, isEnabled: z.boolean() })),

    followTranscript: method<TranscriptPage>().args(z.object({ id: agentId, limit: z.number().int().min(1).max(500), unreadBoundaryAt: z.number().optional() })),
    readTranscriptEnd: method<TranscriptPage>().args(z.object({ id: agentId, beforeSeq: z.number().int().optional(), limit: z.number().int().min(1).max(500) })),
    deliverMessage: method<{ accepted?: boolean | null } | null>().args(sendPromptArgs),
    stopAgentRun: method<{ hadActiveRun: boolean }>().args(z.object({ id: agentId })),
    resetConversation: method<null>().args(z.object({ id: agentId })),
    answerCard: method<{ accepted: boolean } | null>().args(z.object({ agentId, entryId, value: z.string().max(20000) })),
    closeCard: method<{ accepted: boolean }>().args(z.object({ agentId, entryId })),
    answerToolApproval: method<null>().args(z.object({ agentId, entryId, requestId: z.string().min(1), resolution: permissionResolution })),
    /** Adds the emoji to a message, or takes it back if the user already put it there; replicas get the entry as `updated`. */
    setReaction: method<null>().args(z.object({ agentId, entryId, emoji: z.string().min(1).max(64), sessionId: z.string().max(200).optional() })),
    /**
     * Good ("up") or Bad ("down") on an assistant reply; Bad then waits for "submit" with its reasons
     * (FEEDBACK_CATEGORIES) and an optional comment; "revert" takes the vote back.
     */
    rateReply: method<null>().args(
      z.object({
        agentId,
        entryId,
        action: z.enum(["up", "down", "submit", "revert"]),
        categories: z.array(z.string().max(100)).max(10).optional(),
        comment: z.string().max(4000).optional(),
        sessionId: z.string().max(200).optional(),
      }),
    ),
    /** One agent's messages that contain the query, newest first; `beforeSeq` pages back past the last match returned. */
    findInConversation: method<{ isComplete: boolean; matches: ConversationMatch[] }>().args(
      z.object({ agentId, query: z.string().min(1).max(500), beforeSeq: z.number().int().optional(), limit: z.number().int().min(1).max(200).optional() }),
    ),
    /** Messages that contain the query in every agent's conversation, hidden agents included, newest first. */
    findAcrossAgents: method<MessageMatch[]>().args(z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(200).optional() })),
    /**
     * The whole conversation as an outline ("Show full conversation"); "outline" events keep it live.
     * `id` names the conversation: an agent's (a subagent's would be its own).
     */
    readOutline: method<ConversationOutlineItem[]>().args(z.object({ id: conversationId })),
    /** A tool call's arguments and output, which outline items leave out; `entryId` is the item's id. */
    getToolCallDetail: method<ToolCallDetail | null>().args(z.object({ id: conversationId, entryId })),

    readAgentTodos: method<AgentTodo[]>().args(z.object({ id: agentId })),
    /** The agent's background work that is still running ("Async tasks"); "background-work" events keep it live. */
    readAsyncTasks: method<AsyncTaskInfo[]>().args(z.object({ id: agentId })),
    /** Stops one of them (a background command, with every process it started). */
    cancelAsyncTask: method<null>().args(z.object({ id: agentId, taskId: asyncTaskId })),
    /** The end of one's output so far. */
    readAsyncTaskOutput: method<AsyncTaskOutput>().args(z.object({ id: agentId, taskId: asyncTaskId, tailChars: z.number().int().min(100).max(200_000).optional() })),
    /** Its tasks that ended in the last week, newest first, beside `readAsyncTasks`' running ones. */
    getEndedAsyncTasks: method<EndedAsyncTask[]>().args(z.object({ id: agentId, limit: z.number().int().min(1).max(50).optional() })),
    /** Stops every one of its running tasks, each told to the agent as one Stop is (without waking it). */
    cancelAllAsyncTasks: method<StopAllAsyncTasksResult>().args(z.object({ id: agentId })),
    listAgentAutomations: method<Automation[]>().args(z.object({ id: agentId })),
    addAgentAutomation: method<Automation[]>().args(z.object({ id: agentId, spec: automationSpec })),
    editAgentAutomation: method<Automation[]>().args(z.object({ id: agentId, automationId: z.string().min(1), spec: automationSpec })),
    removeAgentAutomation: method<Automation[]>().args(z.object({ id: agentId, automationId: z.string().min(1) })),
    toggleAgentAutomation: method<Automation[]>().args(z.object({ id: agentId, automationId: z.string().min(1), isEnabled: z.boolean() })),
    runAutomationNow: method<null>().args(z.object({ id: agentId, automationId: z.string().min(1) })),

    /** Skills; imports report what they added and what they skipped. */
    listAgentSkills: method<Skill[]>().args(z.object({ id: agentId })),
    addAgentSkill: method<Skill[]>().args(z.object({ id: agentId, spec: skillSpec })),
    editAgentSkill: method<Skill[]>().args(z.object({ id: agentId, skillId, spec: skillSpec })),
    removeAgentSkill: method<Skill[]>().args(z.object({ id: agentId, skillId })),
    runAgentSkillNow: method<null>().args(z.object({ id: agentId, skillId })),
    importSkillText: method<SkillImportEvent>().args(z.object({ id: agentId, markdown: z.string().min(1).max(400000), name: z.string().max(200).optional() })),
    importSkillFromLink: method<SkillImportEvent>().args(z.object({ id: agentId, url: z.string().url().max(2048), name: z.string().max(200).optional() })),

    /** What each agent remembers across conversations. */
    getAgentMemories: method<AgentMemory[]>().args(z.object({ id: agentId })),
    createAgentMemory: method<AgentMemory[]>().args(z.object({ id: agentId, text: z.string().max(4000) })),
    updateAgentMemory: method<AgentMemory[]>().args(z.object({ id: agentId, memoryId, text: z.string().max(4000) })),
    deleteAgentMemory: method<AgentMemory[]>().args(z.object({ id: agentId, memoryId })),
    /** Approves or rejects what the agent asked to save, change or forget while its memory review was on. */
    reviewAgentMemory: method<AgentMemory[]>().args(z.object({ id: agentId, memoryId, approve: z.boolean() })),

    /**
     * Bot templates made from the box's agents.
     * `listMyTemplates` and `agentTemplate` give each template at its latest version.
     */
    listMyTemplates: method<BotTemplateView[]>().args(z.object({})),
    agentTemplate: method<BotTemplateView | null>().args(z.object({ sourceAgentId: agentId })),
    /** One version as a template file: what Save file writes. */
    readTemplateVersion: method<BotTemplateFile>().args(z.object({ shareId: shareIdSchema, version: z.number().int().min(1) })),
    /** Makes the version the one the template's link serves. */
    shareTemplate: method<BotTemplateView>().args(z.object({ shareId: shareIdSchema, version: z.number().int().min(1) })),
    /** "public" lets anyone with the link fetch the published version (GET /t/<shareId>); "team" keeps it to the gateway. */
    changeTemplateSharing: method<BotTemplateView>().args(z.object({ shareId: shareIdSchema, visibility: z.enum(["public", "team"]) })),
    removeTemplate: method<null>().args(z.object({ shareId: shareIdSchema })),
    /** Always "all": there is no admin to turn sharing off. */
    templateExportRules: method<{ exportPolicy?: "all" | "none" | "team_members" | null }>().args(z.object({})),
    /**
     * The starter gallery, as a marketplace listing (one page). The starters are bundled with the
     * box, which serves each at /t/<shareId> like a published template.
     */
    listStarterTemplates: method<BotMarketplace>().args(z.object({ category: z.string().max(100).optional(), pageSize: z.number().int().min(1).max(100).optional(), pageToken: z.string().max(200).optional() })),
    /** The agent as its template's next version, with what the user ticked. */
    createBotTemplateVersion: method<BotTemplateView>().args(z.object({ sourceAgentId: agentId, include: botTemplateInclude })),
    /**
     * A new agent from a template the user confirmed in Add Bot, and the setup recipe of what it got.
     * The template itself comes along; the name and avatar override the template's.
     */
    addAgentFromTemplate: method<CreateAgentFromTemplateResult>().args(
      z.object({ template: botTemplateSchema, name: z.string().trim().min(1).max(80).optional(), avatarShape: z.enum(AVATAR_SHAPES).optional(), avatarColor: z.enum(AVATAR_COLORS).optional() }),
    ),

    readAppsState: method<McpState>().args(z.object({})),
    addMcpServer:method<McpState>().args(z.object({ name: z.string().min(1).max(80), configJson: z.string().min(2).max(20000) })),
    dropMcpServer: method<McpState>().args(z.object({ serverId: z.string().min(1) })),
    setMcpServerEnabled: method<McpState>().args(z.object({ serverId: z.string().min(1), enabled: z.boolean() })),
    mcpServerTools: method<McpServerTool[]>().args(z.object({ serverId: z.string().min(1) })),
    /** The Connect Apps gallery: well-known remote MCP servers, by category. */
    readAppCatalog: method<McpCatalogEntry[]>().args(z.object({})),
    /**
     * Adds an app from the catalog with the values its fields asked for; `accountKey` names another
     * account of an app already added. `serverId` instead replaces that account's values
     * (a new token), and the reply says which server was added or changed. A plugin from a
     * marketplace (`entryId` `<plugin>@<marketplace>`) needs `approvalKey` from its entry: the
     * commit and servers the user reviewed; its reply's `serverId` is its first server, or "".
     */
    connectCatalogApp: method<McpState & { serverId: string }>().args(
      z.object({
        entryId: z.string().min(1).max(260),
        values: optionValues.optional(),
        accountKey: mcpAccountKey.optional(),
        serverId: mcpServerId.optional(),
        approvalKey: approvalKey.optional(),
      }),
    ),
    /** Switches one tool off (agents are never offered it) or back on. */
    switchMcpTool: method<McpServerTool[]>().args(z.object({ serverId: mcpServerId, toolName: z.string().min(1).max(200) })),
    /** Instructions added to agents' prompts while this server's tools are available to them. */
    changeAppInstructions: method<McpState>().args(z.object({ serverId: mcpServerId, instructions: z.string().max(4000) })),
    relabelMcpAccount: method<McpState>().args(z.object({ serverId: mcpServerId, accountKey: mcpAccountKey, newAccountKey: mcpAccountKey })),
    dropMcpAccount: method<McpState>().args(z.object({ serverId: mcpServerId, accountKey: mcpAccountKey })),

    /**
     * Plugin marketplaces in Claude Code's format, added by a GitHub repository or an https
     * link to a marketplace.json; readAppCatalog lists their plugins. A refresh reads the
     * marketplace again and never updates an installed plugin; with `plugin`, it reads that one
     * plugin's files (a plugin kept in a repository of its own is read when it's opened). Removing
     * a marketplace uninstalls its plugins.
     */
    readMarketplaces: method<MarketplaceView[]>().args(z.object({})),
    addMarketplace: method<MarketplaceView[]>().args(z.object({ source: z.string().trim().min(1).max(2048) })),
    refreshMarketplace: method<MarketplaceView[]>().args(z.object({ id: marketplaceName, plugin: marketplaceName.optional() })),
    removeMarketplace: method<MarketplaceView[]>().args(z.object({ id: marketplaceName })),
    /**
     * Every skill in the marketplaces' plugins whose files were read, with its SKILL.md as agents
     * would read it (characters that don't show taken out). `pluginId` keeps one plugin's.
     */
    skillCatalog: method<SkillCatalogEntry[]>().args(z.object({ pluginId: pluginId.optional() })),
    /** Reads installed plugins' skills from their files again. Each one is in every agent's skills, read-only. */
    refreshPluginSkills: method<PluginSkillInfo[]>().args(z.object({})),
    /** Installed plugins whose servers need a sign-in, and those a refresh found newer files for. */
    readPluginUpdates: method<PluginSyncStatus>().args(z.object({})),
    listInstalledPlugins: method<EffectivePlugin[]>().args(z.object({})),
    /**
     * New values for an installed plugin's options. `update` moves it to the files the last
     * refresh read; when its servers changed, it needs the `approvalKey` of what the user reviewed.
     */
    applyPluginInstall: method<McpState>().args(z.object({ pluginId, values: optionValues, update: z.boolean().optional(), approvalKey: approvalKey.optional() })),
    /**
     * What updating an installed plugin to the last refresh's files changes, for its review:
     * the version, each skill added, removed or changed with its text before and after (as agents
     * read it), whether its servers changed, and its other files.
     */
    getPluginUpdate: method<PluginUpdate>().args(z.object({ pluginId })),
    dropPlugin: method<McpRemoveResult>().args(z.object({ pluginId })),
    /** A plugin's skill as one of the agent's own, to change it. */
    copyPluginSkill: method<SkillImportEvent>().args(z.object({ id: agentId, skillId })),

    readBoxStatus: method<HostStatus>().args(z.object({ includeManagedCapabilities: z.boolean().nullable().optional() })),

    /** The shared cloud computer (an E2B sandbox). */
    getCloudComputer: method<CloudComputerStatus>().args(z.object({})),
    cloudComputerAction: method<{ status: CloudComputerStatus; viewerUrl?: string }>().args(z.object({ action: z.enum(["start", "pause", "delete", "viewer"]) })),

    /** Turns a recording into text with a connected provider: dictation, and voice memos before they're sent. */
    speechToText: method<VoiceTranscription>().args(transcribeAudioArgs),
    /** The voice an agent's replies are read aloud in ("provider:voice"; null = the default), its language and speed. */
    changeAgentVoice: method<null>().args(
      z.object({ id: agentId, voiceId: z.string().max(200).nullable().optional(), voiceLanguage: z.string().max(35).optional(), voiceSpeed: z.number().min(0.5).max(2).optional() }),
    ),
    sampleVoice: method<{ audioBase64: string; mimeType: string }>().args(z.object({ voiceId: z.string().min(1).max(200), greetingId: z.string().max(100) })),
    /** What speech the box can do now, for this agent's provider and voice, and the voices to pick from. */
    getVoiceCapabilities: method<VoiceCapabilities>().args(z.object({ agentId: agentId.optional() })),
    /** One part of an assistant reply read aloud in the agent's voice; a reply is cut into the same parts every time. */
    speakMessage: method<SpokenAudio>().args(z.object({ agentId, entryId, part: z.number().int().min(0).max(100).optional() })),

    /**
     * Documents agents write (create_document), opened on the page stage. `readPage` gives the
     * newest revision's Markdown, or an older one the page keeps. A document is read-only to
     * the user only while the agent's run is writing it.
     */
    readPage: method<PageDocument>().args(z.object({ locator: pageLocator, groupChatId: z.string().max(200).optional(), revision: pageRevision.optional() })),
    pageEditAccess: method<DocumentEditRight>().args(z.object({ locator: pageLocator })),
    /** The user's text, made on `baseRevision`: 409 "page/stale" when the page has moved on, "page/agent-writing" while the agent writes it. */
    writePage: method<PageDocument>().args(z.object({ locator: pageLocator, source: z.string().max(MAX_PAGE_SOURCE + 1024), baseRevision: pageRevision })),
    /** Every agent's pages, newest first (documents only while `includeDocuments`: there are no canvases yet). */
    libraryPages: method<LibraryPage[]>().args(z.object({ includeDocuments: z.boolean() })),
    /** One agent's documents, newest first. */
    libraryDocuments: method<LibraryPage[]>().args(z.object({ agentId })),
    /** The revisions a page keeps, newest first. */
    listPageRevisions: method<PageRevisionInfo[]>().args(z.object({ locator: pageLocator })),
    /** An older revision's text, again, as the user's newest revision. */
    restorePageRevision: method<PageDocument>().args(z.object({ locator: pageLocator, revision: pageRevision, baseRevision: pageRevision })),
    /** Deletes the page and its revisions; its card stays, marked deleted. */
    deletePage: method<null>().args(z.object({ locator: pageLocator })),
  },
  events: {
    "cloud-computer": event<CloudComputerStatus>(),
    agents: event<{ agents: AgentSummary[]; ordered: OrderedStamp }>(),
    "agent-saved": event<{ agent: AgentSummary; ordered: OrderedStamp }>(),
    "agent-deleted": event<{ ids: string[] }>(),
    transcript: event<TranscriptEvent>(),
    outline: event<ConversationOutlineEvent>(),
    todos: event<{ agentId: string; todos: AgentTodo[] }>(),
    "background-work": event<AsyncTasksEvent>(),
    automations: event<{ agentId: string; automations: Automation[] }>(),
    skills: event<{ agentId: string; skills: Skill[] }>(),
    memories: event<{ agentId: string; memories: AgentMemory[] }>(),
    "apps-state": event<McpState>(),
    /** Marketplaces or installed plugins changed (the catalog with them). */
    marketplaces: event<{ marketplaces: MarketplaceView[] }>(),
    "gateway-link": event<{ state: "connected" | "down" }>(),
    /** A page was made, changed (its title too), restored or deleted. */
    "page-changed": event<PageChangedEvent>(),
  },
});

// ---------------------------------------------------------------------------
// coordinator -> main

export const coordinatorControlEdge = defineEdge("coordinator-control", {
  methods: {
    gatewayAddress: method<GatewayConnectionInfo>().args(z.object({ path: z.enum(["gateway"]) })),
    noteAgentActivity: method<void>().args(
      z.object({ agentId, name: z.string(), kind: z.enum(["finished", "needs-approval", "question", "error"]), preview: z.string().max(400) }),
    ),
    reportRoster: method<void>().args(z.object({ running: z.number().int(), unread: z.number().int(), awaiting: z.number().int() })),
    /** The user answered an approval card in this app; local-exec checks approvals the box relays against these. */
    noteToolApproval: method<void>().args(z.object({ requestId, resolution: permissionResolution })),
  },
});

// main -> coordinator
export const coordinatorMainEdge = defineEdge("coordinator-main", {
  methods: {
    rosterAgents: method<AgentSummary[]>().noArgs,
    deliverMessage: method<{ accepted?: boolean | null } | null>().args(sendPromptArgs),
    windowFocusChanged: method<null>().args(z.object({ isFocused: z.boolean() })),
  },
});

// ---------------------------------------------------------------------------
// main -> box host

/** Model access as the box sees it: only connected providers, with their credentials. */
export interface BoxModelConfig {
  defaultModel: ModelRef;
  reasoningEffort: ReasoningEffort;
  temperature: number | null;
  xai: { baseUrl: string; apiKey: string } | null;
  openai: { baseUrl: string; auth: "api-key"; apiKey: string } | { baseUrl: string; auth: "chatgpt"; accessToken: string; expiresAt: number } | null;
  anthropic: { apiKey: string } | null;
  custom: { baseUrl: string; apiKey: string } | null;
  claudeCode: { executable: string } | null;
  /** The providers' own web search; on unless false (a box can be older or newer than the app). */
  webSearch?: boolean;
  /** xAI's X search, with web search on; on unless false. */
  xSearch?: boolean;
}

export interface BoxCloudConfig {
  apiKey: string;
  kind: "headless" | "desktop";
  idleMinutes: number;
  askBeforeCommands: boolean;
}

export interface BoxConfig {
  models: BoxModelConfig;
  workspaceRoot: string;
  cloud: BoxCloudConfig | null;
  /**
   * The user's IANA time zone, for a box on another machine (a server usually runs in UTC):
   * automations fire and messages are dated in it. The box on this PC already shares it.
   */
  timeZone?: string | null;
}

const boxModelConfig = z.object({
  defaultModel: modelRef,
  reasoningEffort,
  temperature: z.number().nullable(),
  xai: z.object({ baseUrl: z.string(), apiKey: z.string() }).nullable(),
  openai: z
    .discriminatedUnion("auth", [
      z.object({ baseUrl: z.string(), auth: z.literal("api-key"), apiKey: z.string() }),
      z.object({ baseUrl: z.string(), auth: z.literal("chatgpt"), accessToken: z.string(), expiresAt: z.number() }),
    ])
    .nullable(),
  anthropic: z.object({ apiKey: z.string() }).nullable(),
  custom: z.object({ baseUrl: z.string(), apiKey: z.string() }).nullable(),
  claudeCode: z.object({ executable: z.string() }).nullable(),
  webSearch: z.boolean().optional(),
  xSearch: z.boolean().optional(),
});

const boxConfigArgs = z.object({
  models: boxModelConfig,
  workspaceRoot: z.string(),
  cloud: z.object({ apiKey: z.string(), kind: z.enum(["headless", "desktop"]), idleMinutes: z.number().int().min(1).max(60), askBeforeCommands: z.boolean() }).nullable(),
  timeZone: z.string().max(100).nullable().optional(),
});

export const boxControlEdge = defineEdge("box-control", {
  methods: {
    configure: method<void>().args(boxConfigArgs),
    listModels: method<ModelChoice[]>().args(z.object({ provider: providerId })),
    /** What main needs to sign in to an HTTP MCP server. */
    mcpSignInTarget: method<McpSignInTarget>().args(z.object({ serverId: mcpServerId })),
    /** Main saved or removed the server's sign-in: connect it again. */
    mcpSignInChanged: method<void>().args(z.object({ serverId: mcpServerId })),
  },
});

// box host -> main
export const boxHostEdge = defineEdge("box-host", {
  methods: {
    /** A valid ChatGPT plan access token (main owns the refresh token); `force` refreshes even if the current one hasn't expired. */
    refreshChatGptToken: method<{ accessToken: string; expiresAt: number }>().args(z.object({ force: z.boolean() })),
    /** A valid access token for an HTTP MCP server main holds a sign-in for, or null; `force` refreshes (after a 401). */
    mcpAccessToken: method<{ accessToken: string; expiresAt: number } | null>().args(z.object({ serverId: mcpServerId, url: z.string().max(2048), force: z.boolean() })),
    /** The server was removed from the box: revoke and forget its sign-in. */
    forgetMcpSignIn: method<void>().args(z.object({ serverId: mcpServerId })),
  },
});

// ---------------------------------------------------------------------------
// main -> remote box server: POST /admin/<method> with the gateway token. The
// same configure/listModels as box-control, plus what a box with no main
// process next to it must handle itself.

/** Where a remote box got a provider's credentials: pushed by this app, or set on the server (env or config file). */
export type CredentialSource = "app" | "server" | null;

/** What a remote box reports about itself. Never contains a secret. */
export interface BoxServerStatus {
  version: string;
  protocol: number;
  localExec: "ready" | "down";
  /** Whether the admin endpoint accepts configuration from the app. */
  admin: boolean;
  providers: { xai: CredentialSource; openai: CredentialSource; anthropic: CredentialSource; custom: CredentialSource; cloud: CredentialSource };
  /** The ChatGPT sign-in copied to the box (it refreshes it itself) and the box's own host id. */
  chatgpt: { connected: boolean; planUsage: boolean; email: string | null; hostId: string };
  /** Claude Code as installed and signed in on the server. */
  claudeCode: ClaudeCodeStatus;
}

/** A ChatGPT sign-in completed on this PC, as copied to the box (OpenAI's credential file contents). */
const chatGptCredentials = z.object({
  clientId: z.string().min(1).max(500),
  accessToken: z.string().min(1).max(20000),
  refreshToken: z.string().min(1).max(20000),
  idToken: z.string().max(20000),
  expiresAt: z.number(),
  scopes: z.array(z.string().max(200)).max(50),
  email: z.string().max(320).nullable().optional(),
});

/** An MCP sign-in completed on this PC, as handed to the box (McpCredentials in src/shared/mcp-oauth.ts). */
const mcpCredentials = z.object({
  serverUrl: z.string().max(2048),
  resource: z.string().max(2048),
  issuer: z.string().max(2048),
  tokenEndpoint: z.string().max(2048),
  revocationEndpoint: z.string().max(2048).nullable(),
  clientId: z.string().min(1).max(2000),
  clientSecret: z.string().max(4000).nullable(),
  tokenEndpointAuthMethod: z.enum(["none", "client_secret_post", "client_secret_basic"]),
  accessToken: z.string().min(1).max(20000),
  refreshToken: z.string().max(20000).nullable(),
  expiresAt: z.number(),
  scope: z.string().max(4000).nullable(),
});

export const boxAdminEdge = defineEdge("box-admin", {
  methods: {
    status: method<BoxServerStatus>().args(z.object({})),
    configure: method<BoxServerStatus>().args(boxConfigArgs),
    listModels: method<ModelChoice[]>().args(z.object({ provider: providerId })),
    importChatGptSignIn: method<BoxServerStatus>().args(chatGptCredentials),
    signOutChatGpt: method<BoxServerStatus>().args(z.object({})),
    checkClaudeCode: method<BoxServerStatus>().args(z.object({})),
    mcpSignInTarget: method<McpSignInTarget>().args(z.object({ serverId: mcpServerId })),
    /** Keeps a sign-in completed on the PC; the box refreshes it from then on. */
    importMcpSignIn: method<BoxServerStatus>().args(z.object({ serverId: mcpServerId, credentials: mcpCredentials })),
    signOutMcpServer: method<BoxServerStatus>().args(z.object({ serverId: mcpServerId })),
  },
});

// ---------------------------------------------------------------------------
// local-exec daemon -> main (host capabilities that need Electron APIs)

export const localHostEdge = defineEdge("local-host", {
  methods: {
    gatewayAddress: method<GatewayConnectionInfo>().noArgs,
    /** An approval card is about to be shown for this request id, with this content. */
    offerToolApproval: method<void>().args(z.object({ requestId, ask: permissionAsk })),
    /** The user's answer to that card on this PC (once), or null if they gave none. */
    takeToolApproval: method<"allow-once" | "always" | "never" | null>().args(z.object({ requestId })),
    toolPermissionModes: method<Record<string, ToolPermission>>().noArgs,
    rememberGrant: method<void>().args(z.object({ toolId: z.string().min(1), scope: z.string().max(2000) })),
    listStandingGrants: method<Array<{ toolId: string; scope: string }>>().noArgs,
    grabScreen: method<{ pngBase64: string; width: number; height: number } | null>().noArgs,
    getClipboardText: method<string>().noArgs,
    putClipboardText: method<void>().args(z.object({ text: z.string().max(1024 * 1024) })),
    openInBrowser: method<void>().args(z.object({ url: z.string().url() })),
    /** What a browser call would act on, for the daemon's policy (src/local-exec/browser-tools.ts). */
    browserPlan: method<BrowserPlanInfo>().args(z.object({ agentId, tool: browserTool, args: browserArgs })),
    /**
     * Runs a browser call the daemon allowed. `expectSite` is the site it was rated for: main
     * refuses the call if the agent's page is on another site now. Waits while the user has the browser.
     */
    browserRun: method<BrowserRunReply>().args(
      z.object({ agentId, tool: browserTool, args: browserArgs, expectSite: z.string().max(2048).nullable(), callId: z.string().min(1).max(100), answer: z.string().max(20_000).nullable() }),
    ),
    /** The daemon gave up on that call (the agent was interrupted). */
    browserCancel: method<void>().args(z.object({ callId: z.string().min(1).max(100) })),
  },
  events: {
    "permissions-changed": event<Record<string, ToolPermission>>(),
  },
});

// ---------------------------------------------------------------------------
// agent browser: the toolbar page at the top of each agent's browser window -> main

export interface AgentBrowserTab {
  id: number;
  title: string;
  url: string;
  active: boolean;
}

/** An agent's browser as the app shows it (the Computer tab, and the window's own toolbar). */
export interface AgentBrowserState {
  agentId: string;
  open: boolean;
  /** Who drives: the agent, or the user, while the agent's actions wait. */
  control: "agent" | "user";
  /** What the agent asked the user to do (browser_wait_for_user), while it waits for the answer. */
  request: string | null;
  tabs: AgentBrowserTab[];
}

export interface AgentBrowserToolbarView extends AgentBrowserState {
  agentName: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /** A page's alert or confirm the user answers in the toolbar (while they have the browser). */
  dialog: { tabId: number; kind: "alert" | "confirm" | "prompt"; message: string } | null;
}

const tabId = z.number().int().min(1);

export const agentBrowserToolbarEdge = defineEdge("agent-browser-toolbar", {
  methods: {
    /** The calling toolbar's own window. */
    read: method<AgentBrowserToolbarView>().noArgs,
    takeOver: method<void>().noArgs,
    /** The user's answer to the page's dialog the toolbar shows: OK (accept) or Cancel. */
    answerDialog: method<void>().args(z.object({ tabId, accept: z.boolean() })),
    returnControl: method<void>().noArgs,
    /** Opens the agent's conversation in the main window. */
    showChat: method<void>().noArgs,
    switchBrowserTab: method<void>().args(z.object({ tabId })),
    closeBrowserTab: method<void>().args(z.object({ tabId })),
    newTab: method<void>().noArgs,
    historyBack: method<void>().noArgs,
    goForward: method<void>().noArgs,
    reload: method<void>().noArgs,
    /** The user typed an address (only while they have the browser). */
    navigate: method<void>().args(z.object({ url: z.string().min(1).max(8192) })),
  },
  events: {
    /** Every window's toolbar hears every change; each keeps its own agent's. */
    changed: event<AgentBrowserToolbarView>(),
  },
});

// ---------------------------------------------------------------------------
// desktop mount: floating bot panel and its capture overlay -> main

export interface MountAgent {
  id: string;
  name: string;
  avatarShape?: AgentSummary["avatarShape"];
  avatarColor?: AgentSummary["avatarColor"];
}

export interface MountView {
  agent: MountAgent | null;
  preview: string;
  isRunning: boolean;
  needsAttention: boolean;
  agents: MountAgent[];
  staged: StagedAttachment[];
  expanded: boolean;
}

export const desktopMountEdge = defineEdge("desktop-mount", {
  methods: {
    read: method<MountView>().noArgs,
    sendFromPanel: method<void>().args(z.object({ prompt: z.string().max(200000) })),
    beginCapture: method<void>().noArgs,
    dropStagedUpload: method<void>().args(z.object({ path: z.string() })),
    openAgentInPanel: method<void>().args(z.object({ agentId })),
    detachPanel: method<void>().noArgs,
    changeExpanded: method<void>().args(z.object({ expanded: z.boolean() })),
    dragPanel: method<void>().args(z.object({ dx: z.number(), dy: z.number() })),
    dropPanel: method<void>().noArgs,
    openMainWindow: method<void>().noArgs,
  },
  events: { changed: event<MountView>() },
});

export const captureOverlayEdge = defineEdge("desktop-mount-capture-overlay", {
  methods: {
    overlayView: method<{ width: number; height: number; scaleFactor: number }>().noArgs,
    chooseRegion: method<void>().args(z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })),
    pickScreen: method<void>().noArgs,
    cancel: method<void>().noArgs,
  },
});
