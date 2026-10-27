// The full conversation outline (the "Show full conversation" panel): the transcript as
// what the user sent, the model's readable thinking, the replies' text, the cards the agent posted
// and the tools it called. A tool call is its name, status and summary; its arguments and output
// stay in the box until a client asks for that one call (`getToolCallDetail`). Only a reply's
// readable `reasoning` is read here, never its replay state.
//
// `readOutline` answers with every item; the "outline" channel then sends an item as
// `appended` the first time the box has it and as `updated` when it changes. Changes the outline
// doesn't show (a reaction, a tool's output streaming in, a question answered) send nothing.
import { createHash } from "node:crypto";
import type { ConversationOutlineEvent, ConversationOutlineItem, TranscriptEntry } from "../shared/model";

/** An entry's items, in order: none, one, or a reply's thinking and then its text. */
export function outlineItems(entry: TranscriptEntry): ConversationOutlineItem[] {
  const seq = entry.seq;
  switch (entry.kind) {
    case "message": {
      if (entry.role === "user") {
        // A message of attachments alone has no text; each attachment is an item of its own. One the
        // box wrote (a background task's end), which the chat doesn't show, is a hidden item.
        if (entry.content.trim().length === 0) return [];
        return [{ id: entry.id, kind: "user", text: entry.content, ...(entry.suppressed != null ? { hidden: true } : {}), timestampMs: entry.timestampMs, seq }];
      }
      const items: ConversationOutlineItem[] = [];
      const reasoning = entry.reasoning ?? "";
      if (reasoning.length > 0) items.push({ id: `${entry.id}:thinking`, kind: "thinking", text: reasoning, ...(entry.reasoningMs != null ? { durationMs: entry.reasoningMs } : {}), seq });
      if (entry.content.length > 0) items.push({ id: entry.id, kind: "assistant-text", text: entry.content, seq });
      return items;
    }
    case "user-attachment": {
      const name = entry.file_name ?? entry.file_path.split(/[\\/]/).pop() ?? "a file";
      return [{ id: entry.id, kind: "user", text: `Attached ${name}`, timestampMs: entry.timestampMs, seq }];
    }
    case "tool-call":
      return [{ id: entry.id, kind: "tool-call", name: entry.name, status: entry.status, ...(entry.summary != null ? { summary: entry.summary } : {}), seq }];
    case "send-message":
      return [{ id: entry.id, kind: "send-message", message: entry.message, timestampMs: entry.timestampMs, seq }];
    default:
      // Notices and timeline events (renames, automation changes) are the app's, not the conversation's.
      return [];
  }
}

export function conversationOutline(entries: TranscriptEntry[]): ConversationOutlineItem[] {
  return entries.flatMap(outlineItems);
}

/** Remembers what the outline last sent of each item, so that only changes go out. */
export class OutlineTracker {
  /** Per agent: item id -> a hash of the item as last sent. */
  private sent = new Map<string, Map<string, string>>();

  /** What an entry's new state sends: items new to this box (since it started) and items that changed. */
  changes(agentId: string, entry: TranscriptEntry): ConversationOutlineEvent[] {
    const items = outlineItems(entry);
    if (items.length === 0) return [];
    let sent = this.sent.get(agentId);
    if (sent == null) this.sent.set(agentId, (sent = new Map()));
    const events: ConversationOutlineEvent[] = [];
    for (const item of items) {
      const print = createHash("sha1").update(JSON.stringify(item)).digest("base64");
      const before = sent.get(item.id);
      if (before === print) continue;
      sent.set(item.id, print);
      events.push(before == null ? { type: "appended", agentId, item } : { type: "updated", agentId, item });
    }
    return events;
  }

  /** The conversation was cleared (Start fresh conversation): its outline is empty now. */
  cleared(agentId: string): ConversationOutlineEvent {
    this.sent.delete(agentId);
    return { type: "snapshot", agentId, items: [] };
  }
}
