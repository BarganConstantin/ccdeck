// The strip under the topbar, and which of its five banners it shows: a
// restart that has just landed, a dropped connection, a release waiting, a
// deck started under its old name, or the one question the deck asks about
// itself — at most one, in that order.
//
// Moved out of App.tsx's markup unchanged. Each banner is its own component;
// this is the order they outrank each other in. Each hook's return comes in
// whole and is taken apart here under the names the markup already used.
import type { useAutoRestart } from "../use-auto-restart";
import type { useDeckUpgrade } from "../use-deck-upgrade";
import type { useOldNameNotice } from "../use-old-name-notice";
import type { useRatingAsk } from "../use-rating-ask";
import type { useVersionCheck } from "../use-version-check";
import ConnectionBanner from "./ConnectionBanner";
import OldNameBanner from "./OldNameBanner";
import RatingBanner, { RATING_THANKS } from "./RatingBanner";
import VersionBanner from "./VersionBanner";

export default function DeckBanner({
  restart, versionCheck, upgrade, oldNameNotice, rating, onFeedback, everConnected, live, paused,
}: {
  restart: ReturnType<typeof useAutoRestart>;
  versionCheck: ReturnType<typeof useVersionCheck>;
  upgrade: ReturnType<typeof useDeckUpgrade>;
  oldNameNotice: ReturnType<typeof useOldNameNotice>;
  rating: ReturnType<typeof useRatingAsk>;
  /** Opens the feedback dialog, blank — the low-score thanks offers it. */
  onFeedback: () => void;
  /** Whether the stream has connected at least once, and whether it is now. */
  everConnected: boolean;
  live: boolean;
  paused: boolean;
}) {
  const { autoRestart, toggleAutoRestart, restarting, restartMode, restartedTo, askRestart,
          restartCopy, restartFuseMs } = restart;
  const { version, notice, noticeOpen, dismissNotice } = versionCheck;
  const { upgradeState, startUpgrade, copyCommand, cmdCopied } = upgrade;
  const { oldName, oldNameOpen, dismissOldName } = oldNameNotice;
  const { ratingPhase, ratingScore, answerRating, rateLater, closeRating, holdThanks } = rating;
  const row = (
    restartedTo ? (
      // Outranks both: it is the shortest-lived of the three and it answers
      // the question the other two just raised.
      <div className="ver-banner done" role="status">
        <span className="ver-dot" />
        <strong>Restarted — now running v{restartedTo}.</strong>
        <span className="ver-sub">The canvas replayed from the event log.</span>
      </div>
    ) : everConnected && !live ? (
      <ConnectionBanner restarting={restarting} restartMode={restartMode} live={live} paused={paused} />
    ) : noticeOpen && notice ? (
      <VersionBanner
        notice={notice} version={version} dismissNotice={dismissNotice}
        upgradeState={upgradeState} startUpgrade={startUpgrade} copyCommand={copyCommand} cmdCopied={cmdCopied}
        autoRestart={autoRestart} toggleAutoRestart={toggleAutoRestart} askRestart={askRestart}
        restartCopy={restartCopy} restartFuseMs={restartFuseMs} restarting={restarting}
      />
    ) : oldNameOpen && oldName ? (
      // Last of the four, because it is the only one nobody has to act on
      // today: a dropped connection, a restart and a release all outrank a
      // name. It comes back the moment the row above it is dismissed.
      <OldNameBanner oldName={oldName} version={version} dismissOldName={dismissOldName} />
    ) : ratingPhase !== "hidden" ? (
      // Last of all: a question about us waits behind anything the reader has
      // to act on, and comes back when the row above it goes.
      <RatingBanner
        phase={ratingPhase} score={ratingScore} onAnswer={answerRating} onLater={rateLater} onClose={closeRating}
        onFeedback={onFeedback} onHold={holdThanks}
      />
    ) : null
  );
  return (
    <>
      {row}
      {/* The thanks, said. Mounted whether or not there is anything to say,
          for the reason App.tsx's removal notice is (#372): words that arrive
          with their region are the ones screen readers drop, and the thanks
          used to be the question's own row turned into a live region in the
          same render as its words. */}
      <div className="vis-hidden" role="status" aria-atomic="true">
        {ratingPhase === "thanks" ? RATING_THANKS : ""}
      </div>
    </>
  );
}
