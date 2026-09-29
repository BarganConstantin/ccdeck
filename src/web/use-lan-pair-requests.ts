// LAN pairing requests waiting on this deck: the poll that finds one, and the
// one answer at a time the dialog over the canvas gives.
//
// Lifted out of App.tsx's `Inner`, where it sat in the middle of a region headed
// "the name this deck was started under", beside the side panels and Browser
// Watch. It reads nothing from the component — its poll's dependency list is
// empty — and nothing in the component wrote its state, so it was only ever
// there by position. Both setters are private now.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import { withAliases } from "./lan-roster";
import type { LanStranger } from "./lan-types";
import { LAN_POLL_OFF_MS, LAN_POLL_ON_MS } from "./use-lan-section";

export interface LanPairRequests {
  /** Decks asking to pair with this one, with the names given to them here. */
  lanPending: LanStranger[];
  /** Fingerprints answered with Escape: still pending, not asked again this load. */
  lanDeferred: MutableRefObject<Set<string>>;
  /** Which answer is in flight, so the dialog can disable both. */
  lanBusy: "accept" | "dismiss" | null;
  answerLanPair: (action: "accept" | "dismiss", fp: string) => Promise<void>;
  /** "Later": leave the request pending on the server, and stop asking about it
   *  until this page is reloaded. */
  deferLanPair: (fp: string) => void;
}

export function useLanPairRequests(): LanPairRequests {
  /** Decks that have dialled this one and are waiting for an answer.
   *
   *  Polled up here rather than read where the answer used to live, because the
   *  accounts panel is a place somebody GOES and this is a question somebody is
   *  ASKED. Until it is answered the far deck is stalled and its owner is
   *  watching an empty roster, so the question cannot depend on this deck's
   *  owner happening to open a panel three sections down.
   *
   *  Five seconds, the cadence the panel's own section polls at, and cheap at
   *  that rate: /api/lan answers out of the engine's memory, and the one probe
   *  behind it that costs anything is throttled in the server. */
  const [lanPending, setLanPending] = useState<LanStranger[]>([]);
  /** Answered with Escape rather than with a press: still pending on the
   *  server, deliberately not asked again until this page is reloaded. The
   *  panel's section still lists it, which is where "later" points. */
  const lanDeferred = useRef<Set<string>>(new Set());
  const [lanBusy, setLanBusy] = useState<"accept" | "dismiss" | null>(null);

  useEffect(() => {
    let alive = true;
    let t = 0;
    // A TIMEOUT CHAIN, NOT AN INTERVAL, so the cadence can follow the switch —
    // five seconds while the network is on, a minute while it is off. With it
    // off nothing can arrive: no beacon is running, nobody can dial in, and
    // `pending` cannot become anything. This poll and the section's own were
    // both asking anyway, so an off deck was making three requests every five
    // seconds for as long as its tab was open.
    //
    // A minute is not too slow for the moment it comes back on, either: a peer
    // has to hear the beacon before it can dial, which is up to thirty seconds,
    // so there is nothing to be late for.
    const pull = () => {
      fetch("/api/lan")
        .then(r => (r.ok ? r.json() : null))
        .then(j => {
          if (!alive) return null;
          // With the names somebody here gave those decks, so the dialog over
          // the canvas says the same word the panel's row does.
          if (j?.ok) setLanPending(withAliases(Array.isArray(j.pending) ? j.pending : [], j.aliases));
          return j;
        })
        .catch(() => null) // the deck is down; the connection banner already says so
        .then(j => {
          if (alive) t = window.setTimeout(pull, j?.enabled === true ? LAN_POLL_ON_MS : LAN_POLL_OFF_MS);
        });
    };
    pull();
    return () => { alive = false; window.clearTimeout(t); };
  }, []);

  const answerLanPair = useCallback(async (action: "accept" | "dismiss", fp: string) => {
    // One answer at a time, and the dialog disables both while it is in flight:
    // a second press on a request the server has already consumed comes back
    // `not_seen`, which is an error message about nothing.
    if (lanBusy) return;
    setLanBusy(action);
    try {
      const res = await fetch("/api/lan/peer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, fp }),
      });
      const out = await res.json().catch(() => null);
      // The route answers with the whole status, so the next request — if there
      // is one — is already in hand and the dialog does not blink out and back
      // in on the next poll.
      if (out && Array.isArray(out.pending)) setLanPending(withAliases(out.pending, out.aliases));
      else setLanPending(prev => prev.filter(p => p.fp !== fp));
    } catch {
      // Nothing was decided, so nothing is drawn as decided: the request stays
      // in front and the next poll says whether it is still there.
    } finally {
      setLanBusy(null);
    }
  }, [lanBusy]);

  // Was written inline in the dialog's "Later" handler in App.tsx, which is the
  // one place outside this hook that had to reach for `setLanPending` — and only
  // to force a redraw, because the deferred set is a ref. Named here, the setter
  // stays private and the dialog says what it means.
  const deferLanPair = useCallback((fp: string) => {
    if (lanBusy) return;
    lanDeferred.current.add(fp);
    // The set is a ref, so nothing above re-renders on its own: bump the list it
    // is filtered against to redraw once.
    setLanPending(prev => [...prev]);
  }, [lanBusy]);

  return { lanPending, lanDeferred, lanBusy, answerLanPair, deferLanPair };
}
