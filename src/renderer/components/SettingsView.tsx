// Settings: General, Box, Models, Cloud computer, Permissions, MCP servers, About.
import { useEffect, useState, type ReactNode } from "react";
import { siteLabel } from "../../shared/agent-browser";
import type { AppInfo, BoxLocationState, BoxServerStatus, NotificationPreferences, ThemeState } from "../../shared/edges";
import {
  CHATGPT_USAGE_URL,
  DEFAULT_XAI_BASE_URL,
  type KeyedProvider,
  type LocalToolInfo,
  type McpServerSummary,
  type ModelSettings,
  PROVIDER_LABELS,
  type ReasoningEffort,
  type ToolPermission,
} from "../../shared/model";
import { gateway, main } from "../bridge";
import { app, closeSettings, openConnectApps, openSettings, type SettingsSection } from "../store/app";
import { loadMcpServers, mcpServers, setMcpState } from "../store/agent-data";
import { cloudAction, cloudSettings, cloudStatus, refreshCloudStatus } from "../store/cloud";
import { loadModels, modelSettings, setModelSettings } from "../store/models";
import { useStore } from "../store/store";
import { AddMcpServer, MCP_STATUS, McpSignIn, McpToolList, serverLabel } from "./ConnectApps";
import { Icon } from "./icons";
import { ModelPicker } from "./ModelPicker";

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "general", label: "General" },
  { id: "box", label: "Box" },
  { id: "model", label: "Models" },
  { id: "cloud", label: "Cloud computer" },
  { id: "permissions", label: "Permissions" },
  { id: "mcp", label: "MCP servers" },
  { id: "about", label: "About" },
];

export function SettingsView() {
  const section = useStore(app, (state) => state.settingsSection);
  return (
    <section className="settings" aria-label="Settings">
      <nav className="settings__nav">
        <button type="button" className="settings__back" onClick={closeSettings}>
          <Icon name="chevronRight" size={12} style={{ transform: "rotate(180deg)" }} /> Back
        </button>
        {SECTIONS.map((item) => (
          <button key={item.id} type="button" className={`settings__nav-item${section === item.id ? " settings__nav-item--active" : ""}`} onClick={() => openSettings(item.id)}>
            {item.label}
          </button>
        ))}
      </nav>
      <div className="settings__content">
        {section === "general" ? <General /> : section === "box" ? <Box /> : section === "model" ? <Models /> : section === "cloud" ? <Cloud /> : section === "permissions" ? <Permissions /> : section === "mcp" ? <Mcp /> : <About />}
      </div>
    </section>
  );
}

function Row({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <div className="settings-row__title">{title}</div>
        {description != null ? <div className="settings-row__description">{description}</div> : null}
      </div>
      <div className="settings-row__control">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className={`switch${disabled ? " switch--disabled" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} aria-label={label} />
      <span />
    </label>
  );
}

function General() {
  const [theme, setTheme] = useState<ThemeState | null>(null);
  const [spell, setSpell] = useState(true);
  const [hardware, setHardware] = useState<{ enabled: boolean; pendingRelaunch: boolean } | null>(null);
  const [notifications, setNotifications] = useState<NotificationPreferences | null>(null);

  useEffect(() => {
    void main.themeInfo().then(setTheme);
    void main.readSpellCheck().then(setSpell);
    void main.readGpuAcceleration().then(setHardware);
    void main.readNotificationSettings().then(setNotifications);
  }, []);

  const updateNotifications = async (patch: Partial<NotificationPreferences>) => {
    if (notifications == null) return;
    setNotifications(await main.changeNotificationSettings({ ...notifications, ...patch }));
  };

  return (
    <div className="settings-section">
      <h2>General</h2>
      <Row title="Theme">
        <div className="segmented">
          {(["system", "light", "dark"] as const).map((option) => (
            <button key={option} type="button" className={theme?.preference === option ? "segmented--active" : ""} onClick={async () => setTheme(await main.chooseTheme({ preference: option }))}>
              {option[0].toUpperCase() + option.slice(1)}
            </button>
          ))}
        </div>
      </Row>
      <Row title="Spell check" description="Underline misspellings while you type.">
        <Toggle checked={spell} label="Spell check" onChange={async (value) => (await main.changeSpellCheck({ enabled: value }), setSpell(value))} />
      </Row>
      <Row
        title="Hardware acceleration"
        description={
          hardware?.pendingRelaunch ? (
            <>
              Takes effect after a relaunch.{" "}
              <button type="button" className="link-button" onClick={() => void main.restartApp()}>
                Relaunch now
              </button>
            </>
          ) : (
            "Use the GPU to draw the app."
          )
        }
      >
        {hardware != null ? (
          <Toggle
            checked={hardware.enabled}
            label="Hardware acceleration"
            onChange={async (value) => {
              await main.changeGpuAcceleration({ enabled: value });
              setHardware(await main.readGpuAcceleration());
            }}
          />
        ) : null}
      </Row>
      <h3>Notifications</h3>
      {notifications != null ? (
        <>
          <Row title="Desktop notifications" description="When an agent finishes, needs approval or asks a question.">
            <Toggle checked={notifications.enabled} label="Desktop notifications" onChange={(value) => void updateNotifications({ enabled: value })} />
          </Row>
          <Row title="Only when the app is in the background">
            <Toggle checked={notifications.onlyWhenUnfocused} label="Only in background" onChange={(value) => void updateNotifications({ onlyWhenUnfocused: value })} />
          </Row>
          <Row title="Sound">
            <Toggle checked={notifications.sound} label="Notification sound" onChange={(value) => void updateNotifications({ sound: value })} />
          </Row>
        </>
      ) : null}
    </div>
  );
}

const errorText = (error: unknown) => (error instanceof Error ? error.message.replace(/^[\w/-]+: /, "") : String(error));

async function updateModels(patch: Parameters<typeof main.updateModelSettings>[0]): Promise<void> {
  setModelSettings(await main.updateModelSettings(patch));
}

const KEY_SOURCES: Array<[keyof BoxServerStatus["providers"], string]> = [
  ["xai", "xAI"],
  ["openai", "OpenAI"],
  ["anthropic", "Anthropic"],
  ["custom", "Custom endpoint"],
  ["cloud", "Cloud computer"],
];

function Box() {
  const [state, setState] = useState<BoxLocationState | null>(null);
  const [choice, setChoice] = useState<"local" | "remote">("local");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const off = main.subscribe({ "box-location-changed": (next) => setState(next) });
    // A remote box is asked again on open and every few seconds, so "Tools on this PC" stays current.
    void main.checkBoxConnection().then((next) => {
      setState(next);
      setChoice(next.location);
      setUrl(next.remoteUrl);
    });
    const timer = setInterval(() => void main.checkBoxConnection().catch(() => undefined), 5_000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, []);
  if (state == null) return null;

  // Switching reloads the window against the new box; a refusal comes back here first.
  const run = async (label: string, action: () => Promise<BoxLocationState>) => {
    setBusy(label);
    setError(null);
    try {
      const next = await action();
      setState(next);
      setToken("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };
  const remote = state.location === "remote" ? state.remote : null;
  const status = remote?.status ?? null;
  const keys = status != null ? KEY_SOURCES.filter(([id]) => status.providers[id] != null).map(([id, label]) => `${label} (${status.providers[id] === "app" ? "from this app" : "set on the server"})`) : [];

  return (
    <div className="settings-section">
      <h2>Box</h2>
      <p className="muted">
        The box runs your agents: their conversations, automations and model requests. On this PC it stops when the PC sleeps or shuts down. On a server of your own, such as a small cloud VM, agents and their automations keep running around the clock, and their tools on this
        PC work whenever it’s on.
      </p>
      <Row title="Box location" description={state.location === "remote" ? <span className="mono">{state.remoteUrl}</span> : "Agents and their data are in this PC’s data folder."}>
        <div className="segmented" role="radiogroup" aria-label="Box location">
          <button
            type="button"
            role="radio"
            aria-checked={choice === "local"}
            className={choice === "local" ? "segmented--active" : ""}
            disabled={busy != null}
            onClick={() => {
              setChoice("local");
              if (state.location === "remote") void run("local", () => main.setBoxLocation({ location: "local" }));
            }}
          >
            This PC
          </button>
          <button type="button" role="radio" aria-checked={choice === "remote"} className={choice === "remote" ? "segmented--active" : ""} disabled={busy != null} onClick={() => setChoice("remote")}>
            Remote server
          </button>
        </div>
      </Row>
      {choice === "remote" ? (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void run("connect", () => main.setBoxLocation({ location: "remote", url, token }));
          }}
        >
          <p className="muted">Run the box server on an always-on machine (deploy/docker-compose.yml puts it behind HTTPS), then paste its address and token. Agents on each box are separate: switching shows the agents of the box you pick.</p>
          <label>
            Server address
            <input className="mono" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://box.example.com" aria-label="Box server address" autoComplete="off" />
          </label>
          <label>
            Token
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={state.hasToken && url.trim() === state.remoteUrl ? "••••••••••••  (saved)" : "On the server: docker compose exec box cat /data/gateway-token"}
              aria-label="Box server token"
              autoComplete="off"
            />
          </label>
          <div className="inline-form">
            <button type="submit" className="button button--primary" disabled={busy != null}>
              {busy === "connect" ? "Connecting…" : state.location === "remote" ? "Reconnect" : "Connect"}
            </button>
            {state.location === "remote" ? (
              <button type="button" className="button" disabled={busy != null} onClick={() => void run("check", () => main.checkBoxConnection())}>
                {busy === "check" ? "Checking…" : "Check"}
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
      {error != null ? <div className="form-error">{error}</div> : null}
      {remote != null ? (
        <>
          <h3>Status</h3>
          <div className="cloud-status">
            <span className={`status-dot status-dot--${remote.reachable ? "connected" : remote.checkedAt === 0 ? "initializing" : "error"}`} />
            <strong>{remote.reachable ? `Connected · box ${status?.version ?? ""}` : remote.checkedAt === 0 ? "Checking…" : "Can’t reach the box"}</strong>
          </div>
          {remote.error != null ? <div className="form-error">{remote.error}</div> : null}
          {status != null ? (
            <>
              <Row title="Tools on this PC" description="This PC dials out to the box whenever it’s on; while it’s off, agents set to This PC have no tools here.">
                <span className="muted">{status.localExec === "ready" ? "Connected" : "Not connected"}</span>
              </Row>
              <Row title="Keys on the box" description={status.admin ? "Keys you add in Settings → Models are sent to the box, which keeps them so it can run while this PC is off." : "This box doesn’t accept settings from the app: its keys are set on the server."}>
                <span className="muted">{keys.length > 0 ? keys.join(", ") : "None yet"}</span>
              </Row>
              <Row title="Claude Code on the box" description={status.claudeCode.installed ? "Signed in on the server with Claude Code’s own flow: docker compose exec -it box claude auth login" : "Build the box image with CLAUDE_CODE=1 to run Claude Code agents there."}>
                <span className="muted">{!status.claudeCode.installed ? "Not installed" : status.claudeCode.signedIn ? "Signed in" : "Not signed in"}</span>
              </Row>
              <Row
                title="ChatGPT plan on the box"
                description={
                  state.chatGptOnThisPc
                    ? "Your ChatGPT sign-in is saved on this PC. Moving it lets agents on the box use your plan: the box keeps it fresh from then on, and this PC forgets it."
                    : "Signing in from Settings → Models happens on this PC, then the sign-in moves to the box."
                }
              >
                {state.chatGptOnThisPc ? (
                  <button type="button" className="button" disabled={busy != null} onClick={() => void run("move", () => main.moveChatGptSignInToBox())}>
                    {busy === "move" ? "Moving…" : "Move to the box"}
                  </button>
                ) : (
                  <span className="muted">{status.chatgpt.connected ? `Signed in${status.chatgpt.email != null ? ` as ${status.chatgpt.email}` : ""}` : "Not signed in"}</span>
                )}
              </Row>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Models() {
  const settings = useStore(modelSettings);
  const [temperature, setTemperature] = useState(settings.temperature == null ? "" : String(settings.temperature));
  useEffect(() => {
    void main.checkClaudeCode().then(setModelSettings).catch(() => undefined);
  }, []);

  return (
    <div className="settings-section">
      <h2>Models</h2>
      <p className="muted">
        Connect one or more providers. Agents use the default model unless you pick another one in an agent’s settings.{" "}
        {settings.boxLocation === "remote"
          ? "Keys are encrypted with your OS keychain here and sent to your box server, which keeps them to call the providers while this PC is off."
          : "Keys are encrypted with your OS keychain and only sent to their provider."}
      </p>
      <Row title="Default model">
        <ModelPicker label="Default model" value={settings.defaultModel} onChange={(ref) => ref != null && void updateModels({ defaultModel: ref })} />
      </Row>
      <Row title="Reasoning effort" description="How long reasoning models think before acting. Higher is slower and uses more tokens.">
        <select value={settings.reasoningEffort} onChange={(event) => void updateModels({ reasoningEffort: event.target.value as ReasoningEffort })} aria-label="Reasoning effort">
          <option value="default">Provider default</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </Row>
      <Row
        title="Web search"
        description="xAI, OpenAI (API key or ChatGPT plan) and Anthropic models search the live web themselves when a question needs it, and their sources show under the reply. Searches are billed by the provider. Claude Code agents use Claude Code’s own WebSearch tool; custom endpoints don’t search."
      >
        <Toggle checked={settings.webSearch} label="Web search" onChange={(value) => void updateModels({ webSearch: value })} />
      </Row>
      <Row title="Search X with xAI" description="Grok models also search posts and people on X, as Grok does.">
        <Toggle checked={settings.webSearch && settings.xSearch} disabled={!settings.webSearch} label="Search X with xAI" onChange={(value) => void updateModels({ xSearch: value })} />
      </Row>

      <h3>Providers</h3>
      <div className="provider-list">
        <XaiCard settings={settings} />
        <OpenAiCard settings={settings} />
        <AnthropicCard settings={settings} />
        <ClaudeCodeCard settings={settings} />
        <CustomCard settings={settings} />
      </div>

      <Row title="Temperature" description="Sent only to xAI and custom endpoints. Leave empty for the provider default.">
        <input
          type="number"
          min={0}
          max={2}
          step={0.1}
          value={temperature}
          onChange={(event) => setTemperature(event.target.value)}
          onBlur={() => void updateModels({ temperature: temperature.trim() === "" ? null : Math.min(2, Math.max(0, Number(temperature))) })}
          aria-label="Temperature"
          style={{ width: 90 }}
        />
      </Row>
      <Row title="Offline mock" description={<>A fake model for trying the app without a network. Send “/tool list_directory {"{}"}” to watch it call a tool.</>}>
        <button type="button" className="button button--ghost" onClick={() => void updateModels({ defaultModel: { provider: "mock", model: "mock-1" } })}>
          Use as default
        </button>
      </Row>
    </div>
  );
}

function ProviderCard({ title, ready, status, children }: { title: string; ready: boolean; status: ReactNode; children: ReactNode }) {
  return (
    <section className="provider-card" aria-label={title}>
      <header className="provider-card__head">
        <span className={`status-dot status-dot--${ready ? "connected" : "disconnected"}`} />
        <h4>{title}</h4>
        <span className="provider-card__status">{status}</span>
      </header>
      <div className="provider-card__body">{children}</div>
    </section>
  );
}

function ApiKeyForm({ provider, hasKey, placeholder }: { provider: KeyedProvider; hasKey: boolean; placeholder?: string }) {
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  return (
    <form
      className="inline-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (value.trim().length === 0) return;
        try {
          setModelSettings(await main.setProviderApiKey({ provider, apiKey: value.trim() }));
          setValue("");
          setMessage("Saved. Checking it…");
          await loadModels(provider, true);
          setMessage(null);
        } catch (error) {
          setMessage(errorText(error));
        }
      }}
    >
      <input type="password" value={value} onChange={(event) => setValue(event.target.value)} placeholder={hasKey ? "••••••••••••  (saved)" : (placeholder ?? "Paste your API key")} autoComplete="off" aria-label={`${PROVIDER_LABELS[provider]} API key`} />
      <button type="submit" className="button">
        Save
      </button>
      {hasKey ? (
        <button type="button" className="button button--ghost" onClick={async () => setModelSettings(await main.clearProviderApiKey({ provider }))}>
          Remove
        </button>
      ) : null}
      {message != null ? <span className="muted">{message}</span> : null}
    </form>
  );
}

function XaiCard({ settings }: { settings: ModelSettings }) {
  const [baseUrl, setBaseUrl] = useState(settings.xai.baseUrl);
  return (
    <ProviderCard title="xAI" ready={settings.xai.hasApiKey} status={settings.xai.hasApiKey ? "API key saved" : "Not connected"}>
      <ApiKeyForm provider="xai" hasKey={settings.xai.hasApiKey} placeholder="xai-…" />
      <details className="provider-card__advanced">
        <summary>Endpoint</summary>
        <div className="inline-form">
          <input className="mono" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} aria-label="xAI base URL" />
          <button type="button" className="button" onClick={() => void updateModels({ xaiBaseUrl: baseUrl.trim() || DEFAULT_XAI_BASE_URL })}>
            Save
          </button>
        </div>
      </details>
    </ProviderCard>
  );
}

function OpenAiCard({ settings }: { settings: ModelSettings }) {
  const { auth, hasApiKey, chatgpt } = settings.openai;
  const [error, setError] = useState<string | null>(null);
  const ready = auth === "api-key" ? hasApiKey : chatgpt.connected && chatgpt.planUsage;
  const status = auth === "api-key" ? (hasApiKey ? "API key saved" : "Not connected") : chatgpt.connected ? (chatgpt.planUsage ? "Using your ChatGPT plan" : "Plan usage not allowed") : "Not connected";
  const signIn = async () => {
    setError(null);
    try {
      setModelSettings(await main.startChatGptSignIn());
      await loadModels("openai", true);
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  return (
    <ProviderCard title="OpenAI" ready={ready} status={status}>
      <div className="segmented" role="radiogroup" aria-label="OpenAI connection">
        <button type="button" role="radio" aria-checked={auth === "api-key"} className={auth === "api-key" ? "segmented--active" : ""} onClick={() => void updateModels({ openaiAuth: "api-key" })}>
          API key
        </button>
        <button type="button" role="radio" aria-checked={auth === "chatgpt"} className={auth === "chatgpt" ? "segmented--active" : ""} onClick={() => void updateModels({ openaiAuth: "chatgpt" })}>
          ChatGPT plan
        </button>
      </div>
      {auth === "api-key" ? (
        <ApiKeyForm provider="openai" hasKey={hasApiKey} placeholder="sk-…" />
      ) : !chatgpt.connected ? (
        <div className="stack">
          <p className="muted">
            Sign in with your ChatGPT Plus or Pro account and agents’ requests use your plan’s included usage instead of API billing. You can cap this app’s share in ChatGPT settings.
            {settings.boxLocation === "remote" ? " You sign in on this PC; the sign-in then moves to your box server, which keeps it fresh." : ""}
          </p>
          <div className="inline-form">
            <button type="button" className="button button--primary" disabled={chatgpt.signingIn} onClick={() => void signIn()}>
              {chatgpt.signingIn ? "Waiting for the browser…" : "Continue with ChatGPT"}
            </button>
            {chatgpt.signingIn ? (
              <button type="button" className="button button--ghost" onClick={() => void main.cancelChatGptSignIn()}>
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="stack">
          <p>
            Signed in{chatgpt.email != null ? ` as ${chatgpt.email}` : ""}.{" "}
            {chatgpt.planUsage ? "Agents set to OpenAI models use your ChatGPT plan." : "You didn’t allow this app to use your plan, so OpenAI requests can’t run yet."}
          </p>
          <div className="inline-form">
            {chatgpt.planUsage ? (
              <button type="button" className="button" onClick={() => void main.openInBrowser({ url: CHATGPT_USAGE_URL })}>
                Manage usage
              </button>
            ) : (
              <button type="button" className="button button--primary" disabled={chatgpt.signingIn} onClick={() => void signIn()}>
                Allow plan usage
              </button>
            )}
            <button type="button" className="button button--ghost" onClick={async () => setModelSettings(await main.signOutChatGpt())}>
              Sign out
            </button>
          </div>
        </div>
      )}
      {error != null ? <div className="form-error">{error}</div> : null}
    </ProviderCard>
  );
}

function AnthropicCard({ settings }: { settings: ModelSettings }) {
  return (
    <ProviderCard title="Anthropic" ready={settings.anthropic.hasApiKey} status={settings.anthropic.hasApiKey ? "API key saved" : "Not connected"}>
      <ApiKeyForm provider="anthropic" hasKey={settings.anthropic.hasApiKey} placeholder="sk-ant-…" />
      <p className="muted">Uses the Claude API with your Console key (claude-opus-5-5 by default). To use a Claude Pro or Max plan instead, use Claude Code below.</p>
    </ProviderCard>
  );
}

const AUTH_METHODS: Record<string, string> = {
  "claude.ai": "your Claude account",
  oauth_token: "a Claude token",
  api_key: "an API key",
  api_key_helper: "an API key helper",
  third_party: "a cloud provider",
};

function ClaudeCodeCard({ settings }: { settings: ModelSettings }) {
  const status = settings.claudeCode;
  const [checking, setChecking] = useState(false);
  const [path, setPath] = useState(status.executable ?? "");
  const [error, setError] = useState<string | null>(null);
  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      setModelSettings(await main.checkClaudeCode());
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setChecking(false);
    }
  };
  const label = !status.installed ? "Not found" : status.signedIn ? `Signed in with ${AUTH_METHODS[status.authMethod ?? ""] ?? "Claude Code"}` : "Not signed in";
  // With a remote box, Claude Code runs there and is signed in there, through Anthropic's own flow.
  const onBox = settings.boxLocation === "remote";
  return (
    <ProviderCard title="Claude Code" ready={status.installed && status.signedIn} status={onBox ? `${label} on your box` : label}>
      {onBox ? (
        <p className="muted">
          Agents set to Claude Code are run by Claude Code on your box server, in their folder there. Sign in on the server with Claude Code’s own flow (<span className="mono">docker compose exec -it box claude auth login</span>); this app never sees
          those credentials. Its permission prompts appear here as approval cards.
        </p>
      ) : (
        <p className="muted">
          Agents set to Claude Code are run by your own Claude Code app, in their workspace folder, with its built-in tools. It uses Claude Code’s own sign-in (a Claude plan or a key you set up there), so this app never sees those credentials. Its
          permission prompts appear here as approval cards.
        </p>
      )}
      {status.installed ? (
        <p className="mono muted">
          {status.executable} · v{status.version ?? "?"}
        </p>
      ) : onBox ? (
        <p>Rebuild the box image with CLAUDE_CODE=1 to install it there, sign in, then check again.</p>
      ) : (
        <p>
          Install Claude Code, sign in, then check again.{" "}
          <button type="button" className="link-button" onClick={() => void main.openInBrowser({ url: "https://code.claude.com/docs/en/setup" })}>
            How to install
          </button>
        </p>
      )}
      <div className="inline-form">
        <button type="button" className="button" disabled={checking} onClick={() => void check()}>
          {checking ? "Checking…" : "Check again"}
        </button>
        {status.installed && !status.signedIn && !onBox ? (
          <button type="button" className="button button--primary" onClick={() => void main.openClaudeCodeSignIn().catch((cause) => setError(errorText(cause)))}>
            Sign in…
          </button>
        ) : null}
      </div>
      {!onBox ? (
        <details className="provider-card__advanced">
          <summary>Executable</summary>
          <div className="inline-form">
            <input className="mono" value={path} onChange={(event) => setPath(event.target.value)} placeholder="Detected automatically" aria-label="Claude Code executable" />
            <button type="button" className="button" onClick={async () => setModelSettings(await main.updateModelSettings({ claudeCodeExecutable: path.trim().length > 0 ? path.trim() : null }))}>
              Save
            </button>
          </div>
        </details>
      ) : null}
      {error != null ? <div className="form-error">{error}</div> : null}
    </ProviderCard>
  );
}

const CUSTOM_PRESETS: Array<{ label: string; baseUrl: string }> = [
  { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { label: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { label: "LM Studio", baseUrl: "http://localhost:1234/v1" },
];

function CustomCard({ settings }: { settings: ModelSettings }) {
  const [baseUrl, setBaseUrl] = useState(settings.custom.baseUrl);
  const [error, setError] = useState<string | null>(null);
  const save = async (url: string) => {
    setError(null);
    try {
      setBaseUrl(url);
      await updateModels({ customBaseUrl: url });
      if (url.length > 0) await loadModels("custom", true);
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const configured = settings.custom.baseUrl.length > 0;
  return (
    <ProviderCard title="Custom endpoint" ready={configured} status={configured ? settings.custom.baseUrl : "Not set up"}>
      <p className="muted">Any OpenAI-compatible Chat Completions endpoint with tool calling.</p>
      <div className="inline-form">
        <input className="mono" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://…/v1" aria-label="Custom base URL" />
        <button type="button" className="button" onClick={() => void save(baseUrl.trim())}>
          Save
        </button>
        {configured ? (
          <button type="button" className="button button--ghost" onClick={() => void save("")}>
            Remove
          </button>
        ) : null}
      </div>
      <div className="preset-row">
        {CUSTOM_PRESETS.map((preset) => (
          <button key={preset.label} type="button" className="chip" onClick={() => void save(preset.baseUrl)}>
            {preset.label}
          </button>
        ))}
      </div>
      {configured ? <ApiKeyForm provider="custom" hasKey={settings.custom.hasApiKey} placeholder="API key (if the endpoint needs one)" /> : null}
      {error != null ? <div className="form-error">{error}</div> : null}
    </ProviderCard>
  );
}

export function CloudControls({ compact = false }: { compact?: boolean }) {
  const settings = useStore(cloudSettings);
  const status = useStore(cloudStatus);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (settings == null || !settings.hasApiKey) return null;
  const run = async (action: "start" | "pause" | "delete" | "viewer") => {
    setBusy(action);
    setMessage(await cloudAction(action));
    setBusy(null);
    setConfirmDelete(false);
  };
  const state = status?.state ?? "none";
  const label = { none: "Not created yet", starting: "Starting…", running: "Running", paused: "Paused", error: "Error" }[state];
  return (
    <div className="stack cloud-controls">
      <div className="cloud-status">
        <span className={`status-dot status-dot--${state === "running" ? "connected" : state === "error" ? "error" : state === "starting" ? "initializing" : "disconnected"}`} />
        <strong>{label}</strong>
        {!compact && status?.sandboxId != null ? <span className="mono muted">{status.sandboxId}</span> : null}
      </div>
      {state === "none" && !compact ? <p className="muted">It is created on an agent’s first cloud tool call, or now with Start.</p> : null}
      {status?.error != null ? <div className="form-error">{status.error}</div> : null}
      <div className="inline-form">
        {state !== "running" ? (
          <button type="button" className="button" disabled={busy != null} onClick={() => void run("start")}>
            {busy === "start" ? "Starting…" : state === "paused" ? "Resume" : "Start"}
          </button>
        ) : (
          <button type="button" className="button" disabled={busy != null} onClick={() => void run("pause")}>
            {busy === "pause" ? "Pausing…" : "Pause now"}
          </button>
        )}
        {settings.kind === "desktop" ? (
          <button type="button" className="button" disabled={busy != null} onClick={() => void run("viewer")}>
            {busy === "viewer" ? "Opening…" : "Watch desktop"}
          </button>
        ) : null}
        {!compact && status?.sandboxId != null ? (
          confirmDelete ? (
            <>
              <button type="button" className="button button--danger" disabled={busy != null} onClick={() => void run("delete")}>
                Delete it and its files
              </button>
              <button type="button" className="button button--ghost" onClick={() => setConfirmDelete(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className="button button--ghost" onClick={() => setConfirmDelete(true)}>
              Delete…
            </button>
          )
        ) : null}
      </div>
      {message != null ? <div className="form-error">{message}</div> : null}
    </div>
  );
}

function Cloud() {
  const settings = useStore(cloudSettings);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void refreshCloudStatus();
  }, []);
  if (settings == null) return null;
  const update = async (patch: Parameters<typeof main.updateCloudSettings>[0]) => cloudSettings.set(await main.updateCloudSettings(patch));
  return (
    <div className="settings-section">
      <h2>Cloud computer</h2>
      <p className="muted">
        Give agents a Linux computer in the cloud instead of this PC, so their commands and files never touch your machine. It is one E2B sandbox shared by your cloud agents, each in its own folder. It pauses itself when idle and resumes in about a second
        with its files and open programs intact. E2B bills per second while it runs (about $0.05 per vCPU-hour) and nothing for compute while it’s paused. Pick This PC or Cloud computer for each agent in its settings.
      </p>
      <Row
        title="E2B API key"
        description={
          <>
            {settings.hasApiKey ? "Saved and encrypted with your OS keychain." : "New E2B accounts start with free credit."}{" "}
            <button type="button" className="link-button" onClick={() => void main.openInBrowser({ url: "https://e2b.dev/dashboard" })}>
              Get a key
            </button>
          </>
        }
      >
        <form
          className="inline-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (key.trim().length === 0) return;
            setError(null);
            try {
              cloudSettings.set(await main.setCloudApiKey({ apiKey: key.trim() }));
              setKey("");
            } catch (cause) {
              setError(errorText(cause));
            }
          }}
        >
          <input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={settings.hasApiKey ? "••••••••••••  (saved)" : "e2b_…"} autoComplete="off" aria-label="E2B API key" />
          <button type="submit" className="button">
            Save
          </button>
          {settings.hasApiKey ? (
            <button type="button" className="button button--ghost" onClick={async () => cloudSettings.set(await main.clearCloudApiKey())}>
              Remove
            </button>
          ) : null}
        </form>
      </Row>
      <Row title="Type" description="Desktop adds a screen agents can see and operate with the mouse and keyboard, and that you can watch. Changing the type replaces the machine.">
        <div className="segmented">
          {(["headless", "desktop"] as const).map((kind) => (
            <button key={kind} type="button" className={settings.kind === kind ? "segmented--active" : ""} onClick={() => void update({ kind })}>
              {kind === "headless" ? "Headless" : "Desktop"}
            </button>
          ))}
        </div>
      </Row>
      <Row title="Pause after" description="Minutes without activity before it pauses and stops costing compute.">
        <select value={settings.idleMinutes} onChange={(event) => void update({ idleMinutes: Number(event.target.value) })} aria-label="Pause after">
          {[5, 10, 15, 30, 60].map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes} minutes
            </option>
          ))}
        </select>
      </Row>
      <Row title="Ask before running commands" description="It is isolated from this PC, so commands and file changes there run without asking unless you turn this on.">
        <Toggle checked={settings.askBeforeCommands} label="Ask before running commands" onChange={(value) => void update({ askBeforeCommands: value })} />
      </Row>
      {settings.hasApiKey ? (
        <>
          <h3>Status</h3>
          <CloudControls />
        </>
      ) : null}
      {error != null ? <div className="form-error">{error}</div> : null}
    </div>
  );
}

const PERMISSION_LABELS: Record<ToolPermission, string> = {
  guarded: "Ask for risky actions",
  trusted: "Always allow",
  ask_always: "Ask every time",
  blocked: "Blocked",
};

/** A site in the agent browser reads as the approval card put it ("typing and clicking on shop.example"). */
function scopeLabel(grant: { toolId: string; scope: string }): string | null {
  const scope = grant.scope.replace(/^deny:/, "");
  if (!scope.startsWith("site:")) return null;
  return `${grant.toolId === "browser.act" ? "typing and clicking" : "browsing"} on ${siteLabel(scope.slice(5))}`;
}

function Permissions() {
  const [tools, setTools] = useState<LocalToolInfo[]>([]);
  const [permissions, setPermissions] = useState<Record<string, ToolPermission>>({});
  const [grants, setGrants] = useState<Array<{ toolId: string; scope: string; grantedAt: number }>>([]);

  const refresh = async () => {
    setTools(await main.listLocalTools());
    setPermissions(await main.readToolPermission());
    setGrants(await main.listLocalToolStandingGrants());
  };
  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="settings-section">
      <h2>Permissions</h2>
      <p className="muted">What agents may do on this computer without asking. Writes inside an agent’s own workspace never ask; risky commands always ask.</p>
      {tools.map((tool) => (
        <Row key={tool.id} title={tool.label} description={tool.description}>
          <select
            value={permissions[tool.id] ?? tool.defaultPermission}
            onChange={async (event) => {
              await main.changeToolPermission({ toolId: tool.id, permission: event.target.value as ToolPermission });
              await refresh();
            }}
          >
            {(Object.keys(PERMISSION_LABELS) as ToolPermission[]).map((permission) => (
              <option key={permission} value={permission}>
                {PERMISSION_LABELS[permission]}
              </option>
            ))}
          </select>
        </Row>
      ))}
      <h3>Remembered decisions</h3>
      {grants.length === 0 ? (
        <p className="muted">None yet. Choosing “Always allow” or “Never” on an approval adds one here.</p>
      ) : (
        <>
          <ul className="grant-list">
            {grants.map((grant) => (
              <li key={`${grant.toolId}:${grant.scope}`}>
                <span className={`risk ${grant.scope.startsWith("deny:") ? "risk--dangerous" : "risk--read-only"}`}>{grant.scope.startsWith("deny:") ? "never" : "allow"}</span>
                <span className="mono">{grant.toolId}</span>
                <span className={`grant-list__scope${scopeLabel(grant) == null ? " mono" : ""}`} title={grant.scope.replace(/^deny:/, "")}>
                  {scopeLabel(grant) ?? grant.scope.replace(/^deny:/, "")}
                </span>
              </li>
            ))}
          </ul>
          <button type="button" className="button button--ghost" onClick={async () => (await main.forgetToolApprovals(), await refresh())}>
            Forget all remembered decisions
          </button>
        </>
      )}
    </div>
  );
}

function Mcp() {
  const { servers } = useStore(mcpServers);
  const onBox = useStore(modelSettings, (settings) => settings.boxLocation === "remote");
  useEffect(() => {
    void loadMcpServers();
  }, []);

  return (
    <div className="settings-section">
      <h2>MCP servers</h2>
      <p className="muted">
        Connect Model Context Protocol servers: remote ones by their URL, such as hosted connectors, or local commands. Their tools become available to every agent, and each tool asks before its first use.
        {onBox ? " They run on your box server. You sign in on this PC; the sign-in then moves to the box, which keeps it fresh." : ""}
      </p>
      <Row title="Connect Apps" description="Well-known apps such as GitHub, Linear, Notion and Stripe, ready to connect.">
        <button type="button" className="button" onClick={() => openConnectApps()}>
          <Icon name="plug" size={14} /> Browse apps
        </button>
      </Row>
      {servers.length > 0 ? (
        <ul className="mcp-list">
          {servers.map((server) => (
            <McpServerRow key={server.id} server={server} />
          ))}
        </ul>
      ) : null}
      <AddMcpServer />
    </div>
  );
}

function McpServerRow({ server }: { server: McpServerSummary }) {
  const update = setMcpState;
  return (
    <li className="mcp-server">
      <div className="mcp-server__head">
        <span className={`status-dot status-dot--${server.status}`} />
        <span className="mcp-server__name">{serverLabel(server)}</span>
        <span className="muted">{server.status === "connected" ? `${server.toolCount} tools${server.disabledToolCount > 0 ? `, ${server.disabledToolCount} off` : ""}` : MCP_STATUS[server.status]}</span>
        <button type="button" className="button button--ghost button--small" onClick={() => openConnectApps({ appId: server.pluginId, serverId: server.id })}>
          Manage
        </button>
        <Toggle checked={server.enabled} label={`Enable ${server.name}`} onChange={(value) => void gateway.setMcpServerEnabled({ serverId: server.id, enabled: value }).then(update)} />
        {/* A marketplace plugin's server goes when the plugin is uninstalled (Manage). */}
        {server.pluginId?.includes("@") === true ? null : (
          <button type="button" className="icon-button" aria-label={`Remove ${server.name}`} onClick={() => void gateway.dropMcpServer({ serverId: server.id }).then(update)}>
            <Icon name="trash" size={14} />
          </button>
        )}
      </div>
      <div className="mono muted mcp-server__command">{server.transport === "http" ? server.url : server.command}</div>
      {server.statusDetail?.kind === "load_error" ? <div className="form-error">{server.statusDetail.technicalDetail}</div> : null}
      {server.transport === "http" && server.enabled ? <McpSignIn server={server} /> : null}
      {server.status === "connected" && server.toolCount > 0 ? <McpTools server={server} /> : null}
    </li>
  );
}

/** The server's tools with their switches, read when opened. */
function McpTools({ server }: { server: McpServerSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="mcp-server__tools" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Show tools</summary>
      {open ? <McpToolList server={server} /> : null}
    </details>
  );
}

function About() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void main.getAppInfo().then(setInfo);
  }, []);
  if (info == null) return null;
  return (
    <div className="settings-section">
      <h2>About</h2>
      <Row title={info.name} description="A desktop app for personal AI agents.">
        <span className="mono">v{info.version}</span>
      </Row>
      <Row title="Electron">
        <span className="mono">{info.electron}</span>
      </Row>
      <Row title="Data folder" description={<span className="mono">{info.userDataDir}</span>}>
        <button type="button" className="button" onClick={() => void main.openWithDefaultApp({ path: info.userDataDir })}>
          Open
        </button>
      </Row>
      <Row title="Agent workspaces" description={<span className="mono">{info.workspaceRoot}</span>}>
        <button type="button" className="button" onClick={() => void main.openWithDefaultApp({ path: info.workspaceRoot }).catch(() => undefined)}>
          Open
        </button>
      </Row>
    </div>
  );
}
