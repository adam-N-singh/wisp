// End-to-end check of a remote box: starts the standalone box server
// (dist/box-server/main.cjs) on loopback, launches the built app with an
// isolated user-data folder, and switches Settings → Box to the server. The
// coordinator and the local-exec daemon must then use it: a prompt
// round-trips through the server, a tool the server calls runs on this PC
// (after an approval given here, for a risky one), an attached image is
// uploaded to the server and shown back here, a background command runs on
// this PC and is stopped from the Async tasks panel through the server, the
// agent browser opens a local test page on this PC for a remote agent, the vault
// fills a login there after an approval here, with no value on the server, and a
// canvas the agent writes on the server runs on this PC's page stage.
// Usage: node test/e2e/remote-box.mjs   (after `node scripts/build.mjs`)
import { _electron as electron } from "playwright";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestSite, toolOutput } from "./agent-browser-step.mjs";
import { driveVault, startLoginSite } from "./vault-step.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const userData = mkdtempSync(join(tmpdir(), "wisp-e2e-remote-"));
const boxData = mkdtempSync(join(tmpdir(), "wisp-box-e2e-"));
const shots = join(root, "test", "e2e", "screenshots");
mkdirSync(shots, { recursive: true });
const token = randomBytes(32).toString("hex");

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

// ---- the box server, as it would run on an always-on machine (here on loopback, so plain HTTP is allowed)
const pass = (names) => Object.fromEntries(names.filter((name) => process.env[name] != null).map((name) => [name, process.env[name]]));
const box = spawn(process.execPath, [join(root, "dist", "box-server", "main.cjs"), "--port", "0"], {
  env: { ...pass(["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]), WISP_BOX_DATA_DIR: boxData, WISP_BOX_TOKEN: token },
  stdio: ["ignore", "ignore", "pipe"],
});
const boxLog = [];
const boxUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`the box server didn't start:\n${boxLog.join("")}`)), 20_000);
  box.stderr.on("data", (chunk) => {
    boxLog.push(String(chunk));
    const match = /serving (http:\/\/127\.0\.0\.1:\d+)/.exec(boxLog.join(""));
    if (match != null) {
      clearTimeout(timer);
      resolve(match[1]);
    }
  });
  box.once("exit", (code) => reject(new Error(`the box server exited (${code}):\n${boxLog.join("")}`)));
});
const boxHealth = async () => (await fetch(`${boxUrl}/health`, { headers: { authorization: `Bearer ${token}` } })).json();
// Asked over the gateway: the box writes agents.json a moment after a change.
const boxAgents = async () => (await fetch(`${boxUrl}/api/rosterAgents`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" })).json();

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
  page.on("pageerror", (error) => logs.push(`[renderer pageerror] ${error.message}`));
  await page.setViewportSize({ width: 1180, height: 780 }).catch(() => undefined);
  const composer = () => page.getByRole("textbox", { name: /Message / });
  const conversation = (name) => page.getByLabel(`Conversation with ${name}`);
  const send = async (text) => {
    await composer().fill(text);
    await composer().press("Enter");
  };
  const openBoxSettings = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Box", exact: true }).click();
    await page.getByRole("heading", { name: "Box", level: 2 }).waitFor({ timeout: 10_000 });
  };

  await step("onboarding with the mock model; the first agent lives on this PC", async () => {
    await page.getByRole("dialog", { name: "Welcome to Wisp" }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Get started" }).click();
    await page.getByRole("radio", { name: /Offline mock/ }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Create agent" }).click();
    await page.getByRole("heading", { name: "Wisp", level: 1 }).waitFor({ timeout: 20_000 });
  });

  await step("Settings → Box: a wrong token is refused and nothing changes", async () => {
    await openBoxSettings();
    await page.getByRole("radio", { name: "Remote server" }).click();
    await page.getByLabel("Box server address").fill(boxUrl);
    await page.getByLabel("Box server token").fill("not-the-token-".repeat(4));
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByText("The box refused the token.").waitFor({ timeout: 15_000 });
    const settings = JSON.parse(readFileSync(join(userData, "settings.json"), "utf8"));
    if (settings.box?.location === "remote") throw new Error("a refused token switched the box");
  });

  await step("Settings → Box: connecting moves the coordinator and local-exec to the server", async () => {
    await page.getByLabel("Box server token").fill(token);
    const reloaded = page.waitForEvent("load", { timeout: 30_000 });
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    // The window reloads against the new box and opens this section again.
    await reloaded;
    await page.getByText(/Connected · box /).waitFor({ timeout: 30_000 });
    await page.getByRole("radio", { name: "Remote server", checked: true }).waitFor({ timeout: 10_000 });
    for (const deadline = Date.now() + 30_000; (await boxHealth()).localExec !== "ready"; ) {
      if (Date.now() > deadline) throw new Error("local-exec never dialed in to the box server");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await page.locator(".settings-row", { hasText: "Tools on this PC" }).getByText("Connected", { exact: true }).waitFor({ timeout: 15_000 });
    await page.screenshot({ path: join(shots, "11-box-remote.png") });
    const settings = JSON.parse(readFileSync(join(userData, "settings.json"), "utf8"));
    if (settings.box.location !== "remote" || settings.box.remoteUrl !== boxUrl) throw new Error(`box settings not saved: ${JSON.stringify(settings.box)}`);
    if (readFileSync(join(userData, "settings.json"), "utf8").includes(token)) throw new Error("the box token was written to settings.json");
    const appConfig = JSON.parse(readFileSync(join(boxData, "app-config.json"), "utf8"));
    if (appConfig.models.defaultModel.provider !== "mock") throw new Error("the app's model settings didn't reach the box");
    await page.locator('.connection-dot--connected[title="Connected to your box"]').waitFor({ timeout: 15_000 });
  });

  await step("a prompt round-trips through the remote box", async () => {
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByText("No agents yet. Create one to get started.").waitFor({ timeout: 15_000 });
    await page.getByLabel("New agent").click();
    await page.getByPlaceholder("Research assistant").fill("Remote Wisp");
    await page.getByRole("button", { name: "Create agent" }).click();
    await page.getByRole("heading", { name: "Remote Wisp", level: 1 }).waitFor({ timeout: 20_000 });
    await send("hello remote box");
    await conversation("Remote Wisp").getByText('Mock model here. You said: "hello remote box"', { exact: false }).waitFor({ timeout: 20_000 });
    if (!(await boxAgents()).some((agent) => agent.name === "Remote Wisp")) throw new Error("the agent isn't on the box server");
    const local = JSON.parse(readFileSync(join(userData, "box", "agents.json"), "utf8")).agents;
    if (local.some((agent) => agent.name === "Remote Wisp")) throw new Error("the agent was created on this PC");
  });

  await step("a tool the box calls runs on this PC, in the agent's folder here", async () => {
    await send('/tool write_file {"path":"from-remote.txt","content":"written by a remote agent"}');
    await conversation("Remote Wisp").getByText("Tool finished. Output:", { exact: false }).first().waitFor({ timeout: 30_000 });
    const agentId = (await boxAgents()).find((agent) => agent.name === "Remote Wisp").id;
    const written = join(userData, "box", "workspaces", agentId, "from-remote.txt");
    if (!existsSync(written) || readFileSync(written, "utf8") !== "written by a remote agent") throw new Error(`the file wasn't written on this PC at ${written}`);
    const machine = JSON.parse(readFileSync(join(boxData, "local-machine.json"), "utf8")).machine;
    if (machine.hostname !== hostname() || machine.workspaceRoot !== join(userData, "box", "workspaces")) throw new Error(`the box has the wrong PC: ${JSON.stringify(machine)}`);
  });

  await step("a risky PC command waits for approval given on this PC, then runs", async () => {
    const command = process.platform === "win32" ? "New-Item -ItemType Directory -Force -Path approved-remotely | Out-Null; 'made it remotely'" : "mkdir -p approved-remotely && echo made it remotely";
    await send(`/tool run_shell ${JSON.stringify({ command })}`);
    const allow = page.getByRole("button", { name: "Allow once" });
    await allow.waitFor({ timeout: 20_000 });
    await page.locator(".permission-card__machine", { hasText: hostname() }).waitFor({ timeout: 5_000 });
    await allow.click();
    await page.getByText("Allowed once").waitFor({ timeout: 10_000 });
    const agentId = (await boxAgents()).find((agent) => agent.name === "Remote Wisp").id;
    const made = join(userData, "box", "workspaces", agentId, "approved-remotely");
    for (const deadline = Date.now() + 30_000; !existsSync(made); ) {
      if (Date.now() > deadline) throw new Error("the approved command didn't run on this PC");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // The prompt itself contains the text, so look for it in the tool's output.
    await conversation("Remote Wisp").getByText("Tool finished. Output:", { exact: false }).nth(1).waitFor({ timeout: 30_000 });
  });

  await step("an attached image is uploaded to the box and shown from there", async () => {
    const image = join(userData, "dot.png");
    writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    await page.locator('input[type="file"]').setInputFiles(image);
    await send("here is a picture");
    const shown = conversation("Remote Wisp").getByRole("img", { name: "dot.png" });
    await shown.waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => [...document.querySelectorAll("img.attachment-image")].some((img) => img.complete && img.naturalWidth > 0), null, { timeout: 15_000 });
    const uploads = readdirSync(join(boxData, "attachments"), { recursive: true }).map(String);
    if (!uploads.some((name) => name.endsWith("dot.png"))) throw new Error(`no upload on the box: ${uploads.join(", ")}`);
    await page.screenshot({ path: join(shots, "12-remote-chat.png") });
  });

  await step("a background command runs on this PC for the remote agent, shows in Async tasks, and is stopped from there through the box", async () => {
    const powershell = process.platform === "win32";
    await send(`/tool run_shell ${JSON.stringify({ command: powershell ? "Write-Output 'bg remote ready'; Start-Sleep -Seconds 120" : "echo bg remote ready; sleep 120", background: true })}`);
    // The card is this PC's, as for any command.
    const allow = page.getByRole("button", { name: "Allow once" });
    await allow.waitFor({ timeout: 20_000 });
    await page.locator(".permission-card__machine", { hasText: hostname() }).last().waitFor({ timeout: 5_000 });
    await allow.click();
    const pill = page.getByRole("button", { name: "1 running" });
    await pill.waitFor({ timeout: 20_000 });
    await page.getByRole("tab", { name: "Overview" }).click();
    await page.getByRole("button", { name: "Async tasks", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Async tasks: Remote Wisp" });
    // Its output is read from this PC through the box (shell-control "output").
    await panel.locator(".async-task__output", { hasText: "bg remote ready" }).waitFor({ timeout: 20_000 });
    await page.screenshot({ path: join(shots, "13-remote-async-tasks.png") });
    // Stop goes to the box, which sends shell-control "stop" to this PC's daemon.
    await panel.getByRole("button", { name: /^Stop Background command \d+$/ }).click();
    await panel.getByText("Remote Wisp has nothing running in the background.").waitFor({ timeout: 20_000 });
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    await pill.waitFor({ state: "hidden", timeout: 10_000 });
  });

  await step("the agent browser opens a local test page on this PC for the remote agent", async () => {
    const site = await startTestSite();
    try {
      await send(`/tool browser_navigate ${JSON.stringify({ url: site.url })}`);
      const opened = await toolOutput(page, conversation("Remote Wisp"), `Opened ${site.url}`);
      if (!opened.includes(`<untrusted-page-content url="${site.url}" title="Agent browser test page">`) || !/textbox "Your name" \[ref=e\d+\]/.test(opened)) {
        throw new Error(`the page didn't come back to the remote agent:\n${opened}`);
      }
      // The window is this PC's, with the page in it.
      const here = await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().some((contents) => contents.getURL() === url), site.url);
      if (!here) throw new Error("the agent browser didn't open the page on this PC");
    } finally {
      await site.close();
    }
  });

  await step("the vault fills a login on this PC for the remote agent; the box only relays ids and keeps no value", async () => {
    const site = await startLoginSite();
    try {
      await driveVault({ app, page, send, site, userData, boxDir: boxData, conversation: () => conversation("Remote Wisp"), screenshot: async () => undefined, brief: true });
    } finally {
      await site.close();
    }
  });

  await step("a canvas the remote agent writes is kept on the box and runs on this PC's stage, read through the box's GET /pages", async () => {
    const contents = '<!doctype html><title>Remote counter</title><p id="out">none yet</p><button onclick="document.getElementById(\'out\').textContent = \'clicked here\'">Click</button>';
    await send(`/tool write_canvas ${JSON.stringify({ contents })}`);
    const card = page.getByRole("button", { name: "Open Remote counter" });
    await card.waitFor({ timeout: 20_000 });
    await card.click();
    const frame = page.frameLocator('iframe[title="Remote counter"]');
    await frame.getByRole("button", { name: "Click" }).click({ timeout: 15_000 });
    await frame.getByText("clicked here").waitFor({ timeout: 5_000 });
    const agentId = (await boxAgents()).find((agent) => agent.name === "Remote Wisp").id;
    if (!existsSync(join(boxData, "pages", agentId, "index.json"))) throw new Error("the canvas isn't on the box server");
    if (existsSync(join(userData, "box", "pages", agentId))) throw new Error("the canvas was kept on this PC");
    await page.getByRole("region", { name: "Page: Remote counter" }).getByRole("button", { name: "Close the page" }).click();
  });

  await step("switching back to This PC brings back this PC's agents", async () => {
    await openBoxSettings();
    const reloaded = page.waitForEvent("load", { timeout: 30_000 });
    await page.getByRole("radio", { name: "This PC" }).click();
    await reloaded;
    await page.getByRole("heading", { name: "Box", level: 2 }).waitFor({ timeout: 15_000 });
    await page.getByRole("radio", { name: "This PC", checked: true }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("heading", { name: "Wisp", level: 1 }).waitFor({ timeout: 20_000 });
    const settings = JSON.parse(readFileSync(join(userData, "settings.json"), "utf8"));
    if (settings.box.location !== "local" || settings.box.remoteUrl !== boxUrl) throw new Error(`box settings after switching back: ${JSON.stringify(settings.box)}`);
  });
} catch {
  if (page != null) await page.screenshot({ path: join(shots, "failure-remote.png") }).catch(() => undefined);
} finally {
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await app.close().catch(() => undefined);
  box.kill();
}

const failed = results.filter((result) => !result.ok);
const errors = logs.join("").split("\n").filter((line) => /error|exception|failed/i.test(line) && !/DevTools|Autofill|GPU|gpu|Electron Security Warning/.test(line));
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (failed.length > 0 && errors.length > 0) console.log(`\nprocess log lines mentioning errors:\n${errors.slice(0, 40).join("\n")}`);
if (failed.length > 0) console.log(`\nbox server log:\n${boxLog.join("").slice(-4000)}`);
rmSync(userData, { recursive: true, force: true });
rmSync(boxData, { recursive: true, force: true });
process.exit(failed.length === 0 && results.length > 0 ? 0 : 1);
