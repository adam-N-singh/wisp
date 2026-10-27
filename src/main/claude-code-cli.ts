// Finds the user's Claude Code CLI and reads whether it is signed in
// (`claude --version`, `claude auth status`). Signing in happens in Claude
// Code's own flow (`claude auth login` in a terminal window); this app never
// handles Claude account credentials.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { ClaudeCodeStatus } from "../shared/model";

const isWindows = process.platform === "win32";

/** Candidate executables, most specific first. */
function candidates(override: string | null): string[] {
  const list: string[] = [];
  if (override != null && override.trim().length > 0) list.push(override.trim());
  const home = homedir();
  if (isWindows) {
    list.push(join(home, ".local", "bin", "claude.exe"));
    if (process.env.APPDATA != null) list.push(join(process.env.APPDATA, "npm", "claude.cmd"));
  } else {
    list.push(join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude");
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    for (const name of isWindows ? ["claude.exe", "claude.cmd"] : ["claude"]) list.push(join(dir, name));
  }
  return [...new Set(list)];
}

function run(executable: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const done = (error: Error | null, stdout: string | Buffer) => {
      const exit = (error as unknown as { code?: unknown } | null)?.code;
      const code = error == null ? 0 : typeof exit === "number" ? exit : -1;
      resolve({ code, stdout: String(stdout ?? "") });
    };
    const options = { timeout: timeoutMs, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } };
    // npm's .cmd shim only runs through the shell; pass it one quoted command line.
    if (isWindows && /\.(cmd|bat)$/i.test(executable)) execFile(shellCommand(executable, args), { ...options, shell: true }, done);
    else execFile(executable, args, options, done);
  });
}

/** One cmd.exe command line with each part quoted as needed. */
export function shellCommand(executable: string, args: string[]): string {
  const quote = (value: string) => (/[\s"&|<>^%]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return [executable, ...args].map(quote).join(" ");
}

export async function detectClaudeCode(override: string | null): Promise<ClaudeCodeStatus> {
  const checkedAt = Date.now();
  for (const executable of candidates(override)) {
    if (!existsSync(executable)) continue;
    const version = await run(executable, ["--version"], 15_000);
    if (version.code !== 0) continue;
    const auth = await run(executable, ["auth", "status"], 20_000);
    let authMethod: string | null = null;
    try {
      const parsed = JSON.parse(auth.stdout) as { authMethod?: unknown };
      authMethod = typeof parsed.authMethod === "string" ? parsed.authMethod : null;
    } catch {
      authMethod = null;
    }
    return {
      executable,
      installed: true,
      version: version.stdout.trim().split(/\s+/)[0] || null,
      signedIn: auth.code === 0 && authMethod !== "none",
      authMethod,
      checkedAt,
    };
  }
  return { executable: null, installed: false, version: null, signedIn: false, authMethod: null, checkedAt };
}

/** Opens a terminal window running `claude auth login`, so sign-in completes in Claude Code itself. */
export function openClaudeCodeSignIn(executable: string): void {
  if (isWindows) {
    // `start` opens a new console window; /k keeps it open so the user sees the result.
    spawn("cmd.exe", ["/d", "/c", "start", '"Claude Code sign-in"', "cmd.exe", "/k", `"${executable}" auth login`], { windowsHide: false, detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
    return;
  }
  if (process.platform === "darwin") {
    const script = `tell application "Terminal" to do script "${executable.replace(/(["\\])/g, "\\$1")} auth login"`;
    spawn("osascript", ["-e", script, "-e", 'tell application "Terminal" to activate'], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("x-terminal-emulator", ["-e", executable, "auth", "login"], { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
}
