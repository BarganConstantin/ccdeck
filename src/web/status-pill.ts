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
// The count then came the rest of the way in. Pause was the last text button in
// a bar every other control had been reduced or removed from, and it is a
// canvas verb like the two that left in #527 — it freezes the canvas — so it
// went down to the React Flow control stack with Re-arrange and Clear. The one
// thing holding it back was the state it carried: `Resume · 42 held` is a
// control reporting a queue, and no glyph can do that. It did not have to. The
// pill already knew the number — its title has counted the queue since #504 —
// so the label says it now, and the fact stops being split between a pill at
// one end of the bar and a button at the other.
//
// Out of App.tsx because the precedence between the two flags is the whole
// rule, and there is no DOM here to render a pill in.
//
// #547 gave the paused tone a third thing to say. The hold behind it is now
// bounded — see PAUSE_QUEUE_LIMIT in pause.ts — and a bounded hold that has
// filled up is showing the user a truncated view of what happened while they
// were away. Silently dropping events under a pill that still reads `paused ·
// 99+` would be a worse bug than the unbounded queue that was fixed, so the
// overflow gets the label, outranks the count in both titles, and takes the
// tone's reserved width with it.

export interface StatusPill {
  /** Modifier class on `.pill`, and the word it shows. */
  tone: "live" | "paused" | "dead";
  label: string;
  /**
   * The longest label THIS TONE can ever show, for the pill to reserve.
   *
   * Per tone rather than one string for all three, and the difference is the
   * whole of what is being bought. What moves on its own is the count: while
   * the deck is paused it climbs unbidden, up to once a second, and every digit
   * it gains would walk the machine meter, the tokens and the cost along with
   * it — the pill leads the readout run, so everything after it is downstream
   * of its width. That is #504 one bar over. What does NOT move on its own is
   * the tone: `live` becomes `paused` because somebody pressed Space, and
   * `dead` arrives with a banner that redraws the top of the page anyway.
   * Pinning all three to the paused tone's worst case would spend it
   * permanently — measured, a resting `live` pill goes from 49.89px to 102.64px
   * and holds the extra 52.75px for as long as the deck is running — to still
   * the one transition a user causes by hand. So each tone reserves its own
   * worst case, and the count never moves anything.
   */
  widest: string;
  title: string;
}

/** "1 event" / "42 events" — the unit the count never carried. */
export function heldEvents(held: number): string {
  const n = Math.max(0, Math.floor(held));
  return `${n} event${n === 1 ? "" : "s"}`;
}

/** The point past which the PILL stops counting and says "99+" (#504).
 *
 *  Only the pill — the button that used to carry this cap has left the bar, and
 *  the reasoning came with it unchanged, because it was never about which
 *  element the string sat in. The count is exact everywhere it does not change
 *  the shape of something: the pill's own title says it in full. What the cap
 *  buys is a label whose length is bounded by construction. Without it `held`
 *  walks 9 → 10 → 100 → 1000 and the string gains a character at each boundary,
 *  which on a content-sized element is a box that changes width while you are
 *  reading it. A ceiling is not the whole fix — the box is pinned as well, see
 *  `widest` above — but it is the half that means the widest label is a string
 *  this file can name rather than a limit somebody has to guess at.
 *
 *  99 rather than 999: past a hundred held events the exact figure has stopped
 *  being actionable — "a lot arrived, resuming will take a moment" is the whole
 *  of what the number is telling you by then — and every extra digit is width
 *  spent permanently, because the box is sized for the worst case whether or
 *  not the deck ever reaches it. */
export const HELD_LABEL_CAP = 99;

/** The held count as the pill writes it: exact to the cap, "99+" past it. */
export function heldShort(held: number): string {
  const n = Math.max(0, Math.floor(held));
  return n > HELD_LABEL_CAP ? `${HELD_LABEL_CAP}+` : String(n);
}

/** The accessible name of the pause control, in BOTH states.
 *
 *  It does not flip to "Resume", and that is the price of reporting state as
 *  state. The control carries `aria-pressed`, which a reader announces as a
 *  property of a name that stays put — "Pause the canvas, toggle button,
 *  pressed" is a sentence; "Resume the canvas, toggle button, pressed" is two
 *  contradictory halves. The same rule the sound switch in the bar above
 *  follows: a stable name, the state in the attribute the tree reads. What flips
 *  is `pauseTitle` below, which is a description and is allowed to be one. */
export const PAUSE_LABEL = "Pause the canvas";

/** The pause control's tooltip. The half that does flip.
 *
 *  The label is capped and the title is not, which is the whole of the split:
 *  the pill's label sits in a box whose width the readouts after it depend on,
 *  and a tooltip can be any length it likes. So the pill says "99+" and this
 *  says "231 events".
 *
 *  These are the three sentences the topbar button carried, unchanged, for the
 *  reason #527 gave when it moved Re-arrange and Clear: the strings a user
 *  already knows survive the move, and only the box around them changes. */
export function pauseTitle(s: { paused: boolean; held: number; dropped?: number }): string {
  if (!s.paused) return "Pause live updates — events keep arriving and are applied when you resume (Space)";
  // The overflow outranks the count, because it is the sentence that changes
  // what the user should do about it: a pause holding 42 events will be applied
  // whole, and a pause that has started dropping will not. Said in full here
  // for the reason the exact count is — a tooltip has room, and the label the
  // box has to fit does not.
  const dropped = Math.max(0, Math.floor(s.dropped ?? 0));
  if (dropped > 0) {
    return `The pause is full — ${heldEvents(s.held)} held and ${dropped} older `
      + `${dropped === 1 ? "one" : "ones"} already dropped. Resume to follow the canvas again (Space)`;
  }
  if (s.held <= 0) return "Nothing has arrived since you paused. Resume to follow the canvas again (Space)";
  return `${heldEvents(s.held)} arrived while paused and will be applied in order when you resume (Space)`;
}

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

/** The paused pill counts its queue in the label as well as the title.
 *
 *  `paused · 42`, and no separator at all at zero: a pause that has held
 *  nothing is not a queue of length nought, it is a queue that has not started,
 *  and "paused · 0" would be a number drawing attention to itself for having
 *  nothing to report. The box does not collapse with the text — `widest` keeps
 *  it — so dropping the separator costs no movement.
 *
 *  Deliberately NOT the button's `Resume · 42 held` wording. That string had to
 *  name a verb, because it was printed on the thing you press; this one is a
 *  readout, and what a readout owes is the state and the number. The unit is
 *  not lost with the verb — it moves to the title, which has room for "42
 *  events held until you resume" and no box to fit it in. */
/** What the pill reads once the hold has overflowed — and the widest label the
 *  paused tone can render, one glyph past `paused · 99+`. That glyph is the
 *  whole cost of the change and it is charged to the paused tone alone: `live`,
 *  the tone the deck rests in, reserves nothing extra. */
const PAUSED_FULL = "paused · full";

const pausedLabel = (held: number, dropped: number) => {
  // A hold that has hit its ceiling has stopped being a queue you can read a
  // number off. The count is pinned at the limit while events fall off the
  // back of it, so `paused · 99+` there would be a figure that is no longer
  // measuring anything — and worse, it would look exactly like the deep pause
  // one event earlier, which is still going to be applied whole. `full` is the
  // one true thing to say: at capacity, and dropping. See PAUSE_QUEUE_LIMIT.
  if (dropped > 0) return PAUSED_FULL;
  return held > 0 ? `paused · ${heldShort(held)}` : "paused";
};

export function statusPill(s: { connected: boolean; paused: boolean; held: number; dropped?: number }): StatusPill {
  const dropped = Math.max(0, Math.floor(s.dropped ?? 0));
  if (!s.connected) {
    return {
      tone: "dead",
      label: "offline",
      widest: "offline",
      title: s.paused
        ? "SSE disconnected — and the canvas is paused, so resuming will not bring events back until it reconnects"
        : "SSE disconnected",
    };
  }
  if (s.paused) {
    return {
      tone: "paused",
      label: pausedLabel(s.held, dropped),
      // Every label this tone can render is `paused · ` plus one of "0".."99",
      // "99+" or "full", and "full" is the longest of those — so the ghost is
      // that one, unconditionally, whether or not this particular pill has
      // overflowed. Reserving it only when it is showing would put the box
      // back in the business of resizing under a state that changes on its own,
      // which is the thing this field exists to prevent. That is an argument
      // from construction rather than from a measurement, which is what a
      // string shipped to three font stacks needs.
      widest: PAUSED_FULL,
      title: dropped > 0
        ? `Connected — the pause is full at ${heldEvents(s.held)}; the oldest are being dropped `
          + `as new ones arrive. Resume to catch up (Space)`
        : s.held > 0
          ? `Connected — ${heldEvents(s.held)} held until you resume (Space)`
          : "Connected — updates held until you resume (Space)",
    };
  }
  return { tone: "live", label: "live", widest: "live", title: "Receiving events" };
}
