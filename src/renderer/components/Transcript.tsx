// Conversation transcript. Older pages load as you scroll up, keeping what you were looking at in
// place. While the find bar is open it scrolls to the current hit (loading older pages to reach
// it) and paints matches with the CSS Custom Highlight API (`::highlight(find-match)`).
// A timestamp row opens the conversation and follows a gap of 15 minutes or a new day; scrolled
// up, a pill offers the way back down, and says so when new messages arrive.
// Messages have a hover toolbar (MessageActions.tsx). A document the agent wrote is a
// card that opens it on the page stage (PageCard.tsx). In a group chat each member's post shows its
// name and avatar, and a member's approval or question is answered in that member's session.
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type AgentSummary, type EventEntry, type InvokedSkill, isSessionRunning, type LocalToolPermissionAsk, type MessageAuthor, type MessageEntry, type NoticeEntry, type SendMessageEntry, type ToolCallEntry, type TranscriptEntry, type UserAttachmentEntry, type WebSource } from "../../shared/model";
import { VAULT_PERMISSION_ID } from "../../shared/vault";
import { desktop, gateway, main } from "../bridge";
import { find } from "../store/find";
import { allAgents, roster } from "../store/roster";
import { useStore } from "../store/store";
import { discardPending, loadOlder, replicaStore, revealEntry, type PendingSend } from "../store/transcripts";
import { activityText } from "./activity";
import { AgentAvatar } from "./AgentAvatar";
import { Avatar } from "./Avatar";
import { CredentialCard } from "./CredentialCard";
import { GroupActivity, namesText } from "./GroupChat";
import { Icon, type IconName } from "./icons";
import { Markdown } from "./Markdown";
import { FeedbackReasons, MessageFooter, MessageToolbar, ReplyQuote } from "./MessageActions";
import { PageCard, PageEditsLine } from "./PageCard";
import { startOfDay, timestampLabel } from "./time";
import { VisualizationCard } from "./VisualizationCard";
import { PendingVoiceMemo, ReadAloud, VoiceMemoMessage } from "./Voice";

type Row =
  | { kind: "time"; id: string; at: number }
  | { kind: "entry"; entry: TranscriptEntry }
  | { kind: "tools"; id: string; calls: ToolCallEntry[] }
  | { kind: "pending"; send: PendingSend };

/** A gap this long between rows starts a new timestamp row, as a new day does. */
const TIMESTAMP_GAP_MS = 15 * 60_000;

const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });

function toRows(entries: TranscriptEntry[], pending: PendingSend[]): Row[] {
  const rows: Row[] = [];
  let previous: number | null = null;
  const stamp = (at: number, key: string) => {
    if (previous == null || at - previous >= TIMESTAMP_GAP_MS || startOfDay(at) !== startOfDay(previous)) rows.push({ kind: "time", id: `time-${key}`, at });
    previous = at;
  };
  for (const entry of entries) {
    if (entry.kind === "tool-call") {
      const last = rows[rows.length - 1];
      if (last?.kind === "tools") {
        last.calls.push(entry);
        previous = entry.timestampMs;
      } else {
        stamp(entry.timestampMs, entry.id);
        rows.push({ kind: "tools", id: `tools-${entry.id}`, calls: [entry] });
      }
      continue;
    }
    if (entry.kind === "message" && entry.role === "assistant" && entry.content.length === 0 && (entry.reasoning ?? "").length === 0) continue;
    // What the box told the agent (a background task's end) isn't part of the chat.
    if (entry.kind === "message" && entry.suppressed != null) continue;
    stamp(entry.timestampMs, entry.id);
    rows.push({ kind: "entry", entry });
  }
  for (const send of pending) {
    stamp(send.createdAt, send.clientNonce);
    rows.push({ kind: "pending", send });
  }
  return rows;
}

const rowKey = (row: Row) => (row.kind === "entry" ? row.entry.id : row.kind === "pending" ? row.send.clientNonce : row.id);

/** Re-renders once a minute, so "Today" turns into "Yesterday" at midnight. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** What messages need from the transcript around them. */
interface Surroundings {
  agent: AgentSummary;
  /** Scrolls to an entry (loading older pages to reach it) and flashes it. */
  jumpTo(entryId: string): void;
}

/** Matches the query as typed, in any case, everywhere in a text. */
const literalPattern = (query: string) => new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");

const highlights = () => (typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null);

export function Transcript({ agent }: { agent: AgentSummary }) {
  const replica = useStore(replicaStore(agent.id));
  const rows = useMemo(() => toRows(replica.entries, replica.pending), [replica.entries, replica.pending]);
  const now = useMinuteClock();
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  /** Where the view was last scrolled to, so a scroll up by the user can be told from content growing below. */
  const lastTop = useRef(0);
  const lastAgent = useRef(agent.id);
  /** The top row and where it was, so rows added above it don't move the view. */
  const anchor = useRef<{ key: string; top: number } | null>(null);
  /** The newest row's key, to tell new rows from older pages loading above. */
  const newest = useRef<string | null>(null);
  /** Scrolled far enough up to offer the way back down. */
  const [away, setAway] = useState(false);
  /** Rows that arrived while scrolled up. */
  const [unseen, setUnseen] = useState(0);
  const findQuery = useStore(find, (state) => (state.agentId === agent.id ? state.query.trim() : ""));
  const hit = useStore(find, (state) => (state.agentId === agent.id ? state.hits[state.index] : undefined));
  const revealTick = useStore(find, (state) => state.revealTick);

  // Stay pinned to the newest row unless the user scrolled up; then count what arrives below.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element == null) return;
    const last = rows[rows.length - 1];
    const lastKey = last != null ? rowKey(last) : null;
    if (lastAgent.current !== agent.id) {
      lastAgent.current = agent.id;
      pinnedToBottom.current = true;
      anchor.current = null;
      newest.current = lastKey;
      setUnseen(0);
      setAway(false);
    } else if (lastKey !== newest.current) {
      const arrived = newest.current != null && last != null;
      newest.current = lastKey;
      // Sending a message brings the conversation down to it.
      if (last?.kind === "pending") pinnedToBottom.current = true;
      else if (arrived && !pinnedToBottom.current) setUnseen((count) => count + 1);
    }
    if (pinnedToBottom.current) element.scrollTop = element.scrollHeight;
    else if (anchor.current != null) {
      const row = element.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(anchor.current.key)}"]`);
      if (row != null && row.offsetTop !== anchor.current.top) element.scrollTop += row.offsetTop - anchor.current.top;
    }
    lastTop.current = element.scrollTop;
    const top = element.querySelector<HTMLElement>("[data-row-key]");
    anchor.current = top != null ? { key: top.dataset.rowKey ?? "", top: top.offsetTop } : null;
  }, [rows, agent.id, agent.isRunning, agent.currentActivity]);

  // Math, diagrams and images grow after they render; a transcript pinned to the bottom stays there.
  const ready = replica.status !== "loading" || replica.entries.length > 0;
  useEffect(() => {
    const element = scroller.current;
    const content = inner.current;
    if (element == null || content == null) return;
    const observer = new ResizeObserver(() => {
      if (!pinnedToBottom.current) return;
      element.scrollTop = element.scrollHeight;
      lastTop.current = element.scrollTop;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [ready]);

  // Scroll to the find bar's current hit, loading older pages until it's there.
  useEffect(() => {
    if (hit == null) return;
    let cancelled = false;
    pinnedToBottom.current = false;
    void revealEntry(agent.id, hit.entryId, hit.seq).then(() => {
      if (cancelled) return;
      requestAnimationFrame(() => {
        const row = scroller.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(hit.entryId)}"]`);
        if (row == null || cancelled) return;
        pinnedToBottom.current = false;
        row.scrollIntoView({ block: "center" });
      });
    });
    return () => {
      cancelled = true;
    };
  }, [agent.id, hit?.entryId, hit?.seq, revealTick]);

  // Paint the matches, the current one apart, and repaint as rows render or stream.
  useEffect(() => {
    const registry = highlights();
    const root = inner.current;
    if (registry == null || root == null || findQuery.length === 0) return;
    const pattern = literalPattern(findQuery);
    let frame = 0;
    const paint = () => {
      frame = 0;
      const current = hit != null ? root.querySelector(`[data-entry-id="${CSS.escape(hit.entryId)}"]`) : null;
      const others: Range[] = [];
      let first: Range | null = null;
      // Only message text: not toolbars, reactions, votes or quotes (the box's search doesn't look there).
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.parentElement?.closest("[data-entry-id]") != null && node.parentElement.closest("[data-find-skip]") == null ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
      });
      for (let node = walker.nextNode(); node != null; node = walker.nextNode()) {
        const text = node.nodeValue ?? "";
        pattern.lastIndex = 0;
        for (let match = pattern.exec(text); match != null; match = pattern.exec(text)) {
          const range = new Range();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          if (first == null && current?.contains(node)) first = range;
          else others.push(range);
        }
      }
      registry.set("find-match", new Highlight(...others));
      if (first != null) registry.set("find-current", new Highlight(first));
      else registry.delete("find-current");
    };
    paint();
    const observer = new MutationObserver(() => {
      frame ||= requestAnimationFrame(paint);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      registry.delete("find-match");
      registry.delete("find-current");
    };
  }, [findQuery, hit?.entryId, ready]);

  const onScroll = () => {
    const element = scroller.current;
    if (element == null) return;
    const below = element.scrollHeight - element.scrollTop - element.clientHeight;
    // Only scrolling up lets go of the bottom: a reply streaming in or a diagram drawn below grows the
    // content between a scroll and its event without anyone scrolling.
    if (below < 48) pinnedToBottom.current = true;
    else if (element.scrollTop < lastTop.current - 1) pinnedToBottom.current = false;
    lastTop.current = element.scrollTop;
    setAway(!pinnedToBottom.current && below > 240);
    if (pinnedToBottom.current) setUnseen(0);
    if (element.scrollTop < 120 && replica.nextBeforeSeq != null) void loadOlder(agent.id);
  };

  const toLatest = () => {
    const element = scroller.current;
    if (element == null) return;
    pinnedToBottom.current = true;
    setUnseen(0);
    setAway(false);
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };

  const surroundings: Surroundings = {
    agent,
    jumpTo: (entryId) => {
      pinnedToBottom.current = false;
      // The reply doesn't know the message's seq, so this pages back (up to 20 pages) until it's there.
      void revealEntry(agent.id, entryId, 0).then((found) => {
        if (!found) return;
        requestAnimationFrame(() => {
          const row = scroller.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(entryId)}"]`);
          if (row == null) return;
          pinnedToBottom.current = false;
          row.scrollIntoView({ block: "center", behavior: "smooth" });
          row.classList.remove("transcript__row--flash");
          void row.offsetWidth; // restart the animation
          row.classList.add("transcript__row--flash");
          setTimeout(() => row.classList.remove("transcript__row--flash"), 2_500);
        });
      });
    },
  };

  if (replica.status === "loading" && replica.entries.length === 0) return <div className="transcript transcript--empty">Loading conversation…</div>;
  if (replica.status === "error" && replica.entries.length === 0) return <div className="transcript transcript--empty">Couldn’t load this conversation: {replica.error}</div>;

  return (
    <div className="transcript-frame">
      <div className="transcript" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-label="Conversation transcript">
        <div className="transcript__inner" ref={inner}>
          {replica.nextBeforeSeq != null ? <div className="transcript__older">{replica.loadingOlder ? "Loading earlier messages…" : "Scroll up for earlier messages"}</div> : null}
          {rows.length === 0 ? <Intro agent={agent} /> : null}
          {rows.map((row) => {
            if (row.kind === "time") {
              return (
                <div key={row.id} className="timestamp-row" title={fullFormat.format(row.at)}>
                  {timestampLabel(row.at, now)}
                </div>
              );
            }
            if (row.kind === "tools") return <ToolGroup key={row.id} rowKey={row.id} calls={row.calls} />;
            if (row.kind === "pending") return <PendingRow key={row.send.clientNonce} agent={agent} send={row.send} />;
            const entry = row.entry;
            return (
              <div key={entry.id} className={`transcript__row${hit?.entryId === entry.id ? " transcript__row--found" : ""}`} data-row-key={entry.id} data-entry-id={entry.id}>
                {replica.unreadAnchorId === entry.id ? <div className="unread-divider">New</div> : null}
                <EntryView at={surroundings} entry={entry} />
              </div>
            );
          })}
          {agent.isGroup ? (
            agent.isRunning && agent.awaitingUserResponse == null ? <GroupActivity room={agent} /> : null
          ) : isSessionRunning(agent) && !agent.isComposingMessage && agent.awaitingUserResponse == null ? (
            <Working agent={agent} />
          ) : null}
        </div>
      </div>
      {unseen > 0 || away ? (
        <button type="button" className={`jump-pill${unseen > 0 ? " jump-pill--new" : ""}`} onClick={toLatest}>
          <Icon name="arrowDown" size={14} />
          {unseen > 0 ? "New messages" : "Scroll to bottom"}
        </button>
      ) : null}
    </div>
  );
}

function Intro({ agent }: { agent: AgentSummary }) {
  return (
    <div className="intro">
      <AgentAvatar agent={agent} size={56} />
      <h2>{agent.name}</h2>
      {agent.isGroup ? (
        <p>Send a message to the group. @mention a bot to ask only it, or @everyone.</p>
      ) : agent.description ? (
        <p>{agent.description}</p>
      ) : (
        <p>Send a message to get started.</p>
      )}
    </div>
  );
}

/** Who wrote an entry: the conversation's agent, or in a group chat the member it names (as it is now, if it's still around). */
function useAuthor(from: MessageAuthor | undefined): AgentSummary | null {
  const state = useStore(roster);
  if (from == null) return null;
  return allAgents(state).find((candidate) => candidate.id === from.id) ?? null;
}

/** A member's avatar beside its post, or the agent's own. */
function AuthorAvatar({ agent, from }: { agent: AgentSummary; from: MessageAuthor | undefined }) {
  const member = useAuthor(from);
  if (from == null) return <Avatar shape={agent.avatarShape} color={agent.avatarColor} size={24} />;
  return <Avatar shape={member?.avatarShape} color={member?.avatarColor ?? "gray"} size={24} image={member?.avatarDataUrl ?? null} />;
}

function Working({ agent }: { agent: AgentSummary }) {
  return (
    <div className="working" aria-label="Agent is working">
      <span className="working__dots">
        <i />
        <i />
        <i />
      </span>
      <span className="working__text">{activityText(agent.currentActivity)}</span>
    </div>
  );
}

function EntryView({ at, entry }: { at: Surroundings; entry: TranscriptEntry }) {
  switch (entry.kind) {
    case "message":
      return entry.role === "user" ? <UserMessage at={at} entry={entry} /> : <AssistantMessage at={at} entry={entry} />;
    case "user-attachment":
      return <AttachmentView at={at} entry={entry} />;
    case "notice":
      return <NoticeView entry={entry} />;
    case "event":
      return <EventView entry={entry} />;
    case "send-message":
      return <SendMessageView at={at} entry={entry} />;
    default:
      return null;
  }
}

/** Who wrote the message a reply quotes. */
const quotedAuthor = (role: MessageEntry["replyRole"], agent: AgentSummary) => (role === "assistant" ? agent.name : role === "user" ? "You" : "Earlier message");

/** The user's side: what's in the bubble lines up on the right, the toolbar to its left. */
function UserSide({ at, entry, text, quote, container, children }: { at: Surroundings; entry: TranscriptEntry; text: string; quote?: string; container: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  return (
    <div className="message__anchor" ref={container}>
      {children}
      <MessageToolbar agentId={at.agent.id} entry={entry} role="user" text={text} quote={quote} container={container} />
    </div>
  );
}

function UserMessage({ at, entry }: { at: Surroundings; entry: MessageEntry }) {
  const container = useRef<HTMLDivElement>(null);
  const replyTo = entry.replyTo;
  const quote = entry.replyQuote != null ? <ReplyQuote quote={entry.replyQuote} author={quotedAuthor(entry.replyRole, at.agent)} onOpen={replyTo != null ? () => at.jumpTo(replyTo) : undefined} /> : null;
  // A voice memo is a card of its own; one sent as a reply shows the quote in it.
  if (entry.voiceMemo != null) return <VoiceMemoMessage entry={entry} memo={entry.voiceMemo} quote={quote} />;
  // A message that ran a skill shows the skill in place of its "/command".
  const text = entry.skill != null ? entry.content.replace(/^\s*\/[\p{L}\p{N}-]+\s*/u, "") : entry.content;
  if (text.length === 0 && entry.skill == null && entry.replyQuote == null) return null;
  return (
    <div className="message message--user">
      {entry.source === "automation" ? (
        <span className="message__tag">
          <Icon name="clock" size={12} /> Automation
        </span>
      ) : entry.source === "desktop-mount" ? (
        <span className="message__tag">
          <Icon name="mount" size={12} /> From desktop
        </span>
      ) : null}
      {entry.skill != null ? <SkillChip skill={entry.skill} /> : null}
      {entry.pageEdits != null && entry.pageEdits.length > 0 ? <PageEditsLine agentId={at.agent.id} edits={entry.pageEdits} /> : null}
      {text.length > 0 || entry.replyQuote != null ? (
        <UserSide at={at} entry={entry} text={text} container={container}>
          <div className="message__bubble">
            {quote}
            {text}
          </div>
        </UserSide>
      ) : null}
      <MessageFooter agentId={at.agent.id} entry={entry} />
    </div>
  );
}

function SkillChip({ skill }: { skill: InvokedSkill }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="skill-chip" aria-expanded={open} title={open ? "Hide the skill’s instructions" : "Show the instructions this sent"} onClick={() => setOpen((value) => !value)}>
        <Icon name="bolt" size={12} />
        <span>{skill.name}</span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
      </button>
      {open ? (
        <div className="skill-chip__body">
          <Markdown text={skill.body} />
        </div>
      ) : null}
    </>
  );
}

function AssistantMessage({ at, entry }: { at: Surroundings; entry: MessageEntry }) {
  const [showReasoning, setShowReasoning] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const agent = at.agent;
  const reasoning = entry.reasoning ?? "";
  // A reply that is still being written, or holds only reasoning, has nothing to act on yet.
  const settled = !entry.isStreaming && entry.content.length > 0;
  return (
    <div className="message message--assistant" ref={container}>
      <AuthorAvatar agent={agent} from={entry.fromAgent} />
      <div className="message__body">
        {entry.fromAgent != null ? <span className="message__author">{entry.fromAgent.name}</span> : null}
        {reasoning.length > 0 ? (
          <button type="button" className="reasoning-toggle" onClick={() => setShowReasoning((open) => !open)}>
            <Icon name={showReasoning ? "chevronDown" : "chevronRight"} size={12} />
            {entry.reasoningMs != null ? `Thought for ${Math.max(1, Math.round(entry.reasoningMs / 1000))}s` : "Thinking…"}
          </button>
        ) : null}
        {showReasoning ? <div className="reasoning">{reasoning}</div> : null}
        {entry.content.length > 0 ? <Markdown text={entry.content} streaming={entry.isStreaming} /> : null}
        {entry.isStreaming && entry.content.length > 0 ? <span className="caret" /> : null}
        {entry.content.length > 0 && (entry.sources ?? []).length > 0 ? <Sources sources={entry.sources!} /> : null}
        {settled ? <ReadAloud agent={agent} entry={entry} /> : null}
        {settled ? <FeedbackReasons agentId={agent.id} entry={entry} /> : null}
        <MessageFooter agentId={agent.id} entry={entry} />
      </div>
      {settled ? <MessageToolbar agentId={agent.id} entry={entry} role="assistant" text={entry.content} container={container} votable /> : null}
    </div>
  );
}

const SOURCE_CHIPS = 4;

/** Under a reply: the pages its web or X search cites as chips, and every page it found when opened. */
function Sources({ sources }: { sources: WebSource[] }) {
  const [open, setOpen] = useState(false);
  const cited = sources.filter((source) => source.cited);
  const chips = (cited.length > 0 ? cited : sources).slice(0, SOURCE_CHIPS);
  const more = sources.length - chips.length;
  return (
    <div className={`sources${open ? " sources--open" : ""}`}>
      <div className="sources__row">
        <button type="button" className="sources__toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)} title={open ? "Hide the sources" : "Show every source"}>
          <Icon name="globe" size={12} />
          {sources.length === 1 ? "1 source" : `${sources.length} sources`}
        </button>
        {!open
          ? chips.map((source) => (
              <SourceLink key={source.url} source={source} className="sources__chip">
                {sourceLabel(source.url)}
              </SourceLink>
            ))
          : null}
        {!open && more > 0 ? (
          <button type="button" className="sources__more" onClick={() => setOpen(true)}>
            +{more}
          </button>
        ) : null}
      </div>
      {open ? (
        <ol className="sources__list">
          {sources.map((source) => (
            <li key={source.url} className={source.cited ? undefined : "sources__uncited"}>
              <SourceLink source={source}>{source.title ?? sourceLabel(source.url)}</SourceLink>
              <span className="sources__host">
                {source.title != null ? sourceLabel(source.url) : source.url.replace(/^https?:\/\/(www\.)?/, "")}
                {source.cited ? "" : " · found, not cited"}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function SourceLink({ source, className, children }: { source: WebSource; className?: string; children: ReactNode }) {
  return (
    <a
      className={className}
      href={source.url}
      title={source.title != null ? `${source.title}\n${source.url}` : source.url}
      onClick={(event) => {
        event.preventDefault();
        void main.openInBrowser({ url: source.url });
      }}
    >
      {children}
    </a>
  );
}

/** "example.com", or "@handle on X" for a post. */
function sourceLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const handle = /^\/([A-Za-z0-9_]{1,15})\/status\//.exec(parsed.pathname)?.[1];
    if ((host === "x.com" || host === "twitter.com") && handle != null && handle !== "i") return `@${handle} on X`;
    return host;
  } catch {
    return url;
  }
}

const TOOL_ICONS: Record<string, IconName> = {
  run_shell: "terminal",
  read_file: "file",
  write_file: "edit",
  edit_file: "edit",
  list_directory: "folder",
  search_files: "search",
  list_processes: "list",
  take_screenshot: "monitor",
  read_clipboard: "file",
  write_clipboard: "file",
  open_url: "globe",
  web_fetch: "globe",
  todo_write: "list",
  ask_user: "info",
  schedule_automation: "clock",
  list_automations: "clock",
  delete_automation: "clock",
  load_skill: "bolt",
  save_memory: "brain",
  update_memory: "brain",
  forget_memory: "brain",
  show_visualization: "chart",
  create_document: "file",
  read_document: "file",
  edit_document: "edit",
};

function ToolGroup({ rowKey, calls }: { rowKey: string; calls: ToolCallEntry[] }) {
  const [open, setOpen] = useState(false);
  const pending = calls.some((call) => call.status === "pending");
  const failed = calls.filter((call) => call.status === "failed").length;
  const label = calls.length === 1 ? (calls[0].summary ?? calls[0].name) : `${pending ? "Working through" : "Used"} ${calls.length} tools`;
  return (
    <div className={`tool-group${open ? " tool-group--open" : ""}`} data-row-key={rowKey}>
      <button type="button" className="tool-group__header" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        <span className={`tool-group__label${pending ? " shimmer" : ""}`}>{label}</span>
        {failed > 0 ? <span className="tool-group__failed">{failed} failed</span> : null}
      </button>
      {open ? (
        <div className="tool-group__calls">
          {calls.map((call) => (
            <ToolCallView key={call.id} call={call} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ToolCallView({ call }: { call: ToolCallEntry }) {
  const [expanded, setExpanded] = useState(call.status === "failed");
  const detail = call.detail;
  useEffect(() => {
    if (call.status === "failed") setExpanded(true);
  }, [call.status]);
  return (
    <div className={`tool-call tool-call--${call.status}`}>
      <button type="button" className="tool-call__header" onClick={() => setExpanded((value) => !value)}>
        <Icon name={TOOL_ICONS[call.name] ?? "sparkle"} size={14} />
        <span className="tool-call__summary">{call.summary ?? call.name}</span>
        <span className="tool-call__status">{call.status === "pending" ? "running" : call.status === "failed" ? "failed" : ""}</span>
      </button>
      {expanded && detail != null ? (
        <div className="tool-call__detail">
          {Object.keys(detail.args).length > 0 ? <pre className="tool-call__args">{JSON.stringify(detail.args, null, 2)}</pre> : null}
          {detail.error != null ? <div className="tool-call__error">{detail.error}</div> : null}
          {detail.output.length > 0 ? <pre className="tool-call__output">{detail.output}</pre> : null}
          {detail.image != null ? <img className="tool-call__image" src={desktop.local.mediaUrl(detail.image)} alt={`${call.name} result`} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function AttachmentView({ at, entry }: { at: Surroundings; entry: UserAttachmentEntry }) {
  const container = useRef<HTMLDivElement>(null);
  const isImage = (entry.mime ?? "").startsWith("image/");
  const name = entry.file_name ?? entry.file_path.split(/[\\/]/).pop() ?? "";
  return (
    <div className="message message--user">
      <UserSide at={at} entry={entry} text="" quote={name} container={container}>
        {isImage ? (
          <img className="attachment-image" src={desktop.local.mediaUrl(entry.file_path)} alt={name} />
        ) : (
          <button type="button" className="attachment-chip" onClick={() => void main.showItemInFolder({ path: entry.file_path })}>
            <Icon name="file" size={14} />
            <span>{name}</span>
            {entry.byteSize != null ? <span className="attachment-chip__size">{formatBytes(entry.byteSize)}</span> : null}
          </button>
        )}
      </UserSide>
      <MessageFooter agentId={at.agent.id} entry={entry} />
    </div>
  );
}

function NoticeView({ entry }: { entry: NoticeEntry }) {
  // Links in notices (e.g. "Manage usage") open in the browser.
  const parts = entry.text.split(/(https:\/\/[^\s)]+)/g);
  return (
    <div className={`notice${entry.tone === "error" ? " notice--error" : ""}`}>
      {entry.tone === "error" ? <Icon name="alert" size={14} /> : null}
      <span>
        {parts.map((part, index) =>
          index % 2 === 1 ? (
            <button key={index} type="button" className="link-button" onClick={() => void main.openInBrowser({ url: part })}>
              {part.includes("chatgpt.com/settings/usage") ? "Manage usage" : part}
            </button>
          ) : (
            part
          ),
        )}
      </span>
    </div>
  );
}

function EventView({ entry }: { entry: EventEntry }) {
  const event = entry.event;
  const text =
    event.type === "automation-changed"
      ? `${event.action === "ran" ? "Ran" : event.action === "created" ? "Created" : event.action === "deleted" ? "Deleted" : "Updated"} automation “${event.automationName}”`
      : event.type === "members-changed"
        ? [event.added.length > 0 ? `${namesText(event.added)} joined` : "", event.removed.length > 0 ? `${namesText(event.removed)} left` : ""].filter(Boolean).join(" · ")
        : `Renamed from “${event.from}” to “${event.to}”`;
  return <div className="timeline-event">{text}</div>;
}

function SendMessageView({ at, entry }: { at: Surroundings; entry: SendMessageEntry }) {
  const container = useRef<HTMLDivElement>(null);
  const agent = at.agent;
  const author = useAuthor(entry.fromAgent);
  const message = entry.message;
  if (message.type === "text") {
    return (
      <div className="message message--assistant" ref={container}>
        <Avatar shape={agent.avatarShape} color={agent.avatarColor} size={24} />
        <div className="message__body">
          <Markdown text={message.content} />
          <MessageFooter agentId={agent.id} entry={entry} />
        </div>
        <MessageToolbar agentId={agent.id} entry={entry} role="assistant" text={message.content} container={container} />
      </div>
    );
  }
  if (message.type === "visualization") {
    return (
      <div className="message message--assistant" ref={container}>
        <AuthorAvatar agent={agent} from={entry.fromAgent} />
        <div className="message__body">
          {entry.fromAgent != null ? <span className="message__author">{entry.fromAgent.name}</span> : null}
          <VisualizationCard message={message} />
          <MessageFooter agentId={agent.id} entry={entry} />
        </div>
        <MessageToolbar agentId={agent.id} entry={entry} role="assistant" text="" quote={message.title} container={container} />
      </div>
    );
  }
  if (message.type === "page") {
    // In a group chat, the member that wrote the page: it opens beside the room's chat.
    return (
      <div className="message message--assistant" ref={container}>
        <AuthorAvatar agent={agent} from={entry.fromAgent} />
        <div className="message__body">
          {entry.fromAgent != null ? <span className="message__author">{entry.fromAgent.name}</span> : null}
          <PageCard agent={author ?? agent} message={message} />
          <MessageFooter agentId={agent.id} entry={entry} />
        </div>
        <MessageToolbar agentId={agent.id} entry={entry} role="assistant" text="" quote={message.title} container={container} />
      </div>
    );
  }
  // A group chat member's card is answered in that member's session, on its own entry.
  const target: CardTarget = entry.forwarded != null ? { agentId: entry.forwarded.agentId, entryId: entry.forwarded.entryId, sessionId: entry.forwarded.sessionId } : { agentId: agent.id, entryId: entry.id };
  let card: ReactNode;
  if (message.type === "local-tool-permission" && message.ask.toolId === VAULT_PERMISSION_ID) card = <CredentialCard target={target} ask={message.ask} />;
  else if (message.type === "local-tool-permission") card = <PermissionCard target={target} ask={message.ask} />;
  else card = <WidgetCard target={target} entry={entry} />;
  if (entry.fromAgent == null) return card;
  return (
    <div className="message message--assistant message--card">
      <AuthorAvatar agent={agent} from={entry.fromAgent} />
      <div className="message__body">
        <span className="message__author">{entry.fromAgent.name} asks</span>
        {card}
      </div>
    </div>
  );
}

/** Where a card's answer goes: the entry it's on, in its agent's session. */
export interface CardTarget {
  agentId: string;
  entryId: string;
  /** Another session than the main one: a group chat member's. */
  sessionId?: string;
}

export const ACTION_LABEL: Record<LocalToolPermissionAsk["action"], string> = {
  "run-command": "Run on your computer",
  "read-file": "Read a file",
  "list-directory": "Look in a folder",
  "write-file": "Change a file",
  "use-app": "Use your computer",
};

function PermissionCard({ target, ask: fromBox }: { target: CardTarget; ask: LocalToolPermissionAsk }) {
  const [busy, setBusy] = useState(false);
  // For tools on this PC, show what the local daemon asked, not the box's copy (the box may be a server elsewhere).
  const [onThisPc, setOnThisPc] = useState<Omit<LocalToolPermissionAsk, "requestId" | "status"> | null>(null);
  useEffect(() => {
    void main.describeToolApproval({ requestId: fromBox.requestId }).then(setOnThisPc).catch(() => undefined);
  }, [fromBox.requestId]);
  const ask: LocalToolPermissionAsk = onThisPc != null ? { ...onThisPc, requestId: fromBox.requestId, status: fromBox.status } : fromBox;
  const resolve = async (resolution: "allow-once" | "always" | "deny" | "never") => {
    setBusy(true);
    try {
      await gateway.answerToolApproval({ ...target, requestId: ask.requestId, resolution });
    } finally {
      setBusy(false);
    }
  };
  const settled = ask.status !== "pending";
  const statusText = { allowed: "Allowed once", always: "Always allowed", denied: "Denied", never: "Denied — won’t ask again", expired: "Expired", pending: "" }[ask.status];
  return (
    <div className={`permission-card${settled ? " permission-card--settled" : ""}${ask.risk === "dangerous" ? " permission-card--danger" : ""}`}>
      <div className="permission-card__head">
        <Icon name="shield" size={16} />
        <span className="permission-card__title">{ask.title ?? ACTION_LABEL[ask.action]}</span>
        {ask.risk != null && ask.risk !== "read-only" ? <span className={`risk risk--${ask.risk}`}>{ask.risk}</span> : null}
        {ask.machineLabel ? <span className="permission-card__machine">{ask.machineLabel}</span> : null}
      </div>
      <code className="permission-card__target">{ask.target}</code>
      {ask.reasons != null && ask.reasons.length > 0 && !settled ? (
        <ul className="permission-card__reasons">
          {ask.reasons.slice(0, 4).map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {settled ? (
        <div className="permission-card__status">{statusText}</div>
      ) : (
        <div className="permission-card__actions">
          <button type="button" className="button button--primary" disabled={busy} onClick={() => void resolve("allow-once")}>
            Allow once
          </button>
          {ask.standingGrant?.kind === "offered" ? (
            <button type="button" className="button" disabled={busy} onClick={() => void resolve("always")}>
              Always allow {ask.standingGrant.recipient}
            </button>
          ) : null}
          <button type="button" className="button button--ghost" disabled={busy} onClick={() => void resolve("deny")}>
            Deny
          </button>
          <button type="button" className="button button--ghost" disabled={busy} onClick={() => void resolve("never")} title="Deny and don’t ask again for this">
            Never
          </button>
        </div>
      )}
    </div>
  );
}

function WidgetCard({ target, entry }: { target: CardTarget; entry: SendMessageEntry }) {
  const [custom, setCustom] = useState("");
  if (entry.message.type !== "widget") return null;
  const widget = entry.message.widget;
  const answered = entry.respondedValue != null || entry.widgetDismissed === true;
  const respond = (value: string) => void gateway.answerCard({ ...target, value });
  return (
    <div className={`widget-card${answered ? " widget-card--answered" : ""}`}>
      <div className="widget-card__prompt">
        <Markdown text={widget.prompt} />
      </div>
      {answered ? (
        <div className="widget-card__answer">{entry.widgetDismissed ? "Dismissed" : `You answered: ${entry.respondedValue}`}</div>
      ) : (
        <>
          {widget.options.length > 0 ? (
            <div className="widget-card__options">
              {widget.options.map((option) => (
                <button key={option.label} type="button" className={`button${option.style === "primary" ? " button--primary" : option.style === "danger" ? " button--danger" : ""}`} onClick={() => respond(option.value ?? option.label)} title={option.description}>
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          {widget.allowCustom !== false ? (
            <form
              className="widget-card__custom"
              onSubmit={(event) => {
                event.preventDefault();
                if (custom.trim().length > 0) respond(custom.trim());
              }}
            >
              <input value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="Type an answer…" aria-label="Your answer" />
              <button type="submit" className="button">
                Reply
              </button>
              <button type="button" className="button button--ghost" onClick={() => void gateway.closeCard(target)}>
                Skip
              </button>
            </form>
          ) : null}
        </>
      )}
    </div>
  );
}

function PendingRow({ agent, send }: { agent: AgentSummary; send: PendingSend }) {
  const agentId = agent.id;
  return (
    <div className={`message message--user message--pending${send.state === "failed" ? " message--failed" : ""}`} data-row-key={send.clientNonce}>
      {send.voiceMemo != null ? <PendingVoiceMemo durationMs={send.voiceMemo.durationMs} /> : null}
      {send.content.length > 0 || send.reply != null ? (
        <div className="message__bubble">
          {send.reply != null ? <ReplyQuote quote={send.reply.quote} author={quotedAuthor(send.reply.role, agent)} /> : null}
          {send.content}
        </div>
      ) : null}
      {send.attachmentNames.map((name) => (
        <span key={name} className="attachment-chip">
          <Icon name="paperclip" size={14} />
          {name}
        </span>
      ))}
      {send.state === "failed" ? (
        <div className="message__send-error">
          Not sent: {send.error}
          <button type="button" className="link-button" onClick={send.retry}>
            Retry
          </button>
          <button type="button" className="link-button" onClick={() => discardPending(agentId, send.clientNonce)}>
            Discard
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
