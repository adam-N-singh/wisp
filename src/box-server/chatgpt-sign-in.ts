// Sign in with ChatGPT on the box server. The OAuth redirect goes to a
// 127.0.0.1 loopback, which can't reach a browser on a server, so (as OpenAI's
// self-hosted VM guidance describes) the user signs in on their PC and the app
// copies the credentials here: the issued client id with its access, refresh
// and ID tokens, saved as <data>/chatgpt-auth.json (mode 0600). From then on
// this server owns every refresh, since each refresh replaces the refresh
// token, and it keeps its own host id (<data>/chatgpt-host-id) rather than
// adopting the PC's.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHATGPT_AUTH_BASE,
  CHATGPT_PLAN_SCOPE,
  ChatGptAuthError,
  idTokenEmail,
  isTerminalRefreshError,
  REFRESH_MARGIN_MS,
  refreshChatGptTokens,
  revokeChatGptTokens,
  type StoredChatGptTokens,
} from "../shared/chatgpt-oauth";
import { replaceFileSync } from "../shared/replace-file";

interface CredentialFile extends StoredChatGptTokens {
  version: 1;
  email: string | null;
  importedAt: number;
}

/** Writes through a temporary file so a crash never leaves half a token set; readable by this user only. */
export function writePrivateFile(path: string, contents: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, contents, { mode: 0o600 });
  replaceFileSync(temp, path);
}

export class ServerChatGptSignIn {
  readonly hostId: string;
  private readonly file: string;
  private readonly authBase: string;
  private refreshing: Promise<CredentialFile> | null = null;

  constructor(private readonly options: { dataDir: string; authBase?: string; log(line: string): void }) {
    this.file = join(options.dataDir, "chatgpt-auth.json");
    this.authBase = (options.authBase ?? CHATGPT_AUTH_BASE).replace(/\/+$/, "");
    // Created before any credentials arrive, and never replaced by a copied one.
    const hostIdFile = join(options.dataDir, "chatgpt-host-id");
    let hostId = existsSync(hostIdFile) ? readFileSync(hostIdFile, "utf8").trim() : "";
    if (!/^urn:uuid:[0-9a-f-]{36}$/.test(hostId)) {
      hostId = `urn:uuid:${randomUUID()}`;
      writePrivateFile(hostIdFile, `${hostId}\n`);
    }
    this.hostId = hostId;
  }

  status(): { connected: boolean; planUsage: boolean; email: string | null; hostId: string } {
    const credentials = this.read();
    return { connected: credentials != null, planUsage: credentials?.scopes.includes(CHATGPT_PLAN_SCOPE) ?? false, email: credentials?.email ?? null, hostId: this.hostId };
  }

  /** Saves a sign-in completed on the user's PC; this server refreshes it from now on. */
  import(tokens: StoredChatGptTokens & { email?: string | null }): void {
    const credentials: CredentialFile = {
      version: 1,
      clientId: tokens.clientId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      email: tokens.email ?? idTokenEmail(tokens.idToken),
      importedAt: Date.now(),
    };
    writePrivateFile(this.file, JSON.stringify(credentials, null, 1));
    this.options.log(`ChatGPT sign-in imported${credentials.email != null ? ` for ${credentials.email}` : ""}`);
  }

  /** A fresh access token, refreshing when close to expiry (or when `force`d after a 401). */
  async accessToken(force: boolean): Promise<{ accessToken: string; expiresAt: number }> {
    let credentials = this.read();
    if (credentials == null) throw new ChatGptAuthError("Sign in with ChatGPT isn't set up on your box. Sign in from the app (Settings → Models) to copy a sign-in to it.");
    if (force || credentials.expiresAt - Date.now() < REFRESH_MARGIN_MS) credentials = await this.refresh();
    return { accessToken: credentials.accessToken, expiresAt: credentials.expiresAt };
  }

  /** Revokes the refresh token at OpenAI and forgets the sign-in. */
  async signOut(): Promise<boolean> {
    await this.refreshing?.catch(() => undefined);
    const credentials = this.read();
    if (credentials == null) return false;
    const revoked = await revokeChatGptTokens(this.authBase, credentials);
    rmSync(this.file, { force: true });
    return revoked;
  }

  private read(): CredentialFile | null {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as CredentialFile;
      return parsed.version === 1 && typeof parsed.refreshToken === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Refreshes are serialized, and each result is saved before the next can start. */
  private refresh(): Promise<CredentialFile> {
    this.refreshing ??= (async () => {
      const current = this.read();
      if (current == null) throw new ChatGptAuthError("Sign in with ChatGPT isn't set up on your box.");
      try {
        const next = { ...current, ...(await refreshChatGptTokens(this.authBase, current)) };
        writePrivateFile(this.file, JSON.stringify(next, null, 1));
        return next;
      } catch (error) {
        // Only a spent or revoked refresh token clears the sign-in; network trouble keeps it for the next try.
        if (isTerminalRefreshError(error)) {
          rmSync(this.file, { force: true });
          this.options.log("the ChatGPT sign-in expired and was removed");
          throw new ChatGptAuthError("The ChatGPT sign-in on your box has expired. Sign in again from the app (Settings → Models) to copy a new one.");
        }
        throw error;
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
}
