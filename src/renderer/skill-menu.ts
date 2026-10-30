// The composer's "/" menu (components/Composer.tsx), kept apart from the component so it can be
// tested without a window: what opens it, which skills match, and the command each one runs as. A
// plugin's skill is "/<plugin>:<skill>", as Claude Code writes it, which the box runs as that
// plugin's skill exactly; typed with a dash for the colon it runs too, unless one of the agent's own
// skills has that command (box/skills.ts skillForPrompt).
import { qualifiedSkillCommand, type Skill, skillCommand } from "../shared/model";

/** What follows the "/" while the message is only "/" and a command being typed; null when the menu has no business open. */
export function slashQuery(text: string): string | null {
  return /^\/([\p{L}\p{N}:-]*)$/u.exec(text)?.[1] ?? null;
}

/** The command a skill runs as, without its "/": "<plugin>:<skill>" for a plugin's, its name's command otherwise. */
export function slashCommand(skill: Pick<Skill, "name" | "source">): string {
  return skill.source === "plugin" ? qualifiedSkillCommand(skill.name) : skillCommand(skill.name);
}

/** Skills whose command or name contains the query (a colon matching a dash), those that start with it first. */
export function skillMatches(list: Skill[], query: string, limit: number): Skill[] {
  const wanted = skillCommand(query);
  return list
    .map((skill) => ({ skill, command: skillCommand(skill.name) }))
    .filter(({ skill, command }) => command.includes(wanted) || skill.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Number(!a.command.startsWith(wanted)) - Number(!b.command.startsWith(wanted)))
    .slice(0, limit)
    .map(({ skill }) => skill);
}
