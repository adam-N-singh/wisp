// Right-hand details pane for the open agent.
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import {
  type AgentMemory,
  type AgentSummary,
  type Automation,
  MAX_MEMORY_TEXT,
  MEMORY_BUDGET,
  memoryImportPrompt,
  memoryUsage,
  type Skill,
  skillCommand,
  type SkillSpec,
  type ToolCallEntry,
} from "../../shared/model";
import type { AgentBrowserState, ScreenCapture } from "../../shared/edges";
import { desktop, gateway, main } from "../bridge";
import { openAsyncTasks, openConnectApps, openDialog } from "../store/app";
import { automations, loadAutomations, loadMemories, loadSkills, loadTodos, memories, setAutomations, setMemories, setSkills, skills, todos } from "../store/agent-data";
import { layout, updateLayout, type InfoTab } from "../store/layout";
import { effectiveModel, modelLabel, modelSettings } from "../store/models";
import { useStore } from "../store/store";
import { replicaStore, deliverMessage } from "../store/transcripts";
import { backgroundText } from "./activity";
import { Icon } from "./icons";
import { LibrarySection } from "./PageCard";
import { CloudControls } from "./SettingsView";

// Memory opens from Overview, which stays selected while it shows: a fifth tab doesn't fit the
// pane's default 320 px.
const TABS: Array<{ id: InfoTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "computer", label: "Computer" },
  { id: "automations", label: "Automations" },
  { id: "skills", label: "Skills" },
];

/** A gateway error without its method or failure-code prefix. */
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message.replace(/^[\w/-]+: /, "") : String(cause));

const showInfoTab = (tab: InfoTab) => updateLayout((state) => ({ ...state, infoPane: { ...state.infoPane, overviewTab: tab } }));

export function InfoPane({ agent }: { agent: AgentSummary }) {
  const tab = useStore(layout, (state) => state.infoPane.overviewTab);
  const width = useStore(layout, (state) => state.infoPane.width);
  const reviews = useStore(memories, (state) => (state[agent.id] ?? []).filter((memory) => memory.review != null).length);
  useEffect(() => {
    void loadMemories(agent.id);
  }, [agent.id]);
  const selected = tab === "memory" ? "overview" : tab;
  return (
    <aside className="info-pane" style={{ width }} aria-label="Agent details">
      <div className="info-pane__tabs" role="tablist">
        {TABS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={selected === item.id} className={`tab${selected === item.id ? " tab--active" : ""}`} onClick={() => showInfoTab(item.id)}>
            {item.label}
            {item.id === "overview" && reviews > 0 ? <span className="badge tab__badge" role="status" aria-label={`${reviews} memory ${reviews === 1 ? "change" : "changes"} to review`} /> : null}
          </button>
        ))}
      </div>
      <div className="info-pane__body">
        {tab === "overview" ? (
          <Overview agent={agent} />
        ) : tab === "computer" ? (
          <Computer agent={agent} />
        ) : tab === "automations" ? (
          <Automations agent={agent} />
        ) : tab === "memory" ? (
          <Memory key={agent.id} agent={agent} />
        ) : (
          <Skills key={agent.id} agentId={agent.id} />
        )}
      </div>
    </aside>
  );
}

function Overview({ agent }: { agent: AgentSummary }) {
  const list = useStore(todos, (state) => state[agent.id]);
  const settings = useStore(modelSettings);
  const [workspace, setWorkspace] = useState<string | null>(null);
  useEffect(() => {
    void loadTodos(agent.id);
    void main.getAppInfo().then((info) => setWorkspace(`${info.workspaceRoot}${info.platform === "win32" ? "\\" : "/"}${agent.id}`));
  }, [agent.id]);

  return (
    <div className="overview">
      <section>
        <h3>Role</h3>
        <p className="muted">{agent.description || "No description yet."}</p>
      </section>
      {agent.instructions ? (
        <section>
          <h3>Instructions</h3>
          <p className="overview__instructions">{agent.instructions}</p>
        </section>
      ) : null}
      <section>
        <h3>Model</h3>
        <p className="muted">
          {modelLabel(effectiveModel(agent, settings))}
          {agent.model == null ? " (app default)" : ""}
        </p>
      </section>
      <MemorySummary agent={agent} />
      <LibrarySection agent={agent} />
      <section>
        <h3>Todo list</h3>
        {list == null || list.length === 0 ? (
          <p className="muted">The agent’s plan for multi-step work shows up here.</p>
        ) : (
          <ul className="todo-list">
            {list.map((todo) => (
              <li key={todo.id} className={`todo todo--${todo.status}`}>
                <span className="todo__box">{todo.status === "completed" ? <Icon name="check" size={12} /> : todo.status === "in_progress" ? <span className="todo__spinner" /> : null}</span>
                <span>{todo.content}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3>Background work</h3>
        <p className="muted">{(agent.asyncTaskCount ?? 0) > 0 ? backgroundText(agent) : "Commands the agent leaves running show up here."}</p>
        <button type="button" className="button button--small overview__tasks" onClick={() => openAsyncTasks(agent.id)}>
          <Icon name="terminal" size={14} /> Async tasks
        </button>
      </section>
      <section className="overview__buttons">
        {workspace != null ? (
          <button type="button" className="button" onClick={() => void main.openWithDefaultApp({ path: workspace }).catch(() => undefined)}>
            <Icon name="folder" size={14} /> Open workspace
          </button>
        ) : null}
        <button type="button" className="button" onClick={() => openDialog({ kind: "edit-agent", agentId: agent.id })}>
          <Icon name="edit" size={14} /> Edit agent
        </button>
      </section>
    </div>
  );
}

function Computer({ agent }: { agent: AgentSummary }) {
  const entries = useStore(replicaStore(agent.id), (replica) => replica.entries);
  const latest = useMemo(() => [...entries].reverse().find((entry): entry is ToolCallEntry => entry.kind === "tool-call" && entry.detail?.image != null), [entries]);
  const [capture, setCapture] = useState<ScreenCapture | null>(null);
  const [busy, setBusy] = useState(false);

  if (agent.computer === "cloud") {
    return (
      <div className="computer">
        <p className="muted">This agent works on your cloud computer, not this PC. Screens it captures there appear here.</p>
        <CloudControls compact />
        {latest?.detail?.image != null ? (
          <figure>
            <img src={desktop.local.mediaUrl(latest.detail.image)} alt="Latest screen the agent captured" />
            <figcaption>
              {latest.summary} · {new Date(latest.timestampMs).toLocaleTimeString()}
            </figcaption>
          </figure>
        ) : null}
      </div>
    );
  }

  return (
    <div className="computer">
      <p className="muted">The agent works on this computer through local tools. Screens it captures appear here.</p>
      {latest?.detail?.image != null ? (
        <figure>
          <img src={desktop.local.mediaUrl(latest.detail.image)} alt="Latest screen the agent captured" />
          <figcaption>{latest.summary} · {new Date(latest.timestampMs).toLocaleTimeString()}</figcaption>
        </figure>
      ) : null}
      {capture != null ? (
        <figure>
          <img src={capture.dataUrl} alt="Your screen" />
          <figcaption>Your screen · {new Date(capture.capturedAt).toLocaleTimeString()}</figcaption>
        </figure>
      ) : null}
      <button
        type="button"
        className="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setCapture(await main.grabScreen());
          } finally {
            setBusy(false);
          }
        }}
      >
        <Icon name="monitor" size={14} /> {busy ? "Capturing…" : "Preview my screen"}
      </button>
      <AgentBrowser agent={agent} />
    </div>
  );
}

/** The agent's own browser on this PC (src/main/agent-browser.ts): what it's on, and a way to open it. */
function AgentBrowser({ agent }: { agent: AgentSummary }) {
  const [state, setState] = useState<AgentBrowserState | null>(null);
  useEffect(() => {
    let live = true;
    void main.getAgentBrowser({ agentId: agent.id }).then((next) => live && setState(next));
    const off = main.subscribe({ "agent-browser-changed": (next) => (next.agentId === agent.id ? setState(next) : undefined) });
    return () => {
      live = false;
      off();
    };
  }, [agent.id]);
  const active = state?.tabs.find((tab) => tab.active);
  return (
    <section className="computer__browser" aria-label="Agent browser">
      <h3>Agent browser</h3>
      <p className="muted">
        {agent.name}’s own browser window on this PC, with a profile of its own. Sign in to a site there once and {agent.name} can use it; nothing is taken from your
        own browser.
      </p>
      {state?.open ? (
        <p>
          {state.request != null ? `Waiting for you: ${state.request}` : state.control === "user" ? "You’re in control; the agent waits." : `${agent.name} is browsing`}
          {active != null && active.url !== "about:blank" ? ` · ${active.title || active.url}` : ""} · {state.tabs.length} {state.tabs.length === 1 ? "tab" : "tabs"}
        </p>
      ) : null}
      <button type="button" className="button" onClick={() => void main.showAgentBrowser({ agentId: agent.id }).then(setState)}>
        <Icon name="monitor" size={14} /> {state?.open ? "Show agent browser" : "Open agent browser"}
      </button>
    </section>
  );
}

const PRESETS: Array<{ label: string; schedule: string }> = [
  { label: "Every weekday at 9:00", schedule: "0 9 * * 1-5" },
  { label: "Every day at 8:00", schedule: "0 8 * * *" },
  { label: "Every hour", schedule: "0 * * * *" },
  { label: "Every 15 minutes", schedule: "*/15 * * * *" },
  { label: "Mondays at 10:00", schedule: "0 10 * * 1" },
];

function Automations({ agent }: { agent: AgentSummary }) {
  const list = useStore(automations, (state) => state[agent.id]);
  /** The automation being edited, or "new". */
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadAutomations(agent.id);
    setEditing(null);
  }, [agent.id]);

  const apply = async (call: Promise<Automation[]>) => {
    setError(null);
    try {
      setAutomations(agent.id, await call);
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    }
  };

  return (
    <div className="automations">
      {list == null || list.length === 0 ? <p className="muted">Automations send this agent a prompt on a schedule. You can also ask the agent to set one up.</p> : null}
      <ul className="automation-list">
        {(list ?? []).map((automation) =>
          editing === automation.id ? (
            <li key={automation.id}>
              <AutomationForm agentId={agent.id} automation={automation} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li key={automation.id} className="automation">
              <div className="automation__head">
                <label className="switch" title={automation.isEnabled ? "Enabled" : "Disabled"}>
                  <input type="checkbox" checked={automation.isEnabled} aria-label={`Run ${automation.name} on its schedule`} onChange={(event) => void apply(gateway.toggleAgentAutomation({ id: agent.id, automationId: automation.id, isEnabled: event.target.checked }))} />
                  <span />
                </label>
                <span className="automation__name">{automation.name}</span>
              </div>
              <div className="automation__meta">
                {automation.triggerDescription}
                {automation.nextRunAt != null && automation.isEnabled ? ` · next ${new Date(automation.nextRunAt).toLocaleString()}` : ""}
                {automation.provenance === "from_template" ? <span title="It came with the bot template this agent was made from, switched off. Read its prompt before you switch it on."> · from a template</span> : null}
              </div>
              <p className="automation__prompt">{automation.prompt}</p>
              <div className="automation__actions">
                <button type="button" className="button button--small" onClick={() => void gateway.runAutomationNow({ id: agent.id, automationId: automation.id })}>
                  <Icon name="play" size={12} /> Run now
                </button>
                <button type="button" className="button button--small button--ghost" onClick={() => setEditing(automation.id)}>
                  <Icon name="edit" size={12} /> Edit
                </button>
                <button type="button" className="button button--small button--ghost" onClick={() => void apply(gateway.removeAgentAutomation({ id: agent.id, automationId: automation.id }))}>
                  <Icon name="trash" size={12} /> Delete
                </button>
              </div>
            </li>
          ),
        )}
      </ul>
      {editing === "new" ? (
        <AutomationForm agentId={agent.id} onDone={() => setEditing(null)} />
      ) : (
        <button type="button" className="button" onClick={() => setEditing("new")}>
          <Icon name="plus" size={14} /> New automation
        </button>
      )}
      {error != null ? <div className="form-error">{error}</div> : null}
    </div>
  );
}

/** Creates an automation, or edits one (its on/off state stays as it is). */
function AutomationForm({ agentId, automation, onDone }: { agentId: string; automation?: Automation; onDone(): void }) {
  const [name, setName] = useState(automation?.name ?? "");
  const [prompt, setPrompt] = useState(automation?.prompt ?? "");
  const [schedule, setSchedule] = useState(automation?.trigger.schedule ?? PRESETS[0].schedule);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const spec = { name: name.trim(), prompt: prompt.trim(), trigger: { type: "cron" as const, schedule: schedule.trim() } };
    try {
      setAutomations(agentId, automation == null ? await gateway.addAgentAutomation({ id: agentId, spec }) : await gateway.editAgentAutomation({ id: agentId, automationId: automation.id, spec }));
      onDone();
    } catch (cause) {
      setError(errorText(cause));
      setSaving(false);
    }
  };

  return (
    <form className="automation-form" onSubmit={submit} aria-label={automation == null ? "New automation" : `Edit ${automation.name}`}>
      <label>
        Name
        <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} placeholder="Morning briefing" autoFocus />
      </label>
      <label>
        Prompt
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} required rows={3} maxLength={20000} placeholder="Summarize my unread email and today’s calendar." />
      </label>
      <label>
        Schedule
        <select value={PRESETS.some((preset) => preset.schedule === schedule) ? schedule : "custom"} onChange={(event) => event.target.value !== "custom" && setSchedule(event.target.value)}>
          {PRESETS.map((preset) => (
            <option key={preset.schedule} value={preset.schedule}>
              {preset.label}
            </option>
          ))}
          <option value="custom">Custom (cron)</option>
        </select>
      </label>
      <label>
        Cron
        <input value={schedule} onChange={(event) => setSchedule(event.target.value)} className="mono" aria-label="Cron expression" />
      </label>
      <div className="automation-form__actions">
        <button type="submit" className="button button--primary" disabled={saving}>
          {automation == null ? "Create" : "Save"}
        </button>
        <button type="button" className="button button--ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      {error != null ? <div className="form-error">{error}</div> : null}
    </form>
  );
}

/** A skill's current spec, for edits that change one part of it. */
function specOf(skill: Skill): SkillSpec {
  return { name: skill.name, description: skill.description, body: skill.body, trigger: skill.trigger };
}

function Skills({ agentId }: { agentId: string }) {
  const list = useStore(skills, (state) => state[agentId]);
  /** The skill being edited, or "new". */
  const [editing, setEditing] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadSkills(agentId);
  }, [agentId]);

  const apply = async (call: Promise<Skill[] | null>) => {
    setError(null);
    try {
      const next = await call;
      if (next != null) setSkills(agentId, next);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  return (
    <div className="skills">
      {list == null || list.every((skill) => skill.source === "plugin") ? <p className="muted">Skills are instructions this agent keeps for a kind of task. It reads one when a request matches the skill’s description, and you can run one by typing / in the message box.</p> : null}
      <ul className="automation-list">
        {(list ?? []).filter((skill) => skill.source !== "plugin").map((skill) =>
          editing === skill.id ? (
            <li key={skill.id}>
              <SkillForm agentId={agentId} skill={skill} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <SkillCard
              key={skill.id}
              agentId={agentId}
              skill={skill}
              apply={apply}
              onEdit={() => {
                setEditing(skill.id);
                setImporting(false);
              }}
            />
          ),
        )}
      </ul>
      {editing === "new" ? (
        <SkillForm agentId={agentId} onDone={() => setEditing(null)} />
      ) : importing ? (
        <SkillImport agentId={agentId} onDone={() => setImporting(false)} />
      ) : (
        <div className="automation__actions">
          <button type="button" className="button" onClick={() => setEditing("new")}>
            <Icon name="plus" size={14} /> New skill
          </button>
          <button type="button" className="button" onClick={() => setImporting(true)}>
            <Icon name="download" size={14} /> Import
          </button>
        </div>
      )}
      {error != null ? <div className="form-error">{error}</div> : null}
      {(list ?? []).some((skill) => skill.source === "plugin") ? (
        <>
          <h3 className="skills__group">From plugins</h3>
          <p className="muted skills__group-note">Installed plugins give every agent these. They’re read-only: copy one to this agent to change it.</p>
          <ul className="automation-list">
            {list!
              .filter((skill) => skill.source === "plugin")
              .map((skill) => (
                <PluginSkillCard key={skill.id} agentId={agentId} skill={skill} apply={apply} />
              ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** A skill an installed plugin gives every agent: run it, copy it to change it, or open its plugin. */
function PluginSkillCard({ agentId, skill, apply }: { agentId: string; skill: Skill; apply(call: Promise<Skill[] | null>): Promise<void> }) {
  return (
    <li className="automation">
      <div className="automation__head">
        <span className="automation__name">{skill.name}</span>
        <span className="pill" title="Read-only: it comes with an installed plugin">
          {skill.pluginName ?? "Plugin"}
        </span>
        {skill.disableModelInvocation === true ? (
          <span className="pill" title="Its file sets disable-model-invocation, so the agent follows it only when you run it">
            Only when you run it
          </span>
        ) : null}
      </div>
      <div className="automation__meta">
        <span className="skill__command">/{skillCommand(skill.name)}</span>
      </div>
      <p className="automation__prompt">{skill.description}</p>
      <div className="automation__actions">
        <button type="button" className="button button--small" onClick={() => void apply(gateway.runAgentSkillNow({ id: agentId, skillId: skill.id }))}>
          <Icon name="play" size={12} /> Run now
        </button>
        <button type="button" className="button button--small button--ghost" onClick={() => void apply(gateway.copyPluginSkill({ id: agentId, skillId: skill.id }).then((copied) => copied.skills))}>
          <Icon name="copy" size={12} /> Copy to agent
        </button>
        {skill.pluginId != null ? (
          <button type="button" className="button button--small button--ghost" onClick={() => openConnectApps({ appId: skill.pluginId! })}>
            <Icon name="plug" size={12} /> Plugin
          </button>
        ) : null}
      </div>
    </li>
  );
}

function SkillCard({ agentId, skill, apply, onEdit }: { agentId: string; skill: Skill; apply(call: Promise<Skill[] | null>): Promise<void>; onEdit(): void }) {
  const [confirming, setConfirming] = useState(false);
  const trigger = skill.trigger;
  return (
    <li className="automation">
      <div className="automation__head">
        {trigger != null ? (
          <label className="switch" title={trigger.isEnabled ? "Schedule on" : "Schedule off"}>
            <input
              type="checkbox"
              checked={trigger.isEnabled}
              aria-label={`Run ${skill.name} on its schedule`}
              onChange={(event) => void apply(gateway.editAgentSkill({ id: agentId, skillId: skill.id, spec: { ...specOf(skill), trigger: { ...trigger, isEnabled: event.target.checked } } }))}
            />
            <span />
          </label>
        ) : null}
        <span className="automation__name">{skill.name}</span>
        {skill.disableModelInvocation === true ? (
          <span className="pill" title="Its file sets disable-model-invocation, so the agent follows it only when you run it">
            Only when you run it
          </span>
        ) : null}
      </div>
      <div className="automation__meta">
        <span className="skill__command">/{skillCommand(skill.name)}</span>
        {skill.scheduleDescription != null ? ` · ${skill.scheduleDescription}` : ""}
        {trigger?.isEnabled === true && skill.nextRunAt != null ? ` · next ${new Date(skill.nextRunAt).toLocaleString()}` : ""}
      </div>
      <p className="automation__prompt">{skill.description}</p>
      <div className="automation__actions">
        <button type="button" className="button button--small" onClick={() => void apply(gateway.runAgentSkillNow({ id: agentId, skillId: skill.id }))}>
          <Icon name="play" size={12} /> Run now
        </button>
        <button type="button" className="button button--small button--ghost" onClick={onEdit}>
          <Icon name="edit" size={12} /> Edit
        </button>
        {confirming ? (
          <button type="button" className="button button--small button--danger" autoFocus onBlur={() => setConfirming(false)} onClick={() => void apply(gateway.removeAgentSkill({ id: agentId, skillId: skill.id }))}>
            Confirm delete
          </button>
        ) : (
          <button type="button" className="button button--small button--ghost" onClick={() => setConfirming(true)}>
            <Icon name="trash" size={12} /> Delete
          </button>
        )}
      </div>
    </li>
  );
}

function SkillForm({ agentId, skill, onDone }: { agentId: string; skill?: Skill; onDone(): void }) {
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [body, setBody] = useState(skill?.body ?? "");
  const [scheduled, setScheduled] = useState(skill?.trigger != null);
  const [schedule, setSchedule] = useState(skill?.trigger?.schedule ?? PRESETS[0].schedule);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const command = skillCommand(name);
  const commandHint = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const spec: SkillSpec = { name, description, body, trigger: scheduled ? { isEnabled: skill?.trigger?.isEnabled ?? true, schedule } : null };
    try {
      setSkills(agentId, skill == null ? await gateway.addAgentSkill({ id: agentId, spec }) : await gateway.editAgentSkill({ id: agentId, skillId: skill.id, spec }));
      onDone();
    } catch (cause) {
      setError(errorText(cause));
      setSaving(false);
    }
  };

  return (
    <form className="automation-form" onSubmit={submit} aria-label={skill == null ? "New skill" : `Edit ${skill.name}`}>
      <label>
        Name
        <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={64} placeholder="Weekly report" autoFocus={skill == null} aria-describedby={commandHint} />
      </label>
      <p id={commandHint} className="form-hint form-hint--attached">
        {command.length > 0 ? `Run it by typing /${command}` : "Its letters and digits become its / command."}
      </p>
      <label>
        Description
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} required rows={2} maxLength={1024} placeholder="Use when the user asks for the weekly report." />
      </label>
      <label>
        Instructions
        <textarea value={body} onChange={(event) => setBody(event.target.value)} required rows={8} placeholder={"1. Collect this week’s merged pull requests.\n2. Group them by area.\n3. Write a short summary for each."} />
      </label>
      <div className="form-field">
        Schedule
        <div className="segmented" role="radiogroup" aria-label="Schedule">
          <button type="button" role="radio" aria-checked={!scheduled} className={scheduled ? "" : "segmented--active"} onClick={() => setScheduled(false)}>
            No schedule
          </button>
          <button type="button" role="radio" aria-checked={scheduled} className={scheduled ? "segmented--active" : ""} onClick={() => setScheduled(true)}>
            On a schedule
          </button>
        </div>
      </div>
      {scheduled ? (
        <>
          <label>
            Repeats
            <select value={PRESETS.some((preset) => preset.schedule === schedule) ? schedule : "custom"} onChange={(event) => event.target.value !== "custom" && setSchedule(event.target.value)}>
              {PRESETS.map((preset) => (
                <option key={preset.schedule} value={preset.schedule}>
                  {preset.label}
                </option>
              ))}
              <option value="custom">Custom (cron)</option>
            </select>
          </label>
          <label>
            Cron
            <input value={schedule} onChange={(event) => setSchedule(event.target.value)} className="mono" aria-label="Skill cron expression" />
          </label>
        </>
      ) : null}
      {skill?.sourceRef != null ? (
        <p className="form-hint">
          Imported from{" "}
          <button type="button" className="link-button" onClick={() => void main.openInBrowser({ url: skill.sourceRef! }).catch(() => undefined)}>
            {skill.sourceRef}
          </button>
        </p>
      ) : null}
      <div className="automation-form__actions">
        <button type="submit" className="button button--primary" disabled={saving}>
          {skill == null ? "Create skill" : "Save"}
        </button>
        <button type="button" className="button button--ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      {error != null ? <div className="form-error">{error}</div> : null}
    </form>
  );
}

function SkillImport({ agentId, onDone }: { agentId: string; onDone(): void }) {
  const [mode, setMode] = useState<"text" | "url">("text");
  const [markdown, setMarkdown] = useState("");
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const linkHint = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblems([]);
    const named = name.trim().length > 0 ? { name: name.trim() } : {};
    const url = /^[a-z][\w+.-]*:\/\//i.test(address.trim()) ? address.trim() : `https://${address.trim()}`;
    try {
      const imported = mode === "text" ? await gateway.importSkillText({ id: agentId, markdown, ...named }) : await gateway.importSkillFromLink({ id: agentId, url, ...named });
      setSkills(agentId, imported.skills);
      if (imported.result.imported.length > 0) return onDone();
      setProblems(imported.result.skipped.map((skipped) => skipped.reason));
    } catch (cause) {
      setProblems([errorText(cause)]);
    }
    setBusy(false);
  };

  return (
    <form className="automation-form" onSubmit={submit} aria-label="Import a skill">
      <div className="segmented" role="radiogroup" aria-label="Import from">
        <button type="button" role="radio" aria-checked={mode === "text"} className={mode === "text" ? "segmented--active" : ""} onClick={() => setMode("text")}>
          Paste Markdown
        </button>
        <button type="button" role="radio" aria-checked={mode === "url"} className={mode === "url" ? "segmented--active" : ""} onClick={() => setMode("url")}>
          From a link
        </button>
      </div>
      {mode === "text" ? (
        <label>
          SKILL.md or other Markdown
          <textarea value={markdown} onChange={(event) => setMarkdown(event.target.value)} required rows={8} className="mono" placeholder={"---\nname: weekly-report\ndescription: Use when …\n---\n\nInstructions…"} />
        </label>
      ) : (
        <>
          <label>
            Link
            <input value={address} onChange={(event) => setAddress(event.target.value)} required placeholder="https://github.com/…/SKILL.md" inputMode="url" aria-describedby={linkHint} />
          </label>
          <p id={linkHint} className="form-hint form-hint--attached">
            A Markdown file, or a GitHub file, skill folder or gist.
          </p>
        </>
      )}
      <label>
        Name (optional)
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} placeholder="Taken from the file" />
      </label>
      <div className="automation-form__actions">
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? "Importing…" : "Import"}
        </button>
        <button type="button" className="button button--ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      {problems.map((problem) => (
        <div key={problem} className="form-error">
          Not imported: {problem}
        </div>
      ))}
    </form>
  );
}

/** For Import memory: what to ask another assistant so it writes out what it remembers about the user. */
const EXPORT_PROMPT =
  "List everything you remember about me from our conversations: facts about me and my work, the people, projects and tools I deal with, my preferences, and how I like you to work. Write one short fact per line, without commentary.";

const memoryDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** Overview's Memory section: how much the agent remembers and what waits for review, and the way into the Memory view. */
function MemorySummary({ agent }: { agent: AgentSummary }) {
  const list = useStore(memories, (state) => state[agent.id]);
  const kept = (list ?? []).filter((memory) => memory.review?.action !== "add").length;
  const waiting = (list ?? []).filter((memory) => memory.review != null).length;
  return (
    <section className="memory-summary">
      <h3>Memory</h3>
      <p className="muted">
        {list == null
          ? `What ${agent.name} remembers across conversations shows up here.`
          : kept === 0
            ? `${agent.name} hasn’t saved any memories yet.`
            : `${agent.name} remembers ${kept} ${kept === 1 ? "thing" : "things"} across conversations.`}
      </p>
      {waiting > 0 ? (
        <p className="memory-summary__waiting">
          {waiting} {waiting === 1 ? "change waits" : "changes wait"} for your review.
        </p>
      ) : null}
      <button type="button" className="button" onClick={() => showInfoTab("memory")}>
        <Icon name="brain" size={14} /> {waiting > 0 ? "Review memory" : "Open memory"}
      </button>
    </section>
  );
}

function Memory({ agent }: { agent: AgentSummary }) {
  const list = useStore(memories, (state) => state[agent.id]);
  /** The memory being edited, or "new". */
  const [editing, setEditing] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (call: Promise<AgentMemory[]>) => {
    setError(null);
    try {
      setMemories(agent.id, await call);
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    }
  };

  const all = list ?? [];
  const waiting = all.filter((memory) => memory.review != null);
  const kept = all.filter((memory) => memory.review?.action !== "add");
  const open = (next: { editing?: string; importing?: boolean }) => {
    setEditing(next.editing ?? null);
    setImporting(next.importing ?? false);
    setSent(false);
    setError(null);
  };

  return (
    <div className="memory">
      <header className="memory__header">
        <button type="button" className="link-button memory__back" onClick={() => showInfoTab("overview")}>
          <Icon name="chevronLeft" size={12} /> Overview
        </button>
        <h3 className="memory__title">Memory</h3>
        <p className="muted">{agent.name} remembers these across conversations, even after you start a fresh one. It saves what it learns about you and how you like things done, and you can add, edit or delete memories here.</p>
      </header>
      <div className="memory__setting">
        <div>
          <div className="memory__setting-label">Review before saving</div>
          <p className="form-hint">What {agent.name} saves, changes or forgets waits here for your approval.</p>
        </div>
        <label className="switch" title={agent.memoryReview === true ? "On" : "Off"}>
          <input
            type="checkbox"
            aria-label="Review memories before they're saved"
            checked={agent.memoryReview === true}
            onChange={(event) => void gateway.updateAgentConfig({ id: agent.id, memoryReview: event.target.checked }).catch((cause) => setError(errorText(cause)))}
          />
          <span />
        </label>
      </div>
      {waiting.length > 0 ? (
        <section>
          <h3>Waiting for your review</h3>
          <ul className="automation-list">
            {waiting.map((memory) => (
              <MemoryReviewCard key={memory.id} agentId={agent.id} memory={memory} apply={apply} />
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h3>Saved memories</h3>
        {kept.length === 0 ? (
          <p className="muted">Nothing yet. Tell {agent.name} something worth remembering, or add or import memories here.</p>
        ) : (
          <ul className="automation-list">
            {kept.map((memory) =>
              editing === memory.id ? (
                <li key={memory.id}>
                  <MemoryForm agentId={agent.id} memory={memory} apply={apply} onDone={() => setEditing(null)} />
                </li>
              ) : (
                <MemoryCard key={memory.id} agent={agent} memory={memory} apply={apply} onEdit={() => open({ editing: memory.id })} />
              ),
            )}
          </ul>
        )}
        {all.length > 0 ? (
          <p className="form-hint memory__usage">
            {memoryUsage(all).toLocaleString()} of {MEMORY_BUDGET.toLocaleString()} characters used
          </p>
        ) : null}
      </section>
      {editing === "new" ? (
        <MemoryForm agentId={agent.id} apply={apply} onDone={() => setEditing(null)} />
      ) : importing ? (
        <MemoryImport
          agent={agent}
          onDone={(didSend) => {
            setImporting(false);
            setSent(didSend);
          }}
        />
      ) : (
        <div className="automation__actions">
          <button type="button" className="button" onClick={() => open({ editing: "new" })}>
            <Icon name="plus" size={14} /> Add memory
          </button>
          <button type="button" className="button" onClick={() => open({ importing: true })}>
            <Icon name="download" size={14} /> Import memory
          </button>
        </div>
      )}
      {sent ? <p className="form-hint">Sent your notes to {agent.name}. The memories it saves show up here.</p> : null}
      {error != null ? <div className="form-error">{error}</div> : null}
    </div>
  );
}

function MemoryCard({ agent, memory, apply, onEdit }: { agent: AgentSummary; memory: AgentMemory; apply(call: Promise<AgentMemory[]>): Promise<boolean>; onEdit(): void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="automation">
      <p className="memory__text">{memory.text}</p>
      <div className="automation__meta">
        {memory.source === "user" ? "Saved by you" : `Saved by ${agent.name}`} · {memoryDate(memory.updatedAt)}
        {memory.review != null ? " · change waiting for review" : ""}
      </div>
      <div className="automation__actions">
        <button type="button" className="button button--small button--ghost" onClick={onEdit}>
          <Icon name="edit" size={12} /> Edit
        </button>
        {confirming ? (
          <button type="button" className="button button--small button--danger" autoFocus onBlur={() => setConfirming(false)} onClick={() => void apply(gateway.deleteAgentMemory({ id: agent.id, memoryId: memory.id }))}>
            Confirm delete
          </button>
        ) : (
          <button type="button" className="button button--small button--ghost" onClick={() => setConfirming(true)}>
            <Icon name="trash" size={12} /> Delete
          </button>
        )}
      </div>
    </li>
  );
}

function MemoryReviewCard({ agentId, memory, apply }: { agentId: string; memory: AgentMemory; apply(call: Promise<AgentMemory[]>): Promise<boolean> }) {
  const review = memory.review!;
  return (
    <li className="automation">
      <div className="automation__meta">{review.action === "add" ? "Wants to remember" : review.action === "edit" ? "Wants to change" : "Wants to forget"}</div>
      <p className={`memory__text${review.action === "add" ? "" : " memory__text--old"}`}>{memory.text}</p>
      {review.action === "edit" ? <p className="memory__text">{review.text}</p> : null}
      <div className="automation__actions">
        <button type="button" className="button button--small button--primary" onClick={() => void apply(gateway.reviewAgentMemory({ id: agentId, memoryId: memory.id, approve: true }))}>
          <Icon name="check" size={12} /> Approve
        </button>
        <button type="button" className="button button--small button--ghost" onClick={() => void apply(gateway.reviewAgentMemory({ id: agentId, memoryId: memory.id, approve: false }))}>
          <Icon name="close" size={12} /> Reject
        </button>
      </div>
    </li>
  );
}

function MemoryForm({ agentId, memory, apply, onDone }: { agentId: string; memory?: AgentMemory; apply(call: Promise<AgentMemory[]>): Promise<boolean>; onDone(): void }) {
  const [text, setText] = useState(memory?.text ?? "");
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    if (await apply(memory == null ? gateway.createAgentMemory({ id: agentId, text }) : gateway.updateAgentMemory({ id: agentId, memoryId: memory.id, text }))) onDone();
    else setSaving(false);
  };

  return (
    <form className="automation-form" onSubmit={submit} aria-label={memory == null ? "New memory" : "Edit memory"}>
      <label>
        {memory == null ? "New memory" : "Memory"}
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // One line per memory: Enter saves.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          required
          rows={3}
          maxLength={MAX_MEMORY_TEXT}
          autoFocus
          placeholder="Prefers metric units and 24-hour times."
        />
      </label>
      <div className="automation-form__actions">
        <button type="submit" className="button button--primary" disabled={saving}>
          {memory == null ? "Add" : "Save"}
        </button>
        <button type="button" className="button button--ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function MemoryImport({ agent, onDone }: { agent: AgentSummary; onDone(sent: boolean): void }) {
  const [notes, setNotes] = useState("");
  const [copied, setCopied] = useState(false);
  const notesHint = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // The notes go to the agent as a message, and it saves the memories.
    deliverMessage(agent.id, memoryImportPrompt(notes), []);
    onDone(true);
  };

  return (
    <form className="automation-form" onSubmit={submit} aria-label="Import memory">
      <label>
        Notes to remember
        <textarea value={notes} onChange={(event) => setNotes(event.target.value)} required rows={8} maxLength={20_000} autoFocus placeholder={"I’m a data engineer at Acme.\nI like short answers with the code first."} aria-describedby={notesHint} />
      </label>
      <p id={notesHint} className="form-hint form-hint--attached">
        Paste notes about yourself, or what another assistant remembers about you. {agent.name} reads them in the chat and saves what’s worth keeping.
      </p>
      <div className="memory__export">
        <p className="form-hint">Moving from another assistant? Ask it:</p>
        <blockquote className="memory__export-prompt">{EXPORT_PROMPT}</blockquote>
        <button type="button" className="button button--small button--ghost" onClick={() => void navigator.clipboard.writeText(EXPORT_PROMPT).then(() => setCopied(true), () => undefined)}>
          <Icon name={copied ? "check" : "file"} size={12} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="automation-form__actions">
        <button type="submit" className="button button--primary">
          Import
        </button>
        <button type="button" className="button button--ghost" onClick={() => onDone(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
