// Password exports the user makes themselves, for the vault's CSV import (Settings → Vault):
// Chrome and Edge ("name,url,username,password[,note]") and Firefox ("url,username,password,
// httpRealm,formActionOrigin,guid,…"). Only a file the user picks is read, on this PC; no browser's
// or password manager's own store is ever opened. Pure, so it's unit-tested.
import { normalizeSite } from "../shared/vault";

export const CSV_MAX_BYTES = 5 * 1024 * 1024;
export const CSV_MAX_ROWS = 10_000;

export interface ImportedLogin {
  site: string;
  title: string;
  username: string;
  password: string;
  notes: string;
}

export interface ParsedExport {
  format: "chrome" | "firefox";
  logins: ImportedLogin[];
  /** Rows without a web address or a password (app logins, blank rows). */
  skipped: number;
}

/** RFC 4180: quoted fields with "" for a quote, and line breaks inside quotes; CRLF, LF or CR rows. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = () => {
    row.push(field);
    field = "";
    if (row.length > 1 || row[0].length > 0) rows.push(row);
    row = [];
  };
  for (; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = false;
    } else if (char === '"' && field.length === 0) quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      endRow();
    } else field += char;
  }
  if (quoted) throw new Error("The file ends inside a quoted field, so it isn't a complete CSV export.");
  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}

/** The logins in a Chrome, Edge or Firefox password export; throws for anything else. */
export function parsePasswordExport(text: string): ParsedExport {
  const rows = parseCsv(text);
  if (rows.length > CSV_MAX_ROWS + 1) throw new Error(`The file has more than ${CSV_MAX_ROWS} rows.`);
  const header = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase());
  const column = (...names: string[]) => header.findIndex((cell) => names.includes(cell));
  const url = column("url");
  const username = column("username");
  const password = column("password");
  if (url < 0 || username < 0 || password < 0) throw new Error("This isn't a password export from Chrome, Edge or Firefox (it needs url, username and password columns).");
  const format = header.includes("httprealm") || header.includes("guid") ? "firefox" : "chrome";
  const name = column("name");
  const note = column("note", "notes");
  const logins: ImportedLogin[] = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const site = normalizeSite((row[url] ?? "").trim());
    const secret = row[password] ?? "";
    // App logins (android://…), empty passwords and blank lines aren't for the agent browser.
    if (site == null || !/^https?:/.test(site) || secret.length === 0) {
      skipped++;
      continue;
    }
    // Chrome names a login after its host, which the label already says.
    const title = name >= 0 ? (row[name] ?? "").trim().slice(0, 120) : "";
    const host = new URL(site).hostname.replace(/^www\./, "");
    logins.push({ site, title: title.replace(/^www\./i, "").toLowerCase() === host ? "" : title, username: (row[username] ?? "").slice(0, 1000), password: secret.slice(0, 4000), notes: note >= 0 ? (row[note] ?? "").slice(0, 10_000) : "" });
  }
  return { format, logins, skipped };
}
