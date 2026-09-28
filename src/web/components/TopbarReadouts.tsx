// The readouts in the topbar's observation group: the status strip (the
// stream's pill and the month's usage), the count of sessions blocked on you,
// and what the browser answered when notifications were asked for.
//
// Moved out of App.tsx's markup unchanged. App.tsx keeps the group itself, the
// live regions that speak for these (which have to be mounted whether or not
// these are, #372) and the reasons each sits where it does; this file is only
// what each one shows.
import type { MutableRefObject } from "react";
import type { BlockedSession } from "../ambient-counts";
import { fmtMonthlyCost } from "../monthly-usage";
import { shortAgo } from "../relative-time";
import { statusPill } from "../status-pill";
import { fmtTokens } from "../token-format";
import type { useMonthlyUsage } from "../use-monthly-usage";
import type { PauseControls } from "../use-pause-gate";
import { waitingSentence } from "./AgentNode";

type MonthlyUsage = ReturnType<typeof useMonthlyUsage>;

export function StatusStrip({ live, paused, pauseGate, monthUsageRef, monthlyUsage, monthlyUsageUnavailable }: {
  /** Whether the event stream is connected right now. */
  live: boolean;
  paused: boolean;
  pauseGate: PauseControls["pauseGate"];
  monthUsageRef: MonthlyUsage["monthUsageRef"];
  monthlyUsage: MonthlyUsage["monthlyUsage"];
  monthlyUsageUnavailable: MonthlyUsage["monthlyUsageUnavailable"];
}) {
  return (
    <span className="status">
      {/* Three states, not two. Read through the gate rather than a
          counter of its own: the queue is the thing being reported.
          The count is in the LABEL now, not only the title. It used to be
          printed on the Pause button at the far end of the bar, and that
          button has gone down to the canvas control stack where the other
          canvas verbs went in #527 — so one fact stopped being split
          across two ends of a row, and the pill, which already knew the
          number, says it.
          The ghost below is what keeps that free. The pill LEADS this
          strip, so its width is upstream of everything after it — the
          machine meter, the token total, the dollar figure: a count going
          9 → 10 would walk all three, which is #504 one bar over, and the
          count moves on its own where a label never did. A copy of the
          widest label this tone can reach sits in the same grid cell as
          the live one, so the box measures its own worst case in whatever
          font the platform hands it. The alternative was a min-width in
          pixels, which is the wrong tool for a string — the number would
          be measured in the face this machine renders and shipped to
          Segoe UI and to whatever fontconfig picks, where a wider face
          overruns it and the reflow is back.
          aria-hidden AND visibility: hidden on the ghost, so it is out of
          the accessible tree twice over. The pill has no name of its own
          to protect — it is an unfocusable span, see the tab-stop note in
          topbar-interaction.test.ts — but it does have a title, and a
          reader that walks the markup should not find the word twice. */}
      {(() => {
        const pill = statusPill({
          connected: live, paused,
          held: pauseGate.size, dropped: pauseGate.dropped,
        });
        // Nothing at rest (#719). The ghost above explains why the box
        // measures its own worst case; this is the case where the box
        // itself is not earned. `.status` is a flex row, so the 14px gap
        // leaves with it and the strip closes up without anything
        // shifting on its own — the tone only ever changes because Space
        // was pressed or the stream died.
        if (pill.resting) return null;
        return (
          <span className={`pill ${pill.tone}`} title={pill.title}>
            <span className="pill-box">
              <span className="pill-widest" aria-hidden>{pill.widest}</span>
              <span className="pill-label">{pill.label}</span>
            </span>
          </span>
        );
      })()}
      {/* Month-to-date usage comes from ccusage, not from the cards that
          happen to remain on this board (#737). The label and both values
          live in one element so the period can never be separated from
          the figures it qualifies. A successful empty month is explicitly
          0 tokens / $0.00; a ccusage failure says unavailable rather than
          dressing the current board total up as history.
          THE MACHINE METER WENT THE SAME WAY, and it is the one that had
          been earning its width. A 50x24 box drew a 60-second CPU
          sparkline and a memory bar, and it was the only readout here
          that was not about agents. What it could not do is stop: it is a
          trace that moves whether or not anything on the canvas is
          happening, in the corner of a bar the eye returns to for the one
          thing this deck is for. The panel it disclosed says everything
          it said and eleven things it could not, and the button in the
          run below opens that panel without drawing anything at all. A
          glance costs a click now; the bar costs no attention.
          What is left is the one thing the bar is FOR: whether the stream
          is alive. That is a fact about right now, which is the only
          tense a topbar can keep. */}
      <span
        ref={monthUsageRef}
        className="month-usage"
        title={monthlyUsage
          ? `${monthlyUsage.tokens.toLocaleString()} tokens · ${fmtMonthlyCost(monthlyUsage.cost)} spent since the 1st of this local calendar month`
          : monthlyUsageUnavailable
            ? "Monthly usage is unavailable — ccusage could not be read"
            : "Loading usage since the 1st of this local calendar month"}
      >
        <span className="month-usage-label">this month</span>
        {monthlyUsage ? (
          <>
            <b>{fmtTokens(monthlyUsage.tokens)}</b>
            <span className="month-usage-unit">tokens</span>
            <span className="month-usage-sep" aria-hidden>·</span>
            <b>{fmtMonthlyCost(monthlyUsage.cost)}</b>
          </>
        ) : (
          <span className="month-usage-pending">{monthlyUsageUnavailable ? "unavailable" : "…"}</span>
        )}
      </span>
    </span>
  );
}

export function WaitingStat({ waitingSessions, waitingCursorRef, focusSession, now }: {
  /** The sessions blocked on you, longest-stuck first; the caller shows this only when there is one. */
  waitingSessions: BlockedSession[];
  /** Where W starts from, so a click here and the next W press agree (#825). */
  waitingCursorRef: MutableRefObject<string | null>;
  focusSession: (sessionId: string) => void;
  now: number;
}) {
  return (
    <button
      type="button"
      className="waiting-stat"
      onClick={() => {
        // The same place W starts, so the next press moves on (#825).
        waitingCursorRef.current = waitingSessions[0].id;
        focusSession(waitingSessions[0].id);
      }}
      title={`Blocked waiting for you — click, or press W, to go to the one that has been stuck longest:\n${
        waitingSessions.map(w => `  ${w.label}: ${waitingSentence(w.waiting)} (${shortAgo(now - w.waiting.since)})`).join("\n")
      }`}
      aria-label={`${waitingSessions.length} session${waitingSessions.length === 1 ? "" : "s"} waiting for you`}
    >
      <span className="ap-pulse" aria-hidden />
      <b>{waitingSessions.length}</b> <span className="ws-word">waiting</span>
    </button>
  );
}

export function NotifySaid({ notifySaid }: { notifySaid: "on" | "blocked" }) {
  return (
    <span
      // Written out rather than composed from the state, so the class
      // exists in the markup as a literal and unstyled-class.test.ts can
      // hold it to a rule in the sheet. A template here buys nothing and
      // costs the one check that catches a class with no styling behind
      // it — which is exactly how a warn colour goes missing silently.
      className={notifySaid === "on" ? "notify-said" : "notify-said notify-said-blocked"}
      role="status"
      title={notifySaid === "on"
        ? "The deck will raise a system notification when a session blocks on you and this tab is in the background"
        : "Notifications are blocked for this page. Only your browser can undo that — its site settings for this address"}
    >{notifySaid === "on" ? "notifications on" : "notifications blocked"}</span>
  );
}
