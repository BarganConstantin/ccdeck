// Saying whether somebody is actually looking at this deck.
//
// Lifted out of App.tsx's `Inner` unchanged, and it is the cleanest thing in
// there: one effect with an empty dependency list, no state, no refs, nothing
// read from the component and nothing handed back. It had no business being
// inside a five-thousand-line component and nothing depended on it being there.
import { useEffect } from "react";

import { newTabId, PRESENCE_BEAT_MS, presenceShouldSend, tabLooking } from "./presence";

/**
 * The server updates the deck on its own while nobody is looking at it
 * (auto-update.mjs), and only a page can say whether somebody is. So each tab
 * says so on every focus change, and again every PRESENCE_BEAT_MS while it
 * holds focus, because the claim expires on the server rather than being
 * trusted forever. A tab that closes takes its claim back on the way out;
 * one that cannot is forgotten when its last beat runs out.
 */
export function usePresenceBeacon(): void {
  useEffect(() => {
    const tab = newTabId();
    let last: boolean | null = null;
    const say = (looking: boolean) => {
      fetch("/api/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tab, looking }),
        // keepalive, so the goodbye sent from `pagehide` still leaves.
        keepalive: true,
      }).catch(() => {});
    };
    const tick = () => {
      const looking = tabLooking(document);
      if (presenceShouldSend(last, looking)) say(looking);
      last = looking;
    };
    const bye = () => {
      if (last) say(false);
      last = false;
    };
    tick();
    const iv = window.setInterval(tick, PRESENCE_BEAT_MS);
    window.addEventListener("focus", tick);
    window.addEventListener("blur", tick);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("pagehide", bye);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener("focus", tick);
      window.removeEventListener("blur", tick);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("pagehide", bye);
      bye();
    };
  }, []);
}
