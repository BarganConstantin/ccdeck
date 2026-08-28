// What the deck tells you after an upgrade, and — far more often — what it
// stays quiet about.
//
// The whole feature is one decision, and it is here rather than in the modal
// because it is the part that can be WRONG: the modal only draws what this
// hands it. Given the version the user was last shown something for, the
// version actually running, and the notes that shipped in the package, this
// answers two questions at once — which notes to show, and what to record as
// seen — and a test can ask it both without a DOM, a browser or a clock.
//
// Three states look identical from a chair and are not the same thing:
//
//   NEVER RUN HERE. Nothing in storage. The right answer is silence: notes
//   answer "what changed since you last looked", and someone who has never
//   looked has missed nothing. A changelog is the worst possible first contact
//   with a dashboard. So a first run records the running version as seen and
//   shows nothing — which is the one case that is easy to build backwards,
//   because "no stored version" and "show everything" are the same `null` and
//   the second reading dumps the whole file on a new install.
//
//   SEEN UP TO HERE. A version is stored and it is older than the running one.
//   Everything after it up to and including the running version is new to this
//   user, and they see it once, together — someone who skipped five releases
//   gets one dialog, not five.
//
//   ALREADY AHEAD. The stored version is NEWER than the running one. A
//   downgrade, an `npx ccdeck@1.40` run for a bisect, or the same browser
//   profile pointed at a newer deck on another machine. Nothing is new to this
//   user, so nothing is shown — and the marker is deliberately NOT moved back
//   down to the running version, because doing so would replay 1.46 through
//   1.49 for them the next time they open the newer deck. The marker is a
//   high-water mark, and it only ever rises.
//
// The notes themselves ship in the package (release-notes.json, inlined into
// the bundle at build time). Nothing here reaches the network: the deck binds
// 127.0.0.1 and works offline, and asking GitHub what changed would be a new
// outbound dependency and a new way for the quietest surface in the product to
// fail.

import raw from "../../release-notes.json";

/** One thing a user would notice. `title` is what the eye catches; `body` is
 *  what they need in order to act on it or stop worrying about it. */
export interface ReleaseNote {
  title: string;
  body: string;
}

/** Everything one release had to say, and the version it shipped in. */
export interface VersionNotes {
  version: string;
  notes: ReleaseNote[];
}

/** Where the last-seen version is remembered. In the `agent-dag.*` namespace
 *  with every other preference, and NOT one of storage.ts's SHAPE_KEYS: a
 *  version string means the same thing in every release, so a schema bump must
 *  not clear it and hand somebody a second copy of notes they have read. */
export const RELEASE_NOTES_SEEN_KEY = "agent-dag.releaseNotesSeen";

// ── comparing versions ───────────────────────────────────────────────────────
//
// The sharp edge of the whole feature, because version strings do not sort as
// strings: "1.10.0" is newer than "1.9.0" and sorts before it, so a `<` here
// would show a 1.10 user the notes for 1.9 and nothing else, forever.
//
// This is the second comparator in the repo and that is deliberate. The first
// is `isOlder` in src/server/self-update.mjs, which cannot be imported here:
// that module opens with node:fs and node:child_process, and pulling it into a
// browser bundle to borrow eleven lines would be the tail wagging the dog. So
// the segmentation rule is written once more, in the shape this side needs — a
// three-way answer rather than a boolean, because "the stored version is AHEAD"
// is a case with its own behaviour and `!isOlder(a, b)` cannot tell it from
// "equal". __tests__/release-notes.test.ts holds this against the server's copy
// over a matrix of version strings, so the two cannot drift apart; brand.ts and
// src/server/brand.mjs are the same arrangement one layer down.

/** A version string, split the way self-update.mjs splits one: on dots, and on
 *  the `-`/`+` that start a prerelease or build tag, with anything that is not
 *  a number counted as zero. `1.0.0-rc1` and `1.0.0` therefore compare equal,
 *  which is the existing behaviour and is right for this: a prerelease of a
 *  version carries the same notes as the version. */
function segments(v: string): number[] {
  return v.split(/[.\-+]/).map(n => parseInt(n, 10)).map(n => Number.isNaN(n) ? 0 : n);
}

/** Negative when `a` is older than `b`, positive when it is newer, zero when
 *  they are the same release. Missing trailing segments count as zero, so
 *  `1.30` is older than `1.30.1` and the same release as `1.30.0`. */
export function compareVersions(a: string, b: string): number {
  const x = segments(a), y = segments(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Whether a string is a version this module will compare at all.
 *
 * Not pedantry, and not semver validation: it is the guard that keeps a junk
 * marker from being read as "very old". `segments("")` is `[0]`, so an empty
 * string — which is exactly what `localStorage.getItem` hands back for a key
 * some other code wrote as `""`, and what a half-finished write leaves behind
 * — would compare older than every release in the file and replay the entire
 * history. Anything that is not `<digits>.<digits>.<digits>…` is treated as
 * absent instead, and absent means first run, which is silent.
 */
export function isVersion(v: unknown): v is string {
  return typeof v === "string" && /^\d+\.\d+\.\d+/.test(v);
}

// ── reading the file ─────────────────────────────────────────────────────────

function isNote(n: unknown): n is ReleaseNote {
  if (!n || typeof n !== "object") return false;
  const { title, body } = n as Record<string, unknown>;
  return typeof title === "string" && title.trim() !== ""
    && typeof body === "string" && body.trim() !== "";
}

/**
 * The notes file, turned into a list this module can walk — newest release
 * first, and nothing malformed in it.
 *
 * Malformed entries are DROPPED here and REFUSED by
 * __tests__/release-notes-file.test.ts, which is the split that matters. A
 * typo'd key ("1.46" for "1.46.0", a stray comment key) must never take a
 * running deck down over a data file, and it must never ship either — because
 * a note that is silently dropped is a note the one user who needed it never
 * sees, which is the only failure this feature really has. So the runtime is
 * forgiving and the suite is not.
 *
 * The `"//"` key the file carries its own instructions in falls out of this for
 * free: it is not a version, so it is not a release.
 */
export function readNotes(source: unknown): VersionNotes[] {
  if (!source || typeof source !== "object") return [];
  const out: VersionNotes[] = [];
  for (const [version, value] of Object.entries(source as Record<string, unknown>)) {
    if (!isVersion(version) || !Array.isArray(value)) continue;
    const notes = value.filter(isNote);
    if (notes.length) out.push({ version, notes });
  }
  // Newest first: the reason someone opens this is the release they just took.
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

/** The notes that shipped in this build. */
export const RELEASE_NOTES: VersionNotes[] = readNotes(raw);

/**
 * Every release in `(after, through]` — after the version already seen, up to
 * and including the one running.
 *
 * Inclusive at the top, and that is the half worth stating: recording a version
 * as seen means "you have been shown everything through here", so a user sitting
 * on 1.45 who upgrades to 1.46 must be shown 1.46's own notes. Exclusive at the
 * bottom for the mirror of the same reason.
 *
 * `after` of null means "nothing has been seen", which is what the chip route
 * asks for — everything this build knows about, whether or not it was ever
 * announced.
 */
export function notesBetween(
  notes: VersionNotes[],
  after: string | null,
  through: string,
): VersionNotes[] {
  return notes.filter(n =>
    compareVersions(n.version, through) <= 0
    && (after === null || compareVersions(n.version, after) > 0));
}

// ── what the dialog says about itself ────────────────────────────────────────
//
// Copy rather than markup, and here rather than in the component, for the
// reason version-chip.ts gives about the chip's two strings: this is the part
// that can be WRONG. A dialog nobody asked for has to answer "why am I looking
// at this" in its first line, and it has to answer it differently depending on
// whether the deck raised it or the user did — an unexplained modal is the one
// everybody learns to dismiss unread.

/** The versions a run of notes spans, for the dialog's subtitle. One release is
 *  named on its own; several are named at the ends, oldest first, because that
 *  is the direction a span is read even though the list beneath runs the other
 *  way. Empty for an empty run, which the header then simply omits. */
export function versionRangeLabel(entries: VersionNotes[]): string {
  if (!entries.length) return "";
  const newest = entries[0].version, oldest = entries[entries.length - 1].version;
  return newest === oldest ? `v${newest}` : `v${oldest} – v${newest}`;
}

export interface ReleaseNotesIntroInput {
  /** The version the user had already been shown notes through — a string when
   *  the deck raised this by itself, null when they opened it from the version
   *  chip. The two need different sentences: one is answering "why is this
   *  here", the other "what is this". */
  since: string | null;
  /** The version the deck is actually running. Only the browse route reads it,
   *  and it reads it to avoid the one lie this dialog can tell — see below. */
  running: string | null;
  entries: VersionNotes[];
}

/**
 * The dialog's first line.
 *
 * The browse route is the one that needs `running`, and #715 is where that
 * stopped being optional. The chip opens this dialog on any release, including
 * one that changed nothing a user would notice — which is most of them. What
 * the reader then sees is a list headed by some earlier version, and the
 * dialog's job in that first line is to say so out loud. Left to say
 * "everything this build has to say", it invites the obvious wrong reading:
 * that v1.46.0's notes are notes about the v1.47.0 you are looking at. So the
 * three cases are named separately, and the one that is easiest to get wrong —
 * the running release having nothing of its own — says the quiet part first.
 */
export function releaseNotesIntro({ since, running, entries }: ReleaseNotesIntroInput): string {
  if (!entries.length) {
    return "Nothing in this build has anything to report yet. Most releases do not, which is the point.";
  }
  if (since !== null) {
    const releases = entries.length === 1 ? "one release" : `${entries.length} releases`;
    // Naming the way back, in the dialog itself, is what makes dismissing this
    // safe. It has to name the control that actually exists, and since #715
    // that is the version chip itself — the separate What's new button beside
    // it is gone, and a sentence still pointing at it would be sending people
    // to look for something that is not there.
    return `You were last caught up at v${since}. Since then ${releases} changed something you would notice. Clicking the version in the topbar brings this back.`;
  }
  const newest = entries[0].version;
  // Nothing to compare against: /api/version never answered and the bundle's
  // own number is standing in. Say what is true of the list and nothing about
  // the deck.
  if (!isVersion(running)) {
    return "Everything this build has to say, newest first. Most releases have nothing here, which is why the deck stays quiet about them.";
  }
  const drift = compareVersions(newest, running);
  if (drift < 0) {
    return `v${running} — the release you are running — changed nothing you would notice, which most releases do not. Below is the last release that did, and everything before it, newest first.`;
  }
  // drift > 0 cannot happen through the chip, which never asks for notes past
  // the running version. It can happen to a caller that does, and the honest
  // answer there is the one that claims nothing about which release is yours.
  if (drift > 0) {
    return "Everything this build has to say, newest first. Most releases have nothing here, which is why the deck stays quiet about them.";
  }
  return `You are running v${running}, and this is what it changed — and everything before it, newest first. Most releases have nothing here, which is why the deck stays quiet about them.`;
}

// ── a note title that opens with an emoji ────────────────────────────────────
//
// Reported as "🔊Pick a volume", and the space is not the thing that is wrong.
// It is in the JSON, it survives the bundle, it reaches the DOM, and Chrome
// renders it at 3.332px against a 3.324px word space at the same size. What is
// missing is the side bearing. A colour emoji glyph is drawn edge to edge
// inside its advance, so a word space after one is ALL the white there is;
// between two Latin words the same space is padded by the previous letter's
// right bearing and the next one's left, and the eye is calibrated on that.
//
// So the fix is optical and belongs to the renderer — a margin on the emoji,
// applied by .rn-note-icon in styles.css. Which means the renderer has to know
// an emoji is there, and that is this function: the one piece of the job that
// can be wrong, pulled out where a test with no DOM can ask it.
//
// The alternative was a second space in the JSON. That is a lie in the data
// about a defect in the type, it reads as a typo to the next person editing the
// file, and it is invisible in a diff — and it would have to be repeated by
// every author of every future note, correctly, forever.

/** A note title in two pieces, which still add up to exactly the title. */
export interface NoteTitleParts {
  /** The emoji the title opens with, or null when it does not open with one. */
  icon: string | null;
  /** Everything after it — INCLUDING the single space that separated them.
   *  The space stays in the text on purpose: it is what keeps the rendered
   *  string identical to the title, so the accessible name, a find-in-page and
   *  a copy out of the dialog are all unchanged by the split. The margin is the
   *  only thing the icon's own box adds. */
  rest: string;
}

/**
 * A leading emoji, and everything the deck's authors actually write in front of
 * a note title: a pictograph, optionally with a variation selector, a skin-tone
 * modifier, or the zero-width joins that build one glyph out of several. Two
 * regional indicators for a flag are the same shape of run.
 *
 * The `(?= \S)` at the end is the part with a job. It demands EXACTLY one space
 * after the run, followed by something that is not another space, which means:
 *   • "🔊Pick"  — no space at all — is not split, and gets no optical gap. The
 *     data is wrong there and release-notes-file.test.ts fails it; papering it
 *     over here would hide the one case a reader really would see as flush.
 *   • "🔊  Pick" — two spaces, the paper-over this function exists to make
 *     unnecessary — is not split either, so it gains nothing and is refused by
 *     the same file test.
 */
const LEADING_EMOJI =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\u200D\uFE0F])+(?= \S)/u;

/** Splits a note title at its leading emoji, losslessly: `icon ?? ""` followed
 *  by `rest` is the title it was given, for every string. */
export function splitNoteTitle(title: string): NoteTitleParts {
  const match = LEADING_EMOJI.exec(title);
  if (!match) return { icon: null, rest: title };
  return { icon: match[0], rest: title.slice(match[0].length) };
}

// ── remembering ──────────────────────────────────────────────────────────────
//
// `window.localStorage` is a getter that THROWS — SecurityError under Safari's
// "Block All Cookies", Chrome with site data blocked, Firefox in strict mode —
// so a try that only wraps `getItem` never runs. storage.ts spells out what
// that costs at boot; here it costs less and still has to be right, because the
// failure mode is loud rather than quiet: a store that cannot answer looks like
// "never seen anything", and a store that cannot be written keeps looking that
// way on the next load. Both halves are wrapped, and both collapse to the
// silent branch — a deck that cannot remember shows no modal at all, rather
// than the same one on every reload for the rest of the release.

type Storeish = Pick<Storage, "getItem" | "setItem">;

/** The store, or null where there is not one to have — a non-browser
 *  environment, or a profile that refuses. */
export function seenStore(): Storeish | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; } catch { return null; }
}

/** The version this profile was last shown notes through, or null when the
 *  store is absent, empty, unreadable or holding something that is not a
 *  version. Every one of those is "first run" to decideReleaseNotes. */
export function readSeen(store: Storeish | null | undefined): string | null {
  if (!store) return null;
  let value: string | null = null;
  try { value = store.getItem(RELEASE_NOTES_SEEN_KEY); } catch { return null; }
  return isVersion(value) ? value : null;
}

/** Records a version as seen. Answers whether it stuck, which is the only thing
 *  the caller can act on: a false means the next load will decide "first run"
 *  again, and the caller's own guard — not a second modal — is what keeps that
 *  from being visible. */
export function writeSeen(store: Storeish | null | undefined, version: string): boolean {
  if (!store) return false;
  try { store.setItem(RELEASE_NOTES_SEEN_KEY, version); return true; } catch { return false; }
}

// ── the decision ─────────────────────────────────────────────────────────────

/** Why the deck did what it did, named rather than inferred. Every branch below
 *  is a state somebody could otherwise mistake for another one, and the test
 *  asserts on these rather than on "empty list" — `first-run` and `nothing-new`
 *  both show nothing and are not the same event. */
export type ReleaseNotesReason =
  /** No running version to compare against — /api/version has not answered, or
   *  answered with nothing. Show nothing, remember nothing, ask again later. */
  | "no-version"
  /** Nothing was ever stored: a new install, a cleared profile, or a browser
   *  that refuses to remember. Record and stay quiet. */
  | "first-run"
  /** The stored version is the running one. The common case, every reload. */
  | "seen"
  /** The stored version is NEWER — a downgrade, or a profile shared with a
   *  newer deck. Silent, and the marker is left where it is. */
  | "ahead"
  /** Newer code, and it had nothing a user would notice. The normal release. */
  | "nothing-new"
  /** Newer code with something to say. The only branch that opens a dialog. */
  | "new-notes";

export interface ReleaseNotesDecision {
  /** Releases to show, newest first. Empty means the modal must not open. */
  show: VersionNotes[];
  /** The version to write to storage, or null to leave the marker untouched. */
  record: string | null;
  reason: ReleaseNotesReason;
}

export interface ReleaseNotesInput {
  /** What the store answered — a version, null when absent, and null again when
   *  the store threw. Those two are the same event to this module on purpose: a
   *  browser that cannot remember must fall through to the silent branch rather
   *  than announce the same release on every load. */
  stored: string | null;
  /** The version the server process actually booted with. Not the bundle's:
   *  an upgrade replaces dist/web on disk before the running process restarts,
   *  so the page can be newer than the code answering it, and notes about
   *  behaviour that is not live yet are notes about nothing. */
  running: string | null;
  notes: VersionNotes[];
}

/** What to show and what to remember, on one load of the deck. */
export function decideReleaseNotes({ stored, running, notes }: ReleaseNotesInput): ReleaseNotesDecision {
  if (!isVersion(running)) return { show: [], record: null, reason: "no-version" };
  // Absent, unreadable or junk: all first run, all silent. Recording the
  // running version here is what makes the NEXT upgrade the first one this user
  // hears about.
  if (!isVersion(stored)) return { show: [], record: running, reason: "first-run" };

  const drift = compareVersions(stored, running);
  if (drift === 0) return { show: [], record: null, reason: "seen" };
  // The marker only rises. Writing `running` here would replay everything
  // between the two the next time the newer deck is opened.
  if (drift > 0) return { show: [], record: null, reason: "ahead" };

  const show = notesBetween(notes, stored, running);
  // Recorded either way: nothing between these two versions will ever become
  // interesting later, and a marker that keeps up means the range stays short.
  return show.length
    ? { show, record: running, reason: "new-notes" }
    : { show: [], record: running, reason: "nothing-new" };
}
