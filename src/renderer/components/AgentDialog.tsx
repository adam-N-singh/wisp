// Create / edit agent dialog, and the delete confirmation.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AVATAR_COLORS, AVATAR_SHAPES, type AvatarColor, type AvatarShape, formatModelRef, type ModelRef, parseModelRef, SPEECH_PROVIDERS, type VoiceCapabilities } from "../../shared/model";
import { gateway } from "../bridge";
import { closeDialog, openDialog, openSettings, selectAgent } from "../store/app";
import { cloudSettings } from "../store/cloud";
import { modelSettings } from "../store/models";
import { useStore } from "../store/store";
import { getAgent, upsertAgent } from "../store/roster";
import { forgetVoiceCapabilities, sampleVoice, useVoiceCapabilities } from "../store/voice";
import { Avatar } from "./Avatar";
import { ModelPicker } from "./ModelPicker";

const READING_SPEEDS = [0.75, 1, 1.25, 1.5, 2];
const SPEECH_LABELS = { xai: "xAI", openai: "OpenAI" } as const;

/** The voice an agent's replies are read aloud in, and how fast; only voices of providers that can speak are offered. */
function VoicePicker({ capabilities, voiceId, speed, onVoice, onSpeed }: { capabilities: VoiceCapabilities | undefined; voiceId: string | null; speed: number; onVoice: (id: string | null) => void; onSpeed: (speed: number) => void }) {
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (capabilities == null) return <span className="muted">Checking what can read replies aloud…</span>;
  if (capabilities.speech == null) return <span className="muted">{capabilities.speechUnavailable}</span>;
  const label = (id: string) => capabilities.voices.find((voice) => voice.id === id)?.label ?? id.split(":")[1];
  const fallback = capabilities.speech.defaultVoiceId;
  const listed = voiceId == null || capabilities.voices.some((voice) => voice.id === voiceId);
  return (
    <>
      <div className="voice-picker">
        <select value={voiceId ?? ""} onChange={(event) => onVoice(event.target.value === "" ? null : event.target.value)} aria-label="Voice">
          <option value="">Default ({label(fallback)})</option>
          {SPEECH_PROVIDERS.map((provider) => {
            const voices = capabilities.voices.filter((voice) => voice.provider === provider);
            return voices.length > 0 ? (
              <optgroup key={provider} label={SPEECH_LABELS[provider]}>
                {voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.label}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
          {!listed && voiceId != null ? <option value={voiceId}>{voiceId} (not connected)</option> : null}
        </select>
        <select value={String(speed)} onChange={(event) => onSpeed(Number(event.target.value))} aria-label="Reading speed">
          {READING_SPEEDS.map((option) => (
            <option key={option} value={String(option)}>
              {option}×
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button button--ghost"
          disabled={previewing}
          onClick={async () => {
            setPreviewing(true);
            setError(null);
            try {
              await sampleVoice(voiceId ?? fallback);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setPreviewing(false);
            }
          }}
        >
          {previewing ? "Playing…" : "Preview"}
        </button>
      </div>
      <span className="muted">{error ?? "Replies are read aloud in this voice when you select Read aloud under one."}</span>
    </>
  );
}

export function Modal({ title, children, onClose, wide = false, className }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog ref={dialog} className={`modal${wide ? " modal--wide" : ""}${className != null ? ` ${className}` : ""}`} onCancel={(event) => (event.preventDefault(), onClose())} aria-label={title}>
      <h2 className="modal__title">{title}</h2>
      {children}
    </dialog>
  );
}

export function AgentDialog({ agentId }: { agentId?: string }) {
  const existing = agentId != null ? getAgent(agentId) : undefined;
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [instructions, setInstructions] = useState(existing?.instructions ?? "");
  const [shape, setShape] = useState<AvatarShape>(existing?.avatarShape ?? AVATAR_SHAPES[Math.floor(Math.random() * AVATAR_SHAPES.length)]);
  const [color, setColor] = useState<AvatarColor>(existing?.avatarColor ?? AVATAR_COLORS[Math.floor(Math.random() * (AVATAR_COLORS.length - 1))]);
  const [model, setModel] = useState<ModelRef | null>(existing?.model ? parseModelRef(existing.model, modelSettings.get().defaultModel) : null);
  const [computer, setComputer] = useState<"local" | "cloud">(existing?.computer ?? "local");
  const [voiceId, setVoiceId] = useState<string | null>(existing?.voiceId ?? null);
  const [voiceSpeed, setVoiceSpeed] = useState(existing?.voiceSpeed ?? 1);
  const voiceCapabilities = useVoiceCapabilities(agentId ?? null);
  const cloud = useStore(cloudSettings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const profile = { name: name.trim(), description: description.trim(), avatarShape: shape, avatarColor: color };
      let id = agentId;
      if (id == null) {
        const { agent } = await gateway.addAgent({ ...profile, clientNonce: crypto.randomUUID() });
        upsertAgent(agent);
        id = agent.id;
      } else {
        await gateway.editAgent({ id, profile, editedFields: ["name", "description", "avatarShape", "avatarColor"] });
      }
      const updated = await gateway.updateAgentConfig({ id, instructions: instructions.trim(), model: model != null ? formatModelRef(model) : null, computer });
      if (updated != null) upsertAgent(updated);
      if (voiceId !== (existing?.voiceId ?? null) || voiceSpeed !== (existing?.voiceSpeed ?? 1)) await gateway.changeAgentVoice({ id, voiceId, voiceSpeed });
      // The model's provider and the voice decide who transcribes and speaks for it.
      forgetVoiceCapabilities(id);
      closeDialog();
      if (agentId == null) selectAgent(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  return (
    <Modal title={agentId == null ? "New agent" : `Edit ${existing?.name ?? "agent"}`} onClose={closeDialog} wide>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="agent-form__identity">
          <Avatar shape={shape} color={color} size={64} />
          <label className="grow">
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} autoFocus placeholder="Research assistant" />
          </label>
        </div>
        <label>
          Role
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} maxLength={2000} placeholder="What is this agent for? e.g. “Keeps my inbox and calendar under control.”" />
        </label>
        <label>
          Instructions <span className="muted">(optional)</span>
          <textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={4} maxLength={20000} placeholder="Preferences, context and rules the agent should always follow." />
        </label>
        <fieldset className="shape-picker">
          <legend>Look</legend>
          <div className="shape-picker__shapes">
            {AVATAR_SHAPES.map((option) => (
              <button key={option} type="button" className={`shape-option${option === shape ? " shape-option--selected" : ""}`} onClick={() => setShape(option)} aria-label={option} title={option}>
                <Avatar shape={option} color={color} size={28} />
              </button>
            ))}
          </div>
          <div className="shape-picker__colors">
            {AVATAR_COLORS.map((option) => (
              <button key={option} type="button" className={`color-option color-option--${option}${option === color ? " color-option--selected" : ""}`} onClick={() => setColor(option)} aria-label={option} title={option} />
            ))}
          </div>
        </fieldset>
        <div className="field">
          <span className="field__label">Model</span>
          <ModelPicker label="Model" value={model} onChange={setModel} allowDefault />
        </div>
        <div className="field">
          <span className="field__label">Computer</span>
          <div className="segmented" role="radiogroup" aria-label="Computer">
            <button type="button" role="radio" aria-checked={computer === "local"} className={computer === "local" ? "segmented--active" : ""} onClick={() => setComputer("local")}>
              This PC
            </button>
            <button type="button" role="radio" aria-checked={computer === "cloud"} className={computer === "cloud" ? "segmented--active" : ""} onClick={() => setComputer("cloud")}>
              Cloud computer
            </button>
          </div>
          <span className="muted">
            {computer === "local" ? (
              "Works on this computer, asking before risky actions."
            ) : cloud?.hasApiKey ? (
              "Works on your cloud Linux computer, isolated from this PC."
            ) : (
              <>
                The cloud computer isn’t set up yet.{" "}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    closeDialog();
                    openSettings("cloud");
                  }}
                >
                  Set it up
                </button>
              </>
            )}
          </span>
        </div>
        <div className="field">
          <span className="field__label">Voice</span>
          <VoicePicker capabilities={voiceCapabilities} voiceId={voiceId} speed={voiceSpeed} onVoice={setVoiceId} onSpeed={setVoiceSpeed} />
        </div>
        {error != null ? <div className="form-error">{error}</div> : null}
        <div className="modal__actions">
          {agentId == null ? (
            <>
              <button type="button" className="button button--ghost" onClick={() => openDialog({ kind: "add-bot" })}>
                From a template…
              </button>
              <span className="grow" />
            </>
          ) : null}
          <button type="button" className="button button--ghost" onClick={closeDialog}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={saving || name.trim().length === 0}>
            {saving ? "Saving…" : agentId == null ? "Create agent" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function DeleteAgentDialog({ agentId }: { agentId: string }) {
  const agent = getAgent(agentId);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Delete ${agent?.name ?? "agent"}?`} onClose={closeDialog}>
      <p className="muted">This removes the agent, its conversation, todos and automations. Files in its workspace folder stay on disk.</p>
      <div className="modal__actions">
        <button type="button" className="button button--ghost" onClick={closeDialog}>
          Cancel
        </button>
        <button
          type="button"
          className="button button--danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await gateway.removeAgents({ ids: [agentId] }).catch(() => undefined);
            closeDialog();
            selectAgent(null);
          }}
        >
          Delete
        </button>
      </div>
    </Modal>
  );
}
