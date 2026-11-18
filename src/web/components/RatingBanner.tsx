// "How useful is ccdeck to you?" — the one question the deck asks about itself,
// once, after about a week of use (use-rating-ask.ts says when; rating.mjs on
// the server decides).
//
// In the strip under the topbar, last of its banners: anything the reader has
// to act on outranks a question about us (DeckBanner.tsx). A row in the shape
// of the version banner's calm `note`, never a dialog: it takes no focus, covers
// none of the board, and the deck works the same whether or not anybody answers.
// A group named by its question rather than a live region, so it does not speak
// over whatever the reader is listening to; it is found in reading order, right
// under the topbar.
//
// After an answer, one line of thanks. A low score also offers the feedback
// dialog — empty: the number never travels with the words, and the words are
// only ever sent by pressing Send there. The thanks is said to a screen reader
// by the live region DeckBanner keeps mounted, not by this row: a region that
// arrives together with its words is one a screen reader is apt to skip.
//
// No way out of the row leaves focus on <body> (see landRef and leave below).
import { useEffect, useRef } from "react";
import { focusDropped } from "../panel-press";
import type { RatingPhase } from "../use-rating-ask";
import { t, useT } from "../i18n";
import { sentences } from "../banner-sentences";
import BannerMark from "./BannerMark";
import { KitIcon } from "./kit-icons";

/** What the thanks says, on the row and in DeckBanner's live region. */
/** The English line; ratingThanks() is the translated one. */
export const RATING_THANKS = "Thanks, that helps.";
export const ratingThanks = (): string => t("shell.rating.thanks");

const SCORES = Array.from({ length: 11 }, (_, i) => i);

/** What a screen reader hears for each number: the scale, and what its two ends mean. */
function scoreLabel(n: number): string {
  if (n === 0) return t("shell.rating.score0");
  if (n === 10) return t("shell.rating.score10");
  return t("shell.rating.score", { n });
}

/** At or under this, the thanks also offers the feedback dialog. */
const LOW_SCORE = 6;

/** Where focus goes when the row leaves with it: the canvas — App.tsx's
 *  <main>, the skip link's target — which is the next thing on the page and
 *  where the deck's own keys work again. */
function focusBoard() {
  document.getElementById("canvas")?.focus();
}

export default function RatingBanner({ phase, score, onAnswer, onLater, onClose, onFeedback, onHold }: {
  phase: RatingPhase;
  /** The number picked, once there is one. */
  score: number | null;
  onAnswer: (score: number) => void;
  onLater: () => void;
  onClose: () => void;
  /** Opens the feedback dialog, blank. The thanks stays up under it, so the
   *  dialog has its offer to give focus back to. */
  onFeedback: () => void;
  /** Focus came into the thanks, or left it: it does not go by itself while
   *  somebody is in it (use-rating-ask.ts). */
  onHold: (held: boolean) => void;
}) {
  useT();
  // The strip's height for the rail is DeckBanner's (use-strip-height.ts).
  const rowRef = useRef<HTMLDivElement>(null);
  const offerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // A NUMBER TAKES ITSELF AWAY WHEN IT IS PRESSED: the row becomes the thanks,
  // and focus fell to <body> with the button. So the thanks takes it — its
  // offer, which is what a low score is asked next, or its ×. Only after a
  // press from the keyboard (a click with no pointer count, or a button showing
  // its keyboard focus): a mouse has nothing to follow, and a thanks holding
  // focus does not go by itself.
  const landRef = useRef(false);
  useEffect(() => {
    if (phase !== "thanks" || !landRef.current) return;
    landRef.current = false;
    if (focusDropped(document.activeElement?.tagName ?? null)) (offerRef.current ?? closeRef.current)?.focus();
  }, [phase]);
  /** "Not now" and the × take the whole row; focus that was in it goes to the
   *  board first rather than to <body> after. */
  const leave = (go: () => void) => {
    if (rowRef.current?.contains(document.activeElement)) focusBoard();
    go();
  };
  if (phase === "thanks") {
    // A low score is asked what would make it better in the message itself,
    // and the short "Tell us" at the row's end opens the dialog (V4's Figma).
    const low = score !== null && score <= LOW_SCORE;
    return (
      // The same calm row the question was asked in, so the thanks reads as its
      // answer; `done`'s green and its amber button belong to a restart.
      <div
        ref={rowRef} className="ver-banner rating-banner"
        onFocus={() => onHold(true)}
        onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onHold(false); }}
      >
        <BannerMark glyph="done" tone="ok" />
        <strong>{low ? sentences(ratingThanks(), t("shell.rating.better")) : ratingThanks()}</strong>
        {low ? (
          // Named by the whole sentence, which starts with the drawn words, so
          // a screen reader hears what the short label is short for.
          <button ref={offerRef} type="button" className="ver-act" onClick={onFeedback}
            aria-label={t("shell.rating.better")}>{t("shell.rating.tellUs")}</button>
        ) : null}
        <button ref={closeRef} type="button" aria-label={t("shell.dismiss")} className="ver-close" onClick={() => leave(onClose)}><KitIcon name="close" /></button>
      </div>
    );
  }
  return (
    <div ref={rowRef} className="ver-banner rating-banner rating-ask" role="group" aria-labelledby="rating-question">
      <strong id="rating-question">{t("shell.rating.question")}</strong>
      <span className="rating-scale">
        {SCORES.map(n => (
          <button key={n} type="button" className={n === 10 ? "rating-pick ten" : "rating-pick"} aria-label={scoreLabel(n)}
            onClick={e => { landRef.current = e.detail === 0 || e.currentTarget.matches(":focus-visible"); onAnswer(n); }}>{n}</button>
        ))}
      </span>
      <span className="ver-sub rating-ends" aria-hidden="true">{t("shell.rating.ends")}</span>
      <button type="button" className="rating-later" onClick={() => leave(onLater)}>{t("shell.rating.later")}</button>
    </div>
  );
}
