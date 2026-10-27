# Remote box: agents and automations on an always-on server

Design note. The "box" is the part of Wisp that runs agents: their transcripts, harness, cron automations, model calls
and MCP servers. By default Wisp runs it in an Electron utility process on the PC, so agents and their cron automations
stop when the PC sleeps. The remote box mode moves the box to a small server of the user's own, and the desktop
connects to it over HTTPS.

```
PC (when on)                                              your server (always on)
renderer ─► main ─► coordinator ──HTTPS: /api, SSE /events──────► Caddy :443 ─► box server :8787
                    local-exec ──HTTPS: register, SSE requests──►   (TLS)         agents, transcripts, cron,
                    main ───────HTTPS: /admin (config, sign-in)─►                 harness, MCP servers,
                                                                                  Claude Code ──► model APIs
                                                                                  E2B SDK ──────► cloud computer
```

## What was built

| Piece | Where |
| --- | --- |
| Box host core, shared by both entries | `src/box/host.ts` (gateway, harness, scheduler, store; was `src/box/main.ts`) |
| Electron entry (box on this PC) | `src/box/main.ts`: MessagePort bootstrap; `box-control` configures it; `box-host` refreshes ChatGPT tokens |
| Standalone entry (plain Node, no Electron or MessagePort) | `src/box-server/`: `main.ts` CLI, `config.ts` (flags, env, file, app pushes), `server.ts` (`/admin`), `chatgpt-sign-in.ts` |
| Image and deployment | `app/Dockerfile` (multi-stage, `node:24-bookworm-slim`, runs as `node`, `/data` volume, health check on `/livez`); `app/deploy/` (Compose with Caddy, `.env.example`, `box.env.example`) |
| Settings → Box | **This PC / Remote server** (address + token), status, "Move to the box" for a ChatGPT sign-in |
| Desktop side | `src/main/remote-box.ts` (checks, `/admin` client, config pushes), `ProcessHost.switchBox`, coordinator uploads, local-exec machine info |
| MCP sign-ins | `src/main/mcp-auth.ts` signs in on the PC; `src/box-server/mcp-sign-ins.ts` keeps and refreshes them on the server; `/admin/mcpSignInTarget`, `/admin/importMcpSignIn`, `/admin/signOutMcpServer` |

Gateway additions for both box kinds:
- `GET /livez` (204, no token).
- `POST /attachments?name=` stages an upload on the box.
- `GET /media?path=` returns files under the box's `attachments/` folder only.
- `/pc/register` gains `machine` (hostname, OS, the PC's workspace root).

Box config gains an optional `timeZone`.

## Running it

From `app/deploy`:
1. `cp .env.example .env` and set `BOX_DOMAIN` (a DNS name pointing at the server; ports 80 and 443 open).
2. `docker compose up -d --build`. Add `CLAUDE_CODE=1` in `.env` to also install Claude Code.
3. `docker compose exec box cat /data/gateway-token`.
4. In the app: Settings → Box → Remote server, `https://<BOX_DOMAIN>` and that token.

The server needs no inbound port besides 80/443. Without Docker: `npm run build:box-server`, then
`node dist/box-server/main.cjs --data-dir <dir>` behind any TLS proxy. Every setting is in `--help`.

Cost:
- **Hetzner CX23**: 2 vCPU, 4 GB RAM, 40 GB SSD. About €5.49/month plus about €0.50 for an IPv4 address in Germany.
  Published figures disagree after Hetzner's 2026 price changes and vary with VAT and location, so check the price page.
- **DigitalOcean $6/month droplet**: 1 vCPU, 1 GB RAM. Enough for the box: the container idles at about 45 MiB, plus
  whatever the MCP servers you add use. Claude Code documents 4 GB RAM as its minimum, so pick the CX23 (or add swap)
  for Claude Code agents.
- Model usage and E2B stay billed by those providers, as on the PC.

## TLS

- **Default: Caddy in front.** `deploy/Caddyfile` gets and renews a Let's Encrypt certificate for `BOX_DOMAIN`. It
  forwards everything to the box with `flush_interval -1`, so the two SSE streams aren't buffered. The box listens on
  the Compose network only (`expose`, not `ports`).
- **In-process TLS.** Set `WISP_BOX_TLS_CERT` and `WISP_BOX_TLS_KEY` (PEM files, e.g. from certbot or your own CA).
- **Claude Code's bridge stays local.** On the server it always gets its own plain-HTTP listener on 127.0.0.1, serving
  only `/bridge/*`, so bridge calls never face the network. The gateway port doesn't serve the bridge routes.
- **Refusals on both ends.**
  - The server won't listen on a non-loopback address over plain HTTP unless `WISP_BOX_BEHIND_TLS_PROXY=1` says a
    proxy terminates TLS.
  - The app accepts `https://` addresses, or `http://` only for loopback (an SSH tunnel:
    `ssh -L 8787:127.0.0.1:8787 server`).
  - Certificates must be publicly trusted.
- **No domain?** `tailscale serve` gives the box an `https://<host>.<tailnet>.ts.net` address with a valid certificate,
  reachable only from your own devices.

## Auth tokens

- **One 256-bit bearer token.** It is created on first start as `/data/gateway-token` (mode 0600), or comes from
  `WISP_BOX_TOKEN` / `WISP_BOX_TOKEN_FILE` (at least 32 characters).
  - Every route except `/livez` requires it, compared in constant time: the coordinator's `/api` and `/events`,
    local-exec's routes, uploads and media, and main's `/admin`.
  - It travels in a header, never a cookie, so a web page can't ride on it.
- **On the PC** the token is kept with the other secrets (Electron `safeStorage`, `box-remote-token`). It is never
  stored in `settings.json` and never given to the renderer: the Settings form hands it to main once, and later only
  "saved" is shown.
- **Checked before switching.** Main probes `/health` with the token and checks the protocol version before anything
  changes. A wrong token leaves the app on its current box.
- **Rotating.** Change `WISP_BOX_TOKEN` (or delete `/data/gateway-token`), restart, and paste the new one in
  Settings → Box.
- **What the token grants.** Whoever holds it can run agents with the box's keys, push configuration, and ask the PC for
  tools.
- **The PC keeps the last word on its own tools.** A box reached over the network shouldn't be able to approve commands
  on the PC, so these checks were added to the PC side (`src/local-exec/approvals.ts`):
  - Permissions and standing grants stay in the local-exec daemon.
  - When a call needs consent, the daemon issues an approval id for exactly that call and registers the card's content
    with main. The card shows the daemon's own description, not the box's copy.
  - The coordinator records the user's click on the PC before relaying it.
  - A resent call runs only if all three match: same agent, tool and arguments, the user's own answer, used once. So a
    box, or whoever controls the server, can ask but can't approve, can't reword the card, and can't reuse an approval
    for another command.
  - Calls the PC's settings allow without asking still run without a card, as for the local box: read-only commands,
    files in the agent's own folder, and permissions set to Always allow.
  - The daemon now decides each agent's folder itself from the agent id, so a box can't point the "writes inside the
    workspace never ask" rule elsewhere.
- **Bridge runs.** Claude Code bridge calls use per-run tokens, as before.

## How provider keys reach the server

Three sources, merged per provider; the highest wins:

| Precedence | Source | Where it lives on the server |
| --- | --- | --- |
| 1 | The app: Settings → Models and Cloud computer pushes the same configuration the local box gets over `box-control` to `POST /admin/configure`, over TLS | `/data/app-config.json` (0600), so the box keeps working with the PC off |
| 2 | Environment: `XAI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `E2B_API_KEY`, `WISP_BOX_*` (`deploy/box.env`) | process memory |
| 3 | `WISP_BOX_CONFIG` (default `/data/box-config.json`) | that file |

- A provider the app doesn't send falls back to the server's own key, so keys set on the server stay available.
- `WISP_BOX_ADMIN=off` makes the box refuse pushes; keys then come only from the server. Reading the status and
  listing models still work.
- `/admin/status` reports where each provider's key came from (`app` / `server`), never the keys.
- The app's paths never apply on the server: its workspace folder and its Claude Code executable.
- Web search follows the app's switches. For a box the app doesn't configure, `WISP_BOX_WEB_SEARCH=off` and
  `WISP_BOX_X_SEARCH=off` (or `webSearch` / `xSearch` in the config file) turn it off.
- The app also sends its time zone. A server usually runs in UTC; the box then fires "weekdays at 09:00" at 09:00 where
  the user is and reschedules automations. `TZ` on the server overrides it.
- Secret environment variables are removed from the process once read. MCP servers and Claude Code inherit the box's
  environment, and an inherited `ANTHROPIC_API_KEY` would switch Claude Code from your plan to API billing (it outranks
  a subscription sign-in in `-p` mode).
- A headless server has no keychain: keys rest in 0600 files on the volume. Use disk encryption, provider spend limits
  and scoped keys where providers offer them.

## ChatGPT plan tokens

Sign in with ChatGPT redirects to a `127.0.0.1` loopback, which can't reach a browser on a server. OpenAI's guidance for
self-hosted VMs:
- give the VM a stable `ext_agent_host_id` before importing;
- sign in locally with the same client, user and workspace;
- copy the protected credential file to the VM over a secure channel, keeping the VM's own host id;
- let the VM own every later refresh.

Wisp follows it:
- **Host id.** On first start the box creates `/data/chatgpt-host-id`. An import never replaces it.
- **Signing in.** With a remote box, **Continue with ChatGPT** runs the usual PKCE flow on the PC. It then posts the
  credentials over HTTPS to `/admin/importChatGptSignIn`: the issued client id, access, refresh and ID tokens, scopes
  and email. The box saves them as `/data/chatgpt-auth.json` (0600). Settings → Box offers **Move to the box** for a
  sign-in already on the PC.
- **Only one holder.** Every refresh returns a replacement refresh token, so two holders would invalidate each other.
  The PC therefore deletes its copy after the move, without revoking it. Its configuration pushes then say only "use
  your sign-in", never carrying tokens.
- **Refreshes on the box** are serialized and written atomically before the next one.
  - A spent or revoked refresh token (`invalid_grant`, `refresh_token_reused`, …) clears the file and asks for a new
    sign-in from the app.
  - Network or 5xx failures keep the credentials, per OpenAI's errors guide.
- **Sign out** in Settings → Models revokes the box's refresh token and deletes the file. Switching back to This PC
  needs a new sign-in on the PC.
- **OpenAI's own limit.** Host-specific usage attribution and revocation for transferred sessions aren't available yet.
- **Admin off.** With `WISP_BOX_ADMIN=off` the sign-in can't be moved; use an OpenAI API key on the server instead.

## MCP server sign-ins

Remote MCP servers (Streamable HTTP) that answer 401 need an OAuth sign-in: MCP authorization, with protected resource
and authorization server metadata, dynamic client registration and PKCE. Its redirect goes to a `127.0.0.1` loopback,
which only a browser on the PC can reach, so Wisp does what it does for ChatGPT:
- **Signing in.** **Sign in** in Settings → MCP servers asks the box for the server's address and the challenge from
  its last 401 (`/admin/mcpSignInTarget`). The PC then runs the whole flow: discovery, client registration, the browser
  step and the code exchange. The registration is for the PC's loopback redirect, so the PC keeps it (encrypted) for
  the next sign-in.
- **Handing it over.** Main posts the result to `/admin/importMcpSignIn`: the client id (and secret, if the server
  issued one), token endpoint, resource, and access and refresh tokens. The box saves them by server id in
  `/data/mcp-auth.json` (0600) and reconnects the server. The PC keeps no copy of the tokens.
- **Refreshes on the box.** The box refreshes a token shortly before it expires, or once after a 401, one refresh per
  server at a time, and saves each rotated refresh token before the next refresh.
  - A refused refresh (`invalid_grant`, `invalid_client`, `unauthorized_client`) removes the sign-in, and the server
    shows "Needs sign-in" again.
  - Network failures keep it.
- **Bound to the address.** A sign-in is used only for the URL it was made with. The box refuses an import for another
  address (409), so a server removed and added again under the same name needs a new sign-in.
- **Sign out** in Settings, or removing the server, revokes the refresh token (RFC 7009, when the server offers
  revocation) and deletes it.
- **Admin off.** With `WISP_BOX_ADMIN=off` the box takes no sign-ins and the app says so before opening the browser.
  Put a token in the server's headers instead: `{"url": …, "headers": {"Authorization": "Bearer …"}}`.

Why the PC runs the flow: one pattern then covers both of Wisp's sign-ins and both box kinds:
- For the box on the PC, main keeps the sign-in in the keychain and the box only gets access tokens over `box-host`,
  as with ChatGPT.
- For a remote box, the same code runs on the PC, then hands the result over.

What that costs:
- The PC must reach the MCP server's metadata and its authorization server, which hosted connectors allow.
- The tokens cross to the box once, over the same TLS connection and bearer token as everything else on `/admin`.
- A server only the box can reach (a private address on the server's network) can't be signed in to this way; give it
  a header token.

## E2B from the server

- The cloud computer works unchanged from the server: the SDK needs only the key and outbound HTTPS. The key comes from
  Settings → Cloud computer (pushed) or `E2B_API_KEY`.
- Its sandbox id lives in the box's data folder, so each box has its own cloud computer, with the same pause-on-idle
  lifecycle. "Watch desktop" still opens E2B's noVNC page directly on the PC.
- This pairs well with the remote box. While the PC is off, agents set to **This PC** have no tools (the daemon is
  offline, and the prompt says so). Agents set to **Cloud computer** keep a whole Linux machine around the clock. For
  automations that must act while you're away, pick Cloud computer.

## Claude Code on the server

- **It runs on the server.** The Claude Code engine spawns `claude -p` where the box runs. Build the image with
  `CLAUDE_CODE=1`: it installs `@anthropic-ai/claude-code` (the native binary) with its self-updater off; rebuild to
  update.
- **Sign in on the server, through Claude Code's own flow.**
  - `docker compose exec -it box claude auth login` prints a URL. You open it anywhere and paste the code back (the
    flow Claude Code documents for SSH sessions and containers).
  - Or put a one-year `claude setup-token` token in `box.env` as `CLAUDE_CODE_OAUTH_TOKEN`.
  - Credentials live in `/data/claude` (`CLAUDE_CONFIG_DIR`) on the volume. Settings → Models shows the box's Claude
    Code status; **Check again** re-detects it there.
- **The app never moves Claude credentials.** Anthropic doesn't allow third-party apps to collect, store or intermediate
  Claude.ai credentials or tokens; sign-in has to complete in Anthropic's own flow.
- **Anthropic's commercial terms for hosted Claude Code** (Claude Code's *Legal and compliance* page). Preinstalling or
  running Claude Code in products or services, such as hosted sandboxes or agent infrastructure, requires the Commercial
  Terms, and:
  - the binary must be unmodified, with its authentication methods intact;
  - every end user authenticates with their own Anthropic key, Claude plan or cloud-provider credential;
  - nobody resells or intermediates that usage.
- **A personal box fits those terms**: you are its only user, on your own account or key. Don't share one box across
  people on one sign-in.
- **Plan limits.** Pro and Max limits assume ordinary individual use. For heavy unattended 24/7 automation, a Claude
  Console key fits better: sign in to Claude Code on the box with the Console account (pay per token, under the
  Commercial Terms). The box's own `ANTHROPIC_API_KEY` is never passed to Claude Code.

## The PC side

- **Switching.** Settings → Box applies a switch in this order:
  1. Check the server.
  2. Stop the box process.
  3. Restart the coordinator and local-exec against the server, then push the configuration.
  4. Reload the window, which opens Settings → Box again.
- **Agents live on their box.** Switching shows that box's agents; nothing is migrated (copy `agents.json`,
  `transcripts/`, `automations.json` and `todos/` between data folders by hand if needed).
- **local-exec dials out**. It registers with the server whenever the PC is on, reports the PC's
  hostname, OS and workspace folder, and keeps its reconnect backoff (0.5 → 15 s).
  - The box keeps the last report, so prompts still describe the PC while it's off.
  - Tool calls carry only the agent id; the daemon picks `<userData>/box/workspaces/<agentId>` itself.
  - Approval cards show the PC's hostname.
- **Attachments.** The coordinator uploads staged attachments, only from main's staging folder, before relaying
  `deliverMessage`. `wisp-media://` fetches the box's images from `/media` with the token.
- **MCP servers** added in Settings run on the box, so the image includes `npx`. The box also makes the requests to
  remote (HTTP) servers, so a server on the PC's own `localhost` is out of a remote box's reach.

## Limits and follow-ups

- **One daemon per box**: a second PC that dials in replaces the first.
- **One token**: no per-device tokens or revocation list.
- **No migration** of agents between boxes, and no box auto-update: rebuild the image.
- **Non-image attachments** on a remote box show a chip that opens a local folder, and the path is the server's.
- **Keys removed in the app** stop being used only when the server has none of its own; the app can't delete server-set
  keys.

Verification:
- Unit tests (`test/unit/box-server.test.ts`): settings and precedence; TLS and loopback refusals; tokens; admin
  persistence and admin-off; an HTTP+SSE prompt round-trip with a fake Windows daemon; uploads and media; the ChatGPT
  import, refresh rotation and failures against a fake auth server; time zones; main's remote client; the daemon's
  folder and approval rules (invented, swapped and replayed approvals refused).
- `test/unit/mcp-http.test.ts`, against a fake MCP server and a fake authorization server: the MCP sign-in hand-off
  (target, a sign-in made with main's code, import, the box's own refresh after a 401, the address check, sign-out with
  revocation, admin-off refusal).
- `test/e2e/remote-box.mjs` drives the built app against the standalone server:
  - a wrong token is refused;
  - after connecting, a prompt round-trips;
  - a tool the box calls writes a file on the PC;
  - a risky command waits for Allow once on the PC's card, then runs;
  - an attached image is uploaded and shown;
  - switching back restores the PC's agents.
- The image was built and run locally: it refuses plain HTTP on `0.0.0.0`, serves behind the proxy flag, runs as
  `node`, and Docker reports it healthy.
- `deploy/docker-compose.yml` with `BOX_DOMAIN=localhost` ran locally. Through Caddy's TLS (its internal CA for
  localhost) it served `/livez`, `/health` with the token, and gateway events streamed live over SSE.
- Not exercised: a public deployment with a Let's Encrypt certificate, the real OpenAI, Anthropic and E2B services, and
  Claude Code signed in inside the container.
