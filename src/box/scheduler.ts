// Cron scheduler: every 30 s, due automations hand their prompt to the harness
// as a user message (source "automation"), and skills with a trigger run on the
// same clock. Each firing is recorded as a run, newest first, keeping the last 20.
import { randomUUID } from "node:crypto";
import type { AgentId, Automation, AutomationRun, AutomationSpec, Skill } from "../shared/model";
import { describeCron, isValidCron, nextCronRun } from "./cron";
import type { BoxStore } from "./store";

const MAX_RUNS = 20;

export function computeNextRun(automation: Pick<Automation, "isEnabled" | "schedule">, from: number): number | null {
  if (!automation.isEnabled || !isValidCron(automation.schedule)) return null;
  return nextCronRun(automation.schedule, from);
}

/** A skill's trigger in the terms automations use. */
export function skillSchedule(skill: Pick<Skill, "trigger">): Pick<Automation, "isEnabled" | "schedule"> {
  return { isEnabled: skill.trigger?.isEnabled === true, schedule: skill.trigger?.schedule ?? "" };
}

export function buildAutomation(agentId: AgentId, spec: AutomationSpec, existing?: Automation): Automation {
  if (!isValidCron(spec.trigger.schedule)) throw new Error(`Invalid cron schedule "${spec.trigger.schedule}".`);
  const now = Date.now();
  const id = existing?.id ?? randomUUID();
  const automation: Automation = {
    id,
    agentId,
    name: spec.name,
    prompt: spec.prompt,
    isEnabled: spec.isEnabled ?? existing?.isEnabled ?? true,
    createdAt: existing?.createdAt ?? now,
    lastRunAt: existing?.lastRunAt ?? null,
    nextRunAt: null,
    schedule: spec.trigger.schedule,
    trigger: { type: "cron", schedule: spec.trigger.schedule },
    triggerDescription: describeCron(spec.trigger.schedule),
    runs: existing?.runs ?? [],
    filePath: `automations/${id}.json`,
    ...(existing?.provenance != null ? { provenance: existing.provenance } : {}),
  };
  automation.nextRunAt = computeNextRun(automation, now);
  return automation;
}

function newRun(now: number, trigger: AutomationRun["trigger"], accepted: boolean): AutomationRun {
  return { id: randomUUID(), startedAt: now, finishedAt: Date.now(), status: accepted ? "ok" : "error", trigger, ...(accepted ? {} : { detail: "The agent no longer exists." }) };
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: BoxStore,
    private readonly fire: (automation: Automation) => boolean,
    private readonly onChanged: (agentId: AgentId) => void,
    private readonly skills: { fire(skill: Skill, trigger: AutomationRun["trigger"]): boolean; onChanged(agentId: AgentId): void } | null = null,
  ) {}

  start(): void {
    this.timer ??= setInterval(() => this.tick(), 30_000);
    this.tick();
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
  }

  /** The box's time zone changed: recompute every enabled automation's and skill's next run from now. */
  reschedule(): void {
    const now = Date.now();
    const agents = new Set<AgentId>();
    for (const automation of this.store.listAutomations()) {
      if (!automation.isEnabled) continue;
      this.store.putAutomation({ ...automation, nextRunAt: computeNextRun(automation, now) });
      agents.add(automation.agentId);
    }
    for (const agentId of agents) this.onChanged(agentId);
    const skillAgents = new Set<AgentId>();
    for (const skill of this.store.listSkills()) {
      if (!skillSchedule(skill).isEnabled) continue;
      this.store.putSkill({ ...skill, nextRunAt: computeNextRun(skillSchedule(skill), now) });
      skillAgents.add(skill.agentId);
    }
    for (const agentId of skillAgents) this.skills?.onChanged(agentId);
  }

  runNow(id: string): boolean {
    const automation = this.store.listAutomations().find((a) => a.id === id);
    if (automation == null) return false;
    this.execute(automation, Date.now(), "manual");
    return true;
  }

  runSkillNow(agentId: AgentId, id: string): boolean {
    const skill = this.store.getSkill(agentId, id);
    if (skill == null) return false;
    this.executeSkill(skill, Date.now(), "manual");
    return true;
  }

  private tick(): void {
    const now = Date.now();
    for (const automation of this.store.listAutomations()) {
      if (!automation.isEnabled) continue;
      if (automation.nextRunAt == null) {
        const nextRunAt = computeNextRun(automation, now);
        if (nextRunAt != null) this.store.putAutomation({ ...automation, nextRunAt });
        continue;
      }
      if (automation.nextRunAt <= now) this.execute(automation, now, "schedule");
    }
    for (const skill of this.store.listSkills()) {
      if (!skillSchedule(skill).isEnabled) continue;
      if (skill.nextRunAt == null) {
        const nextRunAt = computeNextRun(skillSchedule(skill), now);
        if (nextRunAt != null) this.store.putSkill({ ...skill, nextRunAt });
        continue;
      }
      if (skill.nextRunAt <= now) this.executeSkill(skill, now, "schedule");
    }
  }

  private execute(automation: Automation, now: number, trigger: AutomationRun["trigger"]): void {
    const run = newRun(now, trigger, this.fire(automation));
    this.store.putAutomation({ ...automation, lastRunAt: now, nextRunAt: computeNextRun(automation, now), runs: [run, ...automation.runs].slice(0, MAX_RUNS) });
    this.onChanged(automation.agentId);
  }

  private executeSkill(skill: Skill, now: number, trigger: AutomationRun["trigger"]): void {
    const run = newRun(now, trigger, this.skills?.fire(skill, trigger) ?? false);
    this.store.putSkill({ ...skill, lastRunAt: now, nextRunAt: computeNextRun(skillSchedule(skill), now), runs: [run, ...skill.runs].slice(0, MAX_RUNS) });
    this.skills?.onChanged(skill.agentId);
  }
}
