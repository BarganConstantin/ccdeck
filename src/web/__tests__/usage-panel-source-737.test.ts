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
    expect(panel).toContain("if (alive && d?.ok) setLanded({ period: want, data: d });");
  });

  it("keeps a failed or absent ccusage silent rather than loud", () => {
    // A deck whose ccusage will not run still has a board to draw, and one that
    // fails on the third poll still has the reading from the second. Neither is
    // an error banner over numbers the panel still holds.
    expect(panel).toContain(".catch(() => {})");
    expect(panel).toContain("data: landed?.data ?? null,");
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
    expect(panel).toMatch(/\{fromRange && \(\s*<div className="uh-range up-period"/);
  });

  it("sits outside the token gate, so an empty period cannot strand the reader", () => {
    // The gate is `totalTokenSum > 0`, and under ccusage that figure is the
    // RANGE's. A session started at 23:50 and still running at 00:05 makes
    // "today" empty, which used to remove the whole panel body — including the
    // only control that could have reached "month". The chips are rendered
    // before the gate now, and the empty branch says which period is empty.
    expect(panel.indexOf('className="uh-range up-period"')).toBeLessThan(panel.indexOf("{totalTokenSum > 0 ? ("));
    expect(panel).toContain("? <>No usage {periodNoun}.<br />Try a longer period.</>");
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
    // ccusage against "all time" takes seconds. Nothing about the chips changes
    // while it does — they are the reader's intent, and a reader who hit the
    // wrong one must be able to correct it immediately.
    expect(panel).not.toContain("up-period-busy");
    // And nothing else reads `loading` either: a refresh of the range already
    // on screen changes nothing the reader can act on, and dimming for it would
    // make the panel flicker every five minutes on its own poll.
    expect(panel).not.toContain("rangeLoading");
  });

  it("dims the figures, not the control, and with the token that means stale", () => {
    // The sheet declares both: --dim-off is "this control cannot be operated",
    // --dim-stale is "a newer reading is on its way and this one was true a
    // moment ago". The second is the state, and it belongs to the numbers.
    expect(panel).toContain('const staleCls = rangeStale ? " up-stale" : "";');
    expect(panel).toContain("<div className={`up-total${staleCls}`}");
    expect(panel).toContain("<div className={`up-tokens-row${staleCls}`}");
    expect(panel).toContain("<section className={`up-section${staleCls}`}>");
    expect(css).toMatch(/\.up-stale \{ opacity: var\(--dim-stale\)/);
  });

  it("never prints one period's money under another period's word", () => {
    // `period` moves on the press and the answer lands seconds later. The hook
    // carries the period each response answers, and every label reads THAT —
    // so the panel shows "$4.20 today" with `all` pressed and dimmed, never
    // "$4.20 all time" rewriting itself a moment later.
    expect(panel).toContain("const [landed, setLanded] = useState<{ period: PeriodKey; data: UsageRange } | null>(null);");
    expect(panel).toContain("setLanded({ period: want, data: d })");
    expect(panel).toContain("stale: landed != null && landed.period !== period,");
    expect(panel).toContain("PERIODS.find(p => p.key === (shownPeriod ?? period))?.noun");
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

  it("polls at a rate chosen against the work, and not behind a hidden tab", () => {
    // Every interval longer than the server's CACHE_MS misses the cache by
    // definition, so the poll rate IS the ccusage run rate — and a run walks
    // every transcript on the machine. Five minutes, and only while someone is
    // looking; a deck open on a second desktop spends nothing.
    const server = read("../../server/ccusage.mjs");
    const cacheMs = Number(/const CACHE_MS = ([\d_]+)/.exec(server)?.[1]?.replace(/_/g, ""));
    expect(cacheMs).toBe(120_000);
    expect(panel).toContain("window.setInterval(beat, 300_000)");
    expect(panel).toContain('if (document.visibilityState === "visible") setTick(n => n + 1);');
    expect(panel).toContain('document.addEventListener("visibilitychange", wake)');
    expect(panel).toContain('document.removeEventListener("visibilitychange", wake)');
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

  it("says on the heading that a ccusage session row is a lifetime total", () => {
    // ccusage's `--since` chooses WHICH sessions are listed and does not cut
    // their figures to the window: session 07ac7b2b spans three days and
    // reports the same $376.88 for "today" as for "all time", so today's rows
    // summed to $4,391 under a headline of $839. The reader can see that
    // arithmetic fail, so the scope goes on the heading and not in a tooltip.
    expect(panel).toContain(">active {periodNoun}</span>");
    expect(panel).toMatch(/title=\{`Sessions with activity \$\{periodNoun\}/);
  });

  it("says why the session list is empty rather than dropping the section", () => {
    // The two halves of one ccusage load do not date things the same way:
    // `daily` buckets by local calendar day and `session` filters by UTC day
    // whatever timezone it is handed. Measured at 01:58 local (UTC+3):
    // `daily --since 20260905` reported $169.12 and `session --since 20260905`
    // reported nothing, because no session had touched UTC's 5th yet. So east
    // of Greenwich there is a stretch after midnight where the money is real
    // and the list is empty, and a missing section reads as a bug.
    expect(panel).toContain("{fromRange && rangeSessionRows.length === 0 && rangeSum.tokens > 0 && (");
    expect(panel).toContain("No session is dated {periodNoun} yet");
  });

  it("cuts the session list at twelve, after sorting by cost", () => {
    // A 280px column against a year of transcripts. The shaper sorts by cost,
    // so the cut keeps the spend worth looking at.
    expect(panel).toContain("ccSessionRows(range, boardNames).slice(0, 12)");
  });

  it("tells two sessions of the same project apart", () => {
    // Parallel agents in one folder, or a deck restarted: both sessions come
    // back under the same project name, and two identical labels carrying
    // different money read as a bug in the panel rather than as two sessions.
    // Only a repeated label pays for the uuid fragment.
    expect(panel).toContain("`${r.label} ${r.sessionId.slice(0, 4)}`");
    expect(panel).toContain("for (const r of rows) if (r.label) seen.set(r.label, (seen.get(r.label) ?? 0) + 1);");
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
