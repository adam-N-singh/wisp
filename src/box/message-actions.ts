// What the user does to a message after it was sent: reacts with an emoji (gateway `setReaction`),
// votes Good or Bad on a reply (`rateReply`), or replies to it (a `deliverMessage` that quotes it).
// Reactions and votes change the stored entry, which the harness then persists and sends as an
// `updated` transcript event, so every replica applies them in order. Neither reaches the model:
// its conversation is rebuilt append-only from the transcript, and changing an old message there
// would break the prompt prefix each request extends. A reply's quote does reach it, on the new
// message, which is where the user put it.
import { FEEDBACK_CATEGORIES, type FeedbackCategory, type MessageEntry, type MessageFeedback, type Reaction, type TranscriptEntry } from "../shared/model";

/** Different emoji one entry keeps. */
export const MAX_REACTIONS = 20;
/** Characters in a vote's comment. */
export const MAX_FEEDBACK_COMMENT = 2_000;
/** Characters of a reply's quote the box keeps; the app sends a shorter one. */
export const MAX_REPLY_QUOTE = 2_000;

export type FeedbackAction = "up" | "down" | "submit" | "revert";

/** A refused change; the gateway answers 404 for "missing", 409 for "streaming" and 400 otherwise. */
export class MessageActionError extends Error {
  constructor(
    readonly code: "missing" | "streaming" | "unsupported" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "MessageActionError";
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** One emoji: a single grapheme that is a pictograph (skin tones and ZWJ sequences included), a flag or a keycap. */
export function isReactionEmoji(value: string): boolean {
  if (value.length === 0 || value.length > 32 || /\s/u.test(value)) return false;
  return [...graphemes.segment(value)].length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(value);
}

/** Messages that are written, attachments, and the agent's text, visualization and page cards take reactions; rows such as tool calls don't. */
function checkReactable(entry: TranscriptEntry): void {
  const reactable = entry.kind === "message" || entry.kind === "user-attachment" || (entry.kind === "send-message" && (entry.message.type === "text" || entry.message.type === "visualization" || entry.message.type === "page"));
  if (!reactable) throw new MessageActionError("unsupported", "Only messages take reactions.");
  if (entry.kind === "message" && entry.isStreaming) throw new MessageActionError("streaming", "The reply is still being written.");
}

/** The entry's reactions after `by` reacts with `emoji`: added, or taken back when they had already put it there. */
export function toggleReaction(entry: TranscriptEntry, emoji: string, by: string): Reaction[] {
  checkReactable(entry);
  if (!isReactionEmoji(emoji)) throw new MessageActionError("invalid", "A reaction is one emoji.");
  const reactions = entry.reactions ?? [];
  const mine = reactions.findIndex((reaction) => reaction.emoji === emoji && reaction.by === by);
  if (mine >= 0) return reactions.filter((_, index) => index !== mine);
  if (!reactions.some((reaction) => reaction.emoji === emoji) && new Set(reactions.map((reaction) => reaction.emoji)).size >= MAX_REACTIONS) {
    throw new MessageActionError("invalid", `A message keeps at most ${MAX_REACTIONS} different reactions.`);
  }
  return [...reactions, { emoji, by }];
}

/**
 * A reply's feedback after a vote: Good is settled at once; Bad waits for its reasons until
 * "submit" (which also settles a Bad sent without any); "revert" takes the vote back. Voting Bad
 * again reopens the reasons given before.
 */
export function nextFeedback(entry: TranscriptEntry, action: FeedbackAction, categories: readonly string[] = [], comment?: string, now = Date.now()): MessageFeedback | undefined {
  if (entry.kind !== "message" || entry.role !== "assistant") throw new MessageActionError("unsupported", "Only the agent’s replies take feedback.");
  if (entry.isStreaming) throw new MessageActionError("streaming", "The reply is still being written.");
  const current = entry.feedback;
  switch (action) {
    case "revert":
      return undefined;
    case "up":
      return { sentiment: "up", state: "voted", categories: [], votedAt: now };
    case "down":
      return { sentiment: "down", state: "improve", categories: current?.sentiment === "down" ? current.categories : [], ...(current?.sentiment === "down" && current.comment != null ? { comment: current.comment } : {}), votedAt: now };
    case "submit": {
      if (current == null) throw new MessageActionError("invalid", "Vote Good or Bad first.");
      const unknown = categories.find((category) => !(FEEDBACK_CATEGORIES as readonly string[]).includes(category));
      if (unknown != null) throw new MessageActionError("invalid", `“${unknown}” isn’t one of the reasons.`);
      if (current.sentiment === "up" && categories.length > 0) throw new MessageActionError("invalid", "Reasons go with a Bad vote.");
      const text = (comment ?? "").trim();
      if (text.length > MAX_FEEDBACK_COMMENT) throw new MessageActionError("invalid", `Keep the comment under ${MAX_FEEDBACK_COMMENT} characters.`);
      const chosen = FEEDBACK_CATEGORIES.filter((category): category is FeedbackCategory => categories.includes(category));
      return { sentiment: current.sentiment, state: "voted", categories: chosen, ...(text.length > 0 ? { comment: text } : {}), votedAt: now };
    }
  }
}

/** Who wrote an entry a reply quotes, when it was someone's message. */
export function replyRoleOf(entry: TranscriptEntry): MessageEntry["replyRole"] {
  if (entry.kind === "message") return entry.role;
  if (entry.kind === "user-attachment") return "user";
  if (entry.kind === "send-message") return "assistant";
  return undefined;
}

/** What a reply quotes when the app sent no text: the start of the entry's own. */
export function quoteOf(entry: TranscriptEntry): string {
  if (entry.kind === "message") return entry.content;
  if (entry.kind === "user-attachment") return entry.file_name ?? entry.file_path;
  if (entry.kind === "send-message" && entry.message.type === "text") return entry.message.content;
  if (entry.kind === "send-message" && (entry.message.type === "visualization" || entry.message.type === "page")) return entry.message.title;
  return "";
}

/** A quote as stored: trimmed, and cut to MAX_REPLY_QUOTE characters with an ellipsis. */
export function clipQuote(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_REPLY_QUOTE ? trimmed : `${trimmed.slice(0, MAX_REPLY_QUOTE - 1).trimEnd()}…`;
}

/** How a reply's quote reads to the model, before the message's own text. */
export function replyContext(message: Pick<MessageEntry, "replyQuote" | "replyRole">): string {
  if (message.replyQuote == null || message.replyQuote.length === 0) return "";
  const whose = message.replyRole === "assistant" ? "your message" : message.replyRole === "user" ? "my earlier message" : "an earlier message";
  return `[Replying to ${whose}:]\n${message.replyQuote
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}\n\n`;
}
