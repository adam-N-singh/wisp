// The vault (README "Vault"): logins and contact info kept on the user's PC, which agents fill
// into their agent browser without ever seeing a value. Main keeps the items, each value sealed
// with safeStorage (src/main/vault.ts), and fills them over the DevTools protocol
// (src/main/agent-browser.ts); the daemon offers the tools (src/local-exec/vault-tools.ts) and
// asks the user on this PC before every fill. What all sides share lives here: the tool names,
// the fields an item has and fills, how an item reads to the model (metadata only), and which
// page a login belongs to.
import { checkBrowserUrl, siteLabel } from "./agent-browser";

export const VAULT_TOOL_NAMES = ["vault_list", "request_credential"] as const;
/** The permission both tools use (Settings → Permissions); its cards are drawn as credential requests. */
export const VAULT_PERMISSION_ID = "vault";

export type VaultItemKind = "login" | "contact";

/** What a login keeps. The site is metadata (it decides where the login fills); the rest is sealed. */
export const LOGIN_FIELDS = ["username", "password", "notes"] as const;
/** What contact info keeps, all sealed. */
export const CONTACT_FIELDS = ["name", "email", "phone", "street", "city", "region", "postal_code", "country"] as const;
export type LoginField = (typeof LOGIN_FIELDS)[number];
export type ContactField = (typeof CONTACT_FIELDS)[number];

/** Fields request_credential fills, by item kind. Contact info also fills parts of its name and street. */
export const LOGIN_FILL_KEYS = ["username", "password"] as const;
export const CONTACT_FILL_KEYS = ["name", "given_name", "family_name", "email", "phone", "street", "address_line1", "address_line2", "city", "region", "postal_code", "country"] as const;
export type VaultFillKey = (typeof LOGIN_FILL_KEYS)[number] | (typeof CONTACT_FILL_KEYS)[number];
export const VAULT_FILL_KEYS: readonly VaultFillKey[] = [...LOGIN_FILL_KEYS, ...CONTACT_FILL_KEYS];

export const FIELD_LABELS: Record<LoginField | ContactField | VaultFillKey, string> = {
  username: "Username",
  password: "Password",
  notes: "Notes",
  name: "Name",
  given_name: "First name",
  family_name: "Last name",
  email: "Email",
  phone: "Phone",
  street: "Street address",
  address_line1: "Address line 1",
  address_line2: "Address line 2",
  city: "City",
  region: "State or region",
  postal_code: "Postal code",
  country: "Country",
};

/** An item as the app lists it, and as the model sees it: never a value. */
export interface VaultItemSummary {
  id: string;
  kind: VaultItemKind;
  /** The user's own name for it ("Home", "Work"); "" when they gave none. */
  title: string;
  /** A login's site, as an origin ("https://shop.example"); null for contact info, which fills anywhere (asking each time). */
  site: string | null;
  /** A masked username or email ("j…@gmail.com"); "" when there's none. */
  hint: string;
  /** The fields it has values for. */
  fields: string[];
  createdAt: number;
  updatedAt: number;
}

/** An item as the Settings form edits it: every value but the password, which never leaves main. */
export interface VaultItemDraft {
  id: string | null;
  kind: VaultItemKind;
  title: string;
  site: string;
  values: Record<string, string>;
  hasPassword: boolean;
}

export interface VaultAuditView {
  /** The hash chain checks out from the first line to the last. */
  ok: boolean;
  entries: number;
  /** The line where the chain breaks (1-based), when it does. */
  brokenAt: number | null;
  /** The latest fills, newest first. */
  recent: Array<{ at: string; label: string; site: string; fields: string[]; agentId: string }>;
}

export interface VaultView {
  /** safeStorage can seal values on this PC; without it nothing new is saved. */
  available: boolean;
  /** Why vault.json can't be read (locked, not JSON, another version's); nothing is written over it meanwhile. */
  problem: string | null;
  items: VaultItemSummary[];
  audit: VaultAuditView;
}

export interface VaultImportResult {
  format: "chrome" | "firefox";
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
  /** Notes left out because they looked like a payment card number (cards aren't kept). */
  notesDropped: number;
}

/** What vault_list tells the daemon: items as the model may see them, and the agent's page. */
export interface VaultListReply {
  /** The site of the page open in the agent's browser, if any. */
  pageSite: string | null;
  items: Array<{ id: string; kind: VaultItemKind; label: string; site: string | null; fields: string[]; matchesPage: boolean }>;
}

/** What main found for a fill, before the user is asked: all from the page and the vault, none from the model. */
export interface VaultPlanInfo {
  itemId: string;
  kind: VaultItemKind;
  label: string;
  /** The page's real origin, read over the DevTools protocol. */
  site: string;
  /** "vault:<agent>/<item>@<origin>": the approval names it, and main checks it before filling. */
  subject: string;
  fields: Array<{ key: VaultFillKey; ref: string; element: string; secret: boolean }>;
  submit: boolean;
}

export interface VaultFillReply {
  output: string;
}

/** "Login for shop.example (j…@gmail.com)", "Contact info “Home” (j…@example.com)": how an item reads, value-free. */
export function vaultItemLabel(item: Pick<VaultItemSummary, "kind" | "title" | "site" | "hint">): string {
  const hint = item.hint.length > 0 ? ` (${item.hint})` : "";
  if (item.kind === "login") return `Login for ${item.title.length > 0 ? `${item.title} on ` : ""}${siteLabel(item.site)}${hint}`;
  return `Contact info${item.title.length > 0 ? ` “${item.title}”` : ""}${hint}`;
}

/** "j…@gmail.com" for an email, "j…e" for a name; enough to tell two items apart, not to use. */
export function maskHint(text: string): string {
  const value = text.trim();
  if (value.length === 0) return "";
  const at = value.lastIndexOf("@");
  if (at > 0) return `${[...value.slice(0, at)][0]}…${value.slice(at)}`.slice(0, 80);
  const chars = [...value];
  return chars.length <= 2 ? "…" : `${chars[0]}…${chars[chars.length - 1]}`;
}

/** A login's site as an origin: "shop.example" and "https://shop.example/login?x" both become "https://shop.example". */
export function normalizeSite(raw: string): string | null {
  const checked = checkBrowserUrl(raw);
  if (!checked.ok || checked.url === "about:blank") return null;
  try {
    const url = new URL(checked.url);
    return url.hostname.length > 0 ? url.origin : null;
  } catch {
    return null;
  }
}

const IP_OR_LOCAL = /^(localhost|\d+\.\d+\.\d+\.\d+|\[[0-9a-f:]+\])$/i;

/**
 * Whether a login saved for `site` fills on a page at `pageUrl`. Strict: the same host (or the same
 * host with or without "www."), the same port, and never from https down to http (an http login
 * fills on the https page too). Not other subdomains: a login for shop.example doesn't fill on
 * accounts.shop.example until the user saves it for that site.
 */
export function vaultSiteMatches(site: string, pageUrl: string): boolean {
  let saved: URL;
  let page: URL;
  try {
    saved = new URL(site);
    page = new URL(pageUrl);
  } catch {
    return false;
  }
  if (page.protocol !== "http:" && page.protocol !== "https:") return false;
  if (saved.protocol !== "http:" && saved.protocol !== "https:") return false;
  if (saved.protocol === "https:" && page.protocol !== "https:") return false;
  if (saved.port !== page.port) return false;
  const savedHost = saved.hostname.toLowerCase();
  const pageHost = page.hostname.toLowerCase();
  if (savedHost === pageHost) return true;
  if (IP_OR_LOCAL.test(savedHost) || IP_OR_LOCAL.test(pageHost)) return false;
  return savedHost === `www.${pageHost}` || pageHost === `www.${savedHost}`;
}

/** A run of 13–19 digits (spaces and dashes allowed) that passes the Luhn check: a payment card number. */
export function containsPaymentCard(text: string): boolean {
  for (const match of text.matchAll(/(?:\d[ -]?){12,18}\d/g)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let index = 0; index < digits.length; index++) {
      let digit = Number(digits[digits.length - 1 - index]);
      if (index % 2 === 1) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/** The value a fill key takes from contact info: parts of the name and street are split off it. */
export function contactFillValue(values: Partial<Record<ContactField, string>>, key: VaultFillKey): string {
  const name = (values.name ?? "").trim();
  const words = name.split(/\s+/).filter((word) => word.length > 0);
  const lines = (values.street ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  switch (key) {
    case "given_name":
      return words.length > 1 ? words.slice(0, -1).join(" ") : name;
    case "family_name":
      return words.length > 1 ? words[words.length - 1] : "";
    case "street":
      return lines.join(", ");
    case "address_line1":
      return lines[0] ?? "";
    case "address_line2":
      return lines.slice(1).join(", ");
    default:
      return (values[key as ContactField] ?? "").trim();
  }
}
