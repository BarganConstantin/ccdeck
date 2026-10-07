// The lane under a card, as the card draws it: under the card, in its node and
// outside its box, one row a commit with its subject, who made it and its age,
// a fold for what does not fit, nothing while Settings › Git is off or at a
// distance; the motion when a commit lands and its reduced-motion answer.
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import AgentNode from "../components/AgentNode";
import { nodeDataFor } from "../canvas-flow";
import { BAND_FOLD_H, BAND_ROW_H, BAND_TOP, bandRoomFor } from "../git-commit-band";
import { loadGitPrefs } from "../git-pref";
import type { GraphState } from "../reducer";
import { sourceOf } from "./client-source";
import { sheetText } from "./sheet-source";
import { API, MIN, NOW, board, commit } from "./git-commit-band-fixture";

/** A card as the canvas draws it, from the canvas's own node data. */
function card(s: GraphState, id: string): string {
  const data = nodeDataFor(s, () => {})(s.agents.get(id)!);
  return renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(AgentNode as never, { id, data, selected: false })));
}
/** How many `<div>`s are open at `at` in `html`. */
const depthAt = (html: string, at: number) =>
  (html.slice(0, at).match(/<div\b/g)?.length ?? 0) - (html.slice(0, at).match(/<\/div>/g)?.length ?? 0);

afterEach(() => { loadGitPrefs({ prefs: { git: true } }); });

describe("the lane on the card", () => {
  it("is drawn under the card, in its node and outside its box, one row a commit", () => {
    const html = card(board([commit(1, 2 * MIN), commit(2, 14 * MIN, { agentId: "tw1", label: "test-writer" })]), API);
    const at = html.indexOf('<div class="git-band"');
    expect(at).toBeGreaterThan(html.indexOf('class="lod-face"'));
    expect(depthAt(html, at)).toBe(0); // a sibling of the card, not a row inside it
    expect(html.startsWith('<div class="agent-node')).toBe(true);
    const rows = [...html.matchAll(/<li class="git-band-row"[\s\S]*?<\/li>/g)].map(m => m[0]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('data-slot="4"');
    expect(rows[0]).toContain(">feat(auth): change 1<");
    expect(rows[0]).toContain('class="git-band-age">2m<');
    expect(rows[0]).toMatch(/title="feat\(auth\): change 1\naaa[0-9a-f]{4} · seen by ccdeck · 2m ago"/);
    expect(rows[1]).toContain('class="git-band-who">↳ test-writer<');
    expect(rows[1]).toContain("by test-writer, 14 minutes ago, commit");
    // One tab stop: the newest row.
    expect(rows[0]).toContain('tabindex="0"');
    expect(rows[1]).toContain('tabindex="-1"');
    expect(html).not.toContain("git-band-fold");
  });

  it("folds what does not fit into one line that opens the git view", () => {
    const html = card(board(Array.from({ length: 7 }, (_, i) => commit(i + 1, (i + 1) * MIN))), API);
    expect([...html.matchAll(/<li class="git-band-row"/g)]).toHaveLength(5);
    expect(html).toMatch(/<button type="button" class="git-band-fold nodrag"[^>]*aria-label="2 earlier commits\. Open the git view"/);
    expect(html).toContain("+2 earlier");
  });

  it("is not there with no commits, nor while Settings › Git is off", () => {
    expect(card(board(), API)).not.toContain("git-band");
    loadGitPrefs({ prefs: { git: false } });
    expect(card(board([commit(1, MIN)]), API)).not.toContain("git-band");
    expect(bandRoomFor(board([commit(1, MIN)]).agents, board([commit(1, MIN)]).agents.get(API)!, NOW, false)).toBe(0);
  });

  it("is hidden on the zoomed-out faces, keeping its room so zooming never reflows the board", () => {
    expect(sheetText()).toMatch(/\.canvas-wrap\[data-lod="compact"\] \.git-band,\s*\.canvas-wrap\[data-lod="overview"\] \.git-band \{ visibility: hidden; \}/);
  });

  it("draws each branch in the colour of its lane slot", () => {
    const css = sheetText();
    for (let n = 1; n <= 5; n++) expect(css).toContain(`.git-band [data-slot="${n}"] { --lane: var(--gv-lane-${n}); }`);
  });

  it("is as tall as the layout reckons it", () => {
    const css = sheetText();
    expect(css).toMatch(new RegExp(`\\.git-band \\{[^}]*padding-top: ${BAND_TOP}px;`));
    expect(css).toMatch(new RegExp(`\\.git-band-row \\{ position: relative; height: ${BAND_ROW_H}px; \\}`));
    expect(css).toMatch(new RegExp(`\\.git-band-commit,\\s*\\.git-band-fold \\{[^}]*height: ${BAND_FOLD_H}px;`));
    // The line reaches up across that gap to the card's edge.
    expect(css).toContain(`.git-band-row:first-child::before { top: -${BAND_TOP}px; }`);
  });
});

describe("motion", () => {
  const css = sheetText();
  const band = sourceOf("components/CommitBand.tsx");

  it("slides a landing row in from the top, grows its diamond, glows the newest once, and fades the lane out", () => {
    expect(css).toContain(".git-band-row[data-landed] { animation: git-band-row-in 200ms cubic-bezier(0.23, 1, 0.32, 1) both; }");
    expect(css).toMatch(/@keyframes git-band-row-in \{ from \{ opacity: 0; transform: translateY\(-8px\); \} \}/);
    expect(css).toMatch(/\.git-band-row\[data-glow\] \.git-band-dot \{\s*animation: git-band-dot-in 200ms cubic-bezier\(0\.23, 1, 0\.32, 1\) both, git-band-glow 1000ms ease-out;/);
    expect(css).toMatch(/\.git-band\[data-leaving\] \{ pointer-events: none; animation: git-band-out 150ms cubic-bezier\(0\.23, 1, 0\.32, 1\) forwards; \}/);
    // The rows under it move down a row, on the house curve.
    expect(band).toMatch(/\.animate\(\[\{ transform: `translateY\(\$\{\(was - i\) \* BAND_ROW_H\}px\)` \}, \{ transform: "translateY\(0\)" \}\], \{ duration: 200, easing: EASE \}\)/);
    expect(band).toContain('const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";');
    // Hover is colour alone, and quick.
    expect(css).toMatch(/\.git-band-commit,\s*\.git-band-fold \{[^}]*transition: color 120ms ease;/);
  });

  it("answers reduced motion with fades only", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .git-band-row[data-landed]"));
    expect(reduced).toMatch(/^@media \(prefers-reduced-motion: reduce\) \{\n  \.git-band-row\[data-landed\] \{ animation: git-band-fade 150ms ease-out both; \}\n  \.git-band-row\[data-landed\] \.git-band-dot \{ animation: none; \}\n  \.git-band-row\[data-glow\] \.git-band-dot \{ animation: git-band-glow 1000ms ease-out; \}/);
    expect(css).toMatch(/@keyframes git-band-fade \{ from \{ opacity: 0; \} \}/);
    expect(css).toMatch(/@keyframes git-band-glow \{\s*0%, 25% \{ box-shadow:[^}]*\}\s*100% \{ box-shadow:[^}]*\}\s*\}/);
    // The FLIP is not run at all.
    expect(band).toMatch(/if \(!el \|\| reducedMotion\(\)\) return;/);
    expect(band).toContain('window.matchMedia?.("(prefers-reduced-motion: reduce)").matches');
  });

  it("animates only what landed, never what was there when the card was drawn, nor a key press", () => {
    expect(band).toMatch(/if \(drawn\.current == null\) \{\s*if \(rows\.length\) drawn\.current = new Set\(rows\.map\(r => r\.sha\)\);/);
    expect(band).toMatch(/if \(Date\.now\(\) - r\.at < LANDING_MS\) landed\.current\.set\(r\.sha, Date\.now\(\)\);/);
    const keys = band.slice(band.indexOf("const onKeyDown"), band.indexOf("const earlier"));
    expect(keys).not.toMatch(/animate|data-landed/);
    expect(keys).toContain("stops[to].focus({ preventScroll: true });");
  });
});

describe("opening the git view from the lane", () => {
  it("names the commit a row stands for, and the fold opens it on the agent", () => {
    const band = sourceOf("components/CommitBand.tsx");
    expect(band).toContain("openGitFor(agentId, pressHow(e), sel ? { sel } : undefined);");
    expect(band).toMatch(/className="git-band-fold nodrag"[\s\S]*?openGitFor\(agentId, pressHow\(e\)\);/);
  });
});
