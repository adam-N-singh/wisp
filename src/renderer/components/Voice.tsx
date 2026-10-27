// Voice in the conversation: a voice memo as a playable bubble with its transcript (the word being
// spoken is highlighted, and a click on a word plays from there, when the provider timed the
// words), and Read aloud under a reply, in the agent's voice.
import { type CSSProperties, type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentSummary, MessageEntry, TranscriptWord, VoiceMemo } from "../../shared/model";
import { useStore } from "../store/store";
import { claimPlayback, MEMO_SPEEDS, memoAudioUrl, memoSpeed, readAloud, readAloudErrors, readingAloud, releasePlayback, setMemoSpeed, stopReadingAloud, useVoiceCapabilities } from "../store/voice";
import { Icon } from "./icons";

/** "0:42", "1:05:09". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

interface WordSpan {
  start: number;
  end: number;
  startMs: number;
}

/** Where each timed word is in the transcript text; a word not found close after the previous one is skipped. */
export function wordSpans(text: string, words: TranscriptWord[] | undefined): WordSpan[] {
  const spans: WordSpan[] = [];
  const lower = text.toLowerCase();
  let cursor = 0;
  for (const word of words ?? []) {
    const token = word.text.trim().toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (token.length === 0) continue;
    const at = lower.indexOf(token, cursor);
    if (at < 0 || at - cursor > 60) continue;
    spans.push({ start: at, end: at + token.length, startMs: word.startMs });
    cursor = at + token.length;
  }
  return spans;
}

const highlights = () => (typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null);

/** The character under a point, in `container`'s text. */
function caretOffset(x: number, y: number, container: Node): number | null {
  const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position != null && container.contains(position.offsetNode)) return position.offset;
  const range = document.caretRangeFromPoint?.(x, y);
  return range != null && container.contains(range.startContainer) ? range.startOffset : null;
}

/** `quote`: what a memo sent as a reply answers, shown at the top of its card. */
export function VoiceMemoMessage({ entry, memo, quote }: { entry: MessageEntry; memo: VoiceMemo; quote?: ReactNode }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"idle" | "loading" | "playing" | "paused">("idle");
  const [positionMs, setPositionMs] = useState(0);
  /** The recording's own length once it's loaded; until then, as measured when it was recorded. */
  const [loadedMs, setLoadedMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(true);
  const speed = useStore(memoSpeed);
  const spans = useMemo(() => wordSpans(entry.content, memo.words), [entry.content, memo.words]);
  const durationMs = Math.max(1, loadedMs ?? memo.durationMs);

  const pause = useCallback(() => audio.current?.pause(), []);
  useEffect(
    () => () => {
      audio.current?.pause();
      audio.current = null;
      releasePlayback(pause);
    },
    [pause],
  );
  useEffect(() => {
    if (audio.current != null) audio.current.playbackRate = speed;
  }, [speed]);

  // Follows playback smoothly while it plays; timeupdate covers frames that don't paint.
  useEffect(() => {
    if (state !== "playing") return;
    let frame = 0;
    const tick = () => {
      if (audio.current != null) setPositionMs(audio.current.currentTime * 1000);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state]);

  // The word being spoken, painted as a highlight so the transcript stays one text node that find in chat can paint too.
  useEffect(() => {
    const registry = highlights();
    const node = transcript.current?.firstChild;
    if (registry == null || state !== "playing" || !(node instanceof Text) || spans.length === 0) return;
    let current: WordSpan | undefined;
    for (const span of spans) {
      if (span.startMs > positionMs) break;
      current = span;
    }
    if (current == null || current.end > node.length) return;
    const range = new Range();
    range.setStart(node, current.start);
    range.setEnd(node, current.end);
    registry.set("voice-word", new Highlight(range));
    return () => void registry.delete("voice-word");
  }, [state, positionMs, spans]);

  const element = async (): Promise<HTMLAudioElement> => {
    if (audio.current != null) return audio.current;
    setState("loading");
    const created = new Audio(await memoAudioUrl(memo.path));
    created.playbackRate = memoSpeed.get();
    created.onplay = () => setState("playing");
    created.onpause = () => setState((current) => (current === "playing" ? "paused" : current));
    created.onended = () => {
      setState("idle");
      setPositionMs(0);
      releasePlayback(pause);
    };
    created.ontimeupdate = () => setPositionMs(created.currentTime * 1000);
    created.ondurationchange = () => {
      if (Number.isFinite(created.duration) && created.duration > 0) setLoadedMs(created.duration * 1000);
    };
    created.onerror = () => {
      setError("The recording couldn’t be played.");
      setState("idle");
    };
    audio.current = created;
    return created;
  };

  const play = async (fromMs?: number) => {
    setError(null);
    try {
      const target = await element();
      if (fromMs != null) {
        target.currentTime = fromMs / 1000;
        setPositionMs(fromMs);
      }
      claimPlayback(pause);
      await target.play();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setState((current) => (current === "loading" ? "idle" : current));
    }
  };

  const seek = (ms: number) => {
    if (audio.current == null) return void play(ms);
    audio.current.currentTime = ms / 1000;
    setPositionMs(ms);
  };

  const playFromWord = (event: MouseEvent<HTMLDivElement>) => {
    if (spans.length === 0 || transcript.current == null || (window.getSelection()?.toString() ?? "").length > 0) return;
    const offset = caretOffset(event.clientX, event.clientY, transcript.current);
    const span = offset != null ? spans.find((candidate) => offset >= candidate.start && offset <= candidate.end) : undefined;
    if (span != null) void play(span.startMs);
  };

  const shownMs = Math.min(positionMs, durationMs);
  const nextSpeed = MEMO_SPEEDS[(MEMO_SPEEDS.indexOf(speed as (typeof MEMO_SPEEDS)[number]) + 1) % MEMO_SPEEDS.length];
  return (
    <div className="message message--user">
      <div className="voice-memo" role="group" aria-label={`Voice memo, ${formatDuration(durationMs)}`}>
        {quote}
        <div className="voice-memo__player">
          <button type="button" className="voice-memo__play" aria-label={state === "playing" ? "Pause the voice memo" : "Play the voice memo"} disabled={state === "loading"} onClick={() => (state === "playing" ? audio.current?.pause() : void play())}>
            <Icon name={state === "playing" ? "pause" : "play"} size={14} />
          </button>
          <input
            type="range"
            className="voice-memo__seek"
            min={0}
            max={Math.round(durationMs)}
            step={100}
            value={Math.round(shownMs)}
            onChange={(event) => seek(Number(event.target.value))}
            aria-label="Position in the voice memo"
            aria-valuetext={formatDuration(shownMs)}
            style={{ "--progress": `${(shownMs / durationMs) * 100}%` } as CSSProperties}
          />
          <span className="voice-memo__time">{state === "idle" && positionMs === 0 ? formatDuration(durationMs) : `${formatDuration(shownMs)} / ${formatDuration(durationMs)}`}</span>
          <button type="button" className="voice-memo__speed" aria-label={`Playback speed ${speed}×, change it`} title="Playback speed" onClick={() => setMemoSpeed(nextSpeed)}>
            {speed}×
          </button>
        </div>
        {showTranscript && entry.content.length > 0 ? (
          <div ref={transcript} className={`voice-memo__transcript${spans.length > 0 ? " voice-memo__transcript--timed" : ""}`} title={spans.length > 0 ? "Click a word to play from there" : undefined} onClick={playFromWord}>
            {entry.content}
          </div>
        ) : null}
        <div className="voice-memo__footer">
          <button type="button" className="link-button" aria-expanded={showTranscript} onClick={() => setShowTranscript((open) => !open)}>
            {showTranscript ? "Hide transcript" : "Show transcript"}
          </button>
          {error != null ? <span className="voice-memo__error">{error}</span> : null}
        </div>
      </div>
    </div>
  );
}

/** A voice memo on its way to the box. */
export function PendingVoiceMemo({ durationMs }: { durationMs: number }) {
  return (
    <span className="attachment-chip">
      <Icon name="waveform" size={14} />
      Voice memo · {formatDuration(durationMs)}
    </span>
  );
}

/** Under a reply: Read aloud, in the agent's voice; Stop while it reads. Hidden when no connected provider can speak. */
export function ReadAloud({ agent, entry }: { agent: AgentSummary; entry: MessageEntry }) {
  const capabilities = useVoiceCapabilities(agent.id);
  const current = useStore(readingAloud, (state) => (state?.agentId === agent.id && state.entryId === entry.id ? state : null));
  const error = useStore(readAloudErrors, (state) => state[entry.id]);
  // Leaving the conversation stops reading it.
  useEffect(
    () => () => {
      if (readingAloud.get()?.entryId === entry.id) stopReadingAloud();
    },
    [entry.id],
  );
  if (capabilities?.speech == null && current == null && error == null) return null;
  const label =
    current == null ? null : current.state === "loading" && current.part === 0 ? "Getting the audio…" : current.parts != null && current.parts > 1 ? `Reading, part ${current.part + 1} of ${current.parts}` : "Reading aloud";
  return (
    <div className={`read-aloud${current != null ? " read-aloud--active" : ""}`}>
      <button
        type="button"
        className="read-aloud__button"
        aria-label={current != null ? "Stop reading aloud" : "Read aloud"}
        title={current != null ? "Stop" : "Read aloud"}
        onClick={() => (current != null ? stopReadingAloud() : void readAloud(agent, entry.id))}
      >
        <Icon name={current != null ? "stop" : "speaker"} size={14} />
        {label != null ? <span className={current?.state === "loading" ? "shimmer" : undefined}>{label}</span> : null}
      </button>
      {error != null ? <span className="read-aloud__error">{error}</span> : null}
    </div>
  );
}
