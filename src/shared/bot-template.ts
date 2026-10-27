// Bot templates: an agent packaged to share. A template carries the agent's profile, its
// instructions (`body`), skills, routines (automations), optionally memories, and the Connect Apps
// apps it uses (`plugins`, which only name an app: no account or token travels). The box keeps
// versions of each agent's template; a version is also the file Save file writes and the JSON a box
// serves at /t/<shareId> once it is published for anyone with the link.
//
// A template is someone else's text: its body, skills and memories become what the new agent reads,
// and its routines run on their own. Characters that don't show on screen are taken out before
// anyone sees a preview, imported routines start switched off, and nothing is created until the
// user confirms the preview (addAgentFromTemplate).
import { z } from "zod";
import type { AgentSummary, TranscriptEntry } from "./model";

/** Names the file format, so a newer one is recognized instead of half-read. */
export const BOT_TEMPLATE_FORMAT = "wisp-template/1";
export const BOT_TEMPLATE_EXTENSION = ".wisp-template.json";
/** A template file, a fetched template and a pasted one: the skill importer's cap. */
export const MAX_TEMPLATE_BYTES = 1024 * 1024;
export const MAX_TEMPLATE_SKILLS = 50;
export const MAX_TEMPLATE_ROUTINES = 50;
export const MAX_TEMPLATE_MEMORIES = 100;
export const MAX_TEMPLATE_PLUGINS = 50;

/** Share ids are 21-character nanoids. */
export const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const shareIdSchema = z.string().regex(SHARE_ID_PATTERN, "isn’t a template id");

/** A small picture instead of the shape: PNG, JPEG or WebP as a data URL, up to about 64 KB. */
const avatarDataUrl = z
  .string()
  .max(90_000)
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/, "isn’t a PNG, JPEG or WebP data URL");

const skillSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
  /** The SKILL.md file: front matter (name, description and any other keys), then the instructions. */
  content: z.string().min(1).max(60_000),
  /** The skill's cron schedule; it arrives switched off. */
  schedule: z.string().min(1).max(120).optional(),
});

const routineSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().max(120).default(""),
  description: z.string().max(2000).default(""),
  /** The prompt the agent gets each time it runs. */
  content: z.string().min(1).max(20_000),
  /** When it runs (cron). A routine without one can't be added. */
  schedule: z.string().min(1).max(120).optional(),
});

const memorySchema = z.object({
  content: z.string().min(1).max(4000),
  createdAt: z.string().max(64).optional(),
  kind: z.enum(["log", "profile"]).nullable().optional(),
});

const pluginSchema = z.object({
  /** The app's id in the Connect Apps catalog (`McpServerConfig.pluginId`). */
  pluginId: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

/** A template file: the template's fields, plus `format`, `description` and an optional avatar. */
export const botTemplateSchema = z.object({
  format: z.literal(BOT_TEMPLATE_FORMAT),
  shareId: shareIdSchema,
  shareUrl: z.string().max(2048).default(""),
  version: z.number().int().min(1).optional(),
  activeVersion: z.number().int().min(1).optional(),
  active: z.boolean().nullable().optional(),
  published: z.boolean().nullable().optional(),
  visibility: z.enum(["public", "team"]).nullable().optional(),
  createdAtMs: z.number().optional(),
  updatedAtMs: z.number().optional(),
  creatorName: z.string().max(200).optional(),
  sourceAgentId: z.string().max(200).optional(),
  name: z.string().trim().min(1).max(80),
  title: z.string().max(200).optional(),
  /** The agent's role. */
  description: z.string().max(2000).optional(),
  /** Any string, as on the wire; a shape or color the app doesn't know is drawn as the default. */
  avatarShape: z.string().max(40),
  avatarColor: z.string().max(40),
  avatarDataUrl: avatarDataUrl.optional(),
  /** The agent's instructions. */
  body: z.string().max(20_000),
  skills: z.array(skillSchema).max(MAX_TEMPLATE_SKILLS).optional(),
  routines: z.array(routineSchema).max(MAX_TEMPLATE_ROUTINES).optional(),
  memory: z.array(memorySchema).max(MAX_TEMPLATE_MEMORIES).optional(),
  plugins: z.array(pluginSchema).max(MAX_TEMPLATE_PLUGINS).optional(),
});

export type BotTemplate = z.infer<typeof botTemplateSchema>;
export type BotTemplateSkill = NonNullable<BotTemplate["skills"]>[number];
export type BotTemplateRoutine = NonNullable<BotTemplate["routines"]>[number];
export type BotTemplateMemory = NonNullable<BotTemplate["memory"]>[number];
export type BotTemplatePlugin = NonNullable<BotTemplate["plugins"]>[number];

/** What a new version takes from its agent besides the profile: the instructions, and the items by id. */
export const botTemplateInclude = z.object({
  body: z.boolean(),
  skillIds: z.array(z.string().min(1).max(200)).max(MAX_TEMPLATE_SKILLS),
  automationIds: z.array(z.string().min(1).max(200)).max(MAX_TEMPLATE_ROUTINES),
  memoryIds: z.array(z.string().min(1).max(200)).max(MAX_TEMPLATE_MEMORIES),
  pluginIds: z.array(z.string().min(1).max(100)).max(MAX_TEMPLATE_PLUGINS),
});
export type BotTemplateInclude = z.infer<typeof botTemplateInclude>;

/** One version of a template, newest last. */
export interface BotTemplateVersionInfo {
  version: number;
  createdAtMs: number;
}

/**
 * A template version as readTemplateVersion returns it, which is also what Save file writes:
 * the content, where it comes from and how it is published.
 */
export interface BotTemplateFile extends BotTemplate {
  version: number;
  active: boolean;
  published: boolean;
  visibility: "public" | "team" | null;
  createdAtMs: number;
  updatedAtMs: number;
}

/** A template as the box's other methods return it: its latest version, plus every version. */
export interface BotTemplateView extends BotTemplateFile {
  versions: BotTemplateVersionInfo[];
}

/** addAgentFromTemplate's setup recipe (`kind: "recipe"`): what the new agent got. */
export interface BotTemplateSetup {
  kind: "recipe";
  /** The routines added, each switched off until the user turns it on. */
  automations: Array<{ name: string; slug: string; description: string; content: string }>;
  memories: Array<{ content: string }>;
  /** The apps the template names; connecting them is up to the user. */
  plugins: Array<{ pluginId: string; name: string; description?: string }>;
  skills: Array<{ name: string; description: string; content: string }>;
  /** A skill called "Getting started", which the user can run first. */
  gettingStartedSkill?: string;
  /** Whether the template came from the app itself (the starter gallery) rather than a file or a link. */
  isTrustedSource: boolean;
  /** What wasn't added, and why. */
  skipped: Array<{ kind: "skill" | "routine" | "memory"; name: string; reason: string }>;
}

export interface CreateAgentFromTemplateResult {
  agent: AgentSummary;
  setup: BotTemplateSetup;
  transcript: TranscriptEntry[];
}

/**
 * A starter template in the gallery (always the default avatar, never an image; categories by
 * their labels).
 */
export interface BotMarketplaceListing {
  slug: string;
  name: string;
  description: string;
  defaultAvatar: { shape: string; color: string };
  category: string;
  categories: string[];
  createdAtMs: number;
  updatedAtMs: number;
  /** The template, which fetchSharedTemplate fetches from the box by this id. */
  shareId: string;
  creator: { name: string; profilePhotoUrl: string; handles: Record<string, string> };
  featured: boolean;
}

/** The starter gallery, which has one page. */
export interface BotMarketplace {
  featuredListings: BotMarketplaceListing[];
  listings: BotMarketplaceListing[];
  nextPageToken: string;
  allCategoriesOrder: string[];
}

/** A template main read or fetched for the Add Bot preview; nothing has been created from it. */
export interface FetchedBotTemplate {
  template: BotTemplate;
  /** Characters that wouldn't show in the preview, taken out of its text. */
  hiddenCharacters: number;
  /** Where it came from, as the preview names it: a file name, a host, "your box". */
  source: string;
}

/**
 * Text a model reads but a preview doesn't show: Unicode tag characters and the variation selectors
 * past the emoji ones (both can carry a hidden message), bidirectional controls (which reorder what
 * shows), zero-width spaces and invisible operators, and control characters other than tab and
 * newline. Zero-width joiners stay: emoji and several scripts need them.
 */
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F᠎​‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

/** The text without characters that don't show; Windows line ends become newlines. */
export function visibleText(text: string): { text: string; removed: number } {
  let removed = 0;
  const clean = text.replace(/\r\n?/g, "\n").replace(HIDDEN, () => {
    removed++;
    return "";
  });
  return { text: clean, removed };
}

/** Every string in a parsed document, cleaned (see visibleText), and how many characters went. */
function cleanStrings(value: unknown): { value: unknown; removed: number } {
  if (typeof value === "string") {
    const { text, removed } = visibleText(value);
    return { value: text, removed };
  }
  if (Array.isArray(value)) {
    let removed = 0;
    const items = value.map((item) => {
      const cleaned = cleanStrings(item);
      removed += cleaned.removed;
      return cleaned.value;
    });
    return { value: items, removed };
  }
  if (typeof value === "object" && value != null) {
    let removed = 0;
    const entries = Object.entries(value).map(([key, item]) => {
      const cleaned = cleanStrings(item);
      removed += cleaned.removed;
      return [key, cleaned.value];
    });
    return { value: Object.fromEntries(entries), removed };
  }
  return { value, removed: 0 };
}

/** Checks a template object (a parsed file, or one sent to the box) and cleans its text; the error is for the user. */
export function readBotTemplate(value: unknown): { template: BotTemplate; hiddenCharacters: number } | { error: string } {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return { error: "It isn’t a bot template." };
  const format = (value as { format?: unknown }).format;
  if (format !== BOT_TEMPLATE_FORMAT) {
    if (typeof format === "string" && format.startsWith("wisp-template/")) return { error: `It was made by a newer version of the app (${format.slice(0, 40)}).` };
    return { error: `It isn’t a bot template: it has no "format": "${BOT_TEMPLATE_FORMAT}".` };
  }
  const cleaned = cleanStrings(value);
  const parsed = botTemplateSchema.safeParse(cleaned.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return { error: `It isn’t a valid bot template (${where}${issue.message}).` };
  }
  return { template: parsed.data, hiddenCharacters: cleaned.removed };
}

/** A template from a file's or a page's text. */
export function parseBotTemplate(text: string): { template: BotTemplate; hiddenCharacters: number } | { error: string } {
  if (text.length > MAX_TEMPLATE_BYTES) return { error: "It is larger than 1 MiB." };
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { error: "It isn’t a bot template: it isn’t JSON." };
  }
  return readBotTemplate(value);
}

/** Where a template may be fetched from: https, or plain http on this computer. */
export function templateUrlAllowed(address: string): boolean {
  try {
    const url = new URL(address);
    return url.protocol === "https:" || (url.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname));
  } catch {
    return false;
  }
}

/** The app link that opens a template in Add Bot: by share id on the user's own box, or by its address. */
export function botTemplateLink(source: { shareId: string } | { url: string }): string {
  return "shareId" in source ? `wisp://bot-template?id=${encodeURIComponent(source.shareId)}&open=1` : `wisp://bot-template?url=${encodeURIComponent(source.url)}`;
}

/** A file name for the template: its name, kept to letters, digits and dashes. */
export function botTemplateFileName(name: string): string {
  const base = name.normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "bot";
  return `${base}${BOT_TEMPLATE_EXTENSION}`;
}
