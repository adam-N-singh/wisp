// Plugin marketplaces: Claude Code-style marketplaces the user adds by link, which the box
// reads (src/box/marketplace.ts) and installs plugins from (src/box/plugins.ts), and the shapes
// the gateway's plugin methods use.
import type { McpState } from "./model";

/** Marketplace and plugin names, as Claude Code allows them: letters, digits, ".", "_" and "-", starting with a letter or digit. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A name Claude Code accepts that also works as a folder name wherever the box runs. */
export function isPluginName(name: string): boolean {
  return NAME.test(name) && !name.includes("..") && !name.endsWith(".") && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name);
}

/** `<plugin>@<marketplace>`, as Claude Code names an installed plugin; the catalog entry's id and the servers' `pluginId`. */
export const pluginIdOf = (plugin: string, marketplace: string): string => `${plugin}@${marketplace}`;

export function parsePluginId(id: string): { plugin: string; marketplace: string } | null {
  const at = id.indexOf("@");
  if (at < 0) return null;
  const plugin = id.slice(0, at);
  const marketplace = id.slice(at + 1);
  return isPluginName(plugin) && isPluginName(marketplace) ? { plugin, marketplace } : null;
}

/**
 * One of a plugin's MCP servers as its files declare it. `${CLAUDE_PLUGIN_ROOT}`,
 * `${CLAUDE_PLUGIN_DATA}` and `${user_config.KEY}` are filled in when it's installed.
 */
export type PluginServerSpec =
  | { name: string; transport: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { name: string; transport: "http"; url: string; headers: Record<string, string> };

/** A value a plugin asks for when it's installed (its manifest's `userConfig`). */
export interface PluginOption {
  key: string;
  title: string;
  description: string;
  type: "string" | "number" | "boolean" | "directory" | "file";
  required: boolean;
  /** Kept out of every reply once it's set. */
  sensitive: boolean;
  default: string | null;
}

/** A skill in a plugin. */
export interface PluginSkillDescriptor {
  name: string;
  description: string;
  /** The SKILL.md on GitHub at the indexed commit, when the plugin is on GitHub. */
  sourceUrl?: string;
  /** Characters that don't show, taken out of what agents read. */
  hiddenCharacters?: number;
}

/** A plugin as Connect Apps shows it (`McpCatalogEntry.plugin`). */
export interface CatalogPlugin {
  pluginId: string;
  name: string;
  marketplaceId: string;
  marketplaceName: string;
  version: string | null;
  author: string | null;
  license: string | null;
  homepage: string | null;
  /** Where its files come from: "acme/market ./plugins/tools", "github.com/acme/tools", … */
  sourceLabel: string;
  /** Its files' commit at the last refresh; null until they were read (a plugin in a repository of its own is read when opened). */
  commit: string | null;
  /** A link to its files at that commit. */
  commitUrl: string | null;
  /**
   * Its servers as the box would run or reach them: the plugin's folder on the box filled in,
   * values the user gives still `${user_config.KEY}`.
   */
  servers: PluginServerSpec[];
  options: PluginOption[];
  /** What it has that the app doesn't use ("hooks", "commands", "agents", …), as `unsupportedFieldKeys`. */
  unsupported: string[];
  /** Things in its files that were skipped, one sentence each. */
  problems: string[];
  /** Why its files couldn't be read, if they couldn't. */
  error: string | null;
  /**
   * Stands for this commit and these servers exactly: installing or updating sends it back, so
   * the box runs nothing the user didn't review.
   */
  approvalKey: string;
  /** The marketplace (its name as shown) of another installed plugin with this name, whose skills' commands this one's would take; it can't be installed alongside. */
  nameTakenBy: string | null;
  installed: InstalledPluginView | null;
}

export interface InstalledPluginView {
  commit: string;
  installedAt: number;
  updatedAt: number;
  /** The servers as installed, so an update can show what changes. */
  servers: PluginServerSpec[];
  /** Box server ids of its MCP servers. */
  serverIds: string[];
  /** Options the user filled in; sensitive ones are listed but their values aren't. */
  values: Record<string, string>;
  configuredKeys: string[];
  /** Its plugin.json's version when it was installed (the catalog's `version` is the newest read). */
  version: string | null;
  /** The last refresh read another commit of its files. */
  updateAvailable: boolean;
  /** …whose servers run or reach something else: updating asks again. */
  serversChanged: boolean;
  /** …and the skills it adds, removes and changes, by name; null without an update. getPluginUpdate has their texts. */
  skillChanges: { added: string[]; removed: string[]; changed: string[] } | null;
  /** The marketplace no longer lists it; it stays installed until it's uninstalled. */
  delisted: boolean;
}

/** One of a plugin's skills an update adds, removes or changes, as agents read it (characters that don't show taken out). */
export interface PluginSkillChange {
  name: string;
  change: "added" | "removed" | "changed";
  /** Its SKILL.md now and after the update; null on the side it isn't on. */
  before: string | null;
  after: string | null;
  /** Characters that don't show, taken out of the text after the update. */
  hiddenCharacters?: number;
}

/** What updating an installed plugin to the last refresh's files changes (getPluginUpdate). */
export interface PluginUpdate {
  pluginId: string;
  fromCommit: string;
  toCommit: string;
  /** From plugin.json, when it gives one. */
  fromVersion: string | null;
  toVersion: string | null;
  /** Its servers run or reach something else: updating needs the review's approvalKey. */
  serversChanged: boolean;
  /** Skills added, removed and changed, by name. */
  skills: PluginSkillChange[];
  /** Its other files added, removed and changed (scripts its servers run, a skill's references), at most 200. */
  files: Array<{ path: string; change: "added" | "removed" | "changed" }>;
  /** Changed files past those 200. */
  moreFiles: number;
}

/** A marketplace the user added. Its id is its name. */
export interface MarketplaceView {
  id: string;
  displayName: string;
  description: string;
  owner: string | null;
  /** "github" (a repository, read from its archive) or "url" (a marketplace.json link: only plugins in other repositories). */
  sourceKind: "github" | "url";
  /** "acme/market", "acme/market@v2" or the link. */
  source: string;
  /** Where to see it: the repository on GitHub, or the link. */
  sourceUrl: string;
  /** The commit the last refresh read (a link's is "sha256:…" of the file). */
  commit: string | null;
  indexedAt: number | null;
  pluginCount: number;
  installedCount: number;
  updateCount: number;
  /** Plugins in repositories of their own not read yet. */
  unfetchedCount: number;
  problems: string[];
  /** The last refresh failed; what it read before still stands. */
  error: string | null;
  refreshing: boolean;
}

/** A plugin's skill as skillCatalog lists it. */
export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  publisher: string;
  source: "managed" | "marketplace";
  install: { kind: "content"; name: string; content: string } | { kind: "url"; url: string };
  pluginId: string;
  pluginName: string;
  marketplaceId: string;
  installed: boolean;
}

/** A skill an installed plugin gives every agent. */
export interface PluginSkillInfo {
  name: string;
  description: string;
  pluginId: string;
  pluginName: string;
}

/** readPluginUpdates's reply; `updates` are installed plugins a refresh found newer files for. */
export interface PluginSyncStatus {
  authBlocked: Array<{ marketplaceName?: string; pluginId: string; pluginName: string }>;
  updates: Array<{ pluginId: string; pluginName: string; installedCommit: string; availableCommit: string; serversChanged: boolean }>;
}

/** An installed plugin as listInstalledPlugins lists it. There are no teams: every plugin is the user's. */
export interface EffectivePlugin {
  pluginId: string;
  name: string;
  displayName: string;
  installMode: "user" | "team-default" | "team-required" | "unknown";
  isEnabled: boolean;
  mcpServerNames?: string[];
  configuredVariableKeys?: string[];
}

export interface McpRemoveResult {
  removed: boolean;
  reason?: "still-present" | "team-server" | null;
  state: McpState;
}

/** What an unsupported part is called in the app. */
export const UNSUPPORTED_LABELS: Record<string, string> = {
  hooks: "hooks",
  commands: "commands",
  agents: "subagents",
  lspServers: "LSP servers",
  outputStyles: "output styles",
  themes: "themes",
  monitors: "monitors",
  workflows: "workflows",
  bin: "executables (bin/)",
  channels: "channels",
  dependencies: "dependencies on other plugins",
  settings: "settings",
};
