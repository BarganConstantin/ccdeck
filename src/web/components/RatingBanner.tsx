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
// only ever sent by pressing Send there.
import { useLayoutEffect, useRef } from "react";
import type { RatingPhase } from "../use-rating-ask";

const SCORES = Array.from({ length: 11 }, (_, i) => i);

/** What a screen reader hears for each number: the scale, and what its two ends mean. */
function scoreLabel(n: number): string {
  if (n === 0) return "0 out of 10, not useful";
  if (n === 10) return "10 out of 10, extremely useful";
  return `${n} out of 10`;
}

/** At or under this, the thanks also offers the feedback dialog. */
const LOW_SCORE = 6;

/** The row's height, written on the page as --rating-h for as long as the row
 *  is up. The row takes the whole width under the topbar, and the rail's two
 *  panels are fixed rather than in the grid, so this is how they know where
 *  it ends (rating.css). Measured again whenever the row wraps differently —
 *  a resized window, the thanks after the question. */
function useRowHeight(phase: RatingPhase) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = ref.current;
    const page = row?.closest<HTMLElement>(".app");
    if (!row || !page) return;
    const measure = () => page.style.setProperty("--rating-h", `${Math.ceil(row.getBoundingClientRect().height)}px`);
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(row);
    return () => { ro?.disconnect(); page.style.removeProperty("--rating-h"); };
  }, [phase]);
  return ref;
}

export default function RatingBanner({ phase, score, onAnswer, onLater, onClose, onFeedback }: {
  phase: RatingPhase;
  /** The number picked, once there is one. */
  score: number | null;
  onAnswer: (score: number) => void;
  onLater: () => void;
  onClose: () => void;
  /** Opens the feedback dialog, blank. */
  onFeedback: () => void;
}) {
  const rowRef = useRowHeight(phase);
  if (phase === "thanks") {
    return (
      // The same calm row the question was asked in, so the thanks reads as its
      // answer; `done`'s green and its amber button belong to a restart.
      <div ref={rowRef} className="ver-banner note rating-banner" role="status">
        <span className="ver-dot" />
        <strong>Thanks — that helps.</strong>
        {score !== null && score <= LOW_SCORE ? (
          <button type="button" className="ver-act" onClick={onFeedback}>Tell us what would make it better</button>
        ) : null}
        <button type="button" aria-label="Dismiss" className="ver-close" onClick={onClose}>×</button>
      </div>
    );
  }
  return (
    <div ref={rowRef} className="ver-banner note rating-banner" role="group" aria-labelledby="rating-question">
      <span className="ver-dot" />
      <strong id="rating-question">How useful is ccdeck to you?</strong>
      <span className="rating-scale">
        {SCORES.map(n => (
          <button key={n} type="button" className="rating-pick" aria-label={scoreLabel(n)} onClick={() => onAnswer(n)}>{n}</button>
        ))}
      </span>
      <span className="ver-sub rating-ends" aria-hidden="true">0 not at all · 10 extremely</span>
      <button type="button" className="ver-act" onClick={onLater}>Not now</button>
    </div>
  );
}
