// Chat's older turns, read as the reader nears the top (ChatView.tsx). The view
// says whether the top of the conversation is within a view's height of what
// shows, after each draw and as the scroll moves; this says whether to ask the
// host for the page before now. Pure; ChatView holds it.
//
// ONE AT A TIME. Once asked, nothing more is asked until the host has answered
// that offer: a burst of scroll events, or the observer and the scroll both
// answering for one move, asks once. The host holds one read in flight per
// session as well (use-session-transcript.ts), and drops a page read for a
// session no longer shown.
//
// NOT AFTER A FAILURE. The button says the page could not be read and pressing
// it tries again; a host that fails is not asked again on every scroll.
//
// NOTHING AT THE START. The host offers no older part there, and nothing is asked.
//
// A RUN IS BOUNDED. A first page shorter than the view leaves the top in reach,
// and the next one is asked by itself, until the conversation scrolls or
// starts; at most OLDER_RUN pages in a row, so pages that add no height cannot
// ask forever. The top going out of reach, the reader moving up on their own,
// or another session starts a new run.

/** The most pages asked in a row while the top stays in reach and the reader does not move. */
export const OLDER_RUN = 4;

/** What the host offers, as far as asking goes: ChatOlder's state. */
export interface OlderOffer { loading?: boolean; failed?: boolean }

export interface OlderReach {
  /** The session shown. */
  session?: string;
  /** The offer of an older part: none once the start is held. */
  older?: OlderOffer;
  /** The top of the conversation is within a view's height of what shows. */
  near: boolean;
}

export interface OlderPager {
  /** Whether to ask for the page before now. True counts the ask as made. */
  due(reach: OlderReach): boolean;
  /** The reader moved toward the top on their own: a new run. */
  moved(): void;
}

export function olderPager(run = OLDER_RUN): OlderPager {
  let session: string | undefined;
  let made = 0;
  // The offer asked from, until the host answers with another one.
  let asked: OlderOffer | null = null;
  return {
    due(reach) {
      if (reach.session !== session) { session = reach.session; made = 0; asked = null; }
      const older = reach.older;
      if (older !== asked) asked = null;
      if (!reach.near) made = 0;
      if (!older || older.loading || older.failed || asked || !reach.near || made >= run) return false;
      made++;
      asked = older;
      return true;
    },
    moved() { made = 0; },
  };
}

/** The top within a view's height, measured: for a page with no IntersectionObserver. */
export function topInReach(el: { scrollTop: number; clientHeight: number }): boolean {
  return el.scrollTop <= el.clientHeight;
}

/** The observer's reach: a view's height above the region's top. */
export const OLDER_MARGIN = "100% 0px 0px 0px";
