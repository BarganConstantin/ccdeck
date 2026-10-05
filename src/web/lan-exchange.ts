// One paired deck against this one, for that deck's own dialog: whose version
// is newer, and which way each login can move between the two.
//
// Lifted out of LanSyncSection.tsx unchanged. The section itself reads none of
// it — the deck's dialog does, and the section was only where it had been
// written. offerLine says the engine's rules for one login in words, and
// exchangeLanes lays every login the two decks offer out as one lane with a
// state at each end, which is what the dialog draws. None of it touches React.
import type { LanAccount, OfferedAccount } from "./lan-types";

/** Two versions against each other: negative when `a` is older, positive when
 *  newer, 0 when they match — and null when either is not a version this can
 *  read, so the dialog prints the number alone rather than guessing. Only the
 *  three numbers count; a pre-release tag is not something a reader compares. */
export function versionOrder(a: string, b: string): number | null {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a ?? "");
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b ?? "");
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  return 0;
}

/**
 * One login another deck offers, and what it would do HERE.
 *
 * The engine's rules, said in words. A copy that does not work there moves
 * nothing. One this deck lacks arrives on the next round, and one that is
 * expired here is repaired on it, whatever this deck shares (see roundWith).
 * This said "share it to repair" over every expired login until the engine
 * stopped asking a deck somebody chose for the tick — and the person reading
 * it deleted the account instead, because the add that followed needed none.
 *
 * TWO CELLS, NOT A SENTENCE. This was one string — `works there · works here`,
 * `broken there · not on this deck` — and a reader had to take it left to
 * right and hold both halves to see which one they could act on. It is a 2×2
 * fact (their copy × this deck's), so it is returned as two, and the dialog
 * puts each in its own column. What that buys is a single left edge under
 * `here`: the column somebody scans, because `here` is the only half anything
 * on this screen can change — a round only ever pulls.
 *
 * `note` is what HAPPENS NEXT, and it is null for every state where the
 * answer is "nothing". So the note exists on exactly the rows worth reading,
 * and it is the note — not the state — that carries the ink.
 *
 * `takesAdds` is false for a deck the accept switch paired rather than a
 * person: the engine takes a login from such a deck — missing here or expired
 * here — only when it is ticked here (see roundWith), so "arrives next round"
 * and "repairs next round" would be promises the round does not keep. Pairing
 * with it by invite is a person choosing it, and that is what lifts it. The
 * name is from when it governed adds alone.
 */
export function offerLine(
  theirs: OfferedAccount,
  mine: LanAccount | null,
  sharedHere: boolean,
  takesAdds = true,
): { there: string; here: string; note: string | null; tone: "ok" | "wait" | "bad" | "idle" } {
  const here = !mine ? "not on this deck" : mine.alive
    ? mine.shareable === false ? "cannot share here" : "works here"
    : "expired here";
  // A valid copy behind an unavailable Keychain is not broken and cannot be
  // pulled. Say exactly that, without promising a transfer or telling the user
  // to sign in again.
  if (theirs.alive && theirs.shareable === false) {
    return { there: "cannot share there", here, note: null, tone: "idle" };
  }
  if (!theirs.alive) {
    // BOTH COPIES GONE is the one state with no repair anywhere, and it used
    // to wear the same warning ink as the state that is fixed with one tick.
    // Warn ink says act; this one says the act is not here, so it names the
    // only thing that does work — the words the accounts panel already uses.
    const note = mine && !mine.alive ? "neither copy works — sign in again here" : null;
    return { there: "broken there", here, note, tone: note ? "bad" : "idle" };
  }
  // `here` stays what IS, and the note says what WILL BE. The old string put
  // `arrives here next round` in the state slot, which left a reader unable to
  // tell the present from the promise.
  if (!mine) {
    return takesAdds || sharedHere
      ? { there: "works there", here, note: "arrives next round", tone: "wait" }
      : { there: "works there", here, note: "paired automatically — pair by invite to take it", tone: "bad" };
  }
  if (mine.alive) return { there: "works there", here, note: null, tone: mine.shareable === false ? "idle" : "ok" };
  return takesAdds || sharedHere
    ? { there: "works there", here, note: "repairs next round", tone: "wait" }
    : { there: "works there", here, note: "paired automatically — share it to repair", tone: "bad" };
}

/** Which way one login can move between this deck and a paired one. `live`
 *  is a copy that can cross; `wait` is one that will, on the next round;
 *  `blocked` works there and stops at this deck, which the accept switch
 *  paired with that one, until this deck shares it too; `cut` is a copy with
 *  nothing to give. */
export type LaneFlow = "live" | "wait" | "blocked" | "cut";

/**
 * One login between this deck and one paired deck — a lane between the two
 * machines in that deck's dialog.
 *
 * ONE LANE PER LOGIN, BOTH WAYS. The dialog drew what that deck offers and
 * what this deck offers as two lists, so a login both decks share — the
 * ordinary case between one person's machines — was printed twice, once per
 * direction, and the reader paired the rows up by eye. A login is one thing
 * with a copy at each end, so it is one lane: a state at each end, and an
 * arrow for each way a copy can travel.
 *
 * `caption` is the words, only where the two ends cannot say it alone: the
 * end that is not working, then what happens next — offerLine's note. The
 * steady state has none, which is what makes a caption worth reading.
 */
export interface Lane {
  key: string;
  email: string;
  /** This deck's copy. */
  here: "works" | "expired" | "missing" | "unavailable";
  /** That deck's, as its last list said — `unknown` when it does not offer it. */
  there: "works" | "broken" | "unavailable" | "unknown";
  /** From that deck to this one; null when that deck does not offer it. */
  in: LaneFlow | null;
  /** From this deck to every paired deck; null when this deck does not offer it. */
  out: "live" | "cut" | null;
  caption: string | null;
  tone: "ok" | "wait" | "bad" | "idle";
  /** That machine is working on this account right now, by what it said in its
   *  last list. This deck's own is not marked — its owner sees it in the
   *  accounts panel's switcher. */
  usedThere: boolean;
}

export function exchangeLanes(
  offered: OfferedAccount[] | null,
  accounts: LanAccount[],
  shared: string[],
  /** The key that deck said it is on, or null. The engine only keeps one that
   *  is in the same list, so it can only ever land on a lane it offers. */
  current: string | null = null,
  /** False for a deck the accept switch paired — see offerLine. */
  takesAdds = true,
): Lane[] {
  // Two slots for one login read as the live one, as the engine's onePerKey
  // picks it (lan-copies.mjs): an expired duplicate after it must not paint this
  // end "expired" while the deck is offering a working copy.
  const byKey = new Map<string, LanAccount>();
  for (const a of accounts) if (!byKey.get(a.key)?.alive) byKey.set(a.key, a);
  const sharedHere = new Set(shared);
  const lanes: Lane[] = [];
  const seen = new Set<string>();
  for (const theirs of offered ?? []) {
    if (seen.has(theirs.key)) continue;
    seen.add(theirs.key);
    const mine = byKey.get(theirs.key) ?? null;
    const giving = sharedHere.has(theirs.key);
    const said = offerLine(theirs, mine, giving, takesAdds);
    const here = !mine ? "missing" : !mine.alive ? "expired"
      : mine.shareable === false ? "unavailable" : "works";
    // Both copies gone is the one note that already names both ends.
    const caption = !theirs.alive && mine && !mine.alive
      ? said.note
      : [here === "works" ? null : said.here,
          theirs.alive && theirs.shareable !== false ? null : said.there,
          said.note]
          .filter(Boolean).join(" · ") || null;
    lanes.push({
      key: theirs.key,
      email: theirs.email,
      here,
      there: !theirs.alive ? "broken" : theirs.shareable === false ? "unavailable" : "works",
      in: !theirs.alive || theirs.shareable === false
        ? "cut"
        : said.tone === "wait" ? "wait" : said.tone === "bad" ? "blocked" : "live",
      out: giving && mine ? (mine.alive && mine.shareable !== false ? "live" : "cut") : null,
      caption,
      tone: said.tone,
      usedThere: current === theirs.key,
    });
  }
  // What only this deck offers, after, in the order this deck offers it.
  for (const key of shared) {
    const mine = byKey.get(key);
    if (!mine || seen.has(key)) continue;
    seen.add(key);
    lanes.push({
      key,
      email: mine.email,
      here: !mine.alive ? "expired" : mine.shareable === false ? "unavailable" : "works",
      there: "unknown",
      in: null,
      out: mine.alive && mine.shareable !== false ? "live" : "cut",
      caption: !mine.alive ? "expired here" : mine.shareable === false ? "cannot share here" : null,
      tone: mine.alive ? mine.shareable === false ? "idle" : "ok" : "bad",
      // That deck does not offer it, so it is never named as the one it is on.
      usedThere: false,
    });
  }
  return lanes;
}
