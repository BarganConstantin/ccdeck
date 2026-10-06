// Where keyboard focus goes in and around the git view. The view owns its
// keys only while focus is inside it, so every path that opens it from the
// keyboard, or moves the reader through it, has to leave focus inside — never
// on the canvas card behind it, where R would still re-arrange the board and
// drop every pin — and every way out has to land somewhere visible.
import { describe, expect, it } from "vitest";
import { sourceOf } from "./client-source";
import { sheetParts } from "./sheet-source";

const view = sourceOf("components/GitView.tsx");
const viewCss = sheetParts().find(([path]) => path === "styles/git-view.css")![1];

describe("a pane asked for focus before its rows are drawn", () => {
  it("can hold focus itself: each pane is focusable from script, not a Tab stop", () => {
    expect(view).toMatch(/aria-label="History" data-gv-pane="graph" tabIndex=\{-1\}/);
    expect(view).toMatch(/aria-label="Files" data-gv-pane="files" tabIndex=\{-1\}/);
    expect(view).toMatch(/aria-label="Diff" data-gv-pane="diff" tabIndex=\{-1\}/);
  });

  it("takes focus itself rather than falling back to a control that may be hidden", () => {
    const at = view.indexOf("const focusPane = useCallback(");
    const body = view.slice(at, view.indexOf("}, []);", at));
    // The old fallback was the panel's first button: the sheet-only Back
    // button, display: none beside the canvas, so focus stayed on the card.
    expect(body).not.toMatch(/button:not\(\[disabled\]\)/);
    expect(body).toMatch(/section\.focus\(\{ preventScroll: true \}\);\s*pendingPane\.current = p;/);
  });

  it("hands focus to the row once it is drawn, only while the pane still holds it", () => {
    expect(view).toMatch(/if \(document\.activeElement === panelRef\.current\?\.querySelector\(`\[data-gv-pane="\$\{p\}"\]`\)\) focusPane\(p\);\s*else pendingPane\.current = null;/);
  });

  it("draws the deck's ring inside a focused pane", () => {
    expect(viewCss).toMatch(/\.gv-wide \[data-gv-pane\]:focus-visible \{ outline-offset: -2px;/);
  });
});

describe("an edge marker activated", () => {
  it("hands focus to its agent's card once the frame has made it a Tab stop: the marker itself is gone", () => {
    expect(view).toMatch(/onGo=\{id => \{ focusAfterFrame\.current = id; onSelectAgent\(id\); \}\}/);
    // In the frame, after the cards under the panel were made inert or released.
    const at = view.indexOf("setInert(under, true, inertCards);");
    const after = view.slice(at, view.indexOf("}, [moveCamera]);", at));
    expect(after).toMatch(/if \(focusAfterFrame\.current === a\.id\) \{\s*focusAfterFrame\.current = null;\s*document\.querySelector<HTMLElement>\(`\.react-flow__node\[data-id="\$\{CSS\.escape\(a\.id\)\}"\]`\)\?\.focus\(\{ preventScroll: true \}\);/);
  });
});

describe("closing", () => {
  const at = view.indexOf("const lastSeq = useRef(request.seq);");
  const close = view.slice(at, view.indexOf("}, [request.seq]);", at));

  it("gives focus back a frame later, so the uncovered rail restyles in its frame, not in the key's handler", () => {
    expect(close).toMatch(/coverBehind\(false\);\s*if \(!inView\) return;/);
    expect(close).toMatch(/const raf = requestAnimationFrame\(\(\) => \{/);
    expect(close).toMatch(/return \(\) => cancelAnimationFrame\(raf\);/);
  });

  it("takes the opener only while it can be seen, else the selected card", () => {
    // A card's chip on a face zoomed out too far to draw it is visibility: hidden.
    expect(close).toMatch(/opener\.checkVisibility\(\{ visibilityProperty: true \}\)/);
    expect(close).toMatch(/if \(target !== card && document\.activeElement !== target\) card\?\.focus\(\{ preventScroll: true \}\);/);
  });
});

describe("a button pressed with Enter or Space", () => {
  // Nothing the keyboard sets off animates: a click with detail 0 opens and
  // closes the view at once, as g and Esc do.
  it("opens the view at once from the glance's Open, its rows and its more line", () => {
    const glance = sourceOf("components/GitGlance.tsx");
    expect(glance).toMatch(/openGitViewFrom\(pressHow\(e\), \{ agentId: agent\.id, focusInside: true, \.\.\.hints \}\)/);
    expect(glance).not.toMatch(/openGitViewFrom\("pointer"/);
    expect(glance.match(/onClick=\{e => open\(e/g)).toHaveLength(4);
  });

  it("closes the view at once from its Close and Back buttons, and from Show on canvas over a sheet", () => {
    expect(view).toMatch(/className="btn gv-back" aria-label="Back to the canvas" onClick=\{e => onClose\(pressHow\(e\)\)\}/);
    expect(view).toMatch(/aria-label="Close the git view" onClick=\{e => onClose\(pressHow\(e\)\)\}/);
    expect(view).toMatch(/if \(sheet\) onClose\(how\);/);
  });
});
