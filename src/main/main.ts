// Electron main process: the app's composition root.
import { writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, nativeTheme, protocol, screen, session, shell } from "electron";
import { BOT_TEMPLATE_EXTENSION, botTemplateFileName } from "../shared/bot-template";
import { serveEdge } from "../shared/rpc/runtime";
import { ipcServerTransport, type PortPeer } from "../shared/rpc/transports";
import { type BoxLocationState, type BoxModelConfig, boxHostEdge, coordinatorControlEdge, type DeepLink, localHostEdge, mainEdge, type ThemeState } from "../shared/edges";
import type { PermissionAsk } from "../shared/gateway-protocol";
import { pageFileName } from "../shared/pages";
import { type AgentSummary, type ChatGptStatus, type ClaudeCodeStatus, type CloudSettings, type KeyedProvider, type ModelSettings, OPENAI_BASE_URL } from "../shared/model";
import { LOCAL_PERMISSIONS } from "../local-exec/policy";
import { agentWorkspace } from "../local-exec/workspace";
import { AgentBrowsers } from "./agent-browser";
import { AttachmentStore, handleMediaProtocol, MEDIA_SCHEME } from "./attachments";
import { botTemplateLinkSource, fetchBotTemplate, fetchBoxTemplate, readBotTemplateFile, writeBotTemplateFile } from "./bot-templates";
import { ChatGptAuth } from "./chatgpt-auth";
import { detectClaudeCode, openClaudeCodeSignIn } from "./claude-code-cli";
import { ClientPersistence } from "./client-persistence";
import { DesktopMount } from "./desktop-mount";
import { McpAuth } from "./mcp-auth";
import { notifyActivity } from "./notifications";
import { ProcessHost } from "./processes";
import { normalizeBoxUrl, probeBox, type RemoteBoxAddress, RemoteBoxClient } from "./remote-box";
import { type SecretName, SecretStore } from "./secrets";
import { SettingsStore } from "./settings";
import { TrayController } from "./tray";
import { handleVisualizationProtocol, VISUALIZATION_SCHEME } from "./visualizations";
import { installWebPermissions } from "./web-permissions";
import { createMainWindow, overlayColors, resolvedDark } from "./windows";

const PROTOCOL = "wisp";
const distDir = resolve(__dirname, "..");
const assetsDir = join(distDir, "assets");

// ---- userData: --user-data-dir=<dir> or WISP_USER_DATA_DIR ----
app.setName("Wisp");
const userDataOverride = process.argv.find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length) ?? process.env.WISP_USER_DATA_DIR;
if (userDataOverride != null && userDataOverride.trim().length > 0) {
  app.setPath("userData", isAbsolute(userDataOverride) ? userDataOverride : resolve(process.cwd(), userDataOverride));
}
const userDataDir = app.getPath("userData");
const boxDataDir = join(userDataDir, "box");

// Settings are read before `ready` because hardware acceleration must be decided now.
const settings = new SettingsStore(userDataDir);
if (!settings.get().hardwareAcceleration) app.disableHardwareAcceleration();
// Electron takes every privileged scheme in one call, before `app.ready`.
protocol.registerSchemesAsPrivileged([MEDIA_SCHEME, VISUALIZATION_SCHEME]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

async function main(): Promise<void> {
  let mainWindow: BrowserWindow | null = null;
  let quitting = false;
  let windowFocused = false;
  let viewingAgentId: string | null = null;
  let deepLinksReady = false;
  const deepLinkQueue: DeepLink[] = [];
  const hardwareAccelerationAtLaunch = settings.get().hardwareAcceleration;

  const parseDeepLink = (raw: string): DeepLink | null => {
    try {
      const url = new URL(raw);
      if (url.protocol !== `${PROTOCOL}:`) return null;
      const parts = `${url.hostname}${url.pathname}`.split("/").filter(Boolean);
      if (parts[0] === "agent" && parts[1] != null) return { route: "agent", agentId: decodeURIComponent(parts[1]) };
      if (parts[0] === "settings") return { route: "settings", section: parts[1] ?? "general" };
      if (parts[0] === "new-agent") return { route: "new-agent" };
      if (parts[0] === "bot-template" && parts.length === 1) {
        const source = botTemplateLinkSource(url);
        return source != null ? { route: "bot-template", source } : null;
      }
    } catch {
      // not a URL
    }
    return null;
  };

  let emitMain: ReturnType<typeof serveEdge<typeof mainEdge>> | null = null;
  const deliverDeepLink = (link: DeepLink) => {
    if (!deepLinksReady || emitMain == null) {
      if (deepLinkQueue.length < 16) deepLinkQueue.push(link);
      return;
    }
    emitMain("link-opened", link);
  };
  const handleArgv = (argv: string[]) => {
    for (const arg of argv) {
      const link = parseDeepLink(arg);
      if (link != null) deliverDeepLink(link);
    }
  };

  if (process.defaultApp) {
    if (process.argv.length >= 2) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  const showMainWindow = (agentId?: string) => {
    if (mainWindow == null || mainWindow.isDestroyed()) mainWindow = openMainWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (agentId != null) deliverDeepLink({ route: "agent", agentId });
  };

  app.on("second-instance", (_event, argv) => {
    showMainWindow();
    handleArgv(argv);
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    const link = parseDeepLink(url);
    if (link != null) deliverDeepLink(link);
  });

  await app.whenReady();

  const secrets = new SecretStore(userDataDir);
  const persistence = new ClientPersistence(userDataDir);
  const attachments = new AttachmentStore(boxDataDir);

  // ---- where the box runs: this PC, or the user's own box server --------------------------
  /** The configured box server, or null for the box on this PC (also when its token can't be read). */
  const remoteAddress = (): RemoteBoxAddress | null => {
    const prefs = settings.get().box;
    const token = prefs.location === "remote" && prefs.remoteUrl.length > 0 ? secrets.get("box-remote-token") : null;
    return token != null ? { baseUrl: prefs.remoteUrl, token } : null;
  };
  let remoteBox: RemoteBoxClient | null = null;
  handleMediaProtocol(attachments, () => remoteBox?.address ?? null);
  handleVisualizationProtocol(attachments, () => remoteBox?.address ?? null);
  session.defaultSession.setSpellCheckerEnabled(settings.get().spellCheck);
  nativeTheme.themeSource = settings.get().theme;

  const workspaceRoot = join(boxDataDir, "workspaces");

  // ---- the agent browser: a window per agent in a saved profile of its own --------------------
  const agentBrowsers = new AgentBrowsers({
    distDir,
    ipcMain,
    workspaceFor: (agentId) => agentWorkspace(workspaceRoot, agentId),
    agentName: (agentId) => rosterCache.find((agent) => agent.id === agentId)?.name ?? "Agent",
    showChat: (agentId) => showMainWindow(agentId),
    onChange: (state) => emitMain?.("agent-browser-changed", state),
  });
  agentBrowsers.install();

  // Deny every web permission except the few the app's own pages use: the microphone (main window only), clipboard writes, notifications.
  // The cloud computer's window and the agent browser's profile get none.
  installWebPermissions(session.defaultSession, [session.fromPartition("cloud-desktop"), agentBrowsers.session], { distDir, mainWindow: () => (mainWindow != null && !mainWindow.isDestroyed() ? mainWindow.webContents : null) });
  const themeState = (): ThemeState => ({ preference: settings.get().theme, resolved: resolvedDark(settings.get().theme) ? "dark" : "light" });

  // ---- models ---------------------------------------------------------------------------
  // Schema-1 settings had one OpenAI-compatible key; it now belongs to xAI or the custom endpoint.
  if (secrets.has("model-api-key")) {
    const target = settings.legacyKeyTarget ?? (settings.get().models.defaultModel.provider === "custom" ? "custom" : "xai");
    await secrets.rename("model-api-key", `${target}-api-key`);
  }
  const keyName = (provider: KeyedProvider): SecretName => `${provider}-api-key`;
  const chatgpt = new ChatGptAuth({ secrets, settings, openInBrowser: (url) => shell.openExternal(url) });
  const mcpAuth = new McpAuth({ secrets, openInBrowser: (url) => shell.openExternal(url), log: (line) => console.error(line) });
  let claudeCode: ClaudeCodeStatus = { executable: null, installed: false, version: null, signedIn: false, authMethod: null, checkedAt: 0 };

  /** With a remote box, ChatGPT plan requests use the sign-in copied to the box: show that one. */
  const boxChatGpt = (): ChatGptStatus => {
    const onBox = remoteBox?.status?.chatgpt;
    return { connected: onBox?.connected ?? false, planUsage: onBox?.planUsage ?? false, email: onBox?.email ?? null, welcomeSeen: settings.get().models.chatgpt.welcomeSeen, signingIn: chatgpt.status().signingIn };
  };
  const NOT_CHECKED: ClaudeCodeStatus = { executable: null, installed: false, version: null, signedIn: false, authMethod: null, checkedAt: 0 };

  const modelSettings = (): ModelSettings => {
    const prefs = settings.get().models;
    return {
      defaultModel: prefs.defaultModel,
      reasoningEffort: prefs.reasoningEffort,
      temperature: prefs.temperature,
      webSearch: prefs.webSearch,
      xSearch: prefs.xSearch,
      xai: { baseUrl: prefs.xaiBaseUrl, hasApiKey: secrets.has("xai-api-key") },
      openai: { auth: prefs.openaiAuth, hasApiKey: secrets.has("openai-api-key"), chatgpt: remoteBox != null ? boxChatGpt() : chatgpt.status() },
      anthropic: { hasApiKey: secrets.has("anthropic-api-key") },
      custom: { baseUrl: prefs.customBaseUrl, hasApiKey: secrets.has("custom-api-key") },
      // A remote box runs its own Claude Code, signed in on the server.
      claudeCode: remoteBox != null ? (remoteBox.status?.claudeCode ?? NOT_CHECKED) : claudeCode,
      boxLocation: remoteBox != null ? "remote" : "local",
    };
  };

  /** What the box may use: connected providers only, with their credentials. */
  const boxModels = async (): Promise<BoxModelConfig> => {
    const prefs = settings.get().models;
    const key = (provider: KeyedProvider) => secrets.get(keyName(provider));
    let openai: BoxModelConfig["openai"] = null;
    if (prefs.openaiAuth === "api-key") {
      const apiKey = key("openai");
      if (apiKey != null) openai = { baseUrl: OPENAI_BASE_URL, auth: "api-key", apiKey };
    } else if (remoteBox != null) {
      // The remote box refreshes the sign-in copied to it; this PC's tokens never go there.
      openai = { baseUrl: OPENAI_BASE_URL, auth: "chatgpt", accessToken: "", expiresAt: 0 };
    } else if (chatgpt.usable()) {
      const token = await chatgpt.accessToken().catch(() => null);
      if (token != null) openai = { baseUrl: OPENAI_BASE_URL, auth: "chatgpt", ...token };
    }
    const xaiKey = key("xai");
    const anthropicKey = key("anthropic");
    return {
      defaultModel: prefs.defaultModel,
      reasoningEffort: prefs.reasoningEffort,
      temperature: prefs.temperature,
      xai: xaiKey != null ? { baseUrl: prefs.xaiBaseUrl, apiKey: xaiKey } : null,
      openai,
      anthropic: anthropicKey != null ? { apiKey: anthropicKey } : null,
      custom: prefs.customBaseUrl.length > 0 ? { baseUrl: prefs.customBaseUrl, apiKey: key("custom") ?? "" } : null,
      claudeCode: remoteBox == null && claudeCode.installed && claudeCode.executable != null ? { executable: claudeCode.executable } : null,
      webSearch: prefs.webSearch,
      xSearch: prefs.xSearch,
    };
  };

  // ---- approvals for tools on this PC -------------------------------------------------
  // local-exec registers each card it asks for (content and request id); the coordinator records the
  // user's answer as it relays it; local-exec then runs a call the box resends only with that answer.
  // A box elsewhere can't approve on the user's behalf, or show different text on the card.
  const approvals = new Map<string, { ask: PermissionAsk; resolution: "allow-once" | "always" | "deny" | "never" | null; used: boolean; at: number }>();
  const pruneApprovals = () => {
    for (const [id, approval] of approvals) if (Date.now() - approval.at > 24 * 60 * 60_000 || approvals.size > 500) approvals.delete(id);
  };

  // ---- child processes ----------------------------------------------------------------
  let rosterCache: AgentSummary[] = [];
  let rosterCounts = { running: 0, unread: 0, awaiting: 0 };
  let localExecEmit: ReturnType<typeof serveEdge<typeof localHostEdge>> | null = null;

  const cloudSettings = (): CloudSettings => ({ hasApiKey: secrets.has("e2b-api-key"), ...settings.get().cloud });
  const boxCloud = () => {
    const apiKey = secrets.get("e2b-api-key");
    return apiKey != null ? { apiKey, ...settings.get().cloud } : null;
  };

  const configureBox = async () => {
    if (remoteBox != null) {
      // The box saves what it gets, so it keeps running on these settings while this PC is off.
      await remoteBox.pushConfig(async () => ({ models: await boxModels(), workspaceRoot: "", cloud: boxCloud(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
      return;
    }
    if (!processes.boxReady || processes.boxControl == null) return;
    try {
      await processes.boxControl.configure({ models: await boxModels(), workspaceRoot, cloud: boxCloud() });
    } catch (error) {
      console.error("box configure failed", error);
    }
  };
  const cloudChanged = async (): Promise<CloudSettings> => {
    await configureBox();
    const next = cloudSettings();
    emitMain?.("cloud-settings-changed", next);
    return next;
  };
  /** Settings changed: tell the box and the renderer. */
  const modelsChanged = async (): Promise<ModelSettings> => {
    await configureBox();
    const next = modelSettings();
    emitMain?.("model-settings-changed", next);
    return next;
  };
  const refreshClaudeCode = async (): Promise<ModelSettings> => {
    claudeCode = await detectClaudeCode(settings.get().models.claudeCodeExecutable);
    return modelsChanged();
  };

  const boxLocationState = (): BoxLocationState => ({
    location: remoteBox != null ? "remote" : "local",
    remoteUrl: settings.get().box.remoteUrl,
    hasToken: secrets.has("box-remote-token"),
    remote: remoteBox != null ? { reachable: remoteBox.error == null && remoteBox.status != null, error: remoteBox.error, status: remoteBox.status, checkedAt: remoteBox.checkedAt } : null,
    chatGptOnThisPc: chatgpt.status().connected,
  });
  /** The remote box reported in; its ChatGPT and Claude Code status also show in Settings → Models. */
  const boxChanged = () => {
    emitMain?.("box-location-changed", boxLocationState());
    emitMain?.("model-settings-changed", modelSettings());
  };
  const connectRemoteBox = (address: RemoteBoxAddress | null) => {
    remoteBox?.close();
    remoteBox = address != null ? new RemoteBoxClient(address, { onChange: boxChanged, log: (line) => console.error(line) }) : null;
  };
  /** Moves every process to the box the settings name, then reloads the UI against it. */
  const applyBoxLocation = async () => {
    const address = remoteAddress();
    connectRemoteBox(address);
    await processes.switchBox(address);
    if (remoteBox != null) {
      await remoteBox.refreshStatus();
      await configureBox();
    }
    boxChanged();
    if (mainWindow != null && !mainWindow.isDestroyed()) {
      deepLinksReady = false;
      mainWindow.webContents.reload();
      deliverDeepLink({ route: "settings", section: "box" });
    }
  };
  /**
   * OpenAI's guidance for self-hosted VMs: sign in where a browser can reach the loopback
   * redirect, copy the credentials to the VM, and let the VM own every refresh from then on.
   */
  const moveChatGptToBox = async () => {
    const box = remoteBox;
    if (box == null) throw new Error("The box runs on this PC, so the sign-in is already where it's used.");
    await chatgpt.moveTo(async (tokens) => void (await box.call("importChatGptSignIn", tokens)));
    settings.update({ models: { ...settings.get().models, openaiAuth: "chatgpt" } });
    await modelsChanged();
  };
  const localBoxControl = () => {
    if (!processes.boxReady || processes.boxControl == null) throw new Error("The box isn't running yet. Try again in a moment.");
    return processes.boxControl;
  };
  /**
   * MCP sign-ins run in the browser on this PC. The box here then gets access tokens from main,
   * which keeps the sign-in; a remote box is handed the sign-in and refreshes it itself, as with
   * ChatGPT, so this PC keeps no copy.
   */
  const signInToMcpServer = async (serverId: string) => {
    const box = remoteBox;
    if (box?.status?.admin === false) throw new Error("Your box server doesn't take sign-ins from the app (WISP_BOX_ADMIN=off). Put a token in the server's headers instead.");
    const target = box != null ? await box.call("mcpSignInTarget", { serverId }) : await localBoxControl().mcpSignInTarget({ serverId });
    const credentials = await mcpAuth.signIn(target);
    if (box != null) {
      await box.call("importMcpSignIn", { serverId, credentials });
      return;
    }
    await mcpAuth.signIns.save(serverId, credentials);
    await localBoxControl().mcpSignInChanged({ serverId });
  };
  const signOutOfMcpServer = async (serverId: string) => {
    if (remoteBox != null) {
      await remoteBox.call("signOutMcpServer", { serverId });
      return;
    }
    await mcpAuth.signIns.forget(serverId, true);
    await localBoxControl().mcpSignInChanged({ serverId });
  };

  const tray = new TrayController(assetsDir, {
    showMain: () => showMainWindow(),
    openAgent: (agentId) => showMainWindow(agentId),
    newAgent: () => {
      showMainWindow();
      deliverDeepLink({ route: "new-agent" });
    },
    quit: () => {
      quitting = true;
      app.quit();
    },
  });

  const refreshRoster = async () => {
    try {
      rosterCache = (await processes.coordinatorMain?.rosterAgents()) ?? rosterCache;
    } catch {
      // coordinator restarting
    }
    tray.update(rosterCounts, rosterCache);
    await desktopMount.rosterChanged();
    agentBrowsers.rosterChanged(rosterCache.map((agent) => agent.id));
    if (process.platform !== "win32") app.setBadgeCount(rosterCounts.unread + rosterCounts.awaiting);
  };
  let rosterTimer: NodeJS.Timeout | null = null;

  const processes = new ProcessHost({
    version: app.getVersion(),
    distDir,
    boxDataDir,
    wasmDir: join(distDir, "wasm"),
    attachmentsRoot: attachments.root,
    workspaceRoot,
    localExecDataDir: join(userDataDir, "local-exec"),
    onBoxReady: () => void configureBox(),
    onStatus: (kind, state) => console.log(`[supervisor] ${kind} ${state}`),
    onBox: (peer: PortPeer) => {
      serveEdge(
        boxHostEdge,
        {
          refreshChatGptToken: ({ force }) => chatgpt.accessToken(force),
          mcpAccessToken: ({ serverId, url, force }) => mcpAuth.signIns.accessToken(serverId, url, force),
          forgetMcpSignIn: async ({ serverId }) => void (await mcpAuth.signIns.forget(serverId, true)),
        },
        peer.server,
      );
    },
    onCoordinator: (peer: PortPeer) => {
      serveEdge(
        coordinatorControlEdge,
        {
          gatewayAddress: () => processes.gatewayAddress(),
          noteAgentActivity: (activity) => {
            notifyActivity(activity, {
              prefs: settings.get().notifications,
              windowFocused,
              viewingAgentId,
              assetsDir,
              onClick: (agentId) => showMainWindow(agentId),
            });
          },
          reportRoster: (counts) => {
            rosterCounts = counts;
            rosterTimer ??= setTimeout(() => {
              rosterTimer = null;
              void refreshRoster();
            }, 300);
          },
          noteToolApproval: ({ requestId, resolution }) => {
            const approval = approvals.get(requestId);
            if (approval != null && approval.resolution == null) approval.resolution = resolution;
          },
        },
        peer.server,
      );
    },
    onLocalExec: (peer: PortPeer) => {
      localExecEmit = serveEdge(
        localHostEdge,
        {
          gatewayAddress: () => processes.gatewayAddress(),
          offerToolApproval: ({ requestId, ask }) => {
            pruneApprovals();
            approvals.set(requestId, { ask, resolution: null, used: false, at: Date.now() });
          },
          takeToolApproval: ({ requestId }) => {
            // Each answer works once; the entry stays so the card keeps showing what was asked.
            const approval = approvals.get(requestId);
            if (approval == null || approval.used || approval.resolution == null || approval.resolution === "deny") return null;
            approval.used = true;
            return approval.resolution;
          },
          toolPermissionModes: () => settings.get().toolPermissions,
          rememberGrant: ({ toolId, scope }) => {
            const grants = settings.get().standingGrants.filter((grant) => !(grant.toolId === toolId && grant.scope === scope));
            settings.update({ standingGrants: [...grants, { toolId, scope, grantedAt: Date.now() }] });
          },
          listStandingGrants: () => settings.get().standingGrants.map(({ toolId, scope }) => ({ toolId, scope })),
          grabScreen: async () => {
            const capture = await grabScreen(2560);
            return capture == null ? null : { pngBase64: capture.png.toString("base64"), width: capture.width, height: capture.height };
          },
          getClipboardText: () => clipboard.readText(),
          putClipboardText: ({ text }) => clipboard.writeText(text),
          openInBrowser: async ({ url }) => {
            if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) links can be opened.");
            await shell.openExternal(url);
          },
          browserPlan: (call) => agentBrowsers.plan(call),
          browserRun: (call) => agentBrowsers.run(call),
          browserCancel: ({ callId }) => agentBrowsers.cancel(callId),
        },
        peer.server,
      );
    },
  });

  const desktopMount = new DesktopMount({
    distDir,
    ipcMain,
    settings,
    attachments,
    rosterAgents: async () => (await processes.coordinatorMain?.rosterAgents()) ?? rosterCache,
    deliverMessage: async ({ agentId, prompt, attachmentPaths, attachmentNames }) => {
      await processes.coordinatorMain?.deliverMessage({ agentId, prompt, attachmentPaths, attachmentNames, clientNonce: crypto.randomUUID(), origin: "desktop-mount" });
    },
    showMainWindow,
    onMountChanged: (agentId) => emitMain?.("mount-state-changed", { mountedAgentId: agentId }),
  });

  // The cloud computer's desktop is a noVNC page served by E2B; show it in a
  // sandboxed window that stays on that origin.
  let cloudDesktopWindow: BrowserWindow | null = null;
  function openCloudDesktop(url: string): void {
    const target = new URL(url);
    if (target.protocol !== "https:" || !/(^|\.)e2b\.(app|dev)$/i.test(target.hostname)) throw new Error("That isn't a cloud computer address.");
    if (cloudDesktopWindow == null || cloudDesktopWindow.isDestroyed()) {
      const window = new BrowserWindow({
        width: 1320,
        height: 880,
        title: "Cloud computer",
        autoHideMenuBar: true,
        backgroundColor: "#141414",
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "cloud-desktop" },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, next) => {
        if (new URL(next).origin !== target.origin) event.preventDefault();
      });
      window.on("closed", () => {
        if (cloudDesktopWindow === window) cloudDesktopWindow = null;
      });
      cloudDesktopWindow = window;
    }
    void cloudDesktopWindow.loadURL(url);
    cloudDesktopWindow.show();
    cloudDesktopWindow.focus();
  }

  async function grabScreen(maxWidth: number): Promise<{ png: Buffer; width: number; height: number } | null> {
    const display = screen.getPrimaryDisplay();
    const scale = Math.min(1, maxWidth / (display.size.width * display.scaleFactor)) * display.scaleFactor;
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) } });
    const source = sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0];
    if (source == null || source.thumbnail.isEmpty()) return null;
    const size = source.thumbnail.getSize();
    return { png: source.thumbnail.toPNG(), width: size.width, height: size.height };
  }

  // ---- main edge (renderer -> main), main window top frame only ----------------------------
  const mainTargets = () => (mainWindow != null && !mainWindow.isDestroyed() ? [mainWindow.webContents] : []);
  const fromMainWindow = (event: { senderFrame?: unknown }) => mainWindow != null && !mainWindow.isDestroyed() && event.senderFrame === mainWindow.webContents.mainFrame;
  const win = () => {
    if (mainWindow == null || mainWindow.isDestroyed()) throw new Error("no main window");
    return mainWindow;
  };
  const windowState = () => ({ isMaximized: win().isMaximized(), isFocused: win().isFocused(), isFullScreen: win().isFullScreen() });

  emitMain = serveEdge(
    mainEdge,
    {
      getAppInfo: () => ({ name: app.getName(), version: app.getVersion(), electron: process.versions.electron, platform: process.platform, userDataDir, workspaceRoot }),
      openInBrowser: async ({ url }) => {
        if (!/^(https?:|mailto:)/i.test(url)) throw new Error("Only web and mail links can be opened.");
        await shell.openExternal(url);
      },
      openWithDefaultApp: async ({ path }) => {
        const error = await shell.openPath(path);
        if (error) throw new Error(error);
      },
      showItemInFolder: ({ path }) => shell.showItemInFolder(path),
      readWindowState: () => windowState(),
      windowMinimize: () => win().minimize(),
      windowToggleMaximize: () => (win().isMaximized() ? win().unmaximize() : win().maximize()),
      windowClose: () => win().close(),
      raiseWindow: () => showMainWindow(),
      setTitlebarColors: ({ tone }) => {
        if (process.platform !== "darwin") win().setTitleBarOverlay(overlayColors(tone === "dark"));
      },
      noteOpenAgent: ({ agentId }) => {
        viewingAgentId = agentId;
      },
      acceptDeepLinks: () => {
        deepLinksReady = true;
        for (const link of deepLinkQueue.splice(0)) emitMain?.("link-opened", link);
      },
      themeInfo: () => themeState(),
      chooseTheme: ({ preference }) => {
        settings.update({ theme: preference });
        nativeTheme.themeSource = preference;
        return themeState();
      },
      readSpellCheck: () => settings.get().spellCheck,
      changeSpellCheck: ({ enabled }) => {
        settings.update({ spellCheck: enabled });
        session.defaultSession.setSpellCheckerEnabled(enabled);
      },
      readGpuAcceleration: () => ({ enabled: settings.get().hardwareAcceleration, pendingRelaunch: settings.get().hardwareAcceleration !== hardwareAccelerationAtLaunch }),
      changeGpuAcceleration: ({ enabled }) => {
        settings.update({ hardwareAcceleration: enabled });
      },
      readNotificationSettings: () => settings.get().notifications,
      changeNotificationSettings: (prefs) => settings.update({ notifications: prefs }).notifications,
      restartApp: () => {
        quitting = true;
        app.relaunch();
        app.exit(0);
      },
      readOnboardingSeen: () => settings.get().onboardingSeen,
      changeOnboardingSeen: ({ seen }) => {
        settings.update({ onboardingSeen: seen });
      },
      getModelSettings: () => modelSettings(),
      updateModelSettings: async (patch) => {
        const prefs = settings.get().models;
        settings.update({
          models: {
            ...prefs,
            ...(patch.defaultModel != null ? { defaultModel: patch.defaultModel } : {}),
            ...(patch.reasoningEffort != null ? { reasoningEffort: patch.reasoningEffort } : {}),
            ...(patch.temperature !== undefined ? { temperature: patch.temperature } : {}),
            ...(patch.webSearch != null ? { webSearch: patch.webSearch } : {}),
            ...(patch.xSearch != null ? { xSearch: patch.xSearch } : {}),
            ...(patch.xaiBaseUrl != null ? { xaiBaseUrl: patch.xaiBaseUrl } : {}),
            ...(patch.customBaseUrl != null ? { customBaseUrl: patch.customBaseUrl } : {}),
            ...(patch.openaiAuth != null ? { openaiAuth: patch.openaiAuth } : {}),
            ...(patch.claudeCodeExecutable !== undefined ? { claudeCodeExecutable: patch.claudeCodeExecutable } : {}),
          },
        });
        if (patch.claudeCodeExecutable !== undefined) return refreshClaudeCode();
        return modelsChanged();
      },
      setProviderApiKey: async ({ provider, apiKey }) => {
        await secrets.set(keyName(provider), apiKey.trim());
        return modelsChanged();
      },
      clearProviderApiKey: async ({ provider }) => {
        await secrets.remove(keyName(provider));
        return modelsChanged();
      },
      listProviderModels: async ({ provider }) => {
        await configureBox(); // a ChatGPT token may need refreshing first; a remote box needs the latest keys
        if (remoteBox != null) return remoteBox.call("listModels", { provider });
        return (await processes.boxControl?.listModels({ provider })) ?? [];
      },
      startChatGptSignIn: async () => {
        const current = remoteBox != null ? boxChatGpt() : chatgpt.status();
        const promise = chatgpt.signIn(current.connected && !current.planUsage);
        emitMain?.("model-settings-changed", modelSettings()); // shows "signing in"
        try {
          await promise;
        } finally {
          emitMain?.("model-settings-changed", modelSettings());
        }
        settings.update({ models: { ...settings.get().models, openaiAuth: "chatgpt" } });
        if (remoteBox != null) await moveChatGptToBox();
        return modelsChanged();
      },
      cancelChatGptSignIn: () => chatgpt.cancel(),
      signOutChatGpt: async () => {
        if (remoteBox != null) await remoteBox.call("signOutChatGpt", {});
        else await chatgpt.signOut();
        return modelsChanged();
      },
      markChatGptWelcomeSeen: () => {
        chatgpt.markWelcomeSeen();
        emitMain?.("model-settings-changed", modelSettings());
      },
      checkClaudeCode: async () => {
        if (remoteBox == null) return refreshClaudeCode();
        await remoteBox.call("checkClaudeCode", {});
        return modelSettings();
      },
      openClaudeCodeSignIn: () => {
        if (remoteBox != null) throw new Error("Claude Code runs on your box server. Sign in there: docker compose exec -it box claude auth login");
        if (claudeCode.executable == null) throw new Error("Claude Code wasn't found on this computer.");
        openClaudeCodeSignIn(claudeCode.executable);
      },
      getCloudSettings: () => cloudSettings(),
      updateCloudSettings: (patch) => {
        settings.update({ cloud: { ...settings.get().cloud, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } });
        return cloudChanged();
      },
      setCloudApiKey: async ({ apiKey }) => {
        await secrets.set("e2b-api-key", apiKey.trim());
        return cloudChanged();
      },
      clearCloudApiKey: async () => {
        await secrets.remove("e2b-api-key");
        return cloudChanged();
      },
      openCloudDesktop: ({ url }) => openCloudDesktop(url),
      getBoxLocation: () => boxLocationState(),
      setBoxLocation: async ({ location, url, token }) => {
        if (location === "local") {
          if (remoteBox == null && settings.get().box.location === "local") return boxLocationState();
          settings.update({ box: { ...settings.get().box, location: "local" } });
          await applyBoxLocation();
          return boxLocationState();
        }
        const baseUrl = normalizeBoxUrl(url ?? settings.get().box.remoteUrl);
        const pasted = token?.trim() ?? "";
        const secret = pasted.length > 0 ? pasted : baseUrl === settings.get().box.remoteUrl ? secrets.get("box-remote-token") : null;
        if (secret == null) throw new Error("Paste the token from your box server.");
        await probeBox({ baseUrl, token: secret }); // nothing changes unless the box answers and takes the token
        await secrets.set("box-remote-token", secret);
        settings.update({ box: { location: "remote", remoteUrl: baseUrl } });
        await applyBoxLocation();
        return boxLocationState();
      },
      checkBoxConnection: async () => {
        await remoteBox?.refreshStatus();
        return boxLocationState();
      },
      moveChatGptSignInToBox: async () => {
        await moveChatGptToBox();
        return boxLocationState();
      },
      startMcpSignIn: ({ serverId }) => signInToMcpServer(serverId),
      cancelMcpSignIn: ({ serverId }) => mcpAuth.cancel(serverId),
      signOutMcpServer: ({ serverId }) => signOutOfMcpServer(serverId),
      describeToolApproval: ({ requestId }) => approvals.get(requestId)?.ask ?? null,
      listLocalTools: () => LOCAL_PERMISSIONS,
      readToolPermission: () => settings.get().toolPermissions,
      changeToolPermission: ({ toolId, permission }) => {
        settings.update({ toolPermissions: { ...settings.get().toolPermissions, [toolId]: permission } });
        localExecEmit?.("permissions-changed", settings.get().toolPermissions);
      },
      listLocalToolStandingGrants: () => settings.get().standingGrants,
      forgetToolApprovals: () => {
        settings.update({ standingGrants: [] });
        localExecEmit?.("permissions-changed", settings.get().toolPermissions);
      },
      loadUiState: ({ key }) => persistence.read(key),
      loadUiStates: ({ include, exclude }) => persistence.readMany(include, exclude),
      saveUiState: ({ key, value }) => persistence.write(key, value),
      deleteUiState: ({ key }) => persistence.remove(key),
      listUiStateKeys: ({ prefix }) => persistence.listKeys(prefix),
      stageUploadBytes: ({ filename, bytes }) => attachments.stageBytes(filename, bytes),
      stageUploadFile: ({ filename, sourcePath }) => attachments.stagePath(filename, sourcePath),
      dropStagedUpload: ({ path }) => attachments.discard(path),
      grabScreen: async () => {
        const capture = await grabScreen(1600);
        return capture == null ? null : { dataUrl: `data:image/png;base64,${capture.png.toString("base64")}`, width: capture.width, height: capture.height, capturedAt: Date.now() };
      },
      fetchSharedTemplate: async ({ shareId, url }) => (shareId != null ? fetchBoxTemplate((await processes.gatewayAddress()).baseUrl, shareId) : fetchBotTemplate(url!)),
      openBotTemplateFile: async () => {
        const picked = await dialog.showOpenDialog(win(), { title: "Open a bot template", properties: ["openFile"], filters: [{ name: "Bot templates", extensions: ["json"] }] });
        return picked.canceled || picked.filePaths[0] == null ? null : readBotTemplateFile(picked.filePaths[0]);
      },
      saveBotTemplateFile: async ({ template }) => {
        const picked = await dialog.showSaveDialog(win(), { title: "Save the bot template", defaultPath: join(app.getPath("downloads"), botTemplateFileName(template.name)), filters: [{ name: "Bot templates", extensions: [BOT_TEMPLATE_EXTENSION.slice(1)] }] });
        if (picked.canceled || picked.filePath == null) return null;
        writeBotTemplateFile(picked.filePath, template);
        return picked.filePath;
      },
      savePageFile: async ({ title, source }) => {
        const picked = await dialog.showSaveDialog(win(), { title: "Save as Markdown", defaultPath: join(app.getPath("documents"), pageFileName(title)), filters: [{ name: "Markdown", extensions: ["md"] }] });
        if (picked.canceled || picked.filePath == null) return null;
        writeFileSync(picked.filePath, source.endsWith("\n") ? source : `${source}\n`);
        return picked.filePath;
      },
      getMountState: () => ({ mountedAgentId: desktopMount.mountedId() }),
      mountAgent: async ({ agentId }) => {
        await desktopMount.mount(agentId);
        return { mountedAgentId: desktopMount.mountedId() };
      },
      unmountAgent: () => {
        desktopMount.unmount();
        return { mountedAgentId: null };
      },
      getAgentBrowser: ({ agentId }) => agentBrowsers.state(agentId),
      showAgentBrowser: ({ agentId }) => agentBrowsers.show(agentId),
    },
    ipcServerTransport(ipcMain, mainTargets, fromMainWindow),
    { onError: (method, error) => console.error(`main edge ${method} failed:`, error) },
  );

  // The renderer asks for its boot snapshot synchronously before first paint.
  ipcMain.on("wisp:boot-snapshot-sync", (event) => {
    event.returnValue = {
      mainEdge: "served",
      theme: themeState(),
      platform: process.platform,
      appVersion: app.getVersion(),
      uiLayout: persistence.readSync("wisp.ui.ui-layout"),
      onboardingSeen: settings.get().onboardingSeen,
      model: modelSettings(),
    };
  });
  ipcMain.handle("wisp:coordinator-port-request", (event) => {
    if (mainWindow != null && event.sender === mainWindow.webContents) processes.attachRenderer(event.sender);
  });

  nativeTheme.on("updated", () => {
    emitMain?.("theme-updated", themeState());
    if (mainWindow != null && !mainWindow.isDestroyed() && process.platform !== "darwin") mainWindow.setTitleBarOverlay(overlayColors(resolvedDark(settings.get().theme)));
  });

  function openMainWindow(): BrowserWindow {
    const window = createMainWindow({ userDataDir, distDir, spellCheck: settings.get().spellCheck, dark: resolvedDark(settings.get().theme) });
    const pushState = () => {
      if (!window.isDestroyed()) emitMain?.("window-state-changed", windowState());
    };
    window.on("focus", () => {
      windowFocused = true;
      void processes.coordinatorMain?.windowFocusChanged({ isFocused: true }).catch(() => undefined);
      pushState();
    });
    window.on("blur", () => {
      windowFocused = false;
      void processes.coordinatorMain?.windowFocusChanged({ isFocused: false }).catch(() => undefined);
      pushState();
    });
    for (const name of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen"] as const) window.on(name as "maximize", pushState);
    // Closing hides to the tray so agents and automations keep running.
    window.on("close", (event) => {
      if (quitting || process.platform === "darwin") return;
      event.preventDefault();
      window.hide();
    });
    window.webContents.on("did-start-loading", () => {
      deepLinksReady = false;
    });
    window.on("closed", () => {
      if (mainWindow === window) mainWindow = null;
    });
    return window;
  }

  const startingBox = remoteAddress();
  connectRemoteBox(startingBox);
  processes.start(startingBox);
  if (startingBox != null) void (remoteBox as RemoteBoxClient | null)?.refreshStatus().then(() => configureBox());
  void refreshClaudeCode().catch((error) => console.error("Claude Code detection failed", error));
  mainWindow = openMainWindow();
  tray.create();
  desktopMount.install();
  handleArgv(process.argv);

  app.on("activate", () => showMainWindow());
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    tray.destroy();
    processes.stop();
  });
  app.on("window-all-closed", () => {
    // Stay alive in the tray; quitting is explicit.
  });
}
