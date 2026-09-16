// #844: Local network, deck-to-deck sync, was only findable at the foot of the
// Claude accounts panel, under every account and the auto-switch block, and
// the tour spent a tip telling people where it was. It is not an account
// setting.
//
// For a while its way in was a line under the panel's header that scrolled down
// to the section, while the section still drew every machine under the
// accounts — so the network's state was said twice and its list took the
// column's space permanently. It is a view of its own now. One row at the foot
// of the accounts view names it and says what state it is in; pressing it gives
// the column to Local network, and Back gives it back. One way in, so the state
// is said once.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { entryLine, type DeckRow } from "../components/LanSyncSection";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const panel = read("../components/AccountsPanel.tsx");
const lan = read("../components/LanSyncSection.tsx");
const guide = read("../components/guide-art.tsx");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

let n = 0;
const row = (kind: DeckRow["kind"], tone: DeckRow["tone"] = "ok", here = tone === "ok"): DeckRow => ({
  fp: `fp-${n++}`, name: "machine", addr: "", kind, state: "", tone, here, hint: "",
});
const on = { enabled: true, running: true };

describe("what the way in says (#844)", () => {
  it("says it is checking until the section has read its own state, and Off while it is off", () => {
    expect(entryLine(null, [])).toEqual({ text: "checking…", tone: "idle", trouble: 0 });
    expect(entryLine({ enabled: false }, [row("paired")]).text).toBe("Off");
  });

  it("names a start that failed, and one that has not finished", () => {
    expect(entryLine({ enabled: true, running: false, stalled: "port in use" }, [])).toMatchObject({ text: "could not start", tone: "bad" });
    expect(entryLine({ enabled: true, running: false }, [])).toMatchObject({ text: "starting…", tone: "wait" });
  });

  it("gives way to a deck asking to pair, which is waiting on this keyboard", () => {
    expect(entryLine(on, [row("asks", "wait"), row("paired", "bad")])).toEqual({ text: "1 deck wants to pair", tone: "wait", trouble: 0 });
    expect(entryLine(on, [row("asks", "wait"), row("asks", "wait")]).text).toBe("2 decks want to pair");
  });

  it("leads with how many paired machines are on, out of how many there are", () => {
    // The same rows the list and its fold are drawn from: an address being
    // dialled that never answers is not paired, and it is not responding.
    const rows = [row("paired"), row("paired"), row("paired", "bad"), row("dialling", "bad"), row("nearby", "idle")];
    expect(entryLine(on, rows)).toEqual({ text: "2 of 3 online", tone: "ok", trouble: 2 });
    expect(entryLine(on, [row("nearby", "idle")])).toEqual({ text: "On · none paired yet", tone: "idle", trouble: 0 });
  });

  it("drops the arithmetic when the whole fleet is there, and says so when none of it is", () => {
    expect(entryLine(on, [row("paired"), row("paired")])).toEqual({ text: "2 online", tone: "ok", trouble: 0 });
    // Paired, switched off, and nothing has failed: not a fault, so not the
    // warning ink — but not `2 online` either, which was the old line's lie.
    const off = [row("paired", "idle", false), row("paired", "idle", false)];
    expect(entryLine(on, off)).toEqual({ text: "none of 2 online", tone: "idle", trouble: 0 });
    // Presence is the row's own `here`, not its tone: a deck that is on and
    // whose last round failed is still one of the machines that are there.
    expect(entryLine(on, [row("paired", "bad", true), row("paired", "idle", false)]))
      .toEqual({ text: "1 of 2 online", tone: "ok", trouble: 1 });
  });
});

describe("one way in, at the foot of the accounts (#844)", () => {
  it("is the section itself, drawn as one row while the accounts have the column", () => {
    expect(lan).toMatch(/if \(!view\) \{\s*return \(\s*<div className="ap-foot">\s*<button type="button" id="ap-lan-entry" className="ap-nav" onClick=\{onOpen\}>/);
    expect(lan).toMatch(/<span className="ap-nav-name">Local network<\/span>/);
    expect(lan).toMatch(/\{entry\.trouble > 0 && <span className="ap-nav-bad">\{" · "\}\{entry\.trouble\} not responding<\/span>\}/);
  });

  it("comes after the roster and the policy row, and is the only place the network's state is said", () => {
    expect(panel).not.toMatch(/ap-lan-way|jumpToLan|lanSummary|onSummary/);
    expect(lan).not.toMatch(/onSummary/);
    expect(panel.indexOf('<div className="ap-foot">')).toBeGreaterThan(panel.indexOf('<ul className="ap-list">'));
    expect(panel.indexOf("<LanSyncSection")).toBeGreaterThan(panel.indexOf('<div className="ap-foot">'));
  });

  it("keeps the section mounted in both views once it has been shown", () => {
    expect(panel).toMatch(/\{lanReady && \(\s*<LanSyncSection/);
    expect(panel).toMatch(/view=\{view === "lan"\}\s*onOpen=\{openLan\}\s*onBack=\{\(\) => setView\("accounts"\)\}/);
    expect(panel).toMatch(/useEffect\(\(\) => \{ if \(data\?\.ok\) setLanReady\(true\); \}, \[data\?\.ok\]\);/);
  });

  it("reads as a destination: a row that answers the pointer with a tone, and no box", () => {
    const nav = /\n\.ap-nav \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(nav).toMatch(/border: 0/);
    expect(nav).toMatch(/cursor: pointer/);
    expect(css).toMatch(/\.ap-nav:hover \{ background: color-mix\(in srgb, var\(--text\) 4%, transparent\); \}/);
  });
});

describe("the view (#844)", () => {
  it("has the panel's header shape: Back, the title, the section's own acts and the panel's close", () => {
    const head = /<div className="ap-lan-view">\s*<div className="ap-header">([\s\S]*?)\n {6}<\/div>/.exec(lan)?.[1] ?? "";
    expect(head).toMatch(/id="ap-lan-back" className="glyph-btn ap-back" onClick=\{onBack\}/);
    expect(head).toMatch(/aria-label="Back to Claude accounts"/);
    expect(head).toMatch(/<h2 id="ap-lan-title">Local network<\/h2>/);
    expect(head).toMatch(/ap-lan-plus/);
    expect(head).toMatch(/\{closeButton\}/);
  });

  it("hands focus to Back on the way in and to the row on the way out, after the frame", () => {
    expect(panel).toMatch(/document\.getElementById\(view === "lan" \? "ap-lan-back" : "ap-lan-entry"\)\?\.focus\(\)/);
    expect(panel).toMatch(/const openLan = \(\) => \{\s*dropMenu\(\);\s*setIssueOpen\(null\);\s*setView\("lan"\);/);
  });

  it("adds no focus stop of its own", () => {
    expect(lan).not.toMatch(/tabIndex=\{-1\}/);
  });
});

describe("the tour no longer has to say where it is (#844)", () => {
  it("points at the row instead of describing the panel's layout", () => {
    expect(guide).not.toMatch(/last section of the Claude accounts panel/);
    expect(guide).toMatch(/tip: "Open it from the row at the foot of the Claude accounts panel\."/);
  });
});
