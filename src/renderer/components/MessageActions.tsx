// What you can do with a message once it's in the conversation, from its hover toolbar: add a
// reaction, reply with a quote, copy it, and on the agent's replies vote Good or Bad. Reactions
// sit under the message as chips that toggle; a Bad vote asks for reasons. Changes show at once
// and the box confirms them (store/transcripts.ts).
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FEEDBACK_CATEGORIES, type FeedbackCategory, type MessageEntry, type Reaction, type TranscriptEntry } from "../../shared/model";
import { startReply, toggleReaction, voteOnReply } from "../store/transcripts";
import { focusComposer } from "./Composer";
import { Icon } from "./icons";

/** The picker's first row, then the rest. */
const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "🙏", "👀", "✅", "🔥"];
const MORE_REACTIONS = [
  "😀", "😊", "😍", "🤔", "😮", "😢", "😡", "😅", "🤯", "🥳", "😎", "🙈", "👏", "🙌", "💪", "👌", "🤝", "👎", "💯", "⭐",
  "✨", "🚀", "💡", "🎯", "📌", "📈", "📉", "🗓️", "⚠️", "❌", "❓", "🔒", "🧠", "🤖", "🛠️", "☕", "🍕", "💬", "🌟", "💀",
];
const PICKER_COLUMNS = 8;
/** Characters a reply quotes when nothing in the message is selected. */
const QUOTE_LENGTH = 280;

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/** A message's Markdown as one line of plain text, for quotes. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** The text selected inside `container`, if the selection is all inside it. */
function selectedText(container: HTMLElement | null): string {
  const selection = window.getSelection();
  if (container == null || selection == null || selection.isCollapsed) return "";
  if (!container.contains(selection.anchorNode) || !container.contains(selection.focusNode)) return "";
  return selection.toString().replace(/\s+/g, " ").trim();
}

/**
 * The hover toolbar. `text` is what Copy copies (no Copy without it) and what Reply quotes, unless
 * part of the message is selected or `quote` says otherwise.
 */
export function MessageToolbar({
  agentId,
  entry,
  role,
  text,
  quote = text,
  container,
  votable = false,
}: {
  agentId: string;
  entry: TranscriptEntry;
  role: "user" | "assistant";
  text: string;
  quote?: string;
  container: RefObject<HTMLElement | null>;
  votable?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<{ text: string; detail: string } | null>(null);
  const selection = useRef("");
  const reactButton = useRef<HTMLButtonElement>(null);
  const feedback = entry.kind === "message" ? entry.feedback : undefined;

  const fail = (text: string) => (cause: unknown) => {
    setError({ text, detail: cause instanceof Error ? cause.message : String(cause) });
    setTimeout(() => setError(null), 4_000);
  };
  const reply = () => {
    startReply(agentId, { entryId: entry.id, quote: clip(selection.current || plainText(quote), QUOTE_LENGTH), role });
    focusComposer();
  };
  const vote = (action: "up" | "down") => void voteOnReply(agentId, entry.id, feedback?.sentiment === action ? "revert" : action).catch(fail("Couldn’t save your vote."));

  return (
    <div
      className={`message-toolbar${picking ? " message-toolbar--open" : ""}`}
      role="toolbar"
      aria-label="Message actions"
      data-find-skip
      // Keep the page's selection (a reply quotes it) and the composer's focus.
      onMouseDown={(event) => {
        selection.current = selectedText(container.current);
        if ((event.target as HTMLElement).closest(".reaction-picker") == null) event.preventDefault();
      }}
    >
      <button ref={reactButton} type="button" className="message-toolbar__button" aria-label="Add reaction" title="Add reaction" aria-expanded={picking} onClick={() => setPicking((open) => !open)}>
        <Icon name="reaction" size={15} />
      </button>
      <button type="button" className="message-toolbar__button" aria-label="Reply" title="Reply" onClick={reply}>
        <Icon name="reply" size={15} />
      </button>
      {text.length > 0 ? (
        <button
          type="button"
          className="message-toolbar__button"
          aria-label="Copy"
          title={copied ? "Copied" : "Copy"}
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1_200);
            }, fail("Couldn’t copy it."));
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={15} />
        </button>
      ) : null}
      {votable ? (
        <>
          <span className="message-toolbar__divider" />
          <button type="button" className="message-toolbar__button" aria-label="Good response" title="Good response" aria-pressed={feedback?.sentiment === "up"} onClick={() => vote("up")}>
            <Icon name="thumbsUp" size={15} />
          </button>
          <button type="button" className="message-toolbar__button" aria-label="Bad response" title="Bad response" aria-pressed={feedback?.sentiment === "down"} onClick={() => vote("down")}>
            <Icon name="thumbsDown" size={15} />
          </button>
        </>
      ) : null}
      {error != null ? (
        <span className="message-toolbar__error" role="status" title={error.detail}>
          {error.text}
        </span>
      ) : null}
      {picking ? (
        <ReactionPicker
          trigger={reactButton}
          onPick={(emoji) => {
            setPicking(false);
            void toggleReaction(agentId, entry.id, emoji).catch(fail("Couldn’t add the reaction."));
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
}

/** A grid of emoji next to `trigger`; arrows move, Enter picks, Esc or a click elsewhere closes. */
export function ReactionPicker({ trigger, onPick, onClose }: { trigger: RefObject<HTMLElement | null>; onPick(emoji: string): void; onClose(): void }) {
  const picker = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  // Below the button when it fits, above it otherwise, always inside the window; it starts off-screen (CSS).
  useLayoutEffect(() => {
    const element = picker.current;
    const anchor = trigger.current?.getBoundingClientRect();
    if (element == null || anchor == null) return;
    const own = element.getBoundingClientRect();
    const below = anchor.bottom + 6;
    element.style.top = `${below + own.height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - own.height - 6)}px`;
    element.style.left = `${Math.min(Math.max(8, anchor.left), window.innerWidth - own.width - 8)}px`;
    element.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, [trigger]);

  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (!picker.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close.current();
    };
    // The picker stays put while the conversation scrolls, so it closes instead.
    const scrolled = (event: Event) => {
      if (!picker.current?.contains(event.target as Node)) close.current();
    };
    window.addEventListener("mousedown", outside);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", close.current);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", close.current);
    };
  }, [trigger]);

  const all = [...QUICK_REACTIONS, ...MORE_REACTIONS];
  const move = (from: number, key: string): number | null => {
    if (key === "ArrowRight") return Math.min(all.length - 1, from + 1);
    if (key === "ArrowLeft") return Math.max(0, from - 1);
    if (key === "ArrowDown") return Math.min(all.length - 1, from + PICKER_COLUMNS);
    if (key === "ArrowUp") return Math.max(0, from - PICKER_COLUMNS);
    if (key === "Home") return 0;
    if (key === "End") return all.length - 1;
    return null;
  };

  return (
    <div
      ref={picker}
      className="reaction-picker"
      role="dialog"
      aria-label="Add reaction"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close.current();
          trigger.current?.focus();
          return;
        }
        const buttons = [...(picker.current?.querySelectorAll<HTMLButtonElement>("button[data-emoji]") ?? [])];
        const next = move(buttons.indexOf(document.activeElement as HTMLButtonElement), event.key);
        if (next != null) {
          event.preventDefault();
          buttons[next]?.focus();
        }
      }}
    >
      <div className="reaction-picker__grid reaction-picker__grid--quick">
        {QUICK_REACTIONS.map((emoji) => (
          <button key={emoji} type="button" data-emoji={emoji} className="reaction-picker__emoji" aria-label={`React with ${emoji}`} onClick={() => onPick(emoji)}>
            {emoji}
          </button>
        ))}
      </div>
      <div className="reaction-picker__grid">
        {MORE_REACTIONS.map((emoji) => (
          <button key={emoji} type="button" data-emoji={emoji} className="reaction-picker__emoji" aria-label={`React with ${emoji}`} onClick={() => onPick(emoji)}>
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Under a message: its reactions as chips that toggle the user's own, and the user's vote on a reply. */
export function MessageFooter({ agentId, entry }: { agentId: string; entry: TranscriptEntry }) {
  const [picking, setPicking] = useState(false);
  const add = useRef<HTMLButtonElement>(null);
  const reactions = entry.reactions ?? [];
  const feedback = entry.kind === "message" ? entry.feedback : undefined;
  if (reactions.length === 0 && (feedback == null || feedback.state !== "voted")) return null;

  const groups = new Map<string, Reaction[]>();
  for (const reaction of reactions) groups.set(reaction.emoji, [...(groups.get(reaction.emoji) ?? []), reaction]);
  const react = (emoji: string) => void toggleReaction(agentId, entry.id, emoji).catch(() => undefined);

  return (
    <div className="message-footer" data-find-skip>
      {[...groups].map(([emoji, list]) => {
        const mine = list.some((reaction) => reaction.by === "user");
        return (
          <button
            key={emoji}
            type="button"
            className={`reaction${mine ? " reaction--mine" : ""}`}
            aria-pressed={mine}
            aria-label={mine ? `${emoji}: take your reaction back` : `${emoji}: react too`}
            title={mine ? "You reacted · click to take it back" : "React too"}
            onClick={() => react(emoji)}
          >
            <span className="reaction__emoji">{emoji}</span>
            {list.length > 1 ? <span className="reaction__count">{list.length}</span> : null}
          </button>
        );
      })}
      {reactions.length > 0 ? (
        <span className="reaction-add">
          <button ref={add} type="button" className="reaction reaction--add" aria-label="Add reaction" title="Add reaction" aria-expanded={picking} onClick={() => setPicking((open) => !open)}>
            <Icon name="reaction" size={14} />
          </button>
          {picking ? (
            <ReactionPicker
              trigger={add}
              onPick={(emoji) => {
                setPicking(false);
                react(emoji);
              }}
              onClose={() => setPicking(false)}
            />
          ) : null}
        </span>
      ) : null}
      {feedback?.state === "voted" ? <FeedbackMark agentId={agentId} entryId={entry.id} feedback={feedback} /> : null}
    </div>
  );
}

function FeedbackMark({ agentId, entryId, feedback }: { agentId: string; entryId: string; feedback: NonNullable<MessageEntry["feedback"]> }) {
  const label = feedback.sentiment === "up" ? "Good response" : "Bad response";
  const reasons = [...feedback.categories, ...(feedback.comment != null ? [`“${feedback.comment}”`] : [])].join(", ");
  return (
    <button
      type="button"
      className={`feedback-mark feedback-mark--${feedback.sentiment}`}
      aria-label={`You marked this a ${label.toLowerCase()}. Take the vote back`}
      title={`You marked this a ${label.toLowerCase()}${reasons.length > 0 ? `: ${reasons}` : ""} · click to take it back`}
      onClick={() => void voteOnReply(agentId, entryId, "revert").catch(() => undefined)}
    >
      <Icon name={feedback.sentiment === "up" ? "thumbsUp" : "thumbsDown"} size={13} />
    </button>
  );
}

/** After a Bad vote: the feedback reasons, an optional note, Submit or Skip. */
export function FeedbackReasons({ agentId, entry }: { agentId: string; entry: MessageEntry }) {
  const feedback = entry.feedback;
  const [chosen, setChosen] = useState<FeedbackCategory[]>(feedback?.categories ?? []);
  const [note, setNote] = useState(feedback?.comment ?? "");
  const [thanked, setThanked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = feedback?.state === "improve";

  useEffect(() => {
    if (!thanked) return;
    const timer = setTimeout(() => setThanked(false), 2_500);
    return () => clearTimeout(timer);
  }, [thanked]);

  if (thanked && !open) {
    return (
      <div className="feedback-thanks" role="status" data-find-skip>
        Thanks. Your feedback is kept with this reply.
      </div>
    );
  }
  if (!open) return null;

  const submit = (categories: FeedbackCategory[], comment: string) => {
    setError(null);
    setThanked(true);
    void voteOnReply(agentId, entry.id, "submit", categories, comment).catch((cause) => {
      setThanked(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };
  return (
    <div className="feedback-card" role="group" aria-label="What went wrong?" data-find-skip>
      <div className="feedback-card__head">
        <span className="feedback-card__title">What went wrong?</span>
        <button type="button" className="icon-button icon-button--small" aria-label="Skip the reasons" title="Skip" onClick={() => submit([], "")}>
          <Icon name="close" size={12} />
        </button>
      </div>
      <div className="feedback-card__reasons">
        {FEEDBACK_CATEGORIES.map((category) => (
          <button
            key={category}
            type="button"
            className="feedback-reason"
            aria-pressed={chosen.includes(category)}
            onClick={() => setChosen((current) => (current.includes(category) ? current.filter((item) => item !== category) : [...current, category]))}
          >
            {category}
          </button>
        ))}
      </div>
      <form
        className="feedback-card__note"
        onSubmit={(event) => {
          event.preventDefault();
          submit(chosen, note);
        }}
      >
        <input value={note} maxLength={2_000} onChange={(event) => setNote(event.target.value)} placeholder="Add a note (optional)" aria-label="Note about this reply" />
        <button type="submit" className="button button--primary" disabled={chosen.length === 0 && note.trim().length === 0}>
          Submit
        </button>
      </form>
      {error != null ? <div className="feedback-card__error">Couldn’t save it: {error}</div> : null}
    </div>
  );
}

/** A reply's quote in its bubble; it takes you to the message it answers when that's known. */
export function ReplyQuote({ quote, author, onOpen }: { quote: string; author: string; onOpen?: () => void }) {
  const body = (
    <>
      <span className="reply-quote__author">{author}</span>
      <span className="reply-quote__text">{quote}</span>
    </>
  );
  return onOpen != null ? (
    <button type="button" className="reply-quote" data-find-skip onClick={onOpen} title="Show the message this replies to">
      {body}
    </button>
  ) : (
    <div className="reply-quote" data-find-skip>
      {body}
    </div>
  );
}
