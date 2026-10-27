// First-run flow: welcome, connect a model, create the first agent.
import { useState } from "react";
import { DEFAULT_MODELS, type KeyedProvider, PROVIDER_LABELS, type ProviderId } from "../../shared/model";
import { gateway, main } from "../bridge";
import { closeDialog, selectAgent } from "../store/app";
import { modelSettings, setModelSettings } from "../store/models";
import { upsertAgent } from "../store/roster";
import { useStore } from "../store/store";
import { Modal } from "./AgentDialog";

type Choice = KeyedProvider | "chatgpt" | "claude-code" | "mock";

const CHOICES: Array<{ id: Choice; title: string; detail: string }> = [
  { id: "xai", title: "xAI API key", detail: "Grok models, billed to your xAI account." },
  { id: "openai", title: "OpenAI API key", detail: "GPT models, billed to your OpenAI API account." },
  { id: "chatgpt", title: "Continue with ChatGPT", detail: "Use your ChatGPT Plus or Pro plan’s included usage." },
  { id: "anthropic", title: "Anthropic API key", detail: "Claude models, billed to your Anthropic Console account." },
  { id: "claude-code", title: "Claude Code", detail: "Run agents with your installed Claude Code and its own sign-in (for example a Claude plan)." },
  { id: "mock", title: "Offline mock", detail: "Try the app without a network or an account." },
];

export function Onboarding() {
  const [step, setStep] = useState<"welcome" | "model" | "agent">("welcome");
  const [choice, setChoice] = useState<Choice>("xai");
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState("Wisp");
  const [role, setRole] = useState("A capable general assistant that can work on my computer.");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = useStore(modelSettings);

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      const { agent } = await gateway.addAgent({ name: name.trim(), description: role.trim(), clientNonce: crypto.randomUUID() });
      upsertAgent(agent);
      await main.changeOnboardingSeen({ seen: true });
      closeDialog();
      selectAgent(agent.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const useProvider = async (provider: ProviderId) => {
    setModelSettings(await main.updateModelSettings({ defaultModel: { provider, model: DEFAULT_MODELS[provider] } }));
    setStep("agent");
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      if (choice === "mock") {
        await useProvider("mock");
      } else if (choice === "chatgpt") {
        await main.updateModelSettings({ openaiAuth: "chatgpt" });
        const next = await main.startChatGptSignIn();
        setModelSettings(next);
        if (!next.openai.chatgpt.planUsage) throw new Error("You signed in but didn’t allow plan usage. Select Continue with ChatGPT again and allow it, or pick another option.");
        await useProvider("openai");
      } else if (choice === "claude-code") {
        const next = await main.checkClaudeCode();
        setModelSettings(next);
        if (!next.claudeCode.installed) throw new Error("Claude Code wasn’t found on this computer. Install it, then try again.");
        if (!next.claudeCode.signedIn) throw new Error("Claude Code isn’t signed in yet. Select Sign in to Claude Code, finish in the terminal window, then try again.");
        await useProvider("claude-code");
      } else {
        if (apiKey.trim().length === 0) throw new Error("Paste your API key first.");
        if (choice === "openai") await main.updateModelSettings({ openaiAuth: "api-key" });
        setModelSettings(await main.setProviderApiKey({ provider: choice, apiKey: apiKey.trim() }));
        await useProvider(choice);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^[\w/-]+: /, "") : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const keyed = choice === "xai" || choice === "openai" || choice === "anthropic";

  return (
    <Modal title="Welcome to Wisp" onClose={() => void main.changeOnboardingSeen({ seen: true }).then(closeDialog)} wide>
      {step === "welcome" ? (
        <div className="onboarding">
          <p>Agents here are personal bots you message like colleagues. Each one keeps its own conversation, todo list, workspace folder and schedules, and can work on this computer — reading files, running commands, taking screenshots — asking you first before anything risky.</p>
          <ul className="onboarding__points">
            <li>Agents keep working while the window is closed; they live in the tray.</li>
            <li>Mount an agent on your desktop to message it from anywhere and share a screen region (Alt+Shift+Space).</li>
            <li>Everything stays on this computer except requests to the model provider you choose.</li>
          </ul>
          <div className="modal__actions">
            <button type="button" className="button button--primary" onClick={() => setStep("model")}>
              Get started
            </button>
          </div>
        </div>
      ) : step === "model" ? (
        <form
          className="form onboarding"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <p>How should agents reach a model? You can connect more providers later in Settings → Models.</p>
          <div className="choice-grid" role="radiogroup" aria-label="Model provider">
            {CHOICES.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={choice === option.id}
                className={`choice${choice === option.id ? " choice--active" : ""}`}
                onClick={() => {
                  setChoice(option.id);
                  setError(null);
                }}
              >
                <span className="choice__title">{option.title}</span>
                <span className="choice__detail">{option.detail}</span>
              </button>
            ))}
          </div>
          {keyed ? (
            <label>
              {PROVIDER_LABELS[choice as KeyedProvider]} API key
              <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={choice === "xai" ? "xai-…" : choice === "openai" ? "sk-…" : "sk-ant-…"} autoComplete="off" />
              <span className="muted">Encrypted with your OS keychain and only sent to {PROVIDER_LABELS[choice as KeyedProvider]}.</span>
            </label>
          ) : null}
          {choice === "chatgpt" ? <p className="muted">Your browser opens to sign in. Requests then count toward your plan’s Codex and agent usage; you can cap this app in ChatGPT settings.</p> : null}
          {choice === "claude-code" ? (
            <div className="stack">
              <p className="muted">
                {settings.claudeCode.installed ? `Found Claude Code ${settings.claudeCode.version ?? ""}${settings.claudeCode.signedIn ? ", signed in." : ", not signed in yet."}` : "Claude Code needs to be installed on this computer."}
              </p>
              {settings.claudeCode.installed && !settings.claudeCode.signedIn ? (
                <div>
                  <button type="button" className="button" onClick={() => void main.openClaudeCodeSignIn().catch(() => undefined)}>
                    Sign in to Claude Code
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {error != null ? <div className="form-error">{error}</div> : null}
          <div className="modal__actions">
            <button type="submit" className="button button--primary" disabled={busy}>
              {busy ? (choice === "chatgpt" ? "Waiting for the browser…" : "Connecting…") : choice === "chatgpt" ? "Continue with ChatGPT" : "Continue"}
            </button>
          </div>
        </form>
      ) : (
        <form
          className="form onboarding"
          onSubmit={(event) => {
            event.preventDefault();
            void finish();
          }}
        >
          <p>Create your first agent. You can add more any time with the + button.</p>
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} />
          </label>
          <label>
            Role
            <textarea value={role} onChange={(event) => setRole(event.target.value)} rows={2} maxLength={2000} />
          </label>
          {error != null ? <div className="form-error">{error}</div> : null}
          <div className="modal__actions">
            <button type="submit" className="button button--primary" disabled={busy || name.trim().length === 0}>
              {busy ? "Creating…" : "Create agent"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
