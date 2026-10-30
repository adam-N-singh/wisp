// browser_snapshot's view of a page: the accessibility tree Chromium builds for it (CDP
// Accessibility.getFullAXTree), as one line per element in document order, indented by nesting.
// Elements an agent can act on (and the landmarks it can read on their own) get a ref ("e7"),
// which stays the element's while its document lives, so refs from an earlier snapshot still work
// after the page changes around them. Text fields show what's in them, except password, payment
// card and one-time code fields and fields filled from the vault. A frame from the page's own
// origin is read in its place, from its own tree (agent-browser.ts fetches it), and its elements'
// refs name their frame, so clicks and typing reach them; a frame from anywhere else is named, with
// where it's from, but not read. No HTML: names, roles, states and text only. Pure, so it's
// unit-tested without a browser.
import { sensitiveField } from "../shared/agent-browser";

export interface AXValue {
  type?: string;
  value?: unknown;
}

export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: Array<{ name: string; value: AXValue }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

/** What the DOM says about a field (DOM.describeNode), which the accessibility tree leaves out. */
export interface FieldInfo {
  tag: string;
  inputType: string;
  autocomplete: string;
  fieldName: string;
}

export interface SnapshotRef {
  ref: string;
  backendNodeId: number;
  role: string;
  name: string;
  /** The frame the element is in; null for the page's own document. */
  frameId: string | null;
}

/** What's inside one of the page's frames: its own accessibility tree (a same-origin frame), or why it isn't read. */
export type FrameContent = { frameId: string; nodes: AXNode[] } | { unread: string };

export interface SnapshotOptions {
  /** Read only this element and what's inside it. */
  rootRef?: string | null;
  maxChars?: number;
  /** The page's address, so links on the same site show as paths. */
  pageUrl?: string;
  /** By backendDOMNodeId, in the page's tree and its frames' alike. */
  fields?: Map<number, FieldInfo>;
  /** Fields filled from the vault: they show as filled, never with what's in them. */
  filled?: ReadonlySet<number>;
  /** The frames' contents, by their frame element's backendDOMNodeId; a frame not here isn't read. */
  frames?: Map<number, FrameContent>;
}

export interface Snapshot {
  text: string;
  truncated: boolean;
  lines: number;
}

export const SNAPSHOT_MAX_CHARS = 14_000;

const INTERACTIVE = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
  "ToggleButton",
  "PopUpButton",
  "ComboBoxMenuButton",
  "DisclosureTriangle",
]);
/** Parts of a page worth reading on their own (browser_snapshot{ref}). */
const REGIONS = new Set(["main", "navigation", "form", "search", "dialog", "alertdialog", "region", "article", "table", "complementary"]);
/** Elements whose value is the point: it shows on their line, and what's inside them doesn't. */
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "PopUpButton", "ComboBoxMenuButton"]);
/** Wrappers that add nothing to a reading: their contents show in their place. */
const TRANSPARENT = new Set(["generic", "none", "presentation", "LabelText", "Section", "Pre", "Ruby", "strong", "emphasis", "mark", "code", "time", "subscript", "superscript", "deletion", "insertion", "Abbr", "abbr", "LayoutTable", "LayoutTableRow", "LayoutTableCell"]);
const SKIPPED = new Set(["InlineTextBox", "LineBreak", "ListMarker", "MenuListPopup"]);
const ROLE_LABELS: Record<string, string> = { ToggleButton: "button", PopUpButton: "combobox", ComboBoxMenuButton: "combobox", DisclosureTriangle: "button", image: "img", Iframe: "iframe", IframePresentational: "iframe" };
const NAME_LIMIT = 200;
const TEXT_LIMIT = 2_000;

/** The fields whose DOM details (FieldInfo) the snapshot wants, to keep secrets out of it. */
export function needsFieldInfo(role: string): boolean {
  return VALUE_ROLES.has(role);
}

/**
 * Refs for one page: an element keeps its ref across snapshots until the page navigates. Node ids
 * are the renderer's, one numbering for the page and its same-origin frames, so a ref also says
 * which frame its element is in.
 */
export class RefTable {
  private byNode = new Map<number, string>();
  private byRef = new Map<string, SnapshotRef>();
  private next = 1;

  refFor(backendNodeId: number, role: string, name: string, frameId: string | null = null): string {
    let ref = this.byNode.get(backendNodeId);
    if (ref == null) {
      ref = `e${this.next++}`;
      this.byNode.set(backendNodeId, ref);
    }
    this.byRef.set(ref, { ref, backendNodeId, role, name, frameId });
    return ref;
  }

  get(ref: string): SnapshotRef | undefined {
    return this.byRef.get(ref.trim().replace(/^\[?(ref=)?/, "").replace(/\]$/, ""));
  }

  /** The frame of an element a ref was given to; null for the page's own document (or an element with no ref). */
  frameOf(backendNodeId: number): string | null {
    const ref = this.byNode.get(backendNodeId);
    return ref != null ? (this.byRef.get(ref)?.frameId ?? null) : null;
  }

  clear(): void {
    this.byNode.clear();
    this.byRef.clear();
    this.next = 1;
  }
}

type Item = { kind: "text"; text: string } | { kind: "line"; text: string; name: string; children: Item[] };

const clean = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim();
const cut = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);
const quote = (text: string) => `"${cut(text, NAME_LIMIT).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const property = (node: AXNode, name: string) => node.properties?.find((entry) => entry.name === name)?.value.value;

/** One accessibility tree: the page's (`frameId` null), or a same-origin frame's. Node ids are per tree. */
interface Tree {
  byId: Map<string, AXNode>;
  frameId: string | null;
}

const treeOf = (nodes: AXNode[], frameId: string | null): Tree => ({ byId: new Map(nodes.map((node) => [node.nodeId, node])), frameId });
const topOf = (tree: Tree) => [...tree.byId.values()].find((node) => node.parentId == null || !tree.byId.has(node.parentId));
const isFrame = (role: string) => role === "Iframe" || role === "IframePresentational";

export function renderSnapshot(nodes: AXNode[], refs: RefTable, options: SnapshotOptions = {}): Snapshot {
  const page = treeOf(nodes, null);
  const frames = options.frames ?? new Map<number, FrameContent>();
  const frameTrees = new Map<string, Tree>();
  for (const content of frames.values()) if ("nodes" in content) frameTrees.set(content.frameId, treeOf(content.nodes, content.frameId));
  const fields = options.fields ?? new Map<number, FieldInfo>();
  let origin: string | null = null;
  try {
    origin = options.pageUrl != null ? new URL(options.pageUrl).origin : null;
  } catch {
    // no same-site shortening
  }

  let root = topOf(page);
  let rootTree: Tree | undefined = page;
  if (options.rootRef != null) {
    const wanted = refs.get(options.rootRef);
    rootTree = wanted?.frameId != null ? frameTrees.get(wanted.frameId) : page;
    root = wanted != null && rootTree != null ? [...rootTree.byId.values()].find((node) => node.backendDOMNodeId === wanted.backendNodeId) : undefined;
    if (root == null) throw new Error(`${options.rootRef} isn't on the page now. Take a new snapshot (browser_snapshot) to get current refs.`);
  }
  if (root == null || rootTree == null) return { text: "(the page is empty)", truncated: false, lines: 0 };

  const children = (node: AXNode, tree: Tree): Item[] => (node.childIds ?? []).flatMap((id) => build(tree.byId.get(id), tree));
  const descendants = (node: AXNode, role: string, tree: Tree): AXNode[] =>
    (node.childIds ?? []).flatMap((id) => {
      const child = tree.byId.get(id);
      if (child == null) return [];
      return child.role?.value === role && child.ignored !== true ? [child] : descendants(child, role, tree);
    });

  const build = (node: AXNode | undefined, tree: Tree): Item[] => {
    if (node == null) return [];
    const role = String(node.role?.value ?? "");
    if (SKIPPED.has(role)) return [];
    if (node.ignored === true) return children(node, tree);
    const name = clean(node.name?.value);
    if (role === "StaticText") return name.length > 0 ? [{ kind: "text", text: String(node.name?.value ?? "") }] : [];
    // The page's title is on the wrapper around the snapshot; a frame's document reads in its frame's place.
    if (role === "RootWebArea") return children(node, tree);
    if (TRANSPARENT.has(role) && name.length === 0) return children(node, tree);
    if (role === "image" && name.length === 0) return [];

    const backendNodeId = node.backendDOMNodeId;
    const label = ROLE_LABELS[role] ?? role;
    const attrs: string[] = [];
    const checked = property(node, "checked");
    if (checked === "true" || checked === true) attrs.push("checked");
    else if (checked === "mixed") attrs.push("mixed");
    if (property(node, "pressed") === "true" || property(node, "pressed") === true) attrs.push("pressed");
    if (property(node, "selected") === true) attrs.push("selected");
    const expanded = property(node, "expanded");
    if (expanded === true) attrs.push("expanded");
    else if (expanded === false && role !== "combobox") attrs.push("collapsed");
    if (property(node, "disabled") === true) attrs.push("disabled");
    if (property(node, "required") === true) attrs.push("required");
    if (property(node, "readonly") === true) attrs.push("readonly");
    if (["true", "spelling", "grammar"].includes(String(property(node, "invalid")))) attrs.push("invalid");
    if (property(node, "focused") === true) attrs.push("focused");
    const level = property(node, "level");
    if (role === "heading" && typeof level === "number") attrs.push(`level=${level}`);

    let value: string | null = null;
    if (VALUE_ROLES.has(role)) {
      const field = backendNodeId != null ? fields.get(backendNodeId) : undefined;
      const secret = sensitiveField({ inputType: field?.inputType ?? "", autocomplete: field?.autocomplete ?? "", fieldName: field?.fieldName ?? "", name });
      // A masked value (•••) still tells its length; secrets show as their kind only.
      if (secret != null) attrs.push(secret === "password" ? "password" : secret);
      if (backendNodeId != null && options.filled?.has(backendNodeId) === true) attrs.push("filled from your vault");
      else if (secret == null) value = cut(clean(node.value?.value), TEXT_LIMIT);
      if (field?.tag === "select" || role === "combobox") {
        const options = descendants(node, "option", tree).map((option) => clean(option.name?.value)).filter((text) => text.length > 0);
        if (options.length > 0) attrs.push(`options: ${options.slice(0, 25).map((text) => quote(cut(text, 60))).join(", ")}${options.length > 25 ? `, … ${options.length - 25} more` : ""}`);
      }
    }
    // A frame reads from its own tree when it's the page's origin; otherwise only its name shows.
    let frame: { tree: Tree; root: AXNode } | null = null;
    if (isFrame(role)) {
      const content = backendNodeId != null ? frames.get(backendNodeId) : undefined;
      const inside = content != null && "nodes" in content ? frameTrees.get(content.frameId) : undefined;
      const top = inside != null ? topOf(inside) : undefined;
      if (inside != null && top != null) frame = { tree: inside, root: top };
      else attrs.push(content != null && "unread" in content ? content.unread : "its contents aren't read");
    }

    const ref = backendNodeId != null && (INTERACTIVE.has(role) || REGIONS.has(role)) ? refs.refFor(backendNodeId, label, name, tree.frameId) : null;
    let href = "";
    if (role === "link") {
      const url = String(property(node, "url") ?? "");
      if (url.length > 0) {
        let shown = url;
        try {
          const parsed = new URL(url);
          if (origin != null && parsed.origin === origin) shown = `${parsed.pathname}${parsed.search}${parsed.hash}`;
        } catch {
          // keep as given
        }
        if (!/^javascript:/i.test(shown)) href = ` → ${cut(shown, 120)}`;
      }
    }

    let inner = VALUE_ROLES.has(role) ? [] : isFrame(role) ? (frame != null ? build(frame.root, frame.tree) : []) : children(node, tree);
    const innerText = inner.every((item) => item.kind === "text") ? clean(inner.map((item) => (item.kind === "text" ? item.text : "")).join("")) : null;
    // A button or link that just says its name, and a paragraph that's only text, go on one line.
    let inline: string | null = null;
    if (innerText != null) {
      if (innerText.length > 0 && innerText !== name && name.length === 0) inline = cut(innerText, TEXT_LIMIT);
      inner = [];
    }
    const head = `${label}${name.length > 0 ? ` ${quote(name)}` : ""}${attrs.map((attr) => ` [${attr}]`).join("")}${ref != null ? ` [ref=${ref}]` : ""}`;
    const tail = value != null && value.length > 0 ? `: ${value}` : inline != null ? `: ${inline}` : "";
    return [{ kind: "line", text: `${head}${tail}${href}`, name, children: inner }];
  };

  /** Joins runs of text and drops text that only repeats a neighbour's name (a field's label). */
  const tidy = (items: Item[]): Item[] => {
    const merged: Item[] = [];
    for (const item of items) {
      const last = merged[merged.length - 1];
      if (item.kind === "text" && last?.kind === "text") last.text += item.text;
      else merged.push(item.kind === "text" ? { ...item } : { ...item, children: tidy(item.children) });
    }
    return merged.filter((item, index) => {
      if (item.kind !== "text") return true;
      const text = clean(item.text);
      if (text.length === 0) return false;
      const neighbours = [merged[index - 1], merged[index + 1]];
      return !neighbours.some((other) => other?.kind === "line" && clean(other.name) === text);
    });
  };

  const items = tidy(build(root, rootTree));
  const limit = options.maxChars ?? SNAPSHOT_MAX_CHARS;
  const out: string[] = [];
  let size = 0;
  let truncated = false;
  const write = (list: Item[], depth: number): void => {
    for (const item of list) {
      if (truncated) return;
      const line = `${"  ".repeat(depth)}- ${item.kind === "text" ? `text: ${cut(clean(item.text), TEXT_LIMIT)}` : item.text}`;
      if (size + line.length + 1 > limit) {
        truncated = true;
        return;
      }
      out.push(line);
      size += line.length + 1;
      if (item.kind === "line") write(item.children, depth + 1);
    }
  };
  write(items, 0);
  if (truncated) out.push("- … (the page goes on: read one part with browser_snapshot{ref}, a main, form or region's ref, or scroll and take a screenshot)");
  return { text: out.length > 0 ? out.join("\n") : "(nothing readable on the page)", truncated, lines: out.length };
}
