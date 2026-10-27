// Each agent's background work that is still running (the "Async tasks" panel), read from the
// gateway when the panel opens and kept live from "background-work" events, which carry an agent's
// whole list. A read that an event overtook on its way is dropped.
import type { AsyncTaskInfo } from "../../shared/model";
import { gateway } from "../bridge";
import { Store } from "./store";

export interface AsyncTasksState {
  tasks: AsyncTaskInfo[];
  status: "loading" | "ready" | "error";
  error: string | null;
}

export const asyncTasks = new Store<Record<string, AsyncTasksState>>({});

/** Per agent: bumped by each event, so a read can tell it came too late. */
const versions = new Map<string, number>();

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/^[\w/-]+: /, "");

export async function loadAsyncTasks(agentId: string): Promise<void> {
  const version = versions.get(agentId) ?? 0;
  asyncTasks.set((state) => ({ ...state, [agentId]: { tasks: state[agentId]?.tasks ?? [], status: state[agentId]?.status === "ready" ? "ready" : "loading", error: null } }));
  try {
    const tasks = await gateway.readAsyncTasks({ id: agentId });
    if ((versions.get(agentId) ?? 0) !== version) return;
    asyncTasks.set((state) => ({ ...state, [agentId]: { tasks, status: "ready", error: null } }));
  } catch (cause) {
    asyncTasks.set((state) => ({ ...state, [agentId]: { tasks: state[agentId]?.tasks ?? [], status: "error", error: errorText(cause) } }));
  }
}

/** Stops a task; the event that follows takes it off the list. */
export async function stopAsyncTask(agentId: string, taskId: string): Promise<void> {
  await gateway.cancelAsyncTask({ id: agentId, taskId });
}

let started = false;
export function startAsyncTasks(): void {
  if (started) return;
  started = true;
  gateway.subscribe({
    "background-work": ({ parentAgentId, tasks }) => {
      versions.set(parentAgentId, (versions.get(parentAgentId) ?? 0) + 1);
      asyncTasks.set((state) => ({ ...state, [parentAgentId]: { tasks, status: "ready", error: null } }));
    },
    // Events may have been missed while the box was out of reach.
    "gateway-link": ({ state }) => {
      if (state !== "connected") return;
      for (const agentId of Object.keys(asyncTasks.get())) void loadAsyncTasks(agentId);
    },
  });
}
