// Plugins from marketplaces in Connect Apps: a plugin's page with its skills, its MCP servers and
// what the app leaves out; the review that comes before anything a plugin brings runs (each
// server's exact command, arguments and environment, or its address, and the commit they come
// from), and for an update what it changes (the version, each skill added, removed or changed
// with its texts, the servers, other files); the Marketplaces tab (add by link, refresh, remove);
// and the Skills tab, a search over every plugin's skills.
import { useEffect, useMemo, useState } from "react";
import { type CatalogPlugin, type MarketplaceView, type PluginServerSpec, type PluginSkillChange, type PluginUpdate, type SkillCatalogEntry, UNSUPPORTED_LABELS } from "../../shared/marketplace";
import type { McpCatalogEntry, McpServerSummary } from "../../shared/model";
import { gateway, main } from "../bridge";
import { loadMarketplaces, loadMcpCatalog, marketplaces, setMarketplaces, setMcpState } from "../store/agent-data";
import { modelSettings } from "../store/models";
import { useStore } from "../store/store";
import { AppLogo, CatalogFieldsForm, errorText, ServerManage } from "./ConnectApps";
import { Icon } from "./icons";

const short = (commit: string) => commit.replace(/^sha256:/, "").slice(0, 7);
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
/** An argument in double quotes when it has a space or a shell character, as the box passes it on. */
const quoteArg = (arg: string) => (/^[\w\-.:\\/=,@+${}]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);

function openLink(url: string | null) {
  if (url != null && url.length > 0) void main.openInBrowser({ url }).catch(() => undefined);
}

/** One MCP server as its plugin writes it: the command it runs, or the address it reaches. */
function ServerSpec({ server, where }: { server: PluginServerSpec; where: string }) {
  const lines = server.transport === "stdio" ? Object.entries(server.env).map(([key, value]) => `${key}=${value}`) : Object.entries(server.headers).map(([key, value]) => `${key}: ${value}`);
  return (
    <div className="plugin-server">
      <div className="plugin-server__head">
        <Icon name={server.transport === "stdio" ? "terminal" : "globe"} size={13} />
        <span className="plugin-server__name">{server.name}</span>
        <span className="muted">{server.transport === "stdio" ? `runs ${where}` : "is reached at"}</span>
      </div>
      <pre className="plugin-command">{server.transport === "stdio" ? [server.command, ...server.args].map(quoteArg).join(" ") : server.url}</pre>
      {lines.length > 0 ? (
        <>
          <div className="muted plugin-server__label">{server.transport === "stdio" ? "With these environment variables, besides the basics of the box’s (search path, folders, temp)" : "With these headers"}</div>
          <pre className="plugin-command plugin-command--extra">{lines.join("\n")}</pre>
        </>
      ) : null}
    </div>
  );
}

/** A plugin's SKILL.md files as agents would read them, by skill name: read when its page opens, and again at another commit. */
function useSkillTexts(pluginId: string, commit: string | null, wanted: boolean): Record<string, string> | null {
  const [texts, setTexts] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (!wanted || commit == null) return;
    let current = true;
    setTexts(null);
    gateway.skillCatalog({ pluginId }).then(
      (found) => current && setTexts(Object.fromEntries(found.map((skill) => [skill.name, skill.install.kind === "content" ? skill.install.content : ""]))),
      () => current && setTexts({}),
    );
    return () => {
      current = false;
    };
  }, [pluginId, commit, wanted]);
  return texts;
}

/** A plugin's skills, each with its full text to read before agents do. */
function PluginSkills({ entry, texts }: { entry: McpCatalogEntry; texts: Record<string, string> | null }) {
  const plugin = entry.plugin!;
  return (
    <ul className="plugin-skills">
      {entry.skills!.map((skill) => (
        <li key={skill.name}>
          <span className="plugin-skills__name">
            <span className="skill__command">
              /{plugin.name}:{skill.name}
            </span>
            {skill.sourceUrl != null ? (
              <button type="button" className="link-button" onClick={() => openLink(skill.sourceUrl!)}>
                On GitHub
              </button>
            ) : null}
          </span>
          <span className="muted">{skill.description}</span>
          {skill.hiddenCharacters != null ? (
            <span className="plugin-skills__hidden">
              <Icon name="alert" size={12} /> {skill.hiddenCharacters === 1 ? "A hidden character was" : `${skill.hiddenCharacters} hidden characters were`} taken out: text a model would read but you wouldn’t see.
            </span>
          ) : null}
          <details className="plugin-skills__text">
            <summary>Read it</summary>
            {texts == null ? <p className="muted">Loading…</p> : texts[skill.name] != null ? <pre className="plugin-command plugin-skills__body">{texts[skill.name]}</pre> : <p className="muted">Couldn’t read it.</p>}
          </details>
        </li>
      ))}
    </ul>
  );
}

/** Where a plugin's commands run. */
function useWhere(): string {
  return useStore(modelSettings, (settings) => (settings.boxLocation === "remote" ? "on your box server" : "on this PC"));
}

export function PluginPage({ entry, servers }: { entry: McpCatalogEntry; servers: McpServerSummary[] }) {
  const plugin = entry.plugin!;
  const installed = plugin.installed;
  const where = useWhere();
  const [mode, setMode] = useState<"view" | "install" | "update" | "settings" | "uninstall">("view");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canInstall = plugin.error == null && plugin.commit != null && plugin.nameTakenBy == null;
  const texts = useSkillTexts(plugin.pluginId, plugin.commit, (entry.skills?.length ?? 0) > 0);
  // An installed plugin is at its installed version until it's updated; the catalog's is the newest read.
  const version = installed != null ? installed.version : plugin.version;
  const unsupported = plugin.unsupported.map((key) => UNSUPPORTED_LABELS[key] ?? key);

  const run = async (label: string, action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(label);
    setError(null);
    try {
      await action();
      setMode("view");
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      setBusy(null);
      // A review that went stale shows what is there now.
      await loadMcpCatalog(true);
    }
  };

  return (
    <div className="app-page">
      <div className="app-page__head">
        <AppLogo entry={entry} size={48} />
        <div className="app-page__title">
          <h2>{entry.displayName}</h2>
          <div className="muted">{[plugin.marketplaceName, version != null ? `v${version}` : null, plugin.author].filter(Boolean).join(" · ")}</div>
        </div>
        {installed != null ? (
          <span className="app-card__state">
            <Icon name="check" size={12} /> Installed
          </span>
        ) : mode !== "install" ? (
          <button type="button" className="button button--primary" disabled={!canInstall} onClick={() => setMode("install")}>
            Review and install
          </button>
        ) : null}
      </div>
      {entry.description.length > 0 ? <p className="app-page__description">{entry.description}</p> : null}
      <p className="muted app-page__how">
        From <span className="mono">{plugin.sourceLabel}</span>
        {plugin.commit != null ? (
          <>
            {" "}
            at{" "}
            {plugin.commitUrl != null ? (
              <button type="button" className="link-button mono" onClick={() => openLink(plugin.commitUrl)} title={plugin.commit}>
                {short(plugin.commit)}
              </button>
            ) : (
              <span className="mono" title={plugin.commit}>
                {short(plugin.commit)}
              </span>
            )}
          </>
        ) : null}
        {plugin.homepage != null ? (
          <>
            {" · "}
            <button type="button" className="link-button" onClick={() => openLink(plugin.homepage)}>
              Website
            </button>
          </>
        ) : null}
        {plugin.license != null ? ` · ${plugin.license}` : ""}
      </p>

      {plugin.error != null ? <div className="form-error">{plugin.error}</div> : null}
      {plugin.nameTakenBy != null && plugin.error == null ? (
        <div className="plugin-update plugin-update--review">
          You already have a plugin named “{plugin.name}”, from {plugin.nameTakenBy}. This one’s skills would take the same /{plugin.name}:… commands, so uninstall that one to install this one.
        </div>
      ) : null}
      {plugin.commit == null && plugin.error == null ? (
        <div className="plugin-unread">
          <span className="muted">Its files are in a repository of their own, so they’re read when you ask. Nothing in them runs.</span>
          <button type="button" className="button button--small" disabled={busy != null} onClick={() => void run("read", () => gateway.refreshMarketplace({ id: plugin.marketplaceId, plugin: plugin.name }).then(setMarketplaces))}>
            {busy === "read" ? "Reading…" : "Read its files"}
          </button>
        </div>
      ) : null}

      {mode === "install" || mode === "update" ? (
        <PluginReview
          entry={entry}
          kind={mode}
          where={where}
          texts={texts}
          busy={busy === mode}
          onCancel={() => setMode("view")}
          onConfirm={(values) =>
            run(mode, async () => {
              if (mode === "install") setMcpState(await gateway.connectCatalogApp({ entryId: entry.id, values, approvalKey: plugin.approvalKey }));
              else setMcpState(await gateway.applyPluginInstall({ pluginId: plugin.pluginId, values: {}, update: true, approvalKey: plugin.approvalKey }));
            })
          }
        />
      ) : null}

      {installed != null && mode !== "update" ? (
        <section className="app-section" aria-label="Installed">
          <h3>Installed</h3>
          <p className="muted">
            At <span className="mono">{short(installed.commit)}</span> since {new Date(installed.updatedAt).toLocaleString()}.
            {installed.delisted ? " Its marketplace no longer lists it; it stays installed until you uninstall it." : ""}
          </p>
          {installed.updateAvailable && plugin.commit != null ? (
            <div className={`plugin-update${installed.serversChanged ? " plugin-update--review" : ""}`}>
              <span>
                A refresh found a new version: {versionChange(installed.version, plugin.version) ?? short(plugin.commit)}.{" "}
                {installed.skillChanges != null ? skillSummary(installed.skillChanges) : ""}
                {installed.serversChanged ? " It runs or reaches something else: review it before updating." : ""}
              </span>
              <button type="button" className="button button--small button--primary" onClick={() => setMode("update")}>
                Review update
              </button>
            </div>
          ) : null}
          {mode === "settings" ? (
            <CatalogFieldsForm
              entry={{
                ...entry,
                fields: (entry.fields ?? []).map((field) => ({
                  ...field,
                  isRequired: false,
                  placeholder: field.isSecret === true ? (installed.configuredKeys.includes(field.key) ? "Saved. Type a new one to replace it." : "") : (installed.values[field.key] ?? field.placeholder),
                })),
              }}
              submitLabel="Save"
              busy={busy === "settings"}
              onCancel={() => setMode("view")}
              onSubmit={(values) => run("settings", async () => setMcpState(await gateway.applyPluginInstall({ pluginId: plugin.pluginId, values })))}
            />
          ) : mode === "uninstall" ? (
            <div className="account-card__row">
              <span>Uninstall {entry.displayName}? Its servers and their sign-ins, its skills and its files are removed. Skills you copied to an agent stay.</span>
              <button
                type="button"
                className="button button--danger button--small"
                disabled={busy != null}
                onClick={() => void run("uninstall", async () => setMcpState((await gateway.dropPlugin({ pluginId: plugin.pluginId })).state))}
              >
                {busy === "uninstall" ? "Uninstalling…" : "Uninstall"}
              </button>
              <button type="button" className="button button--ghost button--small" onClick={() => setMode("view")}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="account-card__row">
              {(entry.fields?.length ?? 0) > 0 ? (
                <button type="button" className="button button--ghost button--small" onClick={() => setMode("settings")}>
                  <Icon name="gear" size={12} /> Settings
                </button>
              ) : null}
              <button type="button" className="button button--ghost button--small" onClick={() => setMode("uninstall")}>
                <Icon name="trash" size={12} /> Uninstall
              </button>
            </div>
          )}
        </section>
      ) : null}
      {error != null ? <div className="form-error">{error}</div> : null}

      {(entry.skills?.length ?? 0) > 0 && mode !== "install" && mode !== "update" ? (
        <section className="app-section" aria-label="Skills">
          <h3>Skills</h3>
          <p className="muted">
            {installed == null
              ? "Once it’s installed, every agent has these, read-only."
              : installed.updateAvailable
                ? "These are the new version’s skills: agents get them once you update. Review update shows what changes."
                : "Every agent has these, read-only. Copy one to an agent from its Skills tab to change it."}
          </p>
          <PluginSkills entry={entry} texts={texts} />
        </section>
      ) : null}

      {installed != null && servers.length > 0 ? (
        servers.map((server) => (
          <section key={server.id} className="app-section" aria-label={server.name}>
            <h3>{server.name}</h3>
            {installed.servers.filter((spec) => servers.length === 1 || server.name.endsWith(`: ${spec.name}`)).map((spec) => (
              <ServerSpec key={spec.name} server={spec} where={where} />
            ))}
            <ServerManage server={server} entry={entry} />
          </section>
        ))
      ) : plugin.servers.length > 0 && mode !== "install" ? (
        <section className="app-section" aria-label="MCP servers">
          <h3>MCP servers</h3>
          {plugin.servers.map((server) => (
            <ServerSpec key={server.name} server={server} where={where} />
          ))}
        </section>
      ) : null}

      {unsupported.length > 0 ? (
        <p className="muted plugin-unsupported">
          <Icon name="info" size={13} /> It also has {unsupported.join(", ")}, which Wisp doesn’t use: only a plugin’s skills and MCP servers are installed.
        </p>
      ) : null}
      {plugin.problems.length > 0 ? (
        <details className="plugin-problems">
          <summary className="muted">{plural(plugin.problems.length, "note")} from reading it</summary>
          <ul>
            {plugin.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * What installing or updating does, shown before it happens: each server's exact command line and
 * environment (or address and headers) and the commit they come from. The box takes the review's
 * approvalKey, so it runs what this showed and nothing else.
 */
function PluginReview({
  entry,
  kind,
  where,
  texts,
  busy,
  onConfirm,
  onCancel,
}: {
  entry: McpCatalogEntry;
  kind: "install" | "update";
  where: string;
  texts: Record<string, string> | null;
  busy: boolean;
  onConfirm(values: Record<string, string>): Promise<boolean>;
  onCancel(): void;
}) {
  const plugin: CatalogPlugin = entry.plugin!;
  const installed = plugin.installed;
  const changed = kind === "update" && installed?.serversChanged === true;
  const runs = plugin.servers.filter((server) => server.transport === "stdio").length;
  const label =
    kind === "install"
      ? plugin.servers.length === 0
        ? "Install"
        : runs > 0
          ? `Install and run ${runs === 1 ? "its command" : `its ${runs} commands`}`
          : "Install and connect"
      : changed
        ? runs > 0
          ? "Update and run the new command"
          : "Update and connect"
        : "Update";
  return (
    <section className="app-section plugin-review" aria-label={kind === "install" ? "Review before installing" : "Review the update"}>
      <h3>{kind === "install" ? `Install ${entry.displayName}?` : `Update ${entry.displayName}?`}</h3>
      <div className="template-warning" role="note">
        <Icon name="shield" size={16} />
        <div>
          {kind === "update" && !changed ? (
            <>
              <strong>Read what changes before you update it.</strong> Its skills are instructions every agent reads
              {runs > 0 ? `, and its ${runs === 1 ? "server restarts" : "servers restart"} from the new files, so check the files that change too` : ""}.
            </>
          ) : runs > 0 ? (
            <>
              <strong>Check what it runs before you {kind === "install" ? "install it" : "update it"}.</strong> Each command below runs {where} as soon as you confirm, with the same file and network access as the box, though not its keys and tokens. It’s code from someone’s repository: install only plugins you trust.
            </>
          ) : plugin.servers.length > 0 ? (
            <>
              <strong>Check where it connects.</strong> Agents send requests, with what they’re working on, to the addresses below.
            </>
          ) : (
            <>
              <strong>It adds only skills:</strong> instructions every agent reads, so they can tell agents what to do. Read them first.
            </>
          )}
        </div>
      </div>
      <p className="plugin-review__source">
        From <span className="mono">{plugin.sourceLabel}</span> at commit <span className="mono plugin-review__commit">{plugin.commit}</span>
        {plugin.commitUrl != null ? (
          <>
            {" "}
            <button type="button" className="link-button" onClick={() => openLink(plugin.commitUrl)}>
              See its files
            </button>
          </>
        ) : null}
      </p>
      {kind === "update" ? <UpdateChanges plugin={plugin} /> : null}
      {changed && installed != null ? (
        <div className="plugin-review__compare">
          <div>
            <div className="plugin-review__heading">Runs now</div>
            {installed.servers.length > 0 ? installed.servers.map((server) => <ServerSpec key={server.name} server={server} where={where} />) : <p className="muted">Nothing.</p>}
          </div>
          <div>
            <div className="plugin-review__heading">After the update</div>
            {plugin.servers.length > 0 ? plugin.servers.map((server) => <ServerSpec key={server.name} server={server} where={where} />) : <p className="muted">Nothing.</p>}
          </div>
        </div>
      ) : (
        <>
          {plugin.servers.map((server) => (
            <ServerSpec key={server.name} server={server} where={where} />
          ))}
        </>
      )}
      {kind === "install" && (entry.skills?.length ?? 0) > 0 ? (
        <div>
          <div className="plugin-review__heading">Gives every agent: {plural(entry.skills!.length, "skill")}</div>
          <PluginSkills entry={entry} texts={texts} />
        </div>
      ) : null}
      <CatalogFieldsForm entry={kind === "install" ? entry : { ...entry, fields: [] }} submitLabel={label} busy={busy} onSubmit={onConfirm} onCancel={onCancel} />
    </section>
  );
}

// ---- what an update changes ------------------------------------------------------------------

/** "v1.0.0 → v1.1.0", or "v1.1.0" when there was none; null when plugin.json gives none or the same one. */
function versionChange(from: string | null, to: string | null): string | null {
  if (to == null || to === from) return null;
  return from != null ? `v${from} → v${to}` : `v${to}`;
}

/** "Its skills change: 1 changed, 1 added." or "Its skills don’t change." */
function skillSummary(changes: { added: string[]; removed: string[]; changed: string[] }): string {
  const parts = [
    changes.changed.length > 0 ? `${changes.changed.length} changed` : null,
    changes.added.length > 0 ? `${changes.added.length} added` : null,
    changes.removed.length > 0 ? `${changes.removed.length} removed` : null,
  ].filter((part) => part != null);
  return parts.length > 0 ? `Its skills change: ${parts.join(", ")}.` : "Its skills don’t change.";
}

/** A line diff of two texts (longest common subsequence); null when they're too long to compare here. */
function lineDiff(before: string, after: string): Array<{ kind: "same" | "add" | "del"; text: string }> | null {
  const a = before.split("\n");
  const b = after.split("\n");
  if ((a.length + 1) * (b.length + 1) > 1_000_000) return null;
  // How long the common part of a[i…] and b[j…] is.
  const common = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
  }
  const lines: Array<{ kind: "same" | "add" | "del"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) lines.push({ kind: "same", text: a[i++] }), j++;
    else if (common[i + 1][j] >= common[i][j + 1]) lines.push({ kind: "del", text: a[i++] });
    else lines.push({ kind: "add", text: b[j++] });
  }
  while (i < a.length) lines.push({ kind: "del", text: a[i++] });
  while (j < b.length) lines.push({ kind: "add", text: b[j++] });
  return lines;
}

const CHANGE_LABELS: Record<PluginSkillChange["change"], string> = { changed: "Changed", added: "Added", removed: "Removed" };

/**
 * What an update changes, read from the box when the review opens: the version and commit, each
 * skill added, removed or changed (its texts as agents read them, and what changed between them),
 * whether its servers change, and its other files.
 */
function UpdateChanges({ plugin }: { plugin: CatalogPlugin }) {
  const [update, setUpdate] = useState<PluginUpdate | "error" | null>(null);
  useEffect(() => {
    let current = true;
    setUpdate(null);
    gateway.getPluginUpdate({ pluginId: plugin.pluginId }).then(
      (found) => current && setUpdate(found),
      () => current && setUpdate("error"),
    );
    return () => {
      current = false;
    };
  }, [plugin.pluginId, plugin.commit]);
  if (update == null) return <p className="muted">Reading what changes…</p>;
  if (update === "error") return <div className="form-error">Couldn’t read what the update changes. Refresh its marketplace and review it again.</div>;
  const version = versionChange(update.fromVersion, update.toVersion);
  const byKind = (change: PluginSkillChange["change"]) => update.skills.filter((skill) => skill.change === change).map((skill) => skill.name);
  const otherFiles = update.files.length + update.moreFiles;
  return (
    <div className="plugin-changes" aria-label="What the update changes">
      <div className="plugin-review__heading">What the update changes</div>
      <ul className="plugin-changes__summary">
        <li>
          {version != null ? `Version ${version}` : "Its version number stays the same"}, commit <span className="mono">{short(update.fromCommit)}</span> → <span className="mono">{short(update.toCommit)}</span>.
        </li>
        <li>{skillSummary({ added: byKind("added"), removed: byKind("removed"), changed: byKind("changed") })}</li>
        <li>{update.serversChanged ? "What it runs or connects to changes: see below." : "What it runs and connects to doesn’t change."}</li>
        <li>{otherFiles > 0 ? `${plural(otherFiles, "other file")} ${otherFiles === 1 ? "changes" : "change"}.` : "No other file changes."}</li>
      </ul>
      {update.skills.length > 0 ? (
        <ul className="plugin-skills">
          {update.skills.map((skill) => {
            const diff = skill.change === "changed" && skill.before != null && skill.after != null ? lineDiff(skill.before, skill.after) : null;
            return (
              <li key={`${skill.change}:${skill.name}`}>
                <span className="plugin-skills__name">
                  <span className={`pill plugin-change plugin-change--${skill.change}`}>{CHANGE_LABELS[skill.change]}</span>
                  <span className="skill__command">
                    /{plugin.name}:{skill.name}
                  </span>
                </span>
                {skill.hiddenCharacters != null ? (
                  <span className="plugin-skills__hidden">
                    <Icon name="alert" size={12} /> {skill.hiddenCharacters === 1 ? "A hidden character was" : `${skill.hiddenCharacters} hidden characters were`} taken out of the new text: text a model would read but you wouldn’t see.
                  </span>
                ) : null}
                {diff != null ? (
                  <details className="plugin-skills__text" open>
                    <summary>What changed</summary>
                    <pre className="plugin-command plugin-skills__body plugin-diff">
                      {diff.map((line, index) => (
                        <span key={index} className={`plugin-diff__line plugin-diff__line--${line.kind}`}>
                          {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
                          {line.text}
                        </span>
                      ))}
                    </pre>
                  </details>
                ) : null}
                {skill.before != null ? (
                  <details className="plugin-skills__text">
                    <summary>{skill.change === "changed" ? "Now" : "Read it"}</summary>
                    <pre className="plugin-command plugin-skills__body">{skill.before}</pre>
                  </details>
                ) : null}
                {skill.after != null ? (
                  <details className="plugin-skills__text">
                    <summary>{skill.change === "changed" ? "After the update" : "Read it"}</summary>
                    <pre className="plugin-command plugin-skills__body">{skill.after}</pre>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {otherFiles > 0 ? (
        <details className="plugin-problems">
          <summary className="muted">Its other files</summary>
          <ul>
            {update.files.map((file) => (
              <li key={file.path}>
                <span className="mono">{file.path}</span> {file.change}
              </li>
            ))}
            {update.moreFiles > 0 ? <li>and {update.moreFiles} more</li> : null}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

// ---- the Marketplaces tab --------------------------------------------------------------------

export function MarketplacesTab({ browse }: { browse(marketplaceId: string): void }) {
  const { list, status } = useStore(marketplaces);
  const [source, setSource] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void loadMarketplaces();
  }, []);
  return (
    <div className="marketplaces">
      <p className="muted marketplaces__intro">
        A marketplace lists plugins in Claude Code’s format: a GitHub repository with a .claude-plugin/marketplace.json, or a link to that file. Its plugins’ skills and MCP servers can then be installed here. The box reads public repositories over HTTPS, and nothing from one runs until you review and install it.
      </p>
      <form
        className="inline-form marketplaces__add"
        onSubmit={async (event) => {
          event.preventDefault();
          setAdding(true);
          setError(null);
          try {
            setMarketplaces(await gateway.addMarketplace({ source: source.trim() }));
            setSource("");
            void loadMcpCatalog(true);
          } catch (cause) {
            setError(errorText(cause));
          } finally {
            setAdding(false);
          }
        }}
      >
        <input className="mono" value={source} onChange={(event) => setSource(event.target.value)} placeholder="owner/repo, or https://…/marketplace.json" aria-label="Marketplace repository or link" required maxLength={2048} spellCheck={false} autoComplete="off" data-autofocus />
        <button type="submit" className="button button--primary" disabled={adding || source.trim().length === 0}>
          {adding ? "Reading…" : "Add marketplace"}
        </button>
      </form>
      {error != null ? <div className="form-error">{error}</div> : null}
      {status === "error" ? <div className="gallery__note">Couldn’t load your marketplaces from the box.</div> : null}
      {status === "ready" && list.length === 0 ? <div className="gallery__note">No marketplaces yet.</div> : null}
      <ul className="mcp-list">
        {list.map((view) => (
          <MarketplaceCard key={view.id} view={view} browse={() => browse(view.id)} />
        ))}
      </ul>
    </div>
  );
}

function MarketplaceCard({ view, browse }: { view: MarketplaceView; browse(): void }) {
  const [mode, setMode] = useState<"view" | "remove">("view");
  const [busy, setBusy] = useState<"refresh" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (kind: "refresh" | "remove", call: () => Promise<MarketplaceView[]>) => {
    setBusy(kind);
    setError(null);
    try {
      setMarketplaces(await call());
      setMode("view");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
      void loadMcpCatalog(true);
    }
  };
  const refreshing = busy === "refresh" || view.refreshing;
  return (
    <li className="mcp-server marketplace-card">
      <div className="mcp-server__head">
        <span className="mcp-server__name">{view.displayName}</span>
        <span className="muted">
          {plural(view.pluginCount, "plugin")}
          {view.installedCount > 0 ? `, ${view.installedCount} installed` : ""}
        </span>
      </div>
      {view.description.length > 0 ? <p className="marketplace-card__description">{view.description}</p> : null}
      <div className="muted marketplace-card__meta">
        <button type="button" className="link-button mono" onClick={() => openLink(view.sourceUrl)}>
          {view.source}
        </button>
        {view.commit != null ? (
          <>
            {" · read at "}
            <span className="mono" title={view.commit}>
              {short(view.commit)}
            </span>
          </>
        ) : null}
        {view.indexedAt != null ? `, ${new Date(view.indexedAt).toLocaleString()}` : ""}
        {view.owner != null ? ` · by ${view.owner}` : ""}
      </div>
      {view.error != null ? <div className="form-error">The last refresh failed: {view.error} What it read before still stands.</div> : null}
      {view.updateCount > 0 ? <div className="plugin-update">{view.updateCount === 1 ? "An installed plugin has" : `${view.updateCount} installed plugins have`} a new version. Open each one to review it; nothing updates by itself.</div> : null}
      {view.unfetchedCount > 0 ? (
        <div className="muted marketplace-card__note">
          {view.unfetchedCount === 1 ? "One plugin is kept in a repository of its own and read when you open it." : `${view.unfetchedCount} plugins are kept in repositories of their own and read when you open them.`}
        </div>
      ) : null}
      {view.problems.length > 0 ? (
        <details className="plugin-problems">
          <summary className="muted">{plural(view.problems.length, "note")} from reading it</summary>
          <ul>
            {view.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {mode === "remove" ? (
        <div className="account-card__row">
          <span>Remove {view.displayName}?{view.installedCount > 0 ? ` Its ${plural(view.installedCount, "installed plugin is", "installed plugins are")} uninstalled.` : ""}</span>
          <button type="button" className="button button--danger button--small" disabled={busy != null} onClick={() => void act("remove", () => gateway.removeMarketplace({ id: view.id }))}>
            {busy === "remove" ? "Removing…" : "Remove"}
          </button>
          <button type="button" className="button button--ghost button--small" onClick={() => setMode("view")}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="account-card__row">
          <button type="button" className="button button--small" onClick={browse}>
            Browse plugins
          </button>
          <button type="button" className="button button--ghost button--small" disabled={refreshing} onClick={() => void act("refresh", () => gateway.refreshMarketplace({ id: view.id }))}>
            <Icon name="refresh" size={12} /> {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button type="button" className="button button--ghost button--small" onClick={() => setMode("remove")}>
            <Icon name="trash" size={12} /> Remove
          </button>
        </div>
      )}
      {error != null ? <div className="form-error">{error}</div> : null}
    </li>
  );
}

// ---- the Skills tab ----------------------------------------------------------------------------

export function SkillsTab({ open, addMarketplace }: { open(pluginId: string): void; addMarketplace(): void }) {
  const { list } = useStore(marketplaces);
  const [skills, setSkills] = useState<SkillCatalogEntry[] | null>(null);
  const [query, setQuery] = useState("");
  // Read again whenever marketplaces or installed plugins change.
  useEffect(() => {
    let current = true;
    void loadMarketplaces();
    gateway.skillCatalog({}).then(
      (found) => current && setSkills(found),
      () => current && setSkills([]),
    );
    return () => {
      current = false;
    };
  }, [list]);
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  const visible = useMemo(() => (skills ?? []).filter((skill) => words.every((word) => `${skill.name} ${skill.description} ${skill.pluginName} ${skill.publisher}`.toLowerCase().includes(word))), [skills, words.join(" ")]);
  const unread = list.reduce((total, view) => total + view.unfetchedCount, 0);
  return (
    <div className="gallery">
      <div className="apps__search">
        <Icon name="search" size={15} />
        <input data-autofocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search skills" aria-label="Search skills" spellCheck={false} maxLength={200} />
        {query.length > 0 ? (
          <button type="button" className="icon-button icon-button--small" aria-label="Clear the search" onClick={() => setQuery("")}>
            <Icon name="close" size={12} />
          </button>
        ) : null}
      </div>
      {skills == null ? (
        <div className="gallery__note">Loading skills…</div>
      ) : skills.length === 0 ? (
        <div className="gallery__note">
          Skills come with the plugins of the marketplaces you add.{" "}
          <button type="button" className="link-button" onClick={addMarketplace}>
            Add a marketplace
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="gallery__note">No skills match.</div>
      ) : (
        <ul className="skill-results" aria-label="Skills">
          {visible.map((skill) => (
            <li key={skill.id}>
              <button type="button" className="skill-result" onClick={() => open(skill.pluginId)}>
                <span className="skill-result__name">
                  {skill.name}
                  {skill.installed ? (
                    <span className="app-card__state">
                      <Icon name="check" size={12} /> Installed
                    </span>
                  ) : null}
                </span>
                <span className="skill-result__description">{skill.description}</span>
                <span className="muted skill-result__from">
                  {skill.pluginName} · {skill.marketplaceId}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {unread > 0 && skills != null && skills.length > 0 ? <div className="gallery__note">{plural(unread, "plugin")} kept in repositories of their own show their skills once you open them.</div> : null}
    </div>
  );
}
