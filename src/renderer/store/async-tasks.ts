// Each agent's background work that is still running (the "Async tasks" panel), read from the
// gateway when the panel opens and kept live from "background-work" events, which carry an agent's
// whole list. A read that an event overtook on its way is dropped. The tasks that ended
// (the panel's Ended section) are read while a panel shows them, again each time the
// running list changes.
import type { AsyncTaskInfo, EndedAsyncTask, StopAllAsyncTasksResult } from "../../shared/model";
import { gateway } from "../bridge";
import { Store } from "./store";

export interface AsyncTasksState {
  tasks: AsyncTaskInfo[];
  status: "loading" | "ready" | "error";
  error: string | null;
}

export const asyncTasks = new Store<Record<string, AsyncTasksState>>({});
export const endedAsyncTasks = new Store<Record<string, EndedAsyncTask[]>>({});

/** How many ended tasks the panel lists. */
const ENDED_LIMIT = 10;

/** Per agent: bumped by each event, so a read can tell it came too late. */
const versions = new Map<string, number>();
/** Agents whose ended tasks a panel shows. */
const endedWatched = new Set<string>();

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

async function loadEnded(agentId: string): Promise<void> {
  try {
    const ended = await gateway.getEndedAsyncTasks({ id: agentId, limit: ENDED_LIMIT });
    if (endedWatched.has(agentId)) endedAsyncTasks.set((state) => ({ ...state, [agentId]: ended }));
  } catch {
    // offline, or a box from before the Ended list; the section stays as it was
  }
}

/** Keeps the agent's ended tasks loaded until the returned function is called. */
export function watchEndedAsyncTasks(agentId: string): () => void {
  endedWatched.add(agentId);
  void loadEnded(agentId);
  return () => {
    endedWatched.delete(agentId);
    endedAsyncTasks.set((state) => {
      const { [agentId]: _closed, ...rest } = state;
      return rest;
    });
  };
}

/** Stops a task; the event that follows takes it off the list. */
export async function stopAsyncTask(agentId: string, taskId: string): Promise<void> {
  await gateway.cancelAsyncTask({ id: agentId, taskId });
}

/** Stops every running task of the agent's; those the box couldn't reach come back in `failed`. */
export async function stopAllAsyncTasks(agentId: string): Promise<StopAllAsyncTasksResult> {
  return gateway.cancelAllAsyncTasks({ id: agentId });
}

let started = false;
export function startAsyncTasks(): void {
  if (started) return;
  started = true;
  gateway.subscribe({
    "background-work": ({ parentAgentId, tasks }) => {
      versions.set(parentAgentId, (versions.get(parentAgentId) ?? 0) + 1);
      asyncTasks.set((state) => ({ ...state, [parentAgentId]: { tasks, status: "ready", error: null } }));
      // A task that left the running list has ended.
      if (endedWatched.has(parentAgentId)) void loadEnded(parentAgentId);
    },
    // Events may have been missed while the box was out of reach.
    "gateway-link": ({ state }) => {
      if (state !== "connected") return;
      for (const agentId of Object.keys(asyncTasks.get())) void loadAsyncTasks(agentId);
      for (const agentId of endedWatched) void loadEnded(agentId);
    },
  });
}
