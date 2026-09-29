// What one browser profile has contributed to Browser Watch since the deck
// started, and how a read is folded into it.
//
// Since #989 a read of a profile's History returns only what is newer than the
// read before it, so there is no whole answer left to keep a copy of: each real
// read is folded into one accumulator per profile by `absorb`, and every poll —
// cached, degraded or real — answers from what has built up. The snapshot in
// browser-watch.mjs holds those accumulators (`_lastRead`) and decides when to
// fold. This module is the fold, and it is pure: the rows and the gate in, the
// accumulator changed in place, nothing read or written anywhere else.
//
// browser-watch.mjs re-exports both names, which is where the tests that check
// what is held between polls (#989, #1131) import them from.
import { classify, isProgramNavigation } from "./agent-activity.mjs";

/** What a profile has contributed before its first read. */
export function nothingSeen() {
  return {
    /** The oldest and newest visit times seen, and the newest a PERSON made. */
    oldest: null,
    newest: null,
    human: null,
    /** How many of those visits Chrome marked as coming from an API. */
    byProgram: 0,
    /**
     * Findings whose verdict can no longer change, and those that still can.
     *
     * THE QUIET GATE IS WHY THIS IS TWO LISTS. `classify` reports a program
     * navigation only when no HUMAN visit falls within `quietMs` of it, on
     * either side, so a verdict depends on visits that may arrive in a later
     * read. Classifying each read's rows on their own is a different
     * computation, and wrong in the direction that matters: the person's visits
     * from the read before would be missing from the gate, and a program page
     * opened while they sat at the browser would be reported.
     *
     * What saves it is that the question SETTLES. Only a human visit less than
     * `quietMs` from a candidate can silence it, and every later read returns
     * visits newer than `newest`, so once `newest` is `quietMs` past a candidate
     * nothing still to come can change its answer. Verdicts up to `settledTo`
     * are final and kept; the ones after it are recomputed on every read from
     * `window`, the same computation the whole-history classify was.
     */
    settled: [],
    open: [],
    settledTo: -Infinity,
    /**
     * The only raw visits this module keeps between polls: every visit newer
     * than `settledTo`, and the TIME of the newest visit a person made at or
     * before it. Bounded by the clock, where the cache before #989 held every
     * visit since the deck booted.
     *
     * NOT PRUNED BY THE GATE IN FORCE, SINCE #1131. It was everything newer
     * than `settledTo - quietMs`, which is what that gate needs and less than a
     * longer one does. With the gate lengthened from 15 minutes to 60, the
     * person's visit forty minutes before a program page had already been
     * dropped, and the next poll reported two pages that `classify` over the
     * same rows under the 60-minute gate reports none of.
     *
     * Every verdict still open is newer than `settledTo`, so of the visits a
     * person made at or before that line the newest is the nearest to every one
     * of them, and the rest can never decide anything, under any gate: the hour
     * the panel offers, or the day `normalise` accepts from a hand edit. Kept,
     * that one visit makes the evidence complete whatever the gate is changed
     * to. It is kept as a time and nothing else, because the gate asks when a
     * person was at the browser and never where. What is held comes to one gate
     * of browsing and one timestamp, where it was two gates of addresses.
     */
    window: [],
    /** The gate the open verdicts were last judged under, so a changed one is
     *  applied on the next poll whether or not that poll read anything. */
    judgedUnder: null,
    /**
     * The moment every visit before which is known to have been read, or null
     * before the first complete look.
     *
     * THE OTHER WAY A VERDICT SETTLES (#1751). `settledTo` moves only when the
     * browser records something newer, and a browser nobody is using records
     * nothing — so on the one machine this feature is for, a program page left
     * alone stayed open until its owner came back, and was only final once they
     * had. The clock settles it instead: a visit is written down when it
     * happens, so once a complete look has been taken `quietMs` past a
     * candidate, no visit still to be read can fall inside its window.
     * `decided` reads this; `settledTo` and the lists above are untouched by
     * it, so a gate changed afterwards re-judges the open verdicts as before.
     */
    readTo: null,
  };
}

/**
 * The findings no later read can withdraw: every settled one, and every open
 * one whose quiet window had closed by the last complete look.
 *
 * Only these are written down, logged and reacted to. An open verdict is still
 * shown — it is what the browser holds right now — but a person's visit in the
 * minutes after it cancels it, and a reaction that quit the browser in the
 * middle of their own login cannot be taken back when the visit arrives.
 */
export function decided(seen) {
  if (seen.readTo === null || seen.judgedUnder === null) return seen.settled.slice();
  const line = seen.readTo - seen.judgedUnder;
  return seen.settled.concat(seen.open.filter(f => f.timeMs <= line));
}

/** Fold one real read's rows into what the profile has contributed, and judge
 *  again whatever is still open. Mutates `seen`, which is the object `_lastRead`
 *  holds. Exported for tests, with `nothingSeen`: what is held between polls
 *  is the question #989 was about, and a snapshot cannot see it. */
export function absorb(seen, rows, { quietMs, classifyOpts, browser, readTo = null }) {
  // Before the early return, because a poll that read nothing still moves the
  // clock: see `readTo` in `nothingSeen`. Null from a read that was not
  // complete, which leaves the line where the last complete one put it.
  if (readTo !== null && (seen.readTo === null || readTo > seen.readTo)) seen.readTo = readTo;
  // NOTHING NEW UNDER THE SAME GATE IS NOTHING TO DO. A gate that has changed
  // since the open verdicts were judged is applied with no new rows at all
  // (#1131): the settings route drops the cache, the read after it finds the
  // file as it was and returns nothing, and returning here on that left a
  // lengthened gate unapplied until the browser next wrote — the panel still
  // listing a page the new gate hides.
  if (rows.length === 0 && (seen.newest === null || seen.judgedUnder === quietMs)) return;
  for (const row of rows) {
    if (seen.oldest === null || row.timeMs < seen.oldest) seen.oldest = row.timeMs;
    if (seen.newest === null || row.timeMs > seen.newest) seen.newest = row.timeMs;
    // PAGES A PROGRAM OPENED, which is not the same as findings. A finding also
    // has to clear the quiet gate; this is every navigation Chrome marked as
    // coming from an API, whether or not anybody was at the keyboard. It is the
    // figure the overview shows, because a panel about what programs did should
    // count what programs did — the total row count it showed before was, on a
    // measured profile, 78% the reader's own browsing.
    if (isProgramNavigation(row.transition)) seen.byProgram += 1;
    else if (seen.human === null || row.timeMs > seen.human) seen.human = row.timeMs;
  }
  // The visits still in play from earlier reads, then this read's.
  const evidence = seen.window.concat(rows);
  // MONOTONIC, so a quiet gate the reader has just lengthened cannot move the
  // line back and re-open a verdict already kept, which would list that finding
  // twice: once settled and once open.
  const settleTo = Math.max(seen.settledTo, seen.newest - quietMs);
  const verdicts = classify(evidence, classifyOpts)
    // Tagged with the browser they came from, which is the one thing a reaction
    // cannot work out for itself: closing a tab means telling ONE application
    // to close it, and a finding that has forgotten which browser it was in can
    // only be guessed at.
    .map(f => ({ ...f, browser }));
  for (const f of verdicts) {
    if (f.timeMs > seen.settledTo && f.timeMs <= settleTo) seen.settled.push(f);
  }
  seen.open = verdicts.filter(f => f.timeMs > settleTo);
  seen.settledTo = settleTo;
  seen.judgedUnder = quietMs;
  // Everything newer than the line, and of what a person did at or before it
  // only the newest, as a time: `window` in `nothingSeen` says why that one
  // visit is all any gate can ask for.
  let person = null;
  for (const r of evidence) {
    if (r.timeMs > settleTo || isProgramNavigation(r.transition)) continue;
    if (person === null || r.timeMs > person) person = r.timeMs;
  }
  seen.window = evidence.filter(r => r.timeMs > settleTo);
  if (person !== null) seen.window.unshift({ url: "", timeMs: person, transition: 0 });
}
