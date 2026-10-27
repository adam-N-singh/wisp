// Plugin marketplaces, in Claude Code's format
// (code.claude.com/docs/en/plugins/marketplace-reference), read over HTTPS with no git installed.
// A marketplace is a GitHub repository with .claude-plugin/marketplace.json, or an https link to
// such a file. A refresh downloads the repository's archive at its branch, tag or commit (GitHub's
// archive names its commit, which pins what was read), reads the marketplace file, and unpacks the
// folder of each plugin kept in the repository. A plugin kept in a repository of its own (a
// `github`, `url` or `git-subdir` source on GitHub) is fetched the same way when it's opened, and
// at each refresh once it's installed. What a plugin offers is read from its files: skills
// (skills/<name>/SKILL.md), MCP servers (.mcp.json) and .claude-plugin/plugin.json, or its
// marketplace entry when it has no plugin.json. Hooks, commands, subagents and the rest are listed
// as unsupported and never run.
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { visibleText } from "../shared/bot-template";
import { isPluginName, type PluginOption, type PluginServerSpec } from "../shared/marketplace";
import { isSecureEndpoint } from "../shared/mcp-oauth";
import { BASIC_ENV } from "./mcp";
import { fetchLimitedText, parseSkillFile, skillFromMarkdown } from "./skills";
import { ArchiveError, downloadFile, readTarGz, safeRelativePath } from "./tarball";

/** Where the box downloads repositories from; tests point it at a fake. */
export interface MarketplaceHosts {
  /** A repository's archive is `<github>/<owner>/<repo>/archive/<ref>.tar.gz`. */
  github: string;
}

export const GITHUB_HOSTS: MarketplaceHosts = { github: "https://github.com" };

export type MarketplaceSource = { kind: "github"; repo: string; ref: string | null } | { kind: "url"; url: string };

/** A marketplace as marketplaces.json keeps it. Its id is its name. */
export interface MarketplaceRecord {
  id: string;
  source: MarketplaceSource;
  addedAt: number;
  /** The last refresh that failed, and why; the index it read before still stands. */
  error: string | null;
}

/** Where a plugin's files are: a folder of the marketplace's repository ("" for its root), a GitHub repository, or a source the box can't fetch. */
export type PluginSource =
  | { kind: "repository"; path: string }
  | { kind: "github"; repo: string; path: string; ref: string | null; sha: string | null }
  | { kind: "unsupported"; reason: string };

export interface IndexedSkill {
  name: string;
  description: string;
  /** Its SKILL.md, from the plugin's folder. */
  path: string;
  /** Characters that don't show, taken out of what agents read. */
  hiddenCharacters?: number;
}

/**
 * A plugin's SKILL.md as agents read it and the review shows it: without the characters a model
 * reads but a reader doesn't see (visibleText, as bot templates are cleaned). A leading byte order
 * mark isn't counted.
 */
export function skillText(raw: string): { text: string; removed: number } {
  return visibleText(raw.replace(/^﻿/, ""));
}

/** A plugin as a refresh read it. */
export interface IndexedPlugin {
  name: string;
  /** Its marketplace entry as written: what it says applies when the plugin is read later. */
  entry: Record<string, unknown>;
  displayName: string;
  description: string;
  version: string | null;
  author: string | null;
  homepage: string | null;
  repository: string | null;
  license: string | null;
  category: string | null;
  keywords: string[];
  source: PluginSource;
  /**
   * Its files at `commit`, in `folder` under the marketplace's folder, and a hash of them (a new
   * marketplace commit that didn't touch them isn't an update); null until they're read.
   */
  files: { commit: string; folder: string; hash: string } | null;
  skills: IndexedSkill[];
  servers: PluginServerSpec[];
  options: PluginOption[];
  unsupported: string[];
  problems: string[];
  /** Why its files couldn't be fetched or read. */
  error: string | null;
}

/** What a refresh read: marketplaces/<id>/index.json. */
export interface MarketplaceIndex {
  schemaVersion: 1;
  name: string;
  displayName: string;
  description: string;
  owner: string | null;
  /** The repository's commit, or "sha256:<hex>" of a linked file. */
  commit: string;
  indexedAt: number;
  /** The folder under marketplaces/<id>/ holding the plugins' files. */
  snapshot: string;
  plugins: IndexedPlugin[];
  /** Entries that were skipped, one sentence each. */
  problems: string[];
}

export class MarketplaceError extends Error {}

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const COMMIT = /^[0-9a-f]{40}$/;
/** Limits on what one refresh unpacks, all plugins together. */
const MAX_FILES = 20_000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 256 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);

function githubSource(repo: string, ref: string | null): MarketplaceSource {
  const name = repo.replace(/\.git$/, "");
  if (!REPO.test(name) || name.includes("..")) throw new MarketplaceError(`“${repo}” isn’t a GitHub repository. Write it as owner/repo.`);
  if (ref != null && !isRef(ref)) throw new MarketplaceError(`“${ref}” isn’t a branch, tag or commit name.`);
  return { kind: "github", repo: name, ref: ref != null && ref.length > 0 ? ref : null };
}

const isRef = (ref: string) => ref.length > 0 && ref.length <= 200 && /^[\w./-]+$/.test(ref) && !ref.includes("..") && !ref.startsWith("/") && !ref.startsWith("-") && !ref.endsWith("/");

/**
 * What the user typed in Add marketplace: a GitHub repository (owner/repo, owner/repo@ref,
 * owner/repo#ref, its address, a …/tree/<branch> link, git@github.com:owner/repo.git, or the raw
 * address of its marketplace.json), or an https link to a marketplace.json anywhere else.
 */
export function parseMarketplaceSource(input: string): MarketplaceSource {
  const value = input.trim();
  const ssh = /^git@github\.com:([^\s#]+?)(?:\.git)?(?:#(\S+))?$/.exec(value);
  if (ssh != null) return githubSource(ssh[1], ssh[2] ?? null);
  if (!value.includes("://")) {
    const short = /^([^\s/@#]+\/[^\s/@#]+?)(?:\.git)?(?:[@#](\S+))?$/.exec(value);
    if (short != null) return githubSource(short[1], short[2] ?? null);
    throw new MarketplaceError("Type a GitHub repository (owner/repo) or an https link to a marketplace.json.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MarketplaceError(`“${value}” isn’t a web address.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isSecureEndpoint(url.href))) throw new MarketplaceError("Use an https:// address.");
  if (url.username !== "" || url.password !== "") throw new MarketplaceError("Leave credentials out of the address: the box reads public marketplaces only.");
  if (url.hostname === "github.com" || url.hostname === "www.github.com") {
    const parts = url.pathname.split("/").filter((part) => part.length > 0).map(decodeURIComponent);
    if (parts.length < 2) throw new MarketplaceError("Link to a repository, like https://github.com/owner/repo.");
    let ref = url.hash.length > 1 ? decodeURIComponent(url.hash.slice(1)) : null;
    if (parts.length > 2) {
      if (parts[2] !== "tree" || parts.length < 4) throw new MarketplaceError("Link to the repository itself, or to one of its branches (…/tree/<branch>).");
      ref = parts.slice(3).join("/");
    }
    return githubSource(`${parts[0]}/${parts[1]}`, ref);
  }
  if (url.hostname === "raw.githubusercontent.com") {
    const raw = /^\/([^/]+)\/([^/]+)\/(.+)\/\.claude-plugin\/marketplace\.json$/.exec(url.pathname);
    if (raw != null) return githubSource(`${raw[1]}/${raw[2]}`, decodeURIComponent(raw[3]).replace(/^refs\/(heads|tags)\//, ""));
  }
  url.hash = "";
  return { kind: "url", url: url.href };
}

/** How the app writes a source: "owner/repo", "owner/repo@ref", or the link. */
export const sourceLabel = (source: MarketplaceSource): string => (source.kind === "github" ? `${source.repo}${source.ref != null ? `@${source.ref}` : ""}` : source.url);

export const sourceUrl = (source: MarketplaceSource): string => (source.kind === "github" ? `https://github.com/${source.repo}${source.ref != null ? `/tree/${source.ref}` : ""}` : source.url);

/** The same marketplace, whatever way it was typed. */
export const sameSource = (a: MarketplaceSource, b: MarketplaceSource): boolean =>
  a.kind === "github" && b.kind === "github" ? a.repo.toLowerCase() === b.repo.toLowerCase() && a.ref === b.ref : a.kind === "url" && b.kind === "url" && a.url === b.url;

const archiveUrl = (hosts: MarketplaceHosts, repo: string, ref: string | null) =>
  `${hosts.github.replace(/\/+$/, "")}/${repo}/archive/${(ref ?? "HEAD").split("/").map(encodeURIComponent).join("/")}.tar.gz`;

/** A path inside the archive's one top folder ("repo-<sha>/"), without it. */
function inRepository(path: string): string | null {
  const slash = path.indexOf("/");
  return slash < 0 ? null : path.slice(slash + 1);
}

/** Downloads a repository's archive into `work`; the file, and a reader for the commit it holds. */
async function download(hosts: MarketplaceHosts, repo: string, ref: string | null, work: string): Promise<string> {
  mkdirSync(work, { recursive: true });
  const file = join(work, `${randomBytes(6).toString("hex")}.tar.gz`);
  try {
    await downloadFile(archiveUrl(hosts, repo, ref), file, { notFound: `GitHub has no public repository ${repo}${ref != null ? ` with a branch, tag or commit “${ref}”` : ""}.` });
  } catch (error) {
    rmSync(file, { force: true });
    throw error instanceof ArchiveError ? new MarketplaceError(error.message) : error;
  }
  return file;
}

/** The commit an archive holds: what GitHub's archive says, or the commit it was asked for. */
function commitOf(comment: string | null, ref: string | null): string {
  if (comment != null && COMMIT.test(comment)) return comment;
  if (ref != null && COMMIT.test(ref)) return ref;
  throw new MarketplaceError("The archive doesn’t say which commit it holds, so it can’t be pinned.");
}

/**
 * Unpacks the archive's files under each `from` (a folder of the repository, "" for all of it)
 * into its `to`. Paths that aren't safe to write are skipped and counted, as are files too large.
 */
async function unpack(file: string, selections: Array<{ from: string; to: string }>): Promise<{ comment: string | null; skipped: Map<string, number> }> {
  const skipped = new Map<string, number>();
  let files = 0;
  let bytes = 0;
  const matches = (path: string) => selections.filter((selection) => selection.from === "" || path === selection.from || path.startsWith(`${selection.from}/`));
  for (const selection of selections) {
    rmSync(selection.to, { recursive: true, force: true });
    mkdirSync(selection.to, { recursive: true });
  }
  const { comment } = await readTarGz(
    file,
    (path) => {
      const inside = inRepository(path);
      return inside != null && matches(inside).length > 0;
    },
    (entry, data) => {
      const inside = inRepository(entry.path)!;
      for (const selection of matches(inside)) {
        const segments = safeRelativePath(selection.from === "" ? inside : inside.slice(selection.from.length + 1));
        if (segments == null || data == null) {
          skipped.set(selection.to, (skipped.get(selection.to) ?? 0) + 1);
          continue;
        }
        files++;
        bytes += data.length;
        if (files > MAX_FILES || bytes > MAX_BYTES) throw new ArchiveError(`The plugins unpack to more than ${MAX_FILES.toLocaleString("en-US")} files or ${MAX_BYTES / 1024 / 1024} MiB.`);
        const target = join(selection.to, ...segments);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, data);
      }
    },
  ).catch((error: unknown) => {
    throw error instanceof ArchiveError ? new MarketplaceError(error.message) : error;
  });
  return { comment, skipped };
}

/** A relative path from a marketplace or manifest ("./x", "x" under a plugin root, "."), as a path in the repository; null when it leaves it. */
function relativePath(value: string, base = ""): string | null {
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return null;
  const joined = posix.normalize(posix.join(base, value)).replace(/\/+$/, "");
  if (joined === "." || joined === "") return "";
  if (joined === ".." || joined.startsWith("../") || joined.split("/").includes("..")) return null;
  return joined;
}

/** A GitHub repository from a plugin source's `repo` or `url`: owner/repo, or its https or git@ address. */
function githubRepo(value: unknown, shorthand: boolean): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match =
    /^https:\/\/(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(trimmed) ??
    /^git@github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(trimmed) ??
    (shorthand ? /^([^/\s:]+\/[^/\s:]+?)(?:\.git)?$/.exec(trimmed) : null);
  return match != null && REPO.test(match[1]) ? match[1] : null;
}

/** An entry's `source`: where its files are, or why the box can't fetch them. */
export function pluginSource(value: unknown, pluginRoot: string, kind: MarketplaceSource["kind"]): PluginSource | { error: string } {
  if (typeof value === "string") {
    const bare = !value.startsWith("./") && value !== "." && !value.includes("/");
    if (!bare && value !== "." && !value.startsWith("./")) return { error: `its source “${value}” must start with ./` };
    const path = relativePath(value, bare ? pluginRoot : "");
    if (path == null) return { error: `its source “${value}” leaves the marketplace` };
    if (kind === "url") return { kind: "unsupported", reason: "It’s kept beside the marketplace file, and a marketplace added by its link has only that file. Add the marketplace’s repository instead." };
    return { kind: "repository", path };
  }
  if (!isRecord(value) || typeof value.source !== "string") return { error: "its source is neither a path nor a source object" };
  const ref = typeof value.ref === "string" && isRef(value.ref) ? value.ref : null;
  const sha = typeof value.sha === "string" && COMMIT.test(value.sha) ? value.sha : null;
  if (value.source === "github" || value.source === "url" || value.source === "git-subdir") {
    const repo = value.source === "github" ? githubRepo(value.repo, true) : githubRepo(value.url, value.source === "git-subdir");
    if (repo == null) {
      const where = String(value.source === "github" ? value.repo : value.url);
      return value.source === "github" ? { error: `its repository “${where}” isn’t owner/repo` } : { kind: "unsupported", reason: `Its files are in a git repository outside GitHub (${where}), which Wisp can’t fetch without git.` };
    }
    const path = value.source === "git-subdir" ? relativePath(String(value.path ?? "")) : "";
    if (path == null || (value.source === "git-subdir" && path === "")) return { error: `its path “${String(value.path)}” isn’t a folder in the repository` };
    return { kind: "github", repo, path, ref, sha };
  }
  if (value.source === "npm") return { kind: "unsupported", reason: "It’s an npm package, which Wisp doesn’t fetch." };
  if (value.source === "archive") return { kind: "unsupported", reason: "It’s a zip archive, which Wisp doesn’t fetch." };
  if (value.source === "command") return { kind: "unsupported", reason: "It’s made by a command run on your computer, which Wisp never runs." };
  return { kind: "unsupported", reason: `Its source type “${value.source}” isn’t one Wisp knows.` };
}

/** The marketplace file: its name, description and owner, and an entry per plugin it lists. */
export function readMarketplaceFile(content: string, kind: MarketplaceSource["kind"]): { name: string; displayName: string; description: string; owner: string | null; entries: Array<{ name: string; entry: Record<string, unknown>; source: PluginSource }>; problems: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(content.replace(/^﻿/, ""));
  } catch (error) {
    throw new MarketplaceError(`Its marketplace.json isn’t valid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (!isRecord(json)) throw new MarketplaceError("Its marketplace.json isn’t a marketplace (it isn’t a JSON object).");
  const name = text(json.name);
  if (name == null) throw new MarketplaceError("Its marketplace.json has no name.");
  if (!isPluginName(name)) throw new MarketplaceError(`Its name “${name}” isn’t one Claude Code accepts: letters, digits, “.”, “_” and “-”, starting with a letter or digit.`);
  if (!Array.isArray(json.plugins)) throw new MarketplaceError("Its marketplace.json lists no plugins (“plugins” isn’t a list).");
  const metadata = isRecord(json.metadata) ? json.metadata : {};
  const pluginRoot = typeof metadata.pluginRoot === "string" ? (relativePath(metadata.pluginRoot) ?? "") : "";
  const problems: string[] = [];
  const entries: Array<{ name: string; entry: Record<string, unknown>; source: PluginSource }> = [];
  json.plugins.forEach((entry: unknown, index: number) => {
    const label = isRecord(entry) && typeof entry.name === "string" ? `“${entry.name}”` : `number ${index + 1}`;
    if (!isRecord(entry) || typeof entry.name !== "string") return void problems.push(`Plugin ${label} was skipped: it has no name.`);
    if (!isPluginName(entry.name)) return void problems.push(`Plugin ${label} was skipped: its name isn’t one Claude Code accepts.`);
    if (entries.some((other) => other.name === entry.name)) return void problems.push(`Plugin ${label} was skipped: another plugin has the same name.`);
    const source = pluginSource(entry.source, pluginRoot, kind);
    if ("error" in source) return void problems.push(`Plugin ${label} was skipped: ${source.error}.`);
    entries.push({ name: entry.name, entry, source });
  });
  const owner = isRecord(json.owner) ? text(json.owner.name) : null;
  return { name, displayName: text(json.displayName) ?? name, description: text(json.description) ?? text(metadata.description) ?? "", owner, entries, problems };
}

// ---- a plugin's files -------------------------------------------------------------------

/** What a plugin offers, from its folder and its marketplace entry. */
export type PluginContents = Pick<IndexedPlugin, "displayName" | "description" | "version" | "author" | "homepage" | "repository" | "license" | "keywords" | "skills" | "servers" | "options" | "unsupported" | "problems">;

const COMPONENT_KEYS = ["commands", "agents", "skills", "hooks", "outputStyles", "themes"];

const authorName = (value: unknown) => (isRecord(value) ? text(value.name) : text(value));
const keywordsOf = (value: unknown) => (Array.isArray(value) ? value.filter((word): word is string => typeof word === "string" && word.trim().length > 0).slice(0, 20) : []);

/** The entry's own fields, for a plugin whose files haven't been read. */
export function entryDetails(name: string, entry: Record<string, unknown>): Pick<IndexedPlugin, "displayName" | "description" | "version" | "author" | "homepage" | "repository" | "license" | "category" | "keywords"> {
  return {
    displayName: text(entry.displayName) ?? name,
    description: text(entry.description) ?? "",
    version: text(entry.version),
    author: authorName(entry.author),
    homepage: text(entry.homepage),
    repository: text(entry.repository),
    license: text(entry.license),
    category: text(entry.category),
    keywords: keywordsOf(entry.keywords ?? entry.tags),
  };
}

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

function readJsonFile(path: string): unknown {
  if (statSync(path).size > MAX_JSON_BYTES) throw new Error("it’s larger than 1 MiB");
  return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
}

/** How many files a folder holds, counting down to `limit`. */
function countFiles(dir: string, limit = 100): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (count >= limit) break;
    if (entry.isDirectory()) count += countFiles(join(dir, entry.name), limit - count);
    else count++;
  }
  return count;
}

/** One path or a list of them, as manifests write component paths. */
const pathList = (value: unknown): string[] => (typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/**
 * Reads a plugin from its folder and its marketplace entry. The plugin's own plugin.json is its
 * manifest when it has one (the entry's display fields still win, and with `strict` the entry's
 * component paths are added); without one, the entry is the manifest.
 */
export function readPluginFolder(root: string, name: string, entry: Record<string, unknown>, atRepositoryRoot: boolean): PluginContents {
  const problems: string[] = [];
  const unsupported = new Set<string>();
  let manifest: Record<string, unknown> | null = null;
  const manifestFile = join(root, ".claude-plugin", "plugin.json");
  if (isFile(manifestFile)) {
    try {
      const read = readJsonFile(manifestFile);
      if (isRecord(read)) manifest = read;
      else problems.push("Its plugin.json isn’t a JSON object, so its marketplace entry was read instead.");
    } catch (error) {
      problems.push(`Its plugin.json couldn’t be read (${error instanceof Error ? error.message : String(error)}), so its marketplace entry was read instead.`);
    }
  }
  const strict = entry.strict !== false;
  const main = manifest ?? entry;
  if (manifest != null && !strict && COMPONENT_KEYS.some((key) => entry[key] != null)) {
    problems.push("Both its plugin.json and its marketplace entry list components (the entry sets strict: false), so Claude Code wouldn’t load it either; only plugin.json was read.");
  }
  /** A component key set where it applies: the manifest, or the entry when it adds to it. */
  const declared = (key: string) => main[key] != null || (manifest != null && strict && COMPONENT_KEYS.includes(key) && entry[key] != null);
  const inside = (value: string) => {
    const path = relativePath(value);
    return path == null ? null : join(root, ...path.split("/").filter(Boolean));
  };

  // Skills: skills/ (unless the entry for a plugin at the repository's root names its own), plus the folders the manifest names.
  const skills: IndexedSkill[] = [];
  const skillFolders: string[] = [];
  const listed = [...pathList(main.skills), ...(manifest != null && strict ? pathList(entry.skills) : [])];
  if (!(atRepositoryRoot && entry.skills != null)) skillFolders.push("skills");
  for (const path of listed) {
    if (inside(path) == null) problems.push(`Its skills path “${path}” leaves the plugin’s folder, so it was skipped.`);
    else skillFolders.push(relativePath(path)!);
  }
  const addSkill = (folder: string, fallbackName: string) => {
    const file = posix.join(folder, "SKILL.md");
    const path = join(root, ...file.split("/").filter(Boolean));
    if (statSync(path).size > MAX_SKILL_FILE_BYTES) return void problems.push(`The skill in ${folder || "its folder"} was skipped: its SKILL.md is larger than 256 KiB.`);
    // What agents read is what the review shows: characters that don't show are taken out (see skillText).
    const { text: content, removed } = skillText(readFileSync(path, "utf8"));
    const read = skillFromMarkdown(content, parseSkillFile(content).name ?? fallbackName);
    if ("reason" in read) return void problems.push(`The skill in ${folder || "its folder"} was skipped: ${read.reason}`);
    if (skills.some((skill) => skill.name === read.spec.name)) return void problems.push(`A second skill named “${read.spec.name}” was skipped.`);
    skills.push({ name: read.spec.name, description: read.spec.description, path: file, ...(removed > 0 ? { hiddenCharacters: removed } : {}) });
    if (removed > 0) problems.push(`The skill “${read.spec.name}” had ${removed === 1 ? "a hidden character" : `${removed} hidden characters`} (text a model would read but you wouldn’t see). ${removed === 1 ? "It’s" : "They’re"} taken out.`);
    const extra = folder === "" ? 0 : countFiles(join(root, ...folder.split("/").filter(Boolean))) - 1;
    if (extra > 0) problems.push(`The skill “${read.spec.name}” comes with ${extra === 1 ? "another file" : `${extra} more files`} (scripts or references); agents get only its SKILL.md.`);
  };
  for (const folder of new Set(skillFolders)) {
    const dir = join(root, ...folder.split("/").filter(Boolean));
    if (!isDirectory(dir)) {
      if (folder !== "skills") problems.push(`Its skills folder “${folder}” isn’t there.`);
      continue;
    }
    if (isFile(join(dir, "SKILL.md"))) addSkill(folder, posix.basename(folder) || name);
    else for (const child of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) if (child.isDirectory() && isFile(join(dir, child.name, "SKILL.md"))) addSkill(posix.join(folder, child.name), child.name);
  }
  if (skills.length === 0 && listed.length === 0 && !isDirectory(join(root, "skills")) && isFile(join(root, "SKILL.md"))) addSkill("", name);

  // Options the user fills in (userConfig).
  const options: PluginOption[] = [];
  if (isRecord(main.userConfig)) {
    for (const [key, raw] of Object.entries(main.userConfig)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) || !isRecord(raw)) {
        problems.push(`Its option “${key}” was skipped.`);
        continue;
      }
      const type = ["string", "number", "boolean", "directory", "file"].includes(String(raw.type)) ? (raw.type as PluginOption["type"]) : "string";
      const fallback = Array.isArray(raw.default) ? raw.default.map(String).join(",") : raw.default != null && typeof raw.default !== "object" ? String(raw.default) : null;
      options.push({ key, title: text(raw.title) ?? key, description: text(raw.description) ?? "", type, required: raw.required === true, sensitive: raw.sensitive === true, default: fallback });
    }
  }

  // MCP servers: .mcp.json, then what the manifest declares; a later one replaces one of the same name.
  const servers = new Map<string, PluginServerSpec>();
  // A file holds {"mcpServers": {…}} or the map itself.
  const readServers = (json: unknown, where: string) => {
    const map = isRecord(json) && isRecord(json.mcpServers) ? json.mcpServers : json;
    if (!isRecord(map)) return void problems.push(`${where} isn’t a map of MCP servers.`);
    for (const [serverName, spec] of Object.entries(map)) {
      const server = readServer(serverName, spec, options, problems);
      if (server != null) servers.set(serverName, server);
    }
  };
  const mcpFile = join(root, ".mcp.json");
  if (isFile(mcpFile)) {
    try {
      readServers(readJsonFile(mcpFile), "Its .mcp.json");
    } catch (error) {
      problems.push(`Its .mcp.json couldn’t be read (${error instanceof Error ? error.message : String(error)}).`);
    }
  }
  for (const item of Array.isArray(main.mcpServers) ? main.mcpServers : main.mcpServers != null ? [main.mcpServers] : []) {
    if (typeof item === "string") {
      if (/\.(mcpb|dxt)$/i.test(item) || /^https?:/i.test(item)) {
        problems.push(`Its MCP bundle ${item} was skipped: bundles (.mcpb, .dxt) aren’t supported.`);
        continue;
      }
      const file = inside(item);
      if (file == null || !isFile(file)) {
        problems.push(`Its MCP servers file “${item}” isn’t in its folder.`);
        continue;
      }
      try {
        readServers(readJsonFile(file), `Its ${item}`);
      } catch (error) {
        problems.push(`Its ${item} couldn’t be read (${error instanceof Error ? error.message : String(error)}).`);
      }
    } else {
      readServers(item, "Its mcpServers");
    }
  }

  // What the box doesn't run.
  const folderHas = (folder: string) => isDirectory(join(root, folder)) && countFiles(join(root, folder), 1) > 0;
  const experimental = isRecord(main.experimental) ? main.experimental : {};
  if (declared("hooks") || isFile(join(root, "hooks", "hooks.json"))) unsupported.add("hooks");
  if (declared("commands") || folderHas("commands")) unsupported.add("commands");
  if (declared("agents") || folderHas("agents")) unsupported.add("agents");
  if (main.lspServers != null || isFile(join(root, ".lsp.json"))) unsupported.add("lspServers");
  if (declared("outputStyles") || folderHas("output-styles")) unsupported.add("outputStyles");
  if (declared("themes") || experimental.themes != null || folderHas("themes")) unsupported.add("themes");
  if (experimental.monitors != null || main.monitors != null || isFile(join(root, "monitors", "monitors.json"))) unsupported.add("monitors");
  if (main.workflows != null || folderHas("workflows")) unsupported.add("workflows");
  if (folderHas("bin")) unsupported.add("bin");
  if (main.channels != null) unsupported.add("channels");
  if (Array.isArray(main.dependencies) && main.dependencies.length > 0) unsupported.add("dependencies");
  if (main.settings != null || isFile(join(root, "settings.json"))) unsupported.add("settings");

  const fromEntry = entryDetails(name, entry);
  return {
    displayName: text(entry.displayName) ?? text(manifest?.displayName) ?? name,
    description: text(entry.description) ?? text(manifest?.description) ?? "",
    version: text(manifest?.version) ?? fromEntry.version,
    author: authorName(entry.author) ?? authorName(manifest?.author),
    homepage: text(entry.homepage) ?? text(manifest?.homepage),
    repository: text(entry.repository) ?? text(manifest?.repository),
    license: text(entry.license) ?? text(manifest?.license),
    keywords: fromEntry.keywords.length > 0 ? fromEntry.keywords : keywordsOf(manifest?.keywords),
    skills,
    servers: [...servers.values()],
    options,
    unsupported: [...unsupported],
    problems,
  };
}

/** `${…}` references in a server's command, arguments, environment, address or headers. */
const variables = (values: string[]) => [...new Set(values.flatMap((value) => [...value.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1])))];

/** One MCP server: stdio (command, args, env) or Streamable HTTP (url, headers); others are skipped with a note. */
function readServer(name: string, spec: unknown, options: PluginOption[], problems: string[]): PluginServerSpec | null {
  const skip = (why: string) => {
    problems.push(`Its MCP server “${name}” was skipped: ${why}`);
    return null;
  };
  if (name.length === 0 || name.length > 64 || /[\u0000-\u001f]/.test(name)) return skip("its name isn’t usable.");
  if (!isRecord(spec)) return skip("it isn’t a server config.");
  const strings = (value: unknown): Record<string, string> | null => {
    if (value == null) return {};
    if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean")) return null;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]).filter(([key]) => key.length > 0 && key.length <= 200));
  };
  const type = typeof spec.type === "string" ? spec.type.toLowerCase() : null;
  let server: PluginServerSpec;
  if (type === "sse" || type === "ws") return skip(`its ${type === "sse" ? "HTTP+SSE" : "WebSocket"} transport isn’t supported (only Streamable HTTP and stdio are).`);
  if (type === "http" || type === "streamable-http" || type === "streamablehttp" || (type == null && spec.url != null)) {
    if (typeof spec.url !== "string" || spec.url.trim().length === 0) return skip("it has no url.");
    if (spec.headersHelper != null) return skip("its headersHelper runs a command, which Wisp never does.");
    const headers = strings(spec.headers);
    if (headers == null) return skip("its headers aren’t a map of names and values.");
    server = { name, transport: "http", url: spec.url.trim(), headers };
  } else if (type == null || type === "stdio") {
    if (typeof spec.command !== "string" || spec.command.trim().length === 0) return skip("it has no command.");
    const env = strings(spec.env);
    if (env == null) return skip("its env isn’t a map of names and values.");
    if (spec.args != null && !Array.isArray(spec.args)) return skip("its args aren’t a list.");
    server = { name, transport: "stdio", command: spec.command.trim(), args: ((spec.args as unknown[] | undefined) ?? []).map(String), env };
  } else {
    return skip(`its type “${type}” isn’t one Wisp knows.`);
  }
  const used = variables(server.transport === "stdio" ? [server.command, ...server.args, ...Object.values(server.env)] : [server.url, ...Object.values(server.headers)]);
  for (const variable of used) {
    const option = /^user_config\.(.+)$/.exec(variable);
    if (option != null) {
      if (!options.some((candidate) => candidate.key === option[1])) problems.push(`Its MCP server “${name}” uses \${${variable}}, which isn’t one of its options; it stays empty.`);
    } else if (variable === "CLAUDE_PROJECT_DIR") {
      problems.push(`Its MCP server “${name}” uses \${CLAUDE_PROJECT_DIR}; the box has no project folder, so it stays empty.`);
    } else if (variable !== "CLAUDE_PLUGIN_ROOT" && variable !== "CLAUDE_PLUGIN_DATA" && server.transport === "http") {
      problems.push(`Its MCP server “${name}” uses \${${variable}}; the box doesn’t send its environment to remote servers, so it stays empty.`);
    } else if (variable !== "CLAUDE_PLUGIN_ROOT" && variable !== "CLAUDE_PLUGIN_DATA" && !variable.includes(":-") && !BASIC_ENV.includes(variable.toUpperCase())) {
      problems.push(`Its MCP server “${name}” uses \${${variable}}; plugins get only the basics of the box’s environment (the search path, your folders, temp), not its keys and tokens, so it stays empty.`);
    }
  }
  return server;
}

/**
 * A server with `${…}` filled in: the plugin's folder and data folder, the user's values, and (for
 * a server the box runs) the box's environment. `keepOptions`, for showing what will run, fills in
 * only the values given (not secrets) and leaves every other `${…}` as written.
 */
export function resolveServer(spec: PluginServerSpec, paths: { root: string; data: string }, values: Record<string, string>, env: Record<string, string | undefined>, keepOptions = false): PluginServerSpec {
  const fill = (value: string) =>
    value.replace(/\$\{([^}]*)\}/g, (whole, variable: string) => {
      if (variable === "CLAUDE_PLUGIN_ROOT") return paths.root;
      if (variable === "CLAUDE_PLUGIN_DATA") return paths.data;
      const option = /^user_config\.(.+)$/.exec(variable);
      if (option != null) return values[option[1]] ?? (keepOptions ? whole : "");
      if (keepOptions) return whole;
      // A remote server never gets the box's environment.
      if (spec.transport === "http") return "";
      const fallback = /^([A-Za-z_][A-Za-z0-9_]*):-(.*)$/.exec(variable);
      return fallback != null ? (env[fallback[1]] ?? fallback[2]) : (env[variable] ?? "");
    });
  const map = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fill(value)]));
  return spec.transport === "stdio" ? { ...spec, command: fill(spec.command), args: spec.args.map(fill), env: map(spec.env) } : { ...spec, url: fill(spec.url), headers: map(spec.headers) };
}

/**
 * Moves a folder. On Windows a rename is refused for a moment while something (Defender, the
 * search indexer) still has a file just written open, so it's retried, then done as copy and delete.
 */
export function moveFolderSync(from: string, to: string): void {
  for (const delay of [0, 50, 100, 200, 400, 800]) {
    if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  cpSync(from, to, { recursive: true });
  rmSync(from, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** A hash of a folder's file names and contents. */
export function folderHash(dir: string): string {
  const hash = createHash("sha256");
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) hash.update(`${relative(dir, path).replace(/\\/g, "/")}\0`).update(readFileSync(path)).update("\0");
    }
  };
  walk(dir);
  return hash.digest("hex").slice(0, 32);
}

/** Stands for the plugin's commit and its servers exactly as written. */
export function approvalKeyOf(pluginId: string, commit: string | null, servers: PluginServerSpec[]): string {
  return createHash("sha256").update(JSON.stringify([pluginId, commit, servers])).digest("hex").slice(0, 32);
}

/** Stands for the servers alone: an update that changes it asks again. */
export const serversKeyOf = (servers: PluginServerSpec[]): string => createHash("sha256").update(JSON.stringify(servers)).digest("hex").slice(0, 32);

// ---- indexing -----------------------------------------------------------------------------

const newSnapshot = () => `s${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

/** A plugin as listed before its files are read. */
function listedPlugin(name: string, entry: Record<string, unknown>, source: PluginSource): IndexedPlugin {
  return {
    name,
    entry,
    ...entryDetails(name, entry),
    source,
    files: null,
    skills: [],
    servers: [],
    options: [],
    unsupported: [],
    problems: [],
    error: source.kind === "unsupported" ? source.reason : null,
  };
}

/**
 * Reads a marketplace into a new snapshot folder under `dir` (marketplaces/<id>/). Plugins in its
 * own repository are read now; one in a repository of its own keeps what `previous` read when its
 * source is pinned to the same commit, and is otherwise read when it's opened.
 */
export async function indexMarketplace(source: MarketplaceSource, dir: string, hosts: MarketplaceHosts, previous: MarketplaceIndex | null): Promise<MarketplaceIndex> {
  const snapshot = newSnapshot();
  const work = join(dir, ".download");
  mkdirSync(dir, { recursive: true });
  try {
    let content: string;
    let commit: string;
    let archive: string | null = null;
    if (source.kind === "github") {
      archive = await download(hosts, source.repo, source.ref, work);
      const found: { text: string | null } = { text: null };
      const { comment } = await readTarGz(
        archive,
        (path) => inRepository(path) === ".claude-plugin/marketplace.json",
        (_, data) => (found.text = data?.toString("utf8") ?? null),
      ).catch((error: unknown) => {
        throw error instanceof ArchiveError ? new MarketplaceError(error.message) : error;
      });
      commit = commitOf(comment, source.ref);
      if (found.text == null) throw new MarketplaceError(`${source.repo} has no .claude-plugin/marketplace.json${source.ref != null ? ` at ${source.ref}` : ""}, so it isn’t a plugin marketplace.`);
      content = found.text;
    } else {
      try {
        content = await fetchLimitedText(source.url, { accept: "application/json, text/plain;q=0.9, */*;q=0.5", webPage: "That address is a web page, not a marketplace.json. Link to the raw file." });
      } catch (error) {
        throw new MarketplaceError(error instanceof Error ? error.message : String(error));
      }
      commit = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    }
    const file = readMarketplaceFile(content, source.kind);
    const plugins = file.entries.map(({ name, entry, source: from }) => listedPlugin(name, entry, from));

    // Plugins in this repository: unpacked from the archive and read now.
    const local = plugins.filter((plugin) => plugin.source.kind === "repository");
    if (archive != null && local.length > 0) {
      const { skipped } = await unpack(
        archive,
        local.map((plugin) => ({ from: (plugin.source as { path: string }).path, to: join(dir, snapshot, "plugins", plugin.name) })),
      );
      for (const plugin of local) {
        const folder = join(dir, snapshot, "plugins", plugin.name);
        const path = (plugin.source as { path: string }).path;
        if (path !== "" && readdirSync(folder).length === 0) {
          plugin.error = `Its folder ./${path} isn’t in the repository.`;
          continue;
        }
        Object.assign(plugin, readPluginFolder(folder, plugin.name, plugin.entry, path === ""), { files: { commit, folder: `${snapshot}/plugins/${plugin.name}`, hash: folderHash(folder) } });
        const count = skipped.get(folder) ?? 0;
        if (count > 0) plugin.problems.push(`${count === 1 ? "One of its files was" : `${count} of its files were`} left out: a link, a name Windows can’t store, or larger than 16 MiB.`);
      }
    }

    // Plugins in repositories of their own: what was read before stands while their source is pinned to the same commit.
    for (const plugin of plugins) {
      if (plugin.source.kind !== "github") continue;
      const before = previous?.plugins.find((candidate) => candidate.name === plugin.name);
      if (before?.files == null || plugin.source.sha == null || JSON.stringify(before.source) !== JSON.stringify(plugin.source) || JSON.stringify(before.entry) !== JSON.stringify(plugin.entry)) continue;
      const from = join(dir, ...before.files.folder.split("/"));
      if (!isDirectory(from)) continue;
      const to = join(dir, snapshot, "plugins", plugin.name);
      mkdirSync(join(to, ".."), { recursive: true });
      moveFolderSync(from, to);
      Object.assign(plugin, { ...before, entry: plugin.entry, files: { ...before.files, folder: `${snapshot}/plugins/${plugin.name}` } });
    }
    return { schemaVersion: 1, name: file.name, displayName: file.displayName, description: file.description, owner: file.owner, commit, indexedAt: Date.now(), snapshot, plugins, problems: file.problems };
  } catch (error) {
    rmSync(join(dir, snapshot), { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Reads a plugin kept in a repository of its own into the marketplace's current snapshot. */
export async function fetchPlugin(plugin: IndexedPlugin, dir: string, snapshot: string, hosts: MarketplaceHosts): Promise<IndexedPlugin> {
  if (plugin.source.kind !== "github") return plugin;
  const source = plugin.source;
  const work = join(dir, ".download");
  const folder = join(dir, snapshot, "plugins", plugin.name);
  try {
    const archive = await download(hosts, source.repo, source.sha ?? source.ref, work);
    const { comment, skipped } = await unpack(archive, [{ from: source.path, to: folder }]);
    const commit = commitOf(comment, source.sha ?? source.ref);
    if (source.path !== "" && readdirSync(folder).length === 0) throw new MarketplaceError(`${source.repo} has no folder ${source.path} at ${commit.slice(0, 7)}.`);
    const contents = readPluginFolder(folder, plugin.name, plugin.entry, false);
    const count = skipped.get(folder) ?? 0;
    if (count > 0) contents.problems.push(`${count === 1 ? "One of its files was" : `${count} of its files were`} left out: a link, a name Windows can’t store, or larger than 16 MiB.`);
    return { ...plugin, ...contents, files: { commit, folder: `${snapshot}/plugins/${plugin.name}`, hash: folderHash(folder) }, error: null };
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    if (!(error instanceof MarketplaceError)) throw error;
    return { ...plugin, files: null, error: error.message };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
