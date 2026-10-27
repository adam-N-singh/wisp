// Secrets (provider API keys, ChatGPT and MCP sign-in tokens, the cloud
// computer key, the remote box's token)
// encrypted with Electron safeStorage (DPAPI on Windows, Keychain on macOS,
// libsecret on Linux) in `secrets.json`. Plaintext never touches disk; if
// safeStorage is unavailable values are kept in memory for this session only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";
import { writeFileAtomic } from "./atomic-write";

export type SecretName =
  | "xai-api-key"
  | "openai-api-key"
  | "anthropic-api-key"
  | "custom-api-key"
  | "openai-chatgpt-tokens"
  /** MCP server sign-ins for the box on this PC, and the app's client registrations (JSON, see mcp-auth.ts). */
  | "mcp-oauth"
  | "e2b-api-key"
  /** Bearer token of the remote box server. */
  | "box-remote-token"
  /** Before multiple providers: the single OpenAI-compatible key (migrated on start). */
  | "model-api-key";

export class SecretStore {
  private readonly file: string;
  private encrypted: Partial<Record<SecretName, string>> = {};
  private memoryOnly: Partial<Record<SecretName, string>> = {};

  constructor(userDataDir: string) {
    this.file = join(userDataDir, "secrets.json");
    try {
      const stored = JSON.parse(readFileSync(this.file, "utf8"));
      if (stored?.version === 1 && typeof stored.secrets === "object") this.encrypted = stored.secrets;
    } catch {
      // none yet
    }
  }

  get(name: SecretName): string | null {
    if (this.memoryOnly[name] != null) return this.memoryOnly[name]!;
    const sealed = this.encrypted[name];
    if (sealed == null || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return safeStorage.decryptString(Buffer.from(sealed, "base64"));
    } catch {
      return null;
    }
  }

  has(name: SecretName): boolean {
    return this.memoryOnly[name] != null || this.encrypted[name] != null;
  }

  async set(name: SecretName, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      this.memoryOnly[name] = value;
      return;
    }
    delete this.memoryOnly[name];
    this.encrypted[name] = safeStorage.encryptString(value).toString("base64");
    await this.save();
  }

  async remove(name: SecretName): Promise<void> {
    delete this.memoryOnly[name];
    delete this.encrypted[name];
    await this.save();
  }

  /** Moves a value to a new name (used when settings migrate). */
  async rename(from: SecretName, to: SecretName): Promise<void> {
    const value = this.get(from);
    if (value == null) return;
    await this.set(to, value);
    await this.remove(from);
  }

  private save(): Promise<void> {
    return writeFileAtomic(this.file, JSON.stringify({ version: 1, secrets: this.encrypted }), 0o600);
  }
}
