// "Show full conversation", the outline panel: everything in an agent's conversation in order,
// the parts the chat folds away included: the model's thinking, and each tool call with a status
// icon (a spinner while it runs, x-circle when it failed, a wrench when done).
// A tool call opens to its arguments and output, which the box sends only then (getToolCallDetail).
// There is a tab per conversation: Main for now, as there are no subagents.
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type AgentSummary, type ConversationOutlineItem, isAgentWorking, type LocalToolPermissionAsk, type SendMessage, type ToolCallDetail } from "../../shared/model";
import { desktop, gateway } from "../bridge";
import { closeDialog } from "../store/app";
import { outlines, watchOutline } from "../store/outline";
import { allAgents, roster } from "../store/roster";
import { useStore } from "../store/store";
import { Avatar } from "./Avatar";
import { Icon } from "./icons";
import { Markdown } from "./Markdown";
import { ACTION_LABEL } from "./Transcript";

type Item<K extends ConversationOutlineItem["kind"]> = Extract<ConversationOutlineItem, { kind: K }>;

/** Texts longer than this are cut down until opened. */
const LONG_TEXT_CHARS = 700;
const LONG_TEXT_LINES = 10;

const timeFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const PERMISSION_STATUS: Record<LocalToolPermissionAsk["status"], string> = {
  pending: "Waiting for you",
  allowed: "Allowed once",
  always: "Always allowed",
  denied: "Denied",
  never: "Never allowed",
  expired: "Expired",
};

export function Outline({ agentId }: { agentId: string }) {
  const agent = useStore(roster, (state) => allAgents(state).find((candidate) => candidate.id === agentId));
  const loaded = useStore(roster, (state) => state.loaded);
  // The agent was deleted meanwhile.
  useEffect(() => {
    if (loaded && agent == null) closeDialog();
  }, [loaded, agent]);
  return agent != null ? <OutlinePanel agent={agent} /> : null;
}

function OutlinePanel({ agent }: { agent: AgentSummary }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // A subagent's conversation would be a tab of its own, named by its id.
  const tabs = [{ id: agent.id, title: "Main" }];
  const [tabId, setTabId] = useState(agent.id);
  const state = useStore(outlines, (all) => all[tabId]);
  const items = state?.items ?? [];
  /** Follows new items while scrolled to the end, as the chat does. */
  const atEnd = useRef(true);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    atEnd.current = true;
    return watchOutline(tabId);
  }, [tabId]);
  // Items grow after they arrive too (a reply being written, code blocks laid out), so the end is kept in view by size.
  useLayoutEffect(() => {
    const scroller = body.current;
    if (scroller == null || content.current == null) return;
    const follow = () => {
      if (atEnd.current) scroller.scrollTop = scroller.scrollHeight;
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="outline"
      aria-label={`Full conversation with ${agent.name}`}
      onCancel={(event) => {
        event.preventDefault();
        closeDialog();
      }}
    >
      <header className="outline__header">
        <Avatar shape={agent.avatarShape} color={agent.avatarColor} size={28} busy={isAgentWorking(agent)} />
        <div className="outline__title">
          <h2>Full conversation</h2>
          <span>{agent.name}</span>
        </div>
        <button type="button" className="icon-button" aria-label="Close" title="Close (Esc)" onClick={closeDialog}>
          <Icon name="close" />
        </button>
      </header>
      <div className="outline__tabs" role="tablist" aria-label="Conversations">
        {tabs.map((tab) => (
          <button key={tab.id} type="button" role="tab" aria-selected={tab.id === tabId} className={`tab${tab.id === tabId ? " tab--active" : ""}`} onClick={() => setTabId(tab.id)}>
            {tab.title}
          </button>
        ))}
      </div>
      <div
        ref={body}
        className="outline__body"
        role="tabpanel"
        onScroll={(event) => {
          const element = event.currentTarget;
          atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
      >
        <div ref={content} className="outline__content">
          {state?.status === "error" && items.length === 0 ? (
            <div className="outline__empty outline__empty--error">
              <Icon name="alert" size={14} /> {state.error ?? "The conversation couldn’t be loaded."}
            </div>
          ) : items.length === 0 ? (
            <div className="outline__empty">{state?.status === "ready" ? "Nothing in this conversation yet." : "Loading…"}</div>
          ) : (
            <ol className="outline__items">
              {items.map((item) => (
                <li key={item.id} className={`outline-item outline-item--${item.kind}`}>
                  <OutlineRow conversationId={tabId} agent={agent} item={item} />
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </dialog>
  );
}

function OutlineRow({ conversationId, agent, item }: { conversationId: string; agent: AgentSummary; item: ConversationOutlineItem }) {
  switch (item.kind) {
    case "user":
      return (
        <>
          <RowHead icon={<Icon name="message" size={14} />} label="You" timestampMs={item.timestampMs} />
          <LongText text={item.text} plain />
        </>
      );
    case "thinking":
      return <ThinkingRow item={item} />;
    case "assistant-text":
      return (
        <>
          <RowHead icon={<Avatar shape={agent.avatarShape} color={agent.avatarColor} size={16} />} label={agent.name} />
          <LongText text={item.text} />
        </>
      );
    case "send-message":
      return <CardRow agent={agent} message={item.message} timestampMs={item.timestampMs} />;
    case "tool-call":
      return <ToolRow conversationId={conversationId} item={item} />;
  }
}

function RowHead({ icon, label, timestampMs, children }: { icon: ReactNode; label: string; timestampMs?: number; children?: ReactNode }) {
  return (
    <div className="outline-item__head">
      <span className="outline-item__icon">{icon}</span>
      <span className="outline-item__label">{label}</span>
      {children}
      {timestampMs != null ? <time className="outline-item__time">{timeFormat.format(timestampMs)}</time> : null}
    </div>
  );
}

/** A message, cut down when it is long; `plain` keeps what the user typed as typed. */
function LongText({ text, plain = false }: { text: string; plain?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_TEXT_CHARS || text.split("\n").length > LONG_TEXT_LINES;
  return (
    <div className="outline-item__body">
      <div className={`outline-item__text${plain ? " outline-item__text--plain" : ""}${long && !open ? " outline-item__text--clamped" : ""}`}>{plain ? text : <Markdown text={text} />}</div>
      {long ? (
        <button type="button" className="link-button outline-item__more" onClick={() => setOpen((value) => !value)}>
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function ThinkingRow({ item }: { item: Item<"thinking"> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="outline-item__head outline-item__toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="outline-item__icon">
          <Icon name="brain" size={14} />
        </span>
        <span className="outline-item__label">{item.durationMs != null ? `Thought for ${Math.max(1, Math.round(item.durationMs / 1000))}s` : "Thinking…"}</span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
      </button>
      {open ? <div className="outline-item__body outline-item__thinking">{item.text}</div> : null}
    </>
  );
}

function CardRow({ agent, message, timestampMs }: { agent: AgentSummary; message: SendMessage; timestampMs?: number }) {
  if (message.type === "text") {
    return (
      <>
        <RowHead icon={<Avatar shape={agent.avatarShape} color={agent.avatarColor} size={16} />} label={agent.name} timestampMs={timestampMs} />
        <LongText text={message.content} />
      </>
    );
  }
  if (message.type === "widget") {
    return (
      <>
        <RowHead icon={<Icon name="info" size={14} />} label="Asked you" timestampMs={timestampMs} />
        <div className="outline-item__body">
          <p className="outline-item__prompt">{message.widget.prompt}</p>
          {message.widget.options.length > 0 ? (
            <div className="outline-item__options">
              {message.widget.options.map((option) => (
                <span key={option.value ?? option.label} className="outline-item__option">
                  {option.label}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </>
    );
  }
  if (message.type === "local-tool-permission") {
    const ask = message.ask;
    return (
      <>
        <RowHead icon={<Icon name="shield" size={14} />} label={ask.title ?? ACTION_LABEL[ask.action]} timestampMs={timestampMs}>
          <span className={`outline-item__status outline-item__status--${ask.status}`}>{PERMISSION_STATUS[ask.status]}</span>
        </RowHead>
        <div className="outline-item__body">
          <code className="outline-item__target">{ask.target}</code>
        </div>
      </>
    );
  }
  if (message.type === "page") {
    return (
      <>
        <RowHead icon={<Icon name="file" size={14} />} label={`${message.deleted === true ? "Deleted" : "Wrote"} “${message.title}”`} timestampMs={timestampMs} />
        {message.excerpt.length > 0 ? <div className="outline-item__body outline-item__summary">{message.excerpt}</div> : null}
      </>
    );
  }
  return (
    <>
      <RowHead icon={<Icon name="chart" size={14} />} label={`Showed “${message.title}”`} timestampMs={timestampMs} />
      {message.summary.length > 0 ? <div className="outline-item__body outline-item__summary">{message.summary}</div> : null}
    </>
  );
}

function ToolRow({ conversationId, item }: { conversationId: string; item: Item<"tool-call"> }) {
  const [open, setOpen] = useState(item.status === "failed");
  const [detail, setDetail] = useState<{ value: ToolCallDetail | null; error: string | null } | null>(null);
  // A tool's name drops its "…ToolCall" suffix.
  const name = item.name.replace(/ToolCall$/, "");

  // Read when opened, and again when the call finishes or fails meanwhile.
  useEffect(() => {
    if (!open) return;
    let current = true;
    gateway.getToolCallDetail({ id: conversationId, entryId: item.id }).then(
      (value) => current && setDetail({ value, error: null }),
      (error: unknown) => current && setDetail({ value: null, error: (error instanceof Error ? error.message : String(error)).replace(/^[\w/-]+: /, "") }),
    );
    return () => {
      current = false;
    };
  }, [open, item.status, conversationId, item.id]);

  return (
    <>
      <button type="button" className="outline-item__head outline-item__toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className={`outline-item__icon outline-tool--${item.status}`} title={item.status === "pending" ? "Running" : item.status === "failed" ? "Failed" : "Done"}>
          {item.status === "pending" ? <span className="outline-tool__spinner" /> : <Icon name={item.status === "failed" ? "xCircle" : "wrench"} size={14} />}
        </span>
        <span className="outline-item__label outline-tool__summary">{item.summary ?? name}</span>
        {item.summary != null ? <span className="outline-tool__name">{name}</span> : null}
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
      </button>
      {open ? (
        <div className="outline-item__body tool-call__detail outline-tool__detail">
          {detail == null ? (
            <span className="outline-tool__note">Loading…</span>
          ) : detail.error != null ? (
            <div className="tool-call__error">{detail.error}</div>
          ) : detail.value == null ? (
            <span className="outline-tool__note">No details were kept for this call.</span>
          ) : (
            <>
              {Object.keys(detail.value.args).length > 0 ? <pre className="tool-call__args">{JSON.stringify(detail.value.args, null, 2)}</pre> : null}
              {detail.value.error != null ? <div className="tool-call__error">{detail.value.error}</div> : null}
              {detail.value.output.length > 0 ? <pre className="tool-call__output">{detail.value.output}</pre> : null}
              {detail.value.image != null ? <img className="tool-call__image" src={desktop.local.mediaUrl(detail.value.image)} alt={`${name} result`} /> : null}
              {item.status === "pending" ? <span className="outline-tool__note">Still running…</span> : null}
              {item.status === "done" && detail.value.output.length === 0 && detail.value.image == null ? <span className="outline-tool__note">No output.</span> : null}
            </>
          )}
        </div>
      ) : null}
    </>
  );
}
