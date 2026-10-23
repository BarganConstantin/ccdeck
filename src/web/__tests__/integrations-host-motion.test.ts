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
import { AUTO_DETAIL_CSS, autoDetail, clampDetail, DETAIL_WIDTH, LIST_MIN, readDetailWidth, SPLITTER } from "../integrations/layout";
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
  it("puts focus back on its opener at once, before it leaves", () => {
    const body = /const close = useCallback\(\(\) => \{([\s\S]*?)\}, \[/.exec(modal)?.[1] ?? "";
    const focus = body.indexOf(".focus({ preventScroll: true })");
    expect(focus).toBeGreaterThan(-1);
    expect(focus).toBeLessThan(body.indexOf("setClosing(true)"));
    // Reduced motion: no exit at all.
    expect(body).toMatch(/if \(prefersReducedMotion\(\)\) finish\(\);\s*else setClosing\(true\);/);
  });

  it("is unmounted when its own animation ends, or after 200ms if that never comes", () => {
    expect(modal).toMatch(/onAnimationEnd=\{event => \{ if \(closing && event\.target === event\.currentTarget\) finish\(\); \}\}/);
    expect(modal).toMatch(/window\.setTimeout\(finish, 200\)/);
    expect(modal).toMatch(/dialogRef\.current\.inert = closing/);
  });

  it("leaves in 120ms, to transparent and 2px down, with the scrim, and only fades under reduced motion", () => {
    expect(rule(host, ".modal.ig-modal[data-closing]")).toMatch(/animation:\s*ig-modal-out 120ms cubic-bezier\(0\.23, 1, 0\.32, 1\) both/);
    expect(keyframes("ig-modal-out")).toMatch(/to\s*\{\s*opacity:\s*0;\s*transform:\s*translateY\(2px\);\s*\}/);
    expect(rule(host, ".modal-backdrop:has(> .ig-modal[data-closing])")).toMatch(/pointer-events:\s*none;\s*animation:\s*ig-fade-out 120ms/);
    expect(reduced).toMatch(/\.modal\.ig-modal\[data-closing\]\s*\{\s*animation:\s*ig-fade-out 120ms/);
  });

  it("keeps the deck's own modal primitives as they were", () => {
    expect(rule(css, ".modal")).toMatch(/animation:\s*popIn 180ms/);
    expect(host).not.toMatch(/(^|\})\s*\.modal\s*\{/);
    expect(host).not.toMatch(/(^|\})\s*\.modal-backdrop\s*\{/);
  });
});

describe("the split between a list and its detail", () => {
  it("lets Escape close the detail before the modal, at every width", () => {
    expect(split).toMatch(/useEffect\(\(\) => \{\s*if \(!open\) return;\s*return modalStack\.push\(\(\) => onBackRef\.current\(\), 0, "popover"\);\s*\}, \[open\]\);/);
    expect(split).not.toMatch(/["']Escape["']/);
  });

  it("gives focus to Back when a phone's detail opens with focus on the hidden list or nowhere", () => {
    expect(split).toMatch(/if \(drillIn && \(!active \|\| active === document\.body \|\| listRef\.current\?\.contains\(active\)\)\) \{\s*backRef\.current\?\.focus\(/);
  });

  it("fades a new thing in beside the list and never animates a width", () => {
    expect(rule(host, '.ig-split:not([data-drill-in]) .ig-detail[data-flip="a"] > *')).toMatch(/animation:\s*ig-detail-in-a 120ms ease-out both/);
    expect(rule(host, '.ig-split:not([data-drill-in]) .ig-detail[data-flip="b"] > *')).toMatch(/animation:\s*ig-detail-in-b 120ms ease-out both/);
    for (const name of ["ig-detail-in-a", "ig-detail-in-b"]) expect(keyframes(name)).toMatch(/from\s*\{\s*opacity:\s*0;\s*\}/);
    const splitRules = [...host.matchAll(/([^{}]*\.ig-(?:split|detail|list|splitter)[^{}]*)\{([^}]*)\}/g)].map(m => m[2]);
    for (const body of splitRules) expect(body).not.toMatch(/transition[^;]*(width|grid-template|--ig-detail-w|all)/);
  });

  it("brings a phone's detail screen in from 8px over 160ms, and takes it out over the list in 120ms", () => {
    expect(rule(host, '.ig-split[data-drill-in] .ig-detail[data-flip="a"]')).toMatch(/animation:\s*ig-drill-in-a 160ms cubic-bezier\(0\.23, 1, 0\.32, 1\) both/);
    expect(keyframes("ig-drill-in-a")).toMatch(/from\s*\{\s*opacity:\s*0;\s*transform:\s*translateX\(8px\);\s*\}/);
    const leaving = rule(host, ".ig-split[data-drill-in] .ig-detail[data-leaving]");
    expect(leaving).toMatch(/position:\s*absolute;\s*inset:\s*0/);
    expect(leaving).toMatch(/animation:\s*ig-drill-out 120ms/);
    expect(keyframes("ig-drill-out")).toMatch(/to\s*\{\s*opacity:\s*0;\s*transform:\s*translateX\(8px\);\s*\}/);
    // The leaving screen is the same mounted detail, inert, never a second copy.
    expect(split).toMatch(/setLeaving\(!open && drillIn && !prefersReducedMotion\(\) \? lastDetail\.current : null\)/);
    expect(split).toMatch(/detailRef\.current\.inert = isLeaving/);
  });

  it("answers every one of those under reduced motion", () => {
    expect(reduced).toMatch(/\.ig-split:not\(\[data-drill-in\]\) \.ig-detail\[data-flip="b"\] > \*\s*\{\s*animation:\s*none/);
    expect(reduced).toMatch(/\.ig-split\[data-drill-in\] \.ig-detail\[data-flip="b"\]\s*\{\s*animation:\s*fadeIn 120ms ease-out/);
    expect(reduced).toMatch(/\.ig-split\[data-drill-in\] \.ig-detail\[data-leaving\]\s*\{\s*animation:\s*ig-fade-out 120ms/);
  });
});

describe("the detail's width before the reader drags it", () => {
  it("leaves the list the wider share under a 1100px modal, and is the standard 440 from about 1050px", () => {
    const listShare = (room: number) => (room - SPLITTER - autoDetail(room)) / room;
    expect(autoDetail(810)).toBe(340);           // a 900px window's modal
    expect(listShare(810)).toBeGreaterThanOrEqual(0.55);
    expect(listShare(1000)).toBeGreaterThanOrEqual(0.55);
    expect(autoDetail(1100)).toBe(DETAIL_WIDTH.standard);
    expect(autoDetail(1296)).toBe(DETAIL_WIDTH.standard);
    expect(autoDetail(760)).toBe(clampDetail(DETAIL_WIDTH.min, 760));
    expect(760 - SPLITTER - autoDetail(760)).toBeGreaterThanOrEqual(LIST_MIN);
  });

  it("is the same rule in the sheet, and nothing is stored until the reader drags", () => {
    expect(AUTO_DETAIL_CSS).toBe("clamp(320px, 42%, 440px)");
    expect(readDetailWidth("no-such-panel")).toBeNull();
    expect(split).toMatch(/"--ig-detail-w": width == null \? AUTO_DETAIL_CSS : `\$\{width\}px`/);
    // Enter and a double click on the splitter go back to it.
    expect(split).toMatch(/if \(event\.key === "Enter"\) \{ event\.preventDefault\(\); commit\(null\); return; \}/);
    expect(split).toMatch(/onDoubleClick=\{\(\) => commit\(null\)\}/);
  });
});

describe("Settings › Integrations", () => {
  it("introduces the development tools section", () => {
    const note = SETTINGS_SECTIONS.find(s => s.id === "integrations")?.note ?? "";
    expect(note).toBe("Connect and manage your development tools.");
  });
});
