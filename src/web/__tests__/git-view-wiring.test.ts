// The git view's wiring for what the server learnt to say: the counts on the
// working tree's changes reach the glance, and the subagents that work in
// another folder reach the files pane, where activating one narrows the whole
// view to it — its own worktree's history, files and diffs — until the scope
// chip widens it back.
import { describe, expect, it } from "vitest";
import { fitBranch, textColumns } from "../git-chip";
import { sourceOf } from "./client-source";
import { sheetParts } from "./sheet-source";

const view = sourceOf("components/GitView.tsx");
const glance = sourceOf("components/GitGlance.tsx");
const viewCss = sheetParts().find(([path]) => path === "styles/git-view.css")![1];

describe("a subagent working in another folder, from the files pane", () => {
  it("is listed only for the whole session's working tree", () => {
    expect(view).toMatch(/const elsewhere = !narrow && sel === UNCOMMITTED \? elsewhereRows\(data\.subagents \?\? \[\], /);
    expect(view).toMatch(/elsewhere=\{elsewhere\} onElsewhere=\{narrowTo\}/);
  });

  it("narrows the view to that subagent's own folder: every read names it", () => {
    expect(view).toMatch(/const agentParam = away \? away\.agentId : narrow \? focus\.agentIds!\[0\] : null;/);
    expect(view).toMatch(/ownFolder: away != null \|\| \(narrow && agent\.git != null\)/);
    // Its stale counter is its own card's, so the narrowed view reads again when it moves.
    expect(view).toMatch(/const awayCard = away && shown \? stateRef\.current\.agents\.get\(`\$\{shown\.sessionId\}::\$\{away\.agentId\}`\) \?\? null : null;/);
    expect(view).toMatch(/const facts = away \? awayCard\?\.git : /);
    expect(view).toMatch(/serialOf\(away\?\.git\)/);
  });

  it("widens back to the session from the scope chip, and starts over on a new agent or request", () => {
    expect(view).toMatch(/if \(away\) setAway\(null\); else setWidened\(true\);/);
    expect(view).toMatch(/useEffect\(\(\) => setNarrowed\(null\), \[request\.seq\]\);/);
    expect(view).toMatch(/const away = narrowed && shown && narrowed\.from === shown\.id \? narrowed\.row : null;/);
    // What a request named lives in the session's folder: a narrowed view opens on its own first file.
    expect(view).toMatch(/initial: away \? \{\} : \{ sel: request\.sel, file: request\.file \}/);
  });

  it("keeps focus inside the view while the narrowed read arrives, then hands it to the files", () => {
    expect(view).toMatch(/headRef\.current\?\.querySelector<HTMLElement>\("\.gv-scope-x"\)\?\.focus\(\{ preventScroll: true \}\);/);
    expect(view).toMatch(/if \(!wantFiles\.current \|\| !filesHandle\.current\) return;\s*wantFiles\.current = false;/);
    expect(view).toMatch(/active\.classList\.contains\("gv-scope-x"\)\) focusPane\("files"\);/);
  });
});

describe("counts in the glance", () => {
  it("ends a file row with its counts, the file's sides added together", () => {
    expect(glance).toMatch(/const n = pathCounts\(data\.entries \?\? \[\], f\.path\);/);
    expect(glance).toMatch(/<span className="gv-g-counts"><span className="gv-g-bin" title="binary file"><span aria-hidden="true">bin<\/span><span className="vis-hidden">binary file<\/span><\/span><\/span>/);
    expect(glance).toContain("groupDigits(n.added)");
  });

  it("keeps the counts on the file row's right, never pushing the path out", () => {
    const at = viewCss.indexOf(".gv-g-counts {");
    expect(at).toBeGreaterThan(-1);
    const rule = viewCss.slice(at, viewCss.indexOf("}", at));
    expect(rule).toMatch(/flex: none/);
    expect(rule).toMatch(/tabular-nums/);
    expect(viewCss).toMatch(/\.gv-g-add \{ color: var\(--gv-add-ink\); \}/);
    expect(viewCss).toMatch(/\.gv-g-del \{ color: var\(--gv-del-ink\); \}/);
  });
});

describe("a detached HEAD's name where it does not fit", () => {
  it("shows the bare short SHA rather than a cut inside it: the commit glyph already says detached", () => {
    const parts = sourceOf("components/GitViewParts.tsx");
    expect(parts).toMatch(/if \(full <= room \+ 1 \|\| !name\.length\) return;\s*if \(short\) \{ text\.nodeValue = short; return; \}/);
    expect(view).toMatch(/useFittedName\(branchName, headRef, `[^`]*`, detached \? shortSha : null\)/);
    expect(glance).toMatch(/useFittedName\(branchName, branchRowRef, `[^`]*`, detached \? shortSha : null\)/);
  });
});

describe("the header's branch name, cut to its box", () => {
  it("measures each spelling in the label's own font, as the card's chip does, never by counting characters", () => {
    const parts = sourceOf("components/GitViewParts.tsx");
    expect(parts).toMatch(/const measure = monoMeasure\(BRANCH_PX\);\s*text\.nodeValue = fitBranch\(name, t => measure\(t\) <= room\);/);
    expect(parts).not.toMatch(/t\.length \* cell/);
    // The size it states is the one the sheet sets both names in.
    expect(parts).toMatch(/export const BRANCH_PX = 12;/);
    expect(viewCss).toMatch(/\.gv-crumb-branch \{[^}]*font: 12px\/1 var\(--font-mono\);/);
    expect(viewCss).toMatch(/\.gv-g-branch \{[^}]*font: 12px\/1 var\(--font-mono\);/);
  });

  it("gives a name in wide characters the room it really draws in, cut between characters, ticket first", () => {
    // A mono font draws CJK and an emoji two cells wide: measure in cells.
    const measure = (t: string) => textColumns(t) * 7;
    const room = 20 * 7;
    const name = "feature/integration-team-shared-work/請求書ビルダーの改善と見直し";
    const got = fitBranch(name, t => measure(t) <= room);
    expect(got).toBe("請求書ビル…見直し");
    expect(measure(got)).toBeLessThanOrEqual(room);
    // One cell per character, from the whole name's average, took the whole
    // last segment: wider than the box.
    const cell = measure(name) / name.length;
    expect(measure(fitBranch(name, t => t.length * cell <= room))).toBeGreaterThan(room);
    // A ticket leads and stays whole, and no emoji is split at a cut.
    const ticketed = fitBranch("feature/VCRM-9090-修正🚀ログイン画面の表示崩れ", t => measure(t) <= room);
    expect(ticketed.startsWith("VCRM-9090")).toBe(true);
    expect(measure(ticketed)).toBeLessThanOrEqual(room);
    expect(ticketed).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
