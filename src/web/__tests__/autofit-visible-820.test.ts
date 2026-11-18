// #820: any pan turned auto-fit off for good, and the only sign was a tint on a
// 14px crosshair. The flag was persisted ("so a refresh respects the user's
// preference"), so across every reload after it new sessions landed off-screen
// on a canvas that said nothing about why — on the owner's own deck, sessions
// sat off to one side of a mostly empty canvas.
//
// A pan is a decision about this look at the board, not a setting: the flag is
// no longer stored, the key older builds wrote is cleared, and while it is off
// the canvas shows the way back: the control bar's recenter, marked with a dot.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const app = read("../App.tsx");
// The flag moved to use-auto-fit-switch.ts; the resume button and the gesture
// that turns it off stayed here. Where it is declared and whether it is
// stored are asked of both files, the negatives included.
const autofit = app + "\n" + read("../use-auto-fit-switch.ts");
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

describe("auto-fit off is a moment, not a setting (#820)", () => {
  it("starts every load fitting, whatever an older build stored", () => {
    expect(autofit).toMatch(/const autoFitDisabledRef = useRef\(false\);/);
    expect(autofit).toMatch(/const \[autoFitDisabled, setAutoFitDisabled\] = useState\(false\);/);
    expect(autofit).not.toMatch(/(?:getItem|readStored)\(AUTOFIT_KEY\)/);
  });

  it("does not store a pan, and clears the key older builds wrote", () => {
    expect(autofit).not.toMatch(/(?:setItem|writeStored)\(AUTOFIT_KEY/);
    expect(autofit).toMatch(/useEffect\(\(\) => \{ removeStored\(AUTOFIT_KEY\); \}, \[\]\);/);
  });

  it("still turns off on the reader's own pan or zoom", () => {
    // The move handlers are use-canvas-viewport.ts's.
    expect(read("../use-canvas-viewport.ts")).toMatch(/if \(isUserViewportGesture\(viewportMove\(e\)\)\) disableAutoFit\(\);/);
  });
});

// CHANGED ON PURPOSE (V4 top-10 #3): a "Fit all" chip on the canvas while
// auto-fit was off → none; the control bar's recenter is the one fit control,
// because the two did the very same thing (both pressed enableAutoFitAndRefit:
// fit the board and turn auto-fit back on) and two fit controls made the
// reader guess the difference (#840 removed React Flow's third for the same
// reason). Recenter carries the state the chip said in words: a dot while
// auto-fit is off, and a title that says the press turns it back on.
describe("recenter is the way back while auto-fit is off (#820)", () => {
  const board = read("../components/BoardFlow.tsx");
  const controls = read("../components/CanvasControls.tsx");

  it("hands recenter the switch, and mounts no second fit control on the canvas", () => {
    expect(app).toMatch(/<BoardFlow\b[^>]*\bautoFit=\{autoFit\}/);
    expect(board).toContain("autoFitDisabled={autoFitDisabled} enableAutoFitAndRefit={enableAutoFitAndRefit}");
    expect(board).not.toMatch(/<AutoFitChip\b|import AutoFitChip/);
    expect(css).not.toMatch(/\.autofit-chip\b/);
  });

  it("fits and turns auto-fit back on when pressed, and says so in its title", () => {
    expect(controls).toMatch(/<ControlButton\s+onClick=\{enableAutoFitAndRefit\}\s+title=\{autoFitDisabled\s+\? t\("board\.controls\.recenterOn"\)\s+: t\("board\.controls\.recenterAuto"\)\}/);
    expect(read("../i18n/areas/board/en.ts")).toContain('"board.controls.recenterOn": "Recenter view + re-enable autofit"');
    expect(read("../use-auto-fit-switch.ts")).toMatch(/const enableAutoFitAndRefit = useCallback\(\(\) => \{\s*autoFitDisabledRef\.current = false;\s*setAutoFitDisabled\(false\);\s*fitLeft\(\);/);
  });

  it("wears a dot in its own ink while auto-fit is off, and only then", () => {
    expect(controls).toContain('data-nudge={autoFitDisabled ? "" : undefined}');
    const nudge = /\.react-flow__controls-button\[data-nudge\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(nudge).toMatch(/color:\s*var\(--text\)/);
    expect(nudge).toMatch(/position:\s*relative/);
    const dot = /\.react-flow__controls-button\[data-nudge\]::before\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(dot).toMatch(/content:\s*""/);
    expect(dot).toMatch(/width:\s*4px/);
    expect(dot).toMatch(/height:\s*4px/);
    // Round from the pill token, not a literal (radius-scale.test.ts).
    expect(dot).toMatch(/border-radius:\s*var\(--r-pill\)/);
    // Not a state colour and not the accent: the glyph's own ink.
    expect(dot).toMatch(/background:\s*currentColor/);
    // The dot is drawn from the attribute alone, never at rest.
    expect(css).not.toMatch(/\.react-flow__controls-button::before/);
  });
});
