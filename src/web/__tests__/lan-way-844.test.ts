// #844: Local network, deck-to-deck sync, was only findable at the foot of the
// Claude accounts panel, under every account and the auto-switch block, and
// the tour spent a tip telling people where it was. It is not an account
// setting. It now has its own way in: a line under the panel's header naming
// it and its state, whose name scrolls to the section and hands its heading
// focus.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const panel = read("../components/AccountsPanel.tsx");
const lan = read("../components/LanSyncSection.tsx");
const guide = read("../components/guide-art.tsx");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

describe("the section says what it is to the panel (#844)", () => {
  it("reports whether it is on and how many decks are paired", () => {
    expect(lan).toMatch(/export interface LanSummary \{ on: boolean; paired: number \}/);
    expect(lan).toMatch(/useEffect\(\(\) => \{ onSummary\?\.\(\{ on, paired \}\); \}, \[on, paired, onSummary\]\);/);
    expect(panel).toMatch(/onChanged=\{\(\) => load\(true\)\}\s*onSummary=\{setLanSummary\}/);
  });

  it("gives its heading an id the link can reach, and no focus stop of its own", () => {
    expect(lan).toMatch(/<h3 className="ap-auto-title" id="ap-lan-title">Local network<\/h3>/);
    expect(lan).not.toMatch(/tabIndex=\{-1\}/);
  });
});

describe("the way in, under the panel's header (#844)", () => {
  it("is drawn between the header and the roster, once the section has reported", () => {
    const way = panel.indexOf('<div className="ap-lan-way">');
    expect(panel).toMatch(/\{lanSummary && \(\s*<div className="ap-lan-way">\s*<button type="button" className="ap-lan-jump" onClick=\{jumpToLan\}/);
    expect(way).toBeGreaterThan(panel.indexOf('<div className="ap-header">'));
    expect(way).toBeLessThan(panel.indexOf("<LanSyncSection"));
    expect(way).toBeLessThan(panel.indexOf("{data == null ? ("));
  });

  it("names the section and says its state beside the name", () => {
    expect(panel).toMatch(/>Local network<\/button>/);
    expect(panel).toMatch(/lanSummary\.on \? \(lanSummary\.paired > 0 \? `on · \$\{lanSummary\.paired\} paired` : "on · none paired yet"\) : "off"/);
  });

  it("scrolls to the section and hands its first control focus, without motion when asked", () => {
    const jump = /const jumpToLan = \(\) => \{[\s\S]*?\n  \};/.exec(panel)?.[0] ?? "";
    expect(jump).toMatch(/document\.getElementById\("ap-lan-title"\)/);
    expect(jump).toMatch(/prefers-reduced-motion: reduce/);
    expect(jump).toMatch(/scrollIntoView\(\{ block: "start", behavior: still \? "auto" : "smooth" \}\)/);
    expect(jump).toMatch(/head\.closest\("\.ap-lan"\)\?\.querySelector<HTMLElement>\("button:not\(:disabled\), input, select"\)\?\.focus\(\{ preventScroll: true \}\)/);
  });

  it("reads as a way to somewhere: a word with a dotted rule, a press and a 24px target", () => {
    const jump = /\n\.ap-lan-jump \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(jump).toMatch(/text-decoration: underline dotted/);
    expect(jump).toMatch(/cursor: pointer/);
    expect(jump).not.toMatch(/border: 1px/);
    expect(css).toMatch(/\.ap-lan-jump:active \{ transform: scale\(0\.97\); \}/);
    expect(css).toMatch(/\.ap-fix::after,\s*\.ap-lan-jump::after \{/);
  });
});

describe("the tour no longer has to say where it is (#844)", () => {
  it("points at the link instead of describing the panel's layout", () => {
    expect(guide).not.toMatch(/last section of the Claude accounts panel/);
    expect(guide).toMatch(/tip: "The Claude accounts panel links to it from its top line\."/);
  });
});
