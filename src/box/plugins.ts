// Plugins from marketplaces: the marketplaces the user added, and the plugins installed
// from them. Installing copies a plugin's files, at the commit the user reviewed, to
// plugins/<marketplace>/<plugin>/<commit>/ (its ${CLAUDE_PLUGIN_ROOT}); its skills join every
// agent's skills, read-only, and its MCP servers join the box's servers with `pluginId` set.
// Nothing a marketplace brings runs before the user confirms it: installing and updating take the
// plugin's approvalKey, a hash of the commit and of every server's command, arguments,
// environment, address and headers as written, so the box starts only what the confirmation
// showed. A refresh reads newer commits but never moves an installed plugin: the user updates it,
// and confirms again when its servers changed.
import { createHash, randomBytes } from "node:crypto";
import { cpSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import {
  type CatalogPlugin,
  type EffectivePlugin,
  type InstalledPluginView,
  type MarketplaceView,
  parsePluginId,
  pluginIdOf,
  type PluginOption,
  type PluginSkillChange,
  type PluginSkillInfo,
  type PluginSyncStatus,
  type PluginUpdate,
  type SkillCatalogEntry,
} from "../shared/marketplace";
import type { McpCatalogEntry, McpServerConfig, McpServerSummary } from "../shared/model";
import {
  approvalKeyOf,
  fetchPlugin,
  type IndexedPlugin,
  indexMarketplace,
  type MarketplaceHosts,
  type MarketplaceIndex,
  MarketplaceError,
  type MarketplaceRecord,
  moveFolderSync,
  parseMarketplaceSource,
  fileChanges,
  type PluginFiles,
  skillChanges,
  resolveServer,
  sameSource,
  serversKeyOf,
  skillText,
  sourceLabel,
  sourceUrl,
} from "./marketplace";
import { normalizeMcpUrl } from "./mcp";
import { parseSkillFile } from "./skills";
import type { BoxStore, InstalledPlugin, PluginSkill } from "./store";

export class PluginError extends Error {
  constructor(
    readonly code: "not-found" | "invalid" | "conflict" | "review" | "unreachable",
    message: string,
  ) {
    super(message);
  }
}

export interface PluginHostDeps {
  store: BoxStore;
  hosts: MarketplaceHosts;
  /** The box's environment, for `${VAR}` in a server the box runs. */
  env: Record<string, string | undefined>;
  /** Starts, stops and restarts servers to match the store. */
  syncServers(): void;
  /** A removed server's sign-in goes too. */
  forgetServer(serverId: string): void;
  /** A short id for a new server, unique among the box's. */
  newServerId(name: string): string;
  serverStatus(serverId: string): McpServerSummary["status"] | null;
  /** Installed plugins' skills changed, so every agent's skill list did. */
  skillsChanged(): void;
  /** Marketplaces or installed plugins changed. */
  changed(): void;
  log(line: string): void;
}

/** How many plugins in repositories of their own a refresh reads at once. */
const FETCH_CONCURRENCY = 4;
/** Brand-like colors for plugins' monograms. */
const COLORS = ["#4f46e5", "#0f766e", "#b45309", "#be123c", "#7c3aed", "#0369a1", "#15803d", "#c2410c", "#334155", "#a21caf"];

export class PluginHost {
  /** Per marketplace: the refresh or fetch running now, so they never overlap. */
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: PluginHostDeps) {}

  private get store(): BoxStore {
    return this.deps.store;
  }

  /** At startup: the installed plugins' skills. */
  load(): void {
    this.loadSkills();
  }

  // ---- marketplaces ------------------------------------------------------------------------

  marketplaces(): MarketplaceView[] {
    return this.store
      .marketplaces()
      .map((record): MarketplaceView => {
        const index = this.store.marketplaceIndex(record.id);
        const plugins = index?.plugins ?? [];
        const installed = this.store.installedPlugins().filter((plugin) => plugin.marketplaceId === record.id);
        return {
          id: record.id,
          displayName: index?.displayName ?? record.id,
          description: index?.description ?? "",
          owner: index?.owner ?? null,
          sourceKind: record.source.kind,
          source: sourceLabel(record.source),
          sourceUrl: sourceUrl(record.source),
          commit: index?.commit ?? null,
          indexedAt: index?.indexedAt ?? null,
          pluginCount: plugins.length,
          installedCount: installed.length,
          updateCount: installed.filter((plugin) => this.updateOf(plugin) != null).length,
          unfetchedCount: plugins.filter((plugin) => plugin.source.kind === "github" && plugin.files == null && plugin.error == null).length,
          problems: index?.problems ?? [],
          error: record.error,
          refreshing: this.running.has(record.id),
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }));
  }

  /** Adds a marketplace by what the user typed and reads it; refused when it isn't one, or is one already added. */
  async add(input: string): Promise<MarketplaceView[]> {
    let source: MarketplaceRecord["source"];
    try {
      source = parseMarketplaceSource(input);
    } catch (error) {
      throw new PluginError("invalid", error instanceof Error ? error.message : String(error));
    }
    const known = this.store.marketplaces().find((record) => sameSource(record.source, source));
    if (known != null) throw new PluginError("conflict", `That marketplace is already added, as “${this.store.marketplaceIndex(known.id)?.displayName ?? known.id}”.`);
    const pending = join(this.store.dataDir, "marketplaces", `.pending-${randomBytes(4).toString("hex")}`);
    try {
      let index: MarketplaceIndex;
      try {
        index = await indexMarketplace(source, pending, this.deps.hosts, null);
      } catch (error) {
        if (error instanceof MarketplaceError) throw new PluginError("unreachable", error.message);
        throw error;
      }
      if (this.store.getMarketplace(index.name) != null) throw new PluginError("conflict", `You already have a marketplace named “${index.name}”. Remove it first to add this one.`);
      const dir = this.store.marketplaceDir(index.name);
      rmSync(dir, { recursive: true, force: true });
      moveFolderSync(pending, dir);
      this.store.putMarketplace({ id: index.name, source, addedAt: Date.now(), error: null });
      this.store.setMarketplaceIndex(index.name, index);
    } finally {
      rmSync(pending, { recursive: true, force: true });
    }
    this.deps.changed();
    return this.marketplaces();
  }

  /**
   * Reads the marketplace again (installed plugins kept in repositories of their own too, to find
   * their updates), or with `pluginName`, reads that one plugin's files. Installed plugins stay
   * where they are. A failure is kept on the marketplace and thrown; what it read before stands.
   */
  async refresh(id: string, pluginName?: string): Promise<MarketplaceView[]> {
    const record = this.requireMarketplace(id);
    await this.exclusive(id, async () => {
      if (pluginName != null) {
        const index = this.store.marketplaceIndex(id);
        const plugin = index?.plugins.find((candidate) => candidate.name === pluginName);
        if (index == null || plugin == null) throw new PluginError("not-found", `${this.label(id)} has no plugin named “${pluginName}”.`);
        await this.fetchInto(id, index, [plugin]);
        this.store.setMarketplaceIndex(id, index);
        return;
      }
      let index: MarketplaceIndex;
      try {
        index = await indexMarketplace(record.source, this.store.marketplaceDir(id), this.deps.hosts, this.store.marketplaceIndex(id));
      } catch (error) {
        if (!(error instanceof MarketplaceError)) throw error;
        this.store.putMarketplace({ ...record, error: error.message });
        throw new PluginError("unreachable", error.message);
      }
      if (index.name !== id) index.problems.unshift(`Its marketplace.json now names it “${index.name}”; it stays listed as “${id}”.`);
      const installed = new Set(this.store.installedPlugins().filter((plugin) => plugin.marketplaceId === id).map((plugin) => plugin.name));
      await this.fetchInto(id, index, index.plugins.filter((plugin) => installed.has(plugin.name) && plugin.source.kind === "github" && plugin.files == null));
      this.store.setMarketplaceIndex(id, index);
      for (const entry of readdirSync(this.store.marketplaceDir(id))) {
        if (entry !== index.snapshot && entry !== "index.json") rmSync(join(this.store.marketplaceDir(id), entry), { recursive: true, force: true });
      }
      this.store.putMarketplace({ ...record, error: null });
    }).finally(() => this.deps.changed());
    return this.marketplaces();
  }

  /** Removes a marketplace and uninstalls its plugins, as Claude Code does. */
  remove(id: string): MarketplaceView[] {
    this.requireMarketplace(id);
    if (this.running.has(id)) throw new PluginError("conflict", `${this.label(id)} is being refreshed. Try again once it’s done.`);
    for (const plugin of this.store.installedPlugins()) if (plugin.marketplaceId === id) this.uninstall(plugin.pluginId, false);
    this.store.deleteMarketplace(id);
    this.afterPluginsChanged();
    return this.marketplaces();
  }

  /** Reads plugins kept in repositories of their own into the index, a few at a time. */
  private async fetchInto(id: string, index: MarketplaceIndex, plugins: IndexedPlugin[]): Promise<void> {
    const queue = [...plugins];
    const work = async () => {
      for (let plugin = queue.shift(); plugin != null; plugin = queue.shift()) {
        const read = await fetchPlugin(plugin, this.store.marketplaceDir(id), index.snapshot, this.deps.hosts);
        index.plugins[index.plugins.indexOf(plugin)] = read;
      }
    };
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, work));
  }

  private async exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
    while (this.running.has(id)) await this.running.get(id)!.catch(() => undefined);
    const task = run();
    this.running.set(id, task);
    this.deps.changed();
    try {
      return await task;
    } finally {
      this.running.delete(id);
    }
  }

  private requireMarketplace(id: string): MarketplaceRecord {
    const record = this.store.getMarketplace(id);
    if (record == null) throw new PluginError("not-found", "That marketplace isn’t added.");
    return record;
  }

  private label(marketplaceId: string): string {
    return this.store.marketplaceIndex(marketplaceId)?.displayName ?? marketplaceId;
  }

  // ---- the catalog -------------------------------------------------------------------------

  /** Every plugin of every marketplace as a Connect Apps entry, and installed plugins a marketplace no longer lists. */
  catalogEntries(): McpCatalogEntry[] {
    const entries: McpCatalogEntry[] = [];
    for (const record of this.store.marketplaces()) {
      const index = this.store.marketplaceIndex(record.id);
      const listed = index?.plugins ?? [];
      const installed = this.store.installedPlugins().filter((plugin) => plugin.marketplaceId === record.id);
      for (const plugin of listed) entries.push(this.entry(record, index, plugin, installed.find((candidate) => candidate.name === plugin.name) ?? null, 10_000 + entries.length));
      for (const plugin of installed) if (!listed.some((candidate) => candidate.name === plugin.name)) entries.push(this.entry(record, index, plugin.plugin, plugin, 10_000 + entries.length));
    }
    return entries;
  }

  private entry(record: MarketplaceRecord, index: MarketplaceIndex | null, plugin: IndexedPlugin, installed: InstalledPlugin | null, rank: number): McpCatalogEntry {
    const pluginId = pluginIdOf(plugin.name, record.id);
    const marketplaceName = index?.displayName ?? record.id;
    const listed = index?.plugins.includes(plugin) === true;
    const commit = plugin.files?.commit ?? null;
    const github = this.githubFolder(record, plugin);
    const paths = { root: this.store.pluginFolder(record.id, plugin.name, commit ?? "pending"), data: this.store.pluginDataFolder(record.id, plugin.name) };
    const color = COLORS[createHash("sha256").update(pluginId).digest()[0] % COLORS.length];
    const words = plugin.displayName.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ");
    const clash = installed == null ? this.sameName(plugin.name, pluginId) : undefined;
    const view: CatalogPlugin = {
      pluginId,
      name: plugin.name,
      marketplaceId: record.id,
      marketplaceName,
      version: plugin.version,
      author: plugin.author,
      license: plugin.license,
      homepage: plugin.homepage,
      sourceLabel: plugin.source.kind === "repository" ? `${sourceLabel(record.source)}${plugin.source.path !== "" ? ` ./${plugin.source.path}` : ""}` : plugin.source.kind === "github" ? `github.com/${plugin.source.repo}${plugin.source.path !== "" ? `/${plugin.source.path}` : ""}` : "",
      commit,
      commitUrl: github != null && commit != null ? `https://github.com/${github.repo}/tree/${commit}${github.path !== "" ? `/${github.path}` : ""}` : null,
      // An installed plugin's update keeps its values, so they show on both sides of its review.
      servers: plugin.servers.map((server) => resolveServer(server, paths, installed != null ? shownValues(installed) : {}, {}, true)),
      options: plugin.options,
      unsupported: plugin.unsupported,
      problems: plugin.problems,
      error: plugin.error,
      approvalKey: approvalKeyOf(pluginId, commit, plugin.servers),
      nameTakenBy: clash != null ? this.label(clash.marketplaceId) : null,
      installed: installed != null ? this.installedView(installed, listed) : null,
    };
    const httpServer = plugin.servers.find((server) => server.transport === "http");
    return {
      id: pluginId,
      displayName: plugin.displayName,
      description: plugin.description,
      category: marketplaceName,
      categoryKey: `marketplace:${record.id}`,
      publisher: { name: (plugin.author ?? index?.owner ?? record.id).toLowerCase().replace(/[^a-z0-9]+/g, "-"), displayName: plugin.author ?? index?.owner ?? marketplaceName, isUserOwned: false },
      websiteUrl: plugin.homepage ?? plugin.repository ?? "",
      popularityRank: rank,
      ...(plugin.options.length > 0 ? { fields: plugin.options.map(optionField) } : {}),
      docsUrl: plugin.homepage ?? "",
      url: httpServer?.transport === "http" ? httpServer.url : "",
      auth: "none",
      featured: false,
      monogram: (words.length > 1 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? "?").slice(0, 1)).toUpperCase(),
      color,
      marketplace: { displayName: marketplaceName, name: record.id, ownership: "user" },
      pluginName: plugin.name,
      ...(github != null ? { repositoryUrl: `https://github.com/${github.repo}` } : {}),
      skills: plugin.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        ...(github != null && commit != null ? { sourceUrl: `https://github.com/${github.repo}/blob/${commit}/${github.path !== "" ? `${github.path}/` : ""}${skill.path}` } : {}),
        ...(skill.hiddenCharacters != null ? { hiddenCharacters: skill.hiddenCharacters } : {}),
      })),
      unsupportedFieldKeys: plugin.unsupported,
      plugin: view,
    };
  }

  /** The plugin's folder on GitHub, when it's there. */
  private githubFolder(record: MarketplaceRecord, plugin: IndexedPlugin): { repo: string; path: string } | null {
    if (plugin.source.kind === "github") return { repo: plugin.source.repo, path: plugin.source.path };
    if (plugin.source.kind === "repository" && record.source.kind === "github") return { repo: record.source.repo, path: plugin.source.path };
    return null;
  }

  private installedView(installed: InstalledPlugin, listed: boolean): InstalledPluginView {
    const update = this.updateOf(installed);
    // Only the skills here: every catalog read comes through, and the other files are hashed when the review asks.
    const skills = update != null ? skillChanges(...this.filesOf(installed, update.plugin)) : null;
    const paths = { root: this.store.pluginFolder(installed.marketplaceId, installed.name, installed.commit), data: this.store.pluginDataFolder(installed.marketplaceId, installed.name) };
    return {
      commit: installed.commit,
      installedAt: installed.installedAt,
      updatedAt: installed.updatedAt,
      servers: installed.plugin.servers.map((server) => resolveServer(server, paths, shownValues(installed), {}, true)),
      serverIds: Object.values(installed.serverIds),
      values: shownValues(installed),
      configuredKeys: Object.entries(installed.values).filter(([, value]) => value.length > 0).map(([key]) => key),
      version: installed.plugin.version,
      updateAvailable: update != null,
      serversChanged: update?.serversChanged ?? false,
      skillChanges: skills != null ? { added: names(skills, "added"), removed: names(skills, "removed"), changed: names(skills, "changed") } : null,
      delisted: !listed,
    };
  }

  /** What updating to the last refresh's files changes: the version, the skills with their texts, the servers and the other files. */
  pluginUpdate(pluginId: string): PluginUpdate {
    const installed = this.store.getInstalledPlugin(pluginId);
    if (installed == null) throw new PluginError("not-found", "That plugin isn’t installed.");
    const update = this.updateOf(installed);
    if (update == null) throw new PluginError("conflict", "There’s no newer version of it. Refresh its marketplace to look for one.");
    return {
      pluginId,
      fromCommit: installed.commit,
      toCommit: update.plugin.files.commit,
      fromVersion: installed.plugin.version,
      toVersion: update.plugin.version,
      serversChanged: update.serversChanged,
      skills: skillChanges(...this.filesOf(installed, update.plugin)),
      ...fileChanges(...this.filesOf(installed, update.plugin)),
    };
  }

  /** The installed files, and the newer ones the marketplace read. */
  private filesOf(installed: InstalledPlugin, newer: IndexedPlugin & { files: NonNullable<IndexedPlugin["files"]> }): [PluginFiles, PluginFiles] {
    return [
      { root: this.store.pluginFolder(installed.marketplaceId, installed.name, installed.commit), skills: installed.plugin.skills },
      { root: join(this.store.marketplaceDir(installed.marketplaceId), ...newer.files.folder.split("/")), skills: newer.skills },
    ];
  }

  /** The marketplace's newer read of an installed plugin, when its files changed. */
  private updateOf(installed: InstalledPlugin): { plugin: IndexedPlugin & { files: NonNullable<IndexedPlugin["files"]> }; serversChanged: boolean } | null {
    const plugin = this.indexed(installed.marketplaceId, installed.name);
    if (plugin?.files == null) return null;
    const serversChanged = serversKeyOf(plugin.servers) !== serversKeyOf(installed.plugin.servers);
    if (plugin.files.hash === installed.hash && !serversChanged) return null;
    return { plugin: plugin as IndexedPlugin & { files: NonNullable<IndexedPlugin["files"]> }, serversChanged };
  }

  private indexed(marketplaceId: string, name: string): IndexedPlugin | undefined {
    return this.store.marketplaceIndex(marketplaceId)?.plugins.find((plugin) => plugin.name === name);
  }

  /** Every skill of every plugin whose files were read, with its SKILL.md (skillCatalog). */
  skillCatalog(onlyPluginId?: string): SkillCatalogEntry[] {
    const out: SkillCatalogEntry[] = [];
    for (const record of this.store.marketplaces()) {
      const index = this.store.marketplaceIndex(record.id);
      for (const plugin of index?.plugins ?? []) {
        if (plugin.files == null) continue;
        const pluginId = pluginIdOf(plugin.name, record.id);
        if (onlyPluginId != null && pluginId !== onlyPluginId) continue;
        for (const skill of plugin.skills) {
          let content: string;
          try {
            content = skillText(readFileSync(join(this.store.marketplaceDir(record.id), ...plugin.files.folder.split("/"), ...skill.path.split("/")), "utf8")).text;
          } catch {
            continue;
          }
          out.push({
            id: `${pluginId}/${skill.name}`,
            name: skill.name,
            description: skill.description,
            publisher: plugin.author ?? index?.owner ?? index?.displayName ?? record.id,
            source: "marketplace",
            install: { kind: "content", name: skill.name, content },
            pluginId,
            pluginName: plugin.displayName,
            marketplaceId: record.id,
            installed: this.store.getInstalledPlugin(pluginId) != null,
          });
        }
      }
    }
    return out;
  }

  // ---- installed plugins -------------------------------------------------------------------

  /**
   * Installs a plugin at the commit the user reviewed (`approvalKey` from its catalog entry) with
   * the values it asks for; returns its servers' ids.
   */
  install(pluginId: string, values: Record<string, string | number | boolean>, approvalKey: string | undefined): string[] {
    const id = parsePluginId(pluginId);
    if (id == null) throw new PluginError("not-found", "That plugin isn’t in any marketplace you added.");
    if (this.store.getInstalledPlugin(pluginId) != null) throw new PluginError("conflict", "That plugin is already installed.");
    const clash = this.sameName(id.plugin, pluginId);
    if (clash != null) {
      throw new PluginError("conflict", `You already have a plugin named “${id.plugin}”, from ${this.label(clash.marketplaceId)}. Its skills would take the same /${id.plugin}:… commands, so uninstall that one first.`);
    }
    const plugin = this.indexed(id.marketplace, id.plugin);
    if (plugin == null) throw new PluginError("not-found", "That plugin isn’t in any marketplace you added.");
    if (plugin.error != null) throw new PluginError("invalid", plugin.error);
    if (plugin.files == null) throw new PluginError("review", "Its files haven’t been read yet. Open it to read them, then review it.");
    this.checkApproval(pluginId, plugin, approvalKey, true);
    const filled = this.filledValues(plugin, {}, values);
    const folder = this.store.pluginFolder(id.marketplace, id.plugin, plugin.files.commit);
    const from = join(this.store.marketplaceDir(id.marketplace), ...plugin.files.folder.split("/"));
    rmSync(folder, { recursive: true, force: true });
    cpSync(from, folder, { recursive: true });
    const now = Date.now();
    const installed: InstalledPlugin = { pluginId, marketplaceId: id.marketplace, name: id.plugin, commit: plugin.files.commit, hash: plugin.files.hash, installedAt: now, updatedAt: now, plugin, values: filled, serverIds: {} };
    try {
      this.putServers(installed, this.serverConfigs(installed));
    } catch (error) {
      rmSync(folder, { recursive: true, force: true });
      throw error;
    }
    this.store.putInstalledPlugin(installed);
    this.afterPluginsChanged();
    return Object.values(installed.serverIds);
  }

  /**
   * New values for an installed plugin's options, and with `update`, moves it to the files the last
   * refresh read. An update whose servers changed needs the new approvalKey: the user reviews
   * what it runs now.
   */
  update(pluginId: string, values: Record<string, string | number | boolean>, update: boolean, approvalKey: string | undefined): void {
    const installed = this.store.getInstalledPlugin(pluginId);
    if (installed == null) throw new PluginError("not-found", "That plugin isn’t installed.");
    let next: InstalledPlugin = { ...installed, serverIds: { ...installed.serverIds }, updatedAt: Date.now() };
    let oldFolder: string | null = null;
    if (update) {
      const found = this.updateOf(installed);
      if (found == null) throw new PluginError("conflict", "There’s no newer version of it. Refresh its marketplace to look for one.");
      this.checkApproval(pluginId, found.plugin, approvalKey, found.serversChanged);
      next = { ...next, plugin: found.plugin, commit: found.plugin.files.commit, hash: found.plugin.files.hash };
      const folder = this.store.pluginFolder(installed.marketplaceId, installed.name, next.commit);
      const current = this.store.pluginFolder(installed.marketplaceId, installed.name, installed.commit);
      if (folder !== current) {
        rmSync(folder, { recursive: true, force: true });
        cpSync(join(this.store.marketplaceDir(installed.marketplaceId), ...found.plugin.files.folder.split("/")), folder, { recursive: true });
        oldFolder = current;
      }
    }
    next.values = this.filledValues(next.plugin, installed.values, values);
    const configs = this.serverConfigs(next);
    for (const [name, serverId] of Object.entries(installed.serverIds)) {
      if (configs.some((config) => config.id === serverId)) continue;
      this.store.deleteMcpServer(serverId);
      this.deps.forgetServer(serverId);
      delete next.serverIds[name];
    }
    this.putServers(next, configs);
    this.store.putInstalledPlugin(next);
    this.afterPluginsChanged();
    if (oldFolder != null) this.removeFolder(oldFolder);
  }

  /** Uninstalls a plugin: its servers (and their sign-ins), skills, files and data go. */
  uninstall(pluginId: string, announce = true): boolean {
    const installed = this.store.getInstalledPlugin(pluginId);
    if (installed == null) return false;
    for (const serverId of Object.values(installed.serverIds)) {
      this.store.deleteMcpServer(serverId);
      this.deps.forgetServer(serverId);
    }
    this.store.deleteInstalledPlugin(pluginId);
    // Its servers stop before their files go.
    this.deps.syncServers();
    this.removeFolder(join(this.store.dataDir, "plugins", installed.marketplaceId, installed.name));
    this.removeFolder(this.store.pluginDataFolder(installed.marketplaceId, installed.name));
    if (announce) this.afterPluginsChanged();
    return true;
  }

  /** Another installed plugin with this name: its skills' commands (`/<name>:<skill>`) would be the same. */
  private sameName(name: string, pluginId: string): InstalledPlugin | undefined {
    return this.store.installedPlugins().find((plugin) => plugin.name === name && plugin.pluginId !== pluginId);
  }

  /** Whether a server belongs to an installed plugin (it goes when the plugin is uninstalled). */
  pluginOfServer(serverId: string): InstalledPlugin | undefined {
    return this.store.installedPlugins().find((plugin) => Object.values(plugin.serverIds).includes(serverId));
  }

  effective(): EffectivePlugin[] {
    return this.store.installedPlugins().map((installed) => ({
      pluginId: installed.pluginId,
      name: installed.name,
      displayName: installed.plugin.displayName,
      installMode: "user",
      isEnabled: true,
      mcpServerNames: installed.plugin.servers.map((server) => server.name),
      configuredVariableKeys: Object.entries(installed.values).filter(([, value]) => value.length > 0).map(([key]) => key),
    }));
  }

  syncStatus(): PluginSyncStatus {
    const installed = this.store.installedPlugins();
    return {
      authBlocked: installed
        .filter((plugin) => Object.values(plugin.serverIds).some((serverId) => this.deps.serverStatus(serverId) === "needsAuth"))
        .map((plugin) => ({ marketplaceName: this.label(plugin.marketplaceId), pluginId: plugin.pluginId, pluginName: plugin.plugin.displayName })),
      updates: installed.flatMap((plugin) => {
        const update = this.updateOf(plugin);
        return update == null ? [] : [{ pluginId: plugin.pluginId, pluginName: plugin.plugin.displayName, installedCommit: plugin.commit, availableCommit: update.plugin.files.commit, serversChanged: update.serversChanged }];
      }),
    };
  }

  /** Reads installed plugins' skills from their files again (refreshPluginSkills). */
  syncSkills(): PluginSkillInfo[] {
    this.loadSkills();
    this.deps.skillsChanged();
    return this.skillInfos();
  }

  skillInfos(): PluginSkillInfo[] {
    return this.store.pluginSkills().map((skill) => ({ name: skill.name, description: skill.description, pluginId: skill.pluginId, pluginName: skill.pluginName }));
  }

  private checkApproval(pluginId: string, plugin: IndexedPlugin, approvalKey: string | undefined, required: boolean): void {
    const key = approvalKeyOf(pluginId, plugin.files?.commit ?? null, plugin.servers);
    if (approvalKey == null) {
      if (required) throw new PluginError("review", plugin.servers.length > 0 ? "Review what it runs and connects to before installing it." : "Review what it adds before installing it.");
      return;
    }
    if (approvalKey !== key) throw new PluginError("review", "It changed since you reviewed it: a refresh read other files. Review it again.");
  }

  /** The values its options take: what the user sent, else what was set before, else the option's default. */
  private filledValues(plugin: IndexedPlugin, previous: Record<string, string>, sent: Record<string, string | number | boolean>): Record<string, string> {
    const values: Record<string, string> = {};
    for (const key of Object.keys(sent)) if (!plugin.options.some((option) => option.key === key)) throw new PluginError("invalid", `${plugin.displayName} has no setting called “${key}”.`);
    for (const option of plugin.options) {
      const raw = sent[option.key];
      // A secret left empty in a form keeps the one set before.
      const value = raw != null && String(raw).trim().length > 0 ? String(raw).trim() : (previous[option.key] ?? option.default ?? "");
      if (value.length > 4000) throw new PluginError("invalid", `${option.title} is too long.`);
      if (/[\u0000-\u001f\u007f]/.test(value)) throw new PluginError("invalid", `${option.title} can’t contain line breaks or control characters.`);
      if (option.required && value.length === 0) throw new PluginError("invalid", `${plugin.displayName} needs ${option.title}.`);
      if (option.type === "number" && value.length > 0 && !Number.isFinite(Number(value))) throw new PluginError("invalid", `${option.title} must be a number.`);
      if (option.type === "boolean" && value.length > 0 && !/^(true|false)$/.test(value)) throw new PluginError("invalid", `${option.title} must be true or false.`);
      values[option.key] = value;
    }
    return values;
  }

  /** The plugin's servers as the box's MCP servers; ones it had keep their ids and the user's settings. */
  private serverConfigs(installed: InstalledPlugin): McpServerConfig[] {
    const paths = { root: this.store.pluginFolder(installed.marketplaceId, installed.name, installed.commit), data: this.store.pluginDataFolder(installed.marketplaceId, installed.name) };
    const existing = new Map(this.store.mcpServers().map((server) => [server.id, server]));
    return installed.plugin.servers.map((spec): McpServerConfig => {
      const resolved = resolveServer(spec, paths, installed.values, this.deps.env);
      const id = installed.serverIds[spec.name] ?? "";
      const before = existing.get(id);
      const kept = { enabled: before?.enabled ?? true, ...(before?.disabledTools != null ? { disabledTools: before.disabledTools } : {}), ...(before?.customInstructions != null ? { customInstructions: before.customInstructions } : {}) };
      const name = installed.plugin.servers.length === 1 ? installed.plugin.displayName : `${installed.plugin.displayName}: ${spec.name}`;
      if (resolved.transport === "http") {
        let url: string;
        try {
          url = normalizeMcpUrl(resolved.url);
        } catch (error) {
          throw new PluginError("invalid", `Its server “${spec.name}” has an address the box won’t use: ${error instanceof Error ? error.message : String(error)}`);
        }
        return { id, name, transport: "http", url, headers: resolved.headers, pluginId: installed.pluginId, ...kept };
      }
      return { id, name, transport: "stdio", command: resolved.command, args: resolved.args, env: resolved.env, basicEnv: true, pluginId: installed.pluginId, ...kept };
    });
  }

  /** Saves the servers, giving new ones an id, and starts what changed. */
  private putServers(installed: InstalledPlugin, configs: McpServerConfig[]): void {
    installed.plugin.servers.forEach((spec, index) => {
      const config = configs[index];
      if (config.id === "") config.id = this.deps.newServerId(`${installed.name}-${spec.name}`);
      installed.serverIds[spec.name] = config.id;
      this.store.putMcpServer(config);
    });
    this.deps.syncServers();
  }

  private afterPluginsChanged(): void {
    this.loadSkills();
    this.deps.syncServers();
    this.deps.skillsChanged();
    this.deps.changed();
  }

  private removeFolder(path: string): void {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      // A server that just stopped may still hold a file on Windows; the folder is only clutter.
      this.deps.log(`removing ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Installed plugins' skills, read from their installed files. */
  private loadSkills(): void {
    const skills: PluginSkill[] = [];
    for (const installed of this.store.installedPlugins()) {
      const folder = this.store.pluginFolder(installed.marketplaceId, installed.name, installed.commit);
      const sensitive = new Set(installed.plugin.options.filter((option) => option.sensitive).map((option) => option.key));
      const fill = (text: string) =>
        text.replace(/\$\{(CLAUDE_PLUGIN_ROOT|user_config\.([A-Za-z_][A-Za-z0-9_]*))\}/g, (whole, variable: string, key?: string) =>
          variable === "CLAUDE_PLUGIN_ROOT" ? folder : key != null && !sensitive.has(key) ? (installed.values[key] ?? "") : whole,
        );
      for (const skill of installed.plugin.skills) {
        let text: string;
        try {
          text = fill(skillText(readFileSync(join(folder, ...skill.path.split("/")), "utf8")).text);
        } catch (error) {
          this.deps.log(`plugin ${installed.pluginId}: skill ${skill.name} unreadable: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        const file = parseSkillFile(text);
        if (file.body.length === 0) continue;
        skills.push({
          id: `plugin-${createHash("sha256").update(`${installed.pluginId}/${skill.name}`).digest("hex").slice(0, 16)}`,
          pluginId: installed.pluginId,
          pluginName: installed.plugin.displayName,
          name: `${installed.name}:${skill.name}`,
          description: skill.description,
          body: file.body,
          text,
          filePath: relative(this.store.dataDir, join(folder, ...skill.path.split("/"))).replace(/\\/g, "/"),
          sourceRef: this.skillSourceRef(installed, skill.path),
          disableModelInvocation: file.disableModelInvocation,
          createdAt: installed.updatedAt,
        });
      }
    }
    this.store.setPluginSkills(skills);
  }

  private skillSourceRef(installed: InstalledPlugin, path: string): string | null {
    const record = this.store.getMarketplace(installed.marketplaceId);
    const github = record != null ? this.githubFolder(record, installed.plugin) : null;
    return github != null && /^[0-9a-f]{40}$/.test(installed.commit) ? `https://github.com/${github.repo}/blob/${installed.commit}/${github.path !== "" ? `${github.path}/` : ""}${path}` : null;
  }
}

/** The names of the skills an update changes this way. */
const names = (skills: PluginSkillChange[], change: PluginSkillChange["change"]) => skills.filter((skill) => skill.change === change).map((skill) => skill.name);

/** The values an installed plugin's options took, secrets left out: what replies may show. */
function shownValues(installed: InstalledPlugin): Record<string, string> {
  const sensitive = new Set(installed.plugin.options.filter((option) => option.sensitive).map((option) => option.key));
  return Object.fromEntries(Object.entries(installed.values).filter(([key, value]) => !sensitive.has(key) && value.length > 0));
}

/** A plugin's option as a field of the install form. */
function optionField(option: PluginOption): NonNullable<McpCatalogEntry["fields"]>[number] {
  return {
    key: option.key,
    label: option.title,
    type: "string",
    ...(option.sensitive ? { isSecret: true } : {}),
    ...(option.required ? { isRequired: true } : {}),
    ...(option.default != null ? { placeholder: option.default } : {}),
    ...(option.description.length > 0 ? { hint: option.description } : {}),
  };
}
