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
  nounFor, panelFigures, rangeView, PERIODS, periodFocusMove, sinceFor,
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
    expect(panel).toContain("{PERIODS.map((p, i) => (");
    expect(panel).toContain("aria-pressed={period === p.key}");
    expect(panel).toContain("onClick={() => setPeriod(p.key)}");
    // The hint is the shaper's too, for the same reason: `month` means what
    // `sinceFor` makes it mean, and a sentence written here could drift from it.
    // The tooltip is now a pair — what the span covers at rest, and what is
    // being read while it reads — so the assertion is that `p.hint` is still
    // the resting half rather than that it is the only half.
    expect(panel).toMatch(/title=\{period === p\.key && rangePending \? `Reading \$\{p\.noun\}[^`]*` : p\.hint\}/);
    expect(panel).not.toMatch(/title="[^"]*month/i);
  });

  it("shows the selector only when there is a source with periods in it", () => {
    // The board has exactly one span — now — so three chips over a board-only
    // panel would be three words for the same figure.
    expect(panel).toMatch(/\{fromRange && \([\s\S]{0,1600}?<div\s+className="uh-range up-period"/);
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

  it("keeps every segment pressable while a period loads", () => {
    // The first read of ANY period takes seconds — measured 2.4-2.8s across all
    // three on this deck, because what costs is walking the transcript
    // directory rather than the range asked of it — and nothing about the
    // control may change while it does. They are the reader's intent, and a
    // reader who hit the wrong word has to be able to correct it immediately.
    //
    // This used to be spelled as `not.toContain("rangeLoading")`, which banned
    // a VARIABLE NAME rather than the behaviour: it would have passed a strip
    // that disabled itself under any other identifier, and it failed the moment
    // the pending signal was drawn without disabling anything. What it was
    // reaching for is below.
    expect(panel).not.toContain("up-period-busy");
    const strip = panel.slice(panel.indexOf('className="uh-range up-period"'), panel.indexOf("</div>\n      )}"));
    expect(strip).not.toMatch(/\bdisabled\b/);
    expect(strip).not.toMatch(/pointer-events/);
    // And the press still commits unconditionally — no guard in front of it.
    expect(strip).toContain("onClick={() => setPeriod(p.key)}");
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

// ── the mark under the selected period ──────────────────────────────────────
//
// The strip is three equal segments of a 250px column and the words in them are
// not equal: `today` and `month` set 30.11px of monospace, `all` sets 18.06px.
// A mark sized as a fraction of the SEGMENT is therefore a different thing on
// each tab — it stood at 1.66x the word under `today` and 2.77x under `all`,
// where it cleared the label by 16px on either side and read as underlining the
// column. Nothing in this codebase can measure text, so the fix is structural:
// one `max-content` grid column holds the label, the ::after shares it, and the
// browser does the measuring. These assertions pin the structure, because the
// structure is the whole of the argument.
describe("the period strip's indicator", () => {
  const block = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("takes its width from the label, never from the segment", () => {
    const seg = block(".up-period .uh-range-btn");
    expect(seg).toMatch(/display:\s*grid/);
    expect(seg).toMatch(/grid-template-columns:\s*max-content/);
    // A percentage here would be a percentage of the segment again, under any
    // spelling — that is the defect, not the number 60.
    const mark = block('.up-period .uh-range-btn[aria-pressed="true"]::after');
    expect(mark).not.toMatch(/width\s*:/);
    expect(block(".up-period .uh-range-btn::after")).not.toMatch(/width\s*:\s*\d+%/);
  });

  it("occupies its row at rest, so no label steps when the period changes", () => {
    // The row is `auto` and sized by the ::after. If the ::after existed only
    // while pressed the row would collapse to 0 on the other two segments and
    // every label would sit 1px lower than the selected one — a shift the
    // reader sees as the strip twitching under their own click.
    const seg = block(".up-period .uh-range-btn");
    expect(seg).toMatch(/grid-template-rows:\s*1fr auto/);
    const rest = block(".up-period .uh-range-btn::after");
    expect(rest).toMatch(/content:\s*""/);
    expect(rest).toMatch(/height:\s*2px/);
    expect(rest).toMatch(/background:\s*transparent/);
    // And because the row is always there, the state can fade rather than
    // teleport — over the same 120ms the label's colour takes.
    expect(rest).toMatch(/transition:\s*background-color 120ms/);
  });

  it("does not let hover wear the selected colour", () => {
    // The shared chip rule repaints any hovered label in --text, which is
    // exactly what the selected label steps to. With the pointer still resting
    // on the strip after a click — the commonest frame there is — two of three
    // segments read identically and a 2px rule was the only difference left.
    expect(block(".up-period .uh-range-btn:hover"))
      .toMatch(/color:\s*color-mix\(in srgb, var\(--text\) 45%, var\(--muted\)\)/);
  });

  it("keeps the selected word legible under the pointer that chose it", () => {
    // `.uh-range-btn[aria-pressed="true"]:hover` paints the label in --bg,
    // which is right for the modal's chips — there it sits on an --accent
    // FILL. This strip has no fill, both selectors are (0,3,0), and the shared
    // one is declared later, so the selected word was --bg on --panel: 1.080:1
    // in dark, 1.132:1 in light. Gone, at the exact moment the pointer is
    // guaranteed to be on it.
    const held = block('.up-period .uh-range-btn[aria-pressed="true"]:hover');
    expect(held).toMatch(/color:\s*var\(--text\)/);
    // And it has to out-specify the shared rule, not merely restate it.
    expect(css.indexOf('.up-period .uh-range-btn[aria-pressed="true"]:hover'))
      .toBeGreaterThan(-1);
  });

  it("keeps its focus ring inside the segment and off the indicator", () => {
    // The shared `button:focus-visible` draws 2px of --accent at offset 1px.
    // On this control its bottom stroke landed on the indicator's own pixels in
    // the indicator's own colour, so the selected tab, focused, showed no
    // indicator at all; and `border-radius: 0` on the segment had shadowed the
    // global ring's 4px, leaving the one hard-cornered ring in the deck.
    const ring = block(".up-period .uh-range-btn:focus-visible");
    expect(ring).toMatch(/outline-offset:\s*-4px/);
    expect(ring).toMatch(/border-radius:\s*4px/);
  });
});

// ── the strip as a keyboard control, and as a remembered one ────────────────
//
// Three things the panel did not do, added together because they are one
// complaint: the strip cost more of the reader's keyboard than it was worth,
// it forgot the answer it had been given, and the middle word did not say what
// it meant. None of them is visible in a screenshot.
describe("the period strip's keyboard and memory", () => {
  it("moves the ring with the arrows and both ends, and nothing else", () => {
    // Wrapping, because three members with a hard stop at each end reads as
    // the key having failed rather than as a boundary.
    expect(periodFocusMove("ArrowRight", 0)).toBe(1);
    expect(periodFocusMove("ArrowRight", 2)).toBe(0);
    expect(periodFocusMove("ArrowLeft", 0)).toBe(2);
    expect(periodFocusMove("ArrowLeft", 2)).toBe(1);
    // Down and Up alias Right and Left: the strip is one row, and a reader who
    // reaches for the vertical pair on a horizontal group has not made a
    // mistake worth a dead key.
    expect(periodFocusMove("ArrowDown", 1)).toBe(2);
    expect(periodFocusMove("ArrowUp", 1)).toBe(0);
    expect(periodFocusMove("Home", 2)).toBe(0);
    expect(periodFocusMove("End", 0)).toBe(2);
    for (const key of ["Enter", " ", "Tab", "Escape", "a", "PageDown"]) {
      expect(periodFocusMove(key, 1), `${key} is swallowed`).toBeNull();
    }
    // A caller that has lost the selected period must not be handed an index.
    expect(periodFocusMove("ArrowRight", 0, 0)).toBeNull();
  });

  it("pays for the role it announces", () => {
    // tablist-contract.test.ts's rule, applied to the neighbouring role: a
    // toolbar promises one tab stop and arrows across the members. Both are
    // here, or the role is a lie.
    expect(panel).toContain('role="toolbar"');
    expect(panel).toContain('aria-orientation="horizontal"');
    expect(panel).toContain("tabIndex={period === p.key ? 0 : -1}");
    // From the focused segment, never from the selected one. Reckoning off
    // `period` walks one step and then stops — Right three times from `today`
    // gives `month`, `month`, `month` — and it looked correct in the source.
    expect(panel).toContain("periodRefs.current.indexOf(e.target as HTMLButtonElement)");
    expect(panel).toContain("periodFocusMove(e.key, from)");
    expect(panel).not.toContain("periodFocusMove(e.key, PERIODS.findIndex");
    // The arrows have to stop being the page's arrows, or the panel scrolls
    // under the ring the moment it moves.
    expect(panel).toMatch(/if \(to === null\) return;\s*\n\s*e\.preventDefault\(\);/);
    expect(panel).toContain("periodRefs.current[to]?.focus();");
    // And it must not have become the thing #381 deleted. Read with the
    // comments stripped: the block above this markup names that role in order
    // to say why it is wrong, and a substring match cannot tell the two apart.
    const code = panel.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain('role="tablist"');
    expect(code).not.toContain('role="tab"');
  });

  it("moves focus without committing a period", () => {
    // Arrowing PAST `all` would otherwise start a read of every transcript on
    // disk on the way to something else. The arrows move the ring; the click
    // handler is the only place a period is chosen.
    const handler = panel.slice(panel.indexOf("onKeyDown={e => {"), panel.indexOf("periodRefs.current[to]?.focus();"));
    expect(handler).not.toContain("setPeriod");
  });

  it("remembers the period, under a key of the deck's own shape", () => {
    expect(panel).toContain('const PERIOD_KEY = "agent-dag.usagePeriod";');
    expect(panel).toContain("useState<PeriodKey>(loadPeriod)");
    expect(panel).toContain("useEffect(() => { savePeriod(period); }, [period]);");
    // Through storage.ts, because the bare property read throws outright on a
    // browser that blocks site data — and this one runs in a useState
    // initialiser, so it would take the panel's first render with it.
    expect(panel).toContain('import { readStored } from "../storage";');
    expect(panel).toMatch(/function loadPeriod\(\)[\s\S]{0,240}readStored\(PERIOD_KEY\)/);
    // Validated, not cast. The store holds whatever was last written into it —
    // an older build's spelling, or a hand edit — and an unknown period would
    // ask /api/ccusage for a range it cannot spell.
    expect(panel).toContain("PERIODS.some(p => p.key === stored)");
    expect(panel).toMatch(/function savePeriod[\s\S]{0,200}catch \{/);
  });

  it("says a read is running, where the finger just was", () => {
    // MEASURED FIRST. The first read of any period is 2.4-2.8s and every read
    // of a range already fetched is 10ms from the server's cache — so the wait
    // is uniform, lands on the first press of each word, and is long enough
    // that a panel which only dims looks broken rather than busy.
    //
    // `loading && stale`, and both halves earn their place. `loading` alone
    // would fire on the five-minute poll of the range already on screen;
    // `stale` alone would keep saying "reading" for good after a fetch that
    // FAILED, because a failure leaves the figures stale and nothing coming.
    expect(panel).toContain("const rangePending = rangeLoading && rangeStale;");
    expect(panel).toContain('data-pending={period === p.key && rangePending ? "" : undefined}');
    expect(panel).toContain("aria-busy={rangePending || undefined}");
    // The mark that already says WHICH period is the one that says it is being
    // fetched — nothing new appears. Keyed on the attribute alone so it stays
    // out of the set of scoped state rules usage-series-contrast holds to three.
    const at = css.indexOf("\n.up-period .uh-range-btn[data-pending]::after {");
    expect(at, "no pending rule for the indicator").toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).toMatch(/animation: up-period-reading 1100ms/);
    expect(rule, "the accent may not be diluted, even while it moves")
      .not.toMatch(/--accent-dim|color-mix[^;]*--accent|background/);
    // Compositor-only, so a 2px grid item cannot reflow the label above it.
    const frames = css.slice(css.indexOf("@keyframes up-period-reading"));
    expect(frames.slice(0, frames.indexOf("\n}"))).not.toMatch(/width|height|margin|padding/);
  });

  it("stops the loop under reduced motion without hiding the wait", () => {
    // A pulse is motion and a loop is the kind that has to stop first. The
    // figures are still dimmed and the live region still speaks, so nothing
    // about the wait lives only in the animation.
    const rm = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(rm).toContain(".up-period .uh-range-btn[data-pending]::after { animation: none; }");
  });

  it("says the wait out loud, from a region that was already there", () => {
    // Until now a reader who could not see the strip pressed `all` and got two
    // and a half seconds of nothing: no announcement, nothing disabled, and
    // figures that were the previous period's.
    //
    // Always mounted with only its text moving. A live region registers when it
    // ENTERS the tree, so text arriving in the same tick as the region is
    // routinely never spoken — rendering this only while pending would put the
    // region and its one sentence on screen together, and take it away again
    // before it could say the wait was over. App.tsx's blocked-session region
    // is the precedent and carries the whole argument.
    expect(panel).toMatch(/<div className="vis-hidden" role="status" aria-atomic="true">/);
    expect(panel).toContain('{rangePending ? `Reading ${nounFor(period, period)}…` : ""}');
    // Polite, not assertive: a figure two seconds late costs nothing and
    // talking over the reader costs a sentence.
    const at = panel.indexOf('<div className="vis-hidden" role="status"');
    expect(panel.slice(at, at + 200)).not.toContain('role="alert"');
  });

  it("says what each span actually covers, from the shaper that decides it", () => {
    // `month` is the one that needed this: three bare words read as a scale,
    // and a reader who takes the middle of a scale for a rolling 30 days is
    // wrong by up to 30 days on the 1st with nothing on screen to correct them.
    const month = PERIODS.find(p => p.key === "month")!;
    expect(month.hint).toMatch(/calendar month/i);
    expect(month.hint).toMatch(/not the last 30 days/i);
    for (const p of PERIODS) expect(p.hint, `${p.key} has no hint`).toMatch(/\S/);
    // And the sentence has to stay true of `sinceFor`, which is what actually
    // asks for the range: the month starts on the 1st, locally.
    const may = new Date(2026, 4, 17, 9, 30);
    expect(sinceFor("month", may)).toBe("20260501");
    expect(sinceFor("today", may)).toBe("20260517");
  });
});

// ── the one section that shuts ──────────────────────────────────────────────
//
// Every other block in this panel is a fixed two or three rows, or a model
// table bounded by the models that exist. The session list is as long as the
// reader's week, and it was the reason the panel scrolled at all: measured on
// this deck, 1078px of content in a 935px column with it open, 754 in 754 with
// it shut. So it shuts, and it is the only one that does.
describe("the session section's disclosure", () => {
  const block = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("puts the button inside the heading rather than instead of it", () => {
    // The ARIA disclosure pattern, and the one spelling that keeps four
    // headings in the document outline while still giving the reader a real
    // control — landmark-outline.test.ts counts them and would have lost one.
    expect(panel).toMatch(/<h3 className="up-section-title">\s*<button/);
    expect(panel).toContain('className="up-disclose"');
    expect(panel).toContain("aria-expanded={sessionsOpen}");
    expect(panel).toContain('aria-controls="up-sessions"');
    expect(panel).toContain('id="up-sessions"');
    expect(panel).toContain("hidden={!sessionsOpen}");
  });

  it("hides the list in CSS as well as in the attribute", () => {
    // `[hidden]` alone does NOT hide this. The attribute works through a UA
    // rule — `[hidden] { display: none }` — and ANY author declaration of
    // `display` outranks the whole UA sheet. `.up-sessions` declares `flex`,
    // so the measured result was: attribute set, `el.hidden` true, twelve rows
    // on screen and in the accessibility tree. Silent in both directions.
    expect(block(".up-sessions")).toMatch(/display:\s*flex/);
    expect(css).toContain(".up-sessions[hidden] { display: none; }");
  });

  it("takes the whole heading as the target, and gives the height back", () => {
    // A 9px chevron is a 9px hit area for a section-sized decision, and
    // SC 2.5.8 asks 24 of the short side. The heading's ink is 15.9px tall, so
    // the padding buys the difference and the negative margin returns it to the
    // layout: the button's border box measures 25.9, its margin box measures
    // what the words always did, and the section keeps the rhythm of the three
    // headings above it.
    const b = block(".up-disclose");
    expect(b).toMatch(/padding:\s*5px 0/);
    expect(b).toMatch(/margin:\s*-5px 0/);
    expect(b).toMatch(/flex:\s*1 1 auto/);
    // And it has to be invisible as a control: same font, same colour, same
    // left edge as the three headings that do not open.
    expect(b).toMatch(/font:\s*inherit/);
    expect(b).toMatch(/color:\s*inherit/);
    expect(b).toMatch(/text-align:\s*left/);
    expect(b).toMatch(/background:\s*transparent/);
    expect(b).toMatch(/border:\s*none/);
  });

  it("turns the chevron rather than swapping two glyphs", () => {
    // `.bw-chev` prints ▾ and ▸ and is at the mercy of whichever font answers
    // for them on Windows and Linux. A path is the same three strokes on every
    // OS, and it can rotate instead of being replaced.
    expect(panel).toContain('<svg className="up-chev"');
    expect(panel).not.toMatch(/up-chev[^>]*>\s*[▾▸▼►]/);
    expect(block('.up-disclose[aria-expanded="true"] .up-chev')).toMatch(/transform:\s*rotate\(180deg\)/);
    // Under reduced motion it still turns — it just stops travelling.
    // `transform: none` there would have frozen it pointing down over an open
    // section, which is the one thing it must never do.
    const rm = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(rm).toContain(".up-chev { transition: none; }");
    expect(rm).not.toMatch(/\.up-chev[^{]*\{[^}]*transform:\s*none/);
  });

  it("remembers whether it is open, and starts shut", () => {
    expect(panel).toContain('const SESSIONS_OPEN_KEY = "agent-dag.usageSessionsOpen";');
    expect(panel).toContain("useState<boolean>(loadSessionsOpen)");
    expect(panel).toContain("useEffect(() => { saveSessionsOpen(sessionsOpen); }, [sessionsOpen]);");
    // Shut is the default, which is the deliberate half. An absent key, a
    // blocked store and a junk value all have to land on the same answer, and
    // `=== "1"` is the spelling that gives it: anything that is not the string
    // written by `saveSessionsOpen` reads as shut.
    expect(panel).toMatch(/function loadSessionsOpen\(\)[\s\S]{0,160}readStored\(SESSIONS_OPEN_KEY\) === "1"/);
    expect(panel).toMatch(/function saveSessionsOpen[\s\S]{0,220}catch \{/);
  });

  it("says how much is behind it, on the title rather than in ink", () => {
    // Shut, the reader cannot see how many sessions there are, and that is the
    // one fact the collapse actually takes away. The heading already carries
    // two things; a third in ink would be the noise this panel is short of.
    expect(panel).toContain("const sessionCount = fromRange ? rangeSessionRows.length : boardSessionRows.length;");
    expect(panel).toMatch(/Show the per-session breakdown — \$\{sessionCount\} session\$\{sessionCount === 1 \? "" : "s"\}/);
    expect(panel).toContain('"Hide the per-session breakdown"');
  });
});

// ── the scrollbar, which is not there until it is asked for ─────────────────
describe("the scrollbar at rest", () => {
  it("fades the thumb and never the track's width", () => {
    // Asking for `::-webkit-scrollbar` at all opts Chrome out of the overlay
    // bar macOS draws, so these 10px are real layout — and on Windows and Linux
    // they are real layout in every browser. A rule that took the width back at
    // rest would reflow the panel under the pointer as it arrived, on the two
    // platforms this repo cannot render. Measured: clientWidth 267 in both
    // states.
    const bar = css.slice(css.indexOf("*::-webkit-scrollbar {"), css.indexOf(":hover, :focus-within { scrollbar-color"));
    expect(bar).toMatch(/\*::-webkit-scrollbar \{ width: 10px; height: 10px; \}/);
    expect(bar).not.toMatch(/:hover[^{]*::-webkit-scrollbar \{/);
    const thumb = css.slice(css.indexOf("*::-webkit-scrollbar-thumb {"), css.indexOf("}", css.indexOf("*::-webkit-scrollbar-thumb {")));
    expect(thumb).toMatch(/background-color:\s*transparent/);
    // The border was `var(--bg)` — a hairline of the CANVAS colour drawn over
    // whatever surface the scroller has, right on one scroller and wrong on
    // every panel. Transparent, with the clip doing what the colour was doing.
    expect(thumb).toMatch(/border:\s*2px solid transparent/);
    expect(thumb).toMatch(/background-clip:\s*padding-box/);
    expect(thumb).not.toMatch(/var\(--bg\)/);
  });

  it("comes back for a pointer and for a keyboard alike", () => {
    // A bar that only exists under a pointer does not exist for the reader
    // arrowing through the thing it measures.
    expect(css).toMatch(/:hover::-webkit-scrollbar-thumb,\s*\n:focus-within::-webkit-scrollbar-thumb \{ background-color: var\(--line\); \}/);
    // Firefox's half, in its own property, degrading to today's always-visible
    // bar if it declines a transparent thumb.
    expect(css).toContain("* { scrollbar-color: transparent transparent; scrollbar-width: thin; }");
    expect(css).toContain(":hover, :focus-within { scrollbar-color: var(--line) transparent; }");
    // The thumb's own hover has to stay the loudest of the three, so it is
    // declared last where source order settles the tie at equal specificity.
    expect(css.indexOf("*::-webkit-scrollbar-thumb:hover"))
      .toBeGreaterThan(css.indexOf(":focus-within::-webkit-scrollbar-thumb"));
  });
});
