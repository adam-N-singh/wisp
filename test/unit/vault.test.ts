import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type AXNode, RefTable, renderSnapshot } from "../../src/main/agent-browser-snapshot";
import { coverRegions, HIDDEN_VALUE, holdsValue, quadRegion, scaleRegion, scrubClipboard, scrubValues, valueRegions } from "../../src/main/agent-browser-mask";
import { forgetFrameWorld, inWorld } from "../../src/main/agent-browser-worlds";
import { clipboardChord, parseKeyChord } from "../../src/shared/agent-browser";
import { type Sealer, Vault, VaultAudit, type VaultBrowser, type VaultField, type VaultFill, VaultFiller, verifyAuditChain } from "../../src/main/vault";
import { parseCsv, parsePasswordExport } from "../../src/main/vault-csv";
import { evaluate, grantRecipient } from "../../src/local-exec/policy";
import { LOCAL_TOOLS, type ToolContext } from "../../src/local-exec/tools";
import { containsPaymentCard, contactFillValue, maskHint, normalizeSite, vaultItemLabel, vaultSiteMatches } from "../../src/shared/vault";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "vault-test-"));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** safeStorage's stand-in: XOR with a key behind a header, so nothing on disk reads as the value. */
function fakeSealer(available = true, backend?: string): Sealer {
  const key = 0x5a;
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: backend != null ? () => backend : undefined,
    encryptString: (text) => Buffer.concat([Buffer.from("SEAL"), Buffer.from(Buffer.from(text, "utf8").map((byte) => byte ^ key))]),
    decryptString: (data) => {
      if (data.subarray(0, 4).toString() !== "SEAL") throw new Error("not sealed by this key");
      return Buffer.from(data.subarray(4).map((byte) => byte ^ key)).toString("utf8");
    },
  };
}

const PASSWORD = "correct horse battery staple";
const USERNAME = "jane.doe@gmail.com";
const NOTES = "security question: first pet was Rex";

test("vault: every value is sealed on disk, and comes back unsealed only for a fill", async () => {
  const dir = tempDir();
  const vault = new Vault(dir, fakeSealer());
  const login = await vault.save({ kind: "login", title: "", site: "https://shop.example/login?next=/", values: { username: USERNAME, password: PASSWORD, notes: NOTES } });
  assert.equal(login.site, "https://shop.example", "the site is kept as an origin");
  assert.equal(login.hint, "j…@gmail.com");
  assert.deepEqual(login.fields.sort(), ["notes", "password", "username"]);

  const disk = readFileSync(join(dir, "vault.json"), "utf8");
  for (const value of [PASSWORD, USERNAME, NOTES, Buffer.from(PASSWORD).toString("base64")]) assert.equal(disk.includes(value), false, `${value} isn't on disk`);

  // Another session reads the same file and unseals it.
  const again = new Vault(dir, fakeSealer());
  assert.deepEqual(again.reveal(login.id, ["username", "password"]), { username: USERNAME, password: PASSWORD });
  const draft = again.draft(login.id);
  assert.equal(draft.values.username, USERNAME);
  assert.equal(draft.values.password, undefined, "the edit form never gets the password");
  assert.equal(draft.hasPassword, true);

  // Editing with an empty password keeps the saved one.
  await again.save({ id: login.id, kind: "login", title: "Work", site: "shop.example", values: { username: "jane@work.example", password: "" } });
  assert.deepEqual(again.reveal(login.id, ["username", "password", "notes"]), { username: "jane@work.example", password: PASSWORD }, "notes left empty are cleared");

  // A value sealed elsewhere (another account, a changed file) fails without saying what it was.
  const json = JSON.parse(readFileSync(join(dir, "vault.json"), "utf8"));
  json.items[0].sealed.password = Buffer.from("garbage").toString("base64");
  writeFileSync(join(dir, "vault.json"), JSON.stringify(json));
  assert.throws(() => new Vault(dir, fakeSealer()).reveal(login.id, ["password"]), (error: Error) => /can't be unsealed/.test(error.message) && !error.message.includes(PASSWORD));
});

test("vault: nothing new is saved without secure storage, and payment cards aren't kept", async () => {
  await assert.rejects(new Vault(tempDir(), fakeSealer(false)).save({ kind: "contact", title: "", values: { name: "Ada" } }), /secure storage isn't available/);
  const linuxWithoutKeyring = new Vault(tempDir(), fakeSealer(true, "basic_text"));
  assert.equal(linuxWithoutKeyring.available(), false, "basic_text only obfuscates");
  const vault = new Vault(tempDir(), fakeSealer());
  await assert.rejects(vault.save({ kind: "login", title: "", site: "shop.example", values: { password: "x", notes: "card 4242 4242 4242 4242 exp 12/30" } }), /payment card/);
  await assert.rejects(vault.save({ kind: "login", title: "", site: "", values: { password: "x" } }), /needs the site/);
  await assert.rejects(vault.save({ kind: "login", title: "", site: "file:///C:/x", values: { password: "x" } }), /needs the site/);
  await assert.rejects(vault.save({ kind: "contact", title: "", values: { cvv: "123" } }), /has no cvv field/);
  assert.equal(containsPaymentCard("4111-1111-1111-1111"), true);
  assert.equal(containsPaymentCard("4111 1111 1111 1112"), false, "fails the Luhn check");
  assert.equal(containsPaymentCard("+1 415 555 0100"), false);
});

test("csv: quoted fields, doubled quotes, line breaks inside quotes, a BOM and CRLF", () => {
  assert.deepEqual(parseCsv('\ufeffa,b,c\r\n"1, one","say ""hi""","two\nlines"\r\n\r\nx,,z'), [
    ["a", "b", "c"],
    ["1, one", 'say "hi"', "two\nlines"],
    ["x", "", "z"],
  ]);
  assert.throws(() => parseCsv('a,"open'), /ends inside a quoted field/);
});

test("csv import: Chrome, Edge and Firefox exports; app logins and blank passwords skipped; same site and username updated", async () => {
  const chrome = parsePasswordExport(
    ["name,url,username,password,note", `shop.example,https://shop.example/login,${USERNAME},"${PASSWORD}",${NOTES}`, "Bank,https://www.bank.example/,jd,pw1,4111 1111 1111 1111", "app,android://abc@com.app/,me,pw,", "blank,https://blank.example/,me,,"].join("\n"),
  );
  assert.equal(chrome.format, "chrome");
  assert.equal(chrome.skipped, 2);
  assert.deepEqual(
    chrome.logins.map((login) => [login.site, login.title, login.username]),
    [
      ["https://shop.example", "", USERNAME],
      ["https://www.bank.example", "Bank", "jd"],
    ],
    "Chrome's host-named logins get no title of their own",
  );
  const edge = parsePasswordExport("name,url,username,password\r\nmail,https://mail.example/,me,pw\r\n");
  assert.equal(edge.logins[0].site, "https://mail.example");
  const firefox = parsePasswordExport(
    '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n"https://shop.example","jane.doe@gmail.com","new password",,"https://shop.example","{1}","1","1","1"\n',
  );
  assert.equal(firefox.format, "firefox");
  assert.throws(() => parsePasswordExport("title,login_uri,secret\nx,y,z"), /isn't a password export/);

  const dir = tempDir();
  const vault = new Vault(dir, fakeSealer());
  const first = await vault.importLogins(chrome);
  assert.deepEqual(first, { format: "chrome", added: 2, updated: 0, unchanged: 0, skipped: 2, notesDropped: 1 });
  assert.equal((await vault.importLogins(chrome)).unchanged, 2, "importing again changes nothing");
  const second = await vault.importLogins(firefox);
  assert.equal(second.updated, 1, "Firefox's newer password for the same login replaces it");
  const shop = vault.list().find((item) => item.site === "https://shop.example")!;
  assert.equal(vault.reveal(shop.id, ["password"]).password, "new password");
  const bank = vault.list().find((item) => item.site === "https://www.bank.example")!;
  assert.equal(bank.fields.includes("notes"), false, "a note that looked like a card number was left out");
  assert.equal(readFileSync(join(dir, "vault.json"), "utf8").includes("new password"), false);
});

test("sites: a login fills on its own origin only (www. aside), never downgraded to http", () => {
  assert.equal(normalizeSite("shop.example"), "https://shop.example");
  assert.equal(normalizeSite("127.0.0.1:5173/login"), "http://127.0.0.1:5173");
  assert.equal(normalizeSite("javascript:alert(1)"), null);
  const site = "https://shop.example";
  assert.equal(vaultSiteMatches(site, "https://shop.example/login"), true);
  assert.equal(vaultSiteMatches(site, "https://www.shop.example/"), true);
  assert.equal(vaultSiteMatches("https://www.shop.example", "https://shop.example/"), true);
  for (const other of ["http://shop.example/", "https://accounts.shop.example/", "https://shop.example.evil.test/", "https://evilshop.example/", "https://shop.example:8443/", "file:///shop.example"]) {
    assert.equal(vaultSiteMatches(site, other), false, other);
  }
  assert.equal(vaultSiteMatches("http://shop.example", "https://shop.example/"), true, "an http login fills on the https page");
  assert.equal(vaultSiteMatches("http://127.0.0.1:5173", "http://127.0.0.1:5174/"), false, "another port is another site");
  assert.equal(vaultSiteMatches("http://127.0.0.1:5173", "http://localhost:5173/"), false);
  assert.equal(maskHint("janedoe"), "j…e");
  assert.equal(maskHint("al"), "…");
  assert.deepEqual(
    ["given_name", "family_name", "address_line1", "address_line2", "street"].map((key) => contactFillValue({ name: "Ada King Lovelace", street: "12 St James's Square\nFlat 3\n" }, key as never)),
    ["Ada King", "Lovelace", "12 St James's Square", "Flat 3", "12 St James's Square, Flat 3"],
  );
});

// ---- filling --------------------------------------------------------------------------------

const field = (ref: string, extra: Partial<VaultField> = {}): VaultField => ({
  ref,
  role: "textbox",
  name: ref === "e2" ? "Password" : "Email",
  tag: "input",
  inputType: ref === "e2" ? "password" : "email",
  autocomplete: ref === "e2" ? "current-password" : "username",
  fieldName: "",
  submits: false,
  editable: true,
  href: "",
  inPage: true,
  origin: "https://shop.example",
  ...extra,
});

function fakeBrowser(page: { url: string; site: string | null } | null, fields: Record<string, VaultField>) {
  const fills: VaultFill[][] = [];
  /** What the agent's window holds from earlier fills, as the real browser would blank. */
  const held = new Set<string>();
  const browser: VaultBrowser = {
    page: async () => page,
    fields: async (_agentId, refs) => new Map(refs.filter((ref) => fields[ref] != null).map((ref) => [ref, fields[ref]])),
    fill: async (_agentId, list, options) => {
      fills.push(list);
      return { filled: list.length, submitted: options.submit, navigated: false, error: null };
    },
    scrub: (_agentId, text) => scrubValues(text, held),
  };
  return { browser, fills, held, setPage: (next: typeof page) => (page = next) };
}

async function setup(page = { url: "https://shop.example/login", site: "https://shop.example" as string | null }, fields = { e1: field("e1"), e2: field("e2") }) {
  const dir = tempDir();
  const vault = new Vault(dir, fakeSealer());
  const audit = new VaultAudit(join(dir, "vault-audit.jsonl"));
  const login = await vault.save({ kind: "login", title: "", site: "shop.example", values: { username: USERNAME, password: PASSWORD, notes: NOTES } });
  const contact = await vault.save({ kind: "contact", title: "Home", values: { name: "Ada Lovelace", email: "ada@example.com", phone: "+44 20 7946 0958", street: "12 St James's Square", city: "London", country: "United Kingdom" } });
  const fake = fakeBrowser(page, fields);
  const approvals = new Map<string, string>();
  const filler = new VaultFiller({ vault, audit, browser: fake.browser, spendApproval: (id, subject) => approvals.get(id) === subject && approvals.delete(id) });
  return { dir, vault, audit, login, contact, fake, approvals, filler };
}

const SECRETS = [PASSWORD, USERNAME, NOTES, "Ada Lovelace", "ada@example.com", "7946", "St James", "London"];
const assertValueFree = (text: string, what: string) => {
  for (const value of SECRETS) assert.equal(text.includes(value), false, `${what} has “${value}”`);
};

test("vault_list returns ids and labels, never a value", async () => {
  const { filler, login, contact } = await setup();
  const reply = await filler.list("a1");
  assertValueFree(JSON.stringify(reply), "vault_list's reply");
  assert.deepEqual(
    reply.items.map((item) => [item.id, item.label, item.matchesPage]),
    [
      [contact.id, "Contact info “Home” (a…@example.com)", true],
      [login.id, "Login for shop.example (j…@gmail.com)", true],
    ],
  );
  assert.deepEqual(reply.items.find((item) => item.id === login.id)?.fields, ["username", "password"], "notes aren't listed for filling");

  // Through the daemon's tool, as the model sees it.
  const context = { agentId: "a1", host: { vault: { list: ({ agentId }: { agentId: string }) => filler.list(agentId) } } } as unknown as ToolContext;
  const output = (await LOCAL_TOOLS.vault_list.execute({}, context)).output;
  assertValueFree(output, "vault_list's output");
  assert.match(output, /Login for shop\.example \(j…@gmail\.com\) — username, password — fills on shop\.example \(fits the page you're on\)/);
  assert.equal(vaultItemLabel({ kind: "login", title: "Work", site: "https://shop.example", hint: "" }), "Login for Work on shop.example");
});

test("request_credential: refused on the wrong origin, before anyone is asked or anything filled", async () => {
  const { filler, login, fake, audit } = await setup({ url: "https://shop-example.evil.test/login", site: "https://shop-example.evil.test" }, { e1: field("e1", { origin: "https://shop-example.evil.test" }), e2: field("e2", { origin: "https://shop-example.evil.test" }) });
  await assert.rejects(filler.plan({ agentId: "a1", itemId: login.id, fields: { username: "e1", password: "e2" }, submit: false }), /is for shop\.example, and the page is on shop-example\.evil\.test, so nothing was filled/);
  await assert.rejects(filler.fill({ agentId: "a1", itemId: login.id, fields: { password: "e2" }, submit: false, expectSite: "https://shop-example.evil.test", approvalId: "x", callId: "c" }), /nothing was filled/);
  assert.equal(fake.fills.length, 0);
  const { ok, records } = verifyAuditChain(readFileSync(audit.file, "utf8"));
  assert.equal(ok, true);
  assert.deepEqual(
    records.map((record) => [record.event, record.site]),
    [
      ["fill-refused", "https://shop-example.evil.test"],
      ["fill-refused", "https://shop-example.evil.test"],
    ],
  );

  // No http(s) page (about:blank, or a page whose origins disagree): nothing to fill.
  fake.setPage({ url: "about:blank", site: null });
  await assert.rejects(filler.plan({ agentId: "a1", itemId: login.id, fields: { password: "e2" }, submit: false }), /isn't a web page/);
});

test("request_credential: fields are checked (a password only into a password field, no frames, no card fields)", async () => {
  const fields = {
    e1: field("e1"),
    e2: field("e2"),
    e3: field("e3", { name: "Search", inputType: "text", autocomplete: "" }),
    e4: field("e4", { inPage: false, origin: "https://ads.test" }),
    e5: field("e5", { name: "Card number", inputType: "text", autocomplete: "cc-number" }),
    e6: field("e6", { role: "button", tag: "button", inputType: "", editable: false, name: "Sign in" }),
    e7: field("e7", { name: "Birthday", inputType: "date", autocomplete: "" }),
    // A password field in a frame from the page's own origin (the agent browser reads those frames).
    e8: field("e8", { name: "Password", inputType: "password", autocomplete: "current-password", inPage: false, origin: "" }),
  };
  const { filler, login, contact } = await setup(undefined, fields);
  const plan = (itemId: string, map: Record<string, string>) => filler.plan({ agentId: "a1", itemId, fields: map, submit: false });
  await assert.rejects(plan(login.id, { password: "e3" }), /isn't a password field/);
  await assert.rejects(plan(login.id, { username: "e2" }), /is a password field/);
  await assert.rejects(plan(login.id, { password: "e4" }), /is inside a frame/);
  await assert.rejects(plan(login.id, { password: "e8" }), /e8 \(textbox “Password”\) is inside a frame, and the vault fills only the page's own fields/, "a same-origin frame's field too");
  await assert.rejects(plan(contact.id, { name: "e5" }), /payment card field/);
  await assert.rejects(plan(login.id, { username: "e6" }), /isn't a text field/);
  await assert.rejects(plan(contact.id, { phone: "e7" }), /isn't a text field/, "a date picker draws its value in parts");
  await assert.rejects(plan(login.id, { username: "e9" }), /isn't a ref on this page/);
  await assert.rejects(plan(login.id, { email: "e1" }), /A login doesn't fill email/);
  await assert.rejects(plan(login.id, { username: "e1", password: "e1" }), /named twice/);
  await assert.rejects(plan(login.id, {}), /at least one field/);
  await assert.rejects(plan("vnope", { username: "e1" }), /no vault item/);

  const ok = await plan(login.id, { username: "e1", password: "e2" });
  assert.equal(ok.subject, `vault:a1/${login.id}@https://shop.example`);
  assertValueFree(JSON.stringify(ok), "the plan");
  // Contact info fills on any site, still asking there.
  const anywhere = await plan(contact.id, { email: "e1" });
  assert.equal(anywhere.site, "https://shop.example");
});

test("request_credential: the card always asks, is never remembered, and names no value", async () => {
  const { filler, login } = await setup();
  const context = { agentId: "a1", host: { vault: { plan: (call: never) => filler.plan(call) } } } as unknown as ToolContext;
  const plan = await LOCAL_TOOLS.request_credential.plan({ item_id: login.id, fields: { username: "e1", password: "e2" }, submit: true }, context);
  assert.equal(plan.risk, "dangerous");
  assert.equal(plan.title, "Fill your login on shop.example");
  assert.equal(plan.description, `vault:a1/${login.id}@https://shop.example`);
  assert.deepEqual(plan.reasons, ["Login for shop.example (j…@gmail.com)", "fills Username into e1 (textbox “Email”), Password into e2 (textbox “Password”)", "then presses Enter to submit the form"]);
  assertValueFree(JSON.stringify(plan), "the card");
  const input = { permissionId: "vault", ...plan, workspace: "C:\\w" };
  for (const setting of ["guarded", "trusted", "ask_always"] as const) assert.equal(evaluate(input, { vault: setting }, [{ toolId: "vault", scope: plan.scope }, { toolId: "vault", scope: "all" }]).decision, "ask", setting);
  assert.equal(evaluate(input, { vault: "blocked" }, []).decision, "block", "Settings can turn fills off");
  assert.equal(grantRecipient("vault", plan.scope, plan.risk), null, "no Always allow");
  assert.equal(evaluate({ permissionId: "vault", risk: "read-only", reasons: [], scope: "all", paths: [], workspace: "C:\\w" }, {}, []).decision, "allow", "vault_list runs");
});

test("request_credential: fills only on the user's approval for that item on that site, spent once; the result is value-free", async () => {
  const { filler, login, contact, fake, approvals, audit } = await setup();
  const call = { agentId: "a1", itemId: login.id, fields: { username: "e1", password: "e2" }, submit: true, callId: "c1" };
  const subject = `vault:a1/${login.id}@https://shop.example`;

  await assert.rejects(filler.fill({ ...call, expectSite: "https://shop.example", approvalId: null }), /wasn't allowed in the app on this computer/);
  approvals.set("ap-other", `vault:a1/${contact.id}@https://shop.example`);
  await assert.rejects(filler.fill({ ...call, expectSite: "https://shop.example", approvalId: "ap-other" }), /wasn't allowed/, "an approval for another item doesn't fill this one");
  approvals.set("ap-a2", `vault:a2/${login.id}@https://shop.example`);
  await assert.rejects(filler.fill({ ...call, expectSite: "https://shop.example", approvalId: "ap-a2" }), /wasn't allowed/, "nor one for another agent");
  approvals.set("ap1", subject);
  await assert.rejects(filler.fill({ ...call, expectSite: "https://elsewhere.example", approvalId: "ap1" }), /not elsewhere\.example as when you were asked/);
  assert.equal(fake.fills.length, 0);

  const reply = await filler.fill({ ...call, expectSite: "https://shop.example", approvalId: "ap1" });
  assert.equal(reply.output.startsWith("Filled 2 fields on shop.example (username, password) from Login for shop.example (j…@gmail.com) and pressed Enter."), true, reply.output);
  assertValueFree(reply.output, "the result");
  assert.deepEqual(fake.fills[0], [
    { ref: "e1", value: USERNAME, password: false },
    { ref: "e2", value: PASSWORD, password: true },
  ]);
  await assert.rejects(filler.fill({ ...call, expectSite: "https://shop.example", approvalId: "ap1" }), /wasn't allowed/, "an approval fills once");

  // Contact info fills on any site (on its own approval there), and parts of itself.
  approvals.set("ap2", `vault:a1/${contact.id}@https://shop.example`);
  const contactReply = await filler.fill({ agentId: "a1", itemId: contact.id, fields: { given_name: "e1" }, submit: false, expectSite: "https://shop.example", approvalId: "ap2", callId: "c2" });
  assert.match(contactReply.output, /^Filled 1 field on shop\.example \(given_name\) from Contact info “Home” \(a…@example\.com\)\./);
  assert.deepEqual(fake.fills[1], [{ ref: "e1", value: "Ada", password: false }]);

  const log = readFileSync(audit.file, "utf8");
  assertValueFree(log, "the audit log");
  const fills = verifyAuditChain(log).records.filter((record) => record.event === "fill");
  assert.deepEqual(
    fills.map((record) => [record.itemId, record.site, record.fields, record.agentId]),
    [
      [login.id, "https://shop.example", ["username", "password"], "a1"],
      [contact.id, "https://shop.example", ["given_name"], "a1"],
    ],
  );
});

// ---- what the agent reads after a fill ---------------------------------------------------------

test("snapshot: fields filled from the vault show as filled, never with their contents", () => {
  const nodes: AXNode[] = [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Sign in" }, childIds: ["2", "3", "4"] },
    { nodeId: "2", parentId: "1", role: { value: "textbox" }, name: { value: "Email" }, value: { value: USERNAME }, backendDOMNodeId: 11 },
    { nodeId: "3", parentId: "1", role: { value: "textbox" }, name: { value: "Password" }, value: { value: "••••••••" }, backendDOMNodeId: 12 },
    { nodeId: "4", parentId: "1", role: { value: "combobox" }, name: { value: "Country" }, value: { value: "United Kingdom" }, backendDOMNodeId: 13 },
  ];
  const fields = new Map([
    [11, { tag: "input", inputType: "email", autocomplete: "username", fieldName: "email" }],
    [12, { tag: "input", inputType: "password", autocomplete: "current-password", fieldName: "pw" }],
    [13, { tag: "select", inputType: "", autocomplete: "", fieldName: "country" }],
  ]);
  const text = renderSnapshot(nodes, new RefTable(), { fields, filled: new Set([11, 12, 13]) }).text;
  assert.equal(text, ['- textbox "Email" [filled from your vault] [ref=e1]', '- textbox "Password" [password] [filled from your vault] [ref=e2]', '- combobox "Country" [filled from your vault] [ref=e3]'].join("\n"));
  assert.match(renderSnapshot(nodes, new RefTable(), { fields }).text, /jane\.doe@gmail\.com/, "unfilled, an email field shows what's in it");
});

test("page text: vault values are blanked wherever a page repeats them, URL-encoded too", () => {
  const values = new Set([USERNAME, "Ada Lovelace", "Rex"]);
  const text = `Signed in as JANE.DOE@gmail.com — https://shop.example/?u=${encodeURIComponent(USERNAME)}&n=Ada+Lovelace — Rex the dog`;
  const scrubbed = scrubValues(text, values);
  assert.equal(scrubbed, `Signed in as ${HIDDEN_VALUE} — https://shop.example/?u=${HIDDEN_VALUE}&n=${HIDDEN_VALUE} — Rex the dog`, "short values aren't blanked in ordinary text");
  assert.equal(scrubValues("a.b+c", new Set(["a.b+c"])), HIDDEN_VALUE, "values are matched literally");
});

test("screenshots: a filled field's box is painted over, in device pixels", () => {
  const width = 10;
  const height = 6;
  const bitmap = new Uint8Array(width * height * 4).fill(0x11);
  // A field at CSS (2,1)–(4,2) on a 2x screen, with no margin: device pixels (4,2)–(8,4).
  const region = quadRegion([2, 1, 4, 1, 4, 2, 2, 2], 2, 0);
  assert.deepEqual(region, { x: 4, y: 2, width: 4, height: 2 });
  assert.equal(coverRegions(bitmap, width, height, [region, { x: -5, y: 5, width: 7, height: 9 }]), 8 + 2);
  const at = (x: number, y: number) => bitmap[(y * width + x) * 4];
  assert.equal(at(4, 2), 0x80);
  assert.equal(at(7, 3), 0x80);
  assert.equal(at(8, 3), 0x11, "nothing outside the box");
  assert.equal(at(0, 5), 0x80, "a box past the edge is clipped");
  assert.throws(() => coverRegions(new Uint8Array(4), width, height, []), /smaller than its size/);
});

// ---- the audit log ---------------------------------------------------------------------------

test("audit: a hash chain without values; an edited, removed or reordered line breaks it", () => {
  const file = join(tempDir(), "vault-audit.jsonl");
  const audit = new VaultAudit(file);
  audit.append({ event: "added", itemId: "v1", label: "Login for shop.example (j…@gmail.com)", site: "https://shop.example" });
  audit.append({ event: "fill", itemId: "v1", label: "Login for shop.example (j…@gmail.com)", site: "https://shop.example", fields: ["username", "password"], agentId: "a1" });
  audit.append({ event: "fill", itemId: "v1", label: "Login for shop.example (j…@gmail.com)", site: "https://shop.example", fields: ["password"], agentId: "a2" });
  const text = readFileSync(file, "utf8");
  const chain = verifyAuditChain(text);
  assert.equal(chain.ok, true);
  assert.deepEqual(
    chain.records.map((record) => [record.seq, record.event]),
    [
      [1, "added"],
      [2, "fill"],
      [3, "fill"],
    ],
  );
  assert.equal(chain.records[1].prev, chain.records[0].hash);
  const view = audit.view();
  assert.equal(view.ok, true);
  assert.deepEqual(
    view.recent.map((fill) => fill.agentId),
    ["a2", "a1"],
    "newest first",
  );

  const lines = text.trim().split("\n");
  assert.equal(verifyAuditChain(lines.map((line, index) => (index === 1 ? line.replace("shop.example", "evil.example") : line)).join("\n")).brokenAt, 2, "an edited line");
  assert.equal(verifyAuditChain([lines[0], lines[2]].join("\n")).brokenAt, 2, "a removed line");
  assert.equal(verifyAuditChain([lines[1], lines[0], lines[2]].join("\n")).brokenAt, 1, "reordered lines");

  // A new session goes on from the last line.
  new VaultAudit(file).append({ event: "deleted", itemId: "v1", label: "Login for shop.example (j…@gmail.com)" });
  assert.equal(verifyAuditChain(readFileSync(file, "utf8")).records.length, 4);
  writeFileSync(file, lines.map((line, index) => (index === 0 ? line.replace("added", "edited") : line)).join("\n"));
  assert.deepEqual([new VaultAudit(file).view().ok, new VaultAudit(file).view().brokenAt], [false, 1]);
});

// ---- review fixes ----------------------------------------------------------------------------

test("vault: an unreadable vault.json is never written over (only a missing one is empty)", async () => {
  const cases: Array<[string, (file: string) => void, RegExp]> = [
    ["not JSON", (file) => writeFileSync(file, '{"version":1,"items":[{"id":'), /isn't valid JSON/],
    ["a newer version", (file) => writeFileSync(file, JSON.stringify({ version: 2, items: [], more: "x" })), /saved by a newer version of the app \(version 2\)/],
    ["something else", (file) => writeFileSync(file, JSON.stringify({ items: "nope" })), /isn't in a form this app reads/],
    ["a folder in its place (it can't be read)", (file) => mkdirSync(file), /couldn't be read \(E[A-Z]+\)/],
  ];
  for (const [what, make, reason] of cases) {
    const dir = tempDir();
    const file = join(dir, "vault.json");
    make(file);
    const before = statSync(file).isDirectory() ? "dir" : readFileSync(file, "utf8");
    const vault = new Vault(dir, fakeSealer());
    assert.match(vault.problem() ?? "", reason, what);
    assert.deepEqual(vault.list(), [], `${what}: nothing listed`);
    await assert.rejects(vault.save({ kind: "contact", title: "", values: { name: "Ada" } }), /Nothing was changed, and the file is left as it is/, `${what}: save`);
    await assert.rejects(vault.importLogins({ format: "chrome", logins: [{ site: "https://a.example", title: "", username: "u", password: "p", notes: "" }], skipped: 0 }), /left as it is/, `${what}: import`);
    assert.throws(() => vault.reveal("v1", ["password"]), /left as it is/, `${what}: reveal`);
    const filler = new VaultFiller({ vault, audit: new VaultAudit(join(dir, "audit.jsonl")), browser: fakeBrowser(null, {}).browser, spendApproval: () => false });
    await assert.rejects(filler.list("a1"), /The vault can't be read right now/, `${what}: vault_list says so`);
    assert.equal(statSync(file).isDirectory() ? "dir" : readFileSync(file, "utf8"), before, `${what}: the file is as it was`);
  }

  // A missing file is an empty vault; a file put right is read again.
  const dir = tempDir();
  const vault = new Vault(dir, fakeSealer());
  assert.equal(vault.problem(), null);
  const saved = await vault.save({ kind: "contact", title: "", values: { name: "Ada" } });
  const good = readFileSync(join(dir, "vault.json"), "utf8");
  writeFileSync(join(dir, "vault.json"), "garbage");
  const broken = new Vault(dir, fakeSealer());
  assert.notEqual(broken.problem(), null);
  writeFileSync(join(dir, "vault.json"), good);
  assert.equal(broken.problem(), null, "tried again once it reads");
  assert.deepEqual(
    broken.list().map((item) => item.id),
    [saved.id],
  );
});

test("keys: every clipboard chord is told apart (Shift+Delete is Windows' cut)", () => {
  const chord = (key: string) => parseKeyChord(key)!;
  for (const key of ["Control+c", "Control+C", "Meta+c", "Control+Shift+c"]) assert.equal(clipboardChord(chord(key)), "copy", key);
  for (const key of ["Control+x", "Meta+X", "Shift+Delete"]) assert.equal(clipboardChord(chord(key)), "cut", key);
  for (const key of ["Control+v", "Meta+v"]) assert.equal(clipboardChord(chord(key)), "paste", key);
  assert.equal(clipboardChord({ key: "Insert", modifiers: 2 }), "copy", "Control+Insert");
  assert.equal(clipboardChord({ key: "Insert", modifiers: 8 }), "paste", "Shift+Insert");
  for (const key of ["Delete", "Shift+Home", "Control+a", "c", "Shift+C", "Enter"]) assert.equal(clipboardChord(chord(key)), null, key);
});

test("clipboard: read_clipboard gets vault values blanked, a short one when it's all the clipboard holds", () => {
  const values = [PASSWORD, "4321"];
  assert.equal(scrubClipboard(`  ${PASSWORD}\n`, values), HIDDEN_VALUE);
  assert.equal(scrubClipboard(`pw: ${PASSWORD}`, values), `pw: ${HIDDEN_VALUE}`);
  assert.equal(scrubClipboard("abc", ["abc"]), HIDDEN_VALUE, "a value too short to blank in text is still all of it");
  assert.equal(scrubClipboard("abcdef", ["abc"]), "abcdef");
  assert.equal(scrubClipboard("nothing here", values), "nothing here");
  assert.equal(holdsValue(encodeURIComponent(PASSWORD), values), true);
  assert.equal(holdsValue("pin 4321 here", ["4321"]), true);
  assert.equal(holdsValue("12", ["123"]), false);
});

test("page text: values blanked as a form submitted by GET encodes them (! ' ( ) ~), and as scripts do", () => {
  const cases: Array<[string, string]> = [
    ["Hunter2!", "Hunter2%21"],
    ["it's a pass(word)~", "it%27s+a+pass%28word%29%7E"],
    ["it's a pass(word)~", "it's%20a%20pass(word)~"],
  ];
  for (const [value, encoded] of cases) {
    assert.equal(scrubValues(`https://shop.example/search?q=${encoded}&x=1`, [value]), `https://shop.example/search?q=${HIDDEN_VALUE}&x=1`, encoded);
  }
  assert.equal(scrubValues("Q=HUNTER2%21", ["Hunter2!"]), `Q=${HIDDEN_VALUE}`, "any case, hex digits too");
});

test("request_credential: a page label naming a value doesn't carry it onto the card or into an error", async () => {
  const fields = {
    e1: field("e1"),
    // A password step that names the account, as many do.
    e2: field("e2", { name: `Password for ${USERNAME}` }),
    e3: field("e3", { name: `Search ${USERNAME}`, inputType: "text", autocomplete: "" }),
    e4: field("e4", { name: "Gift note: earlier-secret-value", inputType: "text", autocomplete: "" }),
  };
  const { filler, login, contact, fake } = await setup(undefined, fields);
  const plan = await filler.plan({ agentId: "a1", itemId: login.id, fields: { username: "e1", password: "e2" }, submit: false });
  assert.equal(plan.fields[1].element, `textbox “Password for ${HIDDEN_VALUE}”`);
  assertValueFree(JSON.stringify(plan), "the plan");
  await assert.rejects(filler.plan({ agentId: "a1", itemId: login.id, fields: { password: "e3" }, submit: false }), (error: Error) => /isn't a password field/.test(error.message) && !error.message.includes(USERNAME));
  // A value the window holds from another fill is blanked too.
  fake.held.add("earlier-secret-value");
  const other = await filler.plan({ agentId: "a1", itemId: contact.id, fields: { name: "e4" }, submit: false });
  assert.equal(other.fields[0].element, `textbox “Gift note: ${HIDDEN_VALUE}”`);
});

test("screenshots: anything on screen holding a value is painted over, not only the fields filled", () => {
  const box = (x: number, y: number) => ({ x, y, width: 100, height: 20 });
  const scan = {
    fields: [
      // Back restored the password field; a show-password toggle swapped in a text field with it; a pasted copy.
      { value: PASSWORD, rects: [box(10, 10)] },
      { value: `copy: ${PASSWORD}`, rects: [box(10, 40)] },
      { value: "ordinary", rects: [box(10, 70)] },
      { value: "abc", rects: [box(10, 100)] },
    ],
    texts: [
      { text: `Signed in as ${USERNAME.toUpperCase()}`, rects: [box(200, 10), box(200, 30)] },
      { text: "Welcome back", rects: [box(200, 60)] },
      { text: `?u=${encodeURIComponent(USERNAME)}`, rects: [] },
    ],
    truncated: false,
  };
  const found = valueRegions(scan, [PASSWORD, USERNAME, "abc"]);
  assert.equal(found.places, 4, "the two fields, the short value that's all of a field, the echo (off-screen text isn't counted)");
  assert.deepEqual(found.regions, [box(10, 10), box(10, 40), box(10, 100), box(200, 10), box(200, 30)]);
  assert.deepEqual(scaleRegion({ x: 10, y: 5, width: 20, height: 10 }, 2, 1), { x: 19, y: 9, width: 42, height: 22 });
});

test("frames: a frame that navigates drops its world, and a stale world is made again once", async () => {
  const worlds = new Map([
    ["", 1],
    ["child", 2],
    ["other", 3],
  ]);
  forgetFrameWorld(worlds, "Page.frameNavigated", { frame: { id: "child", parentId: "main" } });
  assert.deepEqual([...worlds.keys()], ["", "other"], "only the frame that navigated");
  forgetFrameWorld(worlds, "Page.frameDetached", { frameId: "other" });
  forgetFrameWorld(worlds, "Page.loadEventFired", {});
  assert.deepEqual([...worlds.keys()], [""]);
  forgetFrameWorld(worlds, "Page.frameNavigated", { frame: { id: "main" } });
  assert.equal(worlds.size, 0, "the page's own document");

  // focused() and callOn run through inWorld: a world gone with its document is made again, once.
  let made = 0;
  const stale = new Map([["child", 7]]);
  const tried: number[] = [];
  const value = await inWorld(
    stale,
    "child",
    async () => 10 + ++made,
    async (contextId) => {
      tried.push(contextId);
      if (contextId === 7) throw new Error("Cannot find context with specified id");
      return `ran in ${contextId}`;
    },
  );
  assert.deepEqual([value, tried, made, stale.get("child")], ["ran in 11", [7, 11], 1, 11]);
  await assert.rejects(
    inWorld(new Map(), null, async () => 1, async () => Promise.reject(new Error("Cannot find context with specified id"))),
    /Cannot find context/,
    "not twice",
  );
  let runs = 0;
  await assert.rejects(
    inWorld(new Map(), null, async () => 1, async () => (runs++, Promise.reject(new Error("No node with given id")))),
    /No node/,
  );
  assert.equal(runs, 1, "other errors aren't retried");
});
