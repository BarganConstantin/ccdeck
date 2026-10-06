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

describe("the view's first frame", () => {
  it("hands the history every commit and only limits the rows it draws", async () => {
    const { sourceOf } = await import("./client-source");
    const view = sourceOf("components/GitView.tsx");
    expect(view).toMatch(/commits=\{data\.commits\} rowLimit=\{rowLimit\}/);
    expect(view).not.toMatch(/all\.slice\(0, FIRST_ROWS\);\s*\n?\s*\/\/[^\n]*\n\s*return sel === UNCOMMITTED \|\| head\.some/);
    expect(view).toMatch(/\? FIRST_ROWS : undefined;/);
  });
});
