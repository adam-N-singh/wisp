// The find bar over a conversation (Ctrl+F): Enter steps to an older match, Shift+Enter to a newer
// one, Esc closes. The transcript scrolls to the current match and paints the others.
import { useEffect, useRef } from "react";
import type { TranscriptEntry } from "../../shared/model";
import { closeFind, find, refreshFind, setFindQuery, stepFind } from "../store/find";
import { useStore } from "../store/store";
import { replicaStore } from "../store/transcripts";
import { focusComposer } from "./Composer";
import { Icon } from "./icons";

/** The newest message that has finished streaming: a new one may hold more matches. */
function lastSettledMessage(entries: TranscriptEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.kind === "message" && !entry.isStreaming) return entry.id;
  }
  return null;
}

export function FindBar({ agentId }: { agentId: string }) {
  const state = useStore(find);
  const open = state.agentId === agentId;
  const input = useRef<HTMLInputElement>(null);
  const settled = useStore(replicaStore(agentId), (replica) => lastSettledMessage(replica.entries));
  const seen = useRef(settled);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    input.current?.select();
  }, [open, state.focusTick]);

  useEffect(() => {
    if (seen.current === settled) return;
    seen.current = settled;
    if (open) refreshFind();
  }, [settled, open]);

  if (!open) return null;

  const close = () => {
    closeFind();
    focusComposer();
  };
  const count =
    state.query.trim().length === 0
      ? ""
      : state.status === "error"
        ? "Search failed"
        : state.status === "searching" && state.hits.length === 0
          ? "Searching…"
          : state.hits.length === 0
            ? "No results"
            : `${state.index + 1} of ${state.hits.length}${state.complete ? "" : "+"}`;

  return (
    <div className="find-bar" role="search" aria-label="Find in chat">
      <Icon name="search" size={14} className="find-bar__icon" />
      <input
        ref={input}
        className="find-bar__input"
        value={state.query}
        placeholder="Find in chat"
        aria-label="Find in chat"
        maxLength={500}
        spellCheck={false}
        onChange={(event) => setFindQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            void stepFind(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
      />
      <span className={`find-bar__count${state.status === "error" ? " find-bar__count--error" : ""}`} aria-live="polite" title={state.error ?? undefined}>
        {count}
      </span>
      <button type="button" className="icon-button icon-button--small" aria-label="Older match" title="Older match (Enter)" disabled={state.hits.length < 2 && state.complete} onClick={() => void stepFind(1)}>
        <Icon name="chevronUp" size={14} />
      </button>
      <button type="button" className="icon-button icon-button--small" aria-label="Newer match" title="Newer match (Shift+Enter)" disabled={state.hits.length < 2} onClick={() => void stepFind(-1)}>
        <Icon name="chevronDown" size={14} />
      </button>
      <button type="button" className="icon-button icon-button--small" aria-label="Close find" title="Close (Esc)" onClick={close}>
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
