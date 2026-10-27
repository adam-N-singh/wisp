// Sign in with ChatGPT for a local app (developers.openai.com/siwc, "open-source
// and locally hosted apps"): an OAuth authorization-code flow with PKCE against
// auth.openai.com, a loopback redirect on 127.0.0.1, and dynamic client
// registration (the first sign-in sends client_id=dynamic_agent_client and the
// callback returns the issued client id). With the `chatgpt.tokens.use.direct`
// scope granted, Responses API requests draw on the user's ChatGPT plan.
//
// Tokens stay in the main process, encrypted with the OS keychain
// (SecretStore). A local box gets short-lived access tokens only; the renderer
// never sees any of them. For a remote box the whole sign-in moves to the box
// (moveTo), which owns its refreshes from then on.
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import {
  CHATGPT_AUTH_BASE,
  CHATGPT_PLAN_SCOPE as PLAN_SCOPE,
  CHATGPT_RESOURCE as RESOURCE,
  ChatGptAuthError,
  isTerminalRefreshError,
  REFRESH_MARGIN_MS,
  refreshChatGptTokens,
  revokeChatGptTokens,
  type StoredChatGptTokens as StoredTokens,
  tokenRequest,
} from "../shared/chatgpt-oauth";
import type { ChatGptStatus } from "../shared/model";
import { callbackPage, listenLoopback } from "./oauth-loopback";
import type { SecretStore } from "./secrets";
import type { SettingsStore } from "./settings";

export { CHATGPT_AUTH_BASE, ChatGptAuthError };

const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const AGENT_NAME = "Wisp";
const PREFERRED_PORT = 1455;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

export class ChatGptAuth {
  private refreshing: Promise<StoredTokens> | null = null;
  private pendingSignIn: { cancel(): void } | null = null;
  private readonly authBase: string;

  constructor(
    private readonly options: {
      secrets: SecretStore;
      settings: SettingsStore;
      openInBrowser(url: string): Promise<void>;
      /** Tests point this at a local fake. */
      authBase?: string;
      log?(line: string): void;
    },
  ) {
    this.authBase = (options.authBase ?? CHATGPT_AUTH_BASE).replace(/\/+$/, "");
  }

  status(): ChatGptStatus {
    const tokens = this.tokens();
    const registration = this.options.settings.get().models.chatgpt;
    return {
      connected: tokens != null,
      planUsage: tokens?.scopes.includes(PLAN_SCOPE) ?? false,
      email: tokens != null ? registration.email : null,
      welcomeSeen: registration.welcomeSeen,
      signingIn: this.pendingSignIn != null,
    };
  }

  /** True when requests can draw on the plan right now (signed in with the plan scope). */
  usable(): boolean {
    const status = this.status();
    return status.connected && status.planUsage;
  }

  cancel(): void {
    this.pendingSignIn?.cancel();
  }

  markWelcomeSeen(): void {
    this.updateRegistration({ welcomeSeen: true });
  }

  /** A fresh access token, refreshing when it is close to expiry. */
  async accessToken(force = false): Promise<{ accessToken: string; expiresAt: number }> {
    let tokens = this.tokens();
    if (tokens == null) throw new ChatGptAuthError("Sign in with ChatGPT isn't connected.");
    if (force || tokens.expiresAt - Date.now() < REFRESH_MARGIN_MS) tokens = await this.refresh();
    return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
  }

  /** `askConsent` re-shows the consent page, e.g. to grant plan usage after declining it. */
  async signIn(askConsent = false): Promise<void> {
    if (this.pendingSignIn != null) throw new ChatGptAuthError("A sign-in is already in progress.");
    let registration = this.options.settings.get().models.chatgpt;
    // The host id is stable per installation and saved before the first sign-in.
    if (registration.hostId == null) registration = this.updateRegistration({ hostId: `urn:uuid:${randomUUID()}` });
    const hostId = registration.hostId!;
    const savedClientId = registration.clientId;
    const previous = this.tokens();

    const state = base64url(randomBytes(32));
    const nonce = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash("sha256").update(verifier).digest());

    // The redirect's port may vary; its host and path may not.
    const { server, port } = await listenLoopback(PREFERRED_PORT).catch(() => listenLoopback(0));
    const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: savedClientId ?? "dynamic_agent_client",
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ext_agent_host_id: hostId,
    });
    if (savedClientId == null) params.set("agent_name_hint", AGENT_NAME);
    else if (registration.email != null) params.set("login_hint", registration.email);
    if (savedClientId != null && previous?.idToken) params.set("id_token_hint", previous.idToken);
    if (askConsent) params.set("prompt", "consent");

    try {
      const callback = await new Promise<URLSearchParams>((resolve, reject) => {
        const timer = setTimeout(() => reject(new ChatGptAuthError("Sign-in timed out.")), SIGN_IN_TIMEOUT_MS);
        this.pendingSignIn = {
          cancel: () => {
            clearTimeout(timer);
            reject(new ChatGptAuthError("Sign-in was cancelled."));
          },
        };
        server.on("request", (request, response) => {
          const url = new URL(request.url ?? "/", redirectUri);
          if (url.pathname !== "/auth/callback") {
            response.writeHead(404).end();
            return;
          }
          const query = url.searchParams;
          const ok = query.get("state") === state && query.get("error") == null && query.get("code") != null;
          response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          response.end(callbackPage(ok));
          clearTimeout(timer);
          if (query.get("state") !== state) return reject(new ChatGptAuthError("The sign-in response didn't match this request. Try again."));
          if (query.get("error") != null) return reject(new ChatGptAuthError(query.get("error") === "access_denied" ? "Sign-in was cancelled." : `Sign-in failed: ${query.get("error_description") ?? query.get("error")}`));
          resolve(query);
        });
        void this.options.openInBrowser(`${this.authBase}/api/accounts/authorize?${params.toString()}`).catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      // New registrations return the issued client id; save it before the exchange so a retry reuses it.
      const issued = callback.get("client_id");
      let clientId = savedClientId;
      if (savedClientId == null) {
        if (issued == null || issued === "dynamic_agent_client") throw new ChatGptAuthError("OpenAI didn't finish registering the app. Try signing in again.");
        clientId = issued;
        this.updateRegistration({ clientId: issued });
      } else if (issued != null && issued !== savedClientId) {
        throw new ChatGptAuthError("The sign-in response named a different app registration. Try again.");
      }

      const response = await this.tokenRequest({ grant_type: "authorization_code", client_id: clientId!, code: callback.get("code")!, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE });
      const claims = await this.validateIdToken(response.id_token, clientId!, nonce);
      const tokens: StoredTokens = {
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
        idToken: response.id_token,
        expiresAt: Date.now() + (Number(response.expires_in) || 3600) * 1000,
        scopes: String(response.scope ?? "").split(/\s+/).filter(Boolean),
        clientId: clientId!,
      };
      if (!tokens.refreshToken) throw new ChatGptAuthError("OpenAI didn't return a refresh token.");
      await this.saveTokens(tokens);
      this.updateRegistration({ email: typeof claims.email === "string" ? claims.email : null, sub: typeof claims.sub === "string" ? claims.sub : null });
    } finally {
      this.pendingSignIn = null;
      server.close();
    }
  }

  async signOut(): Promise<{ revoked: boolean }> {
    const tokens = this.tokens();
    const revoked = tokens != null ? await revokeChatGptTokens(this.authBase, tokens) : false;
    // Keep the registration (client id, host id) so the next sign-in reuses it.
    await this.options.secrets.remove("openai-chatgpt-tokens");
    return { revoked };
  }

  /**
   * Hands the sign-in to a remote box: `deliver` copies the credentials there, then this PC
   * forgets them (without revoking), because the box owns every refresh from now on.
   */
  async moveTo(deliver: (tokens: StoredTokens & { email: string | null }) => Promise<void>): Promise<void> {
    await this.refreshing?.catch(() => undefined);
    const tokens = this.tokens();
    if (tokens == null) throw new ChatGptAuthError("Sign in with ChatGPT isn't connected on this PC.");
    await deliver({ ...tokens, email: this.options.settings.get().models.chatgpt.email });
    await this.options.secrets.remove("openai-chatgpt-tokens");
  }

  // ---- internals ---------------------------------------------------------------------

  private tokens(): StoredTokens | null {
    const raw = this.options.secrets.get("openai-chatgpt-tokens");
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as StoredTokens;
    } catch {
      return null;
    }
  }

  private saveTokens(tokens: StoredTokens): Promise<void> {
    return this.options.secrets.set("openai-chatgpt-tokens", JSON.stringify(tokens));
  }

  private updateRegistration(patch: Partial<ReturnType<SettingsStore["get"]>["models"]["chatgpt"]>) {
    const models = this.options.settings.get().models;
    const chatgpt = { ...models.chatgpt, ...patch };
    this.options.settings.update({ models: { ...models, chatgpt } });
    return chatgpt;
  }

  /** Refresh tokens rotate, so refreshes are serialized. */
  private refresh(): Promise<StoredTokens> {
    this.refreshing ??= (async () => {
      const current = this.tokens();
      if (current == null) throw new ChatGptAuthError("Sign in with ChatGPT isn't connected.");
      let next: StoredTokens;
      try {
        next = await refreshChatGptTokens(this.authBase, current);
      } catch (error) {
        if (isTerminalRefreshError(error)) {
          await this.options.secrets.remove("openai-chatgpt-tokens");
          throw new ChatGptAuthError("Your ChatGPT sign-in has expired. Sign in again in Settings → Models.");
        }
        throw error;
      }
      await this.saveTokens(next);
      return next;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private tokenRequest(form: Record<string, string>): Promise<Record<string, any>> {
    return tokenRequest(this.authBase, form);
  }

  /** Verifies the ID token's RS256 signature against OpenAI's JWKS, then its issuer, audience, expiry and nonce. */
  private async validateIdToken(idToken: unknown, clientId: string, nonce: string): Promise<Record<string, unknown>> {
    if (typeof idToken !== "string") throw new ChatGptAuthError("OpenAI didn't return an ID token.");
    const [headerPart, payloadPart, signaturePart] = idToken.split(".");
    if (headerPart == null || payloadPart == null || signaturePart == null) throw new ChatGptAuthError("The ID token is malformed.");
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as { alg?: string; kid?: string };
    const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<string, unknown>;
    if (header.alg !== "RS256") throw new ChatGptAuthError(`Unexpected ID token algorithm ${String(header.alg)}.`);
    const jwks = (await (await fetch(`${this.authBase}/.well-known/jwks.json`)).json()) as { keys?: Array<Record<string, unknown>> };
    const jwk = (jwks.keys ?? []).find((key) => key.kid === header.kid) ?? (jwks.keys?.length === 1 ? jwks.keys[0] : undefined);
    if (jwk == null) throw new ChatGptAuthError("OpenAI's signing key for this sign-in wasn't found.");
    const key = createPublicKey({ key: jwk as never, format: "jwk" });
    const valid = verify("RSA-SHA256", Buffer.from(`${headerPart}.${payloadPart}`), key, Buffer.from(signaturePart, "base64url"));
    if (!valid) throw new ChatGptAuthError("The ID token signature is invalid.");
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== CHATGPT_AUTH_BASE && claims.iss !== this.authBase) throw new ChatGptAuthError("The ID token came from an unexpected issuer.");
    if (!audience.includes(clientId)) throw new ChatGptAuthError("The ID token was issued for a different app.");
    if (typeof claims.exp !== "number" || claims.exp < now - 300) throw new ChatGptAuthError("The ID token has expired.");
    if (claims.nonce !== nonce) throw new ChatGptAuthError("The ID token doesn't belong to this sign-in.");
    return claims;
  }
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}
