// What the topbar's version chip says about itself.
//
// The chip is a button, and since #715 one click does two things: it opens what
// changed in the release this deck is running, and it asks npm now instead of
// reusing the answer cached on disk. Nothing about "v1.33.77" in dim 11px text
// says either, so the strings below are the whole affordance — the tooltip a
// mouse finds, and the accessible name a screen reader gets instead of a bare
// version number.
//
// The two jobs are one control rather than two because they are one question.
// #712 split them — a "What's new" button beside the chip — on the reasoning
// that a control doing two unrelated things is worse than a control more. The
// things turned out not to be unrelated: both answer "what about my version",
// the notes route and the check route agree in every state, and neither can
// fail in a way that costs the other. What a second button did cost was two
// words of topbar next to a number, permanently, for a dialog most people open
// once a month. So the chip absorbed it, and every string here names the notes
// FIRST — the notes are the half that always works, including with checks off.
//
// Order matters and belongs in App.tsx rather than here, but the copy has to be
// written knowing it: the notes are in the bundle and the registry is across
// the network, so the dialog is up before the request leaves. A tooltip that
// promised the check first would be describing the slower half.
//
// Kept out of App.tsx because it is the one part of the chip that can be wrong
// rather than merely plain: a chip that says "npm not reached yet" while npm
// answered perfectly well, or "click to check" while a click is already in
// flight, is worse than the plain caption it replaced.

export type VersionChipCopy = {
  /** The version rendered on the chip, already defaulted by the caller. */
  running: string;
  /** npm's newest installable version, or null while none is known. */
  latest?: string | null;
  /** A version npm's dist-tag names but cannot serve yet. Its presence means
   *  the registry WAS reached, which is the opposite of what a null `latest`
   *  alone would suggest. */
  latestPending?: string | null;
  /** Age of the last successful check, already worded — "12m ago", "just
   *  now" — or null when npm has never answered. */
  checkedAgo?: string | null;
  /** AGENTS_DECK_NO_UPDATE_CHECK=1 and friends — no lookup will ever run. */
  checkDisabled?: boolean;
  /** A forced check started by this chip has not come back yet. */
  checking?: boolean;
};

const CHECKS_OFF = "Update checks are off (AGENTS_DECK_NO_UPDATE_CHECK=1)";

/** The half of the click that has no failure mode. It is in every branch below,
 *  including the two that used to describe a chip with nothing to do: a deck
 *  with checks switched off, and one already waiting on npm, both still open
 *  the notes on a click, and a tooltip that said otherwise would be describing
 *  a dead control that is not dead. */
const NOTES_CLICK = "click for what's new";

/** The chip's tooltip: what npm last said, when it said it, and what a click
 *  would do about it. */
export function versionChipTitle(c: VersionChipCopy): string {
  // No lookup will ever run, so the notes are the ONLY thing a click does — and
  // are named rather than left out, which is what turned this branch from "this
  // button is off" into "this button does the other thing".
  if (c.checkDisabled) return `${CHECKS_OFF} · ${NOTES_CLICK}`;
  // A check is already in flight, so a click cannot usefully start another one.
  // It can still open the notes, because those never needed the network.
  if (c.checking) return `Asking npm for the newest release… · ${NOTES_CLICK}`;
  const state = c.latest
    ? `npm has v${c.latest}`
    : c.latestPending
      // Reached, but holding the version back: the dist-tag moves before the
      // tarball is servable, and offering it there ends in ETARGET.
      ? `npm's latest tag names v${c.latestPending}, which it cannot serve yet`
      : "npm not reached yet";
  const age = c.checkedAgo ? ` · checked ${c.checkedAgo}` : "";
  // The deck re-checks on its own now, so the chip must not claim to be the
  // only way — it is the way to not wait. The notes come first in the sentence
  // because they come first in time: they are already in the bundle.
  return `${state}${age} · re-checked periodically · ${NOTES_CLICK}, and to check npm now`;
}

/** The chip's accessible name. The visible text is a version number and both
 *  actions are invisible, so this has to carry all three. */
export function versionChipLabel(c: VersionChipCopy): string {
  const v = `Version v${c.running}, show what's new`;
  // The check is what varies; the notes are what does not. Stated in that order
  // so the constant half is heard first and the caveat second, rather than a
  // reader having to sit through "update checks are off" to find out whether
  // pressing this does anything at all.
  if (c.checkDisabled) return `${v} — update checks are off`;
  if (c.checking) return `${v} — checking npm for a newer release`;
  return `${v} and check npm for a newer release`;
}

/** What the chip is about once a drift has been found. */
export type VersionNoticeCopy = {
  /** "restart" — the new code is already on disk; "upgrade" — it is on npm. */
  kind: "restart" | "upgrade";
  /** The version this process is actually running. */
  from: string;
  /** The version it could be running. */
  to: string;
  /** Whether the banner this chip brings back is on screen already. */
  open: boolean;
};

/** The accessible name of the chip's OTHER branch — the one that is lit
 *  because something is out of date (#381).
 *
 *  It had none, which meant its name fell back to its text: `v1.33.143`, byte
 *  for byte what the healthy chip beside it says. The branch that has news was
 *  the quieter of the two, and the drift it exists to report was carried
 *  entirely by an amber dot (`.v-dot`, aria-hidden) and a `title` — colour and
 *  a hover, which is WCAG 1.4.1 twice over.
 *
 *  The banner below says the same thing, and that is not a substitute: the
 *  banner is dismissible and this chip is deliberately not, so once it is
 *  dismissed the chip is the only surface left carrying the fact.
 *
 *  #715 stopped this being a toggle. The notes have to be reachable from the
 *  version corner in EVERY state — that reachability is the whole reason #712's
 *  dialog is safe to dismiss — and a deck that is behind can stay behind for
 *  weeks, so leaving this branch alone would have hidden them for exactly as
 *  long. It now does what the healthy chip does, plus what it always did: open
 *  the notes, and put the banner back. Only the "put it away again" direction
 *  moved, to the banner's own ×, which was always where dismissing was spelled.
 *  #381's finding survives intact — the name still describes the next click and
 *  still carries the visible version string. */
export function versionNoticeLabel(n: VersionNoticeCopy): string {
  const what = n.kind === "restart"
    ? `v${n.to} is installed and waiting for a restart`
    : `v${n.to} is available on npm`;
  // What the NEXT click does, not what the chip is showing — a name that
  // describes its current state reads backwards to anyone deciding whether to
  // press it. Opening the notes is the half that is true either way; the notice
  // is promised only while it is not already there, because promising to show
  // something the reader can see is how a name stops being trusted.
  const does = n.open ? "show what's new" : "show what's new and the notice";
  return `Version v${n.from}, ${what} — ${does}`;
}
