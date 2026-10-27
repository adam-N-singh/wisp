// End-to-end smoke test: launches the built app with an isolated user-data
// folder and the offline mock model, then drives the main flows through the UI.
// Usage: node test/e2e/run.mjs   (after `node scripts/build.mjs`)
import { _electron as electron } from "playwright";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { driveAgentBrowser, startTestSite } from "./agent-browser-step.mjs";

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

  await step("pages: a document opens on the stage beside the chat; the user's edit is a new revision the next message tells the agent about", async () => {
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
    await send("What did I change?");
    await page.getByText("Page you changed:").waitFor({ timeout: 20_000 });
    await page.getByLabel("Conversation with Wisp").getByText('You said: "What did I change?"', { exact: false }).waitFor({ timeout: 20_000 });
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
    await panel.getByRole("button", { name: "Close" }).click();
    await panel.waitFor({ state: "hidden" });
  });

  await step("agent browser: a local test page is read, typed into (asked once for the site), clicked, downloaded from; prompts, overlays and files are refused; calls wait while the user has it; a purchase asks; the user is handed the browser", async () => {
    const site = await startTestSite();
    try {
      await driveAgentBrowser({ app, page, send, site, conversation: () => page.getByLabel("Conversation with Wisp"), screenshot: (name) => page.screenshot({ path: join(shots, name) }) });
      await page.getByRole("tab", { name: "Computer" }).click();
      await page.getByRole("region", { name: "Agent browser" }).getByRole("button", { name: "Show agent browser" }).waitFor({ timeout: 10_000 });
      await page.getByRole("tab", { name: "Overview" }).click();
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
    for (const section of ["Models", "Cloud computer", "Permissions", "MCP servers", "About", "General"]) {
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
