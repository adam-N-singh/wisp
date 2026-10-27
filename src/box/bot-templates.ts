// Bot templates in the box, which answers the template methods for its own agents and keeps
// templates here: versions made from an agent, the one published for a link, and new agents
// made from a template the user confirmed in Add Bot (src/shared/bot-template.ts has the format).
//
// A new version is the agent as it is now, limited to what the user chose: the profile always, the
// instructions, and the skills, routines (automations), memories and apps they ticked. A version
// that would say exactly what the latest one says isn't made again.
//
// Importing adds the template's skills and memories, and its routines switched off and marked
// `provenance: "from_template"`, so nothing the template brought runs before the user turns it on.
// The starters bundled with the box (bot-templates.json) are served as published templates too.
import { randomBytes } from "node:crypto";
import {
  type BotMarketplace,
  type BotMarketplaceListing,
  type BotTemplate,
  type BotTemplateFile,
  type BotTemplateInclude,
  botTemplateLink,
  type BotTemplateSetup,
  type BotTemplateView,
  BOT_TEMPLATE_FORMAT,
  readBotTemplate,
} from "../shared/bot-template";
import { type AgentSummary, AVATAR_COLORS, AVATAR_SHAPES, type AvatarColor, type AvatarShape, skillCommand } from "../shared/model";
import { isValidCron } from "./cron";
import { addMemory, MemoryError } from "./memory";
import { buildAutomation } from "./scheduler";
import galleryFile from "./bot-templates.json";
import { buildSkill, skillFromMarkdown } from "./skills";
import type { BoxStore, TemplateRecord } from "./store";

/** Why a template call was refused; the message is for the user. */
export class BotTemplateError extends Error {
  constructor(
    readonly code: "not-found" | "stale" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "BotTemplateError";
  }
}

/** An app in the Connect Apps catalog, by its id. */
export type CatalogLookup = (pluginId: string) => { name: string; description: string } | null;

const SHARE_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** 21 characters from a 64-letter alphabet, a nanoid. */
export function newShareId(): string {
  return [...randomBytes(21)].map((byte) => SHARE_ID_ALPHABET[byte & 63]).join("");
}

/** A shape or color from a template, or the default when the app doesn't know it. */
export const avatarShapeOf = (shape: string): AvatarShape => (AVATAR_SHAPES as readonly string[]).includes(shape) ? (shape as AvatarShape) : "blob";
export const avatarColorOf = (color: string): AvatarColor => (AVATAR_COLORS as readonly string[]).includes(color) ? (color as AvatarColor) : "gray";

const missing = (what: string) => new BotTemplateError("stale", `${what} isn’t this agent’s any more. Close the dialog and open Share as template again.`);

/** The agent as a template's content: its profile, and what `include` names. */
export function templateContent(store: BoxStore, agent: AgentSummary, include: BotTemplateInclude, shareId: string, apps: CatalogLookup): BotTemplate {
  const skills = include.skillIds.map((id) => {
    const skill = store.getSkill(agent.id, id);
    const content = store.skillFile(agent.id, id);
    if (skill == null || content == null) throw missing("A skill you picked");
    return { name: skill.name, description: skill.description, content, ...(skill.trigger != null ? { schedule: skill.trigger.schedule } : {}) };
  });
  const automations = store.listAutomations(agent.id);
  const routines = include.automationIds.map((id) => {
    const automation = automations.find((candidate) => candidate.id === id);
    if (automation == null) throw missing("A routine you picked");
    return { name: automation.name, slug: skillCommand(automation.name), description: automation.triggerDescription, content: automation.prompt, schedule: automation.schedule };
  });
  // A memory the agent asked to add and the user hasn't approved isn't one yet.
  const memories = store.listMemories(agent.id).filter((memory) => memory.review?.action !== "add");
  const memory = include.memoryIds.map((id) => {
    const found = memories.find((candidate) => candidate.id === id);
    if (found == null) throw missing("A memory you picked");
    return { content: found.text, createdAt: new Date(found.createdAt).toISOString() };
  });
  const plugins = [...new Set(include.pluginIds)].map((pluginId) => {
    const app = apps(pluginId);
    if (app == null) throw new BotTemplateError("invalid", `“${pluginId}” isn’t an app in Connect Apps.`);
    return { pluginId, name: app.name, description: app.description };
  });
  const content = {
    format: BOT_TEMPLATE_FORMAT,
    shareId,
    sourceAgentId: agent.id,
    name: agent.name,
    ...(agent.title ? { title: agent.title } : {}),
    description: agent.description,
    avatarShape: agent.avatarShape ?? "blob",
    avatarColor: agent.avatarColor ?? "gray",
    ...(agent.avatarDataUrl != null ? { avatarDataUrl: agent.avatarDataUrl } : {}),
    body: include.body ? agent.instructions : "",
    skills,
    routines,
    memory,
    plugins,
  };
  // The same checks and clean-up as a template someone else sends, so the file reads back as it was saved.
  const read = readBotTemplate(content);
  if ("error" in read) throw new BotTemplateError("invalid", read.error);
  return read.template;
}

/** A version as readTemplateVersion returns it and Save file writes it. */
export function templateFile(record: TemplateRecord, version: number, content: BotTemplate): BotTemplateFile {
  return {
    ...content,
    shareId: record.shareId,
    shareUrl: botTemplateLink({ shareId: record.shareId }),
    version,
    ...(record.activeVersion != null ? { activeVersion: record.activeVersion } : {}),
    active: record.activeVersion === version,
    published: record.published,
    visibility: record.visibility,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    sourceAgentId: record.sourceAgentId,
  };
}

export function requireTemplate(store: BoxStore, shareId: string): TemplateRecord {
  const record = store.getTemplate(shareId);
  if (record == null) throw new BotTemplateError("not-found", "There’s no such template on your box.");
  return record;
}

export function templateVersionFile(store: BoxStore, shareId: string, version: number): BotTemplateFile {
  const record = requireTemplate(store, shareId);
  const content = store.templateVersion(shareId, version);
  if (content == null) throw new BotTemplateError("not-found", `This template has no version ${version}.`);
  return templateFile(record, version, content);
}

/** The template at its latest version, with every version listed; null if that version can't be read. */
export function templateView(store: BoxStore, record: TemplateRecord): BotTemplateView | null {
  const latest = record.versions[record.versions.length - 1];
  const content = latest != null ? store.templateVersion(record.shareId, latest.version) : null;
  return latest != null && content != null ? { ...templateFile(record, latest.version, content), versions: record.versions } : null;
}

const viewOf = (store: BoxStore, record: TemplateRecord): BotTemplateView => {
  const view = templateView(store, record);
  if (view == null) throw new BotTemplateError("not-found", "This template’s files can’t be read.");
  return view;
};

/** Saves the agent as its template's next version, making the template on first use; the latest is kept when nothing changed. */
export function saveTemplateVersion(store: BoxStore, agent: AgentSummary, include: BotTemplateInclude, apps: CatalogLookup): BotTemplateView {
  const existing = store.templateForAgent(agent.id);
  const shareId = existing?.shareId ?? newShareId();
  const content = templateContent(store, agent, include, shareId, apps);
  const latest = existing?.versions[existing.versions.length - 1];
  if (existing != null && latest != null && JSON.stringify(store.templateVersion(shareId, latest.version)) === JSON.stringify(content)) return viewOf(store, existing);
  const now = Date.now();
  const version = (latest?.version ?? 0) + 1;
  store.putTemplateVersion(shareId, version, content);
  const record: TemplateRecord = existing ?? { shareId, sourceAgentId: agent.id, createdAtMs: now, updatedAtMs: now, activeVersion: null, published: false, visibility: null, versions: [] };
  return viewOf(store, store.putTemplate({ ...record, updatedAtMs: now, versions: [...record.versions, { version, createdAtMs: now }] }));
}

/** Makes this version the one the template's link serves. */
export function publishTemplate(store: BoxStore, shareId: string, version: number): BotTemplateView {
  const record = requireTemplate(store, shareId);
  if (!record.versions.some((info) => info.version === version)) throw new BotTemplateError("not-found", `This template has no version ${version}.`);
  return viewOf(store, store.putTemplate({ ...record, activeVersion: version, published: true, updatedAtMs: Date.now() }));
}

export function setTemplateVisibility(store: BoxStore, shareId: string, visibility: "public" | "team"): BotTemplateView {
  const record = requireTemplate(store, shareId);
  return viewOf(store, store.putTemplate({ ...record, visibility, updatedAtMs: Date.now() }));
}

/** The published version of a template anyone with its link may fetch (one of the box's, or a starter), or null. */
export function publicTemplate(store: BoxStore, shareId: string, gallery: GalleryFile = BOT_GALLERY): BotTemplateFile | null {
  const record = store.getTemplate(shareId);
  if (record == null) return galleryTemplateFile(shareId, gallery);
  if (!record.published || record.visibility !== "public" || record.activeVersion == null) return null;
  const content = store.templateVersion(shareId, record.activeVersion);
  return content != null ? templateFile(record, record.activeVersion, content) : null;
}

// ---- the starter gallery -------------------------------------------------------------------
// Starter templates bundled with the box (bot-templates.json, like the Connect Apps catalog), listed
// as marketplace listings (listStarterTemplates) and served as published templates at
// /t/<shareId>, so Add Bot reads a starter as it reads any link.

export interface GalleryFile {
  categories: Array<{ key: string; label: string }>;
  /** When the starters last changed. */
  updatedAtMs: number;
  templates: Array<{ slug: string; category: string; featured?: boolean; template: unknown }>;
}

export const BOT_GALLERY = galleryFile as GalleryFile;
const GALLERY_CREATOR = "Wisp";

/** The starters that read as templates (the unit tests check that every one does). */
export function galleryTemplates(file: GalleryFile = BOT_GALLERY): Array<{ entry: GalleryFile["templates"][number]; template: BotTemplate }> {
  return file.templates.flatMap((entry) => {
    const read = readBotTemplate(entry.template);
    return "template" in read ? [{ entry, template: read.template }] : [];
  });
}

/** The gallery as listStarterTemplates answers it: by category, then in the file's order; `category` is a key or a label. */
export function botMarketplace(file: GalleryFile = BOT_GALLERY, category?: string): BotMarketplace {
  const labels = new Map(file.categories.map((item) => [item.key, item.label]));
  const order = file.categories.map((item) => item.label);
  const listings = galleryTemplates(file)
    .filter(({ entry }) => category == null || entry.category === category || labels.get(entry.category) === category)
    .map(({ entry, template }): BotMarketplaceListing => {
      const label = labels.get(entry.category) ?? entry.category;
      return {
        slug: entry.slug,
        name: template.name,
        description: template.description ?? "",
        defaultAvatar: { shape: template.avatarShape, color: template.avatarColor },
        category: label,
        categories: [label],
        createdAtMs: file.updatedAtMs,
        updatedAtMs: file.updatedAtMs,
        shareId: template.shareId,
        creator: { name: GALLERY_CREATOR, profilePhotoUrl: "", handles: {} },
        featured: entry.featured === true,
      };
    })
    .sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
  return { featuredListings: listings.filter((listing) => listing.featured), listings, nextPageToken: "", allCategoriesOrder: order };
}

/** A starter as a published template file, or null. */
function galleryTemplateFile(shareId: string, file: GalleryFile): BotTemplateFile | null {
  const found = galleryTemplates(file).find(({ template }) => template.shareId === shareId);
  if (found == null) return null;
  return {
    ...found.template,
    shareUrl: botTemplateLink({ shareId }),
    version: 1,
    activeVersion: 1,
    active: true,
    published: true,
    visibility: "public",
    createdAtMs: file.updatedAtMs,
    updatedAtMs: file.updatedAtMs,
    creatorName: GALLERY_CREATOR,
  };
}

/** A starter as the gallery has it, perhaps with items left out but none added or changed: the setup's `isTrustedSource`. */
export function isGalleryTemplate(template: BotTemplate, file: GalleryFile = BOT_GALLERY): boolean {
  const bundled = galleryTemplates(file).find((candidate) => candidate.template.shareId === template.shareId)?.template;
  if (bundled == null) return false;
  const within = (sent: unknown[] | undefined, known: unknown[] | undefined) => (sent ?? []).every((item) => (known ?? []).some((candidate) => JSON.stringify(candidate) === JSON.stringify(item)));
  return (template.body === "" || template.body === bundled.body) && within(template.skills, bundled.skills) && within(template.routines, bundled.routines) && within(template.memory, bundled.memory) && within(template.plugins, bundled.plugins);
}

/** A memory or routine as the skipped list names it. */
const shortName = (text: string) => (text.length > 60 ? `${text.slice(0, 59)}…` : text);

/**
 * Adds what the template brings to an agent just made from it: its skills (their schedules switched
 * off), its routines as automations switched off, and its memories. Each one that can't be added is
 * reported with the reason; the rest still are.
 */
export function importTemplate(store: BoxStore, agentId: string, template: BotTemplate, isTrustedSource: boolean): BotTemplateSetup {
  const setup: BotTemplateSetup = { kind: "recipe", automations: [], memories: [], plugins: [], skills: [], isTrustedSource, skipped: [] };
  for (const skill of template.skills ?? []) {
    try {
      // The name and description the preview showed win over the file's front matter.
      const found = skillFromMarkdown(skill.content, skill.name);
      if ("reason" in found) throw new Error(found.reason);
      const spec = { ...found.spec, description: skill.description.trim() || found.spec.description, sourceRef: null, trigger: skill.schedule != null ? { isEnabled: false, schedule: skill.schedule } : null };
      const added = store.putSkill(buildSkill(agentId, spec, store.listSkills(agentId)), found.extra);
      setup.skills.push({ name: added.name, description: added.description, content: skill.content });
    } catch (error) {
      setup.skipped.push({ kind: "skill", name: skill.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const routine of template.routines ?? []) {
    const schedule = routine.schedule?.trim() ?? "";
    if (schedule.length === 0 || !isValidCron(schedule)) {
      setup.skipped.push({ kind: "routine", name: routine.name, reason: schedule.length === 0 ? "It has no schedule." : `Its schedule “${schedule}” isn’t a cron schedule.` });
      continue;
    }
    const automation = buildAutomation(agentId, { name: routine.name.trim(), prompt: routine.content.trim(), trigger: { type: "cron", schedule }, isEnabled: false });
    store.putAutomation({ ...automation, provenance: "from_template" });
    setup.automations.push({ name: automation.name, slug: routine.slug || skillCommand(routine.name), description: routine.description, content: automation.prompt });
  }
  for (const memory of template.memory ?? []) {
    try {
      const { existing } = addMemory(store, agentId, memory.content, "user", false);
      if (existing) setup.skipped.push({ kind: "memory", name: shortName(memory.content), reason: "Another memory in the template says the same." });
      else setup.memories.push({ content: memory.content });
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      setup.skipped.push({ kind: "memory", name: shortName(memory.content), reason: error.message });
    }
  }
  const seen = new Set<string>();
  for (const plugin of template.plugins ?? []) {
    if (seen.has(plugin.pluginId)) continue;
    seen.add(plugin.pluginId);
    setup.plugins.push({ pluginId: plugin.pluginId, name: plugin.name, ...(plugin.description != null ? { description: plugin.description } : {}) });
  }
  const gettingStarted = setup.skills.find((skill) => skillCommand(skill.name) === "getting-started");
  if (gettingStarted != null) setup.gettingStartedSkill = gettingStarted.name;
  return setup;
}
