// Connect Apps (Ctrl+Shift+M, the palette, the sidebar's footer), the plugins dialog: a
// searchable gallery of well-known remote MCP servers by
// category, from the box's readAppCatalog; each app's page with its accounts (sign in, rename,
// remove, add another), its tools with a switch each, and instructions for agents; and adding a
// custom server by URL or JSON. Settings → MCP servers reuses the server parts. Plugins from the
// marketplaces the user added are apps too; their page, the Skills and Marketplaces tabs are in
// Plugins.tsx. The Bot templates tab is BotGallery in BotTemplates.tsx.
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { McpCatalogEntry, McpServerSummary, McpServerTool, McpState } from "../../shared/model";
import { gateway, main } from "../bridge";
import { isModKey, shortcutKey } from "../shortcuts";
import { closeDialog, type ConnectAppsTab } from "../store/app";
import { loadMcpCatalog, loadMcpServers, mcpCatalog, mcpServers, mcpSignIns, setMcpState, signInToMcpServer, signOutOfMcpServer } from "../store/agent-data";
import { Store, useStore } from "../store/store";
import { BotGallery } from "./BotTemplates";
import { Icon } from "./icons";
import { MarketplacesTab, PluginPage, SkillsTab } from "./Plugins";

type Page = { kind: "gallery" } | { kind: "app"; appId: string; serverId?: string } | { kind: "server"; serverId: string } | { kind: "add-custom" };

const TAB_LABELS: Record<ConnectAppsTab, string> = { apps: "Apps", skills: "Skills", marketplaces: "Marketplaces", bots: "Bot templates" };

export const MCP_STATUS: Record<McpServerSummary["status"], string> = {
  connected: "Connected",
  initializing: "Connecting…",
  needsAuth: "Needs sign-in",
  error: "Error",
  disconnected: "Off",
};

export const errorText = (error: unknown) => (error instanceof Error ? error.message.replace(/^[\w/-]+: /, "") : String(error));

/** Adding an app from a card or its page: in progress, or why it failed. */
const installs = new Store<Record<string, { busy: boolean; error: string | null }>>({});

/** Adds an app (another account when `accountKey` is given) and starts its sign-in when it has one; the new server's id, or null. */
async function installApp(entry: McpCatalogEntry, options: { values?: Record<string, string>; accountKey?: string } = {}): Promise<string | null> {
  installs.set((state) => ({ ...state, [entry.id]: { busy: true, error: null } }));
  try {
    const { serverId, ...state } = await gateway.connectCatalogApp({ entryId: entry.id, ...options });
    setMcpState(state);
    installs.set((state) => ({ ...state, [entry.id]: { busy: false, error: null } }));
    if (entry.auth === "oauth") void signInToMcpServer(serverId);
    return serverId;
  } catch (cause) {
    installs.set((state) => ({ ...state, [entry.id]: { busy: false, error: errorText(cause) } }));
    return null;
  }
}

/** The name agents and lists use: the app, and the account when it has a name. */
export const serverLabel = (server: McpServerSummary) => (server.accountKey ? `${server.name} (${server.accountKey})` : server.name);

/** Dark or light letters, whichever reads better on the brand color. */
function inkFor(color: string): string {
  const channel = (offset: number) => {
    const value = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.36 ? "#14120f" : "#ffffff";
}

/** The app's monogram in its brand color; a plug for a custom server. */
export function AppLogo({ entry, size }: { entry: McpCatalogEntry | null; size: number }) {
  const style = { width: size, height: size, fontSize: Math.round(size * (entry != null && entry.monogram.length > 1 ? 0.36 : 0.44)), borderRadius: Math.round(size * 0.26) } as CSSProperties;
  if (entry == null) {
    return (
      <span className="app-logo app-logo--custom" style={style} aria-hidden="true">
        <Icon name="plug" size={Math.round(size * 0.5)} />
      </span>
    );
  }
  return (
    <span className="app-logo" style={{ ...style, background: entry.color, color: inkFor(entry.color) }} aria-hidden="true">
      {entry.monogram}
    </span>
  );
}

export function ConnectApps({ appId, serverId, tab: initialTab }: { appId?: string; serverId?: string; tab?: ConnectAppsTab }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState<Page>(appId != null ? { kind: "app", appId, serverId } : serverId != null ? { kind: "server", serverId } : { kind: "gallery" });
  const [tab, setTab] = useState<ConnectAppsTab>(initialTab ?? "apps");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const catalog = useStore(mcpCatalog);
  const { servers } = useStore(mcpServers);

  useEffect(() => {
    dialog.current?.showModal();
    void loadMcpCatalog();
    void loadMcpServers();
  }, []);

  // showModal focuses the first control (Close), and a page change removes the one that had focus:
  // the gallery's search field, or a page's way back, takes it.
  const pageKey = page.kind === "app" ? `app:${page.appId}` : page.kind === "server" ? `server:${page.serverId}` : page.kind;
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>(page.kind === "gallery" ? "[data-autofocus]" : ".apps__back")?.focus();
  }, [pageKey]);

  const entry = page.kind === "app" ? catalog.entries.find((candidate) => candidate.id === page.appId) : undefined;
  const server = page.kind === "server" ? servers.find((candidate) => candidate.id === page.serverId) : undefined;
  const back = () => setPage({ kind: "gallery" });
  const open = (target: { appId?: string; serverId?: string }) => {
    const found = target.serverId != null ? servers.find((candidate) => candidate.id === target.serverId) : undefined;
    const app = target.appId ?? found?.pluginId;
    setPage(app != null ? { kind: "app", appId: app, serverId: target.serverId } : { kind: "server", serverId: target.serverId! });
  };

  return (
    <dialog
      ref={dialog}
      className="apps"
      aria-label="Connect Apps"
      onCancel={(event) => {
        event.preventDefault();
        if (page.kind === "gallery") closeDialog();
        else back();
      }}
      onKeyDown={(event) => {
        // Esc goes back to the gallery first. Handled here: Chromium may close a dialog without a
        // cancelable cancel event when nothing was clicked since the last Esc.
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (page.kind === "gallery") closeDialog();
          else back();
        } else if (isModKey(event) && event.shiftKey && !event.altKey && shortcutKey(event.nativeEvent) === "m") {
          // Its own shortcut closes it.
          event.preventDefault();
          closeDialog();
        }
      }}
    >
      <header className="apps__header">
        {page.kind === "gallery" ? (
          <div className="apps__heading">
            <h2 className="apps__title">Connect Apps</h2>
            <div className="apps__tabs" role="tablist" aria-label="Show">
              {(["apps", "skills", "marketplaces", "bots"] as const).map((item) => (
                <button key={item} type="button" role="tab" aria-selected={tab === item} className={`tab${tab === item ? " tab--active" : ""}`} onClick={() => setTab(item)}>
                  {TAB_LABELS[item]}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <button type="button" className="button button--ghost apps__back" onClick={back}>
            <Icon name="chevronLeft" size={14} /> {tab === "apps" ? "All apps" : TAB_LABELS[tab]}
          </button>
        )}
        <button type="button" className="icon-button" aria-label="Close" onClick={closeDialog}>
          <Icon name="close" />
        </button>
      </header>
      <div className="apps__body">
        {page.kind === "gallery" && tab === "bots" ? (
          <BotGallery />
        ) : page.kind === "gallery" && tab === "skills" ? (
          <SkillsTab open={(pluginId) => open({ appId: pluginId })} addMarketplace={() => setTab("marketplaces")} />
        ) : page.kind === "gallery" && tab === "marketplaces" ? (
          <MarketplacesTab
            browse={(marketplaceId) => {
              setTab("apps");
              setQuery("");
              setCategory(`marketplace:${marketplaceId}`);
            }}
          />
        ) : page.kind === "gallery" ? (
          <Gallery query={query} setQuery={setQuery} category={category} setCategory={setCategory} servers={servers} open={open} addCustom={() => setPage({ kind: "add-custom" })} addMarketplace={() => setTab("marketplaces")} />
        ) : page.kind === "app" ? (
          entry?.plugin != null ? (
            <PluginPage key={entry.id} entry={entry} servers={servers.filter((candidate) => candidate.pluginId === entry.id)} />
          ) : entry != null ? (
            <AppPage key={entry.id} entry={entry} accounts={servers.filter((candidate) => candidate.pluginId === entry.id)} initialServerId={page.serverId} />
          ) : (
            <p className="muted">{catalog.status === "error" ? "Couldn’t load the apps." : "Loading…"}</p>
          )
        ) : page.kind === "server" ? (
          server != null ? <ServerPage server={server} onRemoved={back} /> : <p className="muted">This server was removed.</p>
        ) : (
          <div className="app-page">
            <div className="app-page__head">
              <AppLogo entry={null} size={48} />
              <div className="app-page__title">
                <h2>Add a custom app</h2>
                <div className="muted">Any MCP server: a remote one by its address, or a command that runs on your box.</div>
              </div>
            </div>
            <AddMcpServer onAdded={(id) => setPage({ kind: "server", serverId: id })} />
          </div>
        )}
      </div>
    </dialog>
  );
}

function Gallery({
  query,
  setQuery,
  category,
  setCategory,
  servers,
  open,
  addCustom,
  addMarketplace,
}: {
  query: string;
  setQuery(query: string): void;
  category: string | null;
  setCategory(category: string | null): void;
  servers: McpServerSummary[];
  open(target: { appId?: string; serverId?: string }): void;
  addCustom(): void;
  addMarketplace(): void;
}) {
  const { entries, status } = useStore(mcpCatalog);
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const entry of entries) if (!seen.has(entry.categoryKey)) seen.set(entry.categoryKey, entry.category);
    return [...seen].map(([key, label]) => ({ key, label }));
  }, [entries]);
  const accountsOf = (entry: McpCatalogEntry) => servers.filter((server) => server.pluginId === entry.id);
  const visible = entries.filter(
    (entry) => (category == null || entry.categoryKey === category) && words.every((word) => `${entry.displayName} ${entry.description} ${entry.category} ${entry.publisher.displayName} ${entry.skills?.map((skill) => skill.name).join(" ") ?? ""}`.toLowerCase().includes(word)),
  );
  const browsing = words.length === 0 && category == null;
  const sections: Array<{ title: string; apps: McpCatalogEntry[] }> = browsing
    ? [{ title: "Featured", apps: entries.filter((entry) => entry.featured) }, ...categories.map((item) => ({ title: item.label, apps: entries.filter((entry) => entry.categoryKey === item.key) }))]
    : [{ title: category != null && words.length === 0 ? (categories.find((item) => item.key === category)?.label ?? "Apps") : "Results", apps: visible }];

  return (
    <div className="gallery">
      <div className="apps__search">
        <Icon name="search" size={15} />
        <input data-autofocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search apps and plugins" aria-label="Search apps and plugins" spellCheck={false} maxLength={200} />
        {query.length > 0 ? (
          <button type="button" className="icon-button icon-button--small" aria-label="Clear the search" onClick={() => setQuery("")}>
            <Icon name="close" size={12} />
          </button>
        ) : null}
      </div>
      <div className="apps__categories" role="group" aria-label="Categories">
        <button type="button" className={`chip${category == null ? " chip--active" : ""}`} aria-pressed={category == null} onClick={() => setCategory(null)}>
          All
        </button>
        {categories.map((item) => (
          <button key={item.key} type="button" className={`chip${category === item.key ? " chip--active" : ""}`} aria-pressed={category === item.key} onClick={() => setCategory(category === item.key ? null : item.key)}>
            {item.label}
          </button>
        ))}
      </div>

      {browsing && servers.length > 0 ? (
        <section className="gallery__section" aria-label="Your apps">
          <h3 className="gallery__title">Your apps</h3>
          <div className="your-apps">
            {servers.map((server) => (
              <button key={server.id} type="button" className="your-app" onClick={() => open({ appId: server.pluginId, serverId: server.id })} title={`${serverLabel(server)}: ${MCP_STATUS[server.status]}`}>
                <AppLogo entry={entries.find((entry) => entry.id === server.pluginId) ?? null} size={20} />
                <span className="your-app__name">{serverLabel(server)}</span>
                <span className={`status-dot status-dot--${server.status}`} />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {status === "error" ? (
        <div className="gallery__note">
          Couldn’t load the apps from your box.{" "}
          <button type="button" className="link-button" onClick={() => void loadMcpCatalog()}>
            Try again
          </button>
        </div>
      ) : status !== "ready" ? (
        <div className="gallery__note">Loading apps…</div>
      ) : null}

      {sections
        .filter((section) => section.apps.length > 0)
        .map((section) => (
          <section key={section.title} className="gallery__section" aria-label={section.title}>
            <h3 className="gallery__title">{section.title}</h3>
            <div className="gallery__grid" role="list">
              {section.apps.map((entry) => (
                <AppCard key={entry.id} entry={entry} accounts={accountsOf(entry)} onOpen={() => open({ appId: entry.id })} />
              ))}
            </div>
          </section>
        ))}
      {status === "ready" && !browsing && visible.length === 0 ? <div className="gallery__note">No apps match. You can still add any MCP server yourself.</div> : null}

      <div className="gallery__custom">
        <span className="app-logo app-logo--custom" style={{ width: 36, height: 36, borderRadius: 9 }} aria-hidden="true">
          <Icon name="download" size={18} />
        </span>
        <div className="gallery__custom-text">
          <div className="app-card__name">Plugin marketplace</div>
          <div className="muted">Add plugins’ skills and MCP servers from a Claude Code marketplace on GitHub or at a link.</div>
        </div>
        <button type="button" className="button button--small" onClick={addMarketplace}>
          Add
        </button>
      </div>

      <div className="gallery__custom">
        <AppLogo entry={null} size={36} />
        <div className="gallery__custom-text">
          <div className="app-card__name">Custom app</div>
          <div className="muted">Add any MCP server by its address or a JSON config.</div>
        </div>
        <button type="button" className="button button--small" onClick={addCustom}>
          Add
        </button>
      </div>
    </div>
  );
}

function AppCard({ entry, accounts, onOpen }: { entry: McpCatalogEntry; accounts: McpServerSummary[]; onOpen(): void }) {
  // An installed plugin with a new version, read by a refresh or seen by the daily check.
  const installed = entry.plugin?.installed;
  const update = installed != null && (installed.updateAvailable || installed.updateFound != null);
  return (
    <div className="app-card" role="listitem">
      <button type="button" className="app-card__main" onClick={onOpen} aria-label={`${entry.displayName}: details${update ? ", a new version is out" : ""}`}>
        <AppLogo entry={entry} size={36} />
        <span className="app-card__text">
          <span className="app-card__name">
            {entry.displayName}
            {update ? <span className="app-card__badge">Update</span> : null}
          </span>
          <span className="app-card__description">{entry.description}</span>
        </span>
      </button>
      <ConnectButton entry={entry} accounts={accounts} onSetup={onOpen} />
    </div>
  );
}

/** Connect, Adding…, Sign in or Added, on an app's card. */
function ConnectButton({ entry, accounts, onSetup }: { entry: McpCatalogEntry; accounts: McpServerSummary[]; onSetup(): void }) {
  const install = useStore(installs, (state) => state[entry.id] ?? null);
  const signIns = useStore(mcpSignIns);
  if (entry.plugin != null) {
    // A plugin is installed from its page, after its review.
    const installed = entry.plugin.installed;
    if (installed == null || installed.updateAvailable || installed.updateFound != null) {
      // One the app can't fetch (an npm package, say) has only details to show.
      const label = installed != null ? "Update" : entry.plugin.error != null ? "Details" : "Review";
      return (
        <button type="button" className="button button--small" aria-label={`${label} ${entry.displayName}`} onClick={onSetup}>
          {label}
        </button>
      );
    }
    return installed.enabled ? (
      <span className="app-card__state">
        <Icon name="check" size={12} /> Installed
      </span>
    ) : (
      <span className="app-card__state">Turned off</span>
    );
  }
  if (accounts.length === 0) {
    return (
      <button
        type="button"
        className="button button--primary button--small"
        disabled={install?.busy === true}
        aria-label={`Connect ${entry.displayName}`}
        onClick={() => {
          // A token to paste, or an install that failed: the app's page asks or explains.
          if ((entry.fields?.length ?? 0) > 0) return onSetup();
          void installApp(entry).then((serverId) => serverId == null && onSetup());
        }}
      >
        {install?.busy === true ? "Adding…" : "Connect"}
      </button>
    );
  }
  if (accounts.some((account) => signIns[account.id]?.pending === "sign-in")) return <span className="app-card__state">Signing in…</span>;
  const needsSignIn = accounts.find((account) => account.status === "needsAuth");
  if (needsSignIn != null) {
    return (
      <button type="button" className="button button--small" aria-label={`Sign in to ${serverLabel(needsSignIn)}`} onClick={() => void signInToMcpServer(needsSignIn.id)}>
        Sign in
      </button>
    );
  }
  return (
    <span className="app-card__state">
      <Icon name="check" size={12} /> Added
    </span>
  );
}

const HOW_IT_CONNECTS: Record<McpCatalogEntry["auth"], (name: string) => string> = {
  oauth: (name) => `You sign in to ${name} in your browser, and agents act with your account’s access.`,
  token: (name) => `You paste a token or key you create in ${name}; agents act with what it allows.`,
  none: () => "Public: no sign-in needed.",
};

function AppPage({ entry, accounts, initialServerId }: { entry: McpCatalogEntry; accounts: McpServerSummary[]; initialServerId?: string }) {
  const [selected, setSelected] = useState<string | null>(initialServerId ?? null);
  const [adding, setAdding] = useState(false);
  const install = useStore(installs, (state) => state[entry.id] ?? null);
  const current = accounts.find((account) => account.id === selected) ?? accounts[0] ?? null;
  const hasFields = (entry.fields?.length ?? 0) > 0;

  return (
    <div className="app-page">
      <div className="app-page__head">
        <AppLogo entry={entry} size={48} />
        <div className="app-page__title">
          <h2>{entry.displayName}</h2>
          <div className="muted">
            {entry.publisher.displayName} · {entry.category}
          </div>
        </div>
        {accounts.length === 0 && !hasFields ? (
          <button type="button" className="button button--primary" disabled={install?.busy === true} onClick={() => void installApp(entry)}>
            {install?.busy === true ? "Adding…" : "Connect"}
          </button>
        ) : null}
      </div>
      <p className="app-page__description">{entry.description}</p>
      <p className="muted app-page__how">
        {HOW_IT_CONNECTS[entry.auth](entry.displayName)} Each tool asks before its first use.{" "}
        <button type="button" className="link-button" onClick={() => void main.openInBrowser({ url: entry.docsUrl })}>
          About {entry.displayName}’s MCP server
        </button>
        {" · "}
        <button type="button" className="link-button" onClick={() => void main.openInBrowser({ url: entry.websiteUrl })}>
          Website
        </button>
      </p>

      {accounts.length === 0 ? (
        hasFields ? (
          <CatalogFieldsForm entry={entry} submitLabel="Connect" busy={install?.busy === true} onSubmit={(values) => installApp(entry, { values }).then((id) => id != null)} />
        ) : null
      ) : (
        <>
          {accounts.length > 1 ? (
            <div className="segmented app-page__accounts" role="radiogroup" aria-label="Accounts">
              {accounts.map((account) => (
                <button key={account.id} type="button" role="radio" aria-checked={account.id === current?.id} className={account.id === current?.id ? "segmented--active" : ""} onClick={() => setSelected(account.id)}>
                  <span className={`status-dot status-dot--${account.status}`} /> {account.accountKey || "Unnamed"}
                </button>
              ))}
            </div>
          ) : null}
          {current != null ? <ServerManage key={current.id} server={current} entry={entry} /> : null}
          {adding ? (
            <AddAccountForm
              entry={entry}
              accounts={accounts}
              onDone={(id) => {
                setAdding(false);
                setSelected(id);
              }}
              onCancel={() => setAdding(false)}
            />
          ) : entry.auth !== "none" ? (
            <div>
              <button type="button" className="button button--small" onClick={() => setAdding(true)}>
                <Icon name="plus" size={12} /> Add another account
              </button>
            </div>
          ) : null}
        </>
      )}
      {install?.error != null ? <div className="form-error">{install.error}</div> : null}
    </div>
  );
}

/** The fields an app asks for (a token, say), with where to get them. */
export function CatalogFieldsForm({
  entry,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
  children,
}: {
  entry: McpCatalogEntry;
  submitLabel: string;
  busy: boolean;
  onSubmit(values: Record<string, string>): Promise<boolean>;
  onCancel?(): void;
  children?: ReactNode;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <form
      className="form app-fields"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim().length > 0))).then((done) => done && setValues({}));
      }}
    >
      {children}
      {(entry.fields ?? []).map((field) => (
        <label key={field.key}>
          {field.label}
          {field.isRequired ? "" : " (optional)"}
          <input
            type={field.isSecret ? "password" : "text"}
            className={field.isSecret ? "mono" : undefined}
            value={values[field.key] ?? ""}
            onChange={(event) => setValues((state) => ({ ...state, [field.key]: event.target.value }))}
            required={field.isRequired === true}
            placeholder={field.placeholder}
            autoComplete="off"
            spellCheck={false}
            maxLength={4000}
          />
          {field.hint != null || field.hintUrl != null ? (
            <span className="form-hint">
              {field.hint}{" "}
              {field.hintUrl != null ? (
                <button type="button" className="link-button" onClick={() => void main.openInBrowser({ url: field.hintUrl! })}>
                  Open {new URL(field.hintUrl).host}
                </button>
              ) : null}
            </span>
          ) : null}
        </label>
      ))}
      <div className="inline-form">
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? "Working…" : submitLabel}
        </button>
        {onCancel != null ? (
          <button type="button" className="button button--ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

function AddAccountForm({ entry, accounts, onDone, onCancel }: { entry: McpCatalogEntry; accounts: McpServerSummary[]; onDone(serverId: string): void; onCancel(): void }) {
  const [name, setName] = useState(`Account ${accounts.length + 1}`);
  const install = useStore(installs, (state) => state[entry.id] ?? null);
  const taken = accounts.some((account) => account.accountKey === name.trim());
  const add = async (values?: Record<string, string>) => {
    if (taken || name.trim().length === 0) return false;
    const id = await installApp(entry, { accountKey: name.trim(), ...(values != null ? { values } : {}) });
    if (id != null) onDone(id);
    return id != null;
  };
  const nameField = (
    <label>
      Account name
      <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={40} autoFocus />
      <span className="form-hint">{taken ? "Another account has this name." : `Agents see it beside ${entry.displayName}’s tools, so they can tell the accounts apart.`}</span>
    </label>
  );
  return (
    <div className="app-section">
      <h3>Add another account</h3>
      {entry.auth === "oauth" ? <p className="muted">Your browser signs in to {entry.displayName} as whoever is signed in there. To add a different account, switch accounts in the browser’s {entry.displayName} sign-in page, or sign out of {entry.displayName} there first.</p> : null}
      {(entry.fields?.length ?? 0) > 0 ? (
        <CatalogFieldsForm entry={entry} submitLabel="Add account" busy={install?.busy === true} onSubmit={add}>
          {nameField}
        </CatalogFieldsForm>
      ) : (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          {nameField}
          <div className="inline-form">
            <button type="submit" className="button button--primary" disabled={install?.busy === true || taken}>
              {install?.busy === true ? "Adding…" : "Add account"}
            </button>
            <button type="button" className="button button--ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function ServerPage({ server, onRemoved }: { server: McpServerSummary; onRemoved(): void }) {
  return (
    <div className="app-page">
      <div className="app-page__head">
        <AppLogo entry={null} size={48} />
        <div className="app-page__title">
          <h2>{server.name}</h2>
          <div className="muted mono app-page__address">{server.transport === "http" ? server.url : server.command}</div>
        </div>
      </div>
      <ServerManage server={server} entry={null} onRemoved={onRemoved} />
    </div>
  );
}

/** One server's account, tools and instructions. */
export function ServerManage({ server, entry, onRemoved }: { server: McpServerSummary; entry: McpCatalogEntry | null; onRemoved?(): void }) {
  return (
    <>
      <AccountCard server={server} entry={entry} onRemoved={onRemoved} />
      <section className="app-section" aria-label="Tools">
        <h3>Tools</h3>
        {server.status === "connected" ? (
          <McpToolList server={server} />
        ) : (
          <p className="muted">{server.enabled ? "The tools show here once it’s connected." : "Turned off in Settings → MCP servers."}</p>
        )}
      </section>
      <InstructionsEditor key={server.id} server={server} />
    </>
  );
}

function AccountCard({ server, entry, onRemoved }: { server: McpServerSummary; entry: McpCatalogEntry | null; onRemoved?(): void }) {
  const [mode, setMode] = useState<"view" | "rename" | "remove" | "token">("view");
  const [name, setName] = useState(server.accountKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const install = useStore(installs, (state) => (entry != null ? (state[entry.id] ?? null) : null));
  const run = async (action: () => Promise<McpState>, then?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      setMcpState(await action());
      setMode("view");
      then?.();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const tools = server.status === "connected" ? `${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}${server.disabledToolCount > 0 ? `, ${server.disabledToolCount} off` : ""}` : MCP_STATUS[server.status];

  return (
    <div className="mcp-server account-card">
      <div className="mcp-server__head">
        <span className={`status-dot status-dot--${server.status}`} />
        <span className="mcp-server__name">{entry?.plugin != null ? "Status" : entry != null ? server.accountKey || (entry.auth === "none" ? entry.displayName : "Your account") : "Server"}</span>
        <span className="muted">{tools}</span>
      </div>
      {server.statusDetail?.kind === "load_error" ? <div className="form-error">{server.statusDetail.technicalDetail}</div> : null}
      {server.transport === "http" && server.enabled ? <McpSignIn server={server} /> : null}

      {mode === "rename" ? (
        <form
          className="inline-form account-card__row"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => gateway.relabelMcpAccount({ serverId: server.id, accountKey: server.accountKey, newAccountKey: name.trim() }));
          }}
        >
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} autoFocus aria-label="Account name" placeholder="Work, Personal…" />
          <button type="submit" className="button button--primary button--small" disabled={busy}>
            Save
          </button>
          <button type="button" className="button button--ghost button--small" onClick={() => setMode("view")}>
            Cancel
          </button>
        </form>
      ) : mode === "remove" ? (
        <div className="account-card__row">
          <span>{entry != null ? `Remove ${serverLabel(server)}? Its sign-in and settings are deleted.` : `Remove ${server.name}?`}</span>
          <button
            type="button"
            className="button button--danger button--small"
            disabled={busy}
            onClick={() => void run(() => (entry != null ? gateway.dropMcpAccount({ serverId: server.id, accountKey: server.accountKey }) : gateway.dropMcpServer({ serverId: server.id })), onRemoved)}
          >
            Remove
          </button>
          <button type="button" className="button button--ghost button--small" onClick={() => setMode("view")}>
            Cancel
          </button>
        </div>
      ) : mode === "token" && entry != null ? (
        <CatalogFieldsForm
          entry={entry}
          submitLabel="Save"
          busy={install?.busy === true}
          onSubmit={async (values) => {
            installs.set((state) => ({ ...state, [entry.id]: { busy: true, error: null } }));
            try {
              const result = await gateway.connectCatalogApp({ entryId: entry.id, values, serverId: server.id });
              setMcpState(result);
              installs.set((state) => ({ ...state, [entry.id]: { busy: false, error: null } }));
              setMode("view");
              return true;
            } catch (cause) {
              installs.set((state) => ({ ...state, [entry.id]: { busy: false, error: errorText(cause) } }));
              return false;
            }
          }}
        />
      ) : entry?.plugin != null ? null : (
        <div className="account-card__row">
          {entry != null && entry.auth !== "none" ? (
            <button type="button" className="button button--ghost button--small" onClick={() => (setName(server.accountKey), setMode("rename"))}>
              <Icon name="edit" size={12} /> {server.accountKey ? "Rename" : "Name this account"}
            </button>
          ) : null}
          {entry != null && (entry.fields?.length ?? 0) > 0 ? (
            <button type="button" className="button button--ghost button--small" onClick={() => setMode("token")}>
              <Icon name="refresh" size={12} /> {entry.auth === "token" ? "Replace token" : "Change settings"}
            </button>
          ) : null}
          <button type="button" className="button button--ghost button--small" onClick={() => setMode("remove")}>
            <Icon name="trash" size={12} /> Remove
          </button>
        </div>
      )}
      {error != null ? <div className="form-error">{error}</div> : null}
    </div>
  );
}

/** Sign in, the browser wait with Cancel, or Signed in with Sign out, for a remote server. */
export function McpSignIn({ server }: { server: McpServerSummary }) {
  const progress = useStore(mcpSignIns, (all) => all[server.id] ?? null);
  const error = progress?.error != null ? <div className="form-error">{progress.error}</div> : null;
  if (server.status === "needsAuth" || progress?.pending === "sign-in") {
    const waiting = progress?.pending === "sign-in";
    return (
      <div className="mcp-server__auth">
        <span className="muted">{waiting ? "Finish signing in in your browser." : "This server needs you to sign in before agents can use its tools."}</span>
        <div className="inline-form">
          <button type="button" className="button button--primary" disabled={waiting} onClick={() => void signInToMcpServer(server.id)}>
            {waiting ? "Waiting for the browser…" : "Sign in"}
          </button>
          {waiting ? (
            <button type="button" className="button button--ghost" onClick={() => void main.cancelMcpSignIn({ serverId: server.id })}>
              Cancel
            </button>
          ) : null}
        </div>
        {error}
      </div>
    );
  }
  if (!server.signedIn) return error;
  return (
    <div className="mcp-server__auth">
      <span className="muted">Signed in.</span>
      <button type="button" className="button button--ghost" disabled={progress?.pending === "sign-out"} onClick={() => void signOutOfMcpServer(server.id)}>
        {progress?.pending === "sign-out" ? "Signing out…" : "Sign out"}
      </button>
      {error}
    </div>
  );
}

/** The server's tools, each with a switch: a tool switched off is never offered to agents. */
export function McpToolList({ server }: { server: McpServerSummary }) {
  const [tools, setTools] = useState<McpServerTool[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void gateway
      .mcpServerTools({ serverId: server.id })
      .then((list) => current && setTools(list))
      .catch(() => current && setTools([]));
    return () => {
      current = false;
    };
  }, [server.id, server.toolCount, server.disabledToolCount]);
  if (tools == null) return <p className="muted">Loading…</p>;
  if (tools.length === 0) return <p className="muted">This server has no tools.</p>;
  const on = tools.filter((tool) => !tool.isDisabled).length;
  return (
    <>
      <p className="muted tool-switches__count">
        {on} of {tools.length} on. Agents are never offered a tool you switch off.
      </p>
      <ul className="tool-switches">
        {tools.map((tool) => (
          <li key={tool.name} className={tool.isDisabled ? "tool-switches__off" : undefined}>
            <label className="switch">
              <input
                type="checkbox"
                checked={!tool.isDisabled}
                aria-label={`${tool.title ?? tool.name}: offer to agents`}
                onChange={() => {
                  setError(null);
                  gateway.switchMcpTool({ serverId: server.id, toolName: tool.name }).then(setTools, (cause) => setError(errorText(cause)));
                }}
              />
              <span />
            </label>
            <span className="tool-switches__text">
              <span className="tool-switches__name">
                <span className="mono">{tool.name}</span>
                {tool.isReadOnly === true ? <span className="risk risk--read-only">read-only</span> : null}
              </span>
              {tool.description.length > 0 ? <span className="tool-switches__description">{tool.title != null && tool.title !== tool.name ? `${tool.title}: ` : ""}{tool.description}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {error != null ? <div className="form-error">{error}</div> : null}
    </>
  );
}

function InstructionsEditor({ server }: { server: McpServerSummary }) {
  const [text, setText] = useState(server.customInstructions);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const changed = text.trim() !== server.customInstructions;
  return (
    <section className="app-section" aria-label="Instructions for agents">
      <h3>Instructions for agents</h3>
      <form
        className="form"
        onSubmit={async (event) => {
          event.preventDefault();
          setState("saving");
          setError(null);
          try {
            setMcpState(await gateway.changeAppInstructions({ serverId: server.id, instructions: text }));
            setState("saved");
          } catch (cause) {
            setError(errorText(cause));
            setState("idle");
          }
        }}
      >
        <textarea
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setState("idle");
          }}
          rows={3}
          maxLength={4000}
          aria-label="Instructions for agents"
          placeholder={`How agents should use ${serverLabel(server)}, e.g. which project or team to work in`}
        />
        <p className="form-hint form-hint--attached">Added to your agents’ instructions while this app’s tools are available to them.</p>
        <div className="inline-form">
          <button type="submit" className="button button--small" disabled={!changed || state === "saving"}>
            {state === "saving" ? "Saving…" : "Save"}
          </button>
          {state === "saved" && !changed ? <span className="muted app-section__saved">Saved</span> : null}
        </div>
        {error != null ? <div className="form-error">{error}</div> : null}
      </form>
    </section>
  );
}

const DEFAULT_MCP_COMMAND = '{\n  "command": "npx",\n  "args": ["-y", "@modelcontextprotocol/server-everything"]\n}';

/** Adds a server by its address (and headers) or a JSON config; `onAdded` gets the new server's id. */
export function AddMcpServer({ onAdded }: { onAdded?(serverId: string): void }) {
  const [kind, setKind] = useState<"url" | "json">("url");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [config, setConfig] = useState(DEFAULT_MCP_COMMAND);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** The URL form as the JSON addMcpServer takes: `https://` is assumed, headers are "Name: value" lines. */
  const configJson = (): string => {
    if (kind === "json") return config;
    const address = url.trim();
    const parsed: Record<string, string> = {};
    for (const line of headers.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const colon = line.indexOf(":");
      if (colon <= 0) throw new Error(`“${line.trim()}” isn't a header. Write one per line, like Authorization: Bearer …`);
      parsed[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
    return JSON.stringify({ url: /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `https://${address}`, headers: parsed });
  };

  return (
    <form
      className="form"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        setBusy(true);
        try {
          const before = new Set(mcpServers.get().servers.map((server) => server.id));
          const state = await gateway.addMcpServer({ name: name.trim(), configJson: configJson() });
          setMcpState(state);
          setName("");
          setUrl("");
          setHeaders("");
          const added = state.servers.find((server) => !before.has(server.id));
          if (added != null) onAdded?.(added.id);
        } catch (cause) {
          setError(errorText(cause));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Add a server</h3>
      <div className="segmented" role="radiogroup" aria-label="How to add the server">
        <button type="button" role="radio" aria-checked={kind === "url"} className={kind === "url" ? "segmented--active" : ""} onClick={() => setKind("url")}>
          Remote URL
        </button>
        <button type="button" role="radio" aria-checked={kind === "json"} className={kind === "json" ? "segmented--active" : ""} onClick={() => setKind("json")}>
          JSON config
        </button>
      </div>
      <label>
        Name
        <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} placeholder={kind === "url" ? "linear" : "everything"} />
      </label>
      {kind === "url" ? (
        <>
          <label>
            Server URL
            <input className="mono" value={url} onChange={(event) => setUrl(event.target.value)} required placeholder="https://mcp.example.com/mcp" autoComplete="off" />
          </label>
          <label>
            Headers (optional, one per line)
            <textarea className="mono" value={headers} onChange={(event) => setHeaders(event.target.value)} rows={2} placeholder="Authorization: Bearer …" />
          </label>
          <p className="muted">A server that wants you to sign in shows a Sign in button once it’s added. An Authorization header is used instead of signing in.</p>
        </>
      ) : (
        <label>
          Config (JSON: command, args, env for a local server; url, headers, oauth for a remote one; or an mcpServers block)
          <textarea className="mono" value={config} onChange={(event) => setConfig(event.target.value)} rows={6} />
        </label>
      )}
      {error != null ? <div className="form-error">{error}</div> : null}
      <div>
        <button type="submit" className="button button--primary" disabled={busy}>
          Add server
        </button>
      </div>
    </form>
  );
}
