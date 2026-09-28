// UsagePanel — floating panel showing aggregated token usage and cost
// across all sessions, by model and by session. Toggled via $ button
// in the topbar or the U keyboard shortcut.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtCost, fmtCostRate, UNPRICED_LABEL } from "../pricing";
import { countTo } from "../count-up";
import { boardBySession, liveDelta, NO_DELTA, type SessionUsage } from "../live-delta";
import { recordSpend, spendRate, NO_SPEND_HISTORY, type SpendHistory } from "../spend-rate";
import {
  boardModelTable, boardSessionTable, boardTotals, BOARD_SCOPE_LABEL, BOARD_SCOPE_TITLE, BOARD_SPEND_LABEL,
  UNKNOWN_MODEL, type BoardSessionRow,
} from "../board-usage";
import {
  PERIODS, periodFocusMove, modelRows as ccModelRows, sessionRows as ccSessionRows,
  rangeTotals, sessionListScale, sessionListNote, nounFor, panelFigures,
  type PeriodKey, type UsageRange,
} from "../usage-from-ccusage";
import { readStored } from "../storage";
import type { GraphState } from "../reducer";
import type { AgentState } from "../types";
import { fmtTokens } from "../token-format";
import type { Providers } from "../providers";
import { shortModel } from "../model-label";
import CostBar from "./CostBar";
import { ClaudeQuotaSection, CodexQuotaSection } from "./QuotaSections";
import { stateLabel } from "./AgentNode";
import { selfPressProps } from "../panel-press";
import { useCodexQuota, useCodexUsage, useQuota } from "../use-quota";
import { useUsageRange } from "../use-usage-range";

/** Where the chosen period lives between reloads.
 *
 *  It was the one preference in this panel that did not survive one. The deck
 *  remembers whether the panel is open and which theme it is in, and a reader
 *  who works in `month` re-selected it on every reload — which is also the
 *  slowest of the three to answer, so the cost of forgetting was paid twice.
 *
 *  Read through storage.ts rather than off `window.localStorage`: this runs
 *  inside a useState initialiser and the property access itself throws on a
 *  browser that blocks site data, which would take the panel's first render
 *  with it. And validated against PERIODS rather than cast, because the stored
 *  string is whatever was in the store — an older build's key, or a hand edit —
 *  and an unknown period would ask /api/ccusage for a range it cannot spell.
 */
const PERIOD_KEY = "agent-dag.usagePeriod";

function loadPeriod(): PeriodKey {
  const stored = readStored(PERIOD_KEY);
  return PERIODS.some(p => p.key === stored) ? (stored as PeriodKey) : "today";
}

function savePeriod(period: PeriodKey): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(PERIOD_KEY, period); } catch { /* private mode */ }
}

/** Whether the session list is open, and it is shut until asked for.
 *
 *  It is the one unbounded block in this panel — every other section is a
 *  fixed two or three rows, or a model table that cannot exceed the models
 *  that exist — and it is the reason the panel scrolls at all. Shut, the whole
 *  panel is one screen: quota, period, money, models. The reader who wants the
 *  per-session breakdown asks for it and gets it, and their answer is
 *  remembered, so this costs them one press once rather than one press a day.
 *
 *  Defaults SHUT rather than open, which is the deliberate half of this. The
 *  section is the panel's deepest detail and its least glanceable; the figure
 *  most readers open this panel for is the one at the top.
 */
const SESSIONS_OPEN_KEY = "agent-dag.usageSessionsOpen";

function loadSessionsOpen(): boolean {
  return readStored(SESSIONS_OPEN_KEY) === "1";
}

function saveSessionsOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(SESSIONS_OPEN_KEY, open ? "1" : "0"); } catch { /* private mode */ }
}


// The rows of the two board tables, and UNKNOWN_MODEL, are board-usage.ts's,
// with the folds that build them (#1175).

// The stacked cost bar this panel drew is components/CostBar.tsx now — it was
// written out here, in App.tsx and in SessionSummary.tsx, and #381's role fix
// had to be made three times because of it (#374). The reasoning behind the
// role, which was written in this file, moved to the component with it.
//
// The quota bars' countdown went to relative-time.ts for the same reason: the
// accounts panel had one too, and the two render the same quota reset. The
// bars themselves, and the pace they draw, are components/QuotaBar.tsx, and the
// two sections that draw them are components/QuotaSections.tsx, with the words
// each prints when it has nothing to show.
//
// The three quota reads, and the shapes their routes answer in, are
// use-quota.ts; the ccusage read for the chosen period is use-usage-range.ts.

interface Props {
  state: GraphState;
  now: number;
  /** Which CLIs this deck watches — see src/web/providers.ts. */
  providers: Providers;
  /** Asked to close, still on screen for the length of its exit. */
  leaving?: boolean;
  onClose: () => void;
}

/**
 * A figure that counts to its new value instead of teleporting to it.
 *
 * `key` is what the number MEANS — the period it belongs to. When that changes,
 * the value snaps: "today $269" and "all time $12.4k" are different quantities,
 * and counting between them would be theatre rather than a delta. Within one
 * period, a five-minute poll can move a total while somebody is looking at it,
 * and a count says which way and roughly how far.
 *
 * See count-up.ts for what deliberately does not animate — the first paint, a
 * change too small to read, and the tables.
 */
function useCountUp(value: number): number {
  const [shown, setShown] = useState(value);
  // What is on screen right now, so a second change starts a count from where
  // the number IS rather than from where the last one began.
  const currentRef = useRef(value);
  const firstRef = useRef(true);

  useEffect(() => {
    currentRef.current = shown;
  }, [shown]);

  useEffect(() => {
    // ONLY THE FIRST PAINT SNAPS. Pressing `month` or `all` counts too — the
    // figures ride up to twelve thousand or back down to three hundred, which
    // is the one place in this panel where the size of the difference between
    // two periods is worth feeling. It was a snap at first, on the reasoning
    // that two periods are different quantities rather than one that moved;
    // that reasoning is sound and the motion is still better, because the
    // reader pressed the button and is watching the number they asked for.
    if (firstRef.current) {
      firstRef.current = false;
      currentRef.current = value;
      setShown(value);
      return;
    }
    const stop = countTo(currentRef.current, value, v => {
      currentRef.current = v;
      setShown(v);
    });
    return stop;
  }, [value]);

  return shown;
}

export default function UsagePanel({ state, now, providers, leaving, onClose, liveSince = null }: Props & {
  /** When the stream's replay landed, or null while there is none — see App.tsx.
   *  The $/min counts only from here (#821). */
  liveSince?: number | null;
}) {
  const { quota, loading: quotaLoading, refresh: refreshQuota } = useQuota(providers.claude);
  const { data: codexQuota, loading: codexLoading, refresh: refreshCodex } = useCodexQuota(providers.codex);
  const { data: codexUsage } = useCodexUsage(providers.codex);

  // Tick every 30s so countdowns + pace stay live without parent re-render
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(t);
  }, []);
  /** Per-session spend against the clock, for the header's $/min (#821). A ref,
   *  because the samples are history the memo below reads and extends — not
   *  state, which would re-render the panel for every sample it takes. */
  const spendSamples = useRef<SpendHistory>(NO_SPEND_HISTORY);
  /** The replay the samples above were taken after. A new one — a reconnect —
   *  starts them again, since it re-applies the ring the board was built from. */
  const spendSince = useRef<number | null>(null);

  // Both memos below key on `state.revision`, not on `state.lastSeq`. The
  // `state` prop is `stateRef.current` and `applyEvent` mutates it in place, so
  // its identity never moves after mount and the second dep is the whole of
  // what decides whether either of these recomputes. `lastSeq` answers "when did
  // the last envelope arrive", which is a different question from "has anything
  // in here changed": the four periodic sweeps mutate this same object every
  // 250ms tick and move only `revision` — see the note on GraphState.
  //
  // This one carries `now` as well, because `burnRate` samples the board total
  // against the clock (spend-rate.ts, #821) and has to keep moving while nothing
  // arrives. That third dep is
  // also what hid the wrong second one: `now` is a fresh Date.now() every tick,
  // so this recomputed four times a second whatever `lastSeq` said, and the
  // headline strip stayed honest through a prune by luck rather than by rule.
  // `bySessions` below has no clock in it, and it is the one that went stale.
  const { byModel, totalCost, totalTokens, burnRate } = useMemo(() => {
    // The headline's own arithmetic is `boardTotals`, called once below rather
    // than accumulated here (#687). It was a second copy of the topbar's, and
    // the file it moved to is the file that declares what the figure may be
    // called — which is the whole of the fix: the sum walks the agents on the
    // canvas, the pruners take agents off the canvas, and the only honest label
    // for such a number names the canvas. Splitting the label from the sum is
    // how "total spend" came to stand over a figure that falls by a third on a
    // quiet tick.
    //
    // The table is one pass per MODEL SHARE (#686), in board-usage.ts beside
    // `boardTotals` so the rows and the headline price the same shares through
    // the same helper — see boardModelTable.
    const byModel = boardModelTable(state.agents.values());

    const board = boardTotals(state.agents.values());
    // How fast the board is spending: its total's rise over the last ten minutes
    // (#821), not live agents' cost over the longest one's age — see
    // spend-rate.ts for why that swung eightfold between two tabs of one deck.
    // And only once the replay has landed: before that the board total is
    // history arriving, not spending (see liveSince in App.tsx).
    if (spendSince.current !== liveSince) {
      spendSince.current = liveSince;
      spendSamples.current = NO_SPEND_HISTORY;
    }
    // PER SESSION, not the board total (#987). The board gains a session's whole
    // accumulated cost the moment it first reaches the canvas, and against one
    // total that is indistinguishable from spending: a joining session carrying
    // $15 of history took a true $0.20/min to $1.70/min and held it for the
    // full ten-minute window. This is the same map the live delta below is
    // built on, and the same rule — only work the deck watched happen counts.
    const bySession = boardBySession(state.agents.values(), now);
    if (liveSince != null) spendSamples.current = recordSpend(spendSamples.current, now, bySession);
    const rate = liveSince == null ? null : spendRate(spendSamples.current, now, bySession);
    const burnRate = rate ? { label: fmtCostRate(rate.spent, rate.spanSec), spanMin: rate.spanMin } : null;
    return {
      byModel,
      totalCost: board.cost,
      totalTokens: board,
      burnRate,
    };
  }, [state, state.revision, now, liveSince]);

  // No clock in these deps, and none wanted — every figure in a row is a running
  // total, not an elapsed time. That made this the one memo in the panel with
  // nothing to mask the wrong dependency, and #575 is what it cost: on a quiet
  // deck `pruneDoneSessions` evicts a finished session two minutes after it
  // ends, the canvas drops its cards and the strip above drops its dollars, and
  // these rows kept theirs — so the "By session" table summed past the total
  // printed over it and no click would reconcile the two, because the next
  // envelope that would have moved `lastSeq` never came. `s.state` froze the
  // same way: `sweepStaleSessions` settles a killed terminal's root to `done` at
  // ninety minutes, and the row's dot stayed green and its hidden word stayed
  // "active" for as long as the tab was open.
  const bySessions = useMemo(
    // One row per root with its same-session subagents folded in, cost first
    // and tokens as the tiebreak, cut at twelve — see boardSessionTable.
    (): BoardSessionRow[] => boardSessionTable(state.agents.values()),
    [state, state.revision],
  );

  // ── which source the figures come from ──────────────────────────────────
  //
  // ccusage when it answered, the board when it did not. Everything below this
  // point reads one pair of lists and one pair of totals, so the two sources
  // meet here and nowhere else — the tables, the strip and the headline are the
  // same markup either way.
  const [period, setPeriod] = useState<PeriodKey>(loadPeriod);
  useEffect(() => { savePeriod(period); }, [period]);
  const [sessionsOpen, setSessionsOpen] = useState<boolean>(loadSessionsOpen);
  useEffect(() => { saveSessionsOpen(sessionsOpen); }, [sessionsOpen]);
  // One tab stop for the strip, not three. `role="toolbar"` is what pays for
  // that — see the markup — and moving the ring needs the buttons themselves.
  const periodRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [rangeRefresh, setRangeRefresh] = useState(0);
  // `loading` on its own is not a state this panel shows, and that has not
  // changed: a refresh of the range already on screen moves no figure the
  // reader can act on, and dimming for it would make the panel flicker every
  // five minutes on its own poll. What is read below is `loading AND stale` —
  // a fetch genuinely in flight FOR A PERIOD THAT IS NOT THE ONE SHOWN.
  // What the board sums to right now, behind a stable identity. `state` and
  // `now` move constantly, so handing the hook a fresh closure would re-run its
  // fetch on every 250ms tick; the ref is reassigned each render and the
  // callback that reads it never changes.
  const boardNowRef = useRef<() => ReadonlyMap<string, SessionUsage>>(() => new Map());
  boardNowRef.current = () => boardBySession(state.agents.values(), now);
  const takeBaseline = useCallback(() => boardNowRef.current(), []);

  const { data: range, shown: shownPeriod, stale: rangeStale, loading: rangeLoading, baseline } =
    useUsageRange(period, rangeRefresh, takeBaseline);
  const fromRange = range != null;

  /**
   * A read for the pressed period is running, and what is on screen is not it.
   *
   * MEASURED BEFORE IT WAS DRAWN, because the comments here used to say "ccusage
   * against 'all time' takes seconds" and that is only half true. On this deck:
   * the first read of ANY period is 2.4-2.8s — today, this month and all time
   * within four tenths of each other, because what costs is walking the
   * transcript directory rather than the range asked of it — and every read of
   * a range already fetched is 10ms, from the server's own cache. So the wait is
   * uniform, it happens on the first press of each word, and after that the
   * strip is instant for the rest of the session. Two and a half seconds of a
   * panel that only dims is a panel that looks broken rather than busy.
   *
   * `loading && stale` rather than `loading`, for the reason above it, and
   * rather than `stale` alone for a reason that matters more: a fetch that
   * FAILS leaves the figures stale for good, and an indicator keyed on staleness
   * would then say "reading" forever. `loading` clears in the fetch's own
   * `finally`, so a failure stops the signal and leaves the figures dimmed —
   * which is the truth: they are the previous period's, and nothing is coming.
   */
  const rangePending = rangeLoading && rangeStale;

  // The board's own names, by session id. ccusage knows what a session cost and
  // the canvas knows what to call it; `period` on a ccusage session row is the
  // session id, which is the same key the canvas files its agents under.
  const boardNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const a of state.agents.values()) {
      // The same label the board's own session rows use — a.label when the
      // session has been named, the working directory otherwise. Roots only:
      // a subagent carries its parent's sessionId and would overwrite the
      // session's name with a tool's.
      if (a.kind !== "root" || !a.sessionId) continue;
      const label = a.label || a.cwdBasename;
      if (label) names.set(a.sessionId, label);
    }
    return names;
  }, [state, state.revision]);

  // What the canvas is doing right now, by the same key. A ccusage row for a
  // session that finished last week has no state to report and gets no dot;
  // one that is on the board keeps the dot the session list draws for it.
  const boardStates = useMemo(() => {
    const st = new Map<string, AgentState>();
    for (const a of state.agents.values()) {
      if (a.kind !== "root" || !a.sessionId) continue;
      st.set(a.sessionId, a.state);
    }
    return st;
  }, [state, state.revision]);

  const rangeModelRows = useMemo(() => (fromRange ? ccModelRows(range) : []), [range, fromRange]);
  // Cut at twelve, the same as the board's list and for the same reason: this
  // is a 280px column, and "all time" on a machine that has run coding CLIs for
  // a year is hundreds of sessions. The rows are sorted by cost before the cut,
  // so what survives is the spend worth looking at.
  const rangeSessionRows = useMemo(() => {
    if (!fromRange) return [];
    const rows = ccSessionRows(range, boardNames).slice(0, 12);
    // Two sessions in the same folder is the normal case here — parallel
    // agents, or one deck restarted — and both then arrive under the same
    // project name. Identical rows carrying different figures read as a bug in
    // the panel, so a repeated name takes the head of its session id. Only a
    // repeated one: the common case is a list of distinct projects, and a uuid
    // fragment on every row would be noise on a 280px column.
    const seen = new Map<string, number>();
    for (const r of rows) if (r.label) seen.set(r.label, (seen.get(r.label) ?? 0) + 1);
    return rows.map(r => (r.label && (seen.get(r.label) ?? 0) > 1
      ? { ...r, label: `${r.label} ${r.sessionId.slice(0, 4)}` }
      : r));
  }, [range, fromRange, boardNames]);
  const rangeSum = useMemo(() => rangeTotals(range), [range]);
  // Off the WHOLE list, which is why it is not folded into `rangeSessionRows`
  // above: those are cut at twelve and would under-count by everything the cut
  // took away. See sessionListScale for what the two generations of ccusage
  // each do to a session's totals, and why the panel measures instead of
  // naming one of them.
  const sessionScale = useMemo(() => sessionListScale(range, rangeSum.cost), [range, rangeSum.cost]);

  // The word over the figures names the range the figures came from, not the
  // chip the reader just pressed. While a slower range loads, the panel reads
  // "$4.20 today" with `all` pressed and dimmed — never "$4.20 all time".
  const periodNoun = nounFor(shownPeriod, period);

  // WHAT DIMS WHILE A SLOWER RANGE LOADS, and it is the numbers rather than the
  // chips. The sheet's own rule: --dim-off means "this control cannot be
  // operated" and --dim-stale means "a newer reading is on its way, this one was
  // true a moment ago". Dimming the strip said the first about controls that
  // stay pressable; dimming the figures says the second about the figures, which
  // is what is actually out of date.
  const staleCls = rangeStale ? " up-stale" : "";

  // WHAT HAS HAPPENED SINCE THE READING WAS TAKEN, from the canvas.
  //
  // ccusage is the truth and it costs a process that walks every transcript on
  // the machine — 7.8 CPU-seconds here — so it is asked once a minute and no
  // oftener. In between, the deck already knows: every hook event carries its
  // session's cumulative usage, so the board holds an exact running total for
  // free. The baseline is taken the moment a reading lands, and everything
  // gained since is added on top. The figures then move when the work happens
  // rather than on the minute, at no cost at all.
  //
  // The tokens are exact. The DOLLARS on the delta are priced by this deck's
  // own table rather than by ccusage's — they agree on every model both know,
  // and where they do not it is a minute of one session's spend, corrected at
  // the next reading. See live-delta.ts.
  // No effect and no ref: `baseline` arrives from the hook inside the same
  // object as the reading it belongs to, so there is no render on which this
  // memo can pair one with the other's starting point (#784).
  const delta = useMemo(
    () => (fromRange ? liveDelta(baseline, boardBySession(state.agents.values(), now)) : NO_DELTA),
    [state, state.revision, baseline, fromRange, now],
  );

  // Every figure and its source, paired in one place — usage-from-ccusage.ts,
  // where a test can call it. These used to be five ternaries here and a sixth
  // and seventh above, and nothing could check that all seven agreed about
  // which source they were reading; the file that tried matched the panel's
  // source text.
  const figures = panelFigures(range, { ...totalTokens, cost: totalCost }, delta);
  const hasCost = figures.hasCost;
  const totalTokenSum = figures.tokenSum;

  const shownCost   = useCountUp(figures.cost);
  const shownIn     = useCountUp(figures.inputTokens);
  const shownOut    = useCountUp(figures.outputTokens);
  const shownCacheR = useCountUp(figures.cacheReadTokens);
  const shownCacheC = useCountUp(figures.cacheCreateTokens);
  // Rows worth a line, which is not the same question as rows worth a dollar.
  // Both tables used to filter on `cost > 0`, and in a deck holding one priced
  // Claude session and any number of unpriced Codex ones that filter was
  // invisible: `hasCost` was true, so the tables rendered, and every Codex row
  // was dropped out of them while its tokens stayed in the strip above. The
  // panel's own headline number then matched no visible row — the arithmetic
  // was right and there was nothing on screen to reconcile it against.
  const boardModelRows   = byModel.filter(m => m.cost.total > 0 || (m.inputTokens + m.outputTokens) > 0);
  const boardSessionRows = bySessions.filter(s => s.cost > 0 || (s.inputTokens + s.outputTokens) > 0);
  // A model ccusage priced at nothing is one IT does not know, and the note
  // below means the same thing either way: these tokens are real and their
  // dollars are not in the total above them.
  const hasUnpriced = fromRange
    ? rangeModelRows.some(m => m.cost <= 0 && m.tokens > 0)
    : boardModelRows.some(m => !m.priced);

  const anyLoading = quotaLoading || codexLoading;

  // The header's ↻ means "everything on this panel", and the range is now part
  // of everything. `refresh=1` on that path is what forces a new ccusage child
  // rather than the 2-minute cached reading — a manual press is the one moment
  // paying for a fresh run is right.
  const refreshAll = () => { refreshQuota(); refreshCodex(); setRangeRefresh(n => n + 1); };

  // One string, used as both the ↻'s tooltip and its accessible name (#381).
  // The button's whole content is a single glyph, so `title` was the only name
  // it had — a valid last-resort source, and one that touch users never see and
  // that some screen readers are configured never to read. Sharing the string
  // rather than writing a second one also keeps 2.5.3 satisfied by
  // construction: the name a voice-control user says is the words the tooltip
  // shows, per provider, and cannot drift into promising a section that is not
  // rendered.
  const refreshLabel = providers.claude && providers.codex
    ? "Refresh Claude + Codex quota"
    : providers.codex ? "Refresh Codex quota"
      : "Refresh Claude quota";

  return (
    // The id is the target of the topbar toggle's aria-controls. It is spelled
    // the same as the class on purpose: one name for the region, so the button
    // that opens it cannot point somewhere else after a rename.
    //
    // <aside>, not <div> (#381). The aria-label below has been here since the
    // panel was written and did nothing at all: a <div> with no role resolves
    // to `generic`, and the accessibility tree drops the name off a generic
    // element rather than exposing an unnamed nameless box. #373 saw this shape
    // and called it a naming defect rather than a state one, which is what it
    // is — the label was never wrong, it had nothing to attach to. An <aside>
    // outside any sectioning content is a `complementary` landmark, which does
    // take a name, and complementary is what this panel is: spend beside the
    // canvas, openable and closable without changing what the canvas shows.
    <aside className={`usage-panel${leaving ? " leaving" : ""}`} id="usage-panel" aria-label="Usage">
      <div className="up-header">
        {/* h2, under the topbar's h1 (#381). Same level as the other panels'
            titles, and the four `up-section-title`s below stepped from h4 to h3
            with it, so the panel reads h1 → h2 → h3 with nothing skipped. */}
        <h2>Usage</h2>
        {/* Says what it measured (#821): a rate with no span beside it read as a
            fact about the account rather than about the last few minutes. */}
        {burnRate && (
          <span className="up-rate" title={`Spend on this board over the last ${burnRate.spanMin} min`}>
            {burnRate.label}<span className="up-rate-span"> · {burnRate.spanMin} min</span>
          </span>
        )}
        <div className="up-header-right">
          {/* Named after what is actually below it, and gone when neither
              section is. On a Codex-only deck "Refresh Claude + Codex quota"
              promises a section that is not there, which is the same lie in
              miniature as the panel this change removed; with both CLIs absent
              the control refreshes nothing at all. */}
          {(providers.claude || providers.codex) && (
          <button
            type="button"
            className="glyph-btn up-refresh-btn"
            onClick={refreshAll}
            /* #620: this was `disabled={anyLoading}`, and both hooks set their
               `loading` before their first await — so the ↻ went disabled
               under the press that had just come from it. It is the worst of
               the nine to lose focus on: the panel is docked with no focus
               trap, and the Codex leg of this refresh is a full second or
               more, all of it with focus on `<body>` and nothing to hand it
               back. The glyph goes on saying which state it is in. */
            {...selfPressProps(anyLoading)}
            aria-label={refreshLabel}
            title={refreshLabel}
          >{anyLoading ? "…" : "↻"}</button>
          )}
          <button
            type="button"
            className="glyph-btn up-close"
            onClick={onClose}
            aria-label="Close usage panel"
            title="Close (U)"
          >×</button>
        </div>
      </div>

      {/* ── Claude quota ── */}
      {providers.claude && (
        <ClaudeQuotaSection quota={quota} quotaLoading={quotaLoading} nowSec={nowSec} />
      )}

      {/* ── Codex quota ──
          The mirror of the accounts panel, and fixed by the same fact arriving
          from /api/health: a Claude-only machine used to carry "Quota
          unavailable. / Run codex login to authenticate." permanently, for a
          CLI it has no reason to install. */}
      {providers.codex && (
        <CodexQuotaSection codexQuota={codexQuota} codexLoading={codexLoading} codexUsage={codexUsage} nowSec={nowSec} />
      )}

      {/* ── Cost + tokens ──
          Gated on TOKENS, not on cost. The two tables used to live inside a
          `hasCost` branch, which meant a deck of nothing but unpriced sessions
          fell through to a two-number strip and a hint, with no per-model and
          no per-session breakdown at all — the reader could see that 4.2M
          tokens existed and nothing about where they went. Cost is what is
          conditional now: the headline and the bar appear when there is money
          to report, and the breakdown appears whenever there is anything to
          break down. */}
      {/* WHICH SPAN, when there is a source that has spans at all.
              The board has exactly one — right now — so the strip appears only
              under ccusage, and the panel is silently the old panel when
              ccusage is absent rather than showing three chips that all mean
              the same thing.
              `.uh-range` rather than a new set of chips: it is the same control
              the history modal's presets use, it already carries #583's
              luminance inversion for the selected chip, and toggle-state
              coverage is written against that selector. Reusing it is also the
              honest signal to a reader — these two surfaces read the same
              ccusage data over the same kind of range. */}
      {fromRange && (
        /* role="toolbar", not role="group", and the difference is a bill this
            strip now pays. #381 deleted role="tablist" from the history
            modal's range strip because a tablist promises one tab stop, arrows
            between the members and a tabpanel each, and that strip could
            honour none of the three. The third clause is still false here —
            these words select a range, they do not reveal a region — so
            tablist stays wrong. But the first two are exactly what a toolbar
            promises and nothing more, and three of the Usage panel's five tab
            stops going to one three-way choice is the defect they fix. So:
            one stop, arrows and Home/End across it, Enter or Space to commit.
            tablist-contract.test.ts holds any file that says "tab" to the
            whole model; this one says "toolbar" and carries the whole of that.

            The stop is the SELECTED segment rather than the last-focused one.
            The strip has three members and no scroll, so there is no long walk
            to resume, and re-entering on the period actually being shown is
            the more useful place to land than wherever the ring was left. */
        <div
          className="uh-range up-period"
          role="toolbar"
          aria-orientation="horizontal"
          aria-label="Period"
          aria-busy={rangePending || undefined}
          onKeyDown={e => {
            // From where the RING is, not from where the selection is. Arrows
            // that reckon off `period` walk one step from the selected segment
            // every time and then stop: press Right three times from `today`
            // and you get `month`, `month`, `month`. The origin has to be the
            // segment the key was pressed on, which is what bubbled the event.
            const from = periodRefs.current.indexOf(e.target as HTMLButtonElement);
            if (from < 0) return;
            const to = periodFocusMove(e.key, from);
            if (to === null) return;
            e.preventDefault();
            periodRefs.current[to]?.focus();
          }}
        >
          {PERIODS.map((p, i) => (
            <button
              key={p.key}
              type="button"
              ref={el => { periodRefs.current[i] = el; }}
              tabIndex={period === p.key ? 0 : -1}
              aria-pressed={period === p.key}
              // Only ever on the pressed one, which is what lets the CSS key the
              // pulse on this attribute alone: a rule that also named
              // `[aria-pressed="true"]` would join the set of scoped state rules
              // usage-series-contrast.test.ts holds to exactly three, and this
              // is a temporary activity rather than a fourth way of being
              // selected.
              data-pending={period === p.key && rangePending ? "" : undefined}
              // While it reads, the tooltip says what it is reading. The wait is
              // the deck walking transcripts on this disk, and a reader who
              // knows that reads two and a half seconds as work rather than as a
              // request that may not come back.
              title={period === p.key && rangePending ? `Reading ${p.noun} from the transcripts on this machine…` : p.hint}
              className="uh-range-btn"
              onClick={() => setPeriod(p.key)}
            >{p.label}</button>
          ))}
        </div>
      )}
      {/* WHAT THE WAIT SOUNDS LIKE, since until now it made no sound at all: a
          reader who cannot see the strip pressed `all`, and for two and a half
          seconds nothing was announced, nothing was disabled, and the figures
          they could read were the previous period's.
          Always mounted with only its text moving — App.tsx's blocked-session
          region carries the whole argument, and the half that matters here is
          that a live region registers when it ENTERS the tree, so text arriving
          in the same tick as the region is routinely never spoken. Rendering
          this only while pending would put the region and its one sentence on
          screen together, which is the delivery screen readers are least
          reliable about, and would take it away again before it could say the
          wait was over.
          Polite, because a figure that is two seconds late costs nothing and
          talking over the reader costs a sentence. `aria-atomic` because half
          of this only means the wrong thing. */}
      {fromRange && (
        <div className="vis-hidden" role="status" aria-atomic="true">
          {rangePending ? `Reading ${nounFor(period, period)}…` : ""}
        </div>
      )}

      {totalTokenSum > 0 ? (
        <>
          {/* The headline says whose spend it is (#687).
              It read "total spend", and it is not a total of anything: it walks
              the agents on the canvas, and `pruneDoneSessions` takes finished
              sessions off the canvas two minutes after they end, six at a time.
              Ten finished sessions reading $75.00 read $45.00 one 250ms tick
              later with nothing refunded — a correct number under a word that
              claims a period it does not cover, which is the worst kind of wrong
              number because nothing on screen looks broken.
              The label carries the scope and the tooltip carries the rest: why
              the figure falls, and that H opens the one surface which answers
              "what has today cost me" from the logs on disk. */}
          {hasCost && (
            <>
              <div className={`up-total${staleCls}`} title={fromRange ? undefined : BOARD_SCOPE_TITLE}>
                <span className="up-total-value">{fmtCost(shownCost)}</span>
                <span className="up-total-label">{fromRange ? periodNoun : BOARD_SPEND_LABEL}</span>
              </div>
              {/* NO BAR OVER A ccusage HEADLINE, and it is not an omission.
                  The bar splits a total across input / output / cache, and
                  ccusage publishes one cost per model rather than that split —
                  so the only way to draw it here would be to derive the shares
                  from this deck's own rate table and hang them under a number
                  that came from somewhere else. That is the shape of wrongness
                  #687 is about: a picture that looks authoritative and is a
                  different measurement from the figure above it.
                  Little is lost. The strip below says the same thing in tokens,
                  from the same source, with nothing derived at all. */}
              {figures.showCostBar && <CostBar cost={totalCost} />}
            </>
          )}

          <div className={`up-tokens-row${staleCls}`} title={fromRange ? undefined : BOARD_SCOPE_TITLE}>
            <span className="up-tok"><span className="up-k">in</span>{fmtTokens(shownIn)}</span>
            <span className="up-tok"><span className="up-k">out</span>{fmtTokens(shownOut)}</span>
            {/* Gated on the TRUE value, not the counted one: a strip that
                appeared and vanished as a count crossed zero would flicker. */}
            {figures.cacheReadTokens > 0 && <span className="up-tok"><span className="up-k">cache r</span>{fmtTokens(shownCacheR)}</span>}
            {figures.cacheCreateTokens > 0 && <span className="up-tok"><span className="up-k">cache c</span>{fmtTokens(shownCacheC)}</span>}
            {/* On a deck where nothing is priced there is no headline above this
                — the money block is gated on cost — so the strip is the only
                aggregate on screen and the only place left to say what it is
                the aggregate OF. Said once either way: with a headline present
                this would be the same words twice on a 280px panel. */}
            {!hasCost && <span className="up-tok up-scope">{BOARD_SCOPE_LABEL}</span>}
          </div>

          {/* NO BOARD FIGURE UNDER A ccusage HEADLINE.
              There used to be one here — the canvas's own spend, on its own
              labelled line — on the reasoning that #687's fix was to keep the
              number and name its scope rather than delete it. In front of a
              panel that now answers "today", "this month" and "all time" from
              the logs, it is a second money figure that answers a question
              nobody asked at that moment, and it invited the comparison it
              could never win: $7,385 on the board under $170 for today reads as
              a contradiction until you have read a tooltip.
              The board's own figures are still on the topbar, where they carry
              the same sentence, and the board branch below still prints them
              when ccusage has not answered at all. */}

          {(fromRange ? rangeModelRows.length : boardModelRows.length) > 0 && (
            <section className={`up-section${staleCls}`}>
              <h3 className="up-section-title">By model</h3>
              <table className="up-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Tokens</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {fromRange
                    ? rangeModelRows.map(m => (
                      <tr key={m.model}>
                        <td className="up-model-name" title={m.model}>{shortModel(m.model)}</td>
                        {/* Every token, not input plus output. The board's row
                            counts the two it can price per agent; ccusage sends
                            all four, and on an agentic session the cache is the
                            larger part by two orders of magnitude — 9.56B
                            against 320k on the machine this was written on. */}
                        <td className="up-num">{fmtTokens(m.tokens)}</td>
                        {m.cost > 0
                          ? <td className="up-num up-cost-val">{fmtCost(m.cost)}</td>
                          : <td className="up-num up-unpriced">{UNPRICED_LABEL}</td>}
                      </tr>
                    ))
                    : boardModelRows.map(m => (
                      <tr key={m.model}>
                        {/* `__unknown__` is the map's key for an agent that has
                            not reported a model yet, and it is not a word. The
                            row still belongs here — its tokens are in the strip
                            above — but under a name a person can read. */}
                        <td className="up-model-name" title={m.model === UNKNOWN_MODEL ? "no model reported yet" : m.model}>
                          {m.model === UNKNOWN_MODEL ? "unknown" : shortModel(m.model)}
                        </td>
                        <td className="up-num">{fmtTokens(m.inputTokens + m.outputTokens)}</td>
                        {m.priced
                          ? <td className="up-num up-cost-val">{fmtCost(m.cost.total)}</td>
                          : <td className="up-num up-unpriced">{UNPRICED_LABEL}</td>}
                      </tr>
                    ))}
                </tbody>
              </table>
            </section>
          )}

          {/* THE HOUR AFTER LOCAL MIDNIGHT, said rather than left blank.
              The two halves of one ccusage load do not date things the same
              way: `daily` buckets by local calendar day — it takes `-z` — and
              `session` filters by UTC day whatever timezone it is handed.
              Measured here at 01:58 local (UTC+3): `daily --since 20260905`
              reports $169.12 and `session --since 20260905` reports nothing at
              all, because no session has touched UTC's 5th yet.
              So on any deck east of Greenwich there is a stretch after midnight
              where the money is real and the session list is empty. A missing
              section reads as a bug; this says which of the two questions has
              no answer yet. */}
          {fromRange && rangeSessionRows.length === 0 && rangeSum.tokens > 0 && (
            <section className="up-section">
              <h3 className="up-section-title">By session</h3>
              <div className="up-hint">
                No session is dated {periodNoun} yet — ccusage dates sessions in UTC,
                and the totals above are your local day.
              </div>
            </section>
          )}

          {(fromRange ? rangeSessionRows.length : boardSessionRows.length) > 0 && (() => {
            const sessionCount = fromRange ? rangeSessionRows.length : boardSessionRows.length;
            return (
            <section className={`up-section${staleCls}`}>
              {/* WHAT A ccusage SESSION ROW IS, said on the heading rather than
                  in a tooltip, because the reader can see the arithmetic fail
                  without it: rows that add up past the figure above read as a
                  bug in the panel until something on screen says otherwise.
                  What the panel may NOT do is name the reason, because the
                  reason changed under it. Through ccusage 20.0.20 a row carried
                  the session's lifetime — `--since` picked WHICH sessions
                  appeared and left their figures whole — and 20.0.21 scopes
                  them to the window. The deck runs `ccusage@latest` and
                  refreshes it daily, so both are live on real machines and
                  either sentence is false on half of them.
                  So the qualifier is measured: sessionListScale sums every row
                  in the range against the period's own cost, and the heading
                  speaks only when that sum really is the larger one. */}
              {/* THE ONE SECTION THAT SHUTS, and the chevron is what says so.
                  Every other block in this panel is a fixed two or three rows;
                  this one is as long as the reader's week and is the reason the
                  panel scrolls. Shut, the panel is one screen.
                  The <button> is inside the <h3> rather than instead of it —
                  the ARIA disclosure pattern, and the one spelling that keeps
                  the heading in the document outline while still giving the
                  reader a real control. landmark-outline.test.ts reads these
                  four headings as headings and would have lost one to a bare
                  button. The whole row is the target, 250 x 24, because a
                  chevron alone is a 9px hit area for a section-sized decision;
                  the chevron is the affordance, not the control.
                  The count goes on the title rather than into the row: shut,
                  the reader cannot see how much is behind it, and that is the
                  one fact the collapse actually takes away. Saying it in ink
                  would be a third thing on a line that already carries two. */}
              <h3 className="up-section-title">
                <button
                  type="button"
                  className="up-disclose"
                  aria-expanded={sessionsOpen}
                  aria-controls="up-sessions"
                  title={sessionsOpen
                    ? "Hide the per-session breakdown"
                    : `Show the per-session breakdown — ${sessionCount} session${sessionCount === 1 ? "" : "s"}`}
                  onClick={() => setSessionsOpen(o => !o)}
                >
                  By session
                  {fromRange && (
                    <span
                      className="up-section-age"
                      title={sessionListNote(periodNoun, sessionScale, fmtCost)}
                    >active {periodNoun}</span>
                  )}
                  {/* Drawn, not typed. `.bw-chev` swaps two Unicode glyphs and
                      is at the mercy of whichever font answers for them on
                      Windows and Linux; a path is the same three strokes
                      everywhere, and it can turn rather than be replaced. */}
                  <svg className="up-chev" width="9" height="9" viewBox="0 0 10 10" fill="none"
                       stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
                       strokeLinejoin="round" aria-hidden>
                    <path d="M2.2 3.6 5 6.4 7.8 3.6" />
                  </svg>
                </button>
              </h3>
              {/* `hidden` rather than an unrendered branch: it takes the rows
                  out of the accessibility tree and out of the tab order the
                  same way, and it leaves `aria-controls` pointing at something
                  that exists in both states, which is the whole contract of a
                  disclosure. Twelve divs cost nothing to keep. */}
              <div className="up-sessions" id="up-sessions" hidden={!sessionsOpen}>
                {fromRange && rangeSessionRows.map(s => {
                  const live = boardStates.get(s.sessionId);
                  return (
                    <div className="up-session-row" key={s.sessionId}>
                      {/* A dot only for a session the canvas is drawing. The
                          rest of this list is history — ccusage remembers every
                          session that ever ran — and a "done" tick on a session
                          from three weeks ago would be reporting a state this
                          deck never observed. The placeholder keeps the label
                          column aligned between the two kinds of row. */}
                      {live
                        ? <>
                            <span className={`sl-dot state-${live}`} aria-hidden />
                            <span className="vis-hidden">{stateLabel(live)}</span>
                          </>
                        : <span className="sl-dot up-dot-past" aria-hidden />}
                      {/* ccusage names a session by its uuid, which is not a
                          name. The board's label is used when the board has one
                          — that join is the point of this table — and the first
                          segment of the uuid otherwise, under a title carrying
                          the whole of it. */}
                      <span
                        className={`up-session-label${s.label ? "" : " up-session-id"}`}
                        title={s.label ? `${s.label}\n${s.sessionId}` : s.sessionId}
                      >{s.label ?? s.sessionId.slice(0, 8)}</span>
                      <span className="up-session-tokens">{fmtTokens(s.tokens)}</span>
                      {s.cost > 0
                        ? <span className="up-session-cost" title={s.models.join(", ") || undefined}>{fmtCost(s.cost)}</span>
                        : <span className="up-session-cost up-unpriced">{UNPRICED_LABEL}</span>}
                    </div>
                  );
                })}
                {!fromRange && boardSessionRows.map(s => (
                  <div className="up-session-row" key={s.sessionId}>
                    {/* Same dot and the same hidden word as the session list
                        (#373) — this row is a <div>, so its state is read as
                        part of the line rather than as a control's name, but it
                        was the same silence either way. Two defects here, not
                        one: the dot also matched no rule at all, because every
                        `.sl-dot` selector was scoped to `.session-list` and
                        this panel is that sidebar's sibling. It was drawn as a
                        zero-sized empty span, so this list reported the state
                        in no channel whatsoever. */}
                    <span className={`sl-dot state-${s.state}`} aria-hidden />
                    <span className="vis-hidden">{stateLabel(s.state)}</span>
                    <span className="up-session-label">{s.label}</span>
                    <span className="up-session-tokens">{fmtTokens(s.inputTokens + s.outputTokens)}</span>
                    {/* A mixed session keeps its figure and gains a title: the
                        dollars are real, they are just not all of them, and a
                        floor presented as a total is the one thing this panel
                        must not print without saying so. */}
                    {s.cost > 0
                      ? (
                        <span
                          className="up-session-cost"
                          title={s.unpricedTokens > 0
                            ? `${fmtTokens(s.unpricedTokens)} tokens in this session are on an unpriced model, so this is a floor`
                            : undefined}
                        >{fmtCost(s.cost)}{s.unpricedTokens > 0 ? "+" : ""}</span>
                      )
                      : <span className="up-session-cost up-unpriced">{UNPRICED_LABEL}</span>}
                  </div>
                ))}
              </div>
            </section>
            );
          })()}

          {hasUnpriced && (
            <div className="up-hint">
              “{UNPRICED_LABEL}” means this build holds no published rate for that model —
              those tokens are counted above and their dollars are not.
            </div>
          )}
        </>
      ) : (
        <div className="up-empty">
          {/* A RANGE THAT ANSWERED ZERO IS NOT AN EMPTY MACHINE.
              A session started at 23:50 and still running at 00:05 has no
              tokens in ccusage's "today", and the old copy told the reader to
              start a session while one was burning in front of them. The chips
              are above this block now, so the way out — month, all — is on
              screen either way. */}
          {fromRange
            ? <>No usage {periodNoun}.<br />Try a longer period.</>
            : <>No usage data yet.<br />Start a Claude Code or Codex session.</>}
        </div>
      )}
    </aside>
  );
}
