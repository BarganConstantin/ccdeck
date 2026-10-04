// The one question the deck asks about itself: "How useful is ccdeck to you?",
// 0 to 10, once, after about a week of use.
//
// WHEN. Only once the deck has heard a session on RATING_AFTER_DAYS different
// days (usage-day.mjs keeps that count), only while reports are on — the answer
// is a report, and a deck that sends none has nobody to tell — and never in the
// first minutes after a launch, when the board is filling and the person came
// to look at their sessions, not at us. The page also waits for no dialog to be
// open (use-rating-ask.ts).
//
// HOW OFTEN. "Not now" puts it off by RATING_AGAIN_AFTER_MS, once. A second
// "Not now", or an answer, and it is never asked again — even after a 3.36.x
// deck sharing the data dir rewrites prefs.json without it: the outcome is kept
// a second time beside that file (reports.mjs ratingFile).
//
// WHAT LEAVES. The number picked and how many days the deck had been used, as a
// range (daysUsedBucket) — a "rated" event, sent once (reports.mjs). Nothing
// about a question left unanswered or put off.
//
// Imports nothing, so deck-prefs.mjs can normalise with it.

/** Days the deck has to have been used on before it asks. */
export const RATING_AFTER_DAYS = 7;

/** How long "Not now" puts the question off: thirty days. */
export const RATING_AGAIN_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** How long after a launch the question waits: the launch is the busy minute. */
export const RATING_AFTER_LAUNCH_MS = 5 * 60 * 1000;

/** How many times "Not now" may be said before the question stops for good. */
const LATER_LIMIT = 2;

/** What prefs.json keeps about the question, coerced: the answer (null until
 *  there is one), whether it went out, and how often and when it was put off. */
export function normaliseRating(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const score = Number.isInteger(src.score) && src.score >= 0 && src.score <= 10 ? src.score : null;
  const later = Number.isInteger(src.later) && src.later > 0 ? Math.min(src.later, LATER_LIMIT) : 0;
  return {
    score,
    sent: score !== null && src.sent === true,
    later,
    laterAt: typeof src.laterAt === "string" && !Number.isNaN(Date.parse(src.laterAt)) ? src.laterAt : "",
  };
}

/** How far the question has got: put off none, once or twice, then answered,
 *  then answered and sent. Of two copies of it, the further one is the truth —
 *  nothing ever moves it back. */
export function ratingStage(rating) {
  const r = normaliseRating(rating);
  if (r.score === null) return r.later;
  return r.sent ? LATER_LIMIT + 2 : LATER_LIMIT + 1;
}

/** A score the page may send: a whole number from 0 to 10, else null. */
export function scoreOf(value) {
  return Number.isInteger(value) && value >= 0 && value <= 10 ? value : null;
}

/** How long the deck had been used when it was rated, as the range the API
 *  keeps — never the count itself. */
export function daysUsedBucket(days) {
  if (!Number.isInteger(days) || days < 7) return "1-6";
  if (days < 14) return "7-13";
  if (days < 30) return "14-29";
  if (days < 90) return "30-89";
  return "90+";
}

/**
 * Is it time to ask? The saved state of the question, the days used so far, the
 * time now, and how long this deck has been up. The reports switch is the
 * caller's (reports.mjs), because only it knows the veto.
 */
export function ratingDue(rating, daysUsed, now, uptimeMs) {
  const r = normaliseRating(rating);
  if (r.score !== null || r.later >= LATER_LIMIT) return false;
  if (!Number.isInteger(daysUsed) || daysUsed < RATING_AFTER_DAYS) return false;
  if (!(uptimeMs >= RATING_AFTER_LAUNCH_MS)) return false;
  if (r.later > 0) {
    const at = Date.parse(r.laterAt);
    if (Number.isNaN(at) || now.getTime() - at < RATING_AGAIN_AFTER_MS) return false;
  }
  return true;
}
