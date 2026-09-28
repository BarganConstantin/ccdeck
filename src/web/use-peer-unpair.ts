// The two unpairs in a deck's own dialog: the footer's, for the machine the
// dialog is about, and one beside each other deck folded into its row.
//
// Lifted out of LanPeerModal.tsx unchanged. Each costs two presses, as the
// row's does, stands down on its own after four seconds, and ignores a second
// press sooner than CONFIRM_GAP_MS after the first. The two share the moment
// of arming, and arming either stands the other down (#1607), so the dialog
// never shows two. A confirmed unpair goes through the dialog's own `run`, so
// what went wrong is said in the dialog rather than behind its scrim.
import { useEffect, useRef, useState } from "react";

import type { DeckRow } from "./lan-roster";
import { armedPress, CONFIRM_GAP_MS } from "./panel-press";

export function usePeerUnpair({ row, run, onVerb, onUnpair }: {
  /** The row the dialog is about. Its own unpair is armed for whichever deck
   *  leads it, so a lead that changes between two polls stays armed. */
  row: DeckRow;
  /** The dialog's way of running one of the section's calls. */
  run: (act: () => Promise<string | null>) => Promise<boolean>;
  /** The row's own verb, which for a paired row is unpair. */
  onVerb: () => Promise<string | null>;
  /** Unpair one folded deck, by fingerprint. */
  onUnpair?: (fp: string) => Promise<string | null>;
}) {
  /** Unpair costs two presses here as it does on the row. */
  const [armed, setArmed] = useState(false);
  /** When it was armed, so a double-click cannot be its own confirmation. */
  const armedAt = useRef(0);
  /** Which folded deck's unpair is armed, by fingerprint: the same two presses,
   *  one deck at a time. Shares armedAt, since only one can be armed — arming
   *  either stands the other down (#1607), as a row armed in the list does. */
  const [armedTwin, setArmedTwin] = useState<string | null>(null);
  // An armed unpair stands down on its own, the way the row's does.
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4_000);
    return () => window.clearTimeout(t);
  }, [armed]);
  useEffect(() => {
    if (!armedTwin) return;
    const t = window.setTimeout(() => setArmedTwin(null), 4_000);
    return () => window.clearTimeout(t);
  }, [armedTwin]);
  /** A press on the footer's Unpair. */
  const pressOwn = () => {
    const now = Date.now();
    const press = armedPress({
      armedFor: armed ? row.fp : null, target: row.fp, armedAt: armedAt.current, now, gapMs: CONFIRM_GAP_MS,
    });
    if (press === "arm") { setArmed(true); setArmedTwin(null); armedAt.current = now; return; }
    // A double-click is one decision, not two — the row's rule.
    if (press === "ignore") return;
    setArmed(false);
    void run(onVerb);
  };
  /** A press on a folded deck's unpair. */
  const pressTwin = (fpT: string) => {
    if (!onUnpair) return;
    const now = Date.now();
    const press = armedPress({
      armedFor: armedTwin, target: fpT, armedAt: armedAt.current, now, gapMs: CONFIRM_GAP_MS,
    });
    if (press === "arm") { setArmedTwin(fpT); setArmed(false); armedAt.current = now; return; }
    if (press === "ignore") return;
    setArmedTwin(null);
    void run(() => onUnpair(fpT));
  };
  return { armed, armedTwin, pressOwn, pressTwin };
}
