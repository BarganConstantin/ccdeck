// What the deck says from a tab nobody is looking at.
//
// A deck spends almost all of its life in a background tab, and until #338 that
// tab carried exactly nothing: index.html's <title> is static markup and
// `document.title` was never assigned anywhere in src/web/, so the one surface
// that is always on screen read the same whether five sessions were blocked on a
// permission prompt or the machine had been idle since lunch. A dashboard you
// have to focus to read is a dashboard you close.
//
// The tab strip gives about four characters and sixteen pixels, so it gets two
// signals and no more: a count in the title, a state in the icon. Both are
// decided here, as plain strings, because the vitest suite runs in bare node
// with no DOM — nothing in this file touches `document`, and the caller owns
// every write.
import { PRODUCT } from "./brand";

/** Which of the four states the tab's mark should be wearing. */
export type AmbientIcon = "offline" | "waiting" | "running" | "idle";

export interface AmbientSignal {
  /** What `document.title` should be — already complete, including the name. */
  title: string;
  icon: AmbientIcon;
}

/**
 * What the tab should say and wear, given what the canvas currently holds.
 *
 * THE COUNT LEADS THE STRING: `(2) ccdeck`, never `ccdeck (2)`. Every browser
 * truncates a tab title from the END, and a tab in a strip of fifteen is a few
 * characters wide — so a count appended to the name is the first thing clipped
 * and the deck is back to saying nothing at exactly the moment it has something
 * to say. `(2) c…` is readable down to almost nothing. This ordering is the
 * whole feature, it looks like a typo to anyone tidying the file, and
 * ambient-signal.test.ts asserts the count is at index 0 rather than merely
 * present so that the tidy fails there instead of in a user's tab strip.
 *
 * Never `(0) ccdeck`. Zero is the resting state and has to look like one: a
 * parenthesised zero is a badge that reports nothing is wrong, which is a badge
 * that gets ignored — and a badge that gets ignored is ignored at `(1)` too.
 *
 * The name comes from PRODUCT rather than a literal because this is a surface a
 * human reads, which is the line brand.ts draws; index.html holds the only copy
 * that cannot be derived (it is parsed before any module runs) and
 * display-name.test.ts pins the two together.
 */
export function ambientSignal(
  { waiting, running, connected = true }: { waiting: number; running: number; connected?: boolean },
): AmbientSignal {
  return {
    // The count survives a dead stream, and that is deliberate. It is the last
    // reading rather than a live one, but nobody answered those prompts while
    // the deck was not looking, so it is very likely still true — and a count
    // that vanished the moment the connection dropped would read as "they were
    // dealt with". `(2)` beside a broken mark is the honest pair: two sessions
    // were waiting, and contact has been lost.
    title: waiting > 0 ? `(${waiting}) ${PRODUCT}` : PRODUCT,
    // Offline outranks everything, and not because a blocked session matters
    // less than a dropped socket (#719). While the stream is down, `waiting`
    // and `running` are both frozen readings of a board that has moved on
    // without telling anyone — so the syncing mark claims work is in flight that
    // may have finished minutes ago, and the bare one claims a quiet deck. Both
    // are answers to a question the deck can no longer answer. Worse, acting on
    // the alarm does not clear it: going and approving the prompt changes
    // nothing here, because nothing is arriving to say it was approved. The
    // condition gates the other three, so it precedes them.
    //
    // Then waiting outranks running. The tab strip is an alarm surface, not a
    // status report: one session sitting on a permission prompt while four
    // others work wears the waiting dot, because the four will finish on their
    // own and the one will not. Running answers the lesser question — "is anything still
    // moving" — and only gets the icon when the answer to the first one is no.
    icon: !connected ? "offline" : waiting > 0 ? "waiting" : running > 0 ? "running" : "idle",
  };
}

// THE KIT DRAWS EVERY STATE (2026-10-01).
//
// Until the brand kit, this file drew its own mark and carried the state in
// the mark itself: a grey ring at rest, a blue ring around a dot while
// running, a solid amber disc while waiting, a red ring with a bite out of it
// offline (#338, #719). The kit's rule is that status is an overlay on an
// unchanged mark, never a recolouring or a reshaping of it, and the kit ships
// the tab's states as files: its favicon, and the same favicon with a corner
// badge cut out of the mark for each state. Nothing is drawn here; each state
// names its file.
//
// Owner decision, same day: idle → the kit's default (the favicon itself),
// waiting → waiting, running → syncing, offline → error. The kit's paused has
// no state behind it here and is unused.
//
// What this gave up, said once here so nobody has to dig for it: the old marks
// differed in their whole silhouette, which is what let a dichromat viewer
// tell them apart at 16px. The kit's states differ in shape too — a dot, an
// open ring, a bang — but as a corner badge a few pixels across. The title's
// `(n)` still carries the alarm on its own.

/**
 * The four SVG hrefs, one kit file each, for the link index.html declares as
 * `type="image/svg+xml"`. At rest it is the file index.html boots with, so the
 * first frame and the second cannot disagree.
 *
 * And no animation, ever — not here and not in the caller. A pulsing favicon
 * asks the browser to re-fetch and re-rasterise an icon every frame for the
 * lifetime of the tab, and it is the single most hated pattern in this genre.
 */
export const FAVICON_HREF: Readonly<Record<AmbientIcon, string>> = Object.freeze({
  offline: "/state/favicon-error.svg",
  waiting: "/state/favicon-waiting.svg",
  running: "/state/favicon-syncing.svg",
  idle: "/favicon.svg",
});

/**
 * The same four states for the 32x32 fallback link, the one a browser without
 * SVG favicons shows: the kit's ICO at rest, its 32px PNG of each state
 * otherwise. Swapped with the SVG, as the kit's own snippet does, so such a
 * browser shows the state too instead of a resting mark forever.
 */
export const FAVICON_FALLBACK_HREF: Readonly<Record<AmbientIcon, string>> = Object.freeze({
  offline: "/state/favicon-error-32.png",
  waiting: "/state/favicon-waiting-32.png",
  running: "/state/favicon-syncing-32.png",
  idle: "/favicon.ico",
});
