// The git view's history list, as the markup builds it: one stop in the tab
// order with nothing operable inside a row, the hover card's timing, a live
// commit that never moves a reader, colours kept in safe storage, and motion
// that has an answer under reduced motion — the wiring a plain-node suite
// cannot render to prove.
import { describe, expect, it } from "vitest";
import { sourceOf } from "./client-source";
import { sheetText } from "./sheet-source";

describe("the history list, as the markup builds it", () => {
  const src = sourceOf("components/GitGraph.tsx");
  const sheet = sheetText();
  /** The one row's own markup, from its component to the next one (the
   *  source is read with its comments gone, so code marks the ends). */
  const row = src.slice(src.indexOf("const HistoryRow = memo("), src.indexOf("function HoverCard("));

  it("is a listbox of options with one stop in the tab order, the selected row", () => {
    expect(row.length).toBeGreaterThan(2000);
    expect(src).toMatch(/role="listbox"/);
    expect(row.match(/role="option"/g)).toHaveLength(2); // the uncommitted row and a commit row
    expect(row.match(/tabIndex=\{p\.tabStop \? 0 : -1\}/g)).toHaveLength(2);
    expect(src).toMatch(/const tabStopId = ids\.includes\(selected\) \? selected : ids\[0\];/);
    expect(row).toMatch(/aria-selected=\{p\.selected\}/);
  });

  it("puts nothing operable inside a row: the chips and the SHA answer the pointer only", () => {
    expect(row).not.toMatch(/<button|<a |<input|href=/);
    expect(row.match(/tabIndex=/g)).toHaveLength(2);
    expect(row).not.toMatch(/onClick|onKeyDown/);
  });

  it("names each row in words and describes an agent's commit in the hover card's words", () => {
    expect(row).toMatch(/aria-label=\{label\}/);
    expect(row).toMatch(/aria-describedby=\{descId\}/);
    expect(row).toMatch(/<span id=\{descId\} className="vis-hidden">\{agentSentence\(agent\)\}<\/span>/);
    // The blindness named: seen, matched, from the message, or no agent seen.
    for (const words of ["seen by ccdeck", "matched after an amend or a rebase", "from the commit message", "No agent seen"]) expect(src, words).toContain(words);
    expect(src).not.toMatch(/by a human|made by you/i);
  });

  it("shows the hover card after 700ms, at once within 300ms of the last, and on keyboard focus", () => {
    expect(src).toMatch(/const HOVER_MS = 700;/);
    expect(src).toMatch(/const WARM_MS = 300;/);
    expect(src).toMatch(/row\.matches\(":focus-visible"\)/);
    expect(src).toMatch(/role="tooltip"/);
  });

  it("shows a row's card on keyboard focus only once the user moved it there, never on the focus the view places itself", () => {
    // A keyboard open lands focus on a row (a clean detached HEAD then
    // selects HEAD once the folder is read): no key was pressed inside the
    // view, so no card comes 700ms later. A key pressed inside it (Tab, an
    // arrow, Esc back from the files) is the user moving focus, for that task.
    const keyed = src.slice(src.indexOf("const keyed = useRef(false);"), src.indexOf("const onFocus = useCallback("));
    expect(keyed).toMatch(/const scope = listRef\.current\?\.closest\("\[data-key-scope\]"\);/);
    expect(keyed).toMatch(/if \(!scope \|\| !\(e\.target instanceof Node\) \|\| !scope\.contains\(e\.target\)\) return;/);
    expect(keyed).toMatch(/keyed\.current = true;\s*window\.setTimeout\(\(\) => \{ keyed\.current = false; \}, 0\);/);
    expect(keyed).toMatch(/document\.addEventListener\("keydown", onKey, true\);/);
    const onFocus = src.slice(src.indexOf("const onFocus = useCallback("), src.indexOf("const hoverCommit ="));
    expect(onFocus).toMatch(/if \(!visible \|\| !keyed\.current\) return;/);
  });

  it("shows a card a key brought at once, and takes it away on the first Esc without closing the view", () => {
    // Nothing the keyboard does animates: the focus path asks for the card instantly.
    expect(src).toMatch(/instant: byKey \|\| reducedMotion\(\)/);
    expect(src).toMatch(/showHoverSoon\(sha, hoverAnchor\(row\), true\);/);
    expect(src).toMatch(/const chip = row\.querySelector\("\.gv-agent-chip"\);\s*return chip && chip\.getClientRects\(\)\.length > 0 \? chip : row;/);
    // WCAG 1.4.13: dismissible without moving the pointer or the focus. The
    // listener runs before the view's own Esc (capture, on the window) and
    // only while a card is up.
    const esc = src.slice(src.indexOf("if (!hover) return;"), src.indexOf("}, [hover, hideHover]);"));
    expect(esc).toMatch(/!dismissesCard\(e\)/);
    expect(esc).toMatch(/e\.stopPropagation\(\);\s*hideHover\(\);/);
    expect(esc).toMatch(/window\.addEventListener\("keydown", onKey, true\)/);
  });

  it("keeps a scrolled reader where they are when commits arrive, and slides at most twenty rows at the top", () => {
    expect(src).toMatch(/const FLIP_MAX = 20;/);
    expect(src).toMatch(/if \(sc\.scrollTop > 0\) \{/);
    expect(src).toMatch(/const \{ scrollTop, above \} = keepReaderPlace\(before, tops, arrived, sc\.scrollTop\);/);
    expect(src).toMatch(/return \{ scrollTop: scrollTop \+ \(now - anchor\[1\]\), above:/);
    expect(src).toMatch(/if \(reducedMotion\(\)\) return;/);
    expect(src).toMatch(/duration: 200, easing: EASE/);
    expect(src).toMatch(/const EASE = "cubic-bezier\(0\.23, 1, 0\.32, 1\)";/);
    expect(sheet).toMatch(/\.gv-graph-scroll \{[^}]*overflow-anchor: none;/);
  });

  it("answers reduced motion in the sheet: the new row glows without fading in, the pill and card only fade", () => {
    const reduced = sheet.slice(sheet.indexOf("@media (prefers-reduced-motion: reduce) {\n  .gv-new-pill"));
    expect(reduced).toMatch(/\.gv-row\.is-new \{ animation: gv-glow 1000ms ease-out; \}/);
    expect(reduced).toMatch(/\.gv-new-pill \{ animation: gv-new-fade 150ms ease-out both; \}/);
    expect(reduced).toMatch(/\.gv-pop \{ transform: none; transition: opacity 120ms ease-out; \}/);
  });

  it("moves focus with a selection made outside the list when focus is on another of its rows", () => {
    const effect = src.slice(src.indexOf("const lastSelected = useRef(selected);"), src.indexOf("}, [selected, reveal, rowEl]);"));
    expect(effect).toMatch(/listRef\.current\?\.contains\(active\)/);
    expect(effect).toMatch(/if \(row && row\.dataset\.id !== selected\) rowEl\(selected\)\?\.focus\(\{ preventScroll: true \}\);/);
  });

  it("opens with the newest rows in sight when the row it opens on is on the first screen, and centres it only further down", () => {
    const reveal = src.slice(src.indexOf("const reveal = useCallback("), src.indexOf("reveal(selected, true)"));
    // The working tree and the commits above the agent's stay in view.
    expect(reveal).toMatch(/if \(center\) \{ sc\.scrollTop = top \+ h <= sc\.clientHeight \? 0 : top - sc\.clientHeight \/ 2 \+ h \/ 2; return; \}/);
    // A selection the view's opening makes after the history is drawn lands as it would have at the opening.
    const effect = src.slice(src.indexOf("const lastSelected = useRef(selected);"), src.indexOf("}, [selected, reveal, rowEl]);"));
    expect(effect).toMatch(/reveal\(selected, lastSelected\.current === ""\);/);
  });

  it("moves nothing from the keyboard: a key reveals its row at once", () => {
    expect(src).toMatch(/const reveal = useCallback\(/);
    const reveal = src.slice(src.indexOf("const reveal = useCallback("), src.indexOf("reveal(selected, true)"));
    expect(reveal.length).toBeGreaterThan(100);
    expect(reveal).not.toMatch(/smooth|animate/);
  });

  it("re-renders only the rows a change reached: an arrow key redraws two rows, not the history", () => {
    // The view hands in a new focus, uncommitted counts and HEAD object on
    // every render; a row is handed what they say, never the objects.
    expect(src).toMatch(/\[commits, focus\.sessionId, focusIds, agentName\]\);/);
    expect(src).not.toMatch(/\[commits, focus, agentName\]/);
    expect(src).toMatch(/uncommitted=\{c \? NO_UNCOMMITTED : uncommitted\}/);
    expect(src).toMatch(/const stableHead = useMemo\(\(\) => head, \[headWords\]\);/);
    expect(src).toMatch(/head=\{stableHead\}/);
    expect(src).toMatch(/const HistoryRow = memo\(function HistoryRow/);
  });

  it("remembers lane colours through the deck's safe storage helpers", () => {
    expect(src).toMatch(/import \{ readStored, writeStored \} from "\.\.\/storage";/);
    expect(src).not.toMatch(/localStorage/);
    expect(src).toMatch(/export const LANE_MEMORY_KEY = "agent-dag\.gitLaneSlots";/);
  });

  it("writes no colour of its own: every hue is a token the sheet owns", () => {
    expect(src).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(src).not.toMatch(/rgba?\(|hsl\(/);
  });

  it("draws one small SVG per row, its lanes in butt caps", () => {
    expect(src).toMatch(/<svg className="gv-lanes"/);
    expect(sheet).toMatch(/\.gv-e \{[^}]*stroke-linecap: butt;/);
  });
});
