// The Usage panel has two sources, and this is the seam between them.
//
// #737: the panel summed the agents on the canvas. Those are honest figures
// with a scope nobody reads them as having — `pruneDoneSessions` evicts a
// finished session two minutes after it ends, so the number falls while nothing
// has happened. ccusage reads the transcripts on disk and forgets nothing, so
// it answers "today", "this month" and "all time"; the canvas answers "right
// now" and keeps its own labelled line.
//
// WHY THIS FILE STOPPED BEING TWENTY-THREE STRING MATCHES. It opened with
// "source assertions, like the rest of this suite's panel coverage: there is no
// DOM here (`environment: node`), and what has to hold is a property of the
// component's text". The premise was true and the conclusion was a dead end. A
// match on `"{!fromRange && <CostBar cost={totalCost} />}"` passes for a panel
// that renders the bar under a ccusage headline as long as the characters are
// unchanged, fails for one that renames a variable and is right, and says
// nothing at all about whether the seven places that read the source flag agree
// with each other — which is the entire claim.
//
// The missing piece was not a DOM. It was that the decisions lived inside a
// 1,200-line component where nothing could call them. They are functions now,
// in usage-from-ccusage.ts beside the shaping they belong to:
//
//   rangeView(landed, pressed)     what is on screen, which period it is OF,
//                                  and whether a newer one is still coming
//   nounFor(shown, pressed)        the word printed over the figures
//   panelFigures(range, board, δ)  every headline figure, paired with its source
//
// So the pairing is exercised with real readings instead of matched as text,
// and one property that no amount of grepping could reach is now checked: the
// live delta is added to a ccusage reading and NEVER to a board total, because
// the board already counts the work the delta describes.
//
// WHAT IS STILL READ AS TEXT, and why. Markup shape — which branch renders
// which table, that the chips exist and are pressable, that a class in the JSX
// has a rule in the sheet. Those are properties of the component's text with no
// DOM to observe them in, and unlike the decisions they cannot be moved
// anywhere that would make them callable. They are grouped at the bottom under
// their own heading rather than mixed in with the cases that prove something.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  nounFor, panelFigures, rangeView, PERIODS,
  type Board, type Delta, type Landed, type UsageRange,
} from "../usage-from-ccusage";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const panel = read("../components/UsagePanel.tsx");
const css = read("../styles.css");

/** A ccusage answer, in the shape the route really returns: `totals` is what
 *  `rangeTotals` reads first, and the numbers are the ones a reader would see. */
const RANGE = (over: Partial<Record<string, number>> = {}): UsageRange => ({
  ok: true,
  totals: {
    totalCost: 100,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheCreationTokens: 40,
    totalTokens: 100,
    ...over,
  },
} as unknown as UsageRange);

/** What the canvas sums to, deliberately different from RANGE in every field so
 *  a figure taken from the wrong source cannot coincide with the right one. */
const BOARD: Board = {
  cost: { total: 7 },
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheCreateTokens: 4,
  sum: 3,
};

/** What the canvas has seen since the reading landed. */
const DELTA: Delta = {
  cost: 0.5,
  inputTokens: 1000,
  outputTokens: 2000,
  cacheReadTokens: 3000,
  cacheCreateTokens: 4000,
};

const NONE: Delta = { cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };

describe("which source each figure comes from", () => {
  it("takes every figure from ccusage when ccusage answered", () => {
    const f = panelFigures(RANGE(), BOARD, NONE);
    expect(f.fromRange).toBe(true);
    expect(f.cost).toBe(100);
    expect(f.inputTokens).toBe(10);
    expect(f.outputTokens).toBe(20);
    expect(f.cacheReadTokens).toBe(30);
    expect(f.cacheCreateTokens).toBe(40);
    expect(f.tokenSum).toBe(100);
  });

  it("takes every figure from the board when it did not", () => {
    const f = panelFigures(null, BOARD, NONE);
    expect(f.fromRange).toBe(false);
    expect(f.cost).toBe(7);
    expect(f.inputTokens).toBe(1);
    expect(f.outputTokens).toBe(2);
    expect(f.cacheReadTokens).toBe(3);
    expect(f.cacheCreateTokens).toBe(4);
    expect(f.tokenSum).toBe(3);
  });

  it("never mixes them — no figure carries the other source's number", () => {
    // The claim the whole seam rests on, and the one a string match could not
    // make: with the two sources sharing no value, a single field reading the
    // wrong one shows up immediately.
    const asRange = panelFigures(RANGE(), BOARD, NONE);
    const boardValues = [BOARD.cost.total, BOARD.inputTokens, BOARD.outputTokens,
      BOARD.cacheReadTokens, BOARD.cacheCreateTokens, BOARD.sum];
    for (const [field, value] of Object.entries(asRange)) {
      if (typeof value !== "number") continue;
      expect(boardValues, `${field} came from the board while ccusage had answered`).not.toContain(value);
    }
  });

  it("gates the money block on the source's own cost, not on the other's", () => {
    // A period with no spend must not borrow the board's dollars to open the
    // block, and a board with no priced model must not borrow a range's.
    expect(panelFigures(RANGE({ totalCost: 0 }), BOARD, NONE).hasCost).toBe(false);
    expect(panelFigures(RANGE(), { ...BOARD, cost: { total: 0 } }, NONE).hasCost).toBe(true);
    expect(panelFigures(null, { ...BOARD, cost: { total: 0 } }, NONE).hasCost).toBe(false);
    expect(panelFigures(null, BOARD, NONE).hasCost).toBe(true);
  });

  it("reports an empty period as empty rather than falling back to the board", () => {
    // The gate on the whole body is `tokenSum > 0`, and under ccusage that is
    // the RANGE's count. A period with nothing in it has to read as empty — a
    // fallback here would silently answer a question about today with a figure
    // about right now.
    const empty = panelFigures(RANGE({ totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }), BOARD, NONE);
    expect(empty.fromRange).toBe(true);
    expect(empty.tokenSum).toBe(0);
  });
});

describe("the live delta between two readings", () => {
  it("is added to a ccusage reading, which is the gap it exists to fill", () => {
    const f = panelFigures(RANGE(), BOARD, DELTA);
    expect(f.cost).toBe(100.5);
    expect(f.inputTokens).toBe(1010);
    expect(f.outputTokens).toBe(2020);
    expect(f.cacheReadTokens).toBe(3030);
    expect(f.cacheCreateTokens).toBe(4040);
  });

  it("is never added to a board total, which would count the same work twice", () => {
    // The property this rewrite exists for. The delta IS the canvas's work
    // since the reading landed — the board already counts every bit of it, so
    // adding it there would report it twice, and no amount of matching the
    // panel's text could tell whether the ternaries agreed about that.
    const f = panelFigures(null, BOARD, DELTA);
    expect(f.cost).toBe(BOARD.cost.total);
    expect(f.inputTokens).toBe(BOARD.inputTokens);
    expect(f.outputTokens).toBe(BOARD.outputTokens);
    expect(f.cacheReadTokens).toBe(BOARD.cacheReadTokens);
    expect(f.cacheCreateTokens).toBe(BOARD.cacheCreateTokens);
    expect(f.tokenSum).toBe(BOARD.sum);
  });

  it("cannot open the money block on its own", () => {
    // `hasCost` reads the READING's cost, not the displayed figure. An unpriced
    // period with a live delta on top must not grow a headline out of the
    // deck's own rate table applied to one minute of work.
    expect(panelFigures(RANGE({ totalCost: 0 }), BOARD, DELTA).hasCost).toBe(false);
  });
});

describe("the bar under the headline", () => {
  it("is drawn for the board and never for a ccusage figure", () => {
    // The bar splits a total across input / output / cache. ccusage publishes
    // one cost per model and not that split, so drawing it under a ccusage
    // headline would mean deriving the shares from THIS deck's rate table and
    // hanging them beneath a figure measured somewhere else — a picture that
    // looks authoritative and is a different measurement from the number above
    // it, which is the shape of wrongness #687 is about.
    expect(panelFigures(null, BOARD, NONE).showCostBar).toBe(true);
    expect(panelFigures(RANGE(), BOARD, NONE).showCostBar).toBe(false);
  });

  it("is wired to that answer in the component", () => {
    // The one line of markup this claim reaches through. Asserted by name
    // rather than by shape, so the decision above is the thing that can be
    // wrong and this is only the wire.
    expect(panel).toContain("{figures.showCostBar && <CostBar cost={totalCost} />}");
  });
});

describe("what the figures are labelled with while a slower period loads", () => {
  const landedToday: Landed = { period: "today", data: RANGE() };

  it("shows the period that answered, not the chip that was pressed", () => {
    // `period` moves on the press and the answer lands seconds later. The panel
    // must read "$4.20 today" with `all` pressed and dimmed, never "$4.20 all
    // time" rewriting itself a moment later.
    const view = rangeView(landedToday, "all");
    expect(view.shown).toBe("today");
    expect(view.stale).toBe(true);
    expect(nounFor(view.shown, "all")).toBe(PERIODS.find(p => p.key === "today")!.noun);
  });

  it("is not stale once the pressed period is the one on screen", () => {
    const view = rangeView(landedToday, "today");
    expect(view.stale).toBe(false);
    expect(view.data).toBe(landedToday.data);
  });

  it("holds the last good reading rather than blanking when a later one fails", () => {
    // A fetch that throws leaves `landed` alone, so the view still carries the
    // previous answer. The panel says so by falling back to nothing — no error
    // banner over numbers it still has.
    const view = rangeView(landedToday, "month");
    expect(view.data).toBe(landedToday.data);
    expect(view.stale).toBe(true);
  });

  it("falls back to the board before anything has landed at all", () => {
    const view = rangeView(null, "today");
    expect(view.data).toBeNull();
    expect(view.shown).toBeNull();
    expect(view.stale).toBe(false);
    expect(panelFigures(view.data, BOARD, NONE).fromRange).toBe(false);
  });

  it("always has a noun, including for a period this build no longer offers", () => {
    // A stored preference from an older build must not leave the headline with
    // a bare figure and no word over it.
    expect(nounFor(null, "month")).toBe(PERIODS.find(p => p.key === "month")!.noun);
    expect(nounFor("nope" as never, "today")).toBe("today");
  });
});

describe("what the panel asks the server for", () => {
  it("forces a fresh run only on the press that asked for one", () => {
    // `refreshKey > 0` was true for the rest of the panel's life once the ↻ had
    // been pressed, so every poll after it spawned a ccusage child to re-read
    // what the server had cached. Keyed on the value changing instead.
    expect(panel).toContain("const force = refreshKey !== forcedRef.current;");
    expect(panel).toContain("`/api/ccusage?since=${since}${force ? \"&refresh=1\" : \"\"}`");
    expect(panel).not.toContain('refreshKey > 0 ? "&refresh=1"');
  });

  it("polls once a minute, against a cache that is not longer than the poll", () => {
    // The two numbers have to agree or the interval is a lie: a poll inside the
    // cache window gets the same figure handed back, so the panel would say it
    // refreshes every minute while the reading moved every two. They are both
    // 60s — which makes this the ccusage run rate, and a run walks every
    // transcript on the machine, which is why it is not faster. Two files, one
    // number: this is the only case here that spans them.
    const server = read("../../server/ccusage.mjs");
    const cacheMs = Number(/const CACHE_MS = ([\d_]+)/.exec(server)?.[1]?.replace(/_/g, ""));
    expect(cacheMs).toBe(60_000);
    expect(panel).toContain("const POLL_MS = 60_000;");
    expect(panel).toContain("window.setInterval(beat, POLL_MS)");
    // And returning to the tab is gated on the reading's AGE, not on the tab
    // merely coming forward: flicking between two tabs three times must not
    // spend three runs at 7.8 CPU-seconds each.
    expect(panel).toContain("if (Date.now() - landedAtRef.current >= POLL_MS) setTick(n => n + 1);");
    expect(panel).toContain('const visible = () => document.visibilityState === "visible";');
    expect(panel).toContain('document.addEventListener("visibilitychange", wake)');
    expect(panel).toContain('document.removeEventListener("visibilitychange", wake)');
  });

  it("keeps a failed or absent ccusage silent rather than loud", () => {
    // A deck whose ccusage will not run still has a board to draw, and one that
    // fails on the third poll still has the reading from the second. Neither is
    // an error banner over numbers the panel still holds. The consequence is
    // checked above, against `rangeView`; this is the catch that produces it.
    expect(panel).toContain(".catch(() => {})");
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

// ── markup, which has no DOM here to be observed in ──────────────────────────
//
// What is left after the decisions moved. Every case below is a claim about the
// component's TEXT and says so: which branch renders which table, that a
// control exists, that a class in the JSX has a rule in the sheet. They are the
// weakest cases in this file and they are grouped so that nobody mistakes one
// for a proof — the seam itself is proved above, by calling it.
describe("markup, read as source", () => {
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

  it("says unpriced by the source's own answer", () => {
    // A model ccusage priced at nothing is one IT does not know; a board row
    // carries its own `priced` flag. Same words, two different questions.
    expect(panel).toContain("? rangeModelRows.some(m => m.cost <= 0 && m.tokens > 0)");
    expect(panel).toContain(": boardModelRows.some(m => !m.priced);");
  });

  it("offers the three spans from the shaping layer, never a fourth spelled here", () => {
    // PERIODS is the single list: `sinceFor` switches on the same keys, so a
    // period the component offered and the shaper did not know would silently
    // request the wrong range.
    expect(panel).toContain("{PERIODS.map(p => (");
    expect(panel).toContain("aria-pressed={period === p.key}");
    expect(panel).toContain("onClick={() => setPeriod(p.key)}");
  });

  it("shows the selector only when there is a source with periods in it", () => {
    // The board has exactly one span — now — so three chips over a board-only
    // panel would be three words for the same figure.
    expect(panel).toMatch(/\{fromRange && \(\s*<div className="uh-range up-period"/);
  });

  it("puts the selector outside the token gate, so an empty period cannot strand the reader", () => {
    // A session started at 23:50 and still running at 00:05 makes "today"
    // empty, which used to remove the whole panel body — including the only
    // control that could have reached "month".
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

  it("keeps the chips pressable while a slower period loads", () => {
    // ccusage against "all time" takes seconds. Nothing about the chips changes
    // while it does — they are the reader's intent, and a reader who hit the
    // wrong one must be able to correct it immediately.
    expect(panel).not.toContain("up-period-busy");
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

  it("reads the seam through the functions rather than re-deciding it here", () => {
    // The regression this whole rewrite would otherwise invite: a later edit
    // that re-inlines one of the ternaries would put a figure back where no
    // test can reach it, and every case above would still pass.
    expect(panel).toContain("const figures = panelFigures(range,");
    expect(panel).toContain("const periodNoun = nounFor(shownPeriod, period);");
    expect(panel).toContain("return { ...rangeView(landed, period), loading };");
    for (const gone of ["fromRange ? rangeSum.cost +", "fromRange ? rangeSum.tokens", "landed.period !== period,"]) {
      expect(panel, `${gone} is decided in the component again`).not.toContain(gone);
    }
  });
});
