// Sign in with ChatGPT token handling shared by main (signs in on this PC and
// refreshes for the local box) and the standalone box server (refreshes a
// sign-in copied to it, per OpenAI's self-hosted VM guidance:
// developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms).
// Access tokens live an hour; every refresh returns a replacement refresh
// token, so exactly one place may refresh a given sign-in.

export const CHATGPT_AUTH_BASE = "https://auth.openai.com";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";
/** Refresh this long before the access token expires. */
export const REFRESH_MARGIN_MS = 2 * 60_000;
/** Refresh errors after which the stored tokens can't be used again. */
const TERMINAL_REFRESH_ERRORS = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

/** One sign-in: the issued client id and its token set. */
export interface StoredChatGptTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  scopes: string[];
  clientId: string;
}

export class ChatGptAuthError extends Error {}

export class TokenEndpointError extends ChatGptAuthError {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`OpenAI sign-in failed (${code}): ${detail}`);
  }
}

/** The refresh token is spent or revoked: clear it and sign in again. */
export function isTerminalRefreshError(error: unknown): boolean {
  return error instanceof TokenEndpointError && TERMINAL_REFRESH_ERRORS.has(error.code);
}

export async function tokenRequest(authBase: string, form: Record<string, string>): Promise<Record<string, any>> {
  const response = await fetch(`${authBase}/api/accounts/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const text = await response.text();
  let body: Record<string, any> = {};
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  if (!response.ok) throw new TokenEndpointError(String(body.error ?? response.status), String(body.error_description ?? body.error ?? text).slice(0, 300));
  if (typeof body.access_token !== "string") throw new ChatGptAuthError("OpenAI's token response had no access token.");
  return body;
}

/** One refresh_token grant. Callers serialize refreshes and save the result before the next one. */
export async function refreshChatGptTokens(authBase: string, current: StoredChatGptTokens): Promise<StoredChatGptTokens> {
  const response = await tokenRequest(authBase, { grant_type: "refresh_token", client_id: current.clientId, refresh_token: current.refreshToken, resource: CHATGPT_RESOURCE });
  return {
    ...current,
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? current.refreshToken,
    idToken: response.id_token ?? current.idToken,
    expiresAt: Date.now() + (Number(response.expires_in) || 3600) * 1000,
    scopes: typeof response.scope === "string" ? response.scope.split(/\s+/).filter(Boolean) : current.scopes,
  };
}

/** Revokes the refresh token; true when OpenAI accepted the revocation. */
export async function revokeChatGptTokens(authBase: string, tokens: StoredChatGptTokens): Promise<boolean> {
  try {
    const discovery = (await (await fetch(`${authBase}/.well-known/openid-configuration`)).json()) as { revocation_endpoint?: string };
    const endpoint = discovery.revocation_endpoint ?? `${authBase}/api/accounts/oauth/revoke`;
    const result = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.refreshToken, token_type_hint: "refresh_token", client_id: tokens.clientId }).toString(),
    });
    return result.ok;
  } catch {
    return false;
  }
}

/** The email claim of an ID token, read without verifying it (display only). */
export function idTokenEmail(idToken: string): string | null {
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}
