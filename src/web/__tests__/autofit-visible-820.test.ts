// #820: any pan turned auto-fit off for good, and the only sign was a tint on a
// 14px crosshair. The flag was persisted ("so a refresh respects the user's
// preference"), so across every reload after it new sessions landed off-screen
// on a canvas that said nothing about why — on the owner's own deck, sessions
// sat off to one side of a mostly empty canvas.
//
// A pan is a decision about this look at the board, not a setting: the flag is
// no longer stored, the key older builds wrote is cleared, and while it is off
// the canvas shows the way back: one "Fit all" button.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AutoFitChip from "../components/AutoFitChip";
import { KitIcon } from "../components/kit-icons";
import { sheetText } from "./sheet-source";

const LANGS = ["en", "ro", "de", "fr", "es", "pt-BR", "ja", "ko", "zh-CN", "zh-TW"];

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const app = read("../App.tsx");
// The flag moved to use-auto-fit-switch.ts; the chip, the resume button and the
// gesture that turns it off stayed here. Where it is declared and whether it is
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

describe("the canvas offers Fit all while auto-fit is off (#820)", () => {
  // CHANGED ON PURPOSE: "Auto-fit off · Resume" named a mechanism. It is one
  // quiet button now, "Fit all" with the canvas controls' recenter glyph, that
  // does what Resume did: fit the board and turn auto-fit back on.
  const chipSrc = read("../components/AutoFitChip.tsx");
  const html = renderToStaticMarkup(createElement(AutoFitChip, { enableAutoFitAndRefit: () => {} }));

  it("is mounted only while auto-fit is off, and resumes it when pressed", () => {
    // Three links: App.tsx hands BoardFlow the switch, BoardFlow mounts the
    // button only while auto-fit is off, and the button is components/AutoFitChip.tsx.
    const board = read("../components/BoardFlow.tsx");
    expect(app).toMatch(/<BoardFlow\b[^>]*\bautoFit=\{autoFit\}/);
    expect(board).toMatch(/\{autoFitDisabled && <AutoFitChip enableAutoFitAndRefit=\{enableAutoFitAndRefit\} \/>\}/);
    expect(chipSrc).toMatch(/<button\s+type="button"\s+className="autofit-chip"\s+onClick=\{enableAutoFitAndRefit\}/);
  });

  it("is one button that says Fit all, with its hint, and no status words beside it", () => {
    expect(html).toMatch(/^<button type="button" class="autofit-chip" title="Fit every session on screen again"><svg[^>]*>[\s\S]*<\/svg>Fit all<\/button>$/);
    // Named by its word, so no aria-label of its own.
    expect(html).not.toContain("aria-label");
    expect(html).not.toMatch(/Auto-fit|Resume|autofit-state|autofit-resume/);
  });

  it("wears the same glyph the canvas controls fit and recenter with", () => {
    expect(chipSrc).toContain('<KitIcon name="recenter" />');
    expect(read("../components/CanvasControls.tsx")).toContain('<KitIcon name="recenter" />');
    expect(html).toContain(renderToStaticMarkup(createElement(KitIcon, { name: "recenter" })));
  });

  it("says Fit all in all ten languages, and the old words are gone", () => {
    for (const lang of LANGS) {
      const src = read(`../i18n/areas/accounts/${lang}.ts`);
      expect(src, lang).toMatch(/"accounts\.autoFit\.fitAll": "[^"]+"/);
      expect(src, lang).toMatch(/"accounts\.autoFit\.fitAllTip": "[^"]+"/);
      expect(src, lang).not.toMatch(/"accounts\.autoFit\.(off|offTip|resume|resumeTip|resumeLabel)"/);
      if (lang !== "en") expect(src, lang).not.toContain('"accounts.autoFit.fitAll": "Fit all"');
    }
    const en = read("../i18n/areas/accounts/en.ts");
    expect(en).toContain('"accounts.autoFit.fitAll": "Fit all"');
    expect(en).toContain('"accounts.autoFit.fitAllTip": "Fit every session on screen again"');
  });

  it("draws it on the canvas, clear of the corners, on the canvas chrome's surface", () => {
    const chip = /(?:^|\n)\.autofit-chip\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(chip).toMatch(/position:\s*absolute/);
    expect(chip).toMatch(/left:\s*0;/);
    expect(chip).toMatch(/right:\s*0;/);
    expect(chip).toMatch(/width:\s*max-content/);
    expect(chip).toMatch(/margin:\s*0 auto/);
    expect(chip).toMatch(/bottom:\s*14px/);
    // CHANGED ON PURPOSE (V4's Figma, Auto-fit chip): --panel with a --line-soft
    // edge in place of the chrome's translucent slab; the control radius stays;
    // still no pill and no shadow. CHANGED ON PURPOSE: the whole chip is the
    // button now, so it takes the pointer.
    expect(chip).toMatch(/background:\s*var\(--panel\)/);
    expect(chip).toMatch(/border:\s*1px solid var\(--line-soft\)/);
    expect(chip).toMatch(/border-radius:\s*var\(--r-ctl\)/);
    expect(chip).not.toMatch(/box-shadow|999px/);
    expect(chip).toMatch(/cursor:\s*pointer/);
  });

  it("is a 24px target, 32px under a fingertip", () => {
    const chip = /(?:^|\n)\.autofit-chip\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(chip).toMatch(/height:\s*24px/);
    expect(chip).toMatch(/box-sizing:\s*border-box/);
    expect(read("../styles/touch-and-forced-colours.css")).toMatch(/\.autofit-chip,\s*\.rearrange-undo-act \{ min-height: 32px; \}/);
  });

  it("centres by margins, and presses with scale, which the notices row leaves alone", () => {
    const chip = /(?:^|\n)\.autofit-chip\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(chip).not.toMatch(/transform:\s*translate/);
    // `.canvas-notices .autofit-chip` sets `transform: none` at the same weight,
    // later in the sheet, so a transform press would never show.
    expect(css).toMatch(/\.autofit-chip:active\s*\{\s*scale:\s*var\(--press\);\s*\}/); // --press is .97 (V4's motion rules)
    expect(chip).toMatch(/transition:[^;]*\bscale var\(--dur-fast\)/);
  });
});
