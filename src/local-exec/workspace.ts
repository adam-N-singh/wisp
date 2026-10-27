// Agents' folders on this PC. The daemon decides them itself from the agent
// id: a box (possibly a remote server) only names the agent, so it can't point
// the "writes inside the workspace never ask" rule at another folder.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** `<workspaceRoot>/<agentId>`, created on first use; agent ids are single path segments. */
export function agentWorkspace(workspaceRoot: string, agentId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(agentId)) throw new Error(`Refusing an unusual agent id ${JSON.stringify(agentId.slice(0, 60))}.`);
  const dir = join(workspaceRoot, agentId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
