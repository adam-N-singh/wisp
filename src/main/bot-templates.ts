// Bot template files and links for Add Bot and Share as template. Main reads a file the user picked,
// fetches a template from an https address (or a published one from the user's own box, GET
// /t/<shareId>) with the skill importer's fetcher and its 1 MiB cap, and writes a saved file. Each
// template is checked and its hidden characters taken out (src/shared/bot-template.ts) before the
// renderer shows it; creating an agent from it is a separate step the user confirms.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { type BotTemplate, type FetchedBotTemplate, MAX_TEMPLATE_BYTES, parseBotTemplate, SHARE_ID_PATTERN, templateUrlAllowed } from "../shared/bot-template";
import type { BotTemplateSource } from "../shared/edges";
import { fetchLimitedText, rawFileUrl } from "../box/skills";

const checked = (text: string, source: string): FetchedBotTemplate => {
  const parsed = parseBotTemplate(text);
  if ("error" in parsed) throw new Error(parsed.error);
  return { ...parsed, source };
};

/** A template at an address; GitHub file and gist page links fetch the raw file. Throws a message for the user. */
export async function fetchBotTemplate(address: string, source = new URL(address).host): Promise<FetchedBotTemplate> {
  if (!templateUrlAllowed(address)) throw new Error("Templates are fetched from https:// addresses only.");
  const text = await fetchLimitedText(rawFileUrl(address, null), { accept: "application/json, text/plain;q=0.9, */*;q=0.5", webPage: "That address is a web page, not a template. Link to the template’s .json file instead." });
  return checked(text, source);
}

/** A published template on the user's own box, by its share id. */
export async function fetchBoxTemplate(baseUrl: string, shareId: string): Promise<FetchedBotTemplate> {
  try {
    return checked(await fetchLimitedText(`${baseUrl}/t/${encodeURIComponent(shareId)}`, { accept: "application/json", webPage: "Your box answered with a web page." }), "your box");
  } catch (error) {
    if (error instanceof Error && /HTTP 404/.test(error.message)) throw new Error("Your box has no published template with this link. Ask for the template file instead.");
    throw error;
  }
}

export function readBotTemplateFile(path: string): FetchedBotTemplate {
  if (statSync(path).size > MAX_TEMPLATE_BYTES) throw new Error("That file is larger than 1 MiB.");
  return checked(readFileSync(path, "utf8"), basename(path));
}

export function writeBotTemplateFile(path: string, template: BotTemplate): void {
  writeFileSync(path, `${JSON.stringify(template, null, 2)}\n`);
}

/** `wisp://bot-template?id=<shareId>&open=1` or `?url=<https address>`; `open` is accepted, and Add Bot always opens. */
export function botTemplateLinkSource(url: URL): BotTemplateSource | null {
  const id = url.searchParams.get("id");
  const address = url.searchParams.get("url");
  if (id != null && address == null) return SHARE_ID_PATTERN.test(id) ? { shareId: id } : null;
  if (address != null && id == null) return templateUrlAllowed(address) ? { url: address } : null;
  return null;
}
