import assert from "node:assert/strict";
import { test } from "node:test";
import { agentScore, canHaveAgentBrowser, nameScore, pageMatches } from "../../src/renderer/palette-match";
import type { AgentSummary } from "../../src/shared/model";
import type { LibraryPage } from "../../src/shared/pages";

function agent(id: string, name: string, extra: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id, name, description: "", path: "", origin: "user", isGroup: false, memberIds: [], isActive: false, createdAt: 1, updatedAt: 1,
    isRunning: false, isComposingMessage: false, awaitingUserResponse: null, hasUnread: false, lastMessageId: null, lastEntry: null,
    notificationsEnabled: true, notifyOnUpdatesEnabled: true, avatarDataUrl: null, instructions: "", model: null, isPinned: false, ...extra,
  };
}

const page = (storeId: string, documentId: string, title: string, updatedAt: number): LibraryPage => ({
  page: { kind: "document", storeId, documentId },
  title,
  createdAt: 1,
  updatedAt,
  revision: 1,
  updatedBy: "agent",
});

test("names match at their start, then at a word's start, then anywhere, then by every typed word", () => {
  assert.deepEqual(
    ["trip", "plan", "rip", "plan trip", "portugal", ""].map((needle) => nameScore("Trip plan: Portugal", needle)),
    [4, 3, 2, 1, 3, 0],
  );
  assert.equal(nameScore("Trip plan", "plan  budget"), 0, "every word has to be there");
  assert.equal(nameScore("Café notes", "café"), 4);
  // An agent's name ranks above its role, which still finds it.
  const researcher = agent("a", "Scout", { description: "Research assistant" });
  assert.ok(agentScore(researcher, "scout") > agentScore(researcher, "cou"));
  assert.ok(agentScore(researcher, "cou") > agentScore(researcher, "research"));
  assert.equal(agentScore(researcher, "research"), 1);
  assert.equal(agentScore(researcher, "nothing"), 0);
});

test("Jump to's pages: newest of sidebar agents with nothing typed; with a query, matching titles of every agent, hidden ones too, best first", () => {
  const wisp = agent("wisp", "Wisp");
  const writer = agent("writer", "Writer");
  const secret = agent("secret", "Secret", { isHiddenFromSidebar: true });
  const agents = { visible: [wisp, writer], hidden: [secret] };
  const pages = [
    page("wisp", "doc-aaaaaa", "Trip plan", 10),
    page("writer", "doc-bbbbbb", "Weekly report", 30),
    page("secret", "doc-cccccc", "Trip budget", 40),
    page("writer", "doc-dddddd", "Notes from the trip", 20),
    page("gone", "doc-eeeeee", "Trip from a deleted agent", 50),
  ];
  const ids = (matches: ReturnType<typeof pageMatches>) => matches.map((match) => `${match.agent.id}/${match.page.page.documentId}`);

  // Nothing typed: the newest pages of agents in the sidebar, within the limit.
  assert.deepEqual(ids(pageMatches(pages, agents, "", 2)), ["writer/doc-bbbbbb", "writer/doc-dddddd"]);
  assert.deepEqual(ids(pageMatches(pages, agents, "", 10)), ["writer/doc-bbbbbb", "writer/doc-dddddd", "wisp/doc-aaaaaa"]);

  // A query: titles that start with it first (newest first among them), then a word's start; hidden agents' pages too.
  const trip = pageMatches(pages, agents, "trip", 10);
  assert.deepEqual(ids(trip), ["secret/doc-cccccc", "wisp/doc-aaaaaa", "writer/doc-dddddd"]);
  assert.equal(trip[0].agent.isHiddenFromSidebar, true);
  assert.deepEqual(ids(pageMatches(pages, agents, "trip", 1)), ["secret/doc-cccccc"]);
  assert.deepEqual(ids(pageMatches(pages, agents, "report weekly", 10)), ["writer/doc-bbbbbb"]);
  assert.deepEqual(pageMatches(pages, agents, "lisbon", 10), []);
  // A page whose agent is gone (or not in the roster yet) isn't offered.
  assert.ok(!ids(pageMatches(pages, agents, "deleted", 10)).some((id) => id.startsWith("gone/")));
  assert.deepEqual(pageMatches(pages, { visible: [], hidden: [] }, "", 10), []);
});

test("only agents working on this PC can have an agent browser", () => {
  assert.equal(canHaveAgentBrowser(agent("a", "Local")), true, "This PC is the default");
  assert.equal(canHaveAgentBrowser(agent("b", "Local", { computer: "local" })), true);
  assert.equal(canHaveAgentBrowser(agent("c", "Cloud", { computer: "cloud" })), false);
});
