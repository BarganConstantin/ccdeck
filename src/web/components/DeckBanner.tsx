// The strip under the topbar, and which of its five banners it shows: a
// restart that has just landed, a dropped connection, a release waiting, a
// deck started under its old name, or the one question the deck asks about
// itself — at most one, in that order.
//
// Moved out of App.tsx's markup unchanged. Each banner is its own component;
// this is the order they outrank each other in. Each hook's return comes in
// whole and is taken apart here under the names the markup already used.
//
// The strip also owns how a banner comes and goes (V4's motion rules): it
// opens its height and fades in over Base, and on the way out it fades and
// closes over Exit, drawn until it has gone. A banner that changes its words
// swaps at once, in place. Under reduced motion the space is there at once and
// only the fade is left.
import { useCallback, useEffect, useRef, useState, type ReactNode, type TransitionEvent } from "react";
import { EXIT_SLACK_MS, finish, isDrawn, settle, startPresence, type Presence } from "../dialog-presence";
import { tokenMs } from "../rail-motion";
import { sentences } from "../banner-sentences";
import type { useAutoRestart } from "../use-auto-restart";
import type { useDeckUpgrade } from "../use-deck-upgrade";
import type { useOldNameNotice } from "../use-old-name-notice";
import type { useRatingAsk } from "../use-rating-ask";
import type { useVersionCheck } from "../use-version-check";
import BannerMark from "./BannerMark";
import ConnectionBanner from "./ConnectionBanner";
import OldNameBanner from "./OldNameBanner";
import RatingBanner, { ratingThanks } from "./RatingBanner";
import { useT } from "../i18n";
import { StripHeight } from "../use-strip-height";
import VersionBanner from "./VersionBanner";
import { KitIcon } from "./kit-icons";

/** The strip's holder: `grid-template-rows` 0fr to 1fr and its opacity, in
 *  CSS transitions (search-and-banners.css), so a banner asked back while it
 *  leaves turns round from where it is. The last row stays drawn, inert, for
 *  the length of the exit. */
export function BannerStrip({ children }: { children: ReactNode }) {
  const last = useRef<ReactNode>(null);
  const open = children != null;
  if (open) last.current = children;
  const [p, setP] = useState<Presence>(() => startPresence(open));
  // A banner leaves with the pointer and with a key alike: it is a row going,
  // not a surface the key opened.
  const next = settle(p, open, { instant: false, hasContent: last.current != null });
  if (next !== p) setP(next);
  const leaving = next.closing;
  const gone = useCallback(() => setP(finish), []);
  useEffect(() => {
    if (!leaving) return;
    const id = window.setTimeout(gone, tokenMs("--dur-exit") + EXIT_SLACK_MS);
    return () => window.clearTimeout(id);
  }, [leaving, gone]);
  if (!isDrawn(next)) {
    last.current = null;
    return null;
  }
  const onTransitionEnd = (e: TransitionEvent<HTMLDivElement>) => {
    if (leaving && e.target === e.currentTarget && e.propertyName === "opacity") gone();
  };
  // `inert` is not in React 18's attribute types; it is a plain attribute.
  const inert = leaving ? { inert: "" } : {};
  return (
    <div className="banner-strip" data-open={leaving ? undefined : ""} {...inert} onTransitionEnd={onTransitionEnd}>
      <div className="banner-strip-in">{open ? children : last.current}</div>
    </div>
  );
}

export default function DeckBanner({
  restart, versionCheck, upgrade, oldNameNotice, rating, onFeedback, everConnected, live, paused, phone = false,
  lastNewsAt = null, cardInList = false,
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
  /** 640px and under: the dropped connection says it in the phone's words. */
  phone?: boolean;
  /** When the stream last had news, named by the phone's card. */
  lastNewsAt?: number | null;
  /** The Sessions panel is up on a phone and holds the "Can't reach your
   *  computer" card itself: the strip does not draw it a second time under
   *  the panel. */
  cardInList?: boolean;
}) {
  const t = useT();
  const { restarting, restartMode, restartedTo, dismissRestarted, askRestart, restartCopy, restartFuseMs } = restart;
  const { version, notice, noticeOpen, dismissNotice } = versionCheck;
  const { upgradeState, startUpgrade, copyCommand, cmdCopied } = upgrade;
  const { oldName, oldNameOpen, dismissOldName } = oldNameNotice;
  const { ratingPhase, ratingScore, answerRating, rateLater, closeRating, holdThanks } = rating;
  const row = (
    restartedTo ? (
      // Outranks both: it is the shortest-lived of the three and it answers
      // the question the other two just raised.
      <div className="ver-banner done" role="status">
        <BannerMark glyph="done" tone="ok" />
        <strong>{sentences(t("shell.banner.restartedTo", { version: restartedTo }), t("shell.banner.replayed"))}</strong>
        <button type="button" aria-label={t("shell.dismiss")} className="ver-close" onClick={dismissRestarted}><KitIcon name="close" /></button>
      </div>
    ) : everConnected && !live ? (
      phone && cardInList && !restarting ? null
        : <ConnectionBanner restarting={restarting} restartMode={restartMode} live={live} paused={paused} phone={phone} lastNewsAt={lastNewsAt} />
    ) : noticeOpen && notice ? (
      <VersionBanner
        notice={notice} version={version} dismissNotice={dismissNotice}
        upgradeState={upgradeState} startUpgrade={startUpgrade} copyCommand={copyCommand} cmdCopied={cmdCopied}
        askRestart={askRestart} restartCopy={restartCopy} restartFuseMs={restartFuseMs} restarting={restarting}
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
      <BannerStrip>{row}</BannerStrip>
      {/* Tells the rail how tall the row above is (use-strip-height.ts). */}
      <StripHeight />
      {/* The thanks, said. Mounted whether or not there is anything to say,
          for the reason App.tsx's removal notice is (#372): words that arrive
          with their region are the ones screen readers drop, and the thanks
          used to be the question's own row turned into a live region in the
          same render as its words. */}
      <div className="vis-hidden" role="status" aria-atomic="true">
        {ratingPhase === "thanks" ? ratingThanks() : ""}
      </div>
    </>
  );
}
