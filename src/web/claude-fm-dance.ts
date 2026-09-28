// Claude FM's dances: which one the character does while something is playing,
// at what tempo, and for how long before it changes its mind.
//
// Lifted out of claude-fm.ts unchanged. The errands stay there; the timer that
// changes dances is use-fm-scene.ts's, and the sheet draws each one by its
// `data-dance` name.

// ── the dance is not one loop ───────────────────────────────────────────────
//
// One cycle repeated forever reads as a GIF rather than as a character: the eye
// learns an 800ms loop in about four seconds and then stops looking. So there
// are three of them and it changes its mind every ten seconds or so, and the
// tempo drifts a few percent each time it does.
//
// Nothing here listens to the music, and nothing can: the player is a
// cross-origin iframe, so the page cannot reach the audio element, and a
// tainted source would hand an analyser silence anyway. The only route to real
// beat detection is tab capture, which costs a permission prompt and a sharing
// banner — far too much for a character in a corner. This is the honest
// alternative: it is not dancing TO the track, it is just not dancing the same
// way twice in a row.

export const DANCES = ["bob", "sway", "groove"] as const;
export type Dance = typeof DANCES[number];

/** How long it keeps one dance before picking another. Long enough that the
 *  change is noticed rather than watched for. */
export const DANCE_MIN_MS = 9_000;
export const DANCE_MAX_MS = 16_000;

/** The tempo, and how far either side of it a dance may land. 800ms is 75bpm,
 *  which is about where the thing it is dancing to usually sits; the drift is
 *  small enough to stay in that band and large enough that two dances in a row
 *  are not the same speed.
 *
 *  1000ms is 60bpm, down from 75. The thing it is dancing to is calm, and at
 *  75 it was bobbing along ahead of the music — the character looked busier
 *  than anything it could have been listening to. A slower beat is also the
 *  cheaper one on a monitoring deck, where the corner of the screen should not
 *  be the most energetic thing on it. */
export const BEAT_MS = 1000;
export const BEAT_DRIFT = 0.08;

/**
 * The next dance, which is never the one it is already doing.
 *
 * The names are the sheet's `data-dance` values rather than keyframe names on
 * purpose. Driving `animation-name` through a custom property was one rule
 * instead of three and hid every dance from bubble-motion.test.ts, which exists
 * to catch exactly that: a @keyframes set the sheet no longer runs, and an
 * animation naming a set that is not there. A stylesheet its own guards cannot
 * read is not a saving.
 *
 * Picking uniformly at random would repeat about a third of the time, and a
 * repeat is indistinguishable from the loop this exists to break — the change
 * has to be visible or it has not happened.
 */
export function nextDance(current: Dance | null, rand: () => number): { dance: Dance; beatMs: number } {
  const others = DANCES.filter(d => d !== current);
  const dance = others[Math.min(others.length - 1, Math.floor(rand() * others.length))];
  const drift = (rand() * 2 - 1) * BEAT_DRIFT;
  return { dance, beatMs: Math.round(BEAT_MS * (1 + drift)) };
}

/** How long to hold it. */
export function nextDanceMs(rand: () => number): number {
  return Math.round(DANCE_MIN_MS + rand() * (DANCE_MAX_MS - DANCE_MIN_MS));
}
