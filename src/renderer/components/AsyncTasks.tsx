// "Async tasks: {agent}", the async tasks panel: the agent's background work that is
// still running, opened from the info pane, the agent menu and the palette. Each background
// command shows what it runs, on which computer, for how long, and the end of its output (read
// every 2 s while the panel is open), with Stop for its whole process tree. A task leaves the list
// when it ends; the agent hears how in a message of its own.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentSummary, AsyncTaskInfo, AsyncTaskOutput } from "../../shared/model";
import { gateway, main } from "../bridge";
import { closeDialog } from "../store/app";
import { asyncTasks, loadAsyncTasks, stopAsyncTask } from "../store/async-tasks";
import { allAgents, roster } from "../store/roster";
import { useStore } from "../store/store";
import { Avatar } from "./Avatar";
import { Icon } from "./icons";

const OUTPUT_POLL_MS = 2_000;
const OUTPUT_TAIL_CHARS = 4_000;

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/^[\w/-]+: /, "");

/** "12s", "3m 04s", "1h 02m". */
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** A task's label kind, in words. */
function taskName(task: AsyncTaskInfo): string {
  if (task.labelKind === "shell_command") return `Background command ${task.labelParams?.id ?? ""}`.trim();
  if (task.labelKind === "remote_agent") return "Cloud agent";
  return task.kind === "subagent" ? `Subagent${task.subagentType ? ` (${task.subagentType})` : ""}` : "Background task";
}

export function AsyncTasksPanel({ agentId }: { agentId: string }) {
  const agent = useStore(roster, (state) => allAgents(state).find((candidate) => candidate.id === agentId));
  const loaded = useStore(roster, (state) => state.loaded);
  // The agent was deleted meanwhile.
  useEffect(() => {
    if (loaded && agent == null) closeDialog();
  }, [loaded, agent]);
  return agent != null ? <Panel agent={agent} /> : null;
}

function Panel({ agent }: { agent: AgentSummary }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const state = useStore(asyncTasks, (all) => all[agent.id]);
  const tasks = state?.tasks ?? [];
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    dialog.current?.showModal();
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    void loadAsyncTasks(agent.id);
  }, [agent.id]);

  const title = `Async tasks: ${agent.name}`;
  return (
    <dialog
      ref={dialog}
      className="outline async-tasks"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        closeDialog();
      }}
    >
      <header className="outline__header">
        <Avatar shape={agent.avatarShape} color={agent.avatarColor} size={28} busy={agent.isRunning || tasks.length > 0} />
        <div className="outline__title">
          <h2>{title}</h2>
          <span>{tasks.length === 0 ? "Nothing running in the background" : `${tasks.length} running in the background`}</span>
        </div>
        <button type="button" className="icon-button" aria-label="Close" title="Close (Esc)" onClick={closeDialog}>
          <Icon name="close" />
        </button>
      </header>
      <div className="async-tasks__body">
        {state?.status === "error" && tasks.length === 0 ? (
          <div className="outline__empty outline__empty--error">
            <Icon name="alert" size={14} /> {state.error ?? "The tasks couldn’t be loaded."}
          </div>
        ) : tasks.length === 0 ? (
          <div className="outline__empty async-tasks__empty">{state?.status === "ready" ? `${agent.name} has nothing running in the background.` : "Loading…"}</div>
        ) : (
          <ul className="async-tasks__list">
            {tasks.map((task) => (
              <TaskRow key={task.id} agentId={agent.id} task={task} now={now} />
            ))}
          </ul>
        )}
      </div>
    </dialog>
  );
}

function TaskRow({ agentId, task, now }: { agentId: string; task: AsyncTaskInfo; now: number }) {
  const [output, setOutput] = useState<AsyncTaskOutput | null>(null);
  const [outputError, setOutputError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const pre = useRef<HTMLPreElement>(null);
  /** Follows the output's end, unless the user scrolled up in it. */
  const atEnd = useRef(true);
  const name = taskName(task);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const next = await gateway.readAsyncTaskOutput({ id: agentId, taskId: task.id, tailChars: OUTPUT_TAIL_CHARS });
        if (!current) return;
        setOutput(next);
        setOutputError(null);
      } catch (cause) {
        if (current) setOutputError(errorText(cause));
      }
      if (current) timer = setTimeout(() => void read(), OUTPUT_POLL_MS);
    };
    void read();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [agentId, task.id]);

  useLayoutEffect(() => {
    if (atEnd.current && pre.current != null) pre.current.scrollTop = pre.current.scrollHeight;
  }, [output?.text]);

  const stop = async () => {
    setStopping(true);
    setStopError(null);
    try {
      // The row goes once the command has ended (the "background-work" event).
      await stopAsyncTask(agentId, task.id);
    } catch (cause) {
      setStopError(errorText(cause));
      setStopping(false);
    }
  };

  const text = output == null ? (outputError ?? "Loading output…") : output.text.trim().length === 0 ? "No output yet." : output.text;
  return (
    <li className="async-task">
      <div className="async-task__head">
        <span className="async-task__icon" title="Running">
          <span className="outline-tool__spinner" />
        </span>
        <div className="async-task__title">
          <code className="async-task__label" title={task.command ?? task.label}>
            {task.label}
          </code>
          <span className="async-task__meta">
            {name}
            {task.computerLabel != null ? ` · ${task.computerLabel}` : ""} · <time dateTime={new Date(task.startedAtMs).toISOString()}>{elapsed(now - task.startedAtMs)}</time>
          </span>
        </div>
        {task.computer === "local" && task.outputPath != null ? (
          <button type="button" className="button button--ghost button--small" title={task.outputPath} onClick={() => void main.openWithDefaultApp({ path: task.outputPath! }).catch(() => undefined)}>
            Open log
          </button>
        ) : null}
        <button type="button" className="button button--small" disabled={stopping} aria-label={`Stop ${name}`} onClick={() => void stop()}>
          <Icon name="stop" size={12} /> {stopping ? "Stopping…" : "Stop"}
        </button>
      </div>
      {task.detail != null ? <p className="async-task__detail">{task.detail}</p> : null}
      {output?.note != null ? <p className="async-task__detail">{output.note}</p> : null}
      {stopError != null ? <p className="async-task__error">{stopError}</p> : null}
      <pre
        ref={pre}
        className={`async-task__output${output == null && outputError != null ? " async-task__output--error" : ""}`}
        aria-label={`Output of ${name}`}
        onScroll={(event) => {
          const element = event.currentTarget;
          atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
      >
        {output?.truncated === true ? "…\n" : ""}
        {text}
      </pre>
    </li>
  );
}
