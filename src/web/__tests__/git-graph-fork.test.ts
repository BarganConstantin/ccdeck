// The history in the git view's Fork look, as the markup builds it: the
// layout it draws (no column held for an uncommitted row unless HEAD would
// fold), no uncommitted row, no pane head, the dot slot, the ↩ mark, bold
// prefixes on every row, agent marks in the lane and a name chip at the end
// of the subject, and the selection's two pills.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GitGraph, { forkLayout, hoverAnchor, type GitGraphProps } from "../components/GitGraph";
import { layoutGraph, forkRowDrawing, graphColumns, FORK_GEOMETRY, VISIBLE_LANES, WIP_ID, type LogCommit } from "../git-graph-layout";
import { shopHistory, HISTORY_HEAD } from "./git-graph-history";
import { sourceOf } from "./client-source";
import { sheetText } from "./sheet-source";

const HEAD = { sha: HISTORY_HEAD, branch: "develop", detached: false, short: HISTORY_HEAD, unborn: false };

function c(sha: string, parents: string[] = [], local: string[] = [], extra: Partial<LogCommit> = {}): LogCommit {
  return {
    sha, parents, author: { name: "A", email: "a@example.com" }, date: "2026-10-05T16:00:00Z",
    subject: extra.subject ?? `commit ${sha}`, trailers: [], refs: { local, remote: [], tags: [], head: false },
    agent: null, ...extra,
  };
}

// ─── the layout the look draws ────────────────────────────────────────────

describe("the Fork look's layout", () => {
  it("holds no column for an uncommitted row: the newest lanes start in the first column", () => {
    const list = shopHistory(40);
    const head = { sha: "c66f14c", branch: "feature/auth-login", detached: false, short: "c66f14c", unborn: false };
    const layout = forkLayout(list, head, new Map(), null);
    expect(layout.rows.some(r => r.id === WIP_ID)).toBe(false);
    expect(layout.rows[0]).toMatchObject({ id: "eb7170c", col: 0 });
    expect(layout.rows.find(r => r.id === "c66f14c")!.col).toBe(1);
  });

  it("holds the first column for HEAD after all when HEAD's line would fold away", () => {
    // Nine branches newer than HEAD, each a lane of its own.
    const topics = Array.from({ length: 9 }, (_, i) => c(`t${i}`, ["b0"], [`topic/t${i}`]));
    const list = [...topics, c("h", ["b0"], [], { refs: { local: [], remote: [], tags: [], head: true } }), c("b0")];
    const head = { sha: "h", branch: null, detached: true, short: "h", unborn: false };
    const bare = layoutGraph(list, { head, wip: false });
    expect(bare.rows.find(r => r.id === "h")!.col).toBeGreaterThanOrEqual(VISIBLE_LANES);
    const layout = forkLayout(list, head, new Map(), null);
    expect(layout.rows.find(r => r.id === "h")!.col).toBe(0);
  });

  it("runs a merge that takes HEAD in down the held column into HEAD, with no gap", () => {
    // Seven branches newer than HEAD fold its lane, and develop's merge above
    // HEAD took HEAD's branch in.
    const topics = Array.from({ length: 7 }, (_, i) => c(`t${i}`, ["b0"], [`topic/t${i}`]));
    const list = [
      ...topics,
      c("m", ["x", "h"], ["develop"], { subject: "Merge pull request #9 from someone/feature/mine" }),
      c("h", ["b0"], [], { refs: { local: ["feature/mine"], remote: [], tags: [], head: true } }),
      c("x", ["b0"]),
      c("b0"),
    ];
    const head = { sha: "h", branch: "feature/mine", detached: false, short: "h", unborn: false };
    const layout = forkLayout(list, head, new Map(), null);
    const { folded } = graphColumns(layout.columns);
    const row = (id: string) => layout.rows.find(r => r.id === id)!;
    // What the look draws: no uncommitted row, so none of its held lane.
    const drawn = (id: string, kind: string) => forkRowDrawing(row(id), row(id).kind === "merge" ? "merge" : "commit", layout.headKey, folded)
      .strokes.filter(s => !s.wip && s.kind === kind).map(s => s.d);
    const { laneX0: x0, rowH: H } = FORK_GEOMETRY;
    expect(row("h").col).toBe(0);
    // The merge's run reaches its row's foot in HEAD's column, and HEAD's
    // line comes in from the top of HEAD's row.
    expect(drawn("m", "merge")).toEqual([expect.stringMatching(new RegExp(` ${x0} [\\d.]+V${H}$`))]);
    expect(drawn("h", "in").some(d => d.startsWith(`M${x0} 0V`))).toBe(true);
    // The deck look still draws the held lane dashed to HEAD, the merge meeting it.
    const deck = layoutGraph(list, { head, wip: true });
    const deckMerge = deck.rows.find(r => r.id === "m")!;
    expect(deckMerge.edges.find(e => e.kind === "merge")).toMatchObject({ to: 0, joins: true });
    expect(deckMerge.output[0]).toMatchObject({ id: "h", wip: true });
  });
});

// ─── the card a key brings up ─────────────────────────────────────────────

describe("the agent card a key brings up", () => {
  /** An element with `boxes` client rects, holding `chip`. */
  const el = (boxes: number, chip: Element | null = null) =>
    ({ querySelector: () => chip, getClientRects: () => ({ length: boxes }) }) as unknown as Element;

  it("stands by the row's agent chip while it is drawn, and by the row when a narrow history hides it", () => {
    const drawn = el(1);
    const withChip = el(1, drawn);
    expect(hoverAnchor(withChip)).toBe(drawn);
    // Under 480px another session's chip is display:none: it has no box.
    const withHidden = el(1, el(0));
    expect(hoverAnchor(withHidden)).toBe(withHidden);
    const bare = el(1);
    expect(hoverAnchor(bare)).toBe(bare);
  });
});

// ─── the row, as the markup builds it ─────────────────────────────────────

function render(props: Partial<GitGraphProps> & Pick<GitGraphProps, "commits" | "head">): string {
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return renderToStaticMarkup(createElement(GitGraph, {
      repoKey: "fork-test", uncommitted: { files: 3, byFocus: 1, label: "api-fix" }, focus: { sessionId: "s", agentIds: null },
      selected: HISTORY_HEAD, onSelect: () => {}, onOpen: () => {}, onAgentCard: () => {}, liveInsert: null, look: "fork", ...props,
    }));
  } finally {
    quiet.mockRestore();
  }
}
/** Each row's markup by its data-id. */
function rows(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = html.split(/(?=<div role="option")/).slice(1);
  for (const p of parts) out.set(/data-id="([^"]+)"/.exec(p)![1], p);
  return out;
}

describe("the Fork look's fold, in words", () => {
  it("says on each row drawing the fold how many lanes it holds", () => {
    // Nine branches newer than a detached HEAD: four lanes fold.
    const topics = Array.from({ length: 9 }, (_, i) => c(`t${i}`, ["b0"], [`topic/t${i}`]));
    const list = [...topics, c("h", ["b0"], [], { refs: { local: [], remote: [], tags: [], head: true } }), c("b0")];
    const head = { sha: "h", branch: null, detached: true, short: "h", unborn: false };
    const html = render({ commits: list, head, selected: "h" });
    const drawn = rows(html);
    expect(html).toMatch(/aria-label="History, 4 more lanes folded into the last column"/);
    const words = '<span class="fk-cell-graph" title="4 more lanes folded into this column; the checked-out branch keeps its own">';
    // t5 onwards sit in the fold, and every row below draws its line.
    for (const id of ["t5", "t8", "h", "b0"]) expect(drawn.get(id), id).toContain(words);
    for (const id of ["t0", "t4"]) {
      expect(drawn.get(id), id).toContain('<span class="fk-cell-graph">');
      expect(drawn.get(id), id).not.toContain("lanes folded");
    }
  });
});

describe("a Fork history row", () => {
  const seen = { sessionId: "s", agentId: null, label: "api-fix", agentType: null, kind: "claude" as const, model: "claude-opus-5-5", durationMs: 60_000, confidence: "seen" as const };
  const list = shopHistory(40).map(x => {
    if (x.sha === HISTORY_HEAD) return { ...x, hasBody: true, unpushed: true, agent: seen };
    if (x.sha === "ce73d51") return { ...x, unpushed: true, agent: { agent: "claude" as const, confidence: "trailer" as const } };
    if (x.sha === "2f2c90d") return { ...x, agent: seen };
    return { ...x, hasBody: false };
  });
  const html = render({ commits: list, head: HEAD, listFocused: true });
  const drawn = rows(html);

  it("draws no uncommitted row, no pane head and no legend, whatever the working tree holds", () => {
    expect(drawn.has("uncommitted")).toBe(false);
    expect(drawn.size).toBe(40);
    expect(html).not.toContain("gv-pane-head");
    expect(html).not.toContain("gv-legend");
    expect(html).not.toMatch(/is-wip/);
  });

  it("draws every row's graph 22px tall and one width for the whole list", () => {
    const svgs = [...html.matchAll(/<svg class="fk-lanes" width="([\d.]+)" height="(\d+)"/g)];
    expect(svgs).toHaveLength(40);
    expect(new Set(svgs.map(m => m[2]))).toEqual(new Set(["22"]));
    expect(new Set(svgs.map(m => m[1])).size).toBe(1);
    expect(html).toMatch(new RegExp(`--fk-graph-w:${svgs[0][1]}px`));
  });

  it("bolds HEAD's row and every conventional prefix, on every tone", () => {
    expect(drawn.get(HISTORY_HEAD)).toMatch(/class="fk-row is-sel is-head"/);
    // ab9d31e is origin/develop's, which HEAD cannot reach: still bold.
    expect(drawn.get("ab9d31e")).toMatch(/data-tone="off"/);
    expect(drawn.get("ab9d31e")).toContain('<b class="fk-cc">fix(portal):</b>');
    expect(drawn.get("ebe97fb")).toContain('<b class="fk-cc">chore(ci):</b>');
  });

  it("puts the unpushed dot, or the unreachable one, before the badges, and ↩ after a subject with a body", () => {
    expect(drawn.get(HISTORY_HEAD)).toMatch(/<i class="fk-dot" data-kind="unpushed" title="Not pushed yet"><\/i><span class="fk-refs"/);
    expect(drawn.get("ab9d31e")).toMatch(/<i class="fk-dot" data-kind="incoming"/);
    expect(drawn.get("ebe97fb")).not.toContain("fk-dot");
    expect(drawn.get(HISTORY_HEAD)).toContain('class="fk-ret"');
    expect(drawn.get("ebe97fb")).not.toContain('class="fk-ret"');
    expect(drawn.get(HISTORY_HEAD)).toMatch(/aria-label="[^"]*Not pushed yet"/);
  });

  it("marks an agent's commit with a diamond in the lane, a trailer with a hollow one, and keeps a merge's ring whoever made it", () => {
    expect(drawn.get(HISTORY_HEAD)).toMatch(/<path class="fk-node is-seen" data-lane="0"/);
    expect(drawn.get("ce73d51")).toMatch(/<path class="fk-node is-trailer"/);
    const merge = drawn.get("2f2c90d")!;
    expect(merge).toMatch(/<circle class="fk-node is-merge"[^>]* r="6"/);
    expect(merge).toContain('class="fk-node is-chevron"');
    expect(merge).not.toContain("is-seen");
    expect(merge).toMatch(/<span class="gv-agent-chip fk-chip" data-level="seen"/);
    // Lines stay out of the ring's hollow.
    expect(merge).toMatch(/<mask id="[^"]+-ring"[\s\S]*<circle[^>]* r="5.2" fill="black"/);
    expect(drawn.get("ebe97fb")).toMatch(/<circle class="fk-node is-commit"[^>]* r="2.5"/);
  });

  it("names the agent in a pill at the end of the subject, and says the level in words", () => {
    expect(drawn.get(HISTORY_HEAD)).toMatch(/<span class="gv-agent-chip fk-chip" data-level="seen"[^>]*><i class="gv-swatch fk-swatch"><\/i><span class="gv-agent-name">api-fix<\/span>/);
    expect(drawn.get("ce73d51")).toMatch(/data-level="trailer"/);
    expect(drawn.get(HISTORY_HEAD)).toMatch(/aria-label="[^"]*Made by api-fix, seen by ccdeck/);
    expect(drawn.get("ebe97fb")).toMatch(/aria-label="[^"]*No agent seen/);
  });

  it("casts the selected row's lines on the list's colour, and only that row's", () => {
    expect(drawn.get(HISTORY_HEAD)).toContain('class="fk-case"');
    expect([...drawn.values()].filter(m => m.includes('class="fk-case"'))).toHaveLength(1);
  });

  it("shows the accent pill only while the list holds focus", () => {
    expect(html).toMatch(/role="listbox"[^>]*data-focused=""/);
    expect(render({ commits: list, head: HEAD, listFocused: false })).not.toMatch(/data-focused/);
  });

  it("keeps the deck look's rows when no look is asked for", () => {
    const deck = render({ commits: list, head: HEAD, look: undefined });
    expect(deck).toContain("gv-pane-head");
    expect(deck).toContain('data-id="uncommitted"');
    expect(deck).not.toContain("fk-row");
  });
});

describe("the Fork row's source", () => {
  const src = sourceOf("components/GitGraph.tsx");
  const row = src.slice(src.indexOf("const FkHistoryRow = memo("), src.indexOf("export function forkLayout("));

  it("is one option with one stop in the tab order and nothing operable inside it", () => {
    expect(row.length).toBeGreaterThan(1500);
    expect(row.match(/role="option"/g)).toHaveLength(1);
    expect(row.match(/tabIndex=/g)).toHaveLength(1);
    expect(row).not.toMatch(/<button|<a |<input|href=|onClick|onKeyDown/);
  });

  it("pages the keyboard by the look's own row height", () => {
    expect(src).toMatch(/Math\.floor\(\(listRef\.current\?\.clientHeight \?\? geo\.rowH \* 10\) \/ geo\.rowH\) - 1/);
    expect(src).toMatch(/m\.set\(id, \(i \+ lines\) \* geo\.rowH\)/);
  });

  it("writes no colour of its own in the badge and avatar components either", () => {
    for (const f of ["components/FkRefBadge.tsx", "components/FkAvatar.tsx"]) {
      const s = sourceOf(f);
      expect(s, f).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(s, f).not.toMatch(/rgba?\(|hsl\(/);
    }
  });
});

describe("the Fork row in the sheet", () => {
  const sheet = sheetText();
  const rule = (sel: string) => {
    const at = sheet.indexOf(`\n${sel} {`);
    if (at < 0) throw new Error(`no rule ${sel}`);
    return sheet.slice(at, sheet.indexOf("}", at));
  };
  const F = '.gv-wide[data-look="fork"]';

  it("is 22px tall, 10px in from each edge, its content-visibility sized to the row", () => {
    const r = rule(`${F} .fk-row`);
    expect(r).toMatch(/height: 22px;/);
    expect(r).toMatch(/margin: 0 10px;/);
    expect(r).toMatch(/content-visibility: auto;/);
    expect(r).toMatch(/contain-intrinsic-size: auto 22px;/);
    expect(r).toMatch(/grid-template-columns: var\(--fk-graph-w\) minmax\(100px, 1fr\) 157px 77px max\(163px, var\(--fk-date-min, 0px\)\);/);
    expect(r).toMatch(/font-size: 13px;/);
  });

  it("draws 1.6px lines in butt caps, the ring and chevron at 1.6px, the hollow diamond at 1.3px", () => {
    expect(rule(`${F} .fk-e`)).toMatch(/stroke-width: 1\.6;[^}]*stroke-linecap: butt;/);
    expect(sheet).toMatch(/\.fk-node\.is-chevron \{ fill: none; stroke: var\(--gv-forced-ink, var\(--lane\)\); stroke-width: 1\.6; stroke-linecap: round; stroke-linejoin: round; \}/);
    expect(sheet).toMatch(/\.fk-node\.is-trailer \{ fill: none; stroke: var\(--gv-forced-ink, var\(--lane\)\); stroke-width: 1\.3;/);
    for (let n = 0; n <= 5; n++) expect(sheet).toContain(`${F} [data-lane="${n}"] { --lane: var(--fk-lane-${n}); }`);
  });

  it("selects with the grey pill, the accent one while the list holds focus, and nothing on hover", () => {
    expect(rule(`${F} .fk-row.is-sel`)).toMatch(/background: var\(--fk-select-idle\);/);
    expect(rule(`${F} .gv-graph-scroll[data-focused] .fk-row.is-sel`)).toMatch(/background: var\(--fk-select\);/);
    expect(sheet).not.toMatch(/\.fk-row:hover/);
  });

  it("keeps the subject's room as the pane narrows: the date narrows, the author keeps its avatar, then the SHA and the date go", () => {
    const tier = (px: number) => {
      const at = sheet.indexOf(`@container gvhist (max-width: ${px}px) {\n  ${F} .fk-row`);
      if (at < 0) throw new Error(`no ${px}px tier`);
      return sheet.slice(at, sheet.indexOf("\n}\n", at));
    };
    expect(tier(999)).toMatch(/157px 77px max\(140px, var\(--fk-date-min, 0px\)\)/);
    expect(tier(799)).toMatch(/24px 77px max\(140px/);
    expect(tier(799)).toMatch(/\.fk-author-name \{ display: none; \}/);
    expect(tier(679)).toMatch(/\.fk-cell-sha \{ display: none; \}/);
    expect(tier(479)).toMatch(/\.fk-cell-date \{ display: none; \}/);
    // On a phone another session's chip gives its room to the subject; the
    // focused agent's own chips stay, as their swatch and, on a subagent's
    // commit, its ↳: the name moves to the chip's title and the row's
    // description, as the date's words move to the row's title. A chip from
    // the commit message has no swatch, and its hollow diamond says it.
    expect(tier(479)).toMatch(/\.fk-chip\[data-quiet\] \{ display: none; \}/);
    expect(tier(479)).not.toMatch(/\.fk-chip \{ display: none/);
    expect(tier(479)).toMatch(/\.fk-chip \.gv-agent-name \{ display: none; \}/);
    expect(tier(479)).toMatch(/\.fk-chip \.fk-chip-sub \{ display: inline; \}/);
    expect(tier(479)).toMatch(/\.fk-chip\[data-level="trailer"\] \{ display: none; \}/);
    expect(rule(`${F} .fk-chip-sub`)).toMatch(/display: none;/);
    expect(sourceOf("components/GitGraph.tsx")).toMatch(/\{agent\.sub && <span className="fk-chip-sub" aria-hidden="true">↳<\/span>\}/);
  });

  it("lets the subject give way before the agent's name, the chip never below its swatch and five letters", () => {
    // The chip does not shrink with the subject: the same name is the same
    // chip on every row, cut only past its cap (a share of the cell), never
    // by the few pixels one longer subject asks of it.
    const chip = rule(`${F} .fk-chip`);
    expect(chip).toMatch(/flex: none;/);
    expect(chip).toMatch(/min-width: 64px;/);
    expect(chip).toMatch(/max-width: min\(180px, 40%\);/);
    expect(rule(`${F} .fk-subj`)).toMatch(/flex: 0 1 auto;/);
  });

  it("cuts a badge too long for the room its row leaves with an ellipsis, never through a letter", () => {
    const badge = rule(`${F} .fk-ref`);
    expect(badge).toMatch(/flex: 0 1 auto;/);
    expect(badge).toMatch(/min-width: 0;/);
    expect(rule(`${F} .fk-ref-name`)).toMatch(/text-overflow: ellipsis;/);
    // The +N and the cloud of a pushed branch keep their size.
    expect(rule(`${F} .fk-ref[data-kind="more"]`)).toMatch(/flex: none;/);
  });

  it("draws badges 18px with a 4px radius and 12px words, the chip a 999px pill", () => {
    const b = rule(`${F} .fk-ref`);
    expect(b).toMatch(/height: 18px;/);
    expect(b).toMatch(/border-radius: 4px;/);
    expect(b).toMatch(/font-size: 12px;/);
    expect(b).toMatch(/gap: 4px|gap: 3px/);
    const chip = rule(`${F} .fk-chip`);
    expect(chip).toMatch(/border-radius: 999px;/);
    expect(chip).toMatch(/height: 18px;/);
    expect(rule(`${F} .fk-dot`)).toMatch(/width: 5px; height: 5px;/);
  });
});
