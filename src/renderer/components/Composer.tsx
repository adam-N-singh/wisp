// Prompt composer: Enter sends, Shift+Enter adds a line; files attach by
// paste, drag-and-drop or the paperclip; Stop interrupts a running agent.
// Typing "/" at the start opens the agent's skills: arrows move, Enter or Tab
// picks one ("/<command> ", which the box runs as that skill; a plugin's is
// "/<plugin>:<skill>", as Claude Code writes it), Esc closes.
// A reply started from a message's toolbar shows its quote above the text and
// goes out with the next message or voice memo; Esc or × drops it.
// Voice: Ctrl+D or the microphone dictates into the box.
// Click (or a short press) starts and the next one stops; holding 500 ms or
// more talks until you let go. "Listening…" and "Transcribing…" take the
// placeholder's place, and Esc cancels. When a connected provider can
// transcribe, "+" offers Attach files and Record a voice memo, which sends the
// recording with its transcript.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type AgentSummary, CHATGPT_USAGE_URL, isSessionRunning, type Skill, usesChatGptPlan } from "../../shared/model";
import type { StagedAttachment } from "../../shared/edges";
import { desktop, gateway, main } from "../bridge";
import { isModKey, MOD_LABEL, shortcutKey } from "../shortcuts";
import { skillMatches, slashCommand, slashQuery } from "../skill-menu";
import { loadSkills, skills } from "../store/agent-data";
import { effectiveModel, modelLabel, modelSettings } from "../store/models";
import { allAgents, roster } from "../store/roster";
import { useStore } from "../store/store";
import { cancelReply, replyTargets, deliverMessage } from "../store/transcripts";
import { loadVoiceCapabilities, type RecordedAudio, type Recording, stageRecording, startRecording, transcribeRecording, useVoiceCapabilities } from "../store/voice";
import { AgentAvatar } from "./AgentAvatar";
import { Icon } from "./icons";
import { formatDuration } from "./Voice";

const drafts = new Map<string, string>();
const MENU_ROWS = 8;
/** Holding Ctrl+D or the microphone this long talks until you let go; a shorter press starts, and the next one stops. */
const HOLD_MS = 500;

type Purpose = "dictation" | "memo";
type Voice =
  | { kind: "idle" }
  | { kind: "starting"; purpose: Purpose }
  | { kind: "listening"; purpose: Purpose; recording: Recording }
  | { kind: "transcribing"; purpose: Purpose }
  /** A voice memo that didn't go: its recording waits for Retry or Discard. */
  | { kind: "memo-failed"; audio: RecordedAudio; staged: StagedAttachment | null; error: string };

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Puts the caret in the open conversation's message box (Ctrl+I). */
export function focusComposer(): void {
  document.querySelector<HTMLTextAreaElement>(".composer__input")?.focus();
}

/** In a group chat, what an "@" offers: "everyone" (with two or more members) and the members. */
interface MentionOption {
  id: string;
  label: string;
  description: string;
}

/** The "@" being typed just before the caret, and what follows it so far. */
const MENTION_AT_CARET = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u;

/** Options whose name contains what follows the "@" (spaces ignored), those that start with it first. */
function mentionMatches(members: AgentSummary[], query: string): MentionOption[] {
  const wanted = query.toLowerCase();
  const squash = (text: string) => text.toLowerCase().replace(/\s+/g, "");
  const options: MentionOption[] = [
    ...(members.length >= 2 ? [{ id: "everyone", label: "everyone", description: `All ${members.length} bots` }] : []),
    ...members.map((member) => ({ id: member.id, label: member.name, description: member.description })),
  ];
  return options
    .filter((option) => squash(option.label).includes(wanted))
    .sort((a, b) => Number(!squash(a.label).startsWith(wanted)) - Number(!squash(b.label).startsWith(wanted)))
    .slice(0, MENU_ROWS);
}

export function Composer({ agent }: { agent: AgentSummary }) {
  const [text, setText] = useState(() => drafts.get(agent.id) ?? "");
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const settings = useStore(modelSettings);
  const model = effectiveModel(agent, settings);
  const onPlan = usesChatGptPlan(model, settings);
  const agentSkills = useStore(skills, (state) => state[agent.id]);
  const reply = useStore(replyTargets, (state) => state[agent.id]);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const capabilities = useVoiceCapabilities(agent.id);
  const [voice, setVoiceState] = useState<Voice>({ kind: "idle" });
  const voiceRef = useRef<Voice>(voice);
  /** When Ctrl+D or the microphone went down, while it's held. */
  const heldSince = useRef<number | null>(null);
  const starting = useRef<Promise<void> | null>(null);
  /** Bumped by every cancel, so an answer that arrives afterwards is dropped. */
  const voiceSession = useRef(0);
  const textNow = useRef(text);
  textNow.current = text;
  // A group chat has no skills of its own: its "@" menu lists its members instead.
  const query = agent.isGroup ? null : slashQuery(text);
  const matches = query == null || menuDismissed ? [] : skillMatches(agentSkills ?? [], query, MENU_ROWS);
  const active = Math.min(menuIndex, matches.length - 1);
  const everyone = useStore(roster);
  const [caret, setCaret] = useState(text.length);
  const members = agent.isGroup ? agent.memberIds.flatMap((id) => allAgents(everyone).filter((candidate) => candidate.id === id)) : [];
  const mention = agent.isGroup && !menuDismissed ? MENTION_AT_CARET.exec(text.slice(0, caret)) : null;
  const mentions = mention == null ? [] : mentionMatches(members, mention[1]);
  const activeMention = Math.min(menuIndex, mentions.length - 1);

  const setVoice = (next: Voice) => {
    voiceRef.current = next;
    setVoiceState(next);
  };

  useEffect(() => {
    setText(drafts.get(agent.id) ?? "");
    setAttachments([]);
    setError(null);
    setMenuDismissed(false);
    input.current?.focus();
    void loadSkills(agent.id);
  }, [agent.id]);

  useEffect(() => {
    const element = input.current;
    if (element == null) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [text]);

  // A picked @mention puts the caret after it as soon as the text is in, before the next key lands.
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCaret.current == null) return;
    input.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [text]);

  const addFiles = async (files: File[]) => {
    setError(null);
    if (agent.isGroup) {
      if (files.length > 0) setError("Group chats take text messages only for now.");
      return;
    }
    for (const file of files) {
      try {
        const staged = await desktop.local.stageAttachmentFile(file, file.name || "pasted.png");
        setAttachments((current) => [...current, staged]);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  };

  const send = () => {
    const prompt = text.trim();
    if (prompt.length === 0 && attachments.length === 0) return;
    deliverMessage(
      agent.id,
      prompt,
      attachments.map((attachment) => ({ path: attachment.path, name: attachment.name })),
      { reply },
    );
    setText("");
    drafts.delete(agent.id);
    setAttachments([]);
    setMenuDismissed(false);
    cancelReply(agent.id);
  };

  const removeAttachment = (attachment: StagedAttachment) => {
    setAttachments((current) => current.filter((item) => item.path !== attachment.path));
    void main.dropStagedUpload({ path: attachment.path });
  };

  const edit = (value: string, at = value.length) => {
    setText(value);
    setCaret(at);
    drafts.set(agent.id, value);
    setMenuIndex(0);
    if (!value.startsWith("/") && !(agent.isGroup && MENTION_AT_CARET.test(value.slice(0, at)))) setMenuDismissed(false);
  };

  const pickSkill = (skill: Skill) => {
    const value = `/${slashCommand(skill)} `;
    edit(value);
    requestAnimationFrame(() => input.current?.setSelectionRange(value.length, value.length));
  };

  /** Puts "@Name " in place of the "@" being typed. */
  const pickMention = (option: MentionOption) => {
    if (mention == null) return;
    const before = text.slice(0, caret - mention[1].length - 1);
    const inserted = `@${option.label} `;
    const after = text.slice(caret).replace(/^\s+/, "");
    pendingCaret.current = before.length + inserted.length;
    edit(`${before}${inserted}${after}`, before.length + inserted.length);
  };

  // ---- voice ------------------------------------------------------------------------------

  /** Puts dictated text where the caret is, with a space either side as needed. */
  const insertText = (spoken: string) => {
    const element = input.current;
    const current = textNow.current;
    const start = element?.selectionStart ?? current.length;
    const end = element?.selectionEnd ?? start;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
    const trail = after.length > 0 && !/^\s/.test(after) ? " " : "";
    edit(`${before}${lead}${spoken}${trail}${after}`);
    const caret = before.length + lead.length + spoken.length;
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(caret, caret);
    });
  };

  const begin = (purpose: Purpose) => {
    if (voiceRef.current.kind !== "idle") return;
    setError(null);
    setActionsOpen(false);
    const session = voiceSession.current;
    setVoice({ kind: "starting", purpose });
    const run = (async () => {
      let known = await loadVoiceCapabilities(agent.id);
      if (known.transcription == null) known = await loadVoiceCapabilities(agent.id, true);
      if (session !== voiceSession.current) return;
      if (known.transcription == null) {
        heldSince.current = null;
        setVoice({ kind: "idle" });
        setError(known.transcriptionUnavailable ?? "No connected provider can transcribe speech.");
        return;
      }
      try {
        const recording = await startRecording();
        if (session !== voiceSession.current) return recording.cancel();
        setVoice({ kind: "listening", purpose, recording });
      } catch (cause) {
        if (session !== voiceSession.current) return;
        heldSince.current = null;
        setVoice({ kind: "idle" });
        setError(errorText(cause));
      }
    })();
    starting.current = run;
    void run.finally(() => {
      if (starting.current === run) starting.current = null;
    });
  };

  const dictate = async (audio: RecordedAudio, session: number) => {
    try {
      const transcription = await transcribeRecording(agent.id, await stageRecording(audio, "Dictation"), audio.mimeType, "Dictation");
      if (session !== voiceSession.current) return;
      setVoice({ kind: "idle" });
      if (transcription.text.length === 0) setError("No speech was heard. Try again a little closer to the microphone.");
      else insertText(transcription.text);
    } catch (cause) {
      if (session !== voiceSession.current) return;
      setVoice({ kind: "idle" });
      setError(errorText(cause));
    }
  };

  const sendMemo = async (audio: RecordedAudio, staged: StagedAttachment | null, session = voiceSession.current) => {
    setVoice({ kind: "transcribing", purpose: "memo" });
    let file = staged;
    try {
      file ??= await stageRecording(audio, "Voice memo");
      const transcription = await transcribeRecording(agent.id, file, audio.mimeType, "Voice memo");
      if (session !== voiceSession.current) return void main.dropStagedUpload({ path: file.path }).catch(() => undefined);
      if (transcription.text.length === 0) return setVoice({ kind: "memo-failed", audio, staged: file, error: "No speech was heard in the memo." });
      // A memo recorded while replying goes out as that reply, like a typed message.
      const replying = replyTargets.get()[agent.id];
      deliverMessage(agent.id, transcription.text, [{ path: file.path, name: file.name }], {
        // The length the recorder's timer showed, which the bubble repeats.
        voiceMemo: {
          durationMs: Math.round(audio.durationMs),
          provider: transcription.provider,
          ...(transcription.words != null ? { words: transcription.words } : {}),
        },
        reply: replying,
      });
      if (replying != null) cancelReply(agent.id);
      setVoice({ kind: "idle" });
    } catch (cause) {
      if (session !== voiceSession.current) {
        if (file != null) void main.dropStagedUpload({ path: file.path }).catch(() => undefined);
        return;
      }
      setVoice({ kind: "memo-failed", audio, staged: file, error: errorText(cause) });
    }
  };

  /** Stops listening and transcribes: dictation goes into the box, a memo is sent. */
  const finish = async () => {
    if (starting.current != null) await starting.current;
    const state = voiceRef.current;
    if (state.kind !== "listening") return;
    const session = voiceSession.current;
    setVoice({ kind: "transcribing", purpose: state.purpose });
    let audio: RecordedAudio;
    try {
      audio = await state.recording.stop();
    } catch (cause) {
      if (session !== voiceSession.current) return;
      setVoice({ kind: "idle" });
      setError(errorText(cause));
      return;
    }
    if (session !== voiceSession.current) return;
    if (state.purpose === "dictation") await dictate(audio, session);
    else await sendMemo(audio, null, session);
  };

  const cancelVoice = () => {
    const state = voiceRef.current;
    voiceSession.current++;
    heldSince.current = null;
    if (state.kind === "listening") state.recording.cancel();
    if (state.kind === "memo-failed" && state.staged != null) void main.dropStagedUpload({ path: state.staged.path }).catch(() => undefined);
    if (state.kind !== "idle") setVoice({ kind: "idle" });
  };

  const toggleDictation = () => {
    const state = voiceRef.current;
    if (state.kind === "idle") begin("dictation");
    else if ((state.kind === "starting" || state.kind === "listening") && state.purpose === "dictation") void finish();
  };

  /** Ends a hold: long enough means push-to-talk, so letting go stops; a short press keeps listening until the next one. */
  const release = () => {
    if (heldSince.current == null) return;
    const heldFor = Date.now() - heldSince.current;
    heldSince.current = null;
    if (heldFor >= HOLD_MS) void finish();
  };

  const voiceActions = useRef({ begin, cancelVoice, release, toggleDictation });
  voiceActions.current = { begin, cancelVoice, release, toggleDictation };

  // Ctrl+D anywhere in the conversation, and Esc to cancel; before the app's other key handlers.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (voiceRef.current.kind === "idle") return;
        event.preventDefault();
        voiceActions.current.cancelVoice();
        return;
      }
      if (!isModKey(event) || event.shiftKey || event.altKey || shortcutKey(event) !== "d" || document.querySelector("dialog[open]") != null) return;
      event.preventDefault();
      if (event.repeat) return;
      if (voiceRef.current.kind === "idle") heldSince.current = Date.now();
      voiceActions.current.toggleDictation();
    };
    const up = (event: KeyboardEvent) => {
      if (shortcutKey(event) === "d" || event.key === "Control" || event.key === "Meta") voiceActions.current.release();
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, []);

  // Switching agents (or leaving) drops a recording in progress.
  useEffect(() => () => voiceActions.current.cancelVoice(), [agent.id]);

  const dictating = (voice.kind === "starting" || voice.kind === "listening") && voice.purpose === "dictation";
  const memoActive = voice.kind === "memo-failed" || (voice.kind !== "idle" && voice.purpose === "memo");
  const canRecordMemo = capabilities?.transcription != null;
  const placeholder = agent.isGroup ? "Message group" : agent.awaitingUserResponse?.reason === "question" ? "Answer the question…" : `Message ${agent.name}`;
  const shownPlaceholder = dictating ? "Listening…" : voice.kind === "transcribing" && voice.purpose === "dictation" ? "Transcribing…" : placeholder;

  return (
    <form
      className={`composer${dragging ? " composer--dragging" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (dictating) void finish();
        else send();
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void addFiles([...event.dataTransfer.files]);
      }}
    >
      {attachments.length > 0 ? (
        <div className="composer__attachments">
          {attachments.map((attachment) => (
            <span key={attachment.path} className="attachment-chip">
              {attachment.mime.startsWith("image/") ? <img src={desktop.local.mediaUrl(attachment.path)} alt="" /> : <Icon name="file" size={14} />}
              <span>{attachment.name}</span>
              <button type="button" className="icon-button icon-button--small" aria-label={`Remove ${attachment.name}`} onClick={() => removeAttachment(attachment)}>
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {error != null ? <div className="composer__error">{error}</div> : null}
      {reply != null ? (
        <div className="composer__reply">
          <Icon name="reply" size={14} />
          <div className="composer__reply-body">
            <span className="composer__reply-author">{reply.role === "assistant" ? `Replying to ${agent.name}` : "Replying to your message"}</span>
            <span className="composer__reply-quote">{reply.quote}</span>
          </div>
          <button type="button" className="icon-button icon-button--small" aria-label="Don’t reply to this message" title="Don’t reply (Esc)" onClick={() => cancelReply(agent.id)}>
            <Icon name="close" size={12} />
          </button>
        </div>
      ) : null}
      {matches.length > 0 ? (
        <div className="slash-menu" role="listbox" id={`skill-menu-${agent.id}`} aria-label="Skills">
          <div className="slash-menu__title">Skills</div>
          {matches.map((skill, index) => (
            <div
              key={skill.id}
              id={`skill-option-${skill.id}`}
              role="option"
              aria-selected={index === active}
              className={`slash-menu__item${index === active ? " slash-menu__item--active" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                pickSkill(skill);
              }}
              onMouseEnter={() => setMenuIndex(index)}
            >
              <Icon name="bolt" size={14} />
              <span className="slash-menu__name">{skill.source === "plugin" ? `/${slashCommand(skill)}` : skill.name}</span>
              <span className="slash-menu__description">{skill.description}</span>
            </div>
          ))}
        </div>
      ) : null}
      {mentions.length > 0 ? (
        <div className="slash-menu" role="listbox" id={`mention-menu-${agent.id}`} aria-label="Mention">
          <div className="slash-menu__title">Mention</div>
          {mentions.map((option, index) => (
            <div
              key={option.id}
              id={`mention-option-${option.id}`}
              role="option"
              aria-selected={index === activeMention}
              className={`slash-menu__item${index === activeMention ? " slash-menu__item--active" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                pickMention(option);
              }}
              onMouseEnter={() => setMenuIndex(index)}
            >
              {option.id === "everyone" ? <Icon name="users" size={14} /> : <AgentAvatar agent={members.find((member) => member.id === option.id)!} size={16} />}
              <span className="slash-menu__name">{option.label}</span>
              <span className="slash-menu__description">{option.description}</span>
            </div>
          ))}
        </div>
      ) : null}
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          void addFiles([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      {memoActive ? (
        <MemoRecorder
          voice={voice}
          onCancel={cancelVoice}
          onSend={() => void finish()}
          onRetry={() => {
            if (voice.kind === "memo-failed") void sendMemo(voice.audio, voice.staged);
          }}
        />
      ) : (
        <div className="composer__row">
          {agent.isGroup ? null : canRecordMemo ? (
            <div
              className="composer__actions"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActionsOpen(false);
              }}
            >
              <button
                type="button"
                className={`icon-button${actionsOpen ? " icon-button--active" : ""}`}
                aria-label="Composer actions"
                aria-haspopup="menu"
                aria-expanded={actionsOpen}
                title="Attach files or record a voice memo"
                onClick={() => setActionsOpen((open) => !open)}
              >
                <Icon name="plus" />
              </button>
              {actionsOpen ? (
                <div
                  className="composer-menu"
                  role="menu"
                  aria-label="Composer actions"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setActionsOpen(false);
                    }
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="composer-menu__item"
                    autoFocus
                    onClick={() => {
                      setActionsOpen(false);
                      picker.current?.click();
                    }}
                  >
                    <Icon name="paperclip" size={14} />
                    Attach files
                  </button>
                  <button type="button" role="menuitem" className="composer-menu__item" onClick={() => begin("memo")}>
                    <Icon name="waveform" size={14} />
                    Record a voice memo
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <button type="button" className="icon-button" aria-label="Attach files" title="Attach files" onClick={() => picker.current?.click()}>
              <Icon name="paperclip" />
            </button>
          )}
          <textarea
            ref={input}
            className="composer__input"
            rows={1}
            value={text}
            placeholder={shownPlaceholder}
            aria-label={placeholder}
            aria-autocomplete="list"
            aria-controls={matches.length > 0 ? `skill-menu-${agent.id}` : mentions.length > 0 ? `mention-menu-${agent.id}` : undefined}
            aria-activedescendant={matches.length > 0 ? `skill-option-${matches[active].id}` : mentions.length > 0 ? `mention-option-${mentions[activeMention].id}` : undefined}
            spellCheck
            onChange={(event) => edit(event.target.value, event.target.selectionStart ?? event.target.value.length)}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? text.length)}
            onPaste={(event) => {
              const files = [...event.clipboardData.files];
              if (files.length > 0) {
                event.preventDefault();
                void addFiles(files);
              }
            }}
            onKeyDown={(event) => {
              if (mentions.length > 0 && !event.nativeEvent.isComposing) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setMenuIndex((activeMention + (event.key === "ArrowDown" ? 1 : mentions.length - 1)) % mentions.length);
                  return;
                }
                if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                  event.preventDefault();
                  pickMention(mentions[activeMention]);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setMenuDismissed(true);
                  return;
                }
              }
              if (matches.length > 0 && !event.nativeEvent.isComposing) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setMenuIndex((active + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
                  return;
                }
                if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                  event.preventDefault();
                  pickSkill(matches[active]);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setMenuDismissed(true);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (dictating) void finish();
                else send();
              }
              // Unless that Esc already cancelled dictation or a memo (the window listener above runs first).
              if (event.key === "Escape" && reply != null && !event.nativeEvent.isComposing && !event.nativeEvent.defaultPrevented) {
                event.preventDefault();
                cancelReply(agent.id);
              }
            }}
          />
          <button
            type="button"
            className={`icon-button composer__mic${dictating ? " composer__mic--live" : ""}`}
            aria-label={dictating ? "Stop dictating" : "Dictate"}
            aria-pressed={dictating}
            title={dictating ? "Stop and transcribe" : capabilities != null && capabilities.transcription == null ? (capabilities.transcriptionUnavailable ?? "Dictate") : `Click or hold ${MOD_LABEL}+D to dictate`}
            disabled={voice.kind === "transcribing"}
            onMouseDown={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              if (voiceRef.current.kind === "idle") {
                heldSince.current = Date.now();
                event.currentTarget.setPointerCapture(event.pointerId);
              }
              toggleDictation();
            }}
            onPointerUp={release}
            onClick={(event) => {
              // Enter or Space on the focused button; pointer presses are handled above.
              if (event.detail === 0) toggleDictation();
            }}
          >
            {voice.kind === "listening" && dictating ? <LevelMeter recording={voice.recording} variant="ring" /> : null}
            <Icon name="mic" />
          </button>
          {isSessionRunning(agent) && text.trim().length === 0 && attachments.length === 0 ? (
            <button type="button" className="send-button send-button--stop" aria-label="Stop" title="Stop" onClick={() => void gateway.stopAgentRun({ id: agent.id })}>
              <Icon name="stop" />
            </button>
          ) : (
            <button type="submit" className="send-button" aria-label="Send" title="Send (Enter)" disabled={text.trim().length === 0 && attachments.length === 0}>
              <Icon name="send" />
            </button>
          )}
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {dictating ? "Listening" : voice.kind === "transcribing" ? "Transcribing" : ""}
      </span>
      <div className="composer__meta">
        {agent.isGroup ? (
          <span className="composer__model">{members.length === 1 ? "1 bot" : `${members.length} bots`}, each on its own model</span>
        ) : (
          <span className="composer__model" title="Change it in the agent’s settings">
            {modelLabel(model)}
          </span>
        )}
        {onPlan && !agent.isGroup ? (
          <>
            <span className="composer__plan">Using ChatGPT plan</span>
            <button type="button" className="link-button" onClick={() => void main.openInBrowser({ url: CHATGPT_USAGE_URL })}>
              Manage usage
            </button>
          </>
        ) : null}
      </div>
    </form>
  );
}

/** Takes the composer's row while a voice memo is recorded, transcribed and sent, or waits after a failure. */
function MemoRecorder({ voice, onCancel, onSend, onRetry }: { voice: Voice; onCancel: () => void; onSend: () => void; onRetry: () => void }) {
  const [now, setNow] = useState(Date.now());
  const listening = voice.kind === "listening";
  useEffect(() => {
    if (!listening) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [listening]);
  return (
    <div className={`memo-recorder${voice.kind === "memo-failed" ? " memo-recorder--failed" : ""}`} role="group" aria-label="Voice memo">
      <button type="button" className="icon-button" aria-label={voice.kind === "memo-failed" ? "Discard the voice memo" : "Cancel the voice memo"} title={voice.kind === "memo-failed" ? "Discard" : "Cancel (Esc)"} onClick={onCancel}>
        <Icon name={voice.kind === "memo-failed" ? "trash" : "close"} />
      </button>
      {voice.kind === "listening" ? (
        <>
          <span className="memo-recorder__dot" aria-hidden="true" />
          <span className="memo-recorder__time">{formatDuration(now - voice.recording.startedAt)}</span>
          <LevelMeter recording={voice.recording} variant="bars" />
          <span className="memo-recorder__hint">Recording a voice memo</span>
        </>
      ) : voice.kind === "memo-failed" ? (
        <span className="memo-recorder__error">
          Voice memo, {formatDuration(voice.audio.durationMs)}: {voice.error}
        </span>
      ) : (
        <span className="memo-recorder__status shimmer">{voice.kind === "starting" ? "Starting the microphone…" : "Transcribing…"}</span>
      )}
      {voice.kind === "memo-failed" ? (
        <button type="button" className="button button--small" onClick={onRetry}>
          Try again
        </button>
      ) : (
        <button type="button" className="send-button" aria-label="Send the voice memo" title="Send" disabled={voice.kind !== "listening"} onClick={onSend}>
          <Icon name="send" />
        </button>
      )}
    </div>
  );
}

/** How loud the microphone is: bars beside a memo's timer, or a ring around the microphone while dictating. */
function LevelMeter({ recording, variant }: { recording: Recording; variant: "bars" | "ring" }) {
  const meter = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      meter.current?.style.setProperty("--level", recording.level().toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [recording]);
  return (
    <span ref={meter} className={`level-meter level-meter--${variant}`} aria-hidden="true">
      {variant === "bars" ? (
        <>
          <i />
          <i />
          <i />
          <i />
          <i />
        </>
      ) : null}
    </span>
  );
}
