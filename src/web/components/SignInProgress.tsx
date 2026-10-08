// The sign-in, while it is happening: a ring that turns while the deck works,
// and the four stages it passes through, each ticked off as the server reports
// it (signin-stages.ts says which four and why).
//
// Drawn from props alone — no hooks, no state — so AddAccountDialog keeps every
// decision and this only lays them out. The ring sits exactly where the success
// card's check mark sits, at the same size, which is what lets the handoff be a
// ring closing into a tick rather than one screen replacing another: when the
// sign-in finishes, the turning arc fades as a green ring sweeps round under
// it, the list lifts away, and the card that follows draws only the tick.
import React from "react";
import type { StageRow, StageStatus } from "../signin-stages";

export type ProgressPhase = "live" | "failed" | "resolving";

type Props = {
  rows: StageRow[];
  phase: ProgressPhase;
  /** Drawn under the row that is active, or the one that failed. */
  detail?: React.ReactNode;
  /** The row of buttons under the list — Cancel while it can still cancel. */
  actions?: React.ReactNode;
};

/** What a screen reader adds after each row's words. Pending says nothing:
 *  "Save the credentials" in a list of steps is already a step not yet taken. */
const SAID: Record<StageStatus, string> = { done: ", done", active: ", in progress", failed: ", failed", pending: "" };

function StageIcon({ status }: { status: StageStatus }) {
  return (
    <svg className="aa-stage-icon" viewBox="0 0 16 16" aria-hidden>
      {status === "done" ? <path className="aa-stage-tick" d="M4 8.5 L7 11.5 L12.5 5" />
        : status === "failed" ? <path className="aa-stage-cross" d="M5 5 L11 11 M11 5 L5 11" />
        : status === "active" ? <circle className="aa-stage-now" cx="8" cy="8" r="3.5" />
        : <circle className="aa-stage-later" cx="8" cy="8" r="3" />}
    </svg>
  );
}

export default function SignInProgress({ rows, phase, detail, actions }: Props) {
  // Which stage is running, for the ring: it turns briskly while the deck is
  // working and slows right down while it is the reader the deck waits on.
  const at = rows.find(r => r.status === "active")?.id;
  return (
    <div className={`aa-progress ${phase}`} data-at={at}>
      {/* Same box and radius as SuccessMark's, so the two line up exactly. */}
      <svg className="aa-orbit" viewBox="0 0 44 44" aria-hidden>
        <circle className="aa-orbit-track" cx="22" cy="22" r="20" />
        {phase === "live" || phase === "resolving" ? <circle className="aa-orbit-arc" cx="22" cy="22" r="20" /> : null}
        {phase === "resolving" ? <circle className="aa-orbit-close" cx="22" cy="22" r="20" /> : null}
        {phase === "failed" ? <path className="aa-orbit-cross" d="M17 17 L27 27 M27 17 L17 27" /> : null}
      </svg>
      <ol className="aa-stages">
        {rows.map(row => {
          const open = row.status === "active" || row.status === "failed";
          return (
            <li key={row.id} className="aa-stage" data-status={row.status} aria-current={row.status === "active" ? "step" : undefined}>
              <StageIcon status={row.status} />
              <span className="aa-stage-label">{row.label}<span className="vis-hidden">{SAID[row.status]}</span></span>
              {open && detail ? <div className="aa-stage-more">{detail}</div> : null}
            </li>
          );
        })}
      </ol>
      {actions ? <div className="aa-actions aa-progress-actions">{actions}</div> : null}
    </div>
  );
}
