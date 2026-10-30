// What a running agent is doing, as one line of text.
import type { AgentSummary, CurrentActivity } from "../../shared/model";

/**
 * "2 background commands running", while an agent that has finished its turn still has some, or
 * what it does in another of its conversations while its chat is idle.
 */
export function backgroundText(agent: Pick<AgentSummary, "asyncTaskCount" | "runningSessionIds">): string {
  const count = agent.asyncTaskCount ?? 0;
  const elsewhere = (agent.runningSessionIds ?? []).filter((sessionId) => sessionId !== "");
  if (count === 0 && elsewhere.length > 0) return elsewhere.some((sessionId) => sessionId.startsWith("group:")) ? "Replying in a group chat" : "Working in another conversation";
  return count === 1 ? "1 background command running" : `${count} background commands running`;
}

/** A tool's summary, a search line while the model searches (with the query once known), else thinking. */
export function activityText(activity: CurrentActivity | undefined): string {
  if (activity?.kind === "tool") return activity.detail ?? "Working…";
  if (activity?.kind === "searching") {
    const where = activity.tool === "x_search" ? " on X" : "";
    return activity.detail != null ? `Searching the web${where} for “${activity.detail}”` : `Searching the web${where}…`;
  }
  return "Thinking…";
}
