// The history as GitGraph draws it, rendered to markup: what a first frame
// draws against the whole history, and what a busy repository folds away.
//
// A first frame drew 24 commits laid out on their own, so the graph cell was
// as wide as those rows needed and grew a frame later, pushing every subject
// right by a lane or more. A clean detached HEAD had no uncommitted row to
// hold the first column, so in a busy repository it was the lane that folded:
// HEAD and the agent's diamond drawn as a grey dot, its ring gone. And any
// agent commit in the fold lost its diamond to the same dot.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GitGraph, { type GitGraphProps } from "../components/GitGraph";
import { type LogCommit } from "../git-graph-layout";
import { shopHistory, HISTORY_HEAD } from "./git-graph-history";

function render(props: Partial<GitGraphProps> & Pick<GitGraphProps, "commits" | "head">): string {
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return renderToStaticMarkup(createElement(GitGraph, {
      repoKey: "render-test", uncommitted: { files: 0, byFocus: 0, label: "api-fix" }, focus: { sessionId: "s", agentIds: null },
      selected: "uncommitted", onSelect: () => {}, onOpen: () => {}, onAgentCard: () => {}, liveInsert: null, ...props,
    }));
  } finally {
    quiet.mockRestore();
  }
}

/** Each drawn row's opening tag and its lanes' markup, by its data-id. */
function rows(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<div role="option"[^>]*data-id="([^"]+)"[\s\S]*?<\/svg>/g;
  // Each list numbers its own ids; the rest of a row is what is compared.
  for (let m = re.exec(html); m; m = re.exec(html)) out.set(m[1], m[0].replace(/\bgvh\d+-/g, "gvh-"));
  return out;
}
const laneWidths = (html: string) => new Set([...html.matchAll(/<svg class="gv-lanes" width="(\d+(?:\.\d+)?)"/g)].map(m => m[1]));

const at = (iso: number) => new Date(Date.UTC(2026, 9, 6, 12) - iso * 60_000).toISOString();
function commit(sha: string, parents: string[], minutesAgo: number, extra: Partial<LogCommit> = {}): LogCommit {
  return {
    sha, parents, author: { name: "A", email: "a@example.com" }, date: at(minutesAgo), subject: `work on ${sha}`, trailers: [],
    refs: { local: [], remote: [], tags: [], head: false }, agent: null, ...extra,
  };
}

describe("a first frame", () => {
  it("draws its first rows at the width, fold and lanes the whole history gets", () => {
    const commits = shopHistory(100);
    const head = { branch: "develop", detached: false, sha: HISTORY_HEAD, short: HISTORY_HEAD, unborn: false };
    const all = render({ commits, head });
    const first = render({ commits, head, rowLimit: 24 });
    expect(rows(first).size).toBe(25); // the uncommitted row and 24 commits
    expect(laneWidths(first)).toEqual(laneWidths(all));
    expect(laneWidths(all).size).toBe(1);
    // Each row drawn is drawn as it is in the whole history.
    const whole = rows(all);
    for (const [id, markup] of rows(first)) expect(markup, id).toBe(whole.get(id));
  });
});

describe("a busy repository with a clean detached HEAD", () => {
  // Nine branches dated after the commit HEAD is detached at, each a lane of
  // its own; the newest carries an agent's commit.
  const seen = { sessionId: "s", agentId: null, label: "infra-bump", agentType: null, kind: "claude" as const, model: "claude-haiku-4-5", durationMs: 60_000, confidence: "seen" as const };
  const topics = Array.from({ length: 9 }, (_, i) => commit(`t${i + 1}`, ["b0"], i + 1, { refs: { local: [`topic/t${i + 1}`], remote: [], tags: [], head: false } }));
  const commits = [
    ...topics.slice(0, 8),
    commit("t9", ["b0"], 9, { refs: { local: ["topic/t9"], remote: [], tags: [], head: false }, agent: seen }),
    commit("h", ["b0"], 30, { refs: { local: [], remote: [], tags: ["v0.3.0"], head: true }, agent: seen }),
    commit("b0", [], 600),
  ].filter((c, i, list) => list.findIndex(x => x.sha === c.sha) === i);
  const head = { branch: null, detached: true, sha: "h", short: "h", unborn: false };
  const html = render({ commits, head, selected: "h" });
  const drawn = rows(html);

  it("keeps HEAD in the first column with its ring and its diamond", () => {
    const h = drawn.get("h")!;
    expect(h).toContain('class="gv-head-ring"');
    expect(h).toMatch(/class="gv-node is-seen"/);
    expect(h).not.toContain("gv-fold-node");
    expect(html).toMatch(/\+\d+ lanes/);
  });

  it("draws no uncommitted row and none of its dashed line", () => {
    expect(drawn.has("uncommitted")).toBe(false);
    expect(html).not.toMatch(/gv-e[^"]*is-wip/);
  });

  it("keeps an agent's diamond on a commit whose lane folded, in the fold's grey", () => {
    const folded = [...drawn.values()].filter(m => m.includes("gv-fold-node"));
    expect(folded.length).toBeGreaterThan(0);
    expect(drawn.get("t9")).toMatch(/<path class="gv-fold-node is-seen" d="M/);
    // A folded commit nobody was seen making keeps the plain dot.
    const plain = [...drawn.entries()].filter(([id, m]) => id !== "t9" && m.includes("gv-fold-node"));
    for (const [id, m] of plain) expect(m, id).toMatch(/<circle class="gv-fold-node"/);
  });
});

describe("HEAD older than the window", () => {
  it("lists HEAD under its own words, ringed, its dashed line coming in, the session's older commits apart", () => {
    const window = Array.from({ length: 6 }, (_, i) => commit(`n${6 - i}`, [i === 5 ? "b0" : `n${5 - i}`], i + 1, i === 0 ? { refs: { local: ["other"], remote: [], tags: [], head: false } } : {}));
    const commits = [
      ...window,
      commit("h", ["h1"], 900, { outsideWindow: true, base: false, refs: { local: ["topic"], remote: [], tags: [], head: true } }),
      commit("h1", ["b0"], 901, { outsideWindow: true, base: true }),
      commit("old", ["zz"], 1000, { outsideWindow: true }),
    ];
    const head = { branch: "topic", detached: false, sha: "h", short: "h", unborn: false };
    const html = render({ commits, head, uncommitted: { files: 2, byFocus: 1, label: "api-fix" } });
    const words = [...html.matchAll(/<div class="gv-older" role="presentation">([^<]+)<\/div>/g)].map(m => m[1]);
    expect(words).toEqual(["HEAD is older than the history above", "Older commits from this session"]);
    const drawn = rows(html);
    expect(drawn.get("h")).toContain('class="gv-head-ring"');
    expect(drawn.get("h")).toMatch(/data-head=""/);
    expect(drawn.get("h")).toMatch(/class="gv-e is-wip"[^>]*d="M7 0V/);
    expect(drawn.get("h")).toMatch(/data-tone="own"/);
    expect(drawn.get("h1")).toMatch(/data-tone="base"/);
    // The uncommitted row's dashed line runs down to the window's foot.
    expect(drawn.get("n1")).toMatch(/class="gv-e is-wip"[^>]*d="M7 0V24"/);
  });
});

describe("the view's first frame", () => {
  it("hands the history every commit and only limits the rows it draws", async () => {
    const { sourceOf } = await import("./client-source");
    const view = sourceOf("components/GitView.tsx");
    expect(view).toMatch(/commits=\{data\.commits\} rowLimit=\{rowLimit\}/);
    expect(view).not.toMatch(/all\.slice\(0, FIRST_ROWS\);\s*\n?\s*\/\/[^\n]*\n\s*return sel === UNCOMMITTED \|\| head\.some/);
    expect(view).toMatch(/\? FIRST_ROWS : undefined;/);
  });
});

describe("the legend over the history", () => {
  // It keys the marks on the commits; a repository with no commits yet has
  // none to key, and the legend over its lone Uncommitted row was noise.
  it("keys the marks when there are commits, and is left out before the first one", () => {
    const head = { branch: "main", detached: false, sha: "a1", short: "a1", unborn: false };
    expect(render({ commits: [commit("a1", [], 5)], head })).toContain('<span class="gv-legend">');
    const unborn = render({ commits: [], head: { branch: "main", detached: false, sha: null, short: null, unborn: true } as never });
    expect(unborn).not.toContain("gv-legend");
    expect(unborn).toContain('<span class="gv-pane-title">History</span>');
  });
});
