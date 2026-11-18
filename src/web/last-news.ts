// When the link to the deck last carried news, for the phone's "Can't reach
// your computer" card (components/ConnectionBanner.tsx).
//
// The page cannot know what the deck did while the link was down, so the last
// news is the last moment the page knew the link was up: the moment it dropped,
// when the stream had been open. Counted from the events themselves it would be
// wrong twice over: a link open and quiet since noon would read "noon" at two,
// and an event's age against this phone's clock is a comparison between two
// clocks. A link that was already down keeps the time it first dropped at, and
// the browser's repeated errors while it retries change nothing.

/** What the page remembers of the link. */
export interface LinkMemory {
  /** The stream is open now. */
  open: boolean;
  /** When the stream last dropped after being open; null if it never did. */
  droppedAt: number | null;
}

export const NEVER_OPEN: LinkMemory = { open: false, droppedAt: null };

/** The stream opened. The time it last dropped at stays until it drops again. */
export function linkOpened(memory: LinkMemory): LinkMemory {
  return memory.open ? memory : { open: true, droppedAt: memory.droppedAt };
}

/** The stream reported an error: a drop if it was open, else the same link
 *  still down, keeping the earlier time. */
export function linkDropped(memory: LinkMemory, now: number): LinkMemory {
  return memory.open ? { open: false, droppedAt: now } : memory;
}
