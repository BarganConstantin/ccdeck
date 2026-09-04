// The Usage panel has two sources now, and this is the seam between them.
//
// #737: the panel summed the agents on the canvas. Those are honest figures
// with a scope nobody reads them as having — `pruneDoneSessions` evicts a
// finished session two minutes after it ends, so the number falls while nothing
// has happened. ccusage reads the transcripts on disk and forgets nothing, so
// it answers "today", "this month" and "all time"; the canvas answers "right
// now" and keeps its own labelled line.
//
// Source assertions, like the rest of this suite's panel coverage: there is no
// DOM here (`environment: node`), and what has to hold is a property of the
// component's text — which branch reads which list, and that neither source can
// be silently dropped by an edit to the other.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const panel = read("../components/UsagePanel.tsx");
const css = read("../styles.css");

describe("the panel prefers ccusage and falls back to the board", () => {
  it("decides once, on whether the range answered", () => {
    // One predicate, computed in one place. The tables, the strip, the headline
    // and the selector all read `fromRange`, so a deck without ccusage is the
    // old panel exactly and a deck with it never mixes the two in one figure.
    expect(panel).toContain("const fromRange = range != null;");
    expect(panel).toContain("setData(d?.ok ? d : null)");
  });

  it("keeps a failed or absent ccusage silent rather than loud", () => {
    // A deck whose ccusage will not run still has a board to draw. The catch
    // sets null, which is the fallback — not an error banner over numbers the
    // panel still has.
    expect(panel).toContain(".catch(() => { if (alive) setData(null); })");
  });

  it("renders both branches of both tables", () => {
    expect(panel).toContain("{(fromRange ? rangeModelRows.length : boardModelRows.length) > 0 && (");
    expect(panel).toContain("{(fromRange ? rangeSessionRows.length : boardSessionRows.length) > 0 && (");
    expect(panel).toContain("? rangeModelRows.map(m => (");
    expect(panel).toContain(": boardModelRows.map(m => (");
    expect(panel).toContain("{fromRange && rangeSessionRows.map(s => {");
    expect(panel).toContain("{!fromRange && boardSessionRows.map(s => (");
  });

  it("totals every token class in a ccusage model row, not input plus output", () => {
    // The board's row can only price the two token classes it tracks per agent.
    // ccusage sends four, and on an agentic session cache read is the largest
    // by orders of magnitude — a row that dropped it would report a fraction of
    // its own model's usage under a cost that included all of it.
    expect(panel).toContain("<td className=\"up-num\">{fmtTokens(m.tokens)}</td>");
  });
});

describe("the period selector", () => {
  it("offers the three spans from the shaping layer, never a fourth spelled here", () => {
    // PERIODS is the single list: `sinceFor` switches on the same keys, so a
    // period the component offered and the shaper did not know would silently
    // request the wrong range.
    expect(panel).toContain("{PERIODS.map(p => (");
    expect(panel).toContain("aria-pressed={period === p.key}");
    expect(panel).toContain("onClick={() => setPeriod(p.key)}");
  });

  it("appears only when there is a source with periods in it", () => {
    // The board has exactly one span — now — so three chips over a board-only
    // panel would be three words for the same figure.
    expect(panel).toMatch(/\{fromRange && \(\s*<div className=\{`uh-range up-period/);
  });

  it("reuses the history modal's chips rather than growing a second set", () => {
    // #583's luminance inversion lives on this selector, and toggle-state
    // coverage is written against it. A private copy would ship a selected
    // state that fails contrast on the panel while passing in the modal.
    expect(panel).toContain("uh-range up-period");
    expect(css).toContain('.uh-range-btn[aria-pressed="true"] { background: var(--accent); color: var(--bg); }');
    expect(css).toContain(".up-period {");
  });

  it("stays pressable while a slower period loads", () => {
    // ccusage against "all time" takes seconds. The strip dims; it does not
    // disable, or a reader who hit the wrong chip waits out a range they did
    // not want before they can correct it.
    expect(panel).toContain('${rangeLoading ? " up-period-busy" : ""}');
    expect(panel).not.toMatch(/disabled=\{rangeLoading\}/);
    expect(css).toContain(".up-period-busy { opacity: var(--dim-off); }");
  });
});

describe("what the panel asks the server for", () => {
  it("forces a fresh run only on the press that asked for one", () => {
    // `refreshKey > 0` was true for the rest of the panel's life once the ↻ had
    // been pressed, so every 120s poll after it spawned a ccusage child to
    // re-read what the server had cached. Keyed on the value changing instead.
    expect(panel).toContain("const force = refreshKey !== forcedRef.current;");
    expect(panel).toContain("`/api/ccusage?since=${since}${force ? \"&refresh=1\" : \"\"}`");
    expect(panel).not.toContain('refreshKey > 0 ? "&refresh=1"');
  });

  it("polls at the interval the server caches for, not oftener", () => {
    // CACHE_MS in ccusage.mjs. Polling inside the cache window buys a reading
    // that cannot have changed; polling well outside it leaves the panel behind
    // its own refresh button.
    const server = read("../../server/ccusage.mjs");
    const cacheMs = Number(/const CACHE_MS = ([\d_]+)/.exec(server)?.[1]?.replace(/_/g, ""));
    expect(cacheMs).toBe(120_000);
    expect(panel).toContain("window.setInterval(() => setTick(n => n + 1), 120_000)");
  });

  it("makes the header's ↻ mean the range too", () => {
    expect(panel).toContain("const refreshAll = () => { refreshQuota(); refreshCodex(); setRangeRefresh(n => n + 1); };");
  });
});

describe("the join to the canvas", () => {
  it("names sessions from roots only", () => {
    // A subagent carries its parent's sessionId, so including one would file a
    // tool's label under the session's id and overwrite the project name.
    expect(panel).toMatch(/const boardNames = useMemo[\s\S]{0,600}?if \(a\.kind !== "root" \|\| !a\.sessionId\) continue;/);
    expect(panel).toMatch(/const boardStates = useMemo[\s\S]{0,400}?if \(a\.kind !== "root" \|\| !a\.sessionId\) continue;/);
  });

  it("shows a uuid as a uuid when the board cannot name the session", () => {
    // ccusage remembers sessions this deck never drew — last week's, another
    // machine's. Eight characters under the full id, marked as the machine
    // string it is rather than dressed as a project name.
    expect(panel).toContain("{s.label ?? s.sessionId.slice(0, 8)}");
    expect(css).toContain(".up-session-id {");
  });

  it("draws a state dot only for a session the canvas is drawing", () => {
    // A ✓ on a session from three weeks ago is a state this deck never
    // observed. The placeholder keeps the labels aligned.
    expect(panel).toContain("const live = boardStates.get(s.sessionId);");
    expect(panel).toContain('<span className="sl-dot up-dot-past" aria-hidden />');
    expect(css).toContain(".up-dot-past { visibility: hidden; }");
  });

  it("cuts the session list at twelve, after sorting by cost", () => {
    // A 280px column against a year of transcripts. The shaper sorts by cost,
    // so the cut keeps the spend worth looking at.
    expect(panel).toContain("ccSessionRows(range, boardNames).slice(0, 12)");
  });
});

describe("no bar under a number this deck did not price", () => {
  it("draws the cost bar for the board only", () => {
    // The bar splits a total across input / output / cache. ccusage publishes
    // one cost per model and not that split, so drawing it under a ccusage
    // headline would mean deriving the shares from THIS deck's rate table and
    // hanging them beneath a figure measured somewhere else — a picture that
    // looks authoritative and is a different measurement from the number above
    // it, which is the shape of wrongness #687 is about.
    expect(panel).toContain("{!fromRange && <CostBar cost={totalCost} />}");
  });

  it("says unpriced by the source's own answer", () => {
    // A model ccusage priced at nothing is one IT does not know; a board row
    // carries its own `priced` flag. Same words, two different questions.
    expect(panel).toContain("? rangeModelRows.some(m => m.cost <= 0 && m.tokens > 0)");
    expect(panel).toContain(": boardModelRows.some(m => !m.priced);");
  });
});
