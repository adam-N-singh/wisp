// The vault (README "Vault"): logins and contact info on this PC, which agents fill into their
// agent browser without seeing a value.
//
//   - `Vault` keeps the items in `vault.json`, every value sealed with safeStorage (DPAPI on
//     Windows) one field at a time. A login's site, a masked username ("j…@gmail.com") and which
//     fields are set stay readable: they're what the app lists and the model sees. Payment cards
//     aren't kept. Without safeStorage nothing new is saved. Only a missing vault.json is an empty
//     vault: one that can't be read is never written over (`problem()` says why).
//   - `VaultAudit` appends each fill (and each change to the vault) to `vault-audit.jsonl`, a hash
//     chain with no values in it: each line carries the hash of the one before.
//   - `VaultFiller` answers the daemon's vault tools (src/local-exec/vault-tools.ts). It reads the
//     page's real origin from the agent browser, refuses a login on another site, checks every field
//     (a password only into a password field, nothing into a card field or another frame), and fills
//     only on an approval the user gave in the app on this PC for that item on that site, spent once.
//     Values go from here to the page (src/main/agent-browser.ts), never to the daemon, the box, the
//     transcript or the model: results say "Filled 2 fields on shop.example".
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BrowserTarget, sensitiveField, siteLabel, siteOf } from "../shared/agent-browser";
import {
  CONTACT_FIELDS,
  CONTACT_FILL_KEYS,
  type ContactField,
  contactFillValue,
  containsPaymentCard,
  FIELD_LABELS,
  LOGIN_FIELDS,
  LOGIN_FILL_KEYS,
  maskHint,
  normalizeSite,
  type VaultAuditView,
  type VaultFillKey,
  type VaultFillReply,
  type VaultImportResult,
  type VaultItemDraft,
  type VaultItemKind,
  type VaultItemSummary,
  vaultItemLabel,
  type VaultListReply,
  type VaultPlanInfo,
  vaultSiteMatches,
} from "../shared/vault";
import { describeTarget } from "../local-exec/browser-policy";
import { scrubValues } from "./agent-browser-mask";
import { writeFileAtomic } from "./atomic-write";
import type { ParsedExport } from "./vault-csv";

/** Electron's safeStorage, or a stand-in for tests. */
export interface Sealer {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux: "basic_text" means no keyring, and values would only be obfuscated. */
  getSelectedStorageBackend?(): string;
}

interface StoredItem {
  id: string;
  kind: VaultItemKind;
  title: string;
  site: string | null;
  hint: string;
  /** Field → its value sealed by safeStorage, base64. */
  sealed: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface VaultItemInput {
  id?: string | null;
  kind: VaultItemKind;
  title: string;
  site?: string;
  /** Values by field. Editing, an empty password keeps the saved one; other empty fields are cleared. */
  values: Record<string, string>;
}

const MAX_ITEMS = 5_000;
const MAX_VALUE = 4_000;

export class VaultError extends Error {}

export class Vault {
  private readonly file: string;
  private items: StoredItem[] = [];
  /** Why vault.json can't be read; while there's one, nothing is written over it. */
  private unreadable: string | null = null;

  constructor(
    dir: string,
    private readonly sealer: Sealer,
  ) {
    this.file = join(dir, "vault.json");
    this.load();
  }

  /**
   * Reads vault.json. Only a missing file is an empty vault: one that can't be read (locked, not
   * JSON, from another version of the app) is left as it is, and the vault refuses to write until
   * it can be read.
   */
  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.items = [];
        this.unreadable = null;
      } else this.unreadable = `vault.json couldn't be read (${code ?? "an unknown error"}).`;
      return;
    }
    let stored: { version?: unknown; items?: unknown };
    try {
      stored = JSON.parse(text);
    } catch {
      this.unreadable = "vault.json isn't valid JSON (it was changed outside the app, or only partly written).";
      return;
    }
    if (stored?.version !== 1 || !Array.isArray(stored.items)) {
      this.unreadable = typeof stored?.version === "number" && stored.version > 1 ? `vault.json was saved by a newer version of the app (version ${stored.version}).` : "vault.json isn't in a form this app reads.";
      return;
    }
    this.items = stored.items as StoredItem[];
    this.unreadable = null;
  }

  /** Why the vault can't be read now, or null. A file that was locked is tried again. */
  problem(): string | null {
    if (this.unreadable != null) this.load();
    return this.unreadable;
  }

  /** Throws while vault.json can't be read: it's never written over then. */
  private readable(): void {
    const problem = this.problem();
    if (problem != null) throw new VaultError(`${problem} Nothing was changed, and the file is left as it is.`);
  }

  /** safeStorage can seal here (on Linux, with a real keyring). */
  available(): boolean {
    try {
      return this.sealer.isEncryptionAvailable() && this.sealer.getSelectedStorageBackend?.() !== "basic_text";
    } catch {
      return false;
    }
  }

  /** The items (none while vault.json can't be read: `problem()` says why). */
  list(): VaultItemSummary[] {
    if (this.problem() != null) return [];
    return this.items.map(summary).sort((a, b) => a.kind.localeCompare(b.kind) || vaultItemLabel(a).localeCompare(vaultItemLabel(b)));
  }

  get(id: string): VaultItemSummary | null {
    this.readable();
    const item = this.items.find((candidate) => candidate.id === id);
    return item != null ? summary(item) : null;
  }

  /** The item for the Settings form: every value but the password, which only ever goes to a page. */
  draft(id: string): VaultItemDraft {
    this.readable();
    const item = this.require(id);
    const values: Record<string, string> = {};
    for (const field of Object.keys(item.sealed)) if (field !== "password") values[field] = this.unseal(item, field);
    return { id: item.id, kind: item.kind, title: item.title, site: item.site ?? "", values, hasPassword: item.sealed.password != null };
  }

  async save(input: VaultItemInput): Promise<VaultItemSummary> {
    this.readable();
    if (!this.available()) throw new VaultError("This computer's secure storage isn't available, so the vault can't keep anything new.");
    const existing = input.id != null ? this.require(input.id) : null;
    if (existing != null && existing.kind !== input.kind) throw new VaultError("An item can't change from a login to contact info.");
    const fields: readonly string[] = input.kind === "login" ? LOGIN_FIELDS : CONTACT_FIELDS;
    const unknown = Object.keys(input.values).filter((field) => !fields.includes(field));
    if (unknown.length > 0) throw new VaultError(`${input.kind === "login" ? "A login" : "Contact info"} has no ${unknown.join(", ")} field.`);
    const title = input.title.trim().slice(0, 120);
    if (containsPaymentCard(title) || containsPaymentCard(input.values.notes ?? "")) throw new VaultError("That looks like a payment card number. The vault doesn't keep cards.");
    for (const [field, value] of Object.entries(input.values)) if (value.length > MAX_VALUE) throw new VaultError(`${FIELD_LABELS[field as ContactField] ?? field} is too long.`);

    const sealed: Record<string, string> = {};
    for (const field of fields) {
      const value = field === "notes" || field === "street" || field === "password" ? (input.values[field] ?? "") : (input.values[field] ?? "").trim();
      if (value.length > 0) sealed[field] = this.sealer.encryptString(value).toString("base64");
      else if (field === "password" && existing?.sealed.password != null) sealed.password = existing.sealed.password;
    }
    let site: string | null = null;
    if (input.kind === "login") {
      site = normalizeSite(input.site ?? "");
      if (site == null) throw new VaultError("A login needs the site it's for, like shop.example or https://shop.example.");
      if (sealed.username == null && sealed.password == null) throw new VaultError("A login needs a username or a password.");
    } else if (Object.keys(sealed).length === 0) throw new VaultError("Fill in at least one field.");
    if (existing == null && this.items.length >= MAX_ITEMS) throw new VaultError(`The vault holds ${MAX_ITEMS} items at most.`);

    const now = Date.now();
    const hintFrom = input.kind === "login" ? (input.values.username ?? "") : (input.values.email ?? "") || (input.values.name ?? "");
    const item: StoredItem = { id: existing?.id ?? newId(), kind: input.kind, title, site, hint: maskHint(hintFrom), sealed, createdAt: existing?.createdAt ?? now, updatedAt: now };
    this.items = existing != null ? this.items.map((candidate) => (candidate === existing ? item : candidate)) : [...this.items, item];
    await this.write();
    return summary(item);
  }

  async remove(id: string): Promise<VaultItemSummary> {
    const item = this.require(id);
    this.items = this.items.filter((candidate) => candidate !== item);
    await this.write();
    return summary(item);
  }

  /** Logins from a password export: a login for the same site and username is updated. */
  async importLogins(parsed: ParsedExport): Promise<VaultImportResult> {
    this.readable();
    if (!this.available()) throw new VaultError("This computer's secure storage isn't available, so the vault can't keep anything new.");
    const result: VaultImportResult = { format: parsed.format, added: 0, updated: 0, unchanged: 0, skipped: parsed.skipped, notesDropped: 0 };
    const now = Date.now();
    for (const login of parsed.logins) {
      const notes = containsPaymentCard(login.notes) ? "" : login.notes;
      if (notes !== login.notes) result.notesDropped++;
      const existing = this.items.find((item) => item.kind === "login" && item.site === login.site && this.unsealOrNull(item, "username") === login.username);
      if (existing != null) {
        if (this.unsealOrNull(existing, "password") === login.password && (this.unsealOrNull(existing, "notes") ?? "") === notes) {
          result.unchanged++;
          continue;
        }
        existing.sealed.password = this.seal(login.password);
        if (notes.length > 0) existing.sealed.notes = this.seal(notes);
        else delete existing.sealed.notes;
        existing.updatedAt = now;
        result.updated++;
        continue;
      }
      if (this.items.length >= MAX_ITEMS) {
        result.skipped++;
        continue;
      }
      const sealed: Record<string, string> = { password: this.seal(login.password) };
      if (login.username.length > 0) sealed.username = this.seal(login.username);
      if (notes.length > 0) sealed.notes = this.seal(notes);
      this.items.push({ id: newId(), kind: "login", title: login.title, site: login.site, hint: maskHint(login.username), sealed, createdAt: now, updatedAt: now });
      result.added++;
    }
    await this.write();
    return result;
  }

  /** The values of `fields`, for a fill only (VaultFiller). Never logged, returned to an edge or stored elsewhere. */
  reveal(id: string, fields: string[]): Record<string, string> {
    const item = this.require(id);
    const values: Record<string, string> = {};
    for (const field of fields) if (item.sealed[field] != null) values[field] = this.unseal(item, field);
    return values;
  }

  private require(id: string): StoredItem {
    this.readable();
    const item = this.items.find((candidate) => candidate.id === id);
    if (item == null) throw new VaultError(`There's no vault item ${id.slice(0, 40)}. List them with vault_list.`);
    return item;
  }

  private seal(value: string): string {
    return this.sealer.encryptString(value).toString("base64");
  }

  private unseal(item: StoredItem, field: string): string {
    try {
      return this.sealer.decryptString(Buffer.from(item.sealed[field], "base64"));
    } catch {
      throw new VaultError(`${vaultItemLabel(item)} can't be unsealed on this PC (it was saved under another account, or vault.json was changed).`);
    }
  }

  private unsealOrNull(item: StoredItem, field: string): string | null {
    if (item.sealed[field] == null) return null;
    try {
      return this.sealer.decryptString(Buffer.from(item.sealed[field], "base64"));
    } catch {
      return null;
    }
  }

  private write(): Promise<void> {
    if (this.unreadable != null) return Promise.reject(new VaultError(`${this.unreadable} Nothing was changed, and the file is left as it is.`));
    return writeFileAtomic(this.file, JSON.stringify({ version: 1, items: this.items }), 0o600);
  }
}

function summary(item: StoredItem): VaultItemSummary {
  const fields: readonly string[] = item.kind === "login" ? LOGIN_FIELDS : CONTACT_FIELDS;
  return { id: item.id, kind: item.kind, title: item.title, site: item.site, hint: item.hint, fields: fields.filter((field) => item.sealed[field] != null), createdAt: item.createdAt, updatedAt: item.updatedAt };
}

const newId = () => `v${randomBytes(6).toString("hex")}`;

// ---- the audit log ----------------------------------------------------------------------------

export type VaultAuditEvent = "fill" | "fill-refused" | "added" | "edited" | "deleted" | "imported";

export interface VaultAuditEntry {
  event: VaultAuditEvent;
  itemId?: string;
  label?: string;
  site?: string;
  fields?: string[];
  agentId?: string;
  count?: number;
  reason?: string;
}

export interface VaultAuditRecord extends VaultAuditEntry {
  seq: number;
  at: string;
  prev: string;
  hash: string;
}

const GENESIS = "0".repeat(64);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Checks a `vault-audit.jsonl`: every line's hash is of the line itself (without it), and names the line before. */
export function verifyAuditChain(text: string): { ok: boolean; records: VaultAuditRecord[]; brokenAt: number | null } {
  const records: VaultAuditRecord[] = [];
  let prev = GENESIS;
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  for (let index = 0; index < lines.length; index++) {
    let record: VaultAuditRecord;
    try {
      record = JSON.parse(lines[index]);
    } catch {
      return { ok: false, records, brokenAt: index + 1 };
    }
    const { hash, ...body } = record;
    if (body.prev !== prev || body.seq !== index + 1 || sha256(JSON.stringify(body)) !== hash) return { ok: false, records, brokenAt: index + 1 };
    records.push(record);
    prev = hash;
  }
  return { ok: true, records, brokenAt: null };
}

export class VaultAudit {
  private last: { seq: number; hash: string } | null = null;

  constructor(readonly file: string) {}

  append(entry: VaultAuditEntry): VaultAuditRecord {
    const last = this.last ?? this.tail();
    const body = { seq: last.seq + 1, at: new Date().toISOString(), ...entry, prev: last.hash };
    const hash = sha256(JSON.stringify(body));
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify({ ...body, hash })}\n`, { mode: 0o600 });
    this.last = { seq: body.seq, hash };
    return { ...body, hash };
  }

  view(limit = 10): VaultAuditView {
    const { ok, records, brokenAt } = verifyAuditChain(this.read());
    const recent = records
      .filter((record) => record.event === "fill")
      .slice(-limit)
      .reverse()
      .map((record) => ({ at: record.at, label: record.label ?? "", site: record.site ?? "", fields: record.fields ?? [], agentId: record.agentId ?? "" }));
    return { ok, entries: ok ? records.length : (brokenAt ?? 1) - 1, brokenAt, recent };
  }

  private read(): string {
    try {
      return readFileSync(this.file, "utf8");
    } catch {
      return "";
    }
  }

  /** The last line, which the next one chains onto (even when an earlier line was tampered with). */
  private tail(): { seq: number; hash: string } {
    const lines = this.read()
      .split("\n")
      .filter((line) => line.trim().length > 0);
    try {
      const record = JSON.parse(lines[lines.length - 1]) as VaultAuditRecord;
      if (typeof record.hash === "string" && Number.isInteger(record.seq)) return { seq: record.seq, hash: record.hash };
    } catch {
      // empty or unreadable: start a chain
    }
    return { seq: 0, hash: GENESIS };
  }
}

// ---- filling ----------------------------------------------------------------------------------

/** A field the browser found behind a ref, and where it lives. */
export interface VaultField extends BrowserTarget {
  /** The element is in the page's own document (not in a frame). */
  inPage: boolean;
  /** Its document's origin. */
  origin: string;
}

export interface VaultFill {
  ref: string;
  value: string;
  /** A password: only into a password field. */
  password: boolean;
}

/** What the vault needs from the agent browser (src/main/agent-browser.ts implements it). */
export interface VaultBrowser {
  /** The agent's current page as the DevTools protocol reports it; site is null unless it's an http(s) page whose origins agree. */
  page(agentId: string): Promise<{ url: string; site: string | null } | null>;
  fields(agentId: string, refs: string[]): Promise<Map<string, VaultField>>;
  /** Fills in the page, in the agent's turn; `stillOn` re-checks the page before each field. Never throws after a field is filled. */
  fill(agentId: string, fills: VaultFill[], options: { site: string; submit: boolean; callId: string; stillOn(url: string): boolean }): Promise<{ filled: number; submitted: boolean; navigated: boolean; error: string | null }>;
  /** Text from the page with the vault values the agent's window holds blanked. */
  scrub(agentId: string, text: string): string;
}

export interface VaultFillerDeps {
  vault: Vault;
  audit: VaultAudit;
  browser: VaultBrowser;
  /** Spends, once, the user's Allow once on this PC for a card that named `subject`; false if there's none. */
  spendApproval(approvalId: string, subject: string): boolean;
}

export interface VaultFillCall {
  agentId: string;
  itemId: string;
  fields: Record<string, string>;
  submit: boolean;
}

/** The stored fields a fill key reads. */
function sourceField(key: VaultFillKey): string {
  if (key === "given_name" || key === "family_name") return "name";
  if (key === "address_line1" || key === "address_line2") return "street";
  return key;
}

const passwordField = (field: BrowserTarget) => field.inputType === "password" || /\b(current|new)-password\b/.test(field.autocomplete);
/** Fields a value fills: text-like inputs (a date or color picker draws its value in parts snapshots would show), text areas, dropdowns. */
export const FILLABLE_INPUT_TYPES = ["", "text", "email", "tel", "password", "search", "url", "number"];
export const fillable = (field: Pick<BrowserTarget, "tag" | "inputType" | "editable">) => field.editable && (field.tag === "textarea" || field.tag === "select" || (field.tag === "input" && FILLABLE_INPUT_TYPES.includes(field.inputType)));

export class VaultFiller {
  constructor(private readonly deps: VaultFillerDeps) {}

  /** vault_list: labels, never values; which items fit the agent's page. */
  async list(agentId: string): Promise<VaultListReply> {
    const problem = this.deps.vault.problem();
    if (problem != null) throw new VaultError(`The vault can't be read right now: ${problem} The user can see it in Settings → Vault.`);
    const page = await this.deps.browser.page(agentId).catch(() => null);
    const pageSite = page?.site ?? null;
    return {
      pageSite,
      items: this.deps.vault.list().map((item) => ({
        id: item.id,
        kind: item.kind,
        label: vaultItemLabel(item),
        site: item.site,
        fields: item.fields.filter((field) => field !== "notes"),
        matchesPage: page != null && pageSite != null && (item.site == null || vaultSiteMatches(item.site, page.url)),
      })),
    };
  }

  /** What a fill would do, from the page and the vault; throws (value-free) when it can't be done. */
  async plan(call: VaultFillCall): Promise<VaultPlanInfo> {
    const item = this.deps.vault.get(call.itemId);
    if (item == null) throw new VaultError(`There's no vault item ${call.itemId.slice(0, 40)}. List them with vault_list.`);
    const label = vaultItemLabel(item);
    const page = await this.deps.browser.page(call.agentId);
    if (page == null) throw new VaultError("The agent browser has no page open. Open the site's page with browser_navigate first.");
    if (page.site == null) throw new VaultError("The page in the agent browser isn't a web page this can fill (only http and https pages).");
    if (item.kind === "login" && (item.site == null || !vaultSiteMatches(item.site, page.url))) {
      const reason = `the page is on ${siteLabel(page.site)}`;
      this.deps.audit.append({ event: "fill-refused", itemId: item.id, label, site: page.site, agentId: call.agentId, reason });
      throw new VaultError(`${label} is for ${siteLabel(item.site)}, and ${reason}, so nothing was filled. A login only fills on its own site.`);
    }

    const allowed: readonly string[] = item.kind === "login" ? LOGIN_FILL_KEYS : CONTACT_FILL_KEYS;
    const wanted = Object.entries(call.fields);
    if (wanted.length === 0) throw new VaultError("Name at least one field to fill, like {\"username\": \"e3\", \"password\": \"e5\"}.");
    const refs = new Set<string>();
    for (const [key, ref] of wanted) {
      if (!allowed.includes(key)) throw new VaultError(`${item.kind === "login" ? "A login" : "Contact info"} doesn't fill ${key}; it fills ${allowed.join(", ")}.`);
      if (typeof ref !== "string" || ref.length === 0) throw new VaultError(`Give ${key} the ref of a field from browser_snapshot.`);
      if (refs.has(ref)) throw new VaultError(`${ref} is named twice; each field takes one value.`);
      refs.add(ref);
      if (!item.fields.includes(sourceField(key as VaultFillKey))) throw new VaultError(`${label} has no ${FIELD_LABELS[key as VaultFillKey].toLowerCase()} saved.`);
    }

    const found = await this.deps.browser.fields(call.agentId, [...refs]);
    // A field's label is the page's and goes on the card and into errors, so neither this item's
    // values (a password step that names the email) nor ones the window holds come with it.
    const own = Object.values(this.deps.vault.reveal(item.id, item.fields));
    const describe = (field: VaultField) => this.deps.browser.scrub(call.agentId, scrubValues(describeTarget(field), own));
    const fields: VaultPlanInfo["fields"] = [];
    for (const [key, ref] of wanted) {
      const field = found.get(ref);
      if (field == null) throw new VaultError(`${ref} isn't a ref on this page. Take a snapshot (browser_snapshot) first.`);
      const what = `${ref} (${describe(field)})`;
      // A frame's field isn't the page's own, even a frame from the page's origin (another document, another address).
      if (!field.inPage) throw new VaultError(`${what} is inside a frame, and the vault fills only the page's own fields, so nothing is filled into it.`);
      if (field.origin !== page.site) throw new VaultError(`${what} is in a document from another site, so nothing is filled into it.`);
      if (!fillable(field)) throw new VaultError(`${what} isn't a text field.`);
      const secret = sensitiveField(field);
      if (secret === "payment card" || secret === "one-time code") throw new VaultError(`${what} is a ${secret} field; the vault doesn't fill those.`);
      if (key === "password" && !passwordField(field)) throw new VaultError(`${what} isn't a password field; a password only fills into one.`);
      if (key !== "password" && passwordField(field)) throw new VaultError(`${what} is a password field; only a login's password fills into one.`);
      if (field.tag === "select" && item.kind === "login") throw new VaultError(`${what} is a dropdown; a login fills text fields.`);
      fields.push({ key: key as VaultFillKey, ref, element: describe(field), secret: key === "password" });
    }
    return { itemId: item.id, kind: item.kind, label, site: page.site, subject: `vault:${call.agentId}/${item.id}@${page.site}`, fields, submit: call.submit };
  }

  /** request_credential, once the user allowed it on this PC: checks everything again, then fills. */
  async fill(call: VaultFillCall & { expectSite: string | null; approvalId: string | null; callId: string }): Promise<VaultFillReply> {
    const plan = await this.plan(call);
    if (call.expectSite == null || plan.site !== call.expectSite) {
      throw new VaultError(`The page is on ${siteLabel(plan.site)} now, not ${siteLabel(call.expectSite)} as when you were asked, so nothing was filled.`);
    }
    if (call.approvalId == null || !this.deps.spendApproval(call.approvalId, plan.subject)) throw new VaultError("This fill wasn't allowed in the app on this computer, so nothing was filled.");

    const item = this.deps.vault.get(plan.itemId)!;
    const stored = this.deps.vault.reveal(item.id, [...new Set(plan.fields.map((field) => sourceField(field.key)))]);
    const fills: VaultFill[] = [];
    const keys: string[] = [];
    for (const field of plan.fields) {
      const value = item.kind === "login" ? (stored[field.key] ?? "") : contactFillValue(stored, field.key);
      if (value.length === 0) continue;
      fills.push({ ref: field.ref, value, password: field.secret });
      keys.push(field.key);
    }
    if (fills.length === 0) throw new VaultError(`${plan.label} has nothing to put in those fields.`);
    const stillOn = (url: string) => siteOf(url) === plan.site && (item.site == null || vaultSiteMatches(item.site, url));
    const result = await this.deps.browser.fill(call.agentId, fills, { site: plan.site, submit: plan.submit, callId: call.callId, stillOn });
    const filledKeys = keys.slice(0, result.filled);
    if (result.filled > 0) this.deps.audit.append({ event: "fill", itemId: item.id, label: plan.label, site: plan.site, fields: filledKeys, agentId: call.agentId });
    const site = siteLabel(plan.site);
    const count = `${result.filled} field${result.filled === 1 ? "" : "s"}`;
    if (result.error != null) return { output: result.filled > 0 ? `Filled ${count} on ${site} (${filledKeys.join(", ")}), then stopped: ${result.error}` : `Nothing was filled: ${result.error}` };
    const submitted = result.submitted ? (result.navigated ? " and pressed Enter; the page changed" : " and pressed Enter") : "";
    return { output: `Filled ${count} on ${site} (${filledKeys.join(", ")}) from ${plan.label}${submitted}. You don't see the values: snapshots show these fields as filled from the vault, and screenshots cover them. Take a snapshot to see the page.` };
  }
}
