// The vault step of the end-to-end tests (run.mjs, and remote-box.mjs with `brief`): a login is
// saved in Settings → Vault (and, in the full run, a Chrome password export is imported, read on
// this PC); vault_list shows the agent its label only; on the wrong site the fill is refused before
// anyone is asked; on the right one the credential card asks on this PC, and after Allow once the
// page has the values while the agent's snapshot and screenshot keep them hidden; each fill asks
// again, a fill with submit signs in, and the page's echo of the email is blanked. Then the values
// are looked for in the chat, in every file the box keeps and in the audit log, and found nowhere.
// The full run also checks: a key pressed in a password field inside a web component's shadow root,
// or in a same-origin sign-in frame that has just moved to its password step, is rated as typing into
// a password field; a fill into that frame's field is refused; copying and cutting (Shift+Delete
// too) aren't pressed after a fill, read_clipboard blanks a value a page put on the clipboard, and
// pasting it is refused; and screenshots paint over a value the page shows outside the filled fields
// (a show-password toggle's new field, the next page's echo), checked in the image's own pixels.
// Only pages this test serves on this computer are opened.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { toolOutput } from "./agent-browser-step.mjs";

const SIGN_IN = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Vault test sign-in</title></head>
<body>
  <h1>Sign in to the test shop</h1>
  <form action="/login" method="post">
    <label>Email <input name="email" type="email" autocomplete="username"></label>
    <label>Password <input name="password" type="password" autocomplete="current-password" aria-label="Password"></label>
    <button type="button" id="show">Show password</button>
    <button>Sign in</button>
  </form>
  <label>Search <input name="q"></label>
  <pin-box></pin-box>
  <iframe title="Sign-in frame" src="/frame" style="width:420px;height:70px"></iframe>
  <script>
    customElements.define("pin-box", class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: "open" }).innerHTML = '<label>PIN <input type="password" autocomplete="off" aria-label="PIN"></label>';
      }
    });
    // A show-password toggle that swaps in a new field holding the value, as many sites do.
    document.getElementById("show").addEventListener("click", (event) => {
      const old = document.querySelector("[name=password]");
      const next = document.createElement("input");
      const showing = old.type === "password";
      next.name = "password";
      next.type = showing ? "text" : "password";
      next.value = old.value;
      next.setAttribute("aria-label", showing ? "Password (shown)" : "Password");
      if (!showing) next.setAttribute("autocomplete", "current-password");
      old.replaceWith(next);
      event.target.textContent = showing ? "Hide password" : "Show password";
    });
  </script>
</body></html>`;

/** A sign-in frame from the page's own origin: its first step moves on to a password step. */
const FRAME = `<!doctype html><title>Frame</title><button type="button" id="next" onclick="location.href = '/frame-password'">Next</button>`;
const FRAME_PASSWORD = `<!doctype html><title>Frame password</title>
<label>Frame password <input id="pw" type="password" autocomplete="current-password" aria-label="Frame password"></label>
<script>document.getElementById("pw").focus();</script>`;

const escapeHtml = (text) => text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);

/** A sign-in page on this computer; `logins` collects what its form posts. */
export async function startLoginSite() {
  const logins = [];
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/login") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const form = new URLSearchParams(body);
        logins.push({ email: form.get("email"), password: form.get("password") });
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><title>Signed in</title><h1>Signed in as ${escapeHtml(form.get("email") ?? "")}</h1>`);
      });
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(request.url === "/frame" ? FRAME : request.url === "/frame-password" ? FRAME_PASSWORD : SIGN_IN);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => new Promise((resolve) => (server.close(resolve), server.closeAllConnections()));
  return { url: `http://127.0.0.1:${server.address().port}/`, host: `127.0.0.1:${server.address().port}`, logins, close };
}

/** Files under `dir` (recursively) whose bytes contain any of `values`. */
function filesWith(dir, values) {
  const hits = [];
  const walk = (folder) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      let bytes;
      try {
        const stat = statSync(path);
        if (stat.isDirectory()) {
          walk(path);
          continue;
        }
        if (stat.size > 50 * 1024 * 1024) continue;
        bytes = readFileSync(path);
      } catch {
        // A file the running app holds locked (Chromium's lock files).
        continue;
      }
      for (const value of values) if (bytes.includes(Buffer.from(value, "utf8"))) hits.push(`${path} has ${value}`);
    }
  };
  walk(dir);
  return hits;
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `send` posts a message to the agent, `conversation()` is its transcript region, `userData` the
 * app's data folder (vault.json, vault-audit.jsonl), `boxDir` every file the box keeps (a remote
 * box's own folder). `brief` skips the import, the wrong site and the screenshots.
 */
export async function driveVault({ app, page, send, conversation, site, userData, boxDir, screenshot, brief = false }) {
  const username = "ada@example.com";
  const password = `pw-${randomBytes(6).toString("hex")}-Lovelace`;
  const exported = `csv-${randomBytes(6).toString("hex")}`;
  const lastOutput = (mustContain) => toolOutput(page, conversation(), mustContain);
  /**
   * Sends a message and waits for something new in the chat that says `text`: a tool output (`pre`)
   * or other text. The conversation already has outputs from earlier steps ("Clicked e4"), so only a
   * new one counts.
   */
  const sendFor = async (message, text, kind = "output") => {
    const matches = () => (kind === "output" ? conversation().locator("pre").filter({ hasText: text }) : conversation().getByText(text, { exact: false }));
    const before = await matches().count();
    await send(message);
    for (let tries = 0; (await matches().count()) <= before; tries++) {
      if (tries > 150) throw new Error(`nothing new saying “${text}” after ${message}`);
      await page.waitForTimeout(200);
    }
    return kind === "output" ? lastOutput(text) : "";
  };
  // `pattern` is an element's role and name, with ` \[password\]` when it must be a password field;
  // other states may come between (a focused field reads `textbox "Password" [focused] [password]`).
  const refOf = (text, pattern) => {
    const password = pattern.endsWith(" \\[password\\]");
    const element = new RegExp(`${password ? pattern.slice(0, -" \\[password\\]".length) : pattern}((?: \\[[^\\]]+\\])*) \\[ref=(e\\d+)\\]`, "g");
    for (const match of text.matchAll(element)) if (!password || match[1].includes("[password]")) return match[2];
    throw new Error(`no ref for ${pattern} in:\n${text}`);
  };
  const label = `Login for ${site.host} (a…@example.com)`;

  // Settings → Vault: a login added by hand.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Vault", exact: true }).click();
  await page.getByRole("heading", { name: "Vault", level: 2 }).waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "New login" }).click();
  await page.getByRole("textbox", { name: "Site", exact: true }).fill(site.url);
  await page.getByRole("textbox", { name: "Username", exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("list", { name: "Vault items" }).getByText(label, { exact: true }).waitFor({ timeout: 10_000 });
  if (!brief) {
    // A password export the user made in Chrome: the file they pick is read here, in main.
    const csv = join(userData, "Chrome Passwords.csv");
    writeFileSync(csv, `name,url,username,password,note\r\nmail.example,https://mail.example/login,someone@example.com,${exported},\r\napp,android://x@com.example/,me,pw,\r\n`);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, csv);
    await page.getByRole("button", { name: "Import passwords…" }).click();
    await page.getByText("Imported a Chrome or Edge export: 1 added, 0 updated, 0 unchanged, 1 skipped.", { exact: false }).waitFor({ timeout: 10_000 });
    await page.getByRole("list", { name: "Vault items" }).getByText("Login for mail.example (s…@example.com)", { exact: true }).waitFor({ timeout: 10_000 });
    await screenshot("12a-vault-settings.png");
  }
  await page.getByRole("button", { name: "Back", exact: true }).click();

  // The agent sees ids and labels, never a value.
  await send("/tool vault_list {}");
  const listed = await lastOutput("in the vault (values are never shown)");
  const id = new RegExp(`- (v[0-9a-f]{12}): ${escapeRegex(label)}`).exec(listed)?.[1];
  if (id == null) throw new Error(`vault_list didn't list the login:\n${listed}`);
  if (listed.includes(username) || listed.includes(password)) throw new Error(`vault_list showed a value:\n${listed}`);

  if (!brief) {
    // On another site (this computer under another name) the fill is refused, before anyone is asked.
    const other = site.url.replace("127.0.0.1", "localhost");
    await send(`/tool browser_navigate ${JSON.stringify({ url: other })}`);
    const elsewhere = await lastOutput(`Opened ${other}`);
    await send(`/tool request_credential ${JSON.stringify({ item_id: id, fields: { password: refOf(elsewhere, 'textbox "Password" \\[password\\]') } })}`);
    await conversation().getByText(`is for ${site.host}, and the page is on localhost:`, { exact: false }).last().waitFor({ timeout: 20_000 });
  }

  // On its own site: the credential card asks on this PC, Allow once / Deny only.
  await send(`/tool browser_navigate ${JSON.stringify({ url: site.url })}`);
  const opened = await lastOutput(`Opened ${site.url}`);
  const fields = { username: refOf(opened, 'textbox "Email"'), password: refOf(opened, 'textbox "Password" \\[password\\]') };
  // A key pressed where the focus is in a password field is rated as typing into one: asked, then denied here.
  const keyRatedAsPassword = async (what) => {
    await sendFor(`/tool browser_press ${JSON.stringify({ key: "x" })}`, `types into a password field on ${site.host}`, "text").catch((error) => {
      throw new Error(`a key in ${what} wasn't rated as typing into a password field (${error.message})`);
    });
    const denied = conversation().getByText("Denied", { exact: true });
    const before = await denied.count();
    await page.getByRole("button", { name: "Deny", exact: true }).last().click();
    for (let tries = 0; (await denied.count()) <= before && tries < 100; tries++) await page.waitForTimeout(200);
    await page.waitForTimeout(1500);
  };
  if (!brief) {
    // A same-origin sign-in frame moves to its password step (its isolated world goes with it), and
    // a field inside a web component's open shadow root has the focus.
    const next = refOf(opened, 'button "Next"');
    await sendFor(`/tool browser_click ${JSON.stringify({ ref: next })}`, `Clicked ${next}`);
    await page.waitForTimeout(800);
    await keyRatedAsPassword("the frame's password step");
    const framed = await sendFor("/tool browser_snapshot {}", 'textbox "Frame password"');
    // The frame is the page's own origin, but its field isn't the page's: the vault doesn't fill it.
    await sendFor(`/tool request_credential ${JSON.stringify({ item_id: id, fields: { password: refOf(framed, 'textbox "Frame password" \\[password\\]') } })}`, "is inside a frame, and the vault fills only the page's own fields", "text");
    const pin = refOf(opened, 'textbox "PIN" \\[password\\]');
    await sendFor(`/tool browser_click ${JSON.stringify({ ref: pin })}`, `Clicked ${pin}`);
    await keyRatedAsPassword("a shadow root's password field");
  }
  const allow = async () => {
    const card = conversation().getByRole("group", { name: "Fill from your vault" }).last();
    const button = card.getByRole("button", { name: "Allow once" });
    await button.waitFor({ timeout: 20_000 });
    const text = (await card.textContent()) ?? "";
    if (!text.includes(label) || !text.includes(`on ${site.host}`) || /Always|Never/.test(text)) throw new Error(`the card doesn't ask for this item on this site, once:\n${text}`);
    return { card, button };
  };
  await send(`/tool request_credential ${JSON.stringify({ item_id: id, fields })}`);
  const first = await allow();
  if (!brief) await screenshot("12b-vault-credential-card.png");
  await first.button.click();
  await lastOutput(`Filled 2 fields on ${site.host} (username, password)`);

  // The page has the values; the agent's snapshot and screenshot don't.
  const inPage = await app.evaluate(
    ({ webContents }, url) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)?.executeJavaScript('[document.querySelector("[name=email]").value, document.querySelector("[name=password]").value]'),
    site.url,
  );
  if (JSON.stringify(inPage) !== JSON.stringify([username, password])) throw new Error(`the page didn't get the login: ${JSON.stringify(inPage?.map((value) => value.length))}`);
  await send("/tool browser_snapshot {}");
  const masked = await lastOutput("[filled from your vault]");
  if (!/textbox "Email"( \[\w+\])* \[filled from your vault\]/.test(masked) || !/textbox "Password"[^\n]* \[password\] \[filled from your vault\]/.test(masked) || masked.includes(username)) {
    throw new Error(`the snapshot shows a filled field:\n${masked}`);
  }
  // The agent's page, its screenshots (as the box saved them) and the color of their pixels.
  const inAgentPage = (url, script) => app.evaluate(({ webContents }, { url, script }) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)?.executeJavaScript(script), { url, script });
  const newestShot = () => {
    const dir = join(boxDir, "attachments", "tool-images");
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jpg"))
      .map((name) => join(dir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  };
  const pixels = (path, points) =>
    app.evaluate(
      ({ nativeImage }, { path, points }) => {
        const image = nativeImage.createFromPath(path);
        const { width } = image.getSize();
        const bitmap = image.toBitmap();
        return points.map(([x, y]) => [...bitmap.subarray((Math.round(y) * width + Math.round(x)) * 4, (Math.round(y) * width + Math.round(x)) * 4 + 3)]);
      },
      { path, points },
    );
  const grey = (rgb) => rgb.every((channel) => Math.abs(channel - 0x80) <= 24);
  /** Takes a screenshot and checks it's painted grey at the middle of each box (CSS pixels) and not at `clear`. */
  const screenshotCovers = async (url, boxesScript, what) => {
    const { boxes, ratio } = await inAgentPage(url, `({ boxes: ${boxesScript}, ratio: devicePixelRatio })`);
    await sendFor("/tool browser_screenshot {}", "What shows values from the vault (the filled fields, and anything else holding one) is painted over.");
    const points = boxes.map((box) => [(box.x + box.width / 2) * ratio, (box.y + box.height / 2) * ratio]);
    const colors = await pixels(newestShot(), [...points, [4 * ratio, 4 * ratio]]);
    if (!colors.slice(0, -1).every(grey)) throw new Error(`the screenshot shows ${what}: ${JSON.stringify(colors)}`);
    if (grey(colors[colors.length - 1])) throw new Error("the screenshot is painted where nothing holds a value");
  };
  const rect = (selector) => `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`;

  if (!brief) {
    await screenshotCovers(site.url, `[${rect("[name=email]")}, ${rect("[name=password]")}]`, "a filled field");

    // Copying and cutting aren't pressed after a fill, whatever has the focus (Shift+Delete is Windows' cut).
    for (const [key, label, verb] of [
      ["Shift+Delete", "Shift+Delete", "cut"],
      ["Control+c", "Control+C", "copy"],
    ]) {
      await sendFor(`/tool browser_press ${JSON.stringify({ key })}`, `${label} would ${verb} from the page, and this window holds values filled from the vault`, "text");
    }
    // A value a page put on the clipboard itself (a site's own Copy button): read_clipboard blanks it, and it isn't pasted.
    const before = await app.evaluate(({ clipboard }) => clipboard.readText());
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), password);
    try {
      const allowRead = page.getByRole("button", { name: "Allow once" });
      const cards = await allowRead.count();
      await send("/tool read_clipboard {}");
      for (let tries = 0; (await allowRead.count()) <= cards; tries++) {
        if (tries > 100) throw new Error("read_clipboard didn't ask");
        await page.waitForTimeout(200);
      }
      const hidden = conversation().locator("pre").filter({ hasText: "[hidden: a value from your vault]" });
      const shownBefore = await hidden.count();
      await allowRead.last().click();
      for (let tries = 0; (await hidden.count()) <= shownBefore; tries++) {
        if (tries > 100) throw new Error("read_clipboard didn't blank the vault value");
        await page.waitForTimeout(200);
      }
      await sendFor(`/tool browser_press ${JSON.stringify({ key: "Control+v" })}`, "The clipboard holds a value from the vault, so Control+V isn't pressed.", "text");
    } finally {
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), before);
    }

    // A show-password toggle swaps in a new field holding the password: not a filled field, but it
    // doesn't show in the snapshot and is painted over in the screenshot.
    const show = refOf(opened, 'button "Show password"');
    await sendFor(`/tool browser_click ${JSON.stringify({ ref: show })}`, `Clicked ${show}`);
    const shown = await sendFor("/tool browser_snapshot {}", 'textbox "Password (shown)"');
    if (shown.includes(password)) throw new Error(`the shown password is in the snapshot:\n${shown}`);
    await screenshotCovers(site.url, `[${rect("[name=password]")}]`, "the shown password");
    // Hidden again: a new password field, which the next fill fills.
    const hide = refOf(shown, 'button "Hide password"');
    await sendFor(`/tool browser_click ${JSON.stringify({ ref: hide })}`, `Clicked ${hide}`);
    fields.password = refOf(await sendFor("/tool browser_snapshot {}", 'button "Show password"'), 'textbox "Password" \\[password\\]');
  }

  // Each fill asks again; with submit it signs in, and the page's echo of the email is blanked.
  await send(`/tool request_credential ${JSON.stringify({ item_id: id, fields, submit: true })}`);
  await (await allow()).button.click();
  await lastOutput("and pressed Enter; the page changed");
  if (JSON.stringify(site.logins) !== JSON.stringify([{ email: username, password }])) throw new Error(`the site got ${site.logins.length} sign-ins, not this login`);
  await send("/tool browser_snapshot {}");
  const signedIn = await lastOutput("Signed in as");
  if (!signedIn.includes("Signed in as [hidden: a value from your vault]")) throw new Error(`the page's echo of the email wasn't blanked:\n${signedIn}`);
  // No field on this page was filled: the echo is found by its value and painted over.
  if (!brief) {
    const echo = `(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector("h1").firstChild); const r = range.getBoundingClientRect(); return [{ x: r.left, y: r.top, width: r.width, height: r.height }]; })()`;
    await screenshotCovers(`${site.url}login`, echo, "the page's echo of the email");
  }

  // Nowhere in the transcript: not in the chat, not in any file the box keeps.
  await page.waitForTimeout(1500);
  const values = [username, password, encodeURIComponent(username), exported];
  const chat = (await conversation().textContent()) ?? "";
  const seen = values.filter((value) => chat.includes(value));
  if (seen.length > 0) throw new Error(`the chat shows ${seen.length} vault value(s)`);
  const onBox = filesWith(boxDir, values);
  if (onBox.length > 0) throw new Error(`the box keeps vault values:\n${onBox.join("\n")}`);
  // The vault and its audit log on this PC: sealed, and value-free.
  const local = filesWith(userData, [password, exported]).filter((hit) => !hit.includes("Chrome Passwords.csv"));
  if (local.length > 0) throw new Error(`a value is in the clear on this PC:\n${local.join("\n")}`);
  const audit = readFileSync(join(userData, "vault-audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const fills = audit.filter((entry) => entry.event === "fill" && entry.itemId === id);
  if (fills.length !== 2 || fills.some((entry) => entry.site !== site.url.replace(/\/$/, "") || entry.fields.join() !== "username,password")) throw new Error(`the audit log has ${JSON.stringify(fills)}`);
  if (!brief && !audit.some((entry) => entry.event === "fill-refused" && entry.itemId === id)) throw new Error("the refused fill isn't in the audit log");
}
