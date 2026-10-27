// The Connect Apps catalog (readAppCatalog / connectCatalogApp): well-known remote MCP
// servers, kept as data in mcp-catalog.json so an app is easy to add. Each app names its server's
// Streamable HTTP address and how it connects:
//   oauth  a browser sign-in (MCP authorization with dynamic client registration, src/main/mcp-auth.ts)
//   token  a token or key the user pastes, sent in a header
//   none   nothing
// `{key}` in the address, a query parameter or a header is replaced by the field the user filled
// in; a query parameter or header whose fields are all empty is left out.
import type { McpCatalogEntry, McpCatalogField } from "../shared/model";
import { normalizeMcpUrl } from "./mcp";
import catalogFile from "./mcp-catalog.json";

export interface CatalogApp {
  id: string;
  name: string;
  publisher: string;
  category: string;
  description: string;
  url: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  auth: "oauth" | "token" | "none";
  fields?: Array<{ key: string; label: string; secret?: boolean; required?: boolean; placeholder?: string; hint?: string; hintUrl?: string }>;
  website: string;
  docs: string;
  color: string;
  /** One or two letters; the name's first letter otherwise. */
  monogram?: string;
  featured?: boolean;
}

export interface CatalogFile {
  categories: Array<{ key: string; label: string }>;
  apps: CatalogApp[];
}

export const MCP_CATALOG = catalogFile as CatalogFile;

const PLACEHOLDER = /\{([a-z][a-zA-Z0-9_]*)\}/g;
const MAX_VALUE_LENGTH = 4000;

/** Field keys a template uses. */
const placeholders = (template: string) => [...template.matchAll(PLACEHOLDER)].map((match) => match[1]);

export class CatalogError extends Error {}

/** The apps as the gallery shows them: by category, then in the file's order. */
export function mcpCatalog(file: CatalogFile = MCP_CATALOG): McpCatalogEntry[] {
  const categories = new Map(file.categories.map((category, index) => [category.key, { label: category.label, index }]));
  return file.apps
    .map((app, index): McpCatalogEntry => ({
      id: app.id,
      displayName: app.name,
      description: app.description,
      category: categories.get(app.category)?.label ?? app.category,
      categoryKey: app.category,
      publisher: { name: app.publisher.toLowerCase().replace(/[^a-z0-9]+/g, "-"), displayName: app.publisher, isUserOwned: false },
      websiteUrl: app.website,
      popularityRank: index,
      ...(app.fields != null && app.fields.length > 0 ? { fields: app.fields.map(catalogField) } : {}),
      docsUrl: app.docs,
      url: app.url,
      auth: app.auth,
      featured: app.featured === true,
      monogram: app.monogram ?? app.name.slice(0, 1).toUpperCase(),
      color: app.color,
    }))
    .sort((a, b) => (categories.get(a.categoryKey)?.index ?? 0) - (categories.get(b.categoryKey)?.index ?? 0) || a.popularityRank - b.popularityRank);
}

function catalogField(field: NonNullable<CatalogApp["fields"]>[number]): McpCatalogField {
  return {
    key: field.key,
    label: field.label,
    type: "string",
    ...(field.secret === true ? { isSecret: true } : {}),
    ...(field.required === true ? { isRequired: true } : {}),
    ...(field.placeholder != null ? { placeholder: field.placeholder } : {}),
    ...(field.hint != null ? { hint: field.hint } : {}),
    ...(field.hintUrl != null ? { hintUrl: field.hintUrl } : {}),
  };
}

export function catalogApp(id: string, file: CatalogFile = MCP_CATALOG): CatalogApp | undefined {
  return file.apps.find((app) => app.id === id);
}

/** The server's address and headers with the user's values filled in. */
export function catalogServer(app: CatalogApp, values: Record<string, string | number | boolean>): { url: string; headers: Record<string, string> } {
  const fields = app.fields ?? [];
  const filled: Record<string, string> = {};
  for (const [key, raw] of Object.entries(values)) {
    const field = fields.find((candidate) => candidate.key === key);
    if (field == null) throw new CatalogError(`${app.name} has no setting called “${key}”.`);
    const value = String(raw).trim();
    if (value.length > MAX_VALUE_LENGTH) throw new CatalogError(`${field.label} is too long.`);
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new CatalogError(`${field.label} can't contain line breaks or control characters.`);
    filled[key] = value;
  }
  for (const field of fields) {
    if (field.required === true && (filled[field.key] ?? "") === "") throw new CatalogError(`${app.name} needs ${field.label.toLowerCase()}.`);
  }
  const expand = (template: string, encode: (value: string) => string) => template.replace(PLACEHOLDER, (_, key: string) => encode(filled[key] ?? ""));
  /** A template that names fields is left out when all of them are empty. */
  const kept = (template: string) => {
    const keys = placeholders(template);
    return keys.length === 0 || keys.some((key) => (filled[key] ?? "") !== "");
  };

  const url = new URL(normalizeMcpUrl(expand(app.url, encodeURIComponent)));
  for (const [name, template] of Object.entries(app.query ?? {})) if (kept(template)) url.searchParams.set(name, expand(template, (value) => value));
  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(app.headers ?? {})) if (kept(template)) headers[name] = expand(template, (value) => value);
  return { url: url.href, headers };
}

/** What's wrong with the catalog's data, one line per problem (the unit tests keep this empty). */
export function catalogProblems(file: CatalogFile = MCP_CATALOG): string[] {
  const problems: string[] = [];
  const categories = new Set(file.categories.map((category) => category.key));
  if (categories.size !== file.categories.length) problems.push("Category keys repeat.");
  const ids = new Set<string>();
  const https = (value: string) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  };
  for (const app of file.apps) {
    const say = (problem: string) => problems.push(`${app.id}: ${problem}`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(app.id) || app.id.length > 24) say("the id must be lowercase letters, digits and dashes, at most 24 characters.");
    if (ids.has(app.id)) say("the id repeats.");
    ids.add(app.id);
    if (app.name.trim().length === 0 || app.name.length > 40) say("the name must be 1 to 40 characters.");
    if (app.publisher.trim().length === 0) say("the publisher is missing.");
    if (app.description.trim().length < 20 || app.description.length > 160) say("the description must be 20 to 160 characters.");
    if (!categories.has(app.category)) say(`the category “${app.category}” isn't listed.`);
    if (!["oauth", "token", "none"].includes(app.auth)) say(`auth must be oauth, token or none, not “${app.auth}”.`);
    if (!https(app.website) || !https(app.docs)) say("the website and docs must be https addresses.");
    if (!/^#[0-9a-f]{6}$/i.test(app.color)) say("the color must look like #1a2b3c.");
    if (app.monogram != null && !/^[\p{L}\p{N}]{1,2}$/u.test(app.monogram)) say("the monogram must be one or two letters.");

    const fields = app.fields ?? [];
    const keys = fields.map((field) => field.key);
    if (new Set(keys).size !== keys.length) say("field keys repeat.");
    for (const field of fields) {
      if (!/^[a-z][a-zA-Z0-9_]*$/.test(field.key)) say(`the field key “${field.key}” must start with a lowercase letter and use letters, digits and _.`);
      if (field.label.trim().length === 0) say(`the field “${field.key}” has no label.`);
      if (field.hintUrl != null && !https(field.hintUrl)) say(`the field “${field.key}” hint link must be an https address.`);
    }
    const templates = [app.url, ...Object.values(app.query ?? {}), ...Object.values(app.headers ?? {})];
    const used = new Set(templates.flatMap(placeholders));
    for (const key of used) if (!keys.includes(key)) say(`{${key}} isn't one of its fields.`);
    for (const key of keys) if (!used.has(key)) say(`the field “${key}” isn't used in the address, query or headers.`);
    for (const key of placeholders(app.url)) if (fields.find((field) => field.key === key)?.required !== true) say(`{${key}} in the address must be a required field.`);

    const authorization = Object.keys(app.headers ?? {}).some((name) => name.toLowerCase() === "authorization");
    if (app.auth === "oauth" && authorization) say("an Authorization header turns the sign-in off; use auth token.");
    if (app.auth === "token" && !fields.some((field) => field.required === true && field.secret === true && Object.values(app.headers ?? {}).some((template) => placeholders(template).includes(field.key)))) {
      say("token auth needs a required secret field sent in a header.");
    }
    try {
      const sample = Object.fromEntries(fields.map((field) => [field.key, "sample"]));
      catalogServer(app, sample);
    } catch (error) {
      say(`the address doesn't work: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}
