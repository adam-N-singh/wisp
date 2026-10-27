// Bot templates in the UI, and the "Add Bot" overlay.
// Share as template, from an agent's menu, picks what the agent's next template version includes,
// lists the versions, saves or copies one as a file, and publishes one for a link. Add Bot opens a
// template from a file, a link, pasted text or a deep link and shows everything it would add (the
// instructions, each skill and routine in full, the memories and the apps it names) before the user
// confirms; only then does the box create the agent (addAgentFromTemplate). Connect Apps' Bot
// templates tab lists the starter gallery and the user's own templates.
import { type ReactNode, useEffect, useMemo, useState } from "react";
// The box's cron helpers are plain functions: a routine's schedule is described from its cron, not from what the template says about it.
import { describeCron, isValidCron } from "../../box/cron";
import {
  type BotMarketplace,
  type BotMarketplaceListing,
  type BotTemplate,
  type BotTemplateView,
  botTemplateLink,
  type CreateAgentFromTemplateResult,
  type FetchedBotTemplate,
  MAX_TEMPLATE_BYTES,
  parseBotTemplate,
  SHARE_ID_PATTERN,
  templateUrlAllowed,
} from "../../shared/bot-template";
import type { BotTemplateSource, BoxLocationState } from "../../shared/edges";
import { type AvatarColor, type AvatarShape, type McpCatalogEntry, type McpServerSummary, skillCommand } from "../../shared/model";
import { gateway, main } from "../bridge";
import { closeDialog, openConnectApps, openDialog, selectAgent } from "../store/app";
import { automations, loadAutomations, loadMcpCatalog, loadMcpServers, loadMemories, loadSkills, mcpCatalog, mcpServers, memories, skills } from "../store/agent-data";
import { openInfoTab } from "../store/layout";
import { allAgents, roster, upsertAgent } from "../store/roster";
import { useStore } from "../store/store";
import { deliverMessage } from "../store/transcripts";
import { Modal } from "./AgentDialog";
import { Avatar } from "./Avatar";
import { Icon } from "./icons";

/** A gateway error without its method or failure-code prefix. */
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message.replace(/^[\w/-]+: /, "") : String(cause));
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const firstLine = (text: string) => text.trim().split("\n")[0].slice(0, 140);

function Section({ title, count, hint, children }: { title: string; count?: number; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="template-section">
      <h3 className="template-section__title">
        {title}
        {count != null ? <span className="template-section__count">{count}</span> : null}
      </h3>
      {hint != null ? <p className="form-hint">{hint}</p> : null}
      {children}
    </section>
  );
}

/** A ticked or unticked item: its title, a line about it, and optionally its full text. */
function Check({ checked, onChange, disabled = false, title, detail, children }: { checked: boolean; onChange(checked: boolean): void; disabled?: boolean; title: ReactNode; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`template-check${disabled ? " template-check--disabled" : ""}`}>
      <label className="template-check__row">
        <input type="checkbox" checked={checked && !disabled} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
        <span className="template-check__text">
          <span className="template-check__title">{title}</span>
          {detail != null ? <span className="template-check__detail">{detail}</span> : null}
        </span>
      </label>
      {children}
    </div>
  );
}

/** Connect Apps apps that are added and switched on, once each (an app's several accounts are one app to connect). */
function connectedApps(servers: McpServerSummary[], entries: McpCatalogEntry[]): Array<{ pluginId: string; name: string }> {
  const apps = new Map<string, string>();
  for (const server of servers) {
    // A marketplace plugin's servers ("<plugin>@<marketplace>") come with the plugin, not with a template.
    if (server.pluginId != null && !server.pluginId.includes("@") && server.enabled && !apps.has(server.pluginId)) apps.set(server.pluginId, entries.find((entry) => entry.id === server.pluginId)?.displayName ?? server.name);
  }
  return [...apps].map(([pluginId, name]) => ({ pluginId, name }));
}

/** Where an app a template names stands on this box. */
function appState(pluginId: string, servers: McpServerSummary[], entries: McpCatalogEntry[]): { label: string; canConnect: boolean } {
  const accounts = servers.filter((server) => server.pluginId === pluginId);
  if (accounts.some((server) => server.status === "connected")) return { label: "Connected", canConnect: false };
  if (accounts.length > 0) return { label: "Added, not connected", canConnect: true };
  if (entries.some((entry) => entry.id === pluginId)) return { label: "Not connected yet", canConnect: true };
  return { label: entries.length > 0 ? "Not in Connect Apps" : "", canConnect: false };
}

// ---- Share as template ----------------------------------------------------------------

export function ShareTemplateDialog({ agentId }: { agentId: string }) {
  const agent = useStore(roster, (state) => allAgents(state).find((candidate) => candidate.id === agentId));
  const everySkill = useStore(skills, (state) => state[agentId]);
  // Plugins' skills come with their plugins, not with the agent.
  const agentSkills = useMemo(() => everySkill?.filter((skill) => skill.source !== "plugin"), [everySkill]);
  const agentAutomations = useStore(automations, (state) => state[agentId]);
  const agentMemories = useStore(memories, (state) => state[agentId]);
  const { servers } = useStore(mcpServers);
  const catalog = useStore(mcpCatalog);
  /** undefined while it loads; null when the agent has no template yet. */
  const [template, setTemplate] = useState<BotTemplateView | null | undefined>(undefined);
  const [box, setBox] = useState<BoxLocationState | null>(null);
  const [policy, setPolicy] = useState("all");
  const [useBody, setUseBody] = useState(true);
  /** Skills, routines and apps are in unless left out ("skill:<id>", "routine:<id>", "app:<id>"); memories are out unless picked. */
  const [leftOut, setLeftOut] = useState<Set<string>>(new Set());
  const [memoryIds, setMemoryIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    void loadSkills(agentId);
    void loadAutomations(agentId);
    void loadMemories(agentId);
    void loadMcpServers();
    void loadMcpCatalog();
    gateway.agentTemplate({ sourceAgentId: agentId }).then(setTemplate, (cause) => {
      setTemplate(null);
      setError(errorText(cause));
    });
    gateway.templateExportRules({}).then((reply) => setPolicy(reply.exportPolicy ?? "all"), () => undefined);
    main.getBoxLocation().then(setBox, () => undefined);
  }, [agentId]);

  const apps = useMemo(() => connectedApps(servers, catalog.entries), [servers, catalog.entries]);
  if (agent == null) return null;
  const hasInstructions = agent.instructions.trim().length > 0;
  // A memory the agent asked to add and the user hasn't approved isn't one yet.
  const inEffect = (agentMemories ?? []).filter((memory) => memory.review?.action !== "add");
  const toggle = (setter: typeof setLeftOut, key: string, on: boolean) =>
    setter((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const include = {
    body: useBody && hasInstructions,
    skillIds: (agentSkills ?? []).filter((skill) => !leftOut.has(`skill:${skill.id}`)).map((skill) => skill.id),
    automationIds: (agentAutomations ?? []).filter((automation) => !leftOut.has(`routine:${automation.id}`)).map((automation) => automation.id),
    memoryIds: inEffect.filter((memory) => memoryIds.has(memory.id)).map((memory) => memory.id),
    pluginIds: apps.filter((app) => !leftOut.has(`app:${app.pluginId}`)).map((app) => app.pluginId),
  };

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };
  /** A version with what's ticked: the latest one again when nothing changed since it was made. */
  const current = async () => {
    const view = await gateway.createBotTemplateVersion({ sourceAgentId: agentId, include });
    setTemplate(view);
    return view;
  };
  const versionFile = async (version?: number) => {
    const view = version == null || template == null ? await current() : template;
    return gateway.readTemplateVersion({ shareId: view.shareId, version: version ?? view.version });
  };
  const saveFile = (version?: number) =>
    run("save", async () => {
      const file = await versionFile(version);
      const path = await main.saveBotTemplateFile({ template: file });
      if (path != null) setNotice(`Saved version ${file.version} to ${path}.`);
    });
  const copy = (version?: number) =>
    run("copy", async () => {
      const file = await versionFile(version);
      await navigator.clipboard.writeText(`${JSON.stringify(file, null, 2)}\n`);
      setNotice(`Copied version ${file.version}. Whoever gets it pastes it into Add Bot.`);
    });
  const publish = (version: number) => run("publish", async () => setTemplate(await gateway.shareTemplate({ shareId: template!.shareId, version })));
  const setLink = (on: boolean) =>
    run("link", async () => {
      let view = template ?? (await current());
      if (on && view.activeVersion == null) view = await gateway.shareTemplate({ shareId: view.shareId, version: view.version });
      setTemplate(await gateway.changeTemplateSharing({ shareId: view.shareId, visibility: on ? "public" : "team" }));
    });
  const remove = () =>
    run("delete", async () => {
      await gateway.removeTemplate({ shareId: template!.shareId });
      setTemplate(null);
      setConfirmDelete(false);
      setNotice("Deleted the template and its versions. Its link stops working; files you saved still open.");
    });

  if (policy !== "all") {
    return (
      <Modal title={`Share ${agent.name} as a template`} onClose={closeDialog}>
        <p className="muted">Sharing bots as templates is turned off on this box.</p>
        <div className="modal__actions">
          <button type="button" className="button button--primary" onClick={closeDialog}>
            Close
          </button>
        </div>
      </Modal>
    );
  }

  const linkLive = template != null && template.published && template.visibility === "public" && template.activeVersion != null;
  const remote = box?.location === "remote" && box.remoteUrl.length > 0;
  const link = template == null ? null : remote ? `${box!.remoteUrl.replace(/\/+$/, "")}/t/${template.shareId}` : botTemplateLink({ shareId: template.shareId });

  return (
    <Modal title={`Share ${agent.name} as a template`} onClose={closeDialog} wide className="template-dialog">
      <p className="muted template-dialog__intro">
        A template is a copy of this agent’s setup that someone adds as a bot of their own. It doesn’t change when you edit this agent, and no conversation, files, accounts or tokens go with it.
      </p>

      <Section title="What it includes">
        <div className="template-profile">
          <Avatar shape={agent.avatarShape} color={agent.avatarColor} size={36} image={agent.avatarDataUrl} />
          <span className="template-profile__text">
            <span className="template-check__title">{agent.name}</span>
            <span className="template-check__detail">{agent.description || "No role"}</span>
          </span>
          <span className="muted template-profile__always">Name, role and look: always</span>
        </div>
        <Check checked={useBody} onChange={setUseBody} disabled={!hasInstructions} title="Instructions" detail={hasInstructions ? firstLine(agent.instructions) : "This agent has no instructions."} />
      </Section>

      {(agentSkills ?? []).length > 0 ? (
        <Section title="Skills" count={agentSkills!.length}>
          {agentSkills!.map((skill) => (
            <Check key={skill.id} checked={!leftOut.has(`skill:${skill.id}`)} onChange={(on) => toggle(setLeftOut, `skill:${skill.id}`, !on)} title={skill.name} detail={skill.description} />
          ))}
        </Section>
      ) : null}

      {(agentAutomations ?? []).length > 0 ? (
        <Section title="Routines" count={agentAutomations!.length} hint="Automations go in as routines. They arrive switched off, whatever they are here.">
          {agentAutomations!.map((automation) => (
            <Check key={automation.id} checked={!leftOut.has(`routine:${automation.id}`)} onChange={(on) => toggle(setLeftOut, `routine:${automation.id}`, !on)} title={automation.name} detail={`${automation.triggerDescription} · ${firstLine(automation.prompt)}`} />
          ))}
        </Section>
      ) : null}

      {inEffect.length > 0 ? (
        <Section title="Memories" count={inEffect.length} hint="What this agent learned about you. Leave them out unless whoever gets the template should know them.">
          {inEffect.map((memory) => (
            <Check key={memory.id} checked={memoryIds.has(memory.id)} onChange={(on) => toggle(setMemoryIds, memory.id, on)} title={memory.text} />
          ))}
        </Section>
      ) : null}

      {apps.length > 0 ? (
        <Section title="Apps to connect" count={apps.length} hint="Only each app’s name goes in; whoever adds the bot connects their own account.">
          {apps.map((app) => (
            <Check key={app.pluginId} checked={!leftOut.has(`app:${app.pluginId}`)} onChange={(on) => toggle(setLeftOut, `app:${app.pluginId}`, !on)} title={app.name} />
          ))}
        </Section>
      ) : null}

      <div className="template-dialog__save">
        <span className="muted">{template == null ? "Saving makes version 1." : `Saving makes version ${template.version + 1}, unless nothing changed since version ${template.version}.`}</span>
        <button type="button" className="button" disabled={busy != null || template === undefined} onClick={() => void copy()}>
          <Icon name="copy" size={14} /> {busy === "copy" ? "Copying…" : "Copy"}
        </button>
        <button type="button" className="button button--primary" disabled={busy != null || template === undefined} onClick={() => void saveFile()}>
          <Icon name="download" size={14} /> {busy === "save" ? "Saving…" : "Save file…"}
        </button>
      </div>
      {error != null ? <div className="form-error">{error}</div> : null}
      {notice != null ? (
        <div className="template-notice" role="status">
          {notice}
        </div>
      ) : null}

      {template != null ? (
        <>
          <Section title="Versions" count={template.versions.length}>
            <ul className="template-versions">
              {[...template.versions].reverse().map((info) => (
                <li key={info.version} className="template-version">
                  <span className="template-version__name">Version {info.version}</span>
                  <span className="muted">{when(info.createdAtMs)}</span>
                  {template.activeVersion === info.version ? <span className="template-badge">Published</span> : null}
                  <span className="template-version__actions">
                    <button type="button" className="button button--small button--ghost" disabled={busy != null} onClick={() => void saveFile(info.version)}>
                      Save file…
                    </button>
                    <button type="button" className="button button--small button--ghost" disabled={busy != null} onClick={() => void copy(info.version)}>
                      Copy
                    </button>
                    {template.activeVersion !== info.version ? (
                      <button type="button" className="button button--small button--ghost" disabled={busy != null} onClick={() => void publish(info.version)}>
                        Publish
                      </button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Link">
            <div className="settings-row template-link">
              <div className="settings-row__text">
                <div className="settings-row__title">Anyone with the link can add it</div>
                <div className="settings-row__description">
                  {linkLive ? `The link serves version ${template.activeVersion}, everything in it included. Publish another version to change what it serves.` : "Your box serves the published version at a link of its own."}
                </div>
              </div>
              <label className="switch settings-row__control">
                <input type="checkbox" checked={linkLive} disabled={busy != null} aria-label="Anyone with the link can add it" onChange={(event) => void setLink(event.target.checked)} />
                <span />
              </label>
            </div>
            {linkLive && link != null ? (
              <div className="template-link__address">
                <code>{link}</code>
                <button
                  type="button"
                  className="button button--small"
                  onClick={() =>
                    void navigator.clipboard.writeText(link).then(
                      () => setNotice("Copied the link."),
                      (cause) => setError(errorText(cause)),
                    )
                  }
                >
                  <Icon name="copy" size={12} /> Copy link
                </button>
              </div>
            ) : null}
            {linkLive && !remote ? <p className="form-hint">Your box runs on this PC, so the link opens the template only here. To share it with others, save the file and send it, put it at any https:// address, or run your box on a server (Settings → Box).</p> : null}
          </Section>
        </>
      ) : null}

      <div className="modal__actions template-dialog__actions">
        {template != null ? (
          <button type="button" className={`button ${confirmDelete ? "button--danger" : "button--ghost"}`} disabled={busy != null} onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}>
            <Icon name="trash" size={14} /> {confirmDelete ? "Delete every version?" : "Delete template"}
          </button>
        ) : null}
        <span className="grow" />
        <button type="button" className="button button--primary" onClick={closeDialog}>
          Done
        </button>
      </div>
    </Modal>
  );
}

// ---- Add Bot ------------------------------------------------------------------------------

/** What a pasted line names: an https address, or a wisp://bot-template link. */
function pastedSource(text: string): BotTemplateSource | null {
  if (templateUrlAllowed(text)) return { url: text };
  try {
    const url = new URL(text);
    if (url.protocol !== "wisp:" || url.hostname !== "bot-template") return null;
    const id = url.searchParams.get("id");
    const address = url.searchParams.get("url");
    if (id != null && SHARE_ID_PATTERN.test(id)) return { shareId: id };
    if (address != null && templateUrlAllowed(address)) return { url: address };
  } catch {
    // not an address
  }
  return null;
}

/** `sourceLabel` names where the preview says a template from `source` comes from (the starter gallery). */
export function AddBotDialog({ source, sourceLabel }: { source?: BotTemplateSource; sourceLabel?: string }) {
  const [fetched, setFetched] = useState<FetchedBotTemplate | null>(null);
  const [loading, setLoading] = useState(source != null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateAgentFromTemplateResult | null>(null);

  const load = async (get: () => Promise<FetchedBotTemplate | null>) => {
    setLoading(true);
    setError(null);
    try {
      const found = await get();
      if (found != null) setFetched(found);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (source != null) void load(async () => ({ ...(await main.fetchSharedTemplate(source)), ...(sourceLabel != null ? { source: sourceLabel } : {}) }));
  }, [source, sourceLabel]);

  return (
    <Modal title={result != null ? "Bot added" : fetched != null ? "Add bot" : "Add a bot from a template"} onClose={closeDialog} wide className="template-dialog">
      {result != null ? (
        <AddBotDone result={result} />
      ) : fetched != null ? (
        <TemplatePreview
          fetched={fetched}
          onBack={() => {
            setFetched(null);
            setError(null);
          }}
          onAdded={setResult}
        />
      ) : (
        <TemplatePicker loading={loading} error={error} setError={setError} onLoad={load} onParsed={setFetched} />
      )}
    </Modal>
  );
}

function TemplatePicker({
  loading,
  error,
  setError,
  onLoad,
  onParsed,
}: {
  loading: boolean;
  error: string | null;
  setError(error: string | null): void;
  onLoad(get: () => Promise<FetchedBotTemplate | null>): Promise<void>;
  onParsed(fetched: FetchedBotTemplate): void;
}) {
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const parsed = (raw: string, from: string) => {
    const read = parseBotTemplate(raw);
    if ("error" in read) setError(read.error);
    else onParsed({ ...read, source: from });
  };
  const submit = () => {
    const value = text.trim();
    if (value.startsWith("{")) return parsed(value, "pasted text");
    const from = pastedSource(value);
    if (from == null) return setError("Paste an https:// link to a template, a wisp://bot-template link, or the template itself.");
    void onLoad(() => main.fetchSharedTemplate(from));
  };
  const dropped = async (file: File) => {
    if (file.size > MAX_TEMPLATE_BYTES) return setError("That file is larger than 1 MiB.");
    parsed(await file.text(), file.name);
  };

  return (
    <div
      className={`template-picker${dragging ? " template-picker--dragging" : ""}`}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file != null) void dropped(file);
      }}
    >
      <p className="muted">Add a bot someone shared with you: their template file, a link to it, or the template they copied. You’ll see everything in it before anything is added.</p>
      <button type="button" className="button template-picker__open" disabled={loading} onClick={() => void onLoad(() => main.openBotTemplateFile())}>
        <Icon name="file" size={14} /> Open a template file…
      </button>
      <label className="template-picker__paste">
        Link or template
        <textarea
          value={text}
          rows={3}
          spellCheck={false}
          placeholder="https://… or paste the template"
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
        />
      </label>
      <p className="form-hint">You can also drop a template file here.</p>
      {error != null ? <div className="form-error">{error}</div> : null}
      <div className="modal__actions">
        <button type="button" className="button button--ghost" onClick={closeDialog}>
          Cancel
        </button>
        <button type="button" className="button button--primary" disabled={loading || text.trim().length === 0} onClick={submit}>
          {loading ? "Opening…" : "Preview"}
        </button>
      </div>
    </div>
  );
}

/** Why a routine can't be added, or null. */
const routineProblem = (schedule: string | undefined) =>
  schedule == null || schedule.trim().length === 0 ? "It has no schedule, so it can’t be added." : !isValidCron(schedule) ? `Its schedule “${schedule}” isn’t a cron schedule, so it can’t be added.` : null;

function TemplatePreview({ fetched, onBack, onAdded }: { fetched: FetchedBotTemplate; onBack(): void; onAdded(result: CreateAgentFromTemplateResult): void }) {
  const template = fetched.template;
  const { servers } = useStore(mcpServers);
  const catalog = useStore(mcpCatalog);
  const [name, setName] = useState(template.name);
  const [useBody, setUseBody] = useState(template.body.trim().length > 0);
  /** Items left out: "skill:<index>", "routine:<index>", "memory:<index>". */
  const [leftOut, setLeftOut] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void loadMcpServers();
    void loadMcpCatalog();
  }, []);

  const kept = (key: string) => !leftOut.has(key);
  const keep = (key: string, on: boolean) =>
    setLeftOut((current) => {
      const next = new Set(current);
      if (on) next.delete(key);
      else next.add(key);
      return next;
    });
  const skillList = template.skills ?? [];
  const routineList = template.routines ?? [];
  const memoryList = template.memory ?? [];
  const pluginList = template.plugins ?? [];

  const add = async () => {
    setBusy(true);
    setError(null);
    const chosen: BotTemplate = {
      ...template,
      body: useBody ? template.body : "",
      skills: skillList.filter((_, index) => kept(`skill:${index}`)),
      routines: routineList.filter((routine, index) => kept(`routine:${index}`) && routineProblem(routine.schedule) == null),
      memory: memoryList.filter((_, index) => kept(`memory:${index}`)),
    };
    try {
      const result = await gateway.addAgentFromTemplate({ template: chosen, name: name.trim() });
      upsertAgent(result.agent);
      onAdded(result);
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };

  return (
    <div className="template-preview">
      <div className="template-preview__head">
        <Avatar shape={template.avatarShape as AvatarShape} color={template.avatarColor as AvatarColor} size={56} image={template.avatarDataUrl} />
        <div className="grow template-preview__identity">
          <label className="template-preview__name">
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required />
          </label>
          {template.title ? <div className="template-check__detail">{template.title}</div> : null}
          {template.description ? <p className="template-preview__role">{template.description}</p> : null}
          <div className="template-check__detail">
            From {fetched.source}
            {template.version != null ? ` · version ${template.version}` : ""}
            {template.creatorName ? ` · by ${template.creatorName}` : ""}
          </div>
        </div>
      </div>

      <div className="template-warning" role="note">
        <Icon name="shield" size={16} />
        <div>
          <strong>Read what it brings before you add it.</strong> Its instructions, skills and memories become part of what the bot reads, so they can tell it what to do. Routines arrive switched off: turn each one on in Automations once you’ve read it.
          {fetched.hiddenCharacters > 0 ? <div className="template-warning__hidden">{plural(fetched.hiddenCharacters, "character")} that wouldn’t show here {fetched.hiddenCharacters === 1 ? "was" : "were"} taken out of its text.</div> : null}
        </div>
      </div>

      <Section title="Instructions">
        {template.body.trim().length > 0 ? (
          <Check checked={useBody} onChange={setUseBody} title="Use these instructions">
            <pre className="template-text">{template.body}</pre>
          </Check>
        ) : (
          <p className="muted">None.</p>
        )}
      </Section>

      {skillList.length > 0 ? (
        <Section title="Skills" count={skillList.length}>
          {skillList.map((skill, index) => (
            <Check
              key={index}
              checked={kept(`skill:${index}`)}
              onChange={(on) => keep(`skill:${index}`, on)}
              title={skill.name}
              detail={
                <>
                  {skill.description}
                  {skill.schedule != null && isValidCron(skill.schedule) ? <span className="template-check__meta">Runs on a schedule ({describeCron(skill.schedule)}), added switched off</span> : null}
                </>
              }
            >
              <details className="template-details">
                <summary>Show the skill ({plural(skill.content.split("\n").length, "line")})</summary>
                <pre className="template-text">{skill.content}</pre>
              </details>
            </Check>
          ))}
        </Section>
      ) : null}

      {routineList.length > 0 ? (
        <Section title="Routines" count={routineList.length} hint="Each sends the bot its prompt on a schedule, once you switch it on.">
          {routineList.map((routine, index) => {
            const problem = routineProblem(routine.schedule);
            return (
              <Check
                key={index}
                checked={kept(`routine:${index}`)}
                disabled={problem != null}
                onChange={(on) => keep(`routine:${index}`, on)}
                title={routine.name}
                detail={problem ?? <span className="template-check__meta">{describeCron(routine.schedule!)} · added switched off</span>}
              >
                <pre className="template-text template-text--short">{routine.content}</pre>
              </Check>
            );
          })}
        </Section>
      ) : null}

      {memoryList.length > 0 ? (
        <Section title="Memories" count={memoryList.length} hint="What the bot will remember from the start, as if you had told it.">
          {memoryList.map((memory, index) => (
            <Check key={index} checked={kept(`memory:${index}`)} onChange={(on) => keep(`memory:${index}`, on)} title={memory.content} />
          ))}
        </Section>
      ) : null}

      {pluginList.length > 0 ? (
        <Section title="Apps to connect" count={pluginList.length} hint="The template only names these apps. Connect them with your own accounts once the bot is added.">
          <ul className="template-apps">
            {pluginList.map((plugin) => (
              <li key={plugin.pluginId}>
                <span className="template-check__title">{plugin.name}</span>
                <span className="muted">{appState(plugin.pluginId, servers, catalog.entries).label}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {error != null ? <div className="form-error">{error}</div> : null}
      <div className="modal__actions">
        <button type="button" className="button button--ghost" onClick={onBack}>
          Back
        </button>
        <span className="grow" />
        <button type="button" className="button button--ghost" onClick={closeDialog}>
          Cancel
        </button>
        <button type="button" className="button button--primary" disabled={busy || name.trim().length === 0} onClick={() => void add()}>
          {busy ? "Adding…" : "Add bot"}
        </button>
      </div>
    </div>
  );
}

function AddBotDone({ result }: { result: CreateAgentFromTemplateResult }) {
  const { agent, setup } = result;
  const { servers } = useStore(mcpServers);
  const catalog = useStore(mcpCatalog);
  const open = (then?: () => void) => {
    closeDialog();
    selectAgent(agent.id);
    then?.();
  };
  const summary = [plural(setup.skills.length, "skill"), `${plural(setup.automations.length, "routine")}${setup.automations.length > 0 ? " (switched off)" : ""}`, plural(setup.memories.length, "memory", "memories")];
  return (
    <div className="template-preview">
      <div className="template-preview__head">
        <Avatar shape={agent.avatarShape} color={agent.avatarColor} size={56} image={agent.avatarDataUrl} />
        <div className="grow">
          <div className="template-check__title">{agent.name} is ready.</div>
          <div className="template-check__detail">{summary.join(" · ")}</div>
        </div>
      </div>
      {setup.automations.length > 0 ? (
        <p className="muted">
          Its routines don’t run until you switch them on.{" "}
          <button type="button" className="link-button" onClick={() => open(() => openInfoTab("automations"))}>
            Review them in Automations
          </button>
        </p>
      ) : null}
      {setup.skipped.length > 0 ? (
        <Section title="Not added" count={setup.skipped.length}>
          <ul className="template-apps">
            {setup.skipped.map((item, index) => (
              <li key={index}>
                <span className="template-check__title">{item.name}</span>
                <span className="muted">{item.reason}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {setup.plugins.length > 0 ? (
        <Section title="Apps to connect" count={setup.plugins.length}>
          <ul className="template-apps">
            {setup.plugins.map((plugin) => {
              const state = appState(plugin.pluginId, servers, catalog.entries);
              return (
                <li key={plugin.pluginId}>
                  <span className="template-check__title">{plugin.name}</span>
                  <span className="muted">{state.label}</span>
                  {state.canConnect ? (
                    <button
                      type="button"
                      className="button button--small"
                      onClick={() => {
                        selectAgent(agent.id);
                        openConnectApps({ appId: plugin.pluginId });
                      }}
                    >
                      Connect
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}
      <div className="modal__actions">
        {setup.gettingStartedSkill != null ? (
          <button type="button" className="button" onClick={() => open(() => deliverMessage(agent.id, `/${skillCommand(setup.gettingStartedSkill!)}`, []))}>
            <Icon name="play" size={14} /> Run “{setup.gettingStartedSkill}”
          </button>
        ) : null}
        <button type="button" className="button button--primary" onClick={() => open()}>
          Open {agent.name}
        </button>
      </div>
    </div>
  );
}

// ---- Bot templates in Connect Apps -------------------------------------------------------

/** Connect Apps' Bot templates tab: the starter gallery (listStarterTemplates), your own templates, and Add Bot. */
export function BotGallery() {
  const [market, setMarket] = useState<BotMarketplace | null>(null);
  const [mine, setMine] = useState<BotTemplateView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const load = () => {
    setError(null);
    gateway.listStarterTemplates({}).then(setMarket, (cause) => setError(errorText(cause)));
    gateway.listMyTemplates({}).then(setMine, () => undefined);
  };
  useEffect(load, []);

  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  const listings = market?.listings ?? [];
  const visible = listings.filter((listing) => (category == null || listing.category === category) && words.every((word) => `${listing.name} ${listing.description} ${listing.category}`.toLowerCase().includes(word)));
  const browsing = words.length === 0 && category == null;
  const sections: Array<{ title: string; listings: BotMarketplaceListing[] }> = browsing
    ? [{ title: "Featured", listings: market?.featuredListings ?? [] }, ...(market?.allCategoriesOrder ?? []).map((label) => ({ title: label, listings: listings.filter((listing) => listing.category === label) }))]
    : [{ title: category != null && words.length === 0 ? category : "Results", listings: visible }];
  const add = (listing: BotMarketplaceListing) => openDialog({ kind: "add-bot", source: { shareId: listing.shareId }, sourceLabel: "the starter gallery" });

  return (
    <div className="gallery">
      <div className="apps__search">
        <Icon name="search" size={15} />
        <input data-autofocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search bot templates" aria-label="Search bot templates" spellCheck={false} maxLength={200} />
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
        {(market?.allCategoriesOrder ?? []).map((label) => (
          <button key={label} type="button" className={`chip${category === label ? " chip--active" : ""}`} aria-pressed={category === label} onClick={() => setCategory(category === label ? null : label)}>
            {label}
          </button>
        ))}
      </div>

      {browsing && mine.length > 0 ? (
        <section className="gallery__section" aria-label="Your templates">
          <h3 className="gallery__title">Your templates</h3>
          <ul className="template-apps">
            {mine.map((view) => (
              <YourTemplate key={view.shareId} view={view} onDeleted={load} />
            ))}
          </ul>
        </section>
      ) : null}

      {error != null ? (
        <div className="gallery__note">
          Couldn’t load the bot templates from your box.{" "}
          <button type="button" className="link-button" onClick={load}>
            Try again
          </button>
        </div>
      ) : market == null ? (
        <div className="gallery__note">Loading bot templates…</div>
      ) : null}

      {sections
        .filter((section) => section.listings.length > 0)
        .map((section) => (
          <section key={section.title} className="gallery__section" aria-label={section.title}>
            <h3 className="gallery__title">{section.title}</h3>
            <div className="gallery__grid" role="list">
              {section.listings.map((listing) => (
                <div key={listing.slug} className="app-card" role="listitem">
                  <button type="button" className="app-card__main" onClick={() => add(listing)} aria-label={`${listing.name}: preview`}>
                    <Avatar shape={listing.defaultAvatar.shape as AvatarShape} color={listing.defaultAvatar.color as AvatarColor} size={36} />
                    <span className="app-card__text">
                      <span className="app-card__name">{listing.name}</span>
                      <span className="app-card__description">{listing.description}</span>
                    </span>
                  </button>
                  <button type="button" className="button button--small" onClick={() => add(listing)}>
                    Add
                  </button>
                </div>
              ))}
            </div>
          </section>
        ))}
      {market != null && !browsing && visible.length === 0 ? <div className="gallery__note">No starters match. You can still add a bot from a file or a link.</div> : null}

      <div className="gallery__custom">
        <span className="app-logo app-logo--custom" style={{ width: 36, height: 36, borderRadius: 9 }} aria-hidden="true">
          <Icon name="download" size={18} />
        </span>
        <div className="gallery__custom-text">
          <div className="app-card__name">From a file or a link</div>
          <div className="muted">Add a bot from a template someone shared with you.</div>
        </div>
        <button type="button" className="button button--small" onClick={() => openDialog({ kind: "add-bot" })}>
          Open
        </button>
      </div>
    </div>
  );
}

/** One of the user's templates: its latest version, Share… while its agent is there, and Delete. */
function YourTemplate({ view, onDeleted }: { view: BotTemplateView; onDeleted(): void }) {
  const agent = useStore(roster, (state) => allAgents(state).find((candidate) => candidate.id === view.sourceAgentId));
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linkLive = view.published && view.visibility === "public" && view.activeVersion != null;
  return (
    <li>
      <Avatar shape={view.avatarShape as AvatarShape} color={view.avatarColor as AvatarColor} size={20} image={view.avatarDataUrl} />
      <span className="template-check__title">{view.name}</span>
      <span className="muted">
        {plural(view.versions.length, "version")}
        {linkLive ? ` · link serves version ${view.activeVersion}` : ""}
        {agent == null ? " · its agent was deleted" : ""}
        {error != null ? ` · ${error}` : ""}
      </span>
      {agent != null ? (
        <button type="button" className="button button--small button--ghost" onClick={() => openDialog({ kind: "share-template", agentId: agent.id })}>
          Share…
        </button>
      ) : null}
      <button
        type="button"
        className={`button button--small ${confirm ? "button--danger" : "button--ghost"}`}
        onClick={() => {
          if (!confirm) return setConfirm(true);
          gateway.removeTemplate({ shareId: view.shareId }).then(onDeleted, (cause) => setError(errorText(cause)));
        }}
      >
        {confirm ? "Delete every version?" : "Delete"}
      </button>
    </li>
  );
}
