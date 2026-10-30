// End-to-end smoke test: launches the built app with an isolated user-data
// folder and the offline mock model, then drives the main flows through the UI.
// Usage: node test/e2e/run.mjs   (after `node scripts/build.mjs`)
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { driveAgentBrowser, startTestSite } from "./agent-browser-step.mjs";
import { driveVault, startLoginSite } from "./vault-step.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const userData = mkdtempSync(join(tmpdir(), "wisp-e2e-"));
const shots = join(root, "test", "e2e", "screenshots");
mkdirSync(shots, { recursive: true });

const results = [];
const step = async (name, fn) => {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
};

const app = await electron.launch({
  executablePath: join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron"),
  args: [root, `--user-data-dir=${userData}`],
  env: { ...process.env, WISP_USER_DATA_DIR: userData, NODE_ENV: "production" },
  timeout: 60_000,
});
const logs = [];
app.process().stdout?.on("data", (chunk) => logs.push(String(chunk)));
app.process().stderr?.on("data", (chunk) => logs.push(String(chunk)));

let page;
try {
  page = await app.firstWindow();
  page.on("console", (message) => {
    if (message.type() === "error") logs.push(`[renderer console] ${message.text()}`);
  });
  page.on("pageerror", (error) => logs.push(`[renderer pageerror] ${error.message}`));
  await page.setViewportSize({ width: 1180, height: 780 }).catch(() => undefined);

  await step("main window loads and shows onboarding", async () => {
    await page.getByRole("dialog", { name: "Welcome to Wisp" }).waitFor({ timeout: 30_000 });
    await page.screenshot({ path: join(shots, "01-onboarding.png") });
  });

  await step("onboarding: offline mock model + first agent", async () => {
    await page.getByRole("button", { name: "Get started" }).click();
    await page.getByRole("radio", { name: /Offline mock/ }).click();
    await page.screenshot({ path: join(shots, "01b-onboarding-providers.png") });
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Create agent" }).click();
    await page.getByRole("heading", { name: "Wisp", level: 1 }).waitFor({ timeout: 20_000 });
    await page.screenshot({ path: join(shots, "02-first-agent.png") });
  });

  const composer = () => page.getByRole("textbox", { name: /Message Wisp/ });
  const send = async (text) => {
    await composer().fill(text);
    await composer().press("Enter");
  };

  await step("sidebar shows the box connection as live", async () => {
    await page.locator('.connection-dot--connected[title="Connected to your box"]').waitFor({ timeout: 15_000 });
  });

  await step("chat: prompt round-trip through coordinator -> box -> model", async () => {
    await send("hello there");
    // Scoped to the conversation: the sidebar row previews the same reply once the turn ends.
    await page.getByLabel("Conversation with Wisp").getByText("Mock model here. You said: \"hello there\"", { exact: false }).waitFor({ timeout: 20_000 });
    await page.screenshot({ path: join(shots, "03-chat.png") });
  });

  await step("tool: list_directory of the agent workspace runs without approval", async () => {
    await send("/tool list_directory {}");
    await page.getByText("Tool finished. Output:", { exact: false }).first().waitFor({ timeout: 20_000 });
  });

  await step("tool: write_file inside the agent workspace runs without approval", async () => {
    await send('/tool write_file {"path":"notes/hello.txt","content":"written by the e2e test"}');
    await page.getByText("Created ", { exact: false }).first().waitFor({ timeout: 20_000 }).catch(async () => {
      await page.getByText("Tool finished. Output:", { exact: false }).nth(1).waitFor({ timeout: 5_000 });
    });
  });

  await step("tool: a mutating shell command asks for approval; Allow once runs it", async () => {
    const command = process.platform === "win32" ? "New-Item -ItemType Directory -Force -Path approved-dir | Out-Null; 'made it'" : "mkdir -p approved-dir && echo made it";
    await send(`/tool run_shell ${JSON.stringify({ command })}`);
    const allow = page.getByRole("button", { name: "Allow once" });
    await allow.waitFor({ timeout: 20_000 });
    await page.screenshot({ path: join(shots, "04-approval.png") });
    await allow.click();
    await page.getByText("Allowed once").waitFor({ timeout: 10_000 });
    await page.getByText("made it", { exact: false }).first().waitFor({ timeout: 30_000 });
  });

  await step("tool: Deny stops a mutating command", async () => {
    const command = process.platform === "win32" ? "Remove-Item -Path approved-dir" : "rmdir approved-dir";
    await send(`/tool run_shell ${JSON.stringify({ command })}`);
    const deny = page.getByRole("button", { name: "Deny", exact: true });
    await deny.waitFor({ timeout: 20_000 });
    await deny.click();
    await page.getByText("Denied", { exact: true }).waitFor({ timeout: 10_000 });
  });

  await step("tool: screenshot needs approval and its image is served via wisp-media", async () => {
    await send("/tool take_screenshot {}");
    const allow = page.getByRole("button", { name: "Allow once" });
    await allow.waitFor({ timeout: 20_000 });
    await allow.click();
    await page.getByText("Screenshot ", { exact: false }).first().waitFor({ timeout: 30_000 });
    await page.getByRole("tab", { name: "Computer" }).click();
    const image = page.getByRole("img", { name: "Latest screen the agent captured" });
    await image.waitFor({ timeout: 10_000 });
    const loaded = await image.evaluate((element) => element.complete && element.naturalWidth > 0);
    if (!loaded) throw new Error("wisp-media image did not load");
    await page.screenshot({ path: join(shots, "05a-computer-tab.png") });
  });

  await step("outline: Show full conversation lists thinking, cards and tool calls, live; a call opens to its output", async () => {
    // A reply still being written when the panel opens goes on growing in it.
    const words = Array.from({ length: 120 }, (_, index) => `word${index + 1}`).join(" ");
    await send(`/echo Outline check: ${words}`);
    await page.getByRole("button", { name: "Show full conversation" }).click();
    const panel = page.getByRole("dialog", { name: "Full conversation with Wisp" });
    await panel.getByText("word120", { exact: false }).waitFor({ timeout: 20_000 });
    await panel.getByRole("tab", { name: "Main", selected: true }).waitFor();
    await panel.getByRole("button", { name: "Show more" }).last().waitFor();
    await panel.getByText("Thought for", { exact: false }).first().waitFor();
    await panel.getByText("Allowed once").first().waitFor();
    await panel.getByText("Denied", { exact: true }).waitFor();
    // The denied command failed, so its row is open at the reason.
    await panel.locator(".outline-item--tool-call .outline-tool--failed").first().waitFor();
    await panel.locator(".outline-item--tool-call .tool-call__error").first().waitFor();
    const listing = panel.locator(".outline-item--tool-call", { hasText: "list_directory" }).first();
    await listing.getByRole("button").click();
    await listing.locator(".tool-call__output").waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(shots, "05b-outline.png") });
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    // The sidebar row's menu opens it too.
    await page.getByRole("button", { name: "Wisp actions" }).click();
    await page.getByRole("menuitem", { name: "Show full conversation" }).click();
    await panel.getByText("word120", { exact: false }).waitFor({ timeout: 10_000 });
    await panel.getByRole("button", { name: "Close" }).click();
    await panel.waitFor({ state: "hidden" });
  });

  await step("pages: a document opens on the stage beside the chat, and from Ctrl+K; the user's edit is a new revision the next message tells the agent about", async () => {
    const markdown = "# Trip plan\n\nTwo days in Portugal.\n\n- Day 1: Lisbon\n- Day 2: Sintra\n\n| Day | Train |\n|---|---|\n| 1 | 09:10 |";
    await send(`/tool create_document ${JSON.stringify({ title: "Trip plan", markdown })}`);
    const card = page.getByRole("button", { name: "Open Trip plan" });
    await card.waitFor({ timeout: 20_000 });
    await card.click();
    const stage = page.getByRole("region", { name: "Page: Trip plan" });
    // The chat's own Markdown, with the chat beside it and the details pane out of the way.
    await stage.getByRole("heading", { name: "Trip plan", level: 1 }).waitFor({ timeout: 10_000 });
    await stage.getByRole("cell", { name: "09:10" }).waitFor();
    await page.getByLabel("Conversation with Wisp").waitFor();
    await page.getByLabel("Agent details").waitFor({ state: "hidden" });
    await page.screenshot({ path: join(shots, "05c-page-stage.png") });
    await stage.getByRole("button", { name: "Edit" }).click();
    const source = stage.getByRole("textbox", { name: "Markdown" });
    await source.fill(markdown.replace("Sintra", "Cascais"));
    await stage.getByText("Unsaved changes", { exact: false }).waitFor();
    await source.press("Control+s");
    await stage.getByText("Revision 2 · Edited by you", { exact: false }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(shots, "05d-page-editor.png") });
    // Esc leaves the editor, then closes the page.
    await page.keyboard.press("Escape");
    await stage.getByText("Day 2: Cascais").waitFor();
    await page.keyboard.press("Escape");
    await stage.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Open Trip plan" }).getByText("revision 2, edited by you", { exact: false }).waitFor();
    // Ctrl+K finds it by its title and opens it on the stage again; the agent's browser is an action there too.
    const palette = page.getByRole("dialog", { name: "Jump to" });
    await page.keyboard.press("Control+k");
    await palette.getByRole("combobox", { name: "Jump to" }).fill("trip");
    await palette.getByRole("group", { name: "Pages" }).getByRole("option", { name: /^Trip plan/ }).click();
    await stage.getByRole("heading", { name: "Trip plan", level: 1 }).waitFor({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await stage.waitFor({ state: "hidden" });
    await page.keyboard.press("Control+k");
    await palette.getByRole("combobox", { name: "Jump to" }).fill("browser");
    await palette.getByRole("option", { name: "Wisp: Show agent browser" }).waitFor({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await palette.waitFor({ state: "hidden" });
    await send("What did I change?");
    await page.getByText("Page you changed:").waitFor({ timeout: 20_000 });
    await page.getByLabel("Conversation with Wisp").getByText('You said: "What did I change?"', { exact: false }).waitFor({ timeout: 20_000 });
  });

  await step("canvases: an agent's canvas runs on the stage, its button changes the page, a link opens only from a click, and a second write_canvas is revision 2", async () => {
    // Links the canvas opens are caught here instead of reaching the browser.
    const caught = await app.evaluate(({ shell }) => {
      globalThis.__canvasLinks = [];
      try {
        shell.openExternal = async (url) => void globalThis.__canvasLinks.push(url);
      } catch {
        // read-only: the link checks below are skipped
      }
      return String(shell.openExternal).includes("__canvasLinks");
    });
    const waitUntil = async (check, what) => {
      const started = Date.now();
      while (!(await check())) {
        if (Date.now() - started > 10_000) throw new Error(`timed out: ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const counter = (label) =>
      `<!doctype html><html><head><title>Counter</title><style>body { padding: 24px; } button { font-size: 18px; }</style></head><body>` +
      `<h1>Clicks</h1><p id="out">0 clicks so far</p><button id="more">${label}</button> <button id="later">Open later</button> <a href="https://example.com/docs">Docs</a>` +
      `<script>let n = 0; document.getElementById("more").onclick = () => { n++; document.getElementById("out").textContent = n + " clicks so far"; };` +
      `document.getElementById("later").onclick = () => setTimeout(() => window.open("https://example.com/later"), 1600);</script></body></html>`;
    await send(`/tool write_canvas ${JSON.stringify({ contents: counter("Add one") })}`);
    const card = page.getByRole("button", { name: "Open Counter" });
    await card.waitFor({ timeout: 20_000 });
    await card.getByText("Canvas ·", { exact: false }).waitFor();
    await card.click();
    const stage = page.getByRole("region", { name: "Page: Counter" });
    await stage.getByText("Canvas · Revision 1 · Made by Wisp", { exact: false }).waitFor({ timeout: 10_000 });
    const frame = page.frameLocator('iframe[title="Counter"]');
    await frame.getByRole("button", { name: "Add one" }).click({ timeout: 10_000 });
    await frame.getByRole("button", { name: "Add one" }).click();
    await frame.getByText("2 clicks so far").waitFor({ timeout: 5_000 });
    assert.equal(await page.locator('iframe[title="Counter"]').getAttribute("sandbox"), "allow-scripts allow-pointer-lock");
    await page.screenshot({ path: join(shots, "05e-canvas-stage.png") });
    if (caught) {
      // A click on a link opens it; a window.open long after the click doesn't.
      await frame.getByRole("link", { name: "Docs" }).click();
      await waitUntil(async () => (await app.evaluate(() => globalThis.__canvasLinks)).includes("https://example.com/docs"), "the clicked link opened");
      await frame.getByRole("button", { name: "Open later" }).click();
      await stage.getByText("The canvas asked to open a link", { exact: false }).waitFor({ timeout: 10_000 });
      assert.deepEqual(await app.evaluate(() => globalThis.__canvasLinks), ["https://example.com/docs"]);
    } else console.log("       (shell.openExternal is read-only here: the link checks were skipped)");

    // The agent writes it again: revision 2 shows on the stage at once.
    const conversation = await page.getByLabel("Conversation with Wisp").innerText();
    const canvasId = /"canvas_id":\s*"(canvas-[0-9a-f]+)"/.exec(conversation)?.[1];
    if (canvasId == null) throw new Error("write_canvas's result names no canvas_id");
    await send(`/tool write_canvas ${JSON.stringify({ canvas_id: canvasId, contents: counter("Add two") })}`);
    await stage.getByText("Canvas · Revision 2 · Made by Wisp", { exact: false }).waitFor({ timeout: 20_000 });
    await frame.getByRole("button", { name: "Add two" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Open Counter" }).getByText("revision 2", { exact: false }).waitFor();
    // History: back to revision 1 and restore it, as the user's revision 3.
    await stage.getByRole("button", { name: "History" }).click();
    await page.getByRole("menuitem", { name: /^Revision 1/ }).click();
    await stage.getByText("You’re looking at revision 1", { exact: false }).waitFor();
    await frame.getByRole("button", { name: "Add one" }).waitFor({ timeout: 10_000 });
    await stage.getByRole("button", { name: "Restore this revision" }).click();
    await stage.getByText("Canvas · Revision 3 · Restored by you", { exact: false }).waitFor({ timeout: 10_000 });
    await frame.getByRole("button", { name: "Add one" }).waitFor({ timeout: 10_000 });
    await stage.getByRole("button", { name: "Close the page" }).click();
    await stage.waitFor({ state: "hidden" });
    // Ctrl+K finds canvases too.
    const palette = page.getByRole("dialog", { name: "Jump to" });
    await page.keyboard.press("Control+k");
    await palette.getByRole("combobox", { name: "Jump to" }).fill("counter");
    await palette.getByRole("group", { name: "Pages" }).getByRole("option", { name: /^Counter/ }).click();
    await stage.getByText("Canvas · Revision 3", { exact: false }).waitFor({ timeout: 10_000 });
    await stage.getByRole("button", { name: "Close the page" }).click();
    await stage.waitFor({ state: "hidden" });
  });

  await step("canvases: no app bridge or WebRTC in a canvas or its srcdoc child, a javascript: child stays blocked, and the window keeps its sandbox", async () => {
    // The main window: still sandboxed and isolated; the preload runs in every frame, only to lock the others down.
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes("/renderer/index.html"));
      const web = window?.webContents.getLastWebPreferences();
      return { sandbox: web?.sandbox, contextIsolation: web?.contextIsolation, nodeIntegration: web?.nodeIntegration, nodeIntegrationInSubFrames: web?.nodeIntegrationInSubFrames, webrtc: window?.webContents.getWebRTCIPHandlingPolicy() };
    });
    assert.deepEqual(prefs, { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, webrtc: "disable_non_proxied_udp" });
    const contents = String.raw`<!doctype html><title>Isolation</title>
<p id="top">waiting</p><p id="child">waiting</p><p id="js">waiting</p>
<script>
function seen(where) { return where + ": desktop " + typeof window.desktop + ", RTCPeerConnection " + typeof window.RTCPeerConnection + ", webkitRTCPeerConnection " + typeof window.webkitRTCPeerConnection; }
document.getElementById("top").textContent = seen("top");
addEventListener("message", function (event) { if (event.data && event.data.k) document.getElementById(event.data.k).textContent = event.data.v; });
var child = document.createElement("iframe");
child.srcdoc = "<script>parent.postMessage({ k: 'child', v: 'child: desktop ' + typeof window.desktop + ', RTCPeerConnection ' + typeof window.RTCPeerConnection + ', webkitRTCPeerConnection ' + typeof window.webkitRTCPeerConnection }, '*')<\/script>";
document.body.appendChild(child);
var js = document.createElement("iframe");
js.src = "javascript:'<script>parent.postMessage({ k: \"js\", v: \"javascript child ran, RTCPeerConnection \" + typeof window.RTCPeerConnection }, \"*\")<\/script>'";
document.body.appendChild(js);
setTimeout(function () { if (document.getElementById("js").textContent === "waiting") document.getElementById("js").textContent = "javascript child blocked"; }, 2000);
</script>`;
    await send(`/tool write_canvas ${JSON.stringify({ contents })}`);
    const card = page.getByRole("button", { name: "Open Isolation" });
    await card.waitFor({ timeout: 20_000 });
    await card.click();
    const stage = page.getByRole("region", { name: "Page: Isolation" });
    const frame = page.frameLocator('iframe[title="Isolation"]');
    await frame.getByText("top: desktop undefined, RTCPeerConnection undefined, webkitRTCPeerConnection undefined").waitFor({ timeout: 10_000 });
    await frame.getByText("child: desktop undefined, RTCPeerConnection undefined, webkitRTCPeerConnection undefined").waitFor({ timeout: 10_000 });
    await frame.getByText("javascript child blocked").waitFor({ timeout: 10_000 });
    // The app's own page still has its bridge.
    assert.equal(await page.evaluate(() => typeof window.desktop), "object");
    await stage.getByRole("button", { name: "Close the page" }).click();
    await stage.waitFor({ state: "hidden" });
  });

  await step("background command: approved, shown in Async tasks with its output and stopped there; one that ends wakes the agent", async () => {
    const powershell = process.platform === "win32";
    const conversation = page.getByLabel("Conversation with Wisp");
    await send(`/tool run_shell ${JSON.stringify({ command: powershell ? "Write-Output 'bg ready'; Start-Sleep -Seconds 120" : "echo bg ready; sleep 120", background: true })}`);
    // It goes through the daemon's approval policy like any command.
    await page.getByRole("button", { name: "Allow once" }).click({ timeout: 20_000 });
    const pill = page.getByRole("button", { name: "1 running" });
    await pill.waitFor({ timeout: 20_000 });
    await page.getByRole("tab", { name: "Overview" }).click();
    await page.getByRole("button", { name: "Async tasks", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Async tasks: Wisp" });
    // The end of its output, read while the panel is open.
    await panel.locator(".async-task__output", { hasText: "bg ready" }).waitFor({ timeout: 20_000 });
    await panel.getByText(/^Background command \d+ · /).waitFor();
    await page.screenshot({ path: join(shots, "05c-async-tasks.png") });
    await panel.getByRole("button", { name: /^Stop Background command \d+$/ }).click();
    await panel.getByText("Wisp has nothing running in the background.").waitFor({ timeout: 20_000 });
    // It moves to the Ended section, which says who stopped it and keeps its log and last output.
    const ended = panel.getByRole("region", { name: "Ended" });
    await ended.getByText("Stopped by you").waitFor({ timeout: 10_000 });
    await ended.getByRole("button", { name: "Open log" }).waitFor();
    await ended.getByRole("button", { name: "Last output" }).click();
    await ended.getByLabel(/^Last output of Background command \d+$/).getByText("bg ready", { exact: false }).waitFor();
    await page.screenshot({ path: join(shots, "05d-async-tasks-ended.png") });
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    await pill.waitFor({ state: "hidden", timeout: 10_000 });

    // One that ends by itself: the agent is told in a message the chat doesn't show, and replies.
    await send(`/tool run_shell ${JSON.stringify({ command: powershell ? "Write-Output 'bg done'; Start-Sleep -Seconds 2" : "echo bg done; sleep 2", background: true })}`);
    await page.getByRole("button", { name: "Allow once" }).click({ timeout: 20_000 });
    await conversation.getByText(/You said: "\[Background command \d+ finished: exit code 0/).waitFor({ timeout: 30_000 });
    if ((await conversation.getByText(/^\[Background command \d+/).count()) > 0) throw new Error("the box's message to the agent is shown in the chat");
    // The sidebar row's menu opens the panel too.
    await page.getByRole("button", { name: "Wisp actions" }).click();
    await page.getByRole("menuitem", { name: /^Async tasks/ }).click();
    await panel.getByText("Wisp has nothing running in the background.").waitFor({ timeout: 10_000 });
    // Newest first: the one that finished, then the one stopped.
    await ended.locator(".async-task").first().getByText("Finished · exit code 0").waitFor({ timeout: 10_000 });
    if ((await ended.locator(".async-task").count()) !== 2) throw new Error("the Ended section should list both commands");
    await panel.getByRole("button", { name: "Close" }).click();
    await panel.waitFor({ state: "hidden" });
  });

  await step("agent browser: a local test page is read, typed into (asked once for the site), clicked, downloaded from; prompts, overlays and files are refused; calls wait while the user has it; a purchase asks; the user is handed the browser", async () => {
    const site = await startTestSite();
    try {
      await driveAgentBrowser({ app, page, send, site, conversation: () => page.getByLabel("Conversation with Wisp"), screenshot: async (name, options) => (options?.png != null ? writeFileSync(join(shots, name), options.png) : await page.screenshot({ path: join(shots, name) })) });
      await page.getByRole("tab", { name: "Computer" }).click();
      await page.getByRole("region", { name: "Agent browser" }).getByRole("button", { name: "Show agent browser" }).waitFor({ timeout: 10_000 });
      await page.getByRole("tab", { name: "Overview" }).click();
    } finally {
      await site.close();
    }
  });

  await step("vault: a login saved in Settings (and a Chrome export imported) is refused on another site, and fills on its own after Allow once on this PC; the page gets it, the agent and the transcript never see it", async () => {
    const site = await startLoginSite();
    try {
      await driveVault({ app, page, send, site, userData, boxDir: join(userData, "box"), conversation: () => page.getByLabel("Conversation with Wisp"), screenshot: (name) => page.screenshot({ path: join(shots, name) }) });
    } finally {
      await site.close();
    }
  });

  await step("info pane shows overview and automations tabs", async () => {
    await page.getByRole("tab", { name: "Automations" }).click();
    await page.getByRole("button", { name: "New automation" }).click();
    await page.getByPlaceholder("Morning briefing").fill("Daily check-in");
    await page.getByPlaceholder("Summarize my unread email and today’s calendar.").fill("Say good morning.");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByText("Weekdays at 09:00").waitFor({ timeout: 10_000 });
    await page.getByRole("tab", { name: "Overview" }).click();
    await page.screenshot({ path: join(shots, "05-info-pane.png") });
  });

  await step("settings view renders all sections", async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    for (const section of ["Models", "Cloud computer", "Permissions", "Vault", "MCP servers", "About", "General"]) {
      await page.getByRole("button", { name: section, exact: true }).click();
    }
    await page.getByRole("heading", { name: "General" }).waitFor();
    await page.getByRole("button", { name: "Dark" }).click();
    await page.screenshot({ path: join(shots, "06-settings-dark.png") });
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.screenshot({ path: join(shots, "07-chat-dark.png") });
  });

  await step("MCP: add a stdio server in Settings, then call its tool through an approval", async () => {
    const serverScript = join(userData, "echo-mcp.cjs");
    writeFileSync(
      serverScript,
      `const rl = require("node:readline").createInterface({ input: process.stdin });
       const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
       rl.on("line", (line) => {
         const msg = JSON.parse(line);
         if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } } });
         else if (msg.method === "tools/list") send({ id: msg.id, result: { tools: [{ name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
         else if (msg.method === "tools/call") send({ id: msg.id, result: { content: [{ type: "text", text: "echo: " + msg.params.arguments.text }] } });
         else if (msg.id != null) send({ id: msg.id, error: { code: -32601, message: "nope" } });
       });`,
    );
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "MCP servers", exact: true }).click();
    await page.getByRole("radio", { name: "JSON config" }).click();
    await page.getByPlaceholder("everything").fill("echo-test");
    await page.locator(".settings-section textarea").fill(JSON.stringify({ command: process.execPath, args: [serverScript] }));
    await page.getByRole("button", { name: "Add server" }).click();
    await page.getByText("1 tools").waitFor({ timeout: 20_000 });
    await page.screenshot({ path: join(shots, "08-mcp.png") });
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await send('/tool mcp__echo-test__echo {"text":"hi from mcp"}');
    const allow = page.getByRole("button", { name: "Allow once" });
    await allow.waitFor({ timeout: 20_000 });
    await allow.click();
    await page.getByText("echo: hi from mcp").first().waitFor({ timeout: 20_000 });
  });

  await step("desktop mount: the floating panel sends a prompt to the agent", async () => {
    await page.getByRole("button", { name: "Mount on desktop" }).click();
    let panel = null;
    for (const deadline = Date.now() + 20_000; panel == null && Date.now() < deadline; ) {
      panel = app.windows().find((window) => window.url().endsWith("panel.html")) ?? null;
      if (panel == null) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (panel == null) throw new Error(`panel window never appeared; windows: ${app.windows().map((window) => window.url()).join(", ")}`);
    await panel.waitForLoadState("domcontentloaded");
    await panel.locator(".mark").waitFor({ timeout: 15_000 });
    await panel.locator(".mark").click();
    const box = panel.getByPlaceholder("Message Wisp");
    await box.waitFor({ timeout: 10_000 });
    await box.fill("sent from the desktop panel");
    await box.press("Enter");
    await page.getByText("sent from the desktop panel", { exact: true }).waitFor({ timeout: 20_000 });
    await page.getByText("From desktop").first().waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Unmount from desktop" }).click();
  });

  await step("models: provider cards render; a custom endpoint serves the default model", async () => {
    // A fake OpenAI-compatible server: /models and a streamed /chat/completions.
    const server = createServer((request, response) => {
      if (request.url?.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify({ data: [{ id: "fake-model" }] }));
      }
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const messages = JSON.parse(body).messages;
        const last = String(messages[messages.length - 1].content).split("\n").pop();
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `fake says: ${last}` } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Models", exact: true }).click();
      for (const card of ["xAI", "OpenAI", "Anthropic", "Claude Code", "Custom endpoint"]) await page.getByRole("region", { name: card, exact: true }).waitFor({ timeout: 10_000 });
      await page.getByRole("radio", { name: "ChatGPT plan" }).click();
      await page.getByRole("button", { name: "Continue with ChatGPT" }).waitFor({ timeout: 10_000 });
      await page.screenshot({ path: join(shots, "09-models.png") });
      await page.getByRole("radio", { name: "API key" }).click();
      await page.getByLabel("Custom base URL").fill(`http://127.0.0.1:${server.address().port}/v1`);
      await page.getByRole("region", { name: "Custom endpoint" }).getByRole("button", { name: "Save", exact: true }).click();
      await page.locator('option[value="custom:fake-model"]').waitFor({ state: "attached", timeout: 15_000 });
      await page.getByLabel("Default model").selectOption("custom:fake-model");
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.getByText("fake-model · Custom endpoint").first().waitFor({ timeout: 10_000 });
      await send("hello custom");
      await page.getByLabel("Conversation with Wisp").getByText("fake says: hello custom").waitFor({ timeout: 20_000 });
      // Back to the mock for the remaining steps.
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Models", exact: true }).click();
      await page.getByRole("button", { name: "Use as default" }).click();
      await page.getByRole("button", { name: "Back", exact: true }).click();
    } finally {
      server.close();
    }
  });

  await step("agent settings: model picker and This PC / Cloud computer choice", async () => {
    await page.getByRole("button", { name: "Edit agent" }).first().click();
    await page.getByRole("dialog", { name: /Edit Wisp/ }).waitFor({ timeout: 10_000 });
    await page.getByRole("radio", { name: "Cloud computer" }).click();
    await page.getByText("The cloud computer isn’t set up yet.").waitFor({ timeout: 5_000 });
    await page.screenshot({ path: join(shots, "10-agent-dialog.png") });
    await page.getByRole("button", { name: "Cancel" }).click();
  });

  await step("persistence: settings, client slices, box store and transcript log", async () => {
    await page.waitForTimeout(1500);
    const settings = JSON.parse(readFileSync(join(userData, "settings.json"), "utf8"));
    if (settings.models.defaultModel.provider !== "mock") throw new Error("default model not persisted");
    if (settings.models.customBaseUrl.length === 0) throw new Error("custom endpoint not persisted");
    if (settings.theme !== "dark") throw new Error("theme not persisted");
    const blobs = readdirSync(join(userData, "ui-state"));
    if (!blobs.some((name) => name.endsWith(".blob"))) throw new Error("no client persistence blobs");
    const agents = JSON.parse(readFileSync(join(userData, "box", "agents.json"), "utf8")).agents;
    if (agents.length !== 1 || agents[0].name !== "Wisp") throw new Error("box roster not persisted");
    const log = readFileSync(join(userData, "box", "transcripts", `${agents[0].id}.jsonl`), "utf8").trim().split("\n");
    if (log.length < 8) throw new Error(`transcript log too short (${log.length})`);
    const workspaceFile = join(userData, "box", "workspaces", agents[0].id, "notes", "hello.txt");
    if (!existsSync(workspaceFile)) throw new Error("write_file did not create the workspace file");
    if (!existsSync(join(userData, "window-state.json"))) throw new Error("window-state.json missing");
  });

  await step("group chat: two mock bots both reply, then only the one @mentioned (picked from the @ menu); a member's page opens beside the group", async () => {
    await page.getByLabel("New agent").click();
    await page.getByPlaceholder("Research assistant").fill("Scout");
    await page.getByRole("button", { name: "Create agent" }).click();
    await page.getByRole("heading", { name: "Scout", level: 1 }).waitFor({ timeout: 20_000 });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+N" : "Control+Shift+N");
    const dialog = page.getByRole("dialog", { name: "New group chat" });
    await dialog.getByRole("checkbox", { name: /^Wisp/ }).check();
    await dialog.getByRole("checkbox", { name: /^Scout/ }).check();
    await dialog.getByRole("button", { name: "Create group chat" }).click();
    await page.getByRole("heading", { name: "Wisp, Scout", level: 1 }).waitFor({ timeout: 20_000 });
    const room = page.getByLabel("Conversation with Wisp, Scout");
    const message = () => page.getByRole("textbox", { name: "Message group" });
    await room.getByText("Wisp and Scout joined").waitFor({ timeout: 10_000 });
    if ((await page.locator(".agent-row .avatar-stack").count()) !== 1) throw new Error("the group chat's row has no stacked avatar");

    // No mention: every bot gets a turn, each post under its own name.
    await message().fill("hello both");
    await message().press("Enter");
    await room.getByText('Wisp here. You said: "hello both".').waitFor({ timeout: 20_000 });
    await room.getByText('Scout here. You said: "hello both".').waitFor({ timeout: 20_000 });
    if ((await room.locator(".message__author", { hasText: /^Scout$/ }).count()) !== 1) throw new Error("Scout's post doesn't carry its name");
    await page.locator('[aria-label="Bots are replying"]').waitFor({ state: "detached", timeout: 20_000 });

    // "@Sc" offers Scout (and not Wisp); Enter puts the mention in.
    await message().fill("@Sc");
    const menu = page.getByRole("listbox", { name: "Mention" });
    await menu.getByRole("option", { name: /Scout/ }).waitFor({ timeout: 5_000 });
    if ((await menu.getByRole("option", { name: /Wisp/ }).count()) !== 0) throw new Error("the @ menu offered Wisp for “@Sc”");
    await message().press("Enter");
    if ((await message().inputValue()) !== "@Scout ") throw new Error(`the @ menu wrote “${await message().inputValue()}”`);
    await page.keyboard.type("only you");
    await message().press("Enter");
    await room.getByText('Scout here. You said: "only you".').waitFor({ timeout: 20_000 });
    await page.locator('[aria-label="Bots are replying"]').waitFor({ state: "detached", timeout: 20_000 });
    if ((await room.getByText('Wisp here. You said: "only you"').count()) !== 0) throw new Error("Wisp replied though only Scout was mentioned");

    // The details pane lists the members; each bot answered in its own room session, and its own chat is untouched.
    if (!(await page.getByRole("complementary", { name: "Group chat details" }).isVisible())) await page.getByRole("button", { name: "Toggle details" }).click();
    const members = page.getByRole("region", { name: "Members" });
    await members.getByText("Wisp", { exact: true }).waitFor({ timeout: 5_000 });
    await members.getByText("Scout", { exact: true }).waitFor({ timeout: 5_000 });
    await page.screenshot({ path: join(shots, "11-group-chat.png") });
    const rows = JSON.parse(readFileSync(join(userData, "box", "agents.json"), "utf8")).agents;
    const group = rows.find((row) => row.isGroup);
    const scout = rows.find((row) => row.name === "Scout");
    if (group == null || scout == null) throw new Error("the group chat isn't in the box roster");
    if (!existsSync(join(userData, "box", "sessions", scout.id, `group~${group.id}.jsonl`))) throw new Error("Scout's room session isn't on disk");
    if (existsSync(join(userData, "box", "transcripts", `${scout.id}.jsonl`))) throw new Error("Scout's own chat got the room's messages");

    // A document Scout writes in the group shows its card there, which opens Scout's page beside the group's chat.
    await message().fill('@Scout /tool create_document {"title":"Room plan","markdown":"# Room plan\\n\\nWritten in the group."}');
    await message().press("Enter");
    const pageCard = room.getByRole("button", { name: "Open Room plan" });
    await pageCard.waitFor({ timeout: 20_000 });
    await page.locator('[aria-label="Bots are replying"]').waitFor({ state: "detached", timeout: 20_000 });
    await pageCard.click();
    await page.getByText(/Written by Scout/).waitFor({ timeout: 10_000 });
    await page.getByRole("heading", { name: "Wisp, Scout", level: 1 }).waitFor({ timeout: 5_000 });
    await page.screenshot({ path: join(shots, "11b-group-chat-page.png") });
    await page.keyboard.press("Escape");
    await page.getByText(/Written by Scout/).waitFor({ state: "detached", timeout: 10_000 });
  });
} catch {
  if (page != null) await page.screenshot({ path: join(shots, "failure.png") }).catch(() => undefined);
} finally {
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await app.close().catch(() => undefined);
}

const failed = results.filter((result) => !result.ok);
const errors = logs.join("").split("\n").filter((line) => /error|exception|failed/i.test(line) && !/DevTools|Autofill|GPU|gpu|Electron Security Warning/.test(line));
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (errors.length > 0) console.log(`\nprocess log lines mentioning errors:\n${errors.slice(0, 40).join("\n")}`);
rmSync(userData, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
