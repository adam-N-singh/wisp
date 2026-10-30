// What keeps vault values out of what the agent browser tells the agent (src/main/agent-browser.ts):
// snapshots show filled fields as "filled from your vault" (agent-browser-snapshot.ts), the text of
// every reply and error has the values blanked wherever a page repeats them (a title, a link, a URL
// with them in its query, as a form or a script encodes them), the clipboard's text has them blanked
// for read_clipboard, and screenshots have painted over the filled fields and anything else on screen
// that shows a value (a field or text holding one). Pure, so it's unit-tested.

export const HIDDEN_VALUE = "[hidden: a value from your vault]";
/** Shorter values would blank ordinary words; they're still masked in their own fields, and wherever they're all a field or text holds. */
export const MIN_SCRUBBED = 4;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * How a value can show up in text: as it is, as encodeURIComponent writes it (space as %20 or +),
 * as a form submitted by GET writes it (application/x-www-form-urlencoded, which also encodes
 * ! ' ( ) ~), and as encodeURI writes it.
 */
export function valueForms(value: string): string[] {
  const component = encodeURIComponent(value);
  const form = new URLSearchParams([["", value]]).toString().slice(1);
  return [...new Set([value, component, component.replace(/%20/g, "+"), form, form.replace(/\+/g, "%20"), encodeURI(value)])];
}

/** Blanks every value (and its encoded forms) in `text`, ignoring case. */
export function scrubValues(text: string, values: Iterable<string>): string {
  const forms = new Set<string>();
  for (const value of values) if (value.length >= MIN_SCRUBBED) for (const form of valueForms(value)) forms.add(form);
  if (forms.size === 0) return text;
  const pattern = new RegExp([...forms].sort((a, b) => b.length - a.length).map(escape).join("|"), "gi");
  return text.replace(pattern, HIDDEN_VALUE);
}

/** Whether `text` holds a value: anywhere in it (in any of its forms), or, for a short one, as all of it. */
export function holdsValue(text: string, values: Iterable<string>): boolean {
  const lower = text.toLowerCase();
  for (const value of values) {
    if (value.length === 0) continue;
    if (value.length < MIN_SCRUBBED ? text.trim() === value : valueForms(value).some((form) => lower.includes(form.toLowerCase()))) return true;
  }
  return false;
}

/** The clipboard's text for read_clipboard: all of it hidden when it's a value, else every value in it blanked. */
export function scrubClipboard(text: string, values: Iterable<string>): string {
  const list = [...values];
  return list.some((value) => value.length > 0 && text.trim() === value) ? HIDDEN_VALUE : scrubValues(text, list);
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What's on screen in the page (and its same-origin frames), in CSS pixels from the top left of the view. */
export interface ScreenScan {
  /** Inputs, text areas and dropdowns: what each holds. */
  fields: Array<{ value: string; rects: Region[] }>;
  /** Text nodes. */
  texts: Array<{ text: string; rects: Region[] }>;
  /** The page had more text than a scan reads: what's left can't be checked. */
  truncated: boolean;
}

/** The places on screen that show a vault value (CSS pixels), and how many there are. */
export function valueRegions(scan: ScreenScan, values: Iterable<string>): { regions: Region[]; places: number } {
  const list = [...values];
  const regions: Region[] = [];
  let places = 0;
  for (const item of [...scan.fields.map((field) => ({ text: field.value, rects: field.rects })), ...scan.texts]) {
    if (item.rects.length === 0 || !holdsValue(item.text, list)) continue;
    places++;
    regions.push(...item.rects);
  }
  return { regions, places };
}

/** A box in CSS pixels as one in image pixels, with a margin. */
export function scaleRegion(region: Region, scale: number, margin = 3): Region {
  const x = Math.floor(region.x * scale - margin);
  const y = Math.floor(region.y * scale - margin);
  return { x, y, width: Math.ceil((region.x + region.width) * scale + margin) - x, height: Math.ceil((region.y + region.height) * scale + margin) - y };
}

/** A content quad (CDP DOM.getContentQuads: x1,y1 … x4,y4 in CSS pixels) as a box in image pixels, with a margin. */
export function quadRegion(quad: number[], scale: number, margin = 3): Region {
  const xs = [quad[0], quad[2], quad[4], quad[6]].map((value) => value * scale);
  const ys = [quad[1], quad[3], quad[5], quad[7]].map((value) => value * scale);
  const x = Math.floor(Math.min(...xs) - margin);
  const y = Math.floor(Math.min(...ys) - margin);
  return { x, y, width: Math.ceil(Math.max(...xs) + margin) - x, height: Math.ceil(Math.max(...ys) + margin) - y };
}

/** Paints `regions` of a 32-bit bitmap (BGRA or RGBA, `width` × `height`) solid grey, in place; returns how many pixels it covered. */
export function coverRegions(bitmap: Uint8Array, width: number, height: number, regions: Region[]): number {
  if (bitmap.length < width * height * 4) throw new Error("The bitmap is smaller than its size says.");
  let covered = 0;
  for (const region of regions) {
    const left = Math.max(0, Math.floor(region.x));
    const top = Math.max(0, Math.floor(region.y));
    const right = Math.min(width, Math.ceil(region.x + region.width));
    const bottom = Math.min(height, Math.ceil(region.y + region.height));
    for (let row = top; row < bottom; row++) {
      for (let column = left; column < right; column++) {
        const at = (row * width + column) * 4;
        bitmap[at] = 0x80;
        bitmap[at + 1] = 0x80;
        bitmap[at + 2] = 0x80;
        bitmap[at + 3] = 0xff;
        covered++;
      }
    }
  }
  return covered;
}
