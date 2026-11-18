// The integrations' host (#2178, #2179): the modal, its header, the split
// between a list and its detail, and how each of them moves. The modal had
// no exit, opened with a focus ring on the connection selector after a
// pointer open, and drew its header as a second banner landmark; Escape at a
// wide width closed the whole modal with a detail open; a phone's detail
// screen dropped focus to the page; at 900px the detail left the list about
// 400px. No jsdom here, so the sources and the sheet are the evidence, and
// the layout's arithmetic is called directly.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { autoList, clampList, LIST_WIDTH, listCss, listMost, readSplitWidth, SPLITTER } from "../integrations/layout";
import { SETTINGS_SECTIONS } from "../settings";
import { sheetText } from "./sheet-source";

const web = fileURLToPath(new URL("../", import.meta.url));
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const modal = strip(readFileSync(`${web}components/IntegrationModal.tsx`, "utf8"));
const split = strip(readFileSync(`${web}components/IntegrationSplit.tsx`, "utf8"));
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const host = readFileSync(`${web}styles/integrations.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (src: string, sel: string) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`).exec(src)?.[1] ?? "";
};
const keyframes = (name: string) => new RegExp(`@keyframes ${name}\\s*\\{([^{}]*\\{[^}]*\\})*[^}]*\\}`).exec(css)?.[0] ?? "";
const reduced = [...host.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)].map(m => m[1]).join("\n");

describe("the modal's frame", () => {
  it("draws its header as a plain block, since the dialog's label already names it", () => {
    expect(modal).toMatch(/<div className="ig-head">/);
    expect(modal).not.toMatch(/<header\b/);
  });

  it("starts the keyboard on the panel's first control, not on the connection selector", () => {
    expect(modal).toMatch(/useModalDismiss\(close, \{ focusRef: firstControl \}\)/);
    expect(modal).toMatch(/const body = bodyRef\.current;[\s\S]*?querySelectorAll<HTMLElement>\(TABBABLE_SELECTOR\)[\s\S]*?isTabbable\(/);
    expect(modal).toMatch(/<div ref=\{bodyRef\} className="ig-body">/);
  });
});

describe("the modal's exit", () => {
  it("puts focus back on its opener at once, and tells its owner at once", () => {
    const body = /const close = useCallback\(\(\) => \{([\s\S]*?)\}, \[/.exec(modal)?.[1] ?? "";
    const focus = body.indexOf(".focus({ preventScroll: true })");
    expect(focus).toBeGreaterThan(-1);
    expect(focus).toBeLessThan(body.indexOf("onCloseRef.current()"));
  });

  it("leaves through the shared dialog's exit, with no exit of its own", () => {
    expect(modal).not.toMatch(/setClosing|data-closing|onAnimationEnd|prefersReducedMotion|\.inert =/);
    expect(modal).not.toMatch(/setTimeout/);
    expect(host).not.toMatch(/data-closing|ig-modal-out/);
    expect(reduced).not.toMatch(/ig-modal/);
  });

  it("keeps the deck's own modal primitives as they were", () => {
    // V4's dialog motion: Base, now a transition (the popIn keyframe is gone)
    expect(rule(css, ".modal")).toMatch(/transition:\s*opacity var\(--dur-base\) var\(--ease\), transform var\(--dur-base\) var\(--ease\)/);
    expect(rule(css, ".modal")).not.toMatch(/animation:/);
    expect(host).not.toMatch(/(^|\})\s*\.modal\s*\{/);
    expect(host).not.toMatch(/(^|\})\s*\.modal-backdrop\s*\{/);
  });
});

describe("the split between a list and its detail", () => {
  it("lets Escape close the detail before the modal, at every width", () => {
    expect(split).toMatch(/useEffect\(\(\) => \{\s*if \(!open\) return;\s*return modalStack\.push\(\(\) => onBackRef\.current\(\), 0, "popover"\);\s*\}, \[open\]\);/);
    expect(split).not.toMatch(/["']Escape["']/);
  });

  it("gives focus to Back when a phone's detail opens with focus on the hidden list, on what it hid, or nowhere", () => {
    expect(split).toMatch(/const hidden = active instanceof HTMLElement && !\(active\.checkVisibility\?\.\(\) \?\? true\);/);
    expect(split).toMatch(/if \(drillIn && \(!active \|\| active === document\.body \|\| hidden \|\| listRef\.current\?\.contains\(active\)\)\) \{\s*backRef\.current\?\.focus\(/);
  });

  it("fades a new thing in beside the list and never animates a width", () => {
    expect(rule(host, '.ig-split:not([data-drill-in]) .ig-detail[data-flip="a"] > *')).toMatch(/animation:\s*ig-detail-in-a var\(--dur-fast\) var\(--ease\) both/);
    expect(rule(host, '.ig-split:not([data-drill-in]) .ig-detail[data-flip="b"] > *')).toMatch(/animation:\s*ig-detail-in-b var\(--dur-fast\) var\(--ease\) both/);
    for (const name of ["ig-detail-in-a", "ig-detail-in-b"]) expect(keyframes(name)).toMatch(/from\s*\{\s*opacity:\s*0;\s*\}/);
    const splitRules = [...host.matchAll(/([^{}]*\.ig-(?:split|detail|list|splitter)[^{}]*)\{([^}]*)\}/g)].map(m => m[2]);
    for (const body of splitRules) expect(body).not.toMatch(/transition[^;]*(width|grid-template|--ig-detail-w|all)/);
  });

  it("brings a phone's detail screen in from 8px over Base (200), and takes it out over the list on Fast (120)", () => {
    expect(rule(host, '.ig-split[data-drill-in] .ig-detail[data-flip="a"]')).toMatch(/animation:\s*ig-drill-in-a var\(--dur-base\) var\(--ease\) both/);
    expect(keyframes("ig-drill-in-a")).toMatch(/from\s*\{\s*opacity:\s*0;\s*transform:\s*translateX\(8px\);\s*\}/);
    const leaving = rule(host, ".ig-split[data-drill-in] .ig-detail[data-leaving]");
    expect(leaving).toMatch(/position:\s*absolute;\s*inset:\s*0/);
    expect(leaving).toMatch(/animation:\s*ig-drill-out var\(--dur-fast\)/);
    expect(keyframes("ig-drill-out")).toMatch(/to\s*\{\s*opacity:\s*0;\s*transform:\s*translateX\(8px\);\s*\}/);
    // The leaving screen is the same mounted detail, inert, never a second copy.
    expect(split).toMatch(/setLeaving\(!open && drillIn && !prefersReducedMotion\(\) \? lastDetail\.current : null\)/);
    expect(split).toMatch(/detailRef\.current\.inert = isLeaving/);
  });

  it("answers every one of those under reduced motion", () => {
    expect(reduced).toMatch(/\.ig-split:not\(\[data-drill-in\]\) \.ig-detail\[data-flip="b"\] > \*\s*\{\s*animation:\s*none/);
    expect(reduced).toMatch(/\.ig-split\[data-drill-in\] \.ig-detail\[data-flip="b"\]\s*\{\s*animation:\s*fadeIn var\(--dur-fast\) var\(--ease\)/);
    expect(reduced).toMatch(/\.ig-split\[data-drill-in\] \.ig-detail\[data-leaving\]\s*\{\s*animation:\s*ig-fade-out var\(--dur-fast\)/);
  });
});

// CHANGED ON PURPOSE: the divider measures the list now, not the detail. The
// list is held between 280px and 60 % of the workspace (it was the detail,
// between 320 and 1600 with the list at 420 or more), so a dialog the reader
// makes bigger or smaller keeps the list where it was and the detail takes
// the difference. Before any drag the list still takes what half the
// workspace for the detail leaves.
describe("the list's width before the reader drags it", () => {
  it("takes what half the workspace for the detail leaves", () => {
    expect(autoList(1726)).toBe(863);          // a 1920px window's default dialog, less its edges
    expect(autoList(1266)).toBe(633);          // 1440px
    expect(autoList(1000)).toBe(500);
  });

  it("keeps the list at 280px or more and at 60% or less", () => {
    expect(autoList(400)).toBe(LIST_WIDTH.min);
    expect(autoList(4000, 0.2)).toBe(listMost(4000));
    expect(listMost(4000)).toBe(2400);
    // A dragged width is held to the same bounds.
    expect(clampList(200, 1726)).toBe(LIST_WIDTH.min);
    expect(clampList(1500, 1726)).toBe(Math.floor(1726 * 0.6));
    expect(clampList(600, 1726)).toBe(600);
    expect(SPLITTER).toBe(1);
  });

  it("is the same rule in the sheet, and nothing is stored until the reader drags", () => {
    expect(listCss(null)).toBe("clamp(280px, 50%, 60%)");
    expect(readSplitWidth("no-such-panel")).toBeNull();
    expect(split).toMatch(/"--ig-list-w": splitCss\(width, automaticDetailShare\)/);
    expect(host).toMatch(/\.ig-split\[data-detail\]:not\(\[data-drill-in\]\)\s*\{[^}]*grid-template-columns:\s*var\(--ig-list-w\) 1px minmax\(0, 1fr\)/);
    // Enter and a double click on the splitter go back to it.
    expect(split).toMatch(/if \(event\.key === "Enter"\) \{ event\.preventDefault\(\); commit\(null\); return; \}/);
    expect(split).toMatch(/onDoubleClick=\{\(\) => commit\(null\)\}/);
  });
});

describe("Settings › Integrations", () => {
  it("introduces the development tools section", () => {
    const note = SETTINGS_SECTIONS.find(s => s.id === "integrations")?.note ?? "";
    // CHANGED ON PURPOSE (V4's Figma): the page head says V4's line.
    expect(note).toBe("Connect your project tools. Tokens stay on this machine.");
  });
});
