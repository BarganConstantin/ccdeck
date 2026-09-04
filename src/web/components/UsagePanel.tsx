// UsagePanel — floating panel showing aggregated token usage and cost
// across all sessions, by model and by session. Toggled via $ button
// in the topbar or the U keyboard shortcut.
import { useEffect, useMemo, useRef, useState } from "react";
import { costForUsage, fmtCost, fmtCostRate, ratesForModel, UNPRICED_LABEL, type CostBreakdown } from "../pricing";
import { boardTotals, BOARD_SCOPE_LABEL, BOARD_SCOPE_TITLE, BOARD_SPEND_LABEL } from "../board-usage";
import {
  PERIODS, sinceFor, modelRows as ccModelRows, sessionRows as ccSessionRows,
  rangeTotals, type PeriodKey, type UsageRange,
} from "../usage-from-ccusage";
// Tokens are priced at the model that produced them, not at the last model the
// session was seen on — see usage-models.ts for the two measurements that make
// the difference 60% under in one direction and 150% over in the other (#686).
import { agentCost, agentUnpricedTokens, usageByModelEntries } from "../usage-models";
import { PRODUCT } from "../brand";
import type { GraphState } from "../reducer";
import type { AgentState } from "../types";
import { fmtTokens } from "../token-format";
import type { Providers } from "../providers";
import { shortModel } from "../model-label";
import { resetCountdown } from "../relative-time";
import CostBar from "./CostBar";
import { stateLabel } from "./AgentNode";
import { selfPressAccepted, selfPressProps } from "../panel-press";

// ── Quota types ────────────────────────────────────────────────────────────
interface QuotaData {
  ok: boolean;
  session5hPct?: number;
  session5hReset?: string;
  session5hResetAt?: number;   // unix seconds
  session5hWindowSec?: number;
  week7dPct?: number;
  week7dReset?: string;
  week7dResetAt?: number;      // unix seconds
  week7dWindowSec?: number;
  weekSonnetPct?: number;
  weekOpusPct?: number;
  source?: string;
  /** Why there is nothing to show, when `ok` is false. The server has always
   *  sent this and the panel used to drop it, so every failure printed the one
   *  sentence about running /usage — including on machines where that cannot
   *  help, because they have no subscription window to report. */
  reason?: string;
  fetchedAt?: number;
}

/** "just now" / "40s ago" / "17m ago" / "2h ago", or null when never fetched. */
function ageLabel(ms: number | undefined, nowSec: number): string | null {
  if (!ms) return null;
  const s = nowSec - Math.floor(ms / 1000);
  if (s < 10)   return "just now";
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** Which of the three sources answered, in words. */
function quotaSourceHint(source?: string): string {
  if (source === "claude-swap") return "Read from claude-swap's last collection — costs no request against your usage-endpoint budget";
  if (source === "api")         return "Fetched from Anthropic's usage endpoint, at most once every 5 minutes";
  if (source === "cli")         return "Parsed from `claude /usage`, at most once every 5 minutes";
  return "Last update";
}

interface ModelRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  cost: CostBreakdown;
  agentCount: number;
  /** False when this build holds no rate for the model — the row's tokens are
   *  real and its dollars are unknowable, which is not the same as zero. */
  priced: boolean;
}

interface SessionRow {
  sessionId: string;
  label: string;
  state: AgentState;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens on this session that no rate could be applied to. Non-zero and a
   *  `cost` of zero is a session nothing here can price; non-zero beside a
   *  non-zero cost is a mixed session whose figure is a floor, not a total. */
  unpricedTokens: number;
}

/** The model key for an agent that has not reported one yet. Kept out of the
 *  display: the map needs a key and the reader needs a word, and `__unknown__`
 *  is only the first of those. */
const UNKNOWN_MODEL = "__unknown__";

// The stacked cost bar this panel drew is components/CostBar.tsx now — it was
// written out here, in App.tsx and in SessionSummary.tsx, and #381's role fix
// had to be made three times because of it (#374). The reasoning behind the
// role, which was written in this file, moved to the component with it.
//
// Its countdown went to relative-time.ts for the same reason: the accounts
// panel had one too, and the two render the same quota reset.

// ── Pace helpers ───────────────────────────────────────────────────────────

interface PaceInfo {
  label: string;
  color: string;
  expectedPct: number;  // where usage "should" be now — the green-line marker position
  isDeficit: boolean;   // true when burning faster than sustainable
  runsOutIn?: string;   // set when deficit and ETA < window remaining
}

function computePace(pct: number, resetAtSec: number, windowSec: number, nowSec: number): PaceInfo | null {
  const remainSec  = Math.max(0, resetAtSec - nowSec);
  const elapsedSec = Math.max(0, windowSec - remainSec);
  if (elapsedSec < 120) return null; // too early to judge
  const expectedPct = Math.min(100, (elapsedSec / windowSec) * 100);
  const delta = pct - expectedPct;

  if (Math.abs(delta) < 3) {
    return { label: "on pace", color: "var(--ok)", expectedPct, isDeficit: false };
  }

  if (delta > 0) {
    // using more than expected → deficit (burning too fast)
    const remainPct = 100 - pct;
    const ratePerSec = elapsedSec > 0 ? pct / elapsedSec : 0;
    const runsOutSec = ratePerSec > 0 ? remainPct / ratePerSec : Infinity;
    const info: PaceInfo = {
      label: `${Math.round(delta)}% ahead`, color: "var(--warn)",
      expectedPct, isDeficit: true,
    };
    if (runsOutSec < remainSec && runsOutSec < 86400) {
      const h = Math.floor(runsOutSec / 3600);
      const m = Math.floor((runsOutSec % 3600) / 60);
      info.runsOutIn = h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
    return info;
  }
  // under-using → reserve (safe, will last until reset)
  return { label: `${Math.round(-delta)}% reserve`, color: "var(--ok)", expectedPct, isDeficit: false };
}

// ── Quota bar ──────────────────────────────────────────────────────────────
interface QuotaBarProps {
  pct: number;
  label: string;
  reset?: string;
  resetAt?: number;    // unix seconds — enables live countdown
  windowSec?: number;  // enables pace calculation
  limitReached?: boolean;
  nowSec: number;      // current time in seconds (for countdown + pace)
}
function QuotaBar({ pct, label, reset, resetAt, windowSec, limitReached, nowSec }: QuotaBarProps) {
  const capped   = Math.min(100, Math.max(0, pct));
  const isErr    = limitReached || capped >= 90;
  const color    = isErr ? "var(--err)" : capped >= 70 ? "var(--warn)" : "var(--accent)";
  const pctLabel = capped === 0 ? "< 1%" : `${capped}%`;
  // minimum 2% visual fill so a 0% bar is still visible as a thin sliver
  const fillW    = capped === 0 ? 2 : capped;

  const countdown = resetAt ? resetCountdown(resetAt, nowSec) : null;
  const pace = (resetAt && windowSec) ? computePace(capped, resetAt, windowSec, nowSec) : null;

  return (
    <div className="qb-row">
      <div className="qb-meta">
        <span className="qb-label">
          {label}
          {limitReached && <span className="qb-limit-badge" title="Rate limit reached">⛔</span>}
        </span>
        <span className="qb-pct" style={{ color }}>{pctLabel}</span>
      </div>
      <div className="qb-track">
        <div className="qb-fill" style={{ width: `${fillW}%`, background: color, opacity: capped === 0 ? 0.4 : 1 }} />
        {/* Pace marker ("green line"): where usage should be now to last until
            reset. Green when you have reserve / on pace, red when in deficit. */}
        {pace && (
          <div
            className="qb-pace-marker"
            style={{ left: `${pace.expectedPct}%`, background: pace.isDeficit ? "var(--err)" : "var(--ok)" }}
            title={`To last until reset, stay near ${Math.round(pace.expectedPct)}% by now`}
          />
        )}
      </div>
      <div className="qb-reset-row">
        {countdown
          ? <span className="qb-reset">resets in {countdown}</span>
          : reset
            ? <span className="qb-reset">resets {reset}</span>
            : null}
        {pace && (
          <span className="qb-pace" style={{ color: pace.color }}>
            {pace.runsOutIn ? `runs out in ${pace.runsOutIn}` : pace.label}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Quota fetch hook ───────────────────────────────────────────────────────
const QUOTA_POLL_MS = 60_000;

/**
 * @param enabled whether this deck watches Claude Code at all. False stops the
 *   poll rather than only hiding its output: /api/quota is not a cheap read —
 *   it can spawn `claude --print /usage` — and a machine with no Claude Code
 *   would pay for that once a minute forever to render nothing.
 */
function useQuota(enabled: boolean) {
  const [quota, setQuota] = useState<QuotaData | null>(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<number | null>(null);

  // The same fact as `loading`, readable without waiting for a render. The ↻
  // stays enabled while its own request is out (#620), so the second press
  // reaches here and this is what refuses it. Only forced reads take the lock:
  // the poll is not a press and must never be blocked by one.
  const busyRef = useRef(false);

  const fetch_ = async (forceRefresh = false) => {
    if (forceRefresh && !selfPressAccepted(busyRef.current)) return;
    if (forceRefresh) { busyRef.current = true; setLoading(true); }
    try {
      const url = forceRefresh ? "/api/quota?refresh=1" : "/api/quota";
      const res = await fetch(url);
      if (res.ok) setQuota(await res.json());
    } catch { /* server unreachable */ }
    finally { if (forceRefresh) { busyRef.current = false; setLoading(false); } }
  };

  useEffect(() => {
    if (!enabled) return;
    fetch_(true); // force on mount — avoids stale ok:false cache from prior run
    timerRef.current = window.setInterval(() => fetch_(false), QUOTA_POLL_MS);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, [enabled]);

  const refresh = () => { if (enabled) fetch_(true); };
  return { quota, loading, refresh };
}

// ── Codex quota types + hook ───────────────────────────────────────────────
// Lanes arrive as a list rather than fixed 5h/7d slots: which windows an
// account has depends on its plan (free plans get weekly only, some get a
// 30-day cap), and the server labels each one from the duration the API
// reported instead of from its position in the payload.
interface CodexLane {
  id: string;
  key: "session" | "weekly" | "monthly" | "unknown";
  label: string;
  pct: number;
  windowSec: number | null;
  resetAt: number | null;
  reset: string | null;
}

interface CodexCreditLimit {
  limit: number;
  used: number;
  usedPct: number;
  remaining: number;
  source: string | null;
  resetAt: number | null;
  reset: string | null;
}

interface CodexQuotaData {
  ok: boolean;
  limitReached?: boolean;
  windows?: CodexLane[];
  extraWindows?: CodexLane[];
  plan?: string | null;
  planLabel?: string | null;
  creditsBalance?: string | null;
  creditsUnlimited?: boolean;
  overageReached?: boolean;
  creditLimit?: CodexCreditLimit | null;
  spendControlReached?: boolean;
  reachedType?: string | null;
  promo?: string | null;
  partial?: boolean;
  resetCredits?: { availableCount: number; nextExpiryAt: number | null } | null;
  reason?: string;
  fetchedAt?: number;
}

/** Why the Codex section is empty, in words that say what to do about it. */
/**
 * Why the Claude quota section is empty, in the reader's terms.
 *
 * One sentence used to cover every failure — "Run /usage in a claude session,
 * then click ↻" — and on an API-key, Bedrock or Vertex install that is advice
 * which cannot work: those are billed per token and have no five-hour window to
 * report. Worse, that machine did not even get this far. The CLI ran, printed
 * no quota lines, and the server read that as a genuine "<1%", so the panel drew
 * two empty bars for a measurement nobody had taken.
 *
 * Same shape as codexHint below, which has answered this properly all along.
 */
function claudeQuotaHint(reason?: string): string {
  switch (reason) {
    case "no_subscription":
      return "This install signs in with an API key (or Bedrock/Vertex), which is billed per token and has no session window.";
    case "rate_limited":  return "Anthropic asked the deck to wait — it will retry on its own.";
    case "waiting":       return "Waiting for the next allowed read — or click ↻.";
    default:              return "Run /usage in a claude session, then click ↻";
  }
}

function codexHint(reason?: string): string {
  switch (reason) {
    case "no_token":         return "Run codex login to authenticate.";
    case "api_key_mode":     return "API-key login — ChatGPT quota is only available for codex login.";
    case "refresh_rejected": return "Codex session expired — run codex login.";
    case "refresh_failed":   return "Couldn't refresh the Codex token — click ↻ to retry.";
    // The deck will not put a live ChatGPT token on the wire to somewhere it
    // read out of a config file it does not own, so it says which file.
    case "untrusted_base_url": return "chatgpt_base_url in ~/.codex/config.toml is not an https OpenAI host, so the token was not sent.";
    default:                 return "ChatGPT API unreachable — click ↻ to retry.";
  }
}

// ── Codex usage types + hook (token aggregation fallback) ─────────────────
interface CodexWindow {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  sessionCount: number;
}
interface CodexUsageData {
  ok: boolean;
  window5h?: CodexWindow;
  window7d?: CodexWindow;
  fetchedAt?: number;
}

const CODEX_POLL_MS = 60_000;

/** @param enabled whether this deck watches Codex — see useQuota above, which
 *   states the same rule for the other side. A Codex poll refreshes an OAuth
 *   token against OpenAI, which is not work to do on a machine with no Codex. */
function useCodexQuota(enabled: boolean) {
  const [data, setData] = useState<CodexQuotaData | null>(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<number | null>(null);

  // See useQuota above: the ↻ presses both hooks, so both hold a lock of their
  // own against the second press (#620).
  const busyRef = useRef(false);

  const fetch_ = async (forceRefresh = false) => {
    if (forceRefresh && !selfPressAccepted(busyRef.current)) return;
    if (forceRefresh) { busyRef.current = true; setLoading(true); }
    try {
      const url = forceRefresh ? "/api/codex-quota?refresh=1" : "/api/codex-quota";
      const res = await fetch(url);
      if (res.ok) setData(await res.json());
    } catch { /* server unreachable */ }
    finally { if (forceRefresh) { busyRef.current = false; setLoading(false); } }
  };

  useEffect(() => {
    if (!enabled) return;
    fetch_(true); // force on mount — get fresh data immediately
    timerRef.current = window.setInterval(() => fetch_(false), CODEX_POLL_MS);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, [enabled]);

  const refresh = () => { if (enabled) fetch_(true); };
  return { data, loading, refresh };
}

function useCodexUsage(enabled: boolean) {
  const [data, setData] = useState<CodexUsageData | null>(null);
  const timerRef = useRef<number | null>(null);

  const fetch_ = async () => {
    try {
      const res = await fetch("/api/codex-usage");
      if (res.ok) setData(await res.json());
    } catch { /* server unreachable */ }
  };

  useEffect(() => {
    if (!enabled) return;
    fetch_();
    timerRef.current = window.setInterval(fetch_, CODEX_POLL_MS);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, [enabled]);

  return { data };
}

interface Props {
  state: GraphState;
  now: number;
  /** Which CLIs this deck watches — see src/web/providers.ts. */
  providers: Providers;
  onClose: () => void;
}

/**
 * The chosen span, read from ccusage through the deck's own route.
 *
 * This is the panel's answer to #687 and #737. The figures below it used to sum
 * the agents on the canvas — honest numbers with an unusual scope, and the
 * scope was the problem: the canvas evicts finished sessions on a timer, so the
 * total went DOWN while nothing had happened and nothing had been refunded.
 * ccusage reads the transcripts and forgets nothing.
 *
 * NEVER A HARD DEPENDENCY. ccusage is optional — a machine with no npm, or one
 * running under AGENTS_DECK_NO_INSTALL=1, has none — so `data` staying null is
 * an ordinary state and the panel falls back to the board figures it has always
 * drawn. What this adds can only ever add.
 *
 * Refetched on the period AND on a manual refresh, not on a timer: a range is
 * two ccusage children on the far side, and a panel that is open all afternoon
 * must not spawn them on a clock. The route caches per range anyway.
 */
function useUsageRange(period: PeriodKey, refreshKey: number) {
  // THE ANSWER AND THE QUESTION IT ANSWERS, together.
  //
  // A bare `data` here was a defect: `period` moves the instant a chip is
  // pressed and the response lands seconds later, so between the two the panel
  // drew today's money under the words "all time" and then silently rewrote the
  // number. Everything downstream reads `landed.period` — the label, the noun,
  // both tables — so the figures and the word over them can never disagree,
  // whatever is in flight. The pressed chip still shows the reader's intent.
  const [landed, setLanded] = useState<{ period: PeriodKey; data: UsageRange } | null>(null);
  const [loading, setLoading] = useState(false);
  // A panel left open must not freeze at the figure it opened on, and must not
  // become a background job either. Five minutes is chosen against the work
  // rather than against the server's 2-minute cache: every poll longer than
  // CACHE_MS misses it by definition, so this interval IS the ccusage run rate,
  // and a run walks every transcript on the machine.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const beat = () => {
      // Nothing to keep fresh behind a hidden tab. A deck left open for a week
      // on a second desktop otherwise spends a ccusage run every five minutes
      // updating numbers no one is looking at.
      if (document.visibilityState === "visible") setTick(n => n + 1);
    };
    const t = window.setInterval(beat, 300_000);
    // And catch up on the way back: a tab hidden for an hour holds an hour-old
    // reading, which is the one moment a poll is worth more than its cost.
    const wake = () => { if (document.visibilityState === "visible") setTick(n => n + 1); };
    document.addEventListener("visibilitychange", wake);
    return () => { window.clearInterval(t); document.removeEventListener("visibilitychange", wake); };
  }, []);

  // `refresh=1` belongs to the press that asked for it and to nothing after it.
  // Keyed on the value rather than on truthiness: `refreshKey > 0` made every
  // later fetch — including each poll — spawn a ccusage child for the rest of
  // the panel's life, to re-read data the server had already cached.
  const forcedRef = useRef(refreshKey);
  useEffect(() => {
    let alive = true;
    const force = refreshKey !== forcedRef.current;
    forcedRef.current = refreshKey;
    const want = period;
    const since = sinceFor(want);
    setLoading(true);
    fetch(`/api/ccusage?since=${since}${force ? "&refresh=1" : ""}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive && d?.ok) setLanded({ period: want, data: d }); })
      // A deck that is down, or a ccusage that is not there. The panel says so
      // by falling back to the board, not by showing an error over numbers it
      // still has — and a failure leaves the last good reading standing rather
      // than blanking a panel that was correct a moment ago.
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [period, refreshKey, tick]);

  return {
    data: landed?.data ?? null,
    // What the numbers on screen are OF, which is not what the chips say while
    // a slower range is loading.
    shown: landed?.period ?? null,
    loading,
    stale: landed != null && landed.period !== period,
  };
}

export default function UsagePanel({ state, now, providers, onClose }: Props) {
  const { quota, loading: quotaLoading, refresh: refreshQuota } = useQuota(providers.claude);
  const { data: codexQuota, loading: codexLoading, refresh: refreshCodex } = useCodexQuota(providers.codex);
  const { data: codexUsage } = useCodexUsage(providers.codex);

  // Tick every 30s so countdowns + pace stay live without parent re-render
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(t);
  }, []);
  // Both memos below key on `state.revision`, not on `state.lastSeq`. The
  // `state` prop is `stateRef.current` and `applyEvent` mutates it in place, so
  // its identity never moves after mount and the second dep is the whole of
  // what decides whether either of these recomputes. `lastSeq` answers "when did
  // the last envelope arrive", which is a different question from "has anything
  // in here changed": the four periodic sweeps mutate this same object every
  // 250ms tick and move only `revision` — see the note on GraphState.
  //
  // This one carries `now` as well, because `burnRate` divides by wall-clock
  // elapsed and has to keep counting while nothing arrives. That third dep is
  // also what hid the wrong second one: `now` is a fresh Date.now() every tick,
  // so this recomputed four times a second whatever `lastSeq` said, and the
  // headline strip stayed honest through a prune by luck rather than by rule.
  // `bySessions` below has no clock in it, and it is the one that went stale.
  const { byModel, totalCost, totalTokens, burnRate } = useMemo(() => {
    const modelMap = new Map<string, ModelRow>();
    // The headline's own arithmetic is `boardTotals`, called once below rather
    // than accumulated here (#687). It was a second copy of the topbar's, and
    // the file it moved to is the file that declares what the figure may be
    // called — which is the whole of the fix: the sum walks the agents on the
    // canvas, the pruners take agents off the canvas, and the only honest label
    // for such a number names the canvas. Splitting the label from the sum is
    // how "total spend" came to stand over a figure that falls by a third on a
    // quiet tick.
    //
    // One pass per MODEL SHARE below, not one per agent (#686). An agent whose
    // session switched model contributes a share to each row it actually spent
    // on, with the tokens that model produced and the dollars those tokens cost
    // — so this table is finally a breakdown of the deck rather than a
    // restatement of every session's last turn, and a mostly-Opus session that
    // ended on Sonnet shows up as an Opus row AND a Sonnet row instead of one
    // Sonnet row holding the whole 1.1M. The rows still sum to the headline,
    // because `boardTotals` prices the same shares through the same helper.
    for (const a of state.agents.values()) {
      for (const e of usageByModelEntries(a)) {
        const key = e.model ?? UNKNOWN_MODEL;
        const c = costForUsage(e.usage, e.model);
        const row = modelMap.get(key);
        if (row) {
          row.inputTokens        += e.usage.inputTokens;
          row.outputTokens       += e.usage.outputTokens;
          row.cacheReadTokens    += e.usage.cacheReadTokens;
          row.cacheCreateTokens  += e.usage.cacheCreateTokens;
          row.cost.total         += c.total;
          row.cost.input         += c.input;
          row.cost.output        += c.output;
          row.cost.cacheRead     += c.cacheRead;
          row.cost.cacheWrite    += c.cacheWrite;
          row.agentCount++;
        } else {
          modelMap.set(key, {
            model: key,
            inputTokens:       e.usage.inputTokens,
            outputTokens:      e.usage.outputTokens,
            cacheReadTokens:   e.usage.cacheReadTokens,
            cacheCreateTokens: e.usage.cacheCreateTokens,
            cost: { ...c },
            agentCount: 1,
            priced: ratesForModel(e.model) != null,
          });
        }
      }
    }

    // Cost first, then tokens. Every unpriced row costs exactly zero, so
    // without the tiebreak they arrive at the bottom of the table in Map
    // insertion order — which is the order their agents happened to be observed
    // in, and reads as no order at all. Tokens are the only magnitude those
    // rows have.
    const byModel = Array.from(modelMap.values()).sort((a, b) =>
      (b.cost.total - a.cost.total)
      || ((b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)));

    let liveCost = 0, liveSec = 0;
    for (const a of state.agents.values()) {
      if (a.state !== "active") continue;
      const c = agentCost(a);
      liveCost += c.total;
      liveSec = Math.max(liveSec, ((a.endedAt ?? now) - a.startedAt) / 1000);
    }
    const burnRate = liveSec > 0 ? fmtCostRate(liveCost, liveSec) : null;

    const board = boardTotals(state.agents.values());
    return {
      byModel,
      totalCost: board.cost,
      totalTokens: board,
      burnRate,
    };
  }, [state, state.revision, now]);

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
  const bySessions = useMemo((): SessionRow[] => {
    const roots: SessionRow[] = [];
    // A session's tokens that no rate could be applied to, counted per agent
    // because a session can mix providers — a Claude root that spawned a Codex
    // subagent prices one and not the other — and, since #686, per MODEL inside
    // each agent as well: a root that ran on a priced model and then on one this
    // build has never heard of has to print its priced dollars with the floor
    // marker beside them, not swing between fully priced and fully unpriced
    // depending on which model wrote its last line.
    for (const a of state.agents.values()) {
      if (a.kind !== "root") continue;
      let cost = agentCost(a).total;
      let inT = a.usage.inputTokens, outT = a.usage.outputTokens;
      let unpricedT = agentUnpricedTokens(a);
      for (const sub of state.agents.values()) {
        if (sub.sessionId !== a.sessionId || sub.kind === "root") continue;
        cost += agentCost(sub).total;
        inT  += sub.usage.inputTokens;
        outT += sub.usage.outputTokens;
        unpricedT += agentUnpricedTokens(sub);
      }
      roots.push({
        sessionId: a.sessionId,
        label: a.label || a.cwdBasename || "session",
        state: a.state,
        cost,
        inputTokens: inT,
        outputTokens: outT,
        unpricedTokens: unpricedT,
      });
    }
    // Same tiebreak as byModel, and it matters more here: this list is cut at
    // twelve, so before the fallback an unpriced session — however large — sat
    // at cost zero among every other zero and could be cut for a row with
    // fewer tokens than it.
    return roots
      .sort((a, b) => (b.cost - a.cost)
        || ((b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)))
      .slice(0, 12);
  }, [state, state.revision]);

  // ── which source the figures come from ──────────────────────────────────
  //
  // ccusage when it answered, the board when it did not. Everything below this
  // point reads one pair of lists and one pair of totals, so the two sources
  // meet here and nowhere else — the tables, the strip and the headline are the
  // same markup either way.
  const [period, setPeriod] = useState<PeriodKey>("today");
  const [rangeRefresh, setRangeRefresh] = useState(0);
  // `loading` is deliberately not read here. What the reader needs to know is
  // that the figures on screen are the PREVIOUS range's, which is `stale`; a
  // refresh of the range already shown changes nothing they can act on, and
  // dimming for it would make the panel flicker every five minutes on its own
  // poll.
  const { data: range, shown: shownPeriod, stale: rangeStale } =
    useUsageRange(period, rangeRefresh);
  const fromRange = range != null;

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

  // The word over the figures names the range the figures came from, not the
  // chip the reader just pressed. While a slower range loads, the panel reads
  // "$4.20 today" with `all` pressed and dimmed — never "$4.20 all time".
  const periodNoun = PERIODS.find(p => p.key === (shownPeriod ?? period))?.noun ?? "today";

  // WHAT DIMS WHILE A SLOWER RANGE LOADS, and it is the numbers rather than the
  // chips. The sheet's own rule: --dim-off means "this control cannot be
  // operated" and --dim-stale means "a newer reading is on its way, this one was
  // true a moment ago". Dimming the strip said the first about controls that
  // stay pressable; dimming the figures says the second about the figures, which
  // is what is actually out of date.
  const staleCls = rangeStale ? " up-stale" : "";

  const hasCost = fromRange ? rangeSum.cost > 0 : totalCost.total > 0;
  const totalTokenSum = fromRange ? rangeSum.tokens : totalTokens.sum;
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
  // Per section, not per panel. The two quotas come from different places and
  // now age at very different rates — Codex is fetched here, Claude is usually
  // read from claude-swap's last collection, which can be half an hour old.
  // One combined "just now" in the header took the fresher of the two and
  // stamped it on both.
  const claudeAge = ageLabel(quota?.fetchedAt, nowSec);
  const codexAge  = ageLabel(codexQuota?.fetchedAt, nowSec);

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
    <aside className="usage-panel" id="usage-panel" aria-label="Usage">
      <div className="up-header">
        {/* h2, under the topbar's h1 (#381). Same level as the other panels'
            titles, and the four `up-section-title`s below stepped from h4 to h3
            with it, so the panel reads h1 → h2 → h3 with nothing skipped. */}
        <h2>Usage</h2>
        {burnRate && <span className="up-rate">{burnRate}</span>}
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
      <section className="up-section up-quota-section">
        <h3 className="up-section-title">
          Claude quota
          {/* Where the numbers came from, on hover. Anthropic's usage endpoint
              allows ~28-30 calls an hour per account, shared by every tool on
              the machine, so when claude-swap is already collecting them the
              deck reads its store instead of spending a second call — which is
              why this age is minutes rather than seconds. */}
          {claudeAge && !quotaLoading && (
            <span className="up-section-age" title={quotaSourceHint(quota?.source)}>{claudeAge}</span>
          )}
        </h3>
        {quota?.ok ? (
          <div className="up-quota-bars">
            {quota.session5hPct != null && (
              <QuotaBar
                label="5-hour window"
                pct={quota.session5hPct}
                reset={quota.session5hReset}
                resetAt={quota.session5hResetAt}
                windowSec={quota.session5hWindowSec}
                nowSec={nowSec}
              />
            )}
            {quota.week7dPct != null && (
              <QuotaBar
                label="7-day window"
                pct={quota.week7dPct}
                reset={quota.week7dReset}
                resetAt={quota.week7dResetAt}
                windowSec={quota.week7dWindowSec}
                nowSec={nowSec}
              />
            )}
            {quota.weekSonnetPct != null && (
              <QuotaBar label="Sonnet (7d)" pct={quota.weekSonnetPct} nowSec={nowSec} />
            )}
            {quota.weekOpusPct != null && (
              <QuotaBar label="Opus (7d)" pct={quota.weekOpusPct} nowSec={nowSec} />
            )}
          </div>
        ) : quota?.ok === false ? (
          <div className="up-quota-na">
            <span>{quota.reason === "no_subscription" ? "No quota to show." : "Quota unavailable."}</span>
            <span className="up-quota-hint">{claudeQuotaHint(quota.reason)}</span>
          </div>
        ) : (
          <div className="up-quota-na up-quota-loading">Checking…</div>
        )}
      </section>
      )}

      {/* ── Codex quota ──
          The mirror of the accounts panel, and fixed by the same fact arriving
          from /api/health: a Claude-only machine used to carry "Quota
          unavailable. / Run codex login to authenticate." permanently, for a
          CLI it has no reason to install. */}
      {providers.codex && (
      <section className="up-section up-quota-section">
        <h3 className="up-section-title">
          Codex quota
          {codexQuota?.ok && codexQuota.planLabel && (
            <span className="up-plan-badge">{codexQuota.planLabel}</span>
          )}
          {codexAge && !codexLoading && (
            <span className="up-section-age" title="Fetched from the Codex usage endpoint">{codexAge}</span>
          )}
        </h3>
        {codexQuota?.ok ? (
          <div className="up-quota-bars">
            {codexQuota.windows?.map(w => (
              <QuotaBar
                key={w.id}
                label={w.label}
                pct={w.pct}
                reset={w.reset ?? undefined}
                resetAt={w.resetAt ?? undefined}
                windowSec={w.windowSec ?? undefined}
                limitReached={codexQuota.limitReached && w.pct >= 100}
                nowSec={nowSec}
              />
            ))}

            {/* Per-model families (Codex Spark and friends) — separate caps
                that run out independently of the account-wide lanes. */}
            {codexQuota.extraWindows?.map(w => (
              <QuotaBar
                key={w.id}
                label={w.label}
                pct={w.pct}
                reset={w.reset ?? undefined}
                resetAt={w.resetAt ?? undefined}
                windowSec={w.windowSec ?? undefined}
                nowSec={nowSec}
              />
            ))}

            {/* Spend cap (team/enterprise, or a personal monthly credit limit).
                Denominated in dollars, so it gets its own bar rather than
                pretending to be a rate-limit lane. */}
            {codexQuota.creditLimit && (
              <QuotaBar
                label={`spend cap · $${Math.round(codexQuota.creditLimit.used)} of $${Math.round(codexQuota.creditLimit.limit)}`}
                pct={codexQuota.creditLimit.usedPct}
                reset={codexQuota.creditLimit.reset ?? undefined}
                resetAt={codexQuota.creditLimit.resetAt ?? undefined}
                limitReached={codexQuota.spendControlReached}
                nowSec={nowSec}
              />
            )}

            {codexQuota.creditsBalance && !codexQuota.creditsUnlimited && (
              <div className="up-quota-sub up-credits">
                credits: ${codexQuota.creditsBalance}
                {codexQuota.overageReached && " · overage limit reached"}
              </div>
            )}
            {codexQuota.creditsUnlimited && (
              <div className="up-quota-sub up-credits">credits: unlimited</div>
            )}
            {codexQuota.resetCredits && codexQuota.resetCredits.availableCount > 0 && (
              <div className="up-quota-sub up-reset-credits" title={`Redeem in the Codex CLI or ChatGPT — ${PRODUCT} only reports them`}>
                {codexQuota.resetCredits.availableCount} rate-limit reset
                {codexQuota.resetCredits.availableCount !== 1 ? "s" : ""} available
                {codexQuota.resetCredits.nextExpiryAt &&
                  ` · expires ${new Date(codexQuota.resetCredits.nextExpiryAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
              </div>
            )}
            {codexQuota.promo && (
              <div className="up-quota-sub">{codexQuota.promo}</div>
            )}
            {codexQuota.partial && (
              <div className="up-quota-sub up-quota-hint">
                Partial data — OpenAI returned limits this build doesn't recognise.
              </div>
            )}
          </div>
        ) : codexQuota?.ok === false ? (
          <div className="up-quota-na">
            <span>Quota unavailable.</span>
            <span className="up-quota-hint">{codexHint(codexQuota.reason)}</span>
          </div>
        ) : (
          <div className="up-quota-na up-quota-loading">Checking…</div>
        )}

        {/* The 7-day token count, from the rollout files on this disk. It sits
            OUTSIDE the three quota branches above, which is the whole point:
            until #400 it was nested in the success branch, so the one number in
            this section that needs no token, no account and no network was
            withheld whenever the network call failed — on `no_token`, on
            `api_key_mode`, on an expired refresh, on blocked egress. The poll
            ran every 60s regardless and its answer was thrown away.
            Measured on this machine, cold cache, three rounds: /api/codex-usage
            takes 2-4ms and makes zero outbound requests; /api/codex-quota takes
            991-1299ms across two authenticated HTTPS GETs to chatgpt.com. The
            fast local number was waiting on the slow remote one for permission
            to render.
            The 5h window goes in the title rather than on the line: the server
            has computed it since this file was written and nothing has ever
            read it, and this panel is 280px wide (#369) — a second visible
            figure costs more than it says. */}
        {codexUsage?.ok && codexUsage.window7d && codexUsage.window7d.sessionCount > 0 && (
          <div
            className="up-quota-sub"
            title={`Counted from the rollout files under CODEX_HOME — no network, no account${
              codexUsage.window5h ? `\nlast 5h: ${fmtTokens(codexUsage.window5h.totalTokens)} tokens · ${codexUsage.window5h.sessionCount} session${codexUsage.window5h.sessionCount !== 1 ? "s" : ""}` : ""
            }`}
          >
            {fmtTokens(codexUsage.window7d.totalTokens)} tokens · {codexUsage.window7d.sessionCount} session
            {codexUsage.window7d.sessionCount !== 1 ? "s" : ""} (7d)
          </div>
        )}
      </section>
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
        <div className="uh-range up-period" role="group" aria-label="Period">
          {PERIODS.map(p => (
            <button
              key={p.key}
              type="button"
              aria-pressed={period === p.key}
              className="uh-range-btn"
              onClick={() => setPeriod(p.key)}
            >{p.label}</button>
          ))}
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
                <span className="up-total-value">{fmtCost(fromRange ? rangeSum.cost : totalCost.total)}</span>
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
              {!fromRange && <CostBar cost={totalCost} />}
            </>
          )}

          <div className={`up-tokens-row${staleCls}`} title={fromRange ? undefined : BOARD_SCOPE_TITLE}>
            <span className="up-tok"><span className="up-k">in</span>{fmtTokens(fromRange ? rangeSum.inputTokens : totalTokens.inputTokens)}</span>
            <span className="up-tok"><span className="up-k">out</span>{fmtTokens(fromRange ? rangeSum.outputTokens : totalTokens.outputTokens)}</span>
            {(fromRange ? rangeSum.cacheReadTokens : totalTokens.cacheReadTokens) > 0 && <span className="up-tok"><span className="up-k">cache r</span>{fmtTokens(fromRange ? rangeSum.cacheReadTokens : totalTokens.cacheReadTokens)}</span>}
            {(fromRange ? rangeSum.cacheCreateTokens : totalTokens.cacheCreateTokens) > 0 && <span className="up-tok"><span className="up-k">cache c</span>{fmtTokens(fromRange ? rangeSum.cacheCreateTokens : totalTokens.cacheCreateTokens)}</span>}
            {/* On a deck where nothing is priced there is no headline above this
                — the money block is gated on cost — so the strip is the only
                aggregate on screen and the only place left to say what it is
                the aggregate OF. Said once either way: with a headline present
                this would be the same words twice on a 280px panel. */}
            {!hasCost && <span className="up-tok up-scope">{BOARD_SCOPE_LABEL}</span>}
          </div>

          {/* THE LIVE NUMBER, KEPT AND KEPT SEPARATE.
              Everything above this line is ccusage's — a period, off the logs
              on disk, which do not forget. This one is the canvas's: what the
              sessions currently drawn have spent. They are different
              measurements and the panel used to have only the second one under
              a word that implied the first (#687), so the fix is not to delete
              it but to label it and stand it apart. It carries the same tooltip
              it always did, which is where "this falls on its own" is said.
              Only when there is something to say: a board with no priced
              session would otherwise print "$0.00 on this board" beneath a
              month's real spend, which reads as a contradiction rather than as
              a second scope. */}
          {fromRange && totalCost.total > 0 && (
            <div className="up-live" title={BOARD_SCOPE_TITLE}>
              <span className="up-live-value">{fmtCost(totalCost.total)}</span>
              <span className="up-live-label">{BOARD_SCOPE_LABEL} now</span>
            </div>
          )}

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

          {(fromRange ? rangeSessionRows.length : boardSessionRows.length) > 0 && (
            <section className={`up-section${staleCls}`}>
              {/* WHAT A ccusage SESSION ROW IS, said on the heading rather than
                  in a tooltip, because the reader can see the arithmetic fail
                  without it. `--since` picks WHICH sessions appear; it does not
                  cut their figures to the window. Measured on this machine:
                  session 07ac7b2b spans Sep 2-4 and reports the same $376.88
                  whether asked for today or for all time, and today's rows then
                  sum to $4,391 under a day that cost $839.
                  Both numbers are right and they answer different questions —
                  "what did today cost" and "what has each session running today
                  cost in total" — so the heading names the second one. */}
              <h3 className="up-section-title">
                By session
                {fromRange && (
                  <span
                    className="up-section-age"
                    title={`Sessions with activity ${periodNoun}, each showing what that session has cost since it started.\nA session that began earlier brings its whole total with it, so these rows can add up to more than the figure above.`}
                  >active {periodNoun}</span>
                )}
              </h3>
              <div className="up-sessions">
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
          )}

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
