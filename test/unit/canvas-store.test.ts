// The renderer's canvas store against a fake gateway: answers and "page-changed" events arrive by
// different routes, and the stage must never go back to an older revision than one it has heard of.
import { deferred, fake } from "./fake-desktop";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LibraryPage, PageChangedEvent, PageDocument } from "../../src/shared/pages";
import { newerPage } from "../../src/shared/pages";
import { canvases, loadCanvas, pageKey, restorePageRevision, startPages } from "../../src/renderer/store/pages";

const CANVAS = "canvas-abc123";
const view = (revision: number, title = "Counter", updatedBy: "agent" | "user" = "agent"): PageDocument => ({
  page: { kind: "canvas", storeId: "a1", canvasId: CANVAS },
  title,
  createdAt: 1,
  updatedAt: revision * 10,
  revision,
  updatedBy,
  source: `<p>revision ${revision}</p>`,
  sourceRevision: revision,
});
const page = (revision: number, title?: string, updatedBy?: "agent" | "user"): LibraryPage => {
  const { source: _source, sourceRevision: _sourceRevision, ...rest } = view(revision, title, updatedBy);
  return rest;
};
const changed = (revision: number, change: PageChangedEvent["change"], title?: string, editable = true): PageChangedEvent => ({
  agentId: "a1",
  page: page(revision, title),
  change,
  by: "agent",
  editRight: editable ? { canEdit: true } : { canEdit: false, reason: "agent-writing" },
});
const shown = () => canvases.get()[pageKey("a1", CANVAS)];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("newerPage: an older revision never replaces a newer one; at the same revision what arrived wins, unless an event overtook the read", () => {
  const one = page(1);
  const two = page(2);
  const renamed = page(2, "Renamed");
  assert.equal(newerPage(undefined, one), one);
  assert.equal(newerPage(one, two), two);
  assert.equal(newerPage(two, one), two);
  assert.equal(newerPage(two, one, true), two);
  assert.equal(newerPage(two, renamed), renamed, "an event at the same revision says more (a rename)");
  assert.equal(newerPage(renamed, two, true), renamed, "a read the rename overtook");
});

test("the canvas store: a read the agent's next write overtook doesn't take the stage back, nor does a late event or a restore's answer", async () => {
  startPages();
  // Opening the canvas reads revision 1, slowly; meanwhile the agent writes revision 2.
  const read = deferred<PageDocument>();
  fake.answer.canvasPage = () => read.promise;
  fake.answer.pageEditAccess = async () => ({ canEdit: false, reason: "agent-writing" });
  const loading = loadCanvas("a1", CANVAS);
  await settle();
  fake.emit("page-changed", changed(2, "edited", undefined, false));
  assert.deepEqual([shown().status, shown().canvas?.revision], ["ready", 2]);
  read.resolve(view(1));
  await loading;
  assert.deepEqual([shown().canvas?.revision, shown().editRight], [2, { canEdit: false, reason: "agent-writing" }], "revision 1's answer came too late to count");

  // The run ends: the same revision, editable now.
  fake.emit("page-changed", changed(2, "editable"));
  assert.deepEqual([shown().canvas?.revision, shown().editRight], [2, { canEdit: true }]);
  // An event for an older revision that comes late changes nothing.
  const before = shown();
  fake.emit("page-changed", changed(1, "edited", "Old title", false));
  assert.equal(shown(), before);

  // A rename overtakes a read at the same revision: the read's older title doesn't come back.
  const reread = deferred<PageDocument>();
  fake.answer.canvasPage = () => reread.promise;
  fake.answer.pageEditAccess = async () => ({ canEdit: true });
  const reloading = loadCanvas("a1", CANVAS);
  await settle();
  fake.emit("page-changed", changed(2, "renamed", "Tally"));
  reread.resolve(view(2, "Counter"));
  await reloading;
  assert.equal(shown().canvas?.title, "Tally");
  // A read nothing overtook is taken as it is.
  fake.answer.canvasPage = async () => view(2, "Tally 2");
  await loadCanvas("a1", CANVAS);
  assert.equal(shown().canvas?.title, "Tally 2");

  // The user restores revision 1 as revision 3, but the agent's revision 4 is heard first.
  const restore = deferred<PageDocument>();
  fake.answer.restorePageRevision = () => restore.promise;
  const restoring = restorePageRevision("a1", CANVAS, 1, 2);
  await settle();
  fake.emit("page-changed", changed(4, "edited"));
  restore.resolve(view(3, "Tally 2", "user"));
  assert.equal(await restoring, null);
  assert.equal(shown().canvas?.revision, 4);
  // With nothing in between, the restore's answer shows.
  fake.answer.restorePageRevision = async () => view(5, "Tally 2", "user");
  await restorePageRevision("a1", CANVAS, 1, 4);
  assert.deepEqual([shown().canvas?.revision, shown().canvas?.updatedBy], [5, "user"]);
});
