// Permission policy for tools on the user's computer. Each tool maps to a
// permission id whose setting is one of four modes:
//   guarded     run read-only actions (and writes inside the agent's own
//                   workspace) without asking; ask for everything else
//   trusted    never ask (dangerous commands still ask)
//   ask_always  always ask, unless a standing grant covers it
//   blocked         refuse
// Answering "always" records a standing grant scoped to one shell program, one
// folder, one site in the agent browser ("site:<origin>"), or the whole
// permission; "never" records a standing denial for the same scope. Dangerous
// commands never get standing grants.
import { dirname, resolve } from "node:path";
import { siteLabel } from "../shared/agent-browser";
import type { LocalToolInfo, Risk, ToolPermission } from "../shared/model";
import type { ToolPolicyVerdict } from "../shared/gateway-protocol";
import { isInside } from "../shared/paths";

export { isInside };

export const LOCAL_PERMISSIONS: LocalToolInfo[] = [
  { id: "shell", label: "Run commands", description: "Run shell commands on this computer.", defaultPermission: "guarded" },
  { id: "files.read", label: "Read files", description: "Read files and list folders. Reads inside an agent's own workspace never ask; credential stores always ask.", defaultPermission: "guarded" },
  { id: "files.write", label: "Write files", description: "Create and edit files. Writes inside an agent's own workspace never ask.", defaultPermission: "guarded" },
  { id: "processes", label: "See running apps", description: "List running processes.", defaultPermission: "trusted" },
  { id: "screen", label: "Screenshots", description: "Capture the screen so the agent can see it.", defaultPermission: "ask_always" },
  { id: "clipboard.read", label: "Read clipboard", description: "Read text from the clipboard.", defaultPermission: "ask_always" },
  { id: "clipboard.write", label: "Write clipboard", description: "Copy text to the clipboard.", defaultPermission: "guarded" },
  { id: "open", label: "Open links", description: "Open web links in the default browser.", defaultPermission: "guarded" },
  { id: "browser", label: "Browse the web", description: "Open pages in the agent browser, read them and take screenshots of them.", defaultPermission: "guarded" },
  {
    id: "browser.act",
    label: "Act on web pages",
    description: "Click, type and press keys in the agent browser. Typing, form submits and clicks that look like purchases, posts or sends ask once per site; password and payment fields always ask.",
    defaultPermission: "guarded",
  },
];

export interface PolicyInput {
  permissionId: string;
  risk: Risk;
  reasons: string[];
  /** Grant scope this action falls under: "cmd:<program>", "dir:<folder>", "exact:<command>" or "all". */
  scope: string;
  /** Write targets, for the in-workspace exemption. */
  paths: string[];
  workspace: string;
}

export interface Grant {
  toolId: string;
  scope: string;
}

function covers(grantScope: string, scope: string): boolean {
  if (grantScope === "all" || grantScope === scope) return true;
  if (grantScope.startsWith("dir:") && scope.startsWith("dir:")) return isInside(scope.slice(4), grantScope.slice(4));
  return false;
}

export function evaluate(input: PolicyInput, permissions: Record<string, ToolPermission>, grants: Grant[]): ToolPolicyVerdict {
  const setting = permissions[input.permissionId] ?? LOCAL_PERMISSIONS.find((p) => p.id === input.permissionId)?.defaultPermission ?? "ask_always";
  const base = { risk: input.risk, reasons: input.reasons, scope: input.scope };
  const mine = grants.filter((grant) => grant.toolId === input.permissionId);
  if (setting === "blocked") return { ...base, decision: "block" };
  if (mine.some((grant) => grant.scope.startsWith("deny:") && covers(grant.scope.slice(5), input.scope))) return { ...base, decision: "block" };
  if (input.risk === "dangerous") return { ...base, decision: "ask" };
  if (setting === "trusted") return { ...base, decision: "allow" };
  if (mine.some((grant) => !grant.scope.startsWith("deny:") && covers(grant.scope, input.scope))) return { ...base, decision: "allow" };
  if (setting === "ask_always") return { ...base, decision: "ask" };
  // guarded
  if (input.risk === "read-only") return { ...base, decision: "allow" };
  if (input.paths.length > 0 && input.paths.every((path) => isInside(path, input.workspace))) return { ...base, decision: "allow" };
  return { ...base, decision: "ask" };
}

/** What "always" would cover, phrased for the approval card; null when not grantable. */
export function grantRecipient(permissionId: string, scope: string, risk: Risk): string | null {
  if (risk === "dangerous" || scope.startsWith("exact:")) return null;
  if (scope.startsWith("cmd:")) return `\`${scope.slice(4)}\` commands`;
  if (scope.startsWith("dir:")) return `files in ${scope.slice(4)}`;
  if (scope.startsWith("site:")) return `${permissionId === "browser.act" ? "typing and clicking" : "browsing"} on ${siteLabel(scope.slice(5))}`;
  return LOCAL_PERMISSIONS.find((p) => p.id === permissionId)?.label.toLowerCase() ?? permissionId;
}

export function dirScope(paths: string[]): string {
  const dirs = paths.map((path) => dirname(resolve(path)));
  return dirs.length === 0 ? "all" : `dir:${dirs[0]}`;
}
