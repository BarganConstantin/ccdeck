// The Jira panel's own logic (#2178), with no DOM: how a board's issues become
// groups and rows the way Jira's Backlog draws them — each issue once, a
// sub-task under its parent or under a "not assigned to you" context row —
// what a sprint header counts, how Jira writes a duration, and the sanitiser
// an issue's HTML goes through, fed by a parser written here.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildRows, filterRows, groupOpen, groupsFor, groupStats, jiraDuration, rowKey } from "../jira-board";
import type { JiraBoardOverview, JiraIssue, JiraSprint } from "../jira-api";
import { htmlToReact, safeHref, type HtmlNode } from "../jira-html";
import { priorityLevel, typeShape } from "../components/JiraParts";
import { searchSettings } from "../settings-search";
import { SETTINGS_SECTIONS } from "../settings";
import { integrationDefs } from "../integrations/registry";
import { connectionsOf, type IntegrationsState } from "../integrations/client";
import type { IntegrationConnection } from "../integrations/types";
import { items } from "./edge-keys-rails";
import { railItems } from "../rail-items";

const TYPE = { name: "Story", icon: null, subtask: false, epic: false };
const SUB = { name: "Sub-task", icon: null, subtask: true, epic: false };
const status = (category: "new" | "indeterminate" | "done") => ({ name: category, category });
let n = 0;
function issue(key: string, extra: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: String(++n), key, summary: `Summary of ${key}`, url: `https://jira.example.com/browse/${key}`, type: TYPE, status: status("new"),
    priority: null, assignee: null, mine: false, parent: null, subtaskKeys: [], epic: null, fixVersions: [], estimate: null, remaining: null,
    points: null, flagged: false, updated: "", ...extra,
  };
}
const sub = (key: string, parent: JiraIssue, extra: Partial<JiraIssue> = {}) => issue(key, {
  type: SUB, parent: { key: parent.key, summary: parent.summary, type: parent.type, status: parent.status, priority: null }, ...extra,
});
const sprint = (id: number, name: string, state: string): JiraSprint => ({ id, name, state, startDate: null, endDate: null, completeDate: null, goal: "" });
const overview = (over: Partial<JiraBoardOverview>) => ({
  hasSprints: true, hasBacklog: true, sprints: { active: [], future: [] }, ...over,
}) as unknown as JiraBoardOverview;

describe("a board's groups, in the Backlog page's order", () => {
  it("draws the active sprints open, the future ones shut, then the backlog, then closed sprints on demand", () => {
    const groups = groupsFor(overview({ sprints: { active: [sprint(13, "S13", "active"), sprint(20, "B", "active")], future: [sprint(14, "S14", "future")] } } as Partial<JiraBoardOverview>), [sprint(12, "S12", "closed")]);
    expect(groups.map(g => [g.id, g.kind, g.defaultOpen])).toEqual([
      ["sprint:13", "active", true], ["sprint:20", "active", true], ["sprint:14", "future", false], ["backlog", "backlog", false], ["sprint:12", "closed", false],
    ]);
    expect(groups.find(g => g.kind === "backlog")!.paged).toBe(true);
  });

  it("gives a kanban board To Do, In Progress and the last fortnight's Done, and its backlog when it shows one", () => {
    expect(groupsFor(overview({ hasSprints: false, hasBacklog: false })).map(g => g.id)).toEqual(["column:todo", "column:progress", "column:done"]);
    expect(groupsFor(overview({ hasSprints: false, hasBacklog: true })).map(g => g.id)).toContain("backlog");
  });

  it("opens a sprint that has just become active, whatever an old choice said", () => {
    const [active] = groupsFor(overview({ sprints: { active: [sprint(15, "S15", "active")], future: [] } } as Partial<JiraBoardOverview>));
    expect(groupOpen(active, { "sprint:14": false })).toBe(true);
    expect(groupOpen(active, { "sprint:15": false })).toBe(false);
  });
});

describe("rows: each issue once, a sub-task with its parent", () => {
  it("puts a sub-task under its parent when the parent is in the same results, wherever it ranks", () => {
    const story = issue("MOCK-10", { subtaskKeys: ["MOCK-11"] });
    const child = sub("MOCK-11", story);
    const rows = buildRows([child, story]);
    expect(rows.map(rowKey)).toEqual(["MOCK-10"]);
    expect(rows[0]).toMatchObject({ kind: "issue", matched: [child] });
  });

  it("draws a context row for a parent that is not in the results — your sub-task under somebody else's story", () => {
    const theirs = issue("MOCK-20", { assignee: { id: "a", name: "Alex", avatar: null } });
    const mine = sub("MOCK-21", theirs, { mine: true });
    const rows = buildRows([mine]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "context", parent: { key: "MOCK-20" }, matched: [mine] });
  });

  it("never draws an issue twice: not twice in one group, and not again in a later group", () => {
    const a = issue("MOCK-1");
    const seen = new Set<string>();
    expect(buildRows([a, a], seen).map(rowKey)).toEqual(["MOCK-1"]);
    expect(buildRows([a, issue("MOCK-2")], seen).map(rowKey)).toEqual(["MOCK-2"]);
  });

  it("keeps a parent while a sub-task under it still matches the filter, and drops the done under Hide done", () => {
    const story = issue("MOCK-10", { summary: "Checkout" });
    const open = sub("MOCK-11", story, { summary: "Write the payment form" });
    const done = sub("MOCK-12", story, { status: status("done"), summary: "Spike" });
    const rows = buildRows([story, open, done]);
    const found = filterRows(rows, { search: "payment", hideDone: false });
    expect(found.map(rowKey)).toEqual(["MOCK-10"]);
    expect(found[0].matched.map(i => i.key)).toEqual(["MOCK-11"]);
    expect(filterRows(rows, { search: "", hideDone: true })[0].matched.map(i => i.key)).toEqual(["MOCK-11"]);
    expect(filterRows(rows, { search: "nothing like it", hideDone: false })).toEqual([]);
  });
});

describe("what a sprint's header counts", () => {
  it("counts the top-level issues and the sub-tasks under context rows, never a context row itself", () => {
    const me = { id: "me", name: "Jane", avatar: null };
    const alex = { id: "a", name: "Alex", avatar: null };
    const story = issue("MOCK-10", { mine: true, assignee: me, estimate: 7200, status: status("indeterminate") });
    const theirs = issue("MOCK-20", { assignee: alex });
    const mineUnder = sub("MOCK-21", theirs, { mine: true, assignee: me, estimate: 3600, status: status("done") });
    const rows = buildRows([story, mineUnder]);
    const stats = groupStats(rows, "time");
    expect(stats.count).toBe(2);
    expect(stats.totals).toEqual({ new: 0, indeterminate: 7200, done: 3600 });
    expect([stats.mine, stats.mineDone]).toEqual([2, 1]);
    expect(stats.assignees.map(p => p.name)).toEqual(["Jane"]);
    expect(groupStats(rows, "count").totals).toEqual({ new: 0, indeterminate: 1, done: 1 });
  });
});

describe("a duration, the way Jira writes it", () => {
  it("uses the instance's working day and week", () => {
    expect(jiraDuration(8 * 3600)).toBe("1d");
    expect(jiraDuration(5 * 8 * 3600 + 3 * 3600 + 30 * 60)).toBe("1w 3h 30m");
    expect(jiraDuration(6 * 3600, { hoursPerDay: 6, daysPerWeek: 4 })).toBe("1d");
    expect(jiraDuration(24 * 3600, { hoursPerDay: 6, daysPerWeek: 4 })).toBe("1w");
    expect(jiraDuration(null)).toBe("");
  });
});

describe("the icons the panel draws itself", () => {
  it("knows Jira's standard types and both of its priority schemes", () => {
    expect(["Bug", "Story", "Task", "Sub-task", "Epic", "Spike", "Custom thing"].map(name => typeShape(name)))
      .toEqual(["bug", "story", "task", "subtask", "epic", "task", "other"]);
    expect(["Highest", "High", "Medium", "Low", "Lowest", "Blocker", "Major", "Minor", "Trivial", "P9"].map(priorityLevel))
      .toEqual(["highest", "high", "medium", "low", "lowest", "highest", "high", "low", "lowest", null]);
  });
});

// ── the sanitiser ───────────────────────────────────────────────────────────

/** An element or a text node, the way DOMParser would hand it over. */
const el = (name: string, attrs: Record<string, string> = {}, ...children: Array<HtmlNode | string>): HtmlNode => ({
  nodeType: 1, nodeName: name.toUpperCase(),
  childNodes: children.map(c => (typeof c === "string" ? { nodeType: 3, nodeName: "#text", nodeValue: c, childNodes: [] } : c)),
  getAttribute: (k: string) => (Object.hasOwn(attrs, k) ? attrs[k] : null),
});
const draw = (root: HtmlNode, image: (u: string) => string | null = u => `/asset?url=${encodeURIComponent(u)}`) =>
  renderToStaticMarkup(createElement("div", null, htmlToReact("<x>", { baseUrl: "https://jira.example.com", image }, () => root)));

describe("an issue's HTML, rebuilt from an allowlist", () => {
  it("drops script, style, frames and forms with everything in them, and every handler and style attribute", () => {
    const out = draw(el("body", {},
      el("p", { onclick: "steal()", style: "color:red", id: "x" }, "Hello ", el("strong", {}, "there")),
      el("script", {}, "alert(1)"),
      el("style", {}, "body{display:none}"),
      el("iframe", { src: "https://evil.example" }),
      el("form", { action: "https://evil.example" }, el("input", { value: "x" })),
      el("svg", {}, el("script", {}, "alert(2)")),
    ));
    expect(out).toBe("<div><p>Hello <strong>there</strong></p></div>");
  });

  it("keeps a link only when it is http(s), opened away from the page with no referrer", () => {
    const out = draw(el("body", {},
      el("a", { href: "javascript:alert(1)" }, "click"),
      el("a", { href: "data:text/html,<script>alert(1)</script>" }, "data"),
      el("a", { href: "/browse/MOCK-1" }, "MOCK-1"),
    ));
    expect(out).toBe('<div>clickdata<a href="https://jira.example.com/browse/MOCK-1" target="_blank" rel="noreferrer noopener">MOCK-1</a></div>');
    expect(safeHref("https://user:pw@jira.example.com/x", "https://jira.example.com")).toBeNull();
  });

  it("loads an image through the asset route only, and draws a link for one it will not load", () => {
    const out = draw(el("body", {},
      el("img", { src: "/secure/attachment/1/shot.png", alt: "shot" }),
      el("img", { src: "https://evil.example/x.png", alt: "elsewhere" }),
    ), u => (u.startsWith("https://jira.example.com/") ? `/asset?url=${encodeURIComponent(u)}` : null));
    expect(out).toContain(`src="/asset?url=${encodeURIComponent("https://jira.example.com/secure/attachment/1/shot.png")}"`);
    expect(out).toContain('<a class="jr-image-link" href="https://evil.example/x.png" target="_blank" rel="noreferrer noopener">elsewhere</a>');
    expect(out).not.toContain('src="https://evil.example');
  });

  it("draws an emoticon it cannot load as its own text, not as a link", () => {
    expect(draw(el("body", {}, el("img", { src: "/images/icons/emoticons/smile.svg", alt: ":)", class: "emoticon" })), () => null))
      .toBe("<div>:)</div>");
  });

  it("steps an issue's headings under the detail's own, maps Jira's panels and unwraps what it does not know", () => {
    const out = draw(el("body", {},
      el("h1", {}, "Title"),
      el("div", { class: "panel" }, el("div", { class: "panelContent" }, "Note")),
      el("blink", {}, "kept text"),
    ));
    expect(out).toBe('<div><h5>Title</h5><div class="jr-html-panel"><div class="jr-html-panel-body">Note</div></div>kept text</div>');
  });

  it("stops at a depth no description needs, rather than recursing without end", () => {
    let node: HtmlNode = el("span", {}, "deep");
    for (let i = 0; i < 500; i++) node = el("div", {}, node);
    expect(() => draw(el("body", {}, node))).not.toThrow();
    expect(draw(el("body", {}, node))).not.toContain("deep");
  });
});

// ── where the reader finds it ───────────────────────────────────────────────

describe("Settings › Integrations, and the rail control a connection adds", () => {
  it("sits between Sounds and Data, and a search for Jira lands on it", () => {
    const ids = SETTINGS_SECTIONS.map(s => s.id);
    expect(ids.indexOf("integrations")).toBe(ids.indexOf("sounds") + 1);
    expect(ids.indexOf("data")).toBe(ids.indexOf("integrations") + 1);
    const found = searchSettings("jira");
    expect(found.length).toBeGreaterThan(0);
    expect(found.every(e => e.section === "integrations")).toBe(true);
    expect(searchSettings("personal access token").map(e => e.id)).toContain("integrations-add");
  });

  it("draws no rail control until a connection of that kind exists, then one per kind, opening a dialog on I", () => {
    expect(items().integrations).toEqual([]);
    const conn = (id: string): IntegrationConnection => ({
      id, kind: "jira", name: id, baseUrl: "https://jira.example.com", account: {} as never, meta: {} as never,
      allowedOrigins: ["https://jira.example.com"], createdAt: "", updatedAt: "", tokenSaved: true,
    });
    const state: IntegrationsState = { connections: [conn("a"), conn("b")], providers: [], error: "" };
    const connected = integrationDefs().filter(p => connectionsOf(state, p.kind).length > 0);
    const rails = railItems({
      providers: { kind: "reported", claude: true, codex: true } as never,
      sessionListOpen: false, toggleSessionList: () => {}, accountsPanelOpen: false, toggleAccountsPanel: () => {},
      usagePanelOpen: false, setUsagePanelOpen: () => {}, machinePanelOpen: false, setMachinePanelOpen: () => {},
      setUsageHistoryOpen: () => {}, watchOn: false, watchUnseen: 0, setBrowserWatchOpen: () => {}, openSettings: () => {}, onFeedback: () => {},
      toggles: { sessionList: { current: null }, usage: { current: null }, accounts: { current: null }, machine: { current: null } } as never,
      integrations: connected.map(provider => ({ provider, onPress: () => {} })),
    } as Parameters<typeof railItems>[0]);
    expect(rails.integrations.map(r => [r.id, r.label, r.kind, r.key?.cap])).toEqual([["integration-jira", "Jira", "dialog", "I"]]);
  });
});
