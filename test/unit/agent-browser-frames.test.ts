import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AgentBrowserBounds, placeWindow } from "../../src/main/agent-browser-bounds";
import { type AXNode, type FieldInfo, type FrameContent, RefTable, renderSnapshot } from "../../src/main/agent-browser-snapshot";

const cleanup: Array<() => void> = [];
after(() => {
  for (const fn of cleanup.reverse()) fn();
});

// A tree as Chromium's Accessibility.getFullAXTree gives one document: node ids are the tree's own
// (a frame's tree numbers its nodes from 1 again), backend node ids the renderer's, shared by all.
type Spec = [role: string, name?: string, extra?: Partial<AXNode> & { props?: Record<string, unknown>; kids?: Spec[] }];
function tree(root: Spec, backendBase: number): AXNode[] {
  const nodes: AXNode[] = [];
  let next = 1;
  const add = ([role, name, extra = {}]: Spec, parentId?: string): string => {
    const id = String(next++);
    const { props, kids, ...rest } = extra;
    const node: AXNode = { nodeId: id, parentId, role: { value: role }, name: { value: name ?? "" }, backendDOMNodeId: backendBase + Number(id), properties: Object.entries(props ?? {}).map(([key, value]) => ({ name: key, value: { value } })), childIds: [], ...rest };
    nodes.push(node);
    node.childIds = (kids ?? []).map((kid) => add(kid, id));
    return id;
  };
  add(root);
  return nodes;
}

const backendOf = (nodes: AXNode[], name: string) => nodes.find((node) => node.name?.value === name)!.backendDOMNodeId!;

const PAGE = tree(
  [
    "RootWebArea",
    "Shop",
    {
      kids: [
        ["heading", "Checkout", { props: { level: 1 } }],
        ["Iframe", "Sign in"],
        ["Iframe", "Ads"],
        ["Iframe", "Unknown"],
        ["button", "Pay", { kids: [["StaticText", "Pay"]] }],
      ],
    },
  ],
  100,
);
// The sign-in frame, from the page's own origin, with a frame of its own inside.
const SIGN_IN = tree(
  [
    "RootWebArea",
    "Sign in frame",
    {
      kids: [
        [
          "form",
          "",
          {
            kids: [
              ["textbox", "Email", { value: { value: "me@shop.test" } }],
              ["textbox", "Password", { value: { value: "••••••" } }],
              ["button", "Sign in", { kids: [["StaticText", "Sign in"]] }],
            ],
          },
        ],
        ["Iframe", "Nested"],
      ],
    },
  ],
  300,
);
const NESTED = tree(["RootWebArea", "Help", { kids: [["link", "Help", { props: { url: "https://shop.test/help" }, kids: [["StaticText", "Help"]] }]] }], 500);

const FRAMES = new Map<number, FrameContent>([
  [backendOf(PAGE, "Sign in"), { frameId: "F1", nodes: SIGN_IN }],
  [backendOf(PAGE, "Ads"), { unread: "from https://ads.example: its contents aren't read" }],
  [backendOf(SIGN_IN, "Nested"), { frameId: "F2", nodes: NESTED }],
]);
const FIELDS = new Map<number, FieldInfo>([
  [backendOf(SIGN_IN, "Email"), { tag: "input", inputType: "email", autocomplete: "email", fieldName: "email" }],
  [backendOf(SIGN_IN, "Password"), { tag: "input", inputType: "password", autocomplete: "current-password", fieldName: "pw" }],
]);

test("agent browser snapshots read same-origin frames in their place, with refs that name their frame", () => {
  const refs = new RefTable();
  const { text } = renderSnapshot(PAGE, refs, { pageUrl: "https://shop.test/checkout", fields: FIELDS, frames: FRAMES });
  const lines = text.split("\n");
  const refOf = (pattern: RegExp) => {
    const line = lines.find((candidate) => pattern.test(candidate));
    assert.ok(line != null, `no line like ${pattern} in:\n${text}`);
    return /\[ref=(e\d+)\]/.exec(line)![1];
  };

  // The frame's document reads inside its frame's line, a level in; its own frame one further.
  const frameLine = lines.findIndex((line) => line === '- iframe "Sign in"');
  assert.ok(frameLine >= 0, text);
  assert.match(lines[frameLine + 1], /^ {2}- form \[ref=e\d+\]$/);
  assert.match(lines[frameLine + 2], /^ {4}- textbox "Email" \[ref=e\d+\]: me@shop\.test$/);
  assert.match(text, /^ {4}- textbox "Password" \[password\] \[ref=e\d+\]$/m, "a password in a frame stays out too");
  assert.ok(!text.includes("••"));
  assert.match(text, /^ {2}- iframe "Nested"\n {4}- link "Help" \[ref=e\d+\] → \/help$/m);
  // Frames from elsewhere, and ones not fetched, are named but not read.
  assert.match(text, /^- iframe "Ads" \[from https:\/\/ads\.example: its contents aren't read\]$/m);
  assert.match(text, /^- iframe "Unknown" \[its contents aren't read\]$/m);

  // Each ref knows its frame, so clicks and typing reach the element there; the page's own have none.
  const email = refOf(/textbox "Email"/);
  const help = refOf(/link "Help"/);
  const pay = refOf(/button "Pay"/);
  assert.deepEqual([refs.get(email)?.frameId, refs.get(help)?.frameId, refs.get(pay)?.frameId], ["F1", "F2", null]);
  assert.deepEqual([refs.frameOf(backendOf(SIGN_IN, "Email")), refs.frameOf(backendOf(PAGE, "Pay")), refs.frameOf(99_999)], ["F1", null, null]);
  assert.equal(refs.get(email)?.backendNodeId, backendOf(SIGN_IN, "Email"));

  // Refs hold across snapshots, and one part of a frame can be read on its own.
  const again = renderSnapshot(PAGE, refs, { fields: FIELDS, frames: FRAMES });
  assert.match(again.text, new RegExp(`textbox "Email" \\[ref=${email}\\]`));
  const form = refOf(/- form \[ref=/);
  const part = renderSnapshot(PAGE, refs, { rootRef: form, fields: FIELDS, frames: FRAMES }).text;
  assert.match(part, /^- form \[ref=e\d+\]\n {2}- textbox "Email"/);
  assert.ok(!part.includes("Pay") && !part.includes("Checkout"));
  // Without the frame's tree, its part isn't on the page any more.
  assert.throws(() => renderSnapshot(PAGE, refs, { rootRef: form }), /isn't on the page now/);
  // And without frames at all, as before, every frame is only named.
  const plain = renderSnapshot(PAGE, new RefTable()).text;
  assert.equal((plain.match(/\[its contents aren't read\]/g) ?? []).length, 3);
  assert.ok(!plain.includes("Email"));
});

test("agent browser windows open where they were, on a screen that still shows them", () => {
  const size = { width: 1200, height: 860, minWidth: 520, minHeight: 360 };
  const screens = [
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: 1920, y: -200, width: 2560, height: 1400 },
  ];
  assert.deepEqual(placeWindow(null, screens, size), { width: 1200, height: 860, maximized: false });
  assert.deepEqual(placeWindow({ bounds: { x: 100, y: 50, width: 900, height: 700 }, maximized: false }, screens, size), { x: 100, y: 50, width: 900, height: 700, maximized: false });
  assert.deepEqual(placeWindow({ bounds: { x: 2400, y: -150, width: 900, height: 700 }, maximized: true }, screens, size), { x: 2400, y: -150, width: 900, height: 700, maximized: true }, "on the second screen, maximized");
  // The second screen unplugged: the size stays, the place goes (the window opens centred).
  assert.deepEqual(placeWindow({ bounds: { x: 2400, y: -150, width: 900, height: 700 }, maximized: false }, [screens[0]], size), { width: 900, height: 700, maximized: false });
  // A title bar off the top, too big for any screen, too small to use.
  assert.equal(placeWindow({ bounds: { x: 100, y: -300, width: 900, height: 700 }, maximized: false }, [screens[0]], size).y, undefined);
  assert.deepEqual(placeWindow({ bounds: { x: 0, y: 0, width: 5000, height: 3000 }, maximized: false }, [screens[0]], size), { x: 0, y: 0, width: 1920, height: 1040, maximized: false });
  assert.deepEqual(placeWindow({ bounds: { x: 10, y: 10, width: 100, height: 80 }, maximized: false }, [screens[0]], size), { x: 10, y: 10, width: 520, height: 360, maximized: false });
});

test("agent browser window places persist per agent, the newest 200", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wisp-bounds-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "agent-browser-windows.json");
  const store = new AgentBrowserBounds(file);
  assert.equal(store.get("a1"), null);
  store.set("a1", { bounds: { x: 10, y: 20, width: 900, height: 700 }, maximized: false });
  store.set("a2", { bounds: { x: 30, y: 40, width: 1000, height: 800 }, maximized: true });
  store.set("a3", { bounds: { x: 0, y: 0, width: 0, height: 800 }, maximized: false });
  store.set("a4", { bounds: { x: Number.NaN, y: 0, width: 600, height: 800 }, maximized: false });
  await store.flush();
  const read = new AgentBrowserBounds(file);
  assert.deepEqual(read.get("a1"), { bounds: { x: 10, y: 20, width: 900, height: 700 }, maximized: false });
  assert.deepEqual(read.get("a2"), { bounds: { x: 30, y: 40, width: 1000, height: 800 }, maximized: true });
  assert.deepEqual([read.get("a3"), read.get("a4")], [null, null], "sizes that can't be a window aren't kept");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);

  // A window closing writes at once (the app may be quitting); a later place replaces the earlier.
  read.set("a1", { bounds: { x: 50, y: 60, width: 700, height: 500 }, maximized: false });
  read.saveNow();
  assert.deepEqual(new AgentBrowserBounds(file).get("a1")?.bounds, { x: 50, y: 60, width: 700, height: 500 });

  // The newest 200 are kept.
  for (let index = 0; index < 205; index++) read.set(`agent-${index}`, { bounds: { x: index, y: 0, width: 800, height: 600 }, maximized: false });
  await read.flush();
  const many = new AgentBrowserBounds(file);
  assert.deepEqual([many.get("a1"), many.get("agent-4"), many.get("agent-5")?.bounds.x, many.get("agent-204")?.bounds.x], [null, null, 5, 204]);

  // A file that isn't one is ignored.
  writeFileSync(file, "{ not json");
  assert.equal(new AgentBrowserBounds(file).get("agent-204"), null);
});
