// Shell command risk classification with tree-sitter-bash (WASM build, so no
// native addon is needed): split compound commands into simple commands and
// decide which ones can run without asking the user.
import { readFileSync } from "node:fs";
import { Language, type Node, Parser } from "web-tree-sitter";

export type Risk = "read-only" | "mutating" | "dangerous" | "unknown";

export interface CommandFinding {
  text: string;
  name: string;
  risk: Risk;
  reason: string;
}

export interface Classification {
  risk: Risk;
  commands: CommandFinding[];
  reasons: string[];
}

const RISK_ORDER: Record<Risk, number> = { "read-only": 0, unknown: 1, mutating: 2, dangerous: 3 };
const worst = (a: Risk, b: Risk): Risk => (RISK_ORDER[a] >= RISK_ORDER[b] ? a : b);

let parserPromise: Promise<Parser> | null = null;

export function initBashParser(wasmDir: string): Promise<Parser> {
  parserPromise ??= (async () => {
    await Parser.init({ wasmBinary: readFileSync(`${wasmDir}/tree-sitter.wasm`) } as object);
    const bash = await Language.load(readFileSync(`${wasmDir}/tree-sitter-bash.wasm`));
    const parser = new Parser();
    parser.setLanguage(bash);
    return parser;
  })();
  return parserPromise;
}

const READ_ONLY = new Set([
  "ls", "dir", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "ag", "pwd", "echo", "printf", "which", "whereis",
  "whoami", "id", "date", "stat", "file", "du", "df", "tree", "sort", "uniq", "cut", "tr", "column", "nl", "fold", "rev",
  "basename", "dirname", "realpath", "readlink", "diff", "cmp", "comm", "md5sum", "sha1sum", "sha256sum", "shasum", "cksum",
  "xxd", "hexdump", "od", "strings", "jq", "yq", "ps", "uname", "hostname", "uptime", "free", "type", "test", "[", "true",
  "false", "seq", "expr", "bc", "env", "printenv", "locale", "less", "more", "man", "help", "history", "lsof", "netstat", "ss",
  "ping", "nslookup", "dig", "host", "awk", "gawk", "sed", "find", "fd", "git", "node", "python", "python3", "npm", "pnpm",
  "yarn", "cargo", "go", "java", "ruby", "tsc", "code", "Get-ChildItem", "Get-Content", "Get-Location", "Select-String",
]);

const DANGEROUS = new Set(["mkfs", "dd", "shutdown", "reboot", "halt", "poweroff", "fdisk", "parted", "diskutil", "format", "shred", "wipefs"]);
const ESCALATION = new Set(["sudo", "su", "doas", "runas", "pkexec"]);
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "fish", "eval", "exec", "source", ".", "xargs", "powershell", "pwsh", "cmd"]);

// Read-only only for these subcommands / flags.
const GIT_READ = new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files", "ls-tree", "blame", "describe", "tag", "config", "shortlog", "grep", "reflog", "cat-file", "whatchanged"]);
const PKG_READ = new Set(["--version", "-v", "version", "list", "ls", "view", "info", "outdated", "why", "audit", "help", "config"]);

function classifySimple(name: string, args: string[]): { risk: Risk; reason: string } {
  const base = name.replace(/^.*[\\/]/, "");
  if (ESCALATION.has(base)) return { risk: "dangerous", reason: `${base} escalates privileges` };
  if (DANGEROUS.has(base)) return { risk: "dangerous", reason: `${base} can destroy data or stop the machine` };
  if (base === "rm" || base === "rmdir" || base === "del" || base === "Remove-Item") {
    const recursive = args.some((arg) => /^-[a-zA-Z]*[rR]/.test(arg) || arg === "--recursive" || arg === "-Recurse");
    const force = args.some((arg) => /^-[a-zA-Z]*f/.test(arg) || arg === "--force" || arg === "-Force");
    const rootish = args.some((arg) => /^(\/|~|\*|\/\*|[A-Za-z]:\\?)$/.test(arg));
    if (rootish || (recursive && force)) return { risk: "dangerous", reason: "recursive forced delete" };
    return { risk: "mutating", reason: "deletes files" };
  }
  if (INTERPRETERS.has(base)) return { risk: "unknown", reason: `${base} runs code that cannot be inspected` };
  if (base === "git") {
    const sub = args.find((arg) => !arg.startsWith("-")) ?? "";
    if (sub === "branch" && args.some((arg) => /^-(d|D|m|M|c|C)$|^--(delete|move|copy)/.test(arg))) return { risk: "mutating", reason: "git branch edit" };
    if (sub === "config" && !args.some((arg) => arg === "--get" || arg === "--list" || arg === "-l" || arg.startsWith("--get"))) return { risk: "mutating", reason: "git config write" };
    if (sub === "tag" && args.length > 1 && !args.includes("-l") && !args.includes("--list")) return { risk: "mutating", reason: "git tag edit" };
    if (sub === "remote" && args.some((arg) => ["add", "remove", "rm", "rename", "set-url"].includes(arg))) return { risk: "mutating", reason: "git remote edit" };
    if (GIT_READ.has(sub)) return { risk: "read-only", reason: `git ${sub}` };
    if (sub === "push" && args.some((arg) => arg === "--force" || arg === "-f" || arg.startsWith("--force"))) return { risk: "dangerous", reason: "force push" };
    if (sub === "reset" && args.includes("--hard")) return { risk: "dangerous", reason: "git reset --hard discards work" };
    if (sub === "clean" && args.some((arg) => /^-[a-zA-Z]*f/.test(arg))) return { risk: "dangerous", reason: "git clean deletes untracked files" };
    return { risk: "mutating", reason: `git ${sub || "(no subcommand)"}` };
  }
  if (["npm", "pnpm", "yarn", "cargo", "go", "pip", "pip3"].includes(base)) {
    const sub = args.find((arg) => !arg.startsWith("-")) ?? args[0] ?? "";
    return PKG_READ.has(sub) ? { risk: "read-only", reason: `${base} ${sub}` } : { risk: "mutating", reason: `${base} ${sub || ""}`.trim() };
  }
  if (["node", "python", "python3", "ruby", "java", "tsc"].includes(base)) {
    const versionOnly = args.length > 0 && args.every((arg) => /^(--version|-v|-V|--help|-h)$/.test(arg));
    return versionOnly ? { risk: "read-only", reason: `${base} version` } : { risk: "unknown", reason: `${base} runs a program` };
  }
  if (base === "find" || base === "fd") {
    if (args.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls", "--exec", "-x", "-X"].includes(arg))) return { risk: "mutating", reason: `${base} with an action flag` };
    return { risk: "read-only", reason: base };
  }
  if (base === "sed" && args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith("--in-place"))) return { risk: "mutating", reason: "sed -i edits files" };
  if ((base === "awk" || base === "gawk") && args.some((arg) => /system\s*\(|>\s*"|\|\s*"/.test(arg))) return { risk: "unknown", reason: "awk program with side effects" };
  if (base === "env" && args.some((arg) => !arg.includes("=") && !arg.startsWith("-"))) return { risk: "unknown", reason: "env runs another command" };
  if (base === "code" && args.length > 0) return { risk: "mutating", reason: "opens an editor" };
  if (READ_ONLY.has(base) || READ_ONLY.has(name)) return { risk: "read-only", reason: base };
  if (["curl", "wget", "Invoke-WebRequest", "iwr"].includes(base)) {
    const writes = args.some((arg) => ["-o", "-O", "--output", "--remote-name", "-X", "--request", "-d", "--data", "-F", "--form", "--upload-file", "-T"].includes(arg));
    return writes ? { risk: "mutating", reason: `${base} sends data or writes a file` } : { risk: "unknown", reason: `${base} reaches the network` };
  }
  return { risk: "mutating", reason: `${base} is not on the read-only list` };
}

function nodeText(node: Node, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function unquote(word: string): string {
  if (word.length >= 2 && ((word.startsWith("'") && word.endsWith("'")) || (word.startsWith('"') && word.endsWith('"')))) return word.slice(1, -1);
  return word;
}

/** Classify a bash command line. Unparseable input is "unknown". */
export async function classifyBash(command: string, wasmDir: string): Promise<Classification> {
  const parser = await initBashParser(wasmDir);
  const tree = parser.parse(command);
  if (tree == null) return { risk: "unknown", commands: [], reasons: ["could not parse"] };
  const findings: CommandFinding[] = [];
  const reasons: string[] = [];
  let risk: Risk = "read-only";

  if (tree.rootNode.hasError) {
    risk = "unknown";
    reasons.push("command has syntax the parser could not read");
  }

  const visit = (node: Node) => {
    switch (node.type) {
      case "command": {
        const nameNode = node.childForFieldName("name");
        const name = nameNode == null ? "" : unquote(nodeText(nameNode, command));
        const args = node.children
          .filter((child): child is Node => child != null && child.type !== "command_name" && child.type !== "variable_assignment" && child !== nameNode && !child.type.endsWith("redirect"))
          .map((child) => unquote(nodeText(child, command)));
        const verdict = name === "" ? { risk: "read-only" as Risk, reason: "assignment only" } : classifySimple(name, args);
        findings.push({ text: nodeText(node, command), name, ...verdict });
        risk = worst(risk, verdict.risk);
        break;
      }
      case "file_redirect": {
        const op = node.children.find((child) => child != null && /^(>|>>|&>|&>>|>\||<>)$/.test(child.type));
        const target = node.childForFieldName("destination");
        const targetText = target == null ? "" : unquote(nodeText(target, command));
        if (op != null && !/^\/dev\/(null|stdout|stderr)$/.test(targetText) && !/^&?\d$/.test(targetText)) {
          risk = worst(risk, "mutating");
          reasons.push(`writes to ${targetText || "a file"}`);
        }
        break;
      }
      case "command_substitution":
      case "process_substitution":
        reasons.push(`${node.type.replace("_", " ")} runs a nested command`);
        break;
      case "heredoc_redirect":
        break;
    }
    for (const child of node.children) if (child != null) visit(child);
  };
  visit(tree.rootNode);
  tree.delete();

  // A pipe into an interpreter turns data into code.
  for (let i = 1; i < findings.length; i++) {
    if (INTERPRETERS.has(findings[i].name.replace(/^.*[\\/]/, ""))) risk = worst(risk, "unknown");
  }
  if (findings.length === 0 && risk === "read-only" && command.trim().length > 0) risk = "unknown";
  return { risk, commands: findings, reasons: [...reasons, ...findings.filter((f) => f.risk !== "read-only").map((f) => `${f.name}: ${f.reason}`)] };
}
