# Wisp

> [!NOTE]
> Wisp is still in development, and this isn't the final version. Expect bugs, unfinished features and changes
> between releases.

A desktop app for personal AI agents. You message your agents ("wisps") like contacts: each one has its own
conversation, todo list, automations, skills, connected apps, files and memories, and can use tools on your computer
with your approval.

How it's built:
- Electron main, plus a preload exposing `window.desktop`.
- A coordinator utility process, a "box" that runs the agents, and a `local-exec` daemon for tools on your computer.
- Typed RPC edges between processes.

The box runs on this PC by default, or on an always-on server of your own (**remote box**), and agents use **your own
model accounts**: xAI, OpenAI (API key or your ChatGPT plan), Anthropic, your installed Claude Code, or any
OpenAI-compatible endpoint. Agents work on this PC by default, or on an optional **cloud computer**.

## Install on Windows

For 64-bit Windows 10 or 11. The PC needs nothing else: Git and Node.js are only for [running from source](#run-from-source).

1. Download `Wisp-Setup-<version>.exe` from the **Assets** of the [latest release](https://github.com/adam-N-singh/wisp/releases/latest).
2. Run it. Wisp installs for your Windows user (no admin rights), adds a Start menu entry and a desktop shortcut,
   and opens.
3. The installer isn't code-signed, so Windows may warn about it:
   - If your browser says the file isn't commonly downloaded, choose **Keep**.
   - If SmartScreen says "Windows protected your PC", choose **More info → Run anyway**.
   - Windows 11's Smart App Control, when it's on, blocks unsigned apps outright. Run Wisp from source instead.

The installed app keeps itself up to date from new releases (see [Installer and updates](#installer-and-updates)).
To remove it, open **Settings → Apps → Installed apps** and choose **Uninstall** in Wisp's **…** menu. Your agents and
settings in `%APPDATA%\Wisp` are kept.

## Run from source

You need Git and Node.js 22.19 or newer (developed on Node 24). With an older Node.js, `npm install` stops with an
`EBADENGINE` error.

```bash
git clone https://github.com/adam-N-singh/wisp.git
```

```bash
cd wisp
```

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` builds every process and starts the app. Electron doesn't download during `npm install`; the first
start fetches it (about 100 MB). The end-to-end tests launch the Electron binary directly, so on a new computer start
the app once, or run `node node_modules/electron/install.js`, before `npm run test:e2e`.

Your agents, settings, keys and sign-ins live in the app's data folder on each computer (`%APPDATA%\Wisp` on
Windows), not in the repository, so connect your model providers again on each device.

On first launch the onboarding asks how agents should reach a model (see below), or you can choose the offline
**mock model** to try the app without a network. Connect more providers, pick the default model, set reasoning
effort and turn web search on or off in **Settings → Models**; each agent can override the model in its settings. Keys and sign-in tokens are
encrypted with your OS keychain (Electron `safeStorage`) and only sent to their provider.

## Models and providers

Several providers can be connected at once; a model is named `provider:model` (agents store their override that way).

| Provider | How it connects | API | Web search | Notes |
| --- | --- | --- | --- | --- |
| xAI | API key | Responses (`https://api.x.ai/v1/responses`) while web search is on, otherwise Chat Completions | `web_search` and `x_search` (posts and people on X) | Default `grok-4.7`; encrypted reasoning and search calls are replayed between steps |
| OpenAI, API key | API key | Responses API, `store: false` | `web_search`, with the pages each search consulted | Default `gpt-6.1-sol`; encrypted reasoning items and search calls are replayed between steps |
| OpenAI, ChatGPT plan | **Continue with ChatGPT** | Responses API with the plan's OAuth token | `web_search` (allowed on the plan route, subject to the account's or workspace's policy) | OpenAI's Sign in with ChatGPT for local apps: PKCE on a `127.0.0.1` loopback, dynamic client registration, `chatgpt.tokens.use.direct` scope. Requests draw on the Plus/Pro plan's included usage; cap the app in ChatGPT settings → Usage |
| Anthropic | API key | Messages API via `@anthropic-ai/sdk` | The `web_search_20250305` server tool | Default `claude-opus-5-5`; adaptive thinking (summarized), thinking blocks, search results and citations replayed unchanged, `drop_block` for mismatches, server-side refusal fallbacks, prompt caching |
| Claude Code | Your installed `claude` CLI and its own sign-in | `claude -p --output-format stream-json` per turn | Claude Code's own WebSearch tool | How to use a Claude Pro/Max plan here: Claude Code runs the agent in its workspace with its own tools; the app's tools (questions, automations, screenshots, clipboard) and approval cards reach it through a stdio MCP bridge (`--permission-prompt-tool`) |
| Custom endpoint | Base URL (+ optional key) | Chat Completions | None | OpenRouter, Ollama, LM Studio, … |

**Web search** (Settings → Models, on by default) lets agents answer from the live web:
- Each provider runs its own search inside the model's reply, billed with the model; there's no separate search
  key. Grok models also search X unless you turn off **Search X with xAI**.
- While a search runs, the agent's activity reads "Searching the web for “…”". The reply's
  sources show under it: the pages it cites as chips, and every page the search found when you open the list. Links
  open in your browser.
- xAI's search tools exist only on its Responses API (Live Search on Chat Completions was retired), so xAI requests
  go there while search is on: `store: false`, with encrypted reasoning and search calls replayed as for OpenAI.
  With search off, xAI stays on Chat Completions.
- Anthropic gets the basic search tool. The newer versions filter results by running code in an Anthropic sandbox,
  a second computer that agents with a shell on this PC could confuse with it, and they aren't ZDR-eligible.
- A turn Anthropic's search loop pauses (`pause_turn`) is sent back unchanged and continues. A search that never ran
  (the run stopped first) is left out of later requests, so it can't break the conversation.
- If a provider refuses the search tool (a model without it, or search turned off for the account or workspace), the
  request is sent again without it and a notice says so. That model answers without searching until the app restarts.
- The offline mock acts out a search for `/search <query>`: the activity, a cited reply and its sources, no network.

**Voice** (dictation, voice memos and Read aloud, see [What you can do](#what-you-can-do)) uses the providers' own
speech APIs, with an API key:
- xAI: speech to text (`POST /v1/stt`, with word timings) and text to speech (`POST /v1/tts`, with the voices
  `GET /v1/tts/voices` lists).
- OpenAI: `POST /v1/audio/transcriptions` with `gpt-transcribe`, and `POST /v1/audio/speech` with `gpt-4o-mini-tts`
  (13 voices). OpenAI shuts that speech model down on 6 January 2027, and its successor works only over the
  Realtime API.
- A ChatGPT plan sign-in can do neither: it only reaches `/v1/responses`. Anthropic, Claude Code and custom endpoints
  have no speech API here. With neither xAI nor an OpenAI API key connected, the microphone says what to add, and Read
  aloud doesn't show.
- A recording is transcribed by the agent's own provider when it can, otherwise by xAI, then OpenAI. A WebM recording
  (from a recorder that can't make MP4) goes to OpenAI, because xAI doesn't list WebM. Replies are read aloud by the
  provider of the agent's voice.

Subscription plans and the rules that apply:
- **ChatGPT**: OpenAI documents Sign in with ChatGPT plan usage for open-source and locally hosted apps; the app follows
  its UI rules ("Continue with ChatGPT", a one-time "You're using your ChatGPT plan" notice, "Using ChatGPT plan ·
  Manage usage" by the composer, Manage usage on limit errors). Only `/v1/responses` is called; temperature and other
  unsupported fields are never sent, and tools go in one namespace.
- **Claude**: Anthropic does not allow third-party apps to offer Claude.ai sign-in or to use Free/Pro/Max credentials,
  so this app never handles them. It runs your own unmodified Claude Code, which you sign in to yourself (Settings →
  Models → Claude Code → Sign in opens `claude auth login` in a terminal). Anthropic's terms describe plan limits as
  sized for ordinary individual use of Claude Code; for anything you distribute to others, use API keys.

## Cloud computer

Agents can work on a cloud Linux machine instead of this PC (pick **This PC** or **Cloud computer** per agent). It is
one [E2B](https://e2b.dev) sandbox shared by your cloud agents, each in `/home/user/agents/<agentId>`:
- Created on the first cloud tool call with `lifecycle.onTimeout: "pause"`; it pauses itself after the idle time you
  choose (default 10 minutes) and `Sandbox.connect` resumes it with its disk, memory and processes.
- E2B bills per second while it runs (about $0.05 per vCPU-hour) and nothing for compute while paused.
- **Headless** gives shell and file tools with the local tools' names (`run_shell`, `read_file`, …). **Desktop**
  (`@e2b/desktop`) adds `take_screenshot`, `computer_click/type/key/scroll/move/drag` and `open_url`, plus a live view
  (noVNC) you can open from Settings or the agent's Computer tab.
- It is isolated from this PC, so its commands run without approval unless you turn on "Ask before running commands".
- Background commands run there too (see [What you can do](#what-you-can-do)). The box checks on them every 5 s,
  rewriting each log's header as the PC's daemon does, which keeps the sandbox from pausing while one runs. One you
  pause yourself stays paused, and its commands with it: Async tasks then shows their output from before rather than
  waking it.

OpenAI's and Anthropic's hosted containers were considered but only run commands their own models issue (and expire
after 20–60 minutes idle), so they can't serve as a general computer for every provider. For automations that must run
24/7 with this PC off, run the box itself on a server (next section).

## Remote box

The box (agents, transcripts, automations, model calls, MCP servers, Claude Code runs) can run on a small always-on
server instead of this PC. Agents and their cron automations then keep running
while the PC is off. Tools on this PC work whenever it's on: its local-exec daemon dials out to the server.

```bash
cd deploy && cp .env.example .env
```

Set `BOX_DOMAIN` in `.env` to a DNS name that points at the server, then start the box and Caddy (automatic HTTPS):

```bash
docker compose up -d --build
```

Read the generated token, then in the app open Settings → Box → **Remote server** and enter `https://<BOX_DOMAIN>` and
the token:

```bash
docker compose exec box cat /data/gateway-token
```

- The app checks the address and token, moves the coordinator and local-exec to the server, and sends your model and
  cloud-computer settings, which the box keeps so it runs with the PC off.
- A ChatGPT sign-in moves to the box, which refreshes it from then on (OpenAI's flow for self-hosted machines). So do
  MCP server sign-ins: you sign in on the PC, and the box keeps and refreshes the result.
- Claude Code runs on the server: build with `CLAUDE_CODE=1` in `.env`, then sign in there with
  `docker compose exec -it box claude auth login`.
- Agents live on the box they were created on.
- A background command on the PC keeps running while the PC's connection to the server drops. The daemon reports
  its start and end as they happen and sends its whole list each time it reconnects, so an end the box missed still
  reaches the agent.
- A bot template you publish for anyone with the link is served at `https://<BOX_DOMAIN>/t/<shareId>` without the
  box's token (see Bot templates under [What you can do](#what-you-can-do)).

[`docs/remote-box.md`](docs/remote-box.md) covers TLS, tokens, how keys reach the server, E2B,
Claude Code's terms and costs (a Hetzner CX23 or a $6 DigitalOcean droplet). Without Docker: `npm run build:box-server`,
then `node dist/box-server/main.cjs --help`.

Other scripts:

| Script | What it does |
| --- | --- |
| `npm run build` | Bundle every process into `dist/` (esbuild for Node-side bundles, Vite for the renderer) |
| `npm start` | Launch the built app |
| `npm run typecheck` | `tsc --noEmit` over all sources |
| `npm test` | Unit tests: RPC framework, box store and harness, skills (SKILL.md parsing and imports, the store, the harness and Claude Code engine using them, scheduled runs, a gateway round-trip with the mock model), memory (the store, the rules and budget, the prompt, the tools and review, a scripted model, Claude Code's bridge, a gateway round-trip with the mock model through Start fresh conversation), message search (across agents and in one conversation with paging, hidden agents in the roster, automation edits), voice (who transcribes and speaks, xAI's and OpenAI's speech requests against a fake speech server with word timings, language hints and refusals, replies as speakable text in parts, voice memos in the harness and through the gateway with the mock model, a recording uploaded once to a remote box, the web-permission rules), message actions (reactions and Good / Bad votes stored on the entry, sent as ordered `updated` events and kept across a restart, out of the model's conversation; reply quotes in the model's prompt), visualizations (the box tool, its store and `/media`, the frame's document), documents (titles from the first heading, card excerpts, edits that must match once, the note on the user's next message; the page store with each revision's Markdown by hash, a restart, the oldest revisions dropped and Markdown no page names deleted, also with the agent; stale revisions refused, a whole new text refused without its base revision, restore; the tools posting a card and updating it in place, also after Start fresh conversation, and an `editable` event when the run that wrote a page ends; Claude Code's bridge; through the gateway with a scripted model: read-only while the agent writes, the 409s, the Library, revisions, restore, delete and `page-changed` events), the full conversation outline (what each kind of entry shows, without tool arguments, output or replay state; an event only when an item is new or changed; new items put in their place; a gateway round-trip with the mock model: thinking, replies and tool calls done and failed, kept live by events, each call's detail on request, `/echo`, Start fresh conversation), model adapters (Chat Completions, Responses incl. the ChatGPT plan route and xAI, Anthropic; each provider's web search: request shapes, search activity, citations, replay, `pause_turn`, refused tools) against local fake servers, Sign in with ChatGPT against a fake auth server, remote MCP servers (Streamable HTTP, OAuth discovery, registration, PKCE, refresh, a tool call through the approval card, the hand-off to a remote box) against a fake MCP server and a fake authorization server, Connect Apps (every catalog entry checked, fields filled into addresses and headers, apps and more accounts added through the gateway against fake MCP servers, renames, a new token, removal, replies and events in order, switched-off tools kept from the model and from Claude Code, app instructions in the prompt only while the app's tools are on), bot templates (the format and its checks, hidden characters taken out, an agent made into versions and a new agent made from one through the gateway with the same skills, routines and memories, publishing and the tokenless `/t/` link, imports that report what they skip, routines that don't run until switched on, main's fetcher, every starter in the gallery and its listing), background commands (real processes started into their log, awaited for a line of output and to their end, stopped with every process they started, a command past its timeout kept running; a restarted daemon marking what it can't see as lost; the box's registry, the hidden message and wake when one ends unseen, none after a stop or an await, lost tasks after a restart of the box or the PC, the cloud computer's against a fake sandbox, and a remote box whose PC drops and reconnects), plugin marketplaces (sources however they're written, the marketplace and plugin formats with what isn't supported, GitHub archives read entry by entry with links, escapes and long names; through the gateway against a fake GitHub: a marketplace indexed and pinned, plugins reviewed, refused without the review or with a stale one, installed with their values and a server that runs only once confirmed, without the box's keys in its environment, read-only plugin skills without their hidden characters, run and copied, a second plugin with an installed one's name refused, a plugin in its own repository read on demand, a restart, a refresh that never moves an installed plugin, an update that asks again when its command changes, uninstall, a marketplace added by its link, removal), updates (a check, the download and its progress, ready and announced once, kept ready through later checks and failures unless a newer version turns up, one check at a time, the automatic schedule switched off and on, short error lines, nothing in a development build), the Claude Code engine against a fake CLI, the MCP bridge, cloud tools, cron, command classifiers, permission policy, the standalone box server (settings, TLS, tokens, admin, gateway round-trip, uploads, ChatGPT refresh, time zones) |
| `npm run test:e2e` | Build, then drive the real app with Playwright, the mock model and a local fake OpenAI-compatible endpoint. Screenshots go to `test/e2e/screenshots/`; one of them captures your actual screen |
| `npm run test:e2e:remote` | Build, start the standalone box server on loopback, and switch the real app to it (prompt, a PC tool call, an image upload, switching back) |
| `npm run build:box-server` / `npm run box-server` | Build only the standalone box server and the Claude Code bridge; run it (`--help` lists its settings) |
| `npm run package` | Production build (minified, `NODE_ENV=production`), then a Windows NSIS installer via electron-builder in `release/`, with the `latest.yml` and blockmap updates use; nothing is uploaded. It isn't code-signed, so Windows SmartScreen asks once: **More info → Run anyway** |
| `npm run release` | The same, then uploads the installer, blockmap and `latest.yml` to a draft GitHub release (needs `GH_TOKEN`; see [Installer and updates](#installer-and-updates)) |

To use a separate data folder, pass `--user-data-dir=<dir>` or set `WISP_USER_DATA_DIR`.

## Installer and updates

`npm run package` builds `release/Wisp Setup <version>.exe`. It installs Wisp for the current Windows user (no admin
rights) with a Start menu entry and a desktop shortcut, and the PC needs nothing else. It isn't code-signed, so
SmartScreen asks once (**More info → Run anyway**), and Windows 11's Smart App Control, when on, refuses it.

The installed app updates itself from this repository's GitHub Releases, with electron-updater:

- Shortly after it starts and then every 4 hours, it checks the latest published release. A newer version downloads in
  the background (only the changed blocks, when it can) and installs silently the next time Wisp quits.
- As Wisp keeps running in the tray, a downloaded update also shows a notification and a **Restart to update** item in
  the tray. **Settings → About** has the same button, **Check for updates** and the **Automatic updates** switch
  (checking from Settings works with it off).
- A development build (`npm run dev`) doesn't update.

To publish a release:

1. Raise `version` in `package.json`: `npm version patch` (or `minor`, `major`) commits it with a `v<version>` tag. Push both.
2. Set `GH_TOKEN` to a GitHub token that can write to this repository (fine-grained: **Contents: Read and write**).
3. `npm run release` builds the installer and uploads it, its blockmap and `latest.yml` to a draft release tagged
   `v<version>`.
4. Publish the draft on GitHub. Installed copies pick it up on their next check; drafts and pre-releases are skipped.

The repository and its releases must be public, as installed copies read them without a token.

## What you can do

- **Agents**: create bots with a name, role, instructions, avatar (26 shapes × 9 colors) and an optional model override. Pin, rename, duplicate, share as a template, delete, or start a fresh conversation.
  - Each sidebar row has an actions menu (its … button or a right-click), as does the conversation's **More**
    button: also **Mute finished notifications** (questions and approvals still notify) and **Hide from sidebar**.
  - Hidden agents are listed in a **Hidden agents** group at the end of the sidebar, where **Show in sidebar** brings
    one back. They can still be opened from there, the palette or a notification.
- **Full conversation**: **Show full conversation**, in an agent's actions menu, behind the outline button in the
  conversation's header, or in the palette, opens an outline of the whole conversation in order: your
  messages, the model's thinking, the replies, the cards the agent posted (questions, approvals, visualizations) and
  every tool call, with a spinner while it runs, an x-circle when it failed and a wrench when it's done.
  - A tool call opens to its arguments and output, which the box sends only then (`getToolCallDetail`). The outline
    itself comes from `readOutline` and stays live from the box's `outline` events, so a reply still being
    written grows in it. Long messages are cut down until you open them.
  - It has a tab per conversation: only **Main** for now, as agents have no subagents yet. The chat keeps its collapsed
    tool lines as well.
- **Command palette**: **Ctrl+K** ("Jump to") finds agents, actions (New agent, Connect Apps, each Settings section,
  Theme, Keyboard shortcuts, and the open agent's full conversation, async tasks, Skills, Automations, editor, notifications and sidebar visibility) and
  messages; **Ctrl+Shift+F** ("Search agents") lists agents, hidden ones included, and messages. Messages come from the
  box's `findAcrossAgents`, across every conversation. Arrows and Enter pick, **Ctrl+1–9** picks that row (hold Ctrl to see
  the numbers), Esc closes. Picking a message opens its conversation at it, with the find bar open.
- **Find in chat**: **Ctrl+F** opens a find bar over the conversation. The box searches the whole conversation
  (`findInConversation`, newest first, paged with `beforeSeq`), so **Enter** steps to an older match and
  **Shift+Enter** to a newer one, loading older pages (up to 20) to reach it. Matches are painted with the CSS Custom
  Highlight API, the current one apart; Esc closes. New replies that match are added as they finish.
- **Keyboard shortcuts**: **Ctrl+/** lists them all. Besides the above: **Alt+↑/↓** previous or next agent, **Ctrl+1–9**
  agent 1 to 9 in the sidebar, **Ctrl+Tab** / **Ctrl+Shift+Tab** cycle through agents (let go of Ctrl to open one),
  **Ctrl+D** dictation, **Ctrl+N** new agent, **Ctrl+,** settings, **Ctrl+I** the message box, **Ctrl+B** sidebar, **Ctrl+Alt+B** details
  pane, **Ctrl+Shift+,** edit the agent, **Ctrl+Shift+W** its skills, **Ctrl+Shift+M** Connect Apps, and on a page
  **Esc** out of its editor and then off the stage, **Ctrl+S** to save it (⌘ for Ctrl on macOS). None clash with Windows, Electron's default menu (Ctrl+W/M/R, Ctrl+Shift+I/R, Ctrl+0/+/−, F11) or the
  desktop mount's Alt+Shift+Space.
- **Chat**: streaming replies with collapsible reasoning, Markdown with highlighted code, math and diagrams, attachments (paste, drop, pick; images go to the model), stop a run, unread tracking, sends that survive restarts.
  - **Message actions**: hovering a message shows a toolbar: **Add reaction** (an emoji picker; reactions
    sit under the message as chips, and clicking yours takes it back), **Reply**, **Copy**, and on the agent's replies
    **Good** / **Bad**. Bad asks what went wrong, with a few reasons to pick from (Not what I asked, Inaccurate, Low
    quality, Too slow) and an optional note. Reactions and votes show at once and are kept with the message in the box
    (gateway `setReaction`, `rateReply`). They aren't sent anywhere else, and the model doesn't see them.
  - **Replies**: Reply puts a quote of the message, or of the text you selected in it, above the message box. The sent
    message carries the quote, and clicking it goes back to the message it answers. The agent reads the quote before
    your text.
  - **Timeline**: a timestamp row ("Today 3:42 PM", "Yesterday …", then the date) opens the conversation and follows a
    gap of 15 minutes or a new day. Scrolled up, a pill offers **Scroll to bottom**, or **New messages** when new ones
    arrive.
  - **Math and diagrams**: `$$…$$`, in a line of text or on lines of its own, and ```` ```math ```` blocks render with
    KaTeX; a single `$` stays text. ```` ```mermaid ```` blocks become Mermaid diagrams
    (`securityLevel: "strict"`), drawn once the reply is finished, with their code a click away. Both load on first
    use, so the main bundle stays small, follow the light or dark theme, and show their source when it doesn't parse.
    The offline mock streams back whatever follows `/echo`, to see how a reply renders.
  - **Visualizations**: agents can show a chart or a small widget with `show_visualization`: an HTML fragment that
    runs in a frame sandboxed to scripts only, with a strict CSP, so it loads nothing from the network and can't
    reach the app. It gets the theme's colors (`--viz-*` CSS variables, `window.WispViz`) and grows to its content's
    height. The box keeps the HTML by its hash in `attachments/visualizations/`.
- **Documents**: agents write Markdown documents for you with `create_document` (a plan, a report, notes, a draft)
  and change them with `edit_document`. Each one shows in the chat as a card, and opening it puts it on the page
  stage: the page on the main stage, with the chat beside it as a companion column (at least
  424 px; drag the line between them to resize). Below about 848 px the page takes the stage, and **Chat** swaps to the
  chat. **Esc** or **Close** goes back.
  - The page renders through the chat's own Markdown (GFM, math, Mermaid, no raw HTML), so it reads like a reply.
    **Edit** shows its Markdown beside a live preview (one or the other on a narrow stage), **Ctrl+S** or **Save**
    saves, and **Esc** leaves the editor. Unsaved edits stay when you close the page or quit the app, and the page's
    card and its Library row say so until you save or discard them.
  - Every save, yours or the agent's, is a revision. **History** lists the last 50 with who made each and opens an
    older one, and **Restore this revision** adds it again as the newest. A save names the revision it was made on,
    so neither side writes over a change it hasn't seen: the agent is told to read the page again (and can replace a
    page's whole text only by naming the revision it read), and you get **Updated by {agent}: Reload / Keep mine**.
    While a run is writing a page, it's read-only for you; the box says when that run ends, and it's yours to edit
    again.
  - The agent learns what you changed from your next message, which starts with a short note naming those pages
    (shown on the message as **Pages you changed**), the way a reply's quote reaches it. The conversation it has
    already read doesn't change. `read_document` gives it a page as it is now.
  - **Save as Markdown…** writes a `.md` file where you pick, and **Copy as Markdown** copies it. There's no sharing
    or public link: pages are yours alone. The agent's **Overview** lists its documents under **Library**. **Delete
    page…** deletes a page and its revisions; its card stays, marked deleted.
  - Pages live in the box, not in the agent's workspace (which may be on this PC while the box is remote, or on the
    cloud computer): `pages/<agentId>/index.json` lists them with their revisions, and each revision's Markdown is
    kept by its hash in `attachments/pages/`. A document holds at most 256 KB, because its tool calls are replayed to
    the model. Claude Code agents get the same tools through the bridge.
- **Voice**: dictate into the message box with **Ctrl+D** or the microphone. Press once to start
  and again to stop, or hold for half a second or more to talk until you let go. "Listening…" and "Transcribing…"
  show in the box, and Esc cancels.
  - **+ → Record a voice memo** sends the recording itself. It's transcribed first, so the model reads it as text, and
    shows in the chat as a playable bubble with its transcript. With xAI, the word being spoken is highlighted, and a
    click on a word plays from there. The speed button cycles 1×, 1.5×, 2× and 0.75×.
  - **Read aloud** under a reply reads it in the agent's voice. Pick the voice and speed in the agent's settings, with
    Preview. Code blocks and links aren't read out; a long reply is read in parts, the first one short so reading
    starts quickly.
  - Recordings are staged like attachments, so a remote box gets each one once, before it's transcribed. A
    dictation's recording is deleted once transcribed; a memo's stays in the box with the conversation. Which
    providers do this: see [Models and providers](#models-and-providers).
- **Web search**: answers from the live web, and from X with Grok models, with the sources under the reply (see [Models and providers](#models-and-providers)).
- **Tools on your computer**:
  - run commands (PowerShell on Windows, your login shell elsewhere)
  - read, write, edit, list and search files
  - list processes, take screenshots, read and write the clipboard, open links
  - drive the agent's own browser (below)
- **Background commands**: `run_shell` with `background: true` starts a command (a dev server, a watcher, a long
  build) and returns at once with its id, after the same approval as any command. A command still running at its
  timeout isn't stopped any more: it goes on in the background. `await_command{id,
  block_until_ms, regex}` waits for one to end, or for its output to match (a server's ready line), and shows the end
  of its output; `stop_command{id}` stops it and every process it started (`taskkill /t` on Windows, the process group
  elsewhere). The same work on the cloud computer.
  - Each has an id from 1000 to 999999 and a log, `terminals/<id>.txt` under `<userData>/local-exec` (or
    `/home/user/.wisp/terminals` on the cloud computer): a header (pid, cwd, command,
    status, start, running time) rewritten every 5 s, the output, and a footer with the exit code. The agent may read
    its own logs without asking.
  - When one ends and the agent didn't wait for it, the agent gets a message the chat doesn't show ("[Background
    command 4242 finished: exit code 0 after 2m 10s]" with the last lines of output) and is woken to carry on. One you
    stop tells it too, without waking it. The full conversation lists these messages as hidden.
  - **Async tasks** (the agent's Overview, its actions menu, the palette, or the "1 running" pill in the
    conversation's header) lists what is running: the command, its computer, how long it has run and the end of its
    output, with **Stop** and **Open log**. The agent shows as working in the sidebar, the header, the tray and the
    desktop panel while it has one running.
  - A command outlives a restart of the daemon on macOS and Linux (it's watched again, its exit code unknown). On
    Windows it stops with it, and what it had started is stopped when the daemon starts again. Either way, and after
    a restart of the computer or the box, the agent hears which were lost. Quitting the app stops them all.
- **Agent browser**: each agent can open web pages in a browser of its own on your PC, a separate window you can
  watch and take over. Agents never touch your everyday Chrome or Edge, and nothing is read from their profiles.
  - All agent browser windows share one saved profile (`persist:agent-browser` in the app's data). You sign in to a
    site there once, from the agent's **Computer** tab (**Open agent browser**) or when an agent asks, and every
    agent finds the sign-in there. That's how "importing cookies" works here: there's nothing to import.
  - One window per agent, titled with its name, rather than one window with a tab per agent: you take over one
    agent's browser while the others keep going, and an agent's tabs stay together. A page that opens a new window
    gets a tab in the same window.
  - The toolbar says who drives. **Take over** gives you the browser (back, forward, reload, the address bar and
    the tabs work then); the agent's next action waits until you select **Hand back**. A blue edge means the agent
    is browsing, green that you are, amber that the agent asked you for something.
  - Agents use `browser_navigate`, `browser_snapshot` (the page's accessibility tree as text, one element per
    line, with refs such as `e7` on what can be clicked or typed into; no HTML), `browser_click`, `browser_type`
    (also picks a dropdown's option), `browser_press`, `browser_scroll`, `browser_screenshot`, `browser_back` and
    `browser_tabs`. Claude Code agents get them through the bridge.
  - To sign in, solve a CAPTCHA or confirm a two-factor prompt, the agent calls `browser_wait_for_user`: the window
    comes to the front with what it needs, the chat asks the question (an `ask_user` card), and the agent goes on
    when you answer. Agents are told never to type passwords, card numbers or codes.
  - Downloads go to the agent's workspace, in `downloads/` (up to 1 GB each). The window shows up on screen without
    taking focus when an agent first browses; closing it closes the agent's tabs, not the profile. Deleting the
    agent closes its window too, and a renamed agent's window takes the new name.
  - The browser runs on the PC, so it works with a remote box too, through the local tools. While the PC is off its
    tools aren't offered, and a call to one says the PC isn't connected.
- **Agent tools in the box**: todo list, questions back to you (answered inline), web fetch, scheduling its own automations, documents.
- **Approvals**: risky actions show a card with **Allow once / Always allow … / Deny / Never**. Remembered decisions are listed in Settings → Permissions.
- **Automations**: cron schedules per agent (presets or raw cron), run now, edit, enable/disable.
- **Skills**: named Markdown instructions each agent keeps, in the agent's **Skills** tab
  (**Ctrl+Shift+W**). Create and edit them, import a SKILL.md or any Markdown by pasting it or from a link (GitHub file,
  skill-folder and gist links fetch the raw file), run one now, or run it on a cron schedule.
  - The agent's system prompt lists each skill's name and description, and the agent loads one with `load_skill`
    when a request matches. Claude Code agents get the same list and tool through the bridge.
  - Typing `/` in the composer lists the agent's skills. A message that starts with `/<skill-name>`, Run now, and
    the schedule all send the skill's instructions with the message, as the skill read when sent.
  - Each skill is a SKILL.md file in the box, `skills/<agentId>/<skillId>.md`, with `name` and `description`
    front matter. Other front matter (`license`, `allowed-tools`, …) is kept when you edit the skill.
    `disable-model-invocation: true` hides the skill from the agent, so it runs only when you run it. The
    schedule, runs and source link live in `skills/<agentId>/index.json`. A `.md` file added to the folder by hand
    shows up on the next start.
  - Plugins installed from a marketplace add their skills to every agent, under **From plugins**, read-only (see
    Plugin marketplaces below). **Copy to agent** makes one an ordinary skill of the agent's, linked to its source.
- **Memory**: each agent remembers what it learns about you across conversations, also after **Start fresh conversation**. The agent's **Overview** says how much it remembers, and
  **Open memory** lists the memories to add, edit and delete. **Import memory** sends the agent notes you paste (or
  what another assistant remembers about you, using the prompt shown there to ask it), and the agent saves what's
  worth keeping.
  - The agent's system prompt lists its memories with their ids and dates, read when a turn starts, plus guidance on
    what to keep: facts about you and your work, your preferences, and how you like work done, but no secrets. The
    agent saves, rewrites and forgets memories with `save_memory`, `update_memory` and `forget_memory`. Claude Code
    agents get the same list and tools through the bridge. With the mock model, the message `/system` shows the
    prompt.
  - **Review before saving** (per agent) holds what the agent saves, changes or forgets until you **Approve** or
    **Reject** it. A dot on the Overview tab shows that something waits.
  - A memory is one line of up to 500 characters, and an agent keeps up to 100 memories and 8,000 characters in all,
    so all of them fit in its prompt. When the memory is full, the agent merges or forgets memories to make room.
    Memories live in the box, in `memories/<agentId>.json`.
- **Bot templates**: **Share as template…** in an agent's menu (or the palette) packages the agent for someone else:
  its name, role and look, and the instructions, skills, routines (its automations), memories and Connect Apps apps
  you tick. Memories start unticked, and an app goes in by name only: no account, token, conversation or file does.
  - Each save is a new version of the agent's template, unless nothing changed since the last one. **Save file…**
    writes a version as a `.wisp-template.json` file, and **Copy** puts it on the clipboard. Older versions stay
    listed, to save or copy again.
  - **Anyone with the link can add it** publishes a version: the box serves it at `/t/<shareId>` without a token.
    With a remote box that's an `https://<your box>/t/<shareId>` link to send; on this PC the link
    (`wisp://bot-template?id=<shareId>`) opens only here. **Publish** on another version changes what the
    link serves. A template stays until you delete it, also when its agent is deleted.
  - **Connect Apps → Bot templates** (or the palette's **Bot templates**) lists six starters bundled with the box,
    by category and searchable: Chief of Staff, Bug Reproduction, Release Manager, Research Assistant, Prototype
    Builder and Support Triage. **Add** opens a starter in the same preview. The tab also lists your own templates,
    to share again or delete. The starters are data, `src/box/bot-templates.json`; the unit tests check that each one
    is a template, names apps that are in Connect Apps and imports without a skip. A starter with a **Getting
    started** skill offers to run it once the bot is added.
  - **Add bot from a template** (the palette, or **From a template…** in New agent) opens a template file, a link, a
    template pasted as text or a dropped file. So do `wisp://bot-template?url=<https address>` links, and
    `?id=<shareId>` for a template your own box publishes. GitHub file and gist page links fetch the raw file.
  - The preview shows everything the template would add, each item with a box to leave it out: the instructions,
    each skill's whole SKILL.md, each routine's prompt and schedule (described from its cron), the memories, and the
    apps it names with whether they're connected here. Nothing is created until you select **Add bot**.
  - The new agent gets the skills (schedules switched off), the routines as automations switched off and marked
    "from a template", and the memories. What can't be added (a name clash, a routine without a cron schedule, a
    memory that's too long) is listed with the reason. Apps to connect get a **Connect** button.
  - Characters that don't show on screen but a model would read (Unicode tag characters, bidirectional controls,
    zero-width spaces, extra variation selectors) are taken out of a template's text before the preview, and again
    by the box; the preview says how many there were.
  - The format (`src/shared/bot-template.ts`) holds the name, title, avatar shape and color, `body`, `skills`,
    `routines`, `memory`, `plugins`, `shareId`, versions and visibility, plus `"format": "wisp-template/1"`, the
    agent's `description`, an optional small avatar picture, and each
    routine's (and skill's) cron `schedule`. Templates live in the box, `templates/<shareId>/v<N>.json`, listed in
    `templates/index.json`; an agent made from one keeps `sourceTemplate: {shareId, version}`.
- **Connect Apps** (**Ctrl+Shift+M**, the palette, or the sidebar's **Connect Apps** button): a gallery of 25
  well-known apps with official remote MCP servers, searchable and by category, among them GitHub, Linear, Notion,
  Sentry, Atlassian, Stripe and Hugging Face. **Connect** adds the app and starts its browser sign-in when it has one.
  Apps that take a token (GitHub, monday.com, PagerDuty, Render) ask for it first, with a link to where it's made.
  - Each app's page shows its accounts, its tools and instructions for agents. Switch a tool off and agents are never
    offered it; Claude Code agents get it in `--disallowedTools`. The instructions join an agent's prompt (an
    "Apps" section) while that app has tools on for it.
  - **Add another account** connects the same app again under a name, such as Work or Personal. Agents see the name
    beside the tools (`[Linear (Work)] …`, tools named `mcp__linear-work__…`). Accounts can be renamed or removed, and
    a token replaced.
  - The catalog is data, `src/box/mcp-catalog.json`. Each app has its address, how it connects (`oauth`, `token` or
    `none`), the fields it asks for, filled into the address, its query or headers (`{token}`), a category, links and
    a brand color. The unit tests check every entry. The logos are monograms in each brand's color, because the
    vendors' logos are trademarks with terms of their own, so none is bundled.
  - Every address and sign-in method was checked on 2026-10-25 against the vendor's own documentation and with the
    app's own client (sign-in discovery, no registration). Left out: Asana, Box, Canva, Figma, HubSpot, Square and
    Vercel, whose servers take only clients registered with them in advance; Netlify, whose docs don't say how other
    clients sign in; PayPal, whose documented address didn't answer; and Plaid, which needs its own token exchange.
    Any of them can still be added as a custom app, with a token or an OAuth client you register (`"oauth"` in JSON).
- **Plugin marketplaces**: **Connect Apps → Marketplaces** adds a marketplace in Claude Code's format: a GitHub
  repository with `.claude-plugin/marketplace.json` (`owner/repo`, `owner/repo@branch`, its github.com address), or an
  https link to that file. Its plugins then appear among the apps, by marketplace, and their skills in the **Skills**
  tab's search.
  - The box reads public repositories over HTTPS, from GitHub's archive of a commit, so no git is needed, and pins the
    commit it read. A plugin kept in the marketplace's repository is read with it; one in a repository of its own
    (a `github`, `url` or `git-subdir` source on GitHub) is read when you open it, pinned to its `sha` when the entry
    gives one. npm, zip, `command` and non-GitHub git sources are listed but can't be installed.
  - A plugin brings skills (`skills/<name>/SKILL.md`) and MCP servers (`.mcp.json`, or `mcpServers` in
    `.claude-plugin/plugin.json` or its marketplace entry), and asks for its `userConfig` values. Its hooks, commands,
    subagents, LSP servers and the rest are listed as not used here, and never run.
  - **Review and install** shows each server's exact command line and environment (or its address and headers),
    where it runs (this PC, or your box server) and the commit it comes from, with the values it asks for, and each
    skill's full text under **Read it**. Nothing a plugin brings runs before you confirm that.
  - A plugin's server starts with only the basics of the box's environment (the search path, the user's folders,
    temp, locale and Windows' system folders), not its keys and tokens, and `${VAR}` in its config reads only those.
  - A skill's characters that don't show (Unicode tag characters, bidirectional controls, zero-width spaces, as bot
    templates are cleaned) are taken out of what agents read, and the review says how many.
  - Two installed plugins can't share a name, since their skills would share `/<plugin>:…` commands: one from
    another marketplace with an installed plugin's name waits until that one is uninstalled.
  - An installed plugin's skills are in every agent's **Skills** tab, read-only, as `/<plugin>:<skill>`: **Run now**,
    or **Copy to agent** to make one of the agent's own and change it. Its servers are among your apps, with tool
    switches and instructions; they go when the plugin is uninstalled.
  - **Refresh** reads a marketplace again and never moves an installed plugin. A plugin with newer files shows
    **Update**; an update whose servers run or reach something else shows what runs now beside what would run, and
    asks again. Removing a marketplace uninstalls its plugins, as Claude Code does.
  - `WISP_MARKETPLACE_GITHUB_URL` points the box at a GitHub mirror instead of github.com (https, or http on the
    same machine).
- **MCP servers**: add any server as a custom app in Connect Apps, or in Settings → MCP servers: remote servers by URL,
  such as hosted connectors (MCP Streamable HTTP; optional headers), or local stdio servers by JSON
  (`{"command","args","env"}`, `{"url","headers","oauth"}` or an `mcpServers` block).
  - A remote server that answers 401 shows **Sign in**: the MCP authorization flow (protected resource and
    authorization server discovery, dynamic client registration, PKCE on a `127.0.0.1` loopback in your browser).
    Tokens are encrypted with your OS keychain and refreshed before they expire.
  - Settings → MCP servers shows each server's state (connected, needs sign-in, error) and its tools with their
    switches; **Manage** opens it in Connect Apps.
  - Each tool asks before its first use.
- **Desktop mount**: put an agent on your desktop as a floating avatar. Click it to message the agent from anywhere. Press **Alt+Shift+Space** to attach a capture of a screen region.
- **Tray and notifications**: the tray icon shows idle, working or needs-you. Notifications fire when an agent finishes, asks, or needs approval. Closing the window keeps agents running in the tray.
- **Updates**: the installed app checks GitHub Releases, downloads new versions in the background and installs them when it quits, or at once with **Restart to update** (tray, notification, **Settings → About**). See [Installer and updates](#installer-and-updates).

## Architecture

```
renderer (React) ──window.desktop.main──► main (Electron) ──spawns──► box host, coordinator, local-exec
renderer ──window.desktop.gateway (MessagePort)──► coordinator ──POST /api/<method> + SSE /events──► box host
local-exec ──POST /pc/register, SSE /pc/requests, POST /pc/responses──► box host
local-exec ──POST /pc/tasks (background commands started or ended; the whole list with each register)──► box host
box host ──► model APIs (xAI / OpenAI Responses / Anthropic Messages / custom), or spawns `claude -p` per turn
box host ──► speech APIs (xAI /v1/stt, /v1/tts; OpenAI /v1/audio/*): dictation, voice memos, Read aloud
box host ──stdio──► local MCP servers;  ──Streamable HTTP (POST, SSE replies)──► remote MCP servers
claude ──stdio MCP──► dist/claude-bridge/main.cjs ──POST /bridge/tools, /bridge/call──► box host
box host ──e2b SDK──► cloud computer (E2B sandbox) for agents set to "Cloud computer"
local-exec ──local-host edge (browserPlan, browserRun)──► main ──DevTools protocol (webContents.debugger)──► agent browser windows
anyone with a template's link ──GET /t/<shareId>, no token──► box host: the published version of a public template
main ──box-host edge──► box: fresh ChatGPT plan and MCP access tokens (main keeps the refresh tokens)
main ──browser + 127.0.0.1 loopback──► MCP authorization servers (sign-in); ──box-control──► box: sign-in target, reconnect
remote box: no box process here; coordinator, local-exec and main (POST /admin/<method>) use https://<server> instead
```

| Path | Role |
| --- | --- |
| `src/shared/rpc/` | RPC framework: edges, `rpc/<edge>/call/<method>` channels, `{ok,value}` envelopes, IPC and MessagePort transports |
| `src/shared/edges.ts` | Every edge contract (zod-validated arguments) |
| `src/shared/model.ts` | Roster rows, transcript entries, todos, automations and the other shapes the gateway carries |
| `src/shared/gateway-protocol.ts` | The box host's HTTP/SSE surface |
| `src/shared/bot-template.ts` | Bot templates: the file format, its checks and the clean-up of hidden characters, links and file names |
| `src/shared/background-shell.ts` | Background commands as both computers share them: ids, the status the box is told, the log's header and footer, what the agent's tools say |
| `src/shared/marketplace.ts` | Plugin marketplaces: plugin ids (`<plugin>@<marketplace>`), the catalog's plugin view with its servers, options and `approvalKey`, and the plugin views the gateway answers with |
| `src/shared/visualization.ts` | Visualization frames: their CSP, and the document an agent's HTML fragment runs in (theme colors, `window.WispViz`, height reports) |
| `src/shared/pages.ts` | Pages (documents now, canvases later): their shapes on the gateway, titles from the first heading, card excerpts, edit_document's edits, the note a user message carries about pages the user changed |
| `src/shared/mcp-oauth.ts` | MCP authorization shared by main and the box server: `WWW-Authenticate` parsing, protected resource and authorization server discovery, dynamic client registration, code exchange, serialized refreshes with rotation, revocation |
| `src/main/` | Windows, protocols (`wisp-media://`, and `wisp-visualization://` for visualization frames), tray, notifications, deep links (`wisp://agent/<id>`, `wisp://bot-template?id=…` or `?url=…`), bot template files and links (`bot-templates.ts`), settings (schema 2, migrates schema 1), secrets, Sign in with ChatGPT (`chatgpt-auth.ts`), MCP server sign-in (`mcp-auth.ts`), Claude Code detection (`claude-code-cli.ts`), web permissions (`web-permissions.ts`), updates (`updater.ts`, electron-updater), client persistence, process supervision, desktop mount |
| `src/coordinator/` | Gateway client (15 s connect deadline, 35 s stall watchdog with echo probe, 1→10 s backoff) and per-renderer edge serving |
| `src/box/` | Box host (`host.ts`: gateway server, agent store with JSONL transcripts and ordered stamps, harness, cron scheduler, skills (`skills.ts`), memory (`memory.ts`), speech (`voice.ts`), reactions, votes and reply quotes (`message-actions.ts`), the full conversation outline (`outline.ts`), bot templates (`bot-templates.ts`: versions, publishing, `/t/<shareId>`, agents made from a template, the starter gallery in `bot-templates.json`), documents and their revisions (`pages.ts`), agents' background commands (`async-tasks.ts`: the registry in `tasks.json`, `readAsyncTasks`, completions), plugin marketplaces (`marketplace.ts`: sources, GitHub archives (`tarball.ts`), the marketplace and plugin formats; `plugins.ts`: refresh, the catalog's plugins, reviewed installs and updates, plugin skills), built-in tools); MCP client (`mcp.ts`: stdio and Streamable HTTP, sessions, access tokens from main or the box server, switched-off tools, app instructions); the Connect Apps catalog (`mcp-catalog.json`, read and installed by `mcp-catalog.ts`); `main.ts` runs it as an Electron utility process |
| `src/box-server/` | The same box host as a standalone Node server: config from flags, env, a file and `/admin`; its own ChatGPT and MCP sign-ins (handed over from the PC); `Dockerfile` and `deploy/` package it |
| `src/box/models/` | Provider-neutral conversation items and stream events; adapters for Chat Completions, the Responses API, Anthropic Messages and the mock |
| `src/box/claude-code.ts`, `src/claude-bridge/` | The Claude Code engine and the stdio MCP bridge it loads |
| `src/box/cloud-computer.ts`, `src/box/cloud-tools.ts` | The E2B cloud computer and the tools agents use on it |
| `src/local-exec/` | Tool catalog, permission policy, tree-sitter-bash (WASM) and PowerShell command classifiers, background commands (`background.ts`: logs, the saved list, process-tree stops); the agent browser's tools (`browser-tools.ts`) and how the policy rates them (`browser-policy.ts`) |
| `src/main/agent-browser.ts`, `src/main/agent-browser-snapshot.ts`, `src/shared/agent-browser.ts` | The agent browser: windows, tabs, take over and hand back, downloads, the DevTools protocol driver, the trusted-fill seam (`fillByRef`); snapshots and refs; addresses it opens, keys, secret fields and the untrusted-content wrapper. Its toolbar is `src/renderer/agent-browser/` |
| `src/renderer/` | UI (Connect Apps in `components/ConnectApps.tsx`, its plugin pages, review, Skills and Marketplaces tabs in `components/Plugins.tsx`, the full conversation in `components/Outline.tsx`, Async tasks in `components/AsyncTasks.tsx`, Share as template and Add Bot in `components/BotTemplates.tsx`, the page stage in `components/PageStage.tsx` and page cards and the Library in `components/PageCard.tsx`), stores (roster with hidden agents, transcript replicas with resync and optimistic reactions and votes, open outlines kept live from events, pages with unsaved edits kept apart (`store/pages.ts`), find in chat, keyboard navigation, layout slice, voice: recording, transcribing, playback), the shortcut table and handler (`shortcuts.ts`), message actions (`MessageActions.tsx`), math and diagrams loaded on first use (`RichContent.tsx`), visualization cards, desktop-mount pages |

## Safety model

**Permissions**

Each local tool belongs to a permission (`shell`, `files.read`, `files.write`, `processes`, `screen`,
`clipboard.read`, `clipboard.write`, `open`, and `browser` and `browser.act` for the agent browser). Each
permission has one of these modes:

| Mode | Behavior |
| --- | --- |
| `guarded` (default for shell and files) | Runs read-only commands, plus reads and writes inside the agent's own workspace; asks for everything else, including reads elsewhere |
| `trusted` | Never asks, except for dangerous commands |
| `ask_always` | Asks every time unless a remembered decision covers the action |
| `blocked` | Refuses |

**Commands**

Shell commands are parsed (tree-sitter-bash, or a PowerShell splitter) and rated `read-only`, `mutating`, `unknown`
or `dangerous`:
- `rm -rf`, privilege escalation, force-push and similar are **dangerous**. They always ask and can never be remembered.
- Anything that mentions a credential store (`.ssh`, `.aws`, `.gnupg`, browser login data, `.env`, key files) is also **dangerous**, whether it's a command or a file read.
- Pipes into interpreters are **unknown**.

**The agent browser**
- Reading runs without asking (`browser`): opening pages, snapshots, screenshots, scrolling, going back, tabs. So do
  ordinary clicks (links, tabs, menus, plain buttons) and keys that only move around (Tab, arrows, Page Up/Down,
  Escape).
- `browser.act` asks, once per site: typing, a click that submits a form or whose label reads like a purchase, a
  post, a send or a deletion ("Buy now", "Place order", "Pay", "Send", "Post", "Reply", "Delete …"), and keys that can
  submit (Enter, Space, characters). **Always allow** remembers the site (its origin, such as `https://shop.example`:
  `site:<origin>` in Settings → Permissions); **Never** refuses it from then on. The card shows the site, the element
  and the text to be typed.
- Typing into a password, payment card or one-time code field (by its type, `autocomplete` or name) is
  **dangerous**: it always asks, isn't remembered and doesn't show the text. Snapshots never show what's in those
  fields, not even its length.
- The labels are a heuristic for honest sites, which label their buttons; what's typed and what's submitted is what's
  guarded either way. Main looks up the element behind a ref when the call is planned, and refuses the call if the
  page has moved to another site since. An approval doesn't carry over if the ref now names something else.
- What a page says is untrusted. Tool results carry it inside an `<untrusted-page-content>` wrapper the page can't
  close, the tools' descriptions and the agent's instructions say to treat it as data, and page text never decides
  what's allowed.
- Only `http` and `https` pages open (and `about:blank`): no `file://`, `javascript:`, `data:` or `blob:` addresses,
  none of the app's own protocols or the browser's internal pages, no other apps' links, and no addresses with a user
  name or password in them. Redirects and page navigations follow the same rule.
- Every page permission prompt (camera, microphone, location, notifications, screen sharing, USB, serial, HID
  devices, opening other apps) is refused. A page's `alert` is accepted and reported; a `confirm` or `prompt` is
  dismissed and reported, for the user to accept if it should be. The window has no menu, so no developer tools.
- Downloads land in the agent's workspace or are refused (over 1 GB, or not from an agent's tab).
- The agent browser never reads or imports anything from your own Chrome or Edge profile. Its own profile is a
  credential store too: reading `Cookies` or `Login Data` there is as dangerous as anywhere.
- `fillByRef` in `src/main/agent-browser.ts` is where a trusted process (a future vault) types a value into a field by
  ref: main calls it directly, for the site the value belongs to, so the value never passes through the daemon, the
  box, the transcript or the model. Nothing calls it yet.

**Where things run and what leaves the machine**
- The daemon only dials out: to the box host on `127.0.0.1` with a per-launch bearer token, or to your remote box over HTTPS with its token.
- Each agent works in its own folder under `<userData>/box/workspaces/<agentId>`, or `/home/user/agents/<agentId>` on the cloud computer. The daemon picks the folder from the agent id itself, so a remote box can't widen it.
- An approval relayed by the box counts only if you gave it in the app on this PC, to the card the daemon issued for exactly that call; the card shows the daemon's own description. A remote box can ask, but can't approve or reword.
- Everything stays on this computer except requests to the model providers you connect, the MCP servers you add (and
  their sign-in servers) and, for cloud agents, the E2B sandbox. With a remote box, the box's data, the keys you
  connect and MCP sign-ins live on your server instead. The installed app also asks GitHub for this repository's
  latest release, a plain request with no account or app data.
- Updates come only from this repository's GitHub Releases, over HTTPS, and electron-updater checks each download's
  SHA-512 against the release's `latest.yml`. The installer isn't signed, so there's no publisher signature to check:
  whoever can publish releases here can ship code to every installed copy. Keep tokens with release rights private.
  Once the installer is code-signed, electron-builder records the publisher and updates must carry the same signature.
- An agent's visualization runs in a frame sandboxed to scripts only (an opaque origin), under a strict CSP:
  `default-src 'none'`, inline script and style, `data:` and `blob:` images, no connections and no frames. Main
  serves it on `wisp-visualization://` with that CSP and keeps the page's frames on that scheme.
- A document renders through the chat's Markdown, which shows no raw HTML, so a page can't run script. It stays in the
  box and leaves only as a file you save or text you copy.
- A bot template is someone else's text: its instructions, skills and memories become what the new agent reads, and
  its routines would run on their own. So the Add Bot preview shows all of it, with hidden characters taken out (and
  taken out again by the box), nothing is created before you confirm, and routines and skill schedules arrive
  switched off. A template names apps but never connects one. The box's `/t/<shareId>` serves only a version you
  published for anyone with the link; the gateway's other addresses still need its token.
- A background command is approved like any command before it starts. Waiting for one, stopping one and reading its
  log touch only commands that agent started, so they don't ask; the panel's Stop goes to the daemon the same way.
- A plugin's stdio MCP server is a program from someone's repository, and with a remote box it runs on your server.
  So nothing from a marketplace runs before you review it: install and update take the review's `approvalKey`, a hash
  of the commit and of every server's command, arguments, environment, address and headers as written, and the box
  refuses a key that doesn't match what it would run (a refresh that read other files makes the review stale). An
  update whose servers changed asks again. A refresh never updates an installed plugin. Its stdio servers get only
  the basics of the box's environment, so a remote box's provider keys and gateway token stay out of them (Claude
  Code agents, which start servers themselves, get those variables blanked). Its skills reach agents without
  hidden characters, and the review shows their full text. Archives are unpacked with
  links, absolute paths, `..`, names Windows can't store and oversized files left out, within size and file-count
  limits, and a server's `headersHelper` (a command) is refused. A plugin's secret values stay on the box, in
  `plugins.json` like app tokens in `mcp.json`, and never come back in a reply.
- Claude Code runs reach the box through per-run bridge tokens; its permission prompts become the same approval cards
  (Always / Never decisions are remembered per agent, per tool or command name).
- Only the app's own pages (files under `dist/renderer`) get web permissions: the main window may use the
  microphone, never the camera, and app pages may write to the clipboard and show notifications. Everything else is
  refused, and the cloud computer's window and the agent browser get nothing. Recordings go to the box, and from there only to the
  provider that transcribes them.

## License

Wisp is released under the [MIT License](LICENSE).

## Not affiliated

Wisp is an independent open-source project. It isn't affiliated with, endorsed by or sponsored by xAI, OpenAI,
Anthropic, E2B or any other company whose services it connects to. Grok, ChatGPT, Claude, Claude Code and the other
product names here are trademarks of their owners, used only to say which services Wisp works with.
