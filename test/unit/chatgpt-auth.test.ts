import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ChatGptAuth } from "../../src/main/chatgpt-auth";
import type { SecretStore } from "../../src/main/secrets";
import { migrateLegacyModel, SettingsStore } from "../../src/main/settings";

const cleanup: Array<() => void> = [];
after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 200)); // let pending settings writes land
  cleanup.forEach((fn) => fn());
});

/** In-memory stand-in for the keychain-backed SecretStore. */
function memorySecrets(): SecretStore {
  const values = new Map<string, string>();
  return {
    get: (name: string) => values.get(name) ?? null,
    has: (name: string) => values.has(name),
    set: async (name: string, value: string) => void values.set(name, value),
    remove: async (name: string) => void values.delete(name),
  } as unknown as SecretStore;
}

/**
 * A fake auth.openai.com: authorize (answers as if the user consented),
 * token (authorization_code with PKCE, refresh_token with rotation), JWKS,
 * discovery and revocation.
 */
async function fakeAuthServer(options: { declinePlan?: boolean; failRefresh?: string } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "test-key", alg: "RS256", use: "sig" };
  const log: Array<{ path: string; params: Record<string, string> }> = [];
  const codes = new Map<string, { challenge: string; nonce: string; clientId: string; redirectUri: string }>();
  let refreshCount = 0;
  let base = "";

  const idToken = (clientId: string, nonce: string) => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" })).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ iss: base, aud: clientId, sub: "user-123", email: "tester@example.com", nonce, iat: now, exp: now + 3600 })).toString("base64url");
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    return `${header}.${payload}.${signature}`;
  };

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", base);
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const params = request.method === "POST" ? Object.fromEntries(new URLSearchParams(raw)) : Object.fromEntries(url.searchParams);
      log.push({ path: url.pathname, params });
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (url.pathname === "/api/accounts/authorize") {
        const issued = params.client_id === "dynamic_agent_client" ? "oaiapp_test" : params.client_id;
        const code = `code-${codes.size + 1}`;
        codes.set(code, { challenge: params.code_challenge, nonce: params.nonce, clientId: issued, redirectUri: params.redirect_uri });
        const back = new URL(params.redirect_uri);
        back.searchParams.set("code", code);
        back.searchParams.set("state", params.state);
        if (params.client_id === "dynamic_agent_client") back.searchParams.set("client_id", issued);
        response.writeHead(302, { location: back.toString() });
        return response.end();
      }
      if (url.pathname === "/api/accounts/oauth/token") {
        if (params.grant_type === "authorization_code") {
          const entry = codes.get(params.code);
          if (entry == null || entry.clientId !== params.client_id || entry.redirectUri !== params.redirect_uri) return json(400, { error: "invalid_grant" });
          const challenge = createHash("sha256").update(params.code_verifier).digest("base64url");
          if (challenge !== entry.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE mismatch" });
          const scope = options.declinePlan ? "openid profile email offline_access" : "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
          return json(200, { access_token: "access-1", refresh_token: "refresh-1", id_token: idToken(entry.clientId, entry.nonce), token_type: "Bearer", expires_in: 3600, scope });
        }
        if (params.grant_type === "refresh_token") {
          if (options.failRefresh != null) return json(400, { error: options.failRefresh });
          refreshCount++;
          if (params.refresh_token !== `refresh-${refreshCount}`) return json(400, { error: "refresh_token_reused" });
          return json(200, { access_token: `access-${refreshCount + 1}`, refresh_token: `refresh-${refreshCount + 1}`, token_type: "Bearer", expires_in: 3600 });
        }
        return json(400, { error: "unsupported_grant_type" });
      }
      if (url.pathname === "/.well-known/jwks.json") return json(200, { keys: [jwk] });
      if (url.pathname === "/.well-known/openid-configuration") return json(200, { issuer: base, revocation_endpoint: `${base}/api/accounts/oauth/revoke` });
      if (url.pathname === "/api/accounts/oauth/revoke") {
        response.writeHead(200);
        return response.end();
      }
      json(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(() => server.close());
  return { base, log };
}

/** Plays the browser: follow the authorize redirect to the app's loopback callback. */
async function browser(url: string): Promise<void> {
  const authorize = await fetch(url, { redirect: "manual" });
  const location = authorize.headers.get("location");
  assert.ok(location != null, "authorize redirects back to the app");
  const callback = await fetch(location!);
  assert.match(await callback.text(), /signed in/);
}

function setup(authBase: string) {
  const dir = mkdtempSync(join(tmpdir(), "wisp-auth-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const settings = new SettingsStore(dir);
  const secrets = memorySecrets();
  const opened: string[] = [];
  const auth = new ChatGptAuth({
    secrets,
    settings,
    authBase,
    openInBrowser: async (url) => {
      opened.push(url);
      setTimeout(() => void browser(url), 10);
    },
  });
  return { auth, settings, secrets, opened };
}

test("sign in with ChatGPT: dynamic registration, PKCE, ID token checks, refresh rotation and sign-out", async () => {
  const fake = await fakeAuthServer();
  const { auth, settings, secrets, opened } = setup(fake.base);

  await auth.signIn();
  const authorize = new URL(opened[0]);
  assert.equal(authorize.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(authorize.searchParams.get("agent_name_hint"), "Wisp");
  assert.equal(authorize.searchParams.get("response_type"), "code");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("resource"), "https://api.openai.com/v1");
  assert.match(authorize.searchParams.get("scope") ?? "", /offline_access resource\.invoke chatgpt\.tokens\.use\.direct/);
  assert.match(authorize.searchParams.get("redirect_uri") ?? "", /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  assert.match(authorize.searchParams.get("ext_agent_host_id") ?? "", /^urn:uuid:[0-9a-f-]{36}$/);

  const registration = settings.get().models.chatgpt;
  assert.equal(registration.clientId, "oaiapp_test");
  assert.equal(registration.email, "tester@example.com");
  assert.deepEqual({ ...auth.status(), welcomeSeen: false }, { connected: true, planUsage: true, email: "tester@example.com", welcomeSeen: false, signingIn: false });
  assert.equal(auth.usable(), true);

  assert.equal((await auth.accessToken()).accessToken, "access-1", "a fresh token is reused");
  assert.equal((await auth.accessToken(true)).accessToken, "access-2", "force refreshes");
  assert.equal((await auth.accessToken(true)).accessToken, "access-3", "the rotated refresh token is used next");
  const refresh = fake.log.filter((entry) => entry.params.grant_type === "refresh_token");
  assert.deepEqual(refresh.map((entry) => [entry.params.client_id, entry.params.refresh_token, entry.params.resource]), [
    ["oaiapp_test", "refresh-1", "https://api.openai.com/v1"],
    ["oaiapp_test", "refresh-2", "https://api.openai.com/v1"],
  ]);

  // Signing in again reuses the registration and the host id.
  await auth.signIn();
  const again = new URL(opened[1]);
  assert.equal(again.searchParams.get("client_id"), "oaiapp_test");
  assert.equal(again.searchParams.get("agent_name_hint"), null);
  assert.equal(again.searchParams.get("login_hint"), "tester@example.com");
  assert.equal(again.searchParams.get("ext_agent_host_id"), authorize.searchParams.get("ext_agent_host_id"));

  const { revoked } = await auth.signOut();
  assert.equal(revoked, true);
  const revoke = fake.log.find((entry) => entry.path === "/api/accounts/oauth/revoke");
  assert.equal(revoke?.params.token_type_hint, "refresh_token");
  assert.equal(revoke?.params.client_id, "oaiapp_test");
  assert.equal(secrets.has("openai-chatgpt-tokens"), false);
  assert.equal(settings.get().models.chatgpt.clientId, "oaiapp_test", "the registration survives sign-out");
  assert.equal(auth.status().connected, false);
});

test("sign in with ChatGPT: declined plan usage keeps the sign-in but isn't usable", async () => {
  const fake = await fakeAuthServer({ declinePlan: true });
  const { auth } = setup(fake.base);
  await auth.signIn();
  assert.equal(auth.status().connected, true);
  assert.equal(auth.status().planUsage, false);
  assert.equal(auth.usable(), false);
});

test("sign in with ChatGPT: an unusable refresh token signs the user out", async () => {
  const fake = await fakeAuthServer({ failRefresh: "invalid_grant" });
  const { auth, secrets } = setup(fake.base);
  await auth.signIn();
  await assert.rejects(auth.accessToken(true), /sign in again/i);
  assert.equal(secrets.has("openai-chatgpt-tokens"), false);
});

test("settings: schema-1 model settings migrate to providers", () => {
  assert.deepEqual(migrateLegacyModel({ provider: "openai-compatible", baseUrl: "https://api.x.ai/v1", model: "grok-4.7", temperature: 0.3 }), {
    prefs: { defaultModel: { provider: "xai", model: "grok-4.7" }, xaiBaseUrl: "https://api.x.ai/v1", temperature: 0.3 },
    keyTarget: "xai",
  });
  assert.deepEqual(migrateLegacyModel({ provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "llama3.1", temperature: null }), {
    prefs: { defaultModel: { provider: "custom", model: "llama3.1" }, customBaseUrl: "http://localhost:11434/v1", temperature: null },
    keyTarget: "custom",
  });
  assert.equal(migrateLegacyModel({ provider: "mock" }).prefs.defaultModel?.provider, "mock");
});
