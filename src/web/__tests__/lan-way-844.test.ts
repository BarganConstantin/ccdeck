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
    expect(entryLine(null, [])).toEqual({ text: "checking…", tone: "idle", live: false });
    expect(entryLine({ enabled: false }, [row("paired")]).text).toBe("Off");
  });

  it("names a start that failed, and one that has not finished", () => {
    expect(entryLine({ enabled: true, running: false, stalled: "port in use" }, [])).toMatchObject({ text: "could not start", tone: "bad" });
    expect(entryLine({ enabled: true, running: false }, [])).toMatchObject({ text: "starting…", tone: "wait" });
  });

  it("gives way to a deck asking to pair, which is waiting on this keyboard", () => {
    expect(entryLine(on, [row("asks", "wait"), row("paired", "bad")])).toEqual({ text: "1 deck wants to pair", tone: "wait", live: false });
    expect(entryLine(on, [row("asks", "wait"), row("asks", "wait")]).text).toBe("2 decks want to pair");
  });

  it("leads with how many paired machines are on, out of how many there are", () => {
    // Only the paired machines are the fleet: an address still being dialled
    // has no machine behind it yet, and a stranger is not shared with.
    const rows = [row("paired"), row("paired"), row("paired", "bad"), row("dialling", "bad"), row("nearby", "idle")];
    expect(entryLine(on, rows)).toEqual({ text: "2 of 3 online", tone: "ok", live: true });
    expect(entryLine(on, [row("nearby", "idle")])).toEqual({ text: "On · none paired yet", tone: "idle", live: false });
  });

  it("drops the arithmetic when the whole fleet is there, and says so when none of it is", () => {
    expect(entryLine(on, [row("paired"), row("paired")])).toEqual({ text: "2 online", tone: "ok", live: true });
    const off = [row("paired", "idle", false), row("paired", "idle", false)];
    expect(entryLine(on, off)).toEqual({ text: "none of 2 online", tone: "idle", live: false });
    // Presence is the row's own `here`, not its tone: a deck that is on and
    // whose last round failed is still one of the machines that are there.
    expect(entryLine(on, [row("paired", "bad", true), row("paired", "idle", false)]))
      .toEqual({ text: "1 of 2 online", tone: "ok", live: true });
  });

  it("counts no faults on the way in: a deck not responding is already not online", () => {
    // The amber `· 1 not responding` sat beside the presence count and restated
    // an absence that count had stated, in the colour that means act on this,
    // from the one view where there is nothing to act on. Which machine, and
    // why, is a press away — and the list still counts it under its own fold.
    const failing = [row("paired", "bad", false), row("paired"), row("dialling", "bad", false)];
    expect(entryLine(on, failing)).toEqual({ text: "1 of 2 online", tone: "ok", live: true });
    expect(lan).not.toMatch(/ap-nav-bad|not responding<\/span>\}/);
    expect(css).not.toMatch(/\.ap-nav-bad/);
    // The fold inside the view keeps its own count, which is where it belongs.
    expect(lan).toMatch(/\{" · "\}\{troubled\} not responding/);
  });
});

describe("one way in, at the foot of the accounts (#844)", () => {
  it("is the section itself, drawn as one row while the accounts have the column", () => {
    expect(lan).toMatch(/<div className="ap-foot">\s*<button type="button" id="ap-lan-entry" className="ap-nav"/);
    expect(lan).toMatch(/onClick=\{\(\) => \{ shutPeek\(\); onOpen\(\); \}\}/);
    expect(lan).toMatch(/<span className="ap-nav-name">Local network<\/span>/);
    expect(lan).toMatch(/<span className="ap-nav-state" data-tone=\{entry\.tone\}>/);
    // The mark for present, drawn only while somebody is present, in the green
    // the machines themselves wear one press away — see `.ap-lan-who .ap-pulse`.
    // Recolouring the same fact between the summary and the list would make a
    // reader check whether the two were counting different things.
    expect(lan).toMatch(/\{entry\.live && <i className="ap-nav-live" aria-hidden \/>\}/);
    expect(/\n\.ap-nav-live \{([^}]*)\}/.exec(css)?.[1] ?? "").toMatch(/background: var\(--ok\)/);
    expect(css).toMatch(/\.ap-lan-who \.ap-pulse \{ color: var\(--ok\)/);
    // A summary of every machine does not ping; the machines themselves do.
    expect(css).not.toMatch(/\.ap-nav-live[^{]*\{[^}]*animation/);
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

// A count answers HOW MANY and refuses to say WHICH, and which is the question
// somebody has before sending a login to a colleague's machine. The peek is
// that answer without a press: a card beside the row, on hover and on focus.
describe("the peek: who is on, beside the row, with nothing pressed", () => {
  const peek = /function LanPeek\(([\s\S]*?)\n\}/.exec(lan)?.[0] ?? "";
  const block = (sel: string) => new RegExp(`\\n\\${sel} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";

  it("hangs off the way-in row and is drawn only while it is open", () => {
    expect(lan).toMatch(/\{peek && <LanPeek anchorId="ap-lan-entry" id="ap-lan-peek" rows=\{rows\} \/>\}/);
    expect(peek).toMatch(/createPortal\(/);
    expect(peek).toMatch(/className="ap-peek" role="tooltip"/);
  });

  it("opens after a delay for a mouse and at once for focus, and shuts on either leaving", () => {
    expect(lan).toMatch(/onPointerEnter=\{e => \{ if \(e\.pointerType === "mouse"\) openPeek\(PEEK_DELAY_MS\); \}\}/);
    expect(lan).toMatch(/onPointerLeave=\{shutPeek\}/);
    // A keyboard's focus only: Back hands focus to this row on the way out of
    // the view, and a card opened by that hand-back has no pointer to leave it
    // and no blur coming — it just sits there. Reported from a screenshot of
    // exactly that.
    expect(lan).toMatch(/onFocus=\{e => \{ if \(e\.target\.matches\(":focus-visible"\)\) openPeek\(0\); \}\}/);
    expect(lan).toMatch(/onBlur=\{shutPeek\}/);
    // A pointer that leaves before the delay fires cancels it, rather than
    // opening a card the pointer has already walked away from.
    expect(lan).toMatch(/const shutPeek = \(\) => \{ window\.clearTimeout\(peekTimer\.current\); setPeek\(false\); \};/);
    expect(lan).toMatch(/useEffect\(\(\) => \(\) => window\.clearTimeout\(peekTimer\.current\), \[\]\);/);
  });

  it("is told to a screen reader too, and only while the card is there", () => {
    expect(lan).toMatch(/aria-describedby=\{peek \? "ap-lan-peek" : undefined\}/);
    // No Escape of its own: a card that holds no focus and takes no pointer is
    // not something a reader can be stuck inside, and App.tsx stays the one
    // place that reads that key. Held by modal-dismiss.test.ts for every
    // component; said here because this is the surface that raised it.
    expect(lan).not.toMatch(/"Escape"/);
  });

  it("takes neither the pointer nor a press: there is nothing in it to act on", () => {
    // Everything in the card is a press away in the view. A control here would
    // be a control under a pointer that is only passing through.
    expect(peek).not.toMatch(/<button|onClick/);
    expect(block(".ap-peek")).toMatch(/pointer-events: none/);
    expect(block(".ap-peek")).toMatch(/position: fixed/);
    // The layer the panel's other portalled surface already sits on.
    expect(block(".ap-peek")).toMatch(/z-index: 40/);
  });

  it("names at most a handful, then counts the rest", () => {
    expect(lan).toMatch(/const shown = here\.slice\(0, PEEK_NAMES\);/);
    expect(lan).toMatch(/export const PEEK_NAMES = 6;/);
    expect(lan).toMatch(/\{here\.length \? "On the network now" : "Nobody on the network"\}/);
    expect(lan).toMatch(/\$\{off\} not on right now/);
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
