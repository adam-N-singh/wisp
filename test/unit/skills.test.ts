import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type BoxServer, startBoxServer } from "../../src/box-server/server";
import type { ClaudeCodeEngine, EngineHost } from "../../src/box/claude-code";
import { Harness } from "../../src/box/harness";
import { McpManager } from "../../src/box/mcp";
import { Scheduler } from "../../src/box/scheduler";
import { buildSkill, parseSkillFile, rawSkillUrl, skillFileText, skillForPrompt, skillFromMarkdown } from "../../src/box/skills";
import { BoxStore } from "../../src/box/store";
import type { BoxModelConfig } from "../../src/shared/edges";
import { readSse } from "../../src/shared/gateway-protocol";
import { type AgentSummary, type ClaudeCodeStatus, type MessageEntry, type Skill, skillCommand, type SkillImportEvent, type TranscriptEntry } from "../../src/shared/model";

const cleanup: Array<() => void> = [];
const stores: BoxStore[] = [];
after(() => {
  stores.forEach((store) => store.close());
  for (const fn of cleanup.reverse()) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wisp-skills-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function agent(id: string): AgentSummary {
  const now = Date.now();
  return {
    id, name: "Tester", description: "", path: "", origin: "user", isGroup: false, memberIds: [], isActive: false, createdAt: now, updatedAt: now,
    isRunning: false, isComposingMessage: false, awaitingUserResponse: null, hasUnread: false, lastMessageId: null, lastEntry: null,
    notificationsEnabled: true, notifyOnUpdatesEnabled: true, avatarDataUrl: null, instructions: "", model: null, isPinned: false,
  };
}

const MOCK_MODELS: BoxModelConfig = {
  defaultModel: { provider: "mock", model: "mock-1" },
  reasoningEffort: "default",
  temperature: null,
  xai: null,
  openai: null,
  anthropic: null,
  custom: null,
  claudeCode: null,
};

function setup(options: { models?: BoxModelConfig; claudeCode?: ClaudeCodeEngine } = {}) {
  const dir = tempDir();
  const store = new BoxStore(dir);
  stores.push(store);
  store.putAgent(agent("a1"));
  const harness = new Harness({
    store,
    models: () => options.models ?? MOCK_MODELS,
    resolveDeps: { chatGptToken: async () => "unused" },
    workspaceRoot: () => join(dir, "workspaces"),
    localTools: () => [],
    callLocalTool: async () => ({ kind: "error", message: "no local tools" }),
    mcp: new McpManager(() => undefined, () => undefined),
    claudeCode: options.claudeCode ?? null,
    cloud: null,
    cloudConfig: () => null,
    emit: () => undefined,
    log: () => undefined,
  });
  return { dir, store, harness };
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const userMessages = (entries: TranscriptEntry[]) => entries.filter((entry): entry is MessageEntry => entry.kind === "message" && entry.role === "user");
const replies = (entries: TranscriptEntry[]) => entries.filter((entry): entry is MessageEntry => entry.kind === "message" && entry.role === "assistant" && !entry.isStreaming);
const prompt = (text: string, clientNonce: string) => ({ prompt: text, attachmentPaths: [], attachmentNames: [], clientNonce, source: "user" as const });

test("SKILL.md files: front matter scalars parse, other keys are kept, and saved files read back the same", () => {
  const text = [
    "\uFEFF---",
    "name: pdf-processing",
    "description: >",
    "  Extract text and tables from PDF files.",
    "  Use when the user mentions PDFs.",
    "license: Apache-2.0",
    "# a comment",
    "allowed-tools:",
    "- Read",
    "- Bash(python:*)",
    "metadata:",
    '  version: "1.2"',
    "disable-model-invocation: true",
    "---",
    "",
    "# PDF processing",
    "",
    "Use pdfplumber.",
    "",
  ].join("\r\n");
  const file = parseSkillFile(text);
  assert.equal(file.name, "pdf-processing");
  assert.equal(file.description, "Extract text and tables from PDF files. Use when the user mentions PDFs.");
  assert.equal(file.body, "# PDF processing\n\nUse pdfplumber.");
  assert.equal(file.disableModelInvocation, true);
  assert.equal(file.extra, ["license: Apache-2.0", "# a comment", "allowed-tools:", "- Read", "- Bash(python:*)", "metadata:", '  version: "1.2"', "disable-model-invocation: true"].join("\n"));

  const quoted = parseSkillFile("---\nname: \"Say \\\"hi\\\"\\u0021\"\ndescription: 'It''s\n  folded'\nother: |\n  kept\n---\nBody");
  assert.equal(quoted.name, 'Say "hi"!');
  assert.equal(quoted.description, "It's folded");
  assert.equal(quoted.extra, "other: |\n  kept");
  assert.equal(parseSkillFile("---\nname: x # a comment\ndescription: |\n  line one\n  line two\n---\nBody").description, "line one\nline two");
  assert.equal(parseSkillFile("---\nname: x # a comment\ndescription: d\n---\nBody").name, "x");

  // Whatever a name or description holds, the saved file reads back the same.
  for (const name of ["Weekly report", "Re: invoices", "- dash first", "yes", "2026 plans", "C# tips", "#hash", "Ends with colon:", "  padded  ", "Ünïcödé 名前"]) {
    const description = `Use when: "${name}" # comes up\nSecond line.`;
    const saved = skillFileText({ name, description, body: "Do it." }, "license: MIT");
    const back = parseSkillFile(saved);
    assert.equal(back.name, name.trim(), saved);
    assert.equal(back.description, description, saved);
    assert.equal(back.body, "Do it.");
    assert.equal(back.extra, "license: MIT");
  }

  // Not front matter: a document that opens with a rule, or one with no closing fence.
  assert.equal(parseSkillFile("---\n\nJust a rule.\n\n---\nMore").name, null);
  assert.equal(parseSkillFile("---\nname: x\nNo closing fence").body, "---\nname: x\nNo closing fence");
});

test("skill imports: SKILL.md or plain Markdown, GitHub links, and why a document is skipped", () => {
  const imported = skillFromMarkdown("---\nname: weekly-report\ndescription: Use when asked for the weekly report.\nlicense: MIT\n---\n\nList the merged PRs.");
  assert.ok("spec" in imported);
  assert.deepEqual(imported.spec, { name: "weekly-report", description: "Use when asked for the weekly report.", body: "List the merged PRs.", trigger: null });
  assert.equal(imported.extra, "license: MIT");

  const plain = skillFromMarkdown("# Release notes\n\nDraft release notes from the changelog.\n\n1. Read CHANGELOG.md");
  assert.ok("spec" in plain);
  assert.equal(plain.spec.name, "Release notes");
  assert.equal(plain.spec.description, "Draft release notes from the changelog.");
  assert.equal(plain.spec.body, "# Release notes\n\nDraft release notes from the changelog.\n\n1. Read CHANGELOG.md");

  const renamed = skillFromMarkdown("---\nname: from-file\ndescription: d\n---\nJust do the thing.", "Thing doer");
  assert.ok("spec" in renamed);
  assert.equal(renamed.spec.name, "Thing doer", "a typed name wins");

  const reason = (result: ReturnType<typeof skillFromMarkdown>) => ("reason" in result ? result.reason : "");
  assert.match(reason(skillFromMarkdown("No heading, no name.")), /no name/);
  assert.match(reason(skillFromMarkdown("---\nname: empty\ndescription: x\n---\n")), /no instructions/);
  assert.match(reason(skillFromMarkdown(`---\nname: ${"x".repeat(65)}\ndescription: d\n---\nBody`)), /longer than 64/);

  assert.equal(rawSkillUrl("https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md"), "https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md");
  assert.equal(rawSkillUrl("https://github.com/anthropics/skills/tree/main/skills/pdf/"), "https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md");
  assert.equal(rawSkillUrl("https://gist.github.com/someone/0123abcd"), "https://gist.githubusercontent.com/someone/0123abcd/raw");
  assert.equal(rawSkillUrl("https://example.com/skills/a.md?x=1"), "https://example.com/skills/a.md?x=1");
});

test("skill specs: names make unique commands, schedules are checked, prompts run skills by command", () => {
  assert.equal(skillCommand("Weekly report"), "weekly-report");
  assert.equal(skillCommand("  Re: Q3 invoices! "), "re-q3-invoices");
  assert.equal(skillCommand("Résumé review"), "résumé-review");

  const weekly = buildSkill("a1", { name: "  Weekly   report ", description: "Use for the weekly report.", body: " Steps ", trigger: { isEnabled: true, schedule: "0 9 * * 1" } }, []);
  assert.equal(weekly.name, "Weekly report");
  assert.equal(weekly.body, "Steps");
  assert.equal(weekly.filePath, `skills/a1/${weekly.id}.md`);
  assert.equal(weekly.scheduleDescription, "Mondays at 09:00");
  assert.ok(weekly.nextRunAt != null && weekly.nextRunAt > Date.now());
  assert.equal(buildSkill("a1", { name: "Off", description: "d", body: "b", trigger: { isEnabled: false, schedule: "0 9 * * 1" } }, []).nextRunAt, null);

  assert.throws(() => buildSkill("a1", { name: "weekly-REPORT", description: "d", body: "b", trigger: null }, [weekly]), /already has a skill named “Weekly report”/);
  assert.doesNotThrow(() => buildSkill("a1", { name: "Weekly report", description: "d", body: "b2", trigger: null }, [weekly], weekly), "a skill keeps its own name");
  assert.throws(() => buildSkill("a1", { name: "x", description: "d", body: "b", trigger: { isEnabled: true, schedule: "every day" } }, []), /Invalid cron/);
  assert.throws(() => buildSkill("a1", { name: "x", description: " ", body: "b", trigger: null }, []), /Describe when/);
  assert.throws(() => buildSkill("a1", { name: "x", description: "d", body: " ", trigger: null }, []), /needs instructions/);
  assert.throws(() => buildSkill("a1", { name: "!!!", description: "d", body: "b", trigger: null }, []), /letter or a digit/);

  assert.equal(skillForPrompt("/weekly-report for Friday", [weekly])?.id, weekly.id);
  assert.equal(skillForPrompt("  /Weekly-Report", [weekly])?.id, weekly.id);
  assert.equal(skillForPrompt("/weekly-reports", [weekly]), null);
  assert.equal(skillForPrompt("/weekly-report/x", [weekly]), null);
  assert.equal(skillForPrompt("please /weekly-report", [weekly]), null);
});

test("skills store: a SKILL.md and an index per agent, kept front matter, hand-added files, cleanup", () => {
  const { dir, store } = setup();
  const skill = store.putSkill(
    buildSkill("a1", { name: "Weekly report", description: "Use for the weekly report.", body: "1. Collect PRs.", sourceRef: "https://example.com/w.md", trigger: { isEnabled: false, schedule: "0 9 * * 1" } }, []),
    "license: MIT",
  );
  const file = join(dir, "skills", "a1", `${skill.id}.md`);
  assert.equal(readFileSync(file, "utf8"), "---\nname: Weekly report\ndescription: Use for the weekly report.\nlicense: MIT\n---\n\n1. Collect PRs.\n");
  store.putSkill({ ...skill, lastRunAt: 1, runs: [{ id: "r1", startedAt: 1, finishedAt: 2, status: "ok", trigger: "manual" }] });
  writeFileSync(join(dir, "skills", "a1", "by-hand.md"), "# Tidy downloads\n\nMove old files from Downloads to an archive folder.\n");

  const reloaded = new BoxStore(dir);
  stores.push(reloaded);
  const [byHand, weekly] = reloaded.listSkills("a1");
  assert.deepEqual(weekly, store.getSkill("a1", skill.id), "everything survives a restart");
  assert.equal(weekly.runs.length, 1);
  assert.equal(weekly.sourceRef, "https://example.com/w.md");
  assert.deepEqual([byHand.id, byHand.name, byHand.description], ["by-hand", "Tidy downloads", "Move old files from Downloads to an archive folder."]);

  reloaded.putSkill({ ...weekly, body: "1. Collect PRs.\n2. Summarize." });
  assert.match(readFileSync(file, "utf8"), /\nlicense: MIT\n---\n\n1\. Collect PRs\.\n2\. Summarize\.\n$/, "edits keep the front matter the box doesn't manage");

  assert.equal(reloaded.deleteSkill("a1", "by-hand")?.name, "Tidy downloads");
  assert.equal(existsSync(join(dir, "skills", "a1", "by-hand.md")), false);
  reloaded.deleteAgent("a1");
  assert.equal(existsSync(join(dir, "skills", "a1")), false);
  assert.deepEqual(reloaded.listSkills(), []);
});

test("harness: skills are listed for the model, load_skill reads one, and a /command prompt carries it", async () => {
  const { store, harness } = setup();
  const row = store.getAgent("a1")!;
  assert.equal(harness.toolSpecs(row).some((spec) => spec.function.name === "load_skill"), false, "no skills, no load_skill");
  assert.doesNotMatch(harness.systemPrompt(row), /## Skills/);

  const weekly = store.putSkill(buildSkill("a1", { name: "Weekly report", description: "Use when the user asks\nfor the weekly report.", body: "WEEKLY-STEPS: collect PRs.", trigger: null }, []));
  store.putSkill(buildSkill("a1", { name: "Deploy", description: "Ship it.", body: "DEPLOY-STEPS", trigger: null }, store.listSkills("a1")), "disable-model-invocation: true");
  const system = harness.systemPrompt(row);
  assert.match(system, /## Skills\n.*load_skill.*\n- Weekly report: Use when the user asks for the weekly report\.$/m);
  assert.doesNotMatch(system, /Deploy/, "skills only the user runs aren't listed");
  assert.ok(harness.toolSpecs(row).some((spec) => spec.function.name === "load_skill"));

  /** The newest reply once the run settles (the mock's "/tool <name> <args>" makes two). */
  const settled = async () => {
    await until(() => !store.getAgent("a1")!.isRunning);
    return replies(store.entries("a1")).pop()!;
  };
  harness.submitPrompt("a1", prompt('/tool load_skill {"name":"weekly report"}', "n1"));
  await settled();
  harness.submitPrompt("a1", prompt('/tool load_skill {"name":"Deploy"}', "n2"));
  await settled();
  const [loaded, refused] = store.entries("a1").filter((entry) => entry.kind === "tool-call");
  assert.equal(loaded.kind === "tool-call" ? loaded.summary : "", "Loaded the “weekly report” skill");
  assert.equal(loaded.kind === "tool-call" ? loaded.detail?.output : "", "# Weekly report\n\nWEEKLY-STEPS: collect PRs.");
  assert.equal(refused.kind === "tool-call" ? refused.status : "", "failed");
  assert.match(refused.kind === "tool-call" ? refused.detail!.output : "", /No skill named "Deploy"\. Your skills: Weekly report\./);

  // A long skill reaches the model whole, past the usual cut for tool output.
  const long = store.putSkill(buildSkill("a1", { name: "Long", description: "Use for long work.", body: `${"step. ".repeat(6_000)}LAST-STEP`, trigger: null }, store.listSkills("a1")));
  harness.submitPrompt("a1", prompt('/tool load_skill {"name":"Long"}', "n-long"));
  await settled();
  const results = harness.buildConversation("a1").filter((item) => item.kind === "tool-results").pop();
  assert.equal(results?.kind === "tool-results" ? results.results[0].output : "", `# Long\n\n${long.body}`);
  store.deleteSkill("a1", long.id);

  // "/weekly-report for Friday" runs the skill: the message keeps a copy and the model reads it.
  harness.submitPrompt("a1", prompt("/weekly-report for Friday", "n3"));
  assert.deepEqual(userMessages(store.entries("a1")).pop()!.skill, { id: weekly.id, name: "Weekly report", body: "WEEKLY-STEPS: collect PRs." });
  assert.match((await settled()).content, /You said: "\/weekly-report for Friday\nThe user ran the skill “Weekly report”\. Follow its instructions:\n\nWEEKLY-STEPS: collect PRs\."/);

  // Editing the skill later doesn't rewrite what was sent.
  const before = JSON.stringify(harness.buildConversation("a1"));
  store.putSkill({ ...store.getSkill("a1", weekly.id)!, body: "CHANGED-STEPS" });
  assert.equal(JSON.stringify(harness.buildConversation("a1")), before);

  // Run now and the schedule send "/<command>" with the skill as it reads now.
  assert.equal(harness.runSkill(store.getSkill("a1", weekly.id)!, true), true);
  const scheduled = userMessages(store.entries("a1")).pop()!;
  assert.deepEqual([scheduled.content, scheduled.source, scheduled.skill?.body], ["/weekly-report", "automation", "CHANGED-STEPS"]);
  assert.match((await settled()).content, /The skill “Weekly report” ran on its schedule\. Follow its instructions:\n\nCHANGED-STEPS/);
  store.deleteAgent("a1");
  assert.equal(harness.runSkill(weekly, false), false, "an agent that's gone runs nothing");
});

test("Claude Code agents get the skills through the bridge, and their prompts carry a skill they run", async () => {
  const turns: Array<{ tools: string[]; notes: string; prompt: string }> = [];
  const engine = {
    runTurn: async (host: EngineHost, _model: unknown, input: { prompt: string }) => {
      turns.push({ tools: host.appTools().map((tool) => tool.name), notes: host.agentNotes(), prompt: input.prompt });
      return { sessionId: "session-1", failed: null, text: "" };
    },
  } as unknown as ClaudeCodeEngine;
  const { store, harness } = setup({ models: { ...MOCK_MODELS, claudeCode: { executable: "claude" } }, claudeCode: engine });
  store.putAgent({ ...store.getAgent("a1")!, model: "claude-code:default" });

  harness.submitPrompt("a1", prompt("hello", "n1"));
  await until(() => turns.length === 1 && !store.getAgent("a1")!.isRunning);
  assert.equal(turns[0].tools.includes("load_skill"), false);
  assert.doesNotMatch(turns[0].notes, /load_skill/);

  store.putSkill(buildSkill("a1", { name: "Weekly report", description: "Use for the weekly report.", body: "WEEKLY-STEPS", trigger: null }, []));
  harness.runSkill(store.listSkills("a1")[0], false);
  await until(() => turns.length === 2 && !store.getAgent("a1")!.isRunning);
  assert.ok(turns[1].tools.includes("load_skill"), "the bridge offers load_skill");
  assert.match(turns[1].notes, /mcp__wisp__load_skill[^\n]*\n- Weekly report: Use for the weekly report\./);
  assert.match(turns[1].prompt, /^\[Sent [^\]]+\]\n\/weekly-report\n\nThe user ran the skill “Weekly report”\. Follow its instructions:\n\nWEEKLY-STEPS$/);
});

test("scheduled skills fire on the automations' clock and record their runs", async () => {
  const { store, harness } = setup();
  const skill = store.putSkill({ ...buildSkill("a1", { name: "Standup", description: "Use for standup notes.", body: "STANDUP-STEPS", trigger: { isEnabled: true, schedule: "*/5 * * * *" } }, []), nextRunAt: Date.now() - 1000 });
  const changed: string[] = [];
  const scheduler = new Scheduler(store, () => false, () => undefined, { fire: (due, trigger) => harness.runSkill(due, trigger === "schedule"), onChanged: (agentId) => changed.push(agentId) });
  scheduler.start(); // ticks once right away
  scheduler.stop();
  const fired = store.getSkill("a1", skill.id)!;
  assert.deepEqual([fired.runs.length, fired.runs[0].trigger, fired.runs[0].status], [1, "schedule", "ok"]);
  assert.ok(fired.nextRunAt != null && fired.nextRunAt > Date.now() && fired.nextRunAt - Date.now() <= 5 * 60_000);
  assert.deepEqual(changed, ["a1"]);
  const message = userMessages(store.entries("a1")).pop()!;
  assert.deepEqual([message.content, message.source, message.skill?.body], ["/standup", "automation", "STANDUP-STEPS"]);
  await until(() => !store.getAgent("a1")!.isRunning);

  assert.equal(scheduler.runSkillNow("a1", skill.id), true);
  assert.equal(store.getSkill("a1", skill.id)!.runs[0].trigger, "manual");
  assert.equal(scheduler.runSkillNow("a1", "missing"), false);
  await until(() => !store.getAgent("a1")!.isRunning);
});

const TOKEN = randomBytes(24).toString("hex");
const NO_CLAUDE = async (): Promise<ClaudeCodeStatus> => ({ executable: null, installed: false, version: null, signedIn: false, authMethod: null, checkedAt: 1 });

async function bootBox(dataDir: string): Promise<BoxServer> {
  const server = await startBoxServer({
    settings: { dataDir, host: "127.0.0.1", port: 0, token: TOKEN, tls: null, behindTlsProxy: false, admin: true, configFile: join(dataDir, "box-config.json"), workspaceRoot: join(dataDir, "workspaces") },
    env: { WISP_BOX_DEFAULT_MODEL: "mock:mock-1" },
    version: "9.9.9-test",
    detectClaudeCode: NO_CLAUDE,
    log: () => undefined,
  });
  cleanup.push(() => server.close());
  return server;
}

const post = (server: BoxServer, method: string, args: unknown) =>
  fetch(`${server.url}/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(args) });

async function api<T = any>(server: BoxServer, method: string, args: unknown): Promise<T> {
  const response = await post(server, method, args);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as T;
}

test("box gateway: skills end to end with the mock model, from creation and imports to runs and the event stream", async () => {
  const files = createServer((request, response) => {
    if (request.url === "/skills/triage/SKILL.md") {
      response.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      return response.end("---\nname: bug-triage\ndescription: Use when the user asks to triage bug reports.\n---\n\nTRIAGE-STEPS: label each report.\n");
    }
    if (request.url === "/page") {
      response.writeHead(200, { "content-type": "text/html" });
      return response.end("<!doctype html><title>Not a skill</title>");
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => files.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => files.close());
  const base = `http://127.0.0.1:${(files.address() as AddressInfo).port}`;

  const dir = tempDir();
  let server = await bootBox(dir);
  const abort = new AbortController();
  cleanup.push(() => abort.abort());
  const events: Array<{ agentId: string; skills: Skill[] }> = [];
  const stream = await fetch(`${server.url}/events`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: abort.signal });
  void (async () => {
    for await (const block of readSse(stream.body!, abort.signal)) {
      const frame = block.data != null ? JSON.parse(block.data) : null;
      if (frame?.channel === "skills") events.push(frame.payload);
    }
  })().catch(() => undefined);

  const { agent: created } = await api<{ agent: AgentSummary }>(server, "addAgent", { name: "Skilled", description: "" });
  const id = created.id;
  const [weekly] = await api<Skill[]>(server, "addAgentSkill", { id, spec: { name: "Weekly report", description: "Use when the user asks for the weekly report.", body: "WEEKLY-STEPS: collect PRs.", trigger: null } });
  assert.equal(weekly.filePath, `skills/${id}/${weekly.id}.md`);
  await until(() => events.length === 1);
  assert.equal(events[0].agentId, id);

  const clash = await post(server, "addAgentSkill", { id, spec: { name: "weekly-report", description: "d", body: "b", trigger: null } });
  assert.equal(clash.status, 400);
  assert.match(((await clash.json()) as { error: string }).error, /already has a skill named “Weekly report”/);

  const pasted = await api<SkillImportEvent>(server, "importSkillText", { id, markdown: "---\nname: release-notes\ndescription: Use for release notes.\nlicense: MIT\n---\n\nRELEASE-STEPS" });
  assert.deepEqual(pasted.result.imported.map((skill) => skill.name), ["release-notes"]);
  assert.equal(pasted.skills.length, 2);
  assert.match(readFileSync(join(dir, "skills", id, `${pasted.result.imported[0].id}.md`), "utf8"), /^---\nname: release-notes\ndescription: Use for release notes\.\nlicense: MIT\n---\n/);
  const again = await api<SkillImportEvent>(server, "importSkillText", { id, markdown: "# Release notes\n\nAgain." });
  assert.deepEqual(again.result, { imported: [], skipped: [{ source: "Pasted Markdown", reason: "This agent already has a skill named “release-notes”." }] });

  const linked = await api<SkillImportEvent>(server, "importSkillFromLink", { id, url: `${base}/skills/triage/SKILL.md` });
  assert.deepEqual(linked.result.imported.map((skill) => skill.name), ["bug-triage"]);
  assert.equal(linked.skills.find((skill) => skill.name === "bug-triage")?.sourceRef, `${base}/skills/triage/SKILL.md`);
  assert.match((await api<SkillImportEvent>(server, "importSkillFromLink", { id, url: `${base}/page` })).result.skipped[0].reason, /web page/);
  assert.match((await api<SkillImportEvent>(server, "importSkillFromLink", { id, url: `${base}/missing` })).result.skipped[0].reason, /HTTP 404/);
  assert.match((await api<SkillImportEvent>(server, "importSkillFromLink", { id, url: `${base.replace("http:", "https:")}/page` })).result.skipped[0].reason, /doesn’t answer HTTPS/);
  assert.equal((await post(server, "importSkillFromLink", { id, url: "file:///etc/passwd" })).status, 400);

  // Run now: the agent gets "/weekly-report" with the skill's instructions, and the mock echoes them.
  const entries = async () => (await api<{ entries: TranscriptEntry[] }>(server, "readTranscriptEnd", { id, limit: 100 })).entries;
  await api(server, "runAgentSkillNow", { id, skillId: weekly.id });
  await until(async () => replies(await entries()).some((reply) => /WEEKLY-STEPS: collect PRs\./.test(reply.content)));
  const ran = userMessages(await entries()).pop()!;
  assert.deepEqual([ran.content, ran.skill?.name], ["/weekly-report", "Weekly report"]);
  assert.equal((await api<Skill[]>(server, "listAgentSkills", { id })).find((skill) => skill.id === weekly.id)?.runs[0].trigger, "manual");

  // Typed commands and load_skill reach the same skills.
  await api(server, "deliverMessage", { agentId: id, prompt: "/bug-triage the new ones", clientNonce: "n1" });
  await until(async () => replies(await entries()).some((reply) => /TRIAGE-STEPS/.test(reply.content)));
  await api(server, "deliverMessage", { agentId: id, prompt: '/tool load_skill {"name":"release-notes"}', clientNonce: "n2" });
  await until(async () => replies(await entries()).some((reply) => /Tool finished\. Output:[\s\S]*# release-notes\n\nRELEASE-STEPS/.test(reply.content)));

  const updated = await api<Skill[]>(server, "editAgentSkill", { id, skillId: weekly.id, spec: { name: "Weekly report", description: "Use on Fridays.", body: "WEEKLY-STEPS v2", trigger: { isEnabled: true, schedule: "0 16 * * 5" } } });
  const scheduled = updated.find((skill) => skill.id === weekly.id)!;
  assert.deepEqual([scheduled.description, scheduled.scheduleDescription, scheduled.runs.length], ["Use on Fridays.", "Fridays at 16:00", 1]);
  assert.ok(scheduled.nextRunAt != null && new Date(scheduled.nextRunAt).getDay() === 5);
  const remaining = await api<Skill[]>(server, "removeAgentSkill", { id, skillId: linked.result.imported[0].id });
  assert.deepEqual(remaining.map((skill) => skill.name), ["release-notes", "Weekly report"]);
  await until(() => events.length >= 5 && JSON.stringify(events[events.length - 1].skills) === JSON.stringify(remaining));

  // A restarted box has the same skills.
  abort.abort();
  server.close();
  server = await bootBox(dir);
  assert.deepEqual(await api<Skill[]>(server, "listAgentSkills", { id }), remaining);
});
