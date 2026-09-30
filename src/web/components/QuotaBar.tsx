// One quota window drawn as a bar: how full it is, when it resets, and the pace
// that would last until then.
//
// Lifted out of UsagePanel.tsx unchanged, with the pace arithmetic it draws
// (computePace). Every bar in the panel's two quota sections is this component
// — Claude's windows and its top-up, Codex's lanes and its spend cap — so the
// rules for when a bar turns amber or red, and what its pace note says, are
// written once. The one piece of state it holds is its own: whether that note
// is open (#856).
import { useId, useState } from "react";
import { resetCountdown } from "../relative-time";

// ── Pace helpers ───────────────────────────────────────────────────────────

interface PaceInfo {
  label: string;
  color: string;
  expectedPct: number;  // where usage "should" be now — the green-line marker position
  isDeficit: boolean;   // true when burning faster than sustainable
  runsOutIn?: string;   // set when deficit and ETA < window remaining
}

export function computePace(pct: number, resetAtSec: number, windowSec: number, nowSec: number, limitReached = false): PaceInfo | null {
  const remainSec  = Math.max(0, resetAtSec - nowSec);
  const elapsedSec = Math.max(0, windowSec - remainSec);
  if (elapsedSec < 120) return null; // too early to judge
  const expectedPct = Math.min(100, (elapsedSec / windowSec) * 100);
  const delta = pct - expectedPct;

  // A window at its limit has nothing left to run out of (#1805). What is left
  // was measured as `100 - pct`, so a full one "ran out" in zero seconds and
  // the note under a full red bar read "runs out in 0m" — or "on pace", near
  // the end of the window. Said before either, in the over-pace colours.
  if (limitReached || pct >= 100) {
    return { label: "used up", color: "var(--warn)", expectedPct, isDeficit: true };
  }

  if (Math.abs(delta) < 3) {
    return { label: "on pace", color: "var(--ok)", expectedPct, isDeficit: false };
  }

  if (delta > 0) {
    // using more than expected → deficit (burning too fast)
    const remainPct = 100 - pct;
    const ratePerSec = elapsedSec > 0 ? pct / elapsedSec : 0;
    const runsOutSec = ratePerSec > 0 ? remainPct / ratePerSec : Infinity;
    const info: PaceInfo = {
      // "over pace", not "ahead" (#823): ahead reads as winning, and this is
      // the warning — the amber line was taken for good news.
      label: `${Math.round(delta)}% over pace`, color: "var(--warn)",
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
  return { label: `${Math.round(-delta)}% under pace`, color: "var(--ok)", expectedPct, isDeficit: false };
}

// ── Quota bar ──────────────────────────────────────────────────────────────
interface QuotaBarProps {
  /** How full the window is, or null when the source sent no reading for it.
   *  Null is drawn as "no reading" over an empty track (#1627): a zero here
   *  printed "< 1%", which is a measurement nobody took. */
  pct: number | null;
  label: string;
  reset?: string;
  resetAt?: number;    // unix seconds — enables live countdown
  windowSec?: number;  // enables pace calculation
  limitReached?: boolean;
  nowSec: number;      // current time in seconds (for countdown + pace)
}
export default function QuotaBar({ pct, label, reset, resetAt, windowSec, limitReached, nowSec }: QuotaBarProps) {
  // No reading draws no fill, no level colour and no pace: every one of those
  // is a statement about a number, and there is none (#1627).
  const known    = pct != null;
  const capped   = known ? Math.min(100, Math.max(0, pct)) : 0;
  const isErr    = limitReached || capped >= 90;
  const color    = isErr ? "var(--err)" : capped >= 70 ? "var(--warn)" : "var(--accent)";
  // A whole percentage, the way Claude's readings already arrive (clampPct).
  // A Codex spend cap is `used / limit * 100` and printed $10 of $30 as
  // "33.33333333333333%" (#1804). Under 1% reads "< 1%" like a zero does:
  // 0.25% of the track is a fill nobody can see.
  const underOne = capped < 1;
  const pctLabel = !known ? "no reading" : underOne ? "< 1%" : `${Math.round(capped)}%`;
  // minimum 2% visual fill so a bar under 1% is still visible as a thin sliver
  const fillW    = underOne ? 2 : capped;

  const countdown = resetAt ? resetCountdown(resetAt, nowSec) : null;
  const pace = (known && resetAt && windowSec) ? computePace(capped, resetAt, windowSec, nowSec, limitReached) : null;
  // The note opens the number it is measured against (#856).
  const [why, setWhy] = useState(false);
  const whyId = useId();

  return (
    <div className="qb-row">
      <div className="qb-meta">
        <span className="qb-label">
          {label}
          {limitReached && <span className="qb-limit-badge" title="Rate limit reached">⛔</span>}
        </span>
        <span className="qb-pct" style={{ color: known ? color : "var(--muted)" }}>{pctLabel}</span>
      </div>
      <div className="qb-track">
        {known && <div className="qb-fill" style={{ transform: `scaleX(${fillW / 100})`, background: color, opacity: underOne ? 0.4 : 1 }} />}
        {/* Pace marker ("green line"): where usage should be now to last until
            reset. Green when under or on pace, red when over it. Its legend is
            the note under the bar (#850), so the tick itself is not announced. */}
        {pace && (
          // A rail as wide as the track slides, carrying the marker at its
          // left edge (#863): translateX's percentage is of the rail's own
          // width, so this lands where `left` did, without a layout pass.
          <div className="qb-pace-rail" style={{ transform: `translateX(${pace.expectedPct}%)` }}>
            <div
              aria-hidden
              className="qb-pace-marker"
              style={{ background: pace.isDeficit ? "var(--err)" : "var(--ok)" }}
              title={`To last until reset, stay near ${Math.round(pace.expectedPct)}% by now`}
            />
          </div>
        )}
      </div>
      <div className="qb-reset-row">
        {countdown
          ? <span className="qb-reset">resets in {countdown}</span>
          : reset
            ? <span className="qb-reset">resets {reset}</span>
            : null}
        {pace && (
          <button
            type="button"
            className="qb-pace"
            style={{ color: pace.color }}
            aria-expanded={why}
            aria-controls={why ? whyId : undefined}
            onClick={() => setWhy(w => !w)}
          >
            {/* The marker's own line, in the marker's own colour: a legend
                that says the tick on the bar is the pace these words are
                measured against (#850). */}
            <i className="qb-pace-key" aria-hidden style={{ background: pace.isDeficit ? "var(--err)" : "var(--ok)" }} />
            {pace.runsOutIn ? `runs out in ${pace.runsOutIn}` : pace.label}
          </button>
        )}
      </div>
      {why && pace && <div id={whyId} className="qb-why">To last until reset, stay near {Math.round(pace.expectedPct)}% by now.</div>}
    </div>
  );
}
