// Skills: named Markdown instructions an agent keeps. Each one is stored as a
// SKILL.md file: `name` and `description` front matter, then the
// instructions, so skill files from other tools import as they are and the
// box's own files work elsewhere. The harness
// lists every skill's name and description in the agent's system prompt and the
// agent loads a body with load_skill when a request matches; a message that
// starts with "/<command>" (or Run now, or the skill's schedule) carries the
// body itself.
import { randomUUID } from "node:crypto";
import { type AgentId, type InvokedSkill, qualifiedSkillCommand, type Skill, skillCommand, type SkillSpec } from "../shared/model";
import { describeCron, isValidCron } from "./cron";
import { computeNextRun, skillSchedule } from "./scheduler";

export const MAX_SKILL_NAME = 64;
export const MAX_SKILL_DESCRIPTION = 1024;
export const MAX_SKILL_BODY = 50_000;
const MAX_FETCH_BYTES = 1024 * 1024;

export interface SkillFile {
  name: string | null;
  description: string | null;
  body: string;
  /** Front matter other than name and description, verbatim, so saving the skill keeps it. */
  extra: string;
  disableModelInvocation: boolean;
}

/** Reads a SKILL.md: optional `---` front matter (plain, quoted and block scalars), then the instructions. */
export function parseSkillFile(text: string): SkillFile {
  const source = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const none: SkillFile = { name: null, description: null, body: source.trim(), extra: "", disableModelInvocation: false };
  const open = /^---[ \t]*\n/.exec(source);
  if (open == null) return none;
  const rest = source.slice(open[0].length);
  const close = /^---[ \t]*$/m.exec(rest);
  if (close == null) return none;
  const header = rest.slice(0, close.index);
  if (header.trim().length > 0 && !/^[\w-][\w.-]*[ \t]*:/m.test(header)) return none; // a horizontal rule, not front matter

  // Top-level entries: a `key:` line at column 0 and the indented or blank lines under it.
  const entries: Array<{ key: string | null; lines: string[] }> = [];
  for (const line of header.split("\n")) {
    const key = /^([\w-][\w.-]*)[ \t]*:(?=[ \t]|$)/.exec(line);
    if (key != null) entries.push({ key: key[1], lines: [line] });
    else if (entries.length > 0 && (line.trim().length === 0 || /^[ \t]/.test(line))) entries[entries.length - 1].lines.push(line);
    else entries.push({ key: null, lines: [line] });
  }
  const value = (key: string) => {
    const entry = entries.find((candidate) => candidate.key === key);
    return entry == null ? null : scalar(entry.lines);
  };
  const extra = entries
    .filter((entry) => entry.key !== "name" && entry.key !== "description")
    .flatMap((entry) => entry.lines)
    .join("\n")
    .trim();
  return {
    name: nonEmpty(value("name")),
    description: nonEmpty(value("description")),
    body: rest.slice(close.index + close[0].length).trim(),
    extra,
    disableModelInvocation: /^(true|yes|on)$/i.test(value("disable-model-invocation") ?? ""),
  };
}

/** A skill as its SKILL.md file. */
export function skillFileText(skill: Pick<Skill, "name" | "description" | "body">, extra: string): string {
  const header = [`name: ${yamlString(skill.name)}`, `description: ${yamlString(skill.description)}`, ...(extra.trim().length > 0 ? [extra.trim()] : [])];
  return `---\n${header.join("\n")}\n---\n\n${skill.body.trim()}\n`;
}

const nonEmpty = (text: string | null) => (text == null || text.trim().length === 0 ? null : text.trim());

/** One front matter value: the rest of the key's line plus the lines under it. */
function scalar(lines: string[]): string {
  const first = lines[0].slice(lines[0].indexOf(":") + 1).trim();
  const more = lines.slice(1);
  if (first.startsWith('"') || first.startsWith("'")) return quoted([first, ...more.map((line) => line.trim())].join("\n"));
  const block = /^([|>])[+-]?\d?[+-]?[ \t]*(#.*)?$/.exec(first);
  if (block != null) {
    const indent = Math.min(...more.filter((line) => line.trim().length > 0).map((line) => /^[ \t]*/.exec(line)![0].length));
    const text = more.map((line) => line.slice(Math.min(indent, line.length)).trimEnd());
    if (block[1] === "|") return text.join("\n").trim();
    return text
      .join("\n")
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.split("\n").join(" "))
      .join("\n")
      .trim();
  }
  return [first.replace(/[ \t]+#.*$/, ""), ...more.map((line) => line.trim())].filter((line) => line.length > 0).join(" ");
}

/** A single- or double-quoted scalar; line breaks fold to spaces and blank lines to newlines, as in YAML. */
function quoted(text: string): string {
  const quote = text[0];
  let out = "";
  for (let i = 1; i < text.length; i++) {
    const char = text[i];
    if (char === quote) {
      if (quote === "'" && text[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      break;
    }
    if (char === "\n") {
      let blank = 0;
      while (text[i + 1] === "\n") {
        blank++;
        i++;
      }
      out += blank > 0 ? "\n".repeat(blank) : " ";
      continue;
    }
    if (char !== "\\" || quote === "'") {
      out += char;
      continue;
    }
    const next = text[++i];
    if (next == null) break;
    const width = next === "x" ? 2 : next === "u" ? 4 : next === "U" ? 8 : 0;
    if (width > 0) {
      const code = Number.parseInt(text.slice(i + 1, i + 1 + width), 16);
      i += width;
      if (code <= 0x10ffff) out += String.fromCodePoint(code);
    } else if (next !== "\n") {
      out += { n: "\n", t: "\t", r: "\r", "0": "\0", b: "\b", f: "\f", e: "\x1b", _: " ", N: "\u0085", L: " ", P: " " }[next] ?? next;
    }
  }
  return out;
}

/** A plain scalar when it reads back the same, else a double-quoted one (JSON string syntax is valid YAML). */
function yamlString(value: string): string {
  const plain =
    value.length > 0 &&
    value === value.trim() &&
    !/[\n\t]|: |[ \t]#|:$/.test(value) &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !/^(true|false|yes|no|on|off|y|n|null|~)$/i.test(value) &&
    !/^[-+]?\.?\d/.test(value);
  return plain ? value : JSON.stringify(value);
}

/** A skill name a new or renamed skill can't take; `pluginName` when an installed plugin's skill has it. */
export type TakenSkillName = Pick<Skill, "id" | "name"> & { pluginName?: string };

/**
 * Checks a spec and fills in what the box keeps (id, file path, next run); throws a message for the
 * user. `others` are the names its command can't share (BoxStore.skillNamesInUse): the agent's other
 * skills, and every installed plugin's, turned off or not.
 */
export function buildSkill(agentId: AgentId, spec: SkillSpec, others: TakenSkillName[], existing?: Skill): Skill {
  const name = spec.name.replace(/\s+/g, " ").trim();
  const description = spec.description.trim();
  const body = spec.body.trim();
  if (name.length === 0) throw new Error("A skill needs a name.");
  if (name.length > MAX_SKILL_NAME) throw new Error(`A skill’s name can be up to ${MAX_SKILL_NAME} characters.`);
  if (skillCommand(name).length === 0) throw new Error("A skill’s name needs a letter or a digit.");
  // A skill that already shares a plugin's command (made before the plugin came) keeps its name while it's edited.
  const renamed = existing == null || skillCommand(existing.name) !== skillCommand(name);
  const clash = others.find((other) => other.id !== existing?.id && skillCommand(other.name) === skillCommand(name) && (other.pluginName == null || renamed));
  if (clash?.pluginName != null) throw new Error(`The installed plugin ${clash.pluginName} has a skill named “${clash.name}”, which runs as the same command. Pick another name.`);
  if (clash != null) throw new Error(`This agent already has a skill named “${clash.name}”.`);
  if (description.length === 0) throw new Error("Describe when the agent should use this skill.");
  if (description.length > MAX_SKILL_DESCRIPTION) throw new Error(`A skill’s description can be up to ${MAX_SKILL_DESCRIPTION} characters.`);
  if (body.length === 0) throw new Error("A skill needs instructions.");
  if (body.length > MAX_SKILL_BODY) throw new Error(`A skill’s instructions can be up to ${MAX_SKILL_BODY.toLocaleString("en-US")} characters.`);
  const trigger = spec.trigger == null ? null : { isEnabled: spec.trigger.isEnabled, schedule: spec.trigger.schedule.trim() };
  if (trigger != null && !isValidCron(trigger.schedule)) throw new Error(`Invalid cron schedule "${trigger.schedule}".`);
  const now = Date.now();
  const id = existing?.id ?? randomUUID();
  const skill: Skill = {
    id,
    agentId,
    name,
    description,
    body,
    createdAt: existing?.createdAt ?? now,
    filePath: `skills/${agentId}/${id}.md`,
    disableModelInvocation: existing?.disableModelInvocation ?? null,
    sourceRef: spec.sourceRef !== undefined ? spec.sourceRef : (existing?.sourceRef ?? null),
    trigger,
    scheduleDescription: trigger == null ? null : describeCron(trigger.schedule),
    lastRunAt: existing?.lastRunAt ?? null,
    nextRunAt: null,
    runs: existing?.runs ?? [],
  };
  skill.nextRunAt = computeNextRun(skillSchedule(skill), now);
  return skill;
}

/**
 * A skill from a SKILL.md, or from any Markdown document (named by `name` or its first heading,
 * described by its first paragraph), or why it can't be one.
 */
export function skillFromMarkdown(text: string, name?: string | null): { spec: SkillSpec; extra: string } | { reason: string } {
  const file = parseSkillFile(text);
  const heading = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(file.body)?.[1] ?? null;
  const finalName = nonEmpty(name ?? null) ?? file.name ?? heading;
  if (finalName == null) return { reason: "It has no name. Add a name: line to its front matter, or type a name for it." };
  if (finalName.length > MAX_SKILL_NAME) return { reason: `Its name is longer than ${MAX_SKILL_NAME} characters. Type a shorter one.` };
  if (file.body.length === 0) return { reason: "It has no instructions after its front matter." };
  if (file.body.length > MAX_SKILL_BODY) return { reason: `It is longer than ${MAX_SKILL_BODY.toLocaleString("en-US")} characters.` };
  const description = (file.description ?? firstParagraph(file.body) ?? `Use when the user asks for ${finalName}.`).slice(0, MAX_SKILL_DESCRIPTION);
  return { spec: { name: finalName, description, body: file.body, trigger: null }, extra: file.extra };
}

/** The first run of plain text lines (not a heading, rule, fence or table), with list and quote markers dropped. */
function firstParagraph(body: string): string | null {
  for (const block of body.split(/\n\s*\n/)) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^(#|```|~~~|\||---|\*\*\*|<)/.test(line))
      .map((line) => line.replace(/^([-*+]|\d+[.)]|>)\s+/, ""));
    if (lines.length > 0) return lines.join(" ").replace(/\s+/g, " ").slice(0, 300);
  }
  return null;
}

/**
 * A skill by its command. With a colon ("notes:summarize") it's that skill exactly, a plugin's
 * first: never an agent's own skill whose name only folds to the same command ("notes summarize").
 * Without one ("notes-summarize") the colon and the spaces fold alike, and the agent's own skill
 * wins, since listSkills puts them first.
 */
function skillByCommand(skills: Skill[], typed: string): Skill | null {
  if (typed.includes(":")) {
    const wanted = qualifiedSkillCommand(typed);
    const exact = skills.filter((skill) => qualifiedSkillCommand(skill.name) === wanted);
    return exact.find((skill) => skill.source === "plugin") ?? exact[0] ?? null;
  }
  const wanted = skillCommand(typed);
  return wanted.length === 0 ? null : (skills.find((skill) => skillCommand(skill.name) === wanted) ?? null);
}

/** The skill a prompt runs: "/<command>" at its start, alone or followed by more text ("/plugin:skill" for a plugin's). */
export function skillForPrompt(prompt: string, skills: Skill[]): Skill | null {
  const match = /^\/([\p{L}\p{N}][\p{L}\p{N}:-]*)(?=\s|$)/u.exec(prompt.trimStart());
  return match != null ? skillByCommand(skills, match[1]) : null;
}

/** A skill by the name the model gave load_skill: its name, its command, or either with odd spacing or case. */
export function findSkill(skills: Skill[], name: string): Skill | null {
  return skillByCommand(skills, name.replace(/^\//, ""));
}

/** What the model reads with a message that runs a skill. */
export function invokedSkillText(skill: InvokedSkill, scheduled: boolean): string {
  return `${scheduled ? `The skill “${skill.name}” ran on its schedule.` : `The user ran the skill “${skill.name}”.`} Follow its instructions:\n\n${skill.body}`;
}

/**
 * The raw file behind a GitHub page link (a file, a folder's `folderFile` when there is one, or a
 * gist); other addresses as given.
 */
export function rawFileUrl(address: string, folderFile: string | null): string {
  const url = new URL(address);
  if (url.hostname === "github.com") {
    const match = /^\/([^/]+)\/([^/]+)\/(blob|tree)\/(.+?)\/?$/.exec(url.pathname);
    if (match != null && (match[3] === "blob" || folderFile != null)) return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[4]}${match[3] === "tree" ? `/${folderFile}` : ""}`;
  }
  if (url.hostname === "gist.github.com") {
    const match = /^\/([^/]+)\/([0-9a-f]+)\/?$/i.exec(url.pathname);
    if (match != null) return `https://gist.githubusercontent.com/${match[1]}/${match[2]}/raw`;
  }
  return url.toString();
}

/** The raw file behind a GitHub page link (a file, a skill folder's SKILL.md, or a gist); other addresses as given. */
export const rawSkillUrl = (address: string): string => rawFileUrl(address, "SKILL.md");

/** Fetches a skill file (up to 1 MiB of text); throws a message for the user. */
export const fetchSkillText = (address: string): Promise<string> =>
  fetchLimitedText(rawSkillUrl(address), { accept: "text/markdown, text/plain;q=0.9, */*;q=0.5", webPage: "That address is a web page, not a Markdown file. Link to the raw SKILL.md instead." });

/**
 * Fetches up to 1 MiB of text (skill files, and bot templates for main); throws a message for the
 * user. `webPage` is what to say when the address answers with a web page instead.
 */
export async function fetchLimitedText(address: string, options: { accept: string; webPage: string }): Promise<string> {
  let response: Response;
  try {
    response = await fetch(address, {
      signal: AbortSignal.timeout(30_000),
      headers: { "user-agent": "Wisp/0.1 (+desktop agent)", accept: options.accept },
      redirect: "follow",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new Error("It didn’t answer within 30 seconds.");
    // fetch() says only "fetch failed"; what went wrong (DNS, TLS, refused) is its cause's code.
    const cause = error instanceof Error ? (error.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
    const reason = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : String(error);
    if (reason === "ERR_SSL_WRONG_VERSION_NUMBER") throw new Error("It doesn’t answer HTTPS. If it’s a plain http:// address, type the http:// in front.");
    throw new Error(`Couldn’t reach it (${reason}).`);
  }
  if (!response.ok) throw new Error(`The address answered HTTP ${response.status}.`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  for (;;) {
    const read = await reader?.read();
    if (read == null || read.done) break;
    size += read.value.byteLength;
    if (size > MAX_FETCH_BYTES) {
      void reader?.cancel();
      throw new Error("The file is larger than 1 MiB.");
    }
    chunks.push(read.value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (/html/i.test(response.headers.get("content-type") ?? "") || /^\s*<(!doctype|html)/i.test(text)) throw new Error(options.webPage);
  return text;
}
