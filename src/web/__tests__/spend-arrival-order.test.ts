// #1173: a session's history, restated a few seconds after its root appears,
// was counted as new spend.
//
// spend-rate.ts and live-delta.ts both follow one rule — only work the deck
// WATCHED happen counts — and both enforce it by skipping a session missing
// from the previous sample or the baseline. Every case that pinned that rule
// (spend-rate-987, live-delta) fed them hand-built maps in which a joining
// session already carried its history. The reducer does not deliver sessions
// that way. A session's root reaches the board through a hook event, and the
// reducer creates it holding ZERO usage (`ensureRoot`); the session's totals
// land seconds later, when the server's async transcript or rollout scan emits
// UsageObserved. So the root is in the previous sample, at $0, and the
// restatement arrives as a rise:
//
//   joined late    the first hook event of a session running before the deck
//   reborn         a Stop-evicted session's next event, after pruneDoneSessions
//   after Clear    every live session's next event, after `__clear`
//
// Driven through the real reducer before the fix: ten minutes of one session
// spending a true $0.20/min, then a joined-late session restating $12.50 of
// history, read $1.45/min for the next ten minutes — the #987 inflation back
// through the door the reducer opens. The reducer already marks these roots:
// `synthetic` is "the deck never saw this session begin", and a synthetic root
// holding no tokens is one whose usage is NOT KNOWN yet, not one that is at
// zero. `boardBySession` now leaves it out until its usage lands, so it joins
// both maps the way the rule already handles: as a newcomer.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState, pruneDoneSessions, type GraphState } from "../reducer";
import { boardBySession, liveDelta } from "../live-delta";
import { recordSpend, spendRate, NO_SPEND_HISTORY, SAMPLE_EVERY_MS, type SpendHistory } from "../spend-rate";
import { DONE_SESSION_CAP, DONE_SESSION_GRACE_MS } from "../board-limits";
import type { HookEnvelope, HookPayload } from "../types";

const T0 = Date.UTC(2026, 8, 1, 9);
const MIN = 60_000;
const OPUS = "claude-opus-5";   // $5 in / $25 out per Mtok
/** `live`'s pace: 40,000 input tokens a minute at $5/Mtok is $0.20/min. */
const LIVE_INPUT_PER_MIN = 40_000;

/** The board as the panel holds it: the reducer's state, the rate's samples,
 *  and the clock the panel samples on. */
interface Deck { state: GraphState; h: SpendHistory; t: number; seq: number }

function send(d: Deck, at: number, payload: HookPayload): void {
  const env: HookEnvelope = { seq: ++d.seq, receivedAt: at, source: "hook", payload };
  d.state = applyEvent(d.state, env);
}

/** What the server's usage scan restates for a session: its cumulative totals,
 *  with the per-model split a Claude transcript carries (#686) — which prices
 *  the tokens whether or not a ModelObserved has named the root's model yet. */
function usage(d: Deck, at: number, session: string, input: number, output = 0): void {
  const totals = { input_tokens: input, output_tokens: output };
  send(d, at, {
    hook_event_name: "UsageObserved", session_id: session, usage: totals, usageByModel: { [OPUS]: totals },
  } as unknown as HookPayload);
}

/** `live`'s running total at `at`, restated the way the scan restates it. */
function liveUsage(d: Deck, at: number): void {
  usage(d, at, "live", Math.round(((at - T0) / MIN) * LIVE_INPUT_PER_MIN));
}

/** What UsagePanel does every sample: per-session costs off the reducer's
 *  agents, folded into the history. */
function sample(d: Deck): void {
  d.h = recordSpend(d.h, d.t, boardBySession(d.state.agents.values(), d.t));
}

/** The next sample: `live` keeps spending, its scan lands, the panel samples. */
function step(d: Deck): void {
  d.t += SAMPLE_EVERY_MS;
  liveUsage(d, d.t);
  sample(d);
}

/** The $/min the pill would print right now. */
function rate(d: Deck): number {
  const r = spendRate(d.h, d.t, boardBySession(d.state.agents.values(), d.t));
  return r ? r.spent / (r.spanSec / 60) : 0;
}

/** Ten minutes of `live`, watched from its SessionStart, sampled every 5 s. */
function tenLiveMinutes(): Deck {
  const d: Deck = { state: initialState(), h: NO_SPEND_HISTORY, t: T0, seq: 0 };
  send(d, T0, { hook_event_name: "SessionStart", session_id: "live", cwd: "/repo" });
  send(d, T0, { hook_event_name: "ModelObserved", session_id: "live", model: OPUS } as HookPayload);
  liveUsage(d, T0);
  sample(d);
  for (let i = 0; i < 120; i++) step(d);
  return d;
}

/** $12.50 of history at Opus 5: 2M in ($10) and 100k out ($2.50). */
function restateOld(d: Deck, at: number): void {
  send(d, at, { hook_event_name: "ModelObserved", session_id: "old", model: OPUS } as HookPayload);
  usage(d, at, "old", 2_000_000, 100_000);
}

describe("a session whose history is restated after its root appears is not spending (#1173)", () => {
  it("keeps the rate at what was watched when a joined-late session restates $12.50", () => {
    const d = tenLiveMinutes();
    expect(rate(d)).toBeCloseTo(0.2, 2);

    // The first hook event of a session that was running before the deck. The
    // reducer conjures its root, marked synthetic, at $0, and the panel samples
    // it there.
    send(d, d.t + 1_000, { hook_event_name: "PreToolUse", session_id: "old", tool_name: "Bash", tool_use_id: "t1" });
    expect(d.state.agents.get("old")!.synthetic).toBe(true);
    step(d);

    // Two seconds later the scan lands with everything the session ever spent.
    restateOld(d, d.t + 2_000);
    step(d);

    // $2.00 of live's spending plus $12.50 of old's history over ten minutes
    // is the $1.45/min this read before the fix.
    expect(rate(d), "the restated history was counted as spend in the last ten minutes").toBeCloseTo(0.2, 2);
  });

  it("counts that session's spending from the sample after its history landed", () => {
    // The fix may not simply drop synthetic roots: once the scan has said what
    // the session holds, what it spends next is work the deck watched.
    const d = tenLiveMinutes();
    send(d, d.t + 1_000, { hook_event_name: "PreToolUse", session_id: "old", tool_name: "Bash", tool_use_id: "t1" });
    step(d);
    restateOld(d, d.t + 2_000);
    step(d);
    const before = rate(d);

    // One more Opus turn on old: 100,000 input tokens, $0.50.
    usage(d, d.t + 2_000, "old", 2_100_000, 100_000);
    step(d);
    expect(rate(d) - before, "old's watched $0.50 was not counted").toBeCloseTo(0.5 / 10, 2);
  });

  it("does not count a live session's restated total after Clear", () => {
    // `__clear` empties the board while every session keeps running, and the
    // panel's samples carry on through it: nothing resets `liveSince`. Live's
    // next hook event re-creates its root at $0, and the scan then restates its
    // whole two dollars.
    const d = tenLiveMinutes();
    d.state = applyEvent(d.state, {
      seq: ++d.seq, receivedAt: d.t + 500, source: "hook", payload: { hook_event_name: "__clear" },
    } as HookEnvelope);
    send(d, d.t + 1_000, { hook_event_name: "PreToolUse", session_id: "live", tool_name: "Bash", tool_use_id: "t2" });
    d.t += SAMPLE_EVERY_MS;
    sample(d);
    step(d);
    // 0.1967, not 0.2: the one sample in which live was a synthetic root went
    // uncounted. That is the documented cost of the rule — a session joins on
    // its SECOND sample — and it is five seconds of one session, not the two
    // dollars that session had already spent.
    expect(rate(d), "live's restated total was read as spend").toBeCloseTo(0.2, 2);
    // And it goes on counting what live spends from there.
    for (let i = 0; i < 12; i++) step(d);
    expect(rate(d)).toBeCloseTo(0.2, 2);
  });

  it("does not count a Stop-evicted session's history when it comes back", () => {
    // `old` finishes early; six other sessions finish after it, so the cap
    // evicts `old` first once the grace has run. Its next event is a new root.
    const d: Deck = { state: initialState(), h: NO_SPEND_HISTORY, t: T0, seq: 0 };
    send(d, T0, { hook_event_name: "SessionStart", session_id: "old", cwd: "/old" });
    restateOld(d, T0 + 500);
    send(d, T0 + 1_000, { hook_event_name: "Stop", session_id: "old" });
    for (let i = 0; i < DONE_SESSION_CAP; i++) {
      send(d, T0 + 2_000, { hook_event_name: "SessionStart", session_id: `done-${i}`, cwd: `/d${i}` });
      send(d, T0 + 3_000, { hook_event_name: "Stop", session_id: `done-${i}` });
    }
    send(d, T0, { hook_event_name: "SessionStart", session_id: "live", cwd: "/repo" });
    send(d, T0, { hook_event_name: "ModelObserved", session_id: "live", model: OPUS } as HookPayload);
    liveUsage(d, T0);
    sample(d);
    for (let i = 0; i < 120; i++) step(d);
    expect(pruneDoneSessions(d.state, d.t, DONE_SESSION_CAP, DONE_SESSION_GRACE_MS)).toBe(true);
    expect(d.state.agents.has("old")).toBe(false);
    expect(rate(d)).toBeCloseTo(0.2, 2);

    // Reborn: the next prompt in old's terminal, its root back at $0, and the
    // scan restating the $12.50 it already had.
    send(d, d.t + 1_000, { hook_event_name: "UserPromptSubmit", session_id: "old", prompt: "and one more" });
    expect(d.state.agents.get("old")!.usage.inputTokens).toBe(0);
    step(d);
    restateOld(d, d.t + 2_000);
    step(d);
    expect(rate(d), "old's history was counted again on its return").toBeCloseTo(0.2, 2);
  });

  it("still counts a session the deck watched start, from its first turn", () => {
    // The control. A root that began with SessionStart is at $0 because it has
    // spent nothing, and its first turn IS spending — which is why the rule
    // reads `synthetic` and not "every root at $0".
    const d = tenLiveMinutes();
    send(d, d.t + 1_000, { hook_event_name: "SessionStart", session_id: "fresh", cwd: "/fresh" });
    send(d, d.t + 1_000, { hook_event_name: "ModelObserved", session_id: "fresh", model: OPUS } as HookPayload);
    step(d);
    usage(d, d.t + 2_000, "fresh", 100_000);   // $0.50
    step(d);
    // $2.00 of live plus fresh's $0.50, over ten minutes.
    expect(rate(d), "a new session's first turn went uncounted").toBeCloseTo(0.25, 2);
  });
});

describe("the live delta does not add a restated history either (#1173)", () => {
  it("contributes nothing for a root the baseline caught before its usage landed", () => {
    // The ccusage reading lands while `old` is a synthetic root at $0, and the
    // baseline is taken there. The panel's headline adds everything the board
    // gains after it — so the restatement, counted, would put $12.50 that
    // ccusage already has on top of ccusage's own figure.
    const d = tenLiveMinutes();
    send(d, d.t + 1_000, { hook_event_name: "PreToolUse", session_id: "old", tool_name: "Bash", tool_use_id: "t1" });
    const baseline = boardBySession(d.state.agents.values(), d.t + 1_000);

    restateOld(d, d.t + 3_000);
    const current = boardBySession(d.state.agents.values(), d.t + 3_000);
    expect(current.get("old")!.cost).toBeCloseTo(12.5, 9);

    const delta = liveDelta(baseline, current);
    expect(delta.cost).toBe(0);
    expect(delta.sessions).toBe(0);
  });
});
