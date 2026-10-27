// Heuristic risk classification for PowerShell command lines (the default
// shell on Windows). It splits pipelines and statement lists, then rates each
// command by verb: Get-/Test-/Select- style cmdlets read, everything else is
// treated as a change.
import type { Classification, CommandFinding, Risk } from "./bash-classify";

const READ_VERBS = new Set(["get", "test", "select", "measure", "find", "search", "show", "read", "resolve", "compare", "format", "out-string", "convertto", "convertfrom", "where", "sort", "group", "join", "split", "write-output", "write-host"]);
const READ_ALIASES = new Set(["ls", "dir", "gci", "cat", "type", "gc", "pwd", "gl", "echo", "where", "sls", "select", "sort", "measure", "ft", "fl", "?", "%", "foreach", "foreach-object", "whoami", "hostname", "ipconfig", "systeminfo", "tasklist", "git", "node", "npm", "python", "py", "findstr", "tree", "out-null", "out-string", "out-host", "out-default"]);
const DANGEROUS = /^(format-volume|clear-disk|initialize-disk|remove-partition|stop-computer|restart-computer|set-executionpolicy|disable-computerrestore|bcdedit|diskpart|cipher|reg)$/i;
const DESTRUCTIVE_ALIASES = new Set(["rm", "del", "erase", "rd", "rmdir", "ri", "remove-item"]);
const CODE_RUNNERS = new Set(["iex", "invoke-expression", "invoke-command", "icm", "start-process", "saps", "start", "powershell", "pwsh", "cmd", "bash", "sh", "wsl"]);

function splitStatements(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote != null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      parts.push(current);
      current = "";
      i++;
      continue;
    }
    if (char === ";" || char === "|" || char === "\n") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

export function classifyPowerShell(command: string): Classification {
  const findings: CommandFinding[] = [];
  const reasons: string[] = [];
  let risk: Risk = "read-only";
  const bump = (next: Risk) => {
    const order: Risk[] = ["read-only", "unknown", "mutating", "dangerous"];
    if (order.indexOf(next) > order.indexOf(risk)) risk = next;
  };

  if (/(^|[^>])>{1,2}\s*(?!\$null)[^\s&|]/.test(command.replace(/2>&1/g, ""))) {
    bump("mutating");
    reasons.push("redirects output to a file");
  }
  if (/\b(iex|invoke-expression|start-process|invoke-command)\b|&\s*\(|\[scriptblock\]/i.test(command)) {
    bump("unknown");
    reasons.push("runs code that cannot be inspected");
  }

  for (const statement of splitStatements(command)) {
    // A statement that starts with a literal, variable or sub-expression is an
    // expression whose value is just written out, not a command.
    if (/^(['"]|\$(?![({])|\d|\(|@\(|\[)/.test(statement) && !/=/.test(statement.replace(/(['"]).*?\1/g, ""))) {
      findings.push({ text: statement, name: "", risk: "read-only", reason: "expression" });
      continue;
    }
    const name = statement.replace(/^[&.]\s*/, "").split(/\s+/)[0]?.replace(/^["']|["']$/g, "") ?? "";
    const lower = name.toLowerCase();
    const args = statement.split(/\s+/).slice(1);
    let verdict: { risk: Risk; reason: string };
    if (DANGEROUS.test(lower)) verdict = { risk: "dangerous", reason: `${name} can damage the system` };
    else if (CODE_RUNNERS.has(lower)) verdict = { risk: "unknown", reason: `${name} runs code that cannot be inspected` };
    else if (DESTRUCTIVE_ALIASES.has(lower)) {
      const recurse = args.some((arg) => /^-(r|recurse)$/i.test(arg));
      const force = args.some((arg) => /^-(f|force)$/i.test(arg));
      verdict = recurse && force ? { risk: "dangerous", reason: "recursive forced delete" } : { risk: "mutating", reason: "deletes files" };
    } else if (lower === "git") {
      const sub = args.find((arg) => !arg.startsWith("-"))?.toLowerCase() ?? "";
      verdict = ["status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files", "blame"].includes(sub) ? { risk: "read-only", reason: `git ${sub}` } : { risk: "mutating", reason: `git ${sub}` };
    } else if (["node", "npm", "python", "py"].includes(lower)) {
      verdict = args.every((arg) => /^(--version|-v|-V)$/.test(arg)) && args.length > 0 ? { risk: "read-only", reason: `${name} version` } : { risk: "unknown", reason: `${name} runs a program` };
    } else if (READ_ALIASES.has(lower)) verdict = { risk: "read-only", reason: name };
    else {
      const verb = lower.includes("-") ? lower.split("-")[0] : lower;
      verdict = READ_VERBS.has(verb) || READ_VERBS.has(lower) ? { risk: "read-only", reason: name } : { risk: "mutating", reason: `${name} is not a read-only cmdlet` };
    }
    findings.push({ text: statement, name, ...verdict });
    bump(verdict.risk);
  }
  if (findings.length === 0) bump("unknown");
  return { risk, commands: findings, reasons: [...reasons, ...findings.filter((f) => f.risk !== "read-only").map((f) => `${f.name}: ${f.reason}`)] };
}
