// The clock the accounts panel and the usage panel print their countdowns and
// pace against, in whole seconds.
//
// Both panels wrote out the same state and the same effect: a `nowSec` read
// when the panel mounts, and an interval that reads it again every thirty
// seconds until the panel unmounts. Their data arrives on its own schedule —
// the accounts poll, the quota reads — and a reset countdown has to keep
// moving between those, without the parent re-rendering the panel to do it.
//
// NOT use-now.ts, on purpose. useNow shares one timer per rate between every
// component on that beat, starts it with the first subscriber and answers in
// milliseconds. Each panel here owns its interval: it starts when that panel
// mounts, so the countdowns move thirty seconds after the panel opened rather
// than on a beat something else started, and it stops when the panel goes.
import { useEffect, useState } from "react";

/** How often a panel's clock is read again. */
const TICK_MS = 30_000;

/** Whole seconds since the epoch: read at mount, and again every TICK_MS for
 *  as long as the caller is mounted. */
export function usePanelClock(): number {
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), TICK_MS);
    return () => window.clearInterval(t);
  }, []);
  return nowSec;
}
