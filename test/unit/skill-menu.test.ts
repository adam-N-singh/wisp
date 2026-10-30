import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSkill, findSkill, skillForPrompt } from "../../src/box/skills";
import { foldUnchanged, lineDiff } from "../../src/shared/line-diff";
import type { Skill } from "../../src/shared/model";
import { skillMatches, slashCommand, slashQuery } from "../../src/renderer/skill-menu";

function skill(id: string, name: string, extra: Partial<Skill> = {}): Skill {
  return { id, agentId: "a1", name, description: `About ${name}.`, body: "Do it.", createdAt: 1, filePath: "", sourceRef: null, trigger: null, scheduleDescription: null, lastRunAt: null, nextRunAt: null, runs: [], ...extra };
}

const SKILLS = [
  skill("s1", "Summary writer"),
  skill("p1", "notes:summarize", { source: "plugin", pluginId: "notes@acme", pluginName: "Notes" }),
  skill("p2", "my_kit:Tidy Up", { source: "plugin", pluginId: "my_kit@acme", pluginName: "My kit" }),
];

test("the composer's / menu: a plugin's skill shows as /<plugin>:<skill>, and both ways of typing it run it", () => {
  // What opens the menu: "/" and a command being typed, a colon included, alone in the message.
  assert.equal(slashQuery("/"), "");
  assert.equal(slashQuery("/notes:sum"), "notes:sum");
  assert.equal(slashQuery("/notes-sum"), "notes-sum");
  for (const text of ["notes:sum", "/notes sum", "hi /notes", "/notes:sum\n"]) assert.equal(slashQuery(text), null, text);

  // The command each skill runs as: a plugin's keeps its colon; each part as a command, as the box folds it.
  assert.deepEqual(SKILLS.map(slashCommand), ["summary-writer", "notes:summarize", "my-kit:tidy-up"]);

  // Typed with the colon or with a dash, a query finds the plugin's skill; ones that start with it come first.
  const ids = (query: string) => skillMatches(SKILLS, query, 8).map((found) => found.id);
  assert.deepEqual(ids("notes:"), ["p1"]);
  assert.deepEqual(ids("notes-sum"), ["p1"]);
  assert.deepEqual(ids("my-kit:t"), ["p2"]);
  assert.deepEqual(ids("sum"), ["s1", "p1"]);
  assert.deepEqual(ids(""), ["s1", "p1", "p2"]);
  assert.deepEqual(skillMatches(SKILLS, "", 2).map((found) => found.id), ["s1", "p1"]);

  // What the menu puts in the message, and the dashed form, run the same skill on the box.
  for (const picked of SKILLS) {
    assert.equal(skillForPrompt(`/${slashCommand(picked)} please`, SKILLS)?.id, picked.id, slashCommand(picked));
    assert.equal(skillForPrompt(`/${slashCommand(picked).replace(":", "-")}`, SKILLS)?.id, picked.id);
  }
});

test("skill commands: /<plugin>:<skill> names the plugin's skill exactly, never an own skill that folds to it", () => {
  // The agent's own skills come first, as listSkills gives them.
  const own = skill("o1", "notes summarize");
  const colonOwn = skill("o2", "Plan: weekly");
  const plugin = skill("p1", "notes:summarize", { source: "plugin", pluginId: "notes@acme", pluginName: "Notes" });
  const list = [own, colonOwn, plugin];
  assert.equal(skillForPrompt("/notes:summarize these", list)?.id, "p1", "with a colon, the plugin's");
  assert.equal(skillForPrompt("/Notes:Summarize", list)?.id, "p1");
  assert.equal(skillForPrompt("/notes-summarize", list)?.id, "o1", "with a dash, the agent's own wins the shared command");
  assert.equal(skillForPrompt("/notes:summarize", [own])?.id, undefined, "the colon form doesn't fall back to an own skill");
  assert.equal(skillForPrompt("/plan:weekly", list)?.id, "o2", "an own skill with a colon in its name, typed with it");
  assert.equal(skillForPrompt("/plan-weekly", list)?.id, "o2");
  // load_skill resolves the names the model was given the same way.
  assert.deepEqual(["notes:summarize", "/notes:summarize", "notes summarize", "Plan: weekly"].map((name) => findSkill(list, name)?.id), ["p1", "p1", "o1", "o2"]);

  // A new or renamed skill can't take a plugin's command; one that had it first keeps its name while edited.
  const taken = [{ id: "o1", name: "notes summarize" }, { id: "notes@acme/triage", name: "notes:triage", pluginName: "Notes" }];
  const spec = (name: string) => ({ name, description: "Use it.", body: "Do it.", trigger: null });
  assert.throws(() => buildSkill("a1", spec("Notes triage"), taken), /installed plugin Notes has a skill named “notes:triage”/);
  assert.throws(() => buildSkill("a1", spec("notes summarize"), taken), /already has a skill named “notes summarize”/);
  const first = skill("o3", "notes triage");
  assert.equal(buildSkill("a1", spec("notes  triage"), [...taken, { id: "o3", name: "notes triage" }], first).name, "notes triage");
  assert.throws(() => buildSkill("a1", spec("notes triage"), taken, skill("o4", "weekly")), /installed plugin Notes/);
});

test("line diffs: the changed middle compared line by line, unchanged runs folded around it", () => {
  const before = ["# Plan", "", ...Array.from({ length: 20 }, (_, index) => `Step ${index + 1}.`), "Done."].join("\n");
  const after = before.replace("Step 10.", "Step ten, rewritten.").replace("Done.", "Done.\nThanks.");
  const diff = lineDiff(before, after)!;
  assert.deepEqual(
    diff.filter((line) => line.kind !== "same"),
    [
      { kind: "del", text: "Step 10." },
      { kind: "add", text: "Step ten, rewritten." },
      { kind: "add", text: "Thanks." },
    ],
  );
  assert.equal(diff.filter((line) => line.kind !== "add").map((line) => line.text).join("\n"), before, "every old line is there, in order");
  const rows = foldUnchanged(diff, 2);
  assert.deepEqual(rows[0], { kind: "skip", count: 9 }, "the start, up to two lines before the change, folds");
  assert.ok(rows.some((row) => row.kind === "skip" && row.count === 7), "and so does the run between the two changes");
  assert.deepEqual(rows.slice(-3), [
    { kind: "same", text: "Step 20." },
    { kind: "same", text: "Done." },
    { kind: "add", text: "Thanks." },
  ]);
  assert.deepEqual(lineDiff("same\ntext", "same\ntext")!.map((line) => line.kind), ["same", "same"]);
  assert.deepEqual(foldUnchanged(lineDiff("a\nb", "a\nb")!), [{ kind: "skip", count: 2 }]);
  // A long document with a short edit stays cheap: the shared start and end aren't compared.
  const long = Array.from({ length: 50_000 }, (_, index) => `Line ${index}`).join("\n");
  assert.deepEqual(lineDiff(long, long.replace("Line 25000", "Changed"))!.filter((line) => line.kind !== "same").length, 2);
  // Two wholly different long texts are too much to compare here.
  assert.equal(lineDiff(Array.from({ length: 3000 }, (_, index) => `a${index}`).join("\n"), Array.from({ length: 3000 }, (_, index) => `b${index}`).join("\n")), null);
});
