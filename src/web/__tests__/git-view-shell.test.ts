// The git view's container, held where a canvas cannot be rendered: the
// wiring that opens and closes it, what it makes inert while it is open, the
// dividers' keyboard contract, and the colours its canvas marker may wear.
import { describe, expect, it } from "vitest";
import { sourceOf } from "./client-source";
import { sheetParts, sheetText } from "./sheet-source";

const view = sourceOf("components/GitView.tsx");
const app = sourceOf("App.tsx");
const css = sheetText();
/** A rule of the view's own part of the sheet. */
const own = sheetParts().find(([path]) => path === "styles/git-view.css")![1];
const rule = (sel: string) => {
  const at = own.indexOf(`${sel} {`);
  expect(at, sel).toBeGreaterThan(-1);
  return own.slice(at, own.indexOf("}", at));
};

describe("opening and closing", () => {
  it("opens from the card's chip, from g and from the glance, through one request", () => {
    expect(app).toMatch(/useGitOpener\(\{ selectAgent, openGitView: openGitViewFromChip \}\)/);
    expect(app).toMatch(/openGitViewRequest\(how, opts\)/);
    expect(sourceOf("use-deck-shortcuts.ts")).toMatch(/if \(e\.key === "g" \|\| e\.key === "G"\) toggleGitView\(\);/);
  });

  it("opens nothing on a folder git cannot read, and tells the glance to answer", () => {
    expect(app).toMatch(/if \(!gitViewOpens\(gitFactsFor\(agent, stateRef\.current\.agents\.get\(agent\.sessionId\)\)\) \|\| \(cached != null && UNREADABLE\.has\(cached\)\)\) \{\s*window\.dispatchEvent\(new CustomEvent\("gitview:unreadable"/);
  });

  it("closes when Settings switches git off, and when nothing is selected", () => {
    expect(app).toMatch(/useEffect\(\(\) => \{ if \(!gitOn\) closeGitView\("key"\); \}, \[gitOn, closeGitView\]\);/);
    expect(app).toMatch(/useEffect\(\(\) => \{ if \(!primarySelectedId\) closeGitView\("pointer"\); \}/);
  });

  it("is a named region that owns its keys, mounted outside the app's grid", () => {
    expect(view).toMatch(/className="gv-wide"\s+aria-label="Git view"\s+data-key-scope="git"/);
    expect(view).toMatch(/<\/section>, document\.body\)\}/);
  });
});

describe("what it covers while open", () => {
  it("makes the detail rail inert, and the whole deck beside the canvas when it is a sheet", () => {
    expect(view).toMatch(/"\.app > :is\(main, \.detail, \.session-list, \.accounts-panel, \.usage-panel, \.sysdetail\)"\s*:\s*"\.app > \.detail"/);
  });

  it("takes a card wholly under the panel, or wholly off the canvas it leaves, out of the Tab order", () => {
    // The canvas the panel leaves: the canvas's own box, less the panel over its right.
    expect(view).toMatch(/const sight: PaneBox = \{ left: rect\.left, right: Math\.min\(rect\.right, window\.innerWidth - w\), top: rect\.top, bottom: rect\.bottom \};/);
    expect(view).toMatch(/const card: PaneBox = \{ left, right: left \+ \(m\?\.width \?\? 0\) \* zoom, top, bottom: top \+ \(m\?\.height \?\? 0\) \* zoom \};\s*\(outOfSight\(card, sight\) \? under : clear\)\.add\(el\);/);
    // A session's name tag by the same rule, where the frame's camera puts it.
    expect(view).toMatch(/const covered = outOfSight\(\{ left, right: left \+ r\.width, top: rect\.top \+ tagTop, bottom: rect\.top \+ tagTop \+ r\.height \}, sight\);/);
  });

  it("asks again where a pan or a zoom leaves the camera, once it has stopped, and lets the frame's own move land first", () => {
    // The effect that holds the subscription, from its guard to its deps.
    const at = view.lastIndexOf("if (!want || sheet) return;", view.indexOf("store.subscribe("));
    const effect = view.slice(at, view.indexOf("}, [want, sheet]);", at));
    expect(at).toBeGreaterThan(-1);
    expect(effect).toMatch(/if \(!want \|\| sheet\) return;/);
    expect(effect).toMatch(/store\.subscribe\(\(s, prev\) => \{\s*if \(s\.transform === prev\.transform\) return;/);
    expect(effect).toMatch(/const wait = framedUntil\.current - performance\.now\(\);\s*if \(wait > 0\) \{ timer = window\.setTimeout\(settle, wait\); return; \}/);
    expect(effect).toMatch(/const now = rf\.getViewport\(\);\s*takeOutOfSight\(now, now\);/);
    expect(effect).toMatch(/return \(\) => \{ unsubscribe\(\); window\.clearTimeout\(timer\); \};/);
    // The frame says how long its own move takes to land.
    expect(view).toMatch(/moveCamera\(plan\.viewport, duration\);\s*framedUntil\.current = performance\.now\(\) \+ duration \+ SETTLE_MS;/);
  });

  it("gives every card it took back when it closes", () => {
    expect(view).toMatch(/coverBehind\(false\);\s*setInert\(\[\.\.\.inertCards\], false, inertCards\);/);
  });

  it("hides what it covers whole, marked on the root rather than found by :has()", () => {
    expect(css).toMatch(/:root\[data-git-view\] \.app > \.detail,/);
    expect(css).toMatch(/:root\[data-git-view="sheet"\] \.app > main \{ visibility: hidden; \}/);
    expect(own.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/:has\(/);
  });

  it("is a full sheet with a way back to the canvas below 1100px", () => {
    expect(rule(".gv-wide[data-sheet]")).toMatch(/width: 100%/);
    expect(css).toMatch(/\.gv-wide\[data-sheet\] \.gv-head \.btn\.gv-back \{ display: inline-flex; \}/);
    expect(view).toMatch(/aria-label="Back to the canvas"/);
  });
});

describe("the panes on a short window", () => {
  it("never run past the panel's foot: the history gives way to its floor, the files and diff take the rest", () => {
    // A laptop at 200% zoom is 640x400 CSS px: the history's 42% and a 220px
    // floor below it overflowed the panel, and the last rows could not be reached.
    expect(rule(".gv-graph")).toMatch(/flex: 0 1 var\(--gv-graph-h, 42%\); min-height: 120px;/);
    expect(rule(".gv-bottom")).toMatch(/min-height: min\(220px, calc\(100% - 129px\)\);/);
  });
});

describe("the dividers (WAI-ARIA window splitter)", () => {
  it("are focusable separators with a value, a range and what they control", () => {
    expect(view).toMatch(/role="separator" tabIndex=\{0\} aria-orientation=\{orientation\} aria-label=\{label\}/);
    expect(view).toMatch(/aria-controls=\{controls\} aria-valuemin=\{pct\(b\.min\)\} aria-valuemax=\{pct\(b\.max\)\} aria-valuenow=\{pct\(now\)\}/);
  });

  it("drag once a frame and re-fit the canvas once, when the pointer comes up", () => {
    expect(view).toMatch(/const move = \(ev: PointerEvent\) => \{ last = ev; if \(!raf\) raf = requestAnimationFrame\(apply\); \};/);
    expect(view).toMatch(/if \(kind === "edge"\) requestAnimationFrame\(onResized\);/);
  });

  it("reset on a double click", () => {
    expect(view).toMatch(/onDoubleClick=\{onSplitterDouble\(kind\)\}/);
  });
});

describe("the marker for an agent the camera could not keep in view", () => {
  it("wears amber for waiting and the error colour for failed, with words", () => {
    expect(rule(".gv-edge-mark")).toMatch(/color: var\(--warn\)/);
    expect(rule('.gv-edge-mark[data-alarm="failed"]')).toMatch(/color: var\(--err\)/);
    expect(view).toMatch(/`waiting \$\{elapsed\(m\.since, undefined, now\)\}` : "failed"/);
  });

  it("never hides one under another: past the rows the edge has, the last one counts the rest", () => {
    expect(view).toMatch(/const \{ kept, folded \} = foldMarkers\(out, markerRoom\(rect\.height\)\);/);
    expect(view).toMatch(/const stacked = stackMarkers\(column\.map\(m => m\.top\), rect\.height\);/);
    expect(view).toMatch(/<b>\+\{waiting \+ failed\} more<\/b>/);
  });

  it("writes no colour literal in the view's markup", () => {
    expect(view).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![\w-])/);
  });
});

describe("under forced colours", () => {
  const order = sheetParts().map(([path]) => path);
  it("answers after every git sheet, so its marks win where they are spelled as the rules they answer", () => {
    const forced = order.indexOf("styles/touch-and-forced-colours.css");
    const git = order.filter(path => path.startsWith("styles/git-"));
    expect(git.length).toBeGreaterThan(4);
    for (const path of git) expect(order.indexOf(path), path).toBeLessThan(forced);
  });

  it("spells the diff's changed-word mark as the diff's own rule does", () => {
    const sheet = sheetParts().find(([path]) => path === "styles/touch-and-forced-colours.css")![1];
    expect(sheet).toMatch(/\.gvd-line\[data-kind="add"\] \.gvd-word,\s*\.gvd-line\[data-kind="del"\] \.gvd-word \{ forced-color-adjust: none; background: Mark; color: MarkText; \}/);
  });
});

describe("the motion lives in the sheet, on the house curve", () => {
  it("slides in over 200ms and out over 150ms on cubic-bezier(0.23, 1, 0.32, 1)", () => {
    expect(rule(".gv-wide")).toMatch(/transition:\s*transform 200ms var\(--gv-ease\)/);
    expect(rule('.gv-wide[data-phase="closing"]')).toMatch(/transition-duration:\s*150ms/);
    expect(css).toMatch(/--gv-ease:\s*cubic-bezier\(0\.23,\s*1,\s*0\.32,\s*1\)/);
  });

  it("moves nothing when the keyboard opened or closed it", () => {
    expect(rule('.gv-wide[data-motion="instant"]')).toMatch(/transition:\s*none/);
  });

  it("fades instead of sliding under reduced motion", () => {
    const reduced = own.slice(own.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.gv-wide\s*\{[^}]*transition:\s*opacity 150ms/);
  });

});

describe("the Git section in the detail panel", () => {
  it("keeps one height while its read arrives, so the panel under it never jumps", () => {
    expect(rule(".gv-glance[data-reserve]")).toMatch(/min-height: \d+px/);
    expect(css).toMatch(/\.gv-glance\[data-reserve\] > \.gv-handoffs-wrap:not\(\[data-compact\]\) \{ margin-top: auto;/);
    const glance = sourceOf("components/GitGlance.tsx");
    // A folder with no repository is one line and reserves nothing.
    expect(glance).toMatch(/return section\(<ReadStateLine [^\n]*\/>\);/);
    expect(glance).toMatch(/<\/>,\s*true,\s*\);/);
  });

  it("never says an ended session ended \"now ago\"", () => {
    expect(sourceOf("components/GitGlance.tsx")).toMatch(/=== "now" \? "just now" :/);
  });
});
