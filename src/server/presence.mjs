// Whether somebody is looking at the deck right now, as its tabs say.
//
// The server can tell whether a page is CONNECTED — `sseClients.size` — but not
// whether anybody is looking at one: a tab behind other windows keeps its
// stream open all day. The away-update (auto-update.mjs) needs the second fact,
// so each tab reports it (src/web/presence.ts), and a claim expires here unless
// it is renewed, because a tab that crashed or lost its network never gets to
// take it back.
export const PRESENCE_TTL_MS = 45_000;
/** More tabs than anybody opens on one deck. A bound because the ids arrive
 *  from pages; past it the oldest claim goes. */
const MAX_TABS = 32;
const TAB_ID = /^[\w-]{1,64}$/;

export function createPresence({ ttlMs = PRESENCE_TTL_MS } = {}) {
  /** tab id → when it last said it was looking */
  const seen = new Map();
  return {
    /** A tab saying whether it is being looked at. False for an id no page
     *  could have made, which the route answers with a 400. */
    report(tab, looking, now) {
      if (typeof tab !== "string" || !TAB_ID.test(tab)) return false;
      seen.delete(tab);
      if (looking) {
        seen.set(tab, now);
        while (seen.size > MAX_TABS) seen.delete(seen.keys().next().value);
      }
      return true;
    },
    /** Whether any tab's claim is still live. A claim stamped by a clock that
     *  has since moved either way is as expired as an old one. */
    looking(now) {
      for (const [tab, at] of seen) {
        if (Math.abs(now - at) > ttlMs) seen.delete(tab);
        else return true;
      }
      return false;
    },
  };
}
