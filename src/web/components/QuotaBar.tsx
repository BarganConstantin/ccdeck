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

export function computePace(pct: number, resetAtSec: number, windowSec: number, nowSec: number): PaceInfo | null {
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
  pct: number;
  label: string;
  reset?: string;
  resetAt?: number;    // unix seconds — enables live countdown
  windowSec?: number;  // enables pace calculation
  limitReached?: boolean;
  nowSec: number;      // current time in seconds (for countdown + pace)
}
export default function QuotaBar({ pct, label, reset, resetAt, windowSec, limitReached, nowSec }: QuotaBarProps) {
  const capped   = Math.min(100, Math.max(0, pct));
  const isErr    = limitReached || capped >= 90;
  const color    = isErr ? "var(--err)" : capped >= 70 ? "var(--warn)" : "var(--accent)";
  const pctLabel = capped === 0 ? "< 1%" : `${capped}%`;
  // minimum 2% visual fill so a 0% bar is still visible as a thin sliver
  const fillW    = capped === 0 ? 2 : capped;

  const countdown = resetAt ? resetCountdown(resetAt, nowSec) : null;
  const pace = (resetAt && windowSec) ? computePace(capped, resetAt, windowSec, nowSec) : null;
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
        <span className="qb-pct" style={{ color }}>{pctLabel}</span>
      </div>
      <div className="qb-track">
        <div className="qb-fill" style={{ transform: `scaleX(${fillW / 100})`, background: color, opacity: capped === 0 ? 0.4 : 1 }} />
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
