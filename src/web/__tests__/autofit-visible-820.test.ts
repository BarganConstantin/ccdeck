// #820: any pan turned auto-fit off for good, and the only sign was a tint on a
// 14px crosshair. The flag was persisted ("so a refresh respects the user's
// preference"), so across every reload after it new sessions landed off-screen
// on a canvas that said nothing about why — on the owner's own deck, sessions
// sat off to one side of a mostly empty canvas.
//
// A pan is a decision about this look at the board, not a setting: the flag is
// no longer stored, the key older builds wrote is cleared, and while it is off
// the canvas shows "Auto-fit off · Resume" with the way back in the same pill.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const app = read("../App.tsx");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

describe("auto-fit off is a moment, not a setting (#820)", () => {
  it("starts every load fitting, whatever an older build stored", () => {
    expect(app).toMatch(/const autoFitDisabledRef = useRef\(false\);/);
    expect(app).toMatch(/const \[autoFitDisabled, setAutoFitDisabled\] = useState\(false\);/);
    expect(app).not.toMatch(/getItem\(AUTOFIT_KEY\)/);
  });

  it("does not store a pan, and clears the key older builds wrote", () => {
    expect(app).not.toMatch(/setItem\(AUTOFIT_KEY/);
    expect(app).toMatch(/useEffect\(\(\) => \{ try \{ window\.localStorage\.removeItem\(AUTOFIT_KEY\); \} catch \{\} \}, \[\]\);/);
  });

  it("still turns off on the reader's own pan or zoom", () => {
    expect(app).toMatch(/if \(isUserViewportGesture\(viewportMove\(e\)\)\) disableAutoFit\(\);/);
  });
});

describe("the canvas says when auto-fit is off (#820)", () => {
  it("shows the chip while it is off, and resumes from it", () => {
    expect(app).toMatch(/\{autoFitDisabled && \(\s*<button\s+type="button"\s+className="autofit-chip"\s+onClick=\{enableAutoFitAndRefit\}/);
    expect(app).toMatch(/Auto-fit off <span aria-hidden>·<\/span> <b>Resume<\/b>/);
  });

  it("draws it on the canvas, clear of the corners, as a solid slab", () => {
    const chip = /(?:^|\n)\.autofit-chip\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(chip).toMatch(/position:\s*absolute/);
    expect(chip).toMatch(/left:\s*0;/);
    expect(chip).toMatch(/right:\s*0;/);
    expect(chip).toMatch(/width:\s*max-content/);
    expect(chip).toMatch(/margin:\s*0 auto/);
    expect(chip).toMatch(/bottom:\s*14px/);
    expect(chip).toMatch(/background:\s*var\(--panel\)/);
  });

  it("centres by margins, so the press is the only transform it takes", () => {
    const chip = /(?:^|\n)\.autofit-chip\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(chip).not.toMatch(/transform:\s*translate/);
    expect(css).toMatch(/\.autofit-chip:active\s*\{\s*transform:\s*scale\(0\.97\);\s*\}/);
  });
});
