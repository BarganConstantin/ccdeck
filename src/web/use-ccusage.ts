// The usage-history modal's ccusage run: one request per range, the newest
// one's answer kept, and a forced re-run that refuses a second press.
//
// Lifted out of UsageHistoryModal.tsx, which draws what this hands back and
// owns none of the rules about when it arrives.
import { useEffect, useRef, useState } from "react";
import { createLatestGuard } from "./latest";
import { presetSince } from "./usage-range";
import { selfPressAccepted } from "./panel-press";
import { asResp, type CcusageResp } from "./usage-history";

/** A landed response together with the preset it was requested for. The tag is
 *  what lets the view refuse to show one range's numbers under another's tab. */
interface Landed { range: number; resp: CcusageResp; }

// ── data hook ─────────────────────────────────────────────────────────────
export function useCcusage(rangeDays: number) {
  const [landed, setLanded] = useState<Landed | null>(null);
  const [loading, setLoading] = useState(false);

  // Responses can land out of order — a cached 7d range answers instantly while
  // an uncached 90d one runs the CLI for seconds — so only the newest request
  // is allowed to write data or clear `loading`.
  // Seeded through a `useState` initialiser, not `useRef(createLatestGuard())`
  // — that argument is re-evaluated on every render and all but the first
  // guard is thrown away (#612).
  const guard = useState(createLatestGuard)[0];

  // The same fact as `loading`, readable without waiting for a render. Both ↻
  // and Try again stay enabled while their own run is out (#620), so a second
  // Enter reaches here and this is what refuses it. Only a forced run takes the
  // lock, and every new request re-states who holds it: a range change starts
  // an unforced load, which supersedes the forced one — whose `finally` will
  // not fire under `isCurrent` any more — so it has to clear the lock itself
  // rather than leave the ↻ dead for the life of the modal.
  const busyRef = useRef(false);

  const load = (force = false) => {
    if (force && !selfPressAccepted(busyRef.current)) return;
    const isCurrent = guard.begin();
    busyRef.current = force;
    const range = rangeDays;
    setLoading(true);
    const since = presetSince(range);
    const url = `/api/ccusage?since=${since}${force ? "&refresh=1" : ""}`;
    fetch(url)
      .then(r => r.json())
      .then(raw => { if (isCurrent()) setLanded({ range, resp: asResp(raw) }); })
      // The deck itself never answered, which is a different failure from
      // ccusage failing and the only one whose remedy is about the deck.
      .catch(() => { if (isCurrent()) setLanded({ range, resp: { ok: false, reason: "unreachable" } }); })
      .finally(() => { if (isCurrent()) { busyRef.current = false; setLoading(false); } });
  };

  useEffect(() => {
    load(false);
    return () => guard.cancel();
    /* eslint-disable-next-line */
  }, [rangeDays]);
  return { landed, loading, reload: () => load(true) };
}
