// What the toolbar says about whether the board is moving.
//
// The pill was keyed on SSE connectivity alone, so it read "live" with a
// pulsing green dot while the canvas was frozen — and Space, which pauses, is
// an easy key to hit by accident on a canvas UI. The pill was not lying (the
// stream really is connected and receiving while paused; the gate in pause.ts
// holds arrivals rather than closing the connection), but the most prominent
// indicator in the toolbar looked identical whether the deck was following the
// work or had stopped repainting it. The only signal was the Pause button
// flipping to an amber "Resume" — with a bare number appended to it, no unit,
// no label, and a title that still said "Pause/resume live updates".
//
// So: three states rather than two, and the held queue is named wherever it is
// counted. Disconnected outranks paused because a resume cannot fix it — but
// the title still says both, since resuming a deck whose stream is dead is a
// thing a user will otherwise try.
//
// Out of App.tsx because the precedence between the two flags is the whole
// rule, and there is no DOM here to render a pill in.

export interface StatusPill {
  /** Modifier class on `.pill`, and the word it shows. */
  tone: "live" | "paused" | "dead";
  label: string;
  title: string;
}

/** "1 event" / "42 events" — the unit the count never carried. */
export function heldEvents(held: number): string {
  const n = Math.max(0, Math.floor(held));
  return `${n} event${n === 1 ? "" : "s"}`;
}

/** The point past which the BUTTON stops counting and says "99+" (#504).
 *
 *  Only the button. The count is exact everywhere it does not change the shape
 *  of a control — the button's own title says it in full, and so does the
 *  pill's. What the cap buys is a label whose length is bounded by
 *  construction: without it `held` walks 9 → 10 → 100 → 1000 and the string
 *  gains a character at each boundary, which on a content-sized button is a
 *  control that changes width while you are reading it. A ceiling is not the
 *  whole fix — the box is pinned as well, see PAUSE_WIDEST_LABEL — but it is
 *  the half that means the widest label is a string this file can name rather
 *  than a limit somebody has to guess at.
 *
 *  99 rather than 999: past a hundred held events the exact figure has stopped
 *  being actionable — "a lot arrived, resuming will take a moment" is the whole
 *  of what the number is telling you by then — and every extra digit is width
 *  spent permanently, because the box is sized for the worst case whether or
 *  not the deck ever reaches it. */
export const HELD_LABEL_CAP = 99;

/** The held count as the button writes it: exact to the cap, "99+" past it. */
export function heldShort(held: number): string {
  const n = Math.max(0, Math.floor(held));
  return n > HELD_LABEL_CAP ? `${HELD_LABEL_CAP}+` : String(n);
}

/** The longest label pauseButton can ever return.
 *
 *  Rendered invisibly inside the button, in the same grid cell as the live
 *  label, so the control measures itself against its own worst case in
 *  whatever font the platform hands it. A `min-width` in pixels would have
 *  been this sheet's usual idiom and is the wrong tool here: the number would
 *  be measured in -apple-system on the machine that wrote it and applied to
 *  Segoe UI on Windows and whatever fontconfig picks on Linux, where a wider
 *  face simply overruns it and the reflow comes back. Deriving the string from
 *  HELD_LABEL_CAP rather than spelling it out is the other half — the ghost
 *  and the labels cannot drift apart, because a change to the cap rewrites
 *  both. */
export const PAUSE_WIDEST_LABEL = `Resume · ${HELD_LABEL_CAP}+ held`;

/**
 * The half of the status pill's `title` that exists nowhere else on the page,
 * moved to where it is already announced (#510).
 *
 * The pill carries its explanation as a `title` on a non-focusable <span>, so
 * Chrome exposes it as a description hanging off an unnamed generic node:
 * mouse-only, and unreliable even for the readers that do announce descriptions.
 * The tokens and cost readouts beside it have the same shape and it costs them
 * a convenience — their splits are also in the usage panel, the session summary
 * and the history modal. This one sentence was not duplicated anywhere.
 *
 * Two ways out were on the table. Making the pill focusable and named would put
 * the sentence on the keyboard's path, at the price of a new tab stop in a bar
 * that already gains one mid-session when the meter swaps its idle <span> for a
 * <button>. Moving the sentence into the connection banner costs no tab stop
 * and reaches assistive tech by a route that already works.
 *
 * The banner wins, and the tradeoff that was supposed to make it a close call
 * turns out not to exist: the argument for the pill was "discoverability
 * forever versus announced once", on the premise that the banner is dismissible
 * and the pill is not. `.conn-banner` has no dismiss control — the VERSION
 * banner does, and that is the one that can be shut. So the banner is on screen
 * for exactly as long as the condition it describes, which is the property the
 * pill was being kept for.
 *
 * Null while the stream is up, and null while it is down but the canvas is
 * running: the banner already says the connection is lost in its own words, and
 * repeating that is not what was missing. What was missing is the interaction
 * between the two states — that Space is not the way out of this one.
 *
 * The claim is the pill's own, not a stronger one. Its title says resuming
 * "will not bring events back UNTIL it reconnects", which is a statement about
 * a queue that is not being fed, not about events being destroyed; the sentence
 * below keeps that scope.
 */
export function outageSentence(s: { connected: boolean; paused: boolean }): string | null {
  if (s.connected || !s.paused) return null;
  return "The canvas is paused as well — Space resumes it, but nothing new arrives until the stream is back.";
}

export function statusPill(s: { connected: boolean; paused: boolean; held: number }): StatusPill {
  if (!s.connected) {
    return {
      tone: "dead",
      label: "offline",
      title: s.paused
        ? "SSE disconnected — and the canvas is paused, so resuming will not bring events back until it reconnects"
        : "SSE disconnected",
    };
  }
  if (s.paused) {
    return {
      tone: "paused",
      label: "paused",
      title: s.held > 0
        ? `Connected — ${heldEvents(s.held)} held until you resume (Space)`
        : "Connected — updates held until you resume (Space)",
    };
  }
  return { tone: "live", label: "live", title: "Receiving events" };
}

/** The Pause/Resume button. The count belongs to the queue, so it is said in
 *  the queue's terms rather than left as a number beside a verb.
 *
 *  The label is capped and the title is not, which is the whole of the split:
 *  the label sits in a box whose width other controls depend on, and the title
 *  is a tooltip that can be any length it likes. So the button says "99+" and
 *  the tooltip says "231 events". */
export function pauseButton(s: { paused: boolean; held: number }): { label: string; title: string } {
  if (!s.paused) return { label: "Pause", title: "Pause live updates — events keep arriving and are applied when you resume (Space)" };
  if (s.held <= 0) return { label: "Resume", title: "Nothing has arrived since you paused. Resume to follow the canvas again (Space)" };
  return {
    label: `Resume · ${heldShort(s.held)} held`,
    title: `${heldEvents(s.held)} arrived while paused and will be applied in order when you resume (Space)`,
  };
}
