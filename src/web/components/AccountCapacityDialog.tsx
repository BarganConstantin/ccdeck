// Account capacity or Reset calendar, each opened from its own door on the
// left stripe, whether the accounts panel is open or not.
//
// Both used to open from a gauge in the panel's header, on the panel's own
// roster and clock. From the stripe there may be no panel, so this reads the
// roster the way the panel does — use-account-roster.ts, a forced read on open
// and the poll after it, for as long as the dialog is up — on the same kind of
// clock.
// A second reader beside an open panel costs nothing: the server answers both
// from its five-second cache of two local files (claude-accounts.mjs).
//
// Drawn once the first answer is in, so it never opens on "0 of 0" and then
// fills: the read is local, and a failed one still opens it, saying so.
import { useEffect, useState } from "react";
import AccountsUsageReport, { type CapacityView } from "./AccountsUsageReport";
import { DialogPresence } from "./Dialog";
import { useAccountRoster } from "../use-account-roster";
import { usePanelClock } from "../use-panel-clock";
import { reachable } from "../account-fold";
import { laneKey } from "../lane-open";
import { byAvailability } from "../other-accounts-order";
import { accountIssue } from "../account-issue";
import type { Account } from "../claude-accounts";
import { reloadText } from "../accounts-reload";
import { useT } from "../i18n";

/** The order the accounts panel lists a roster in: the live account, then the
 *  others usable first (internal #94, other-accounts-order.ts byAvailability).
 *  With nobody live, the roster's own. */
export function panelOrder(roster: readonly Account[], nowSec: number): string[] {
  const live = roster.filter(a => a.active);
  if (live.length === 0) return roster.map(laneKey);
  const others = roster.filter(a => !a.active);
  return [...live, ...byAvailability(others, a => ({
    reachable: reachable(a, nowSec),
    rateLimited: accountIssue(a, nowSec)?.kind === "rate",
  }), nowSec)].map(laneKey);
}

/** The roster's own handoff, unused: nothing here keeps lanes to trim. */
function ignoreRoster() {}

export default function AccountCapacityDialog({ view, onClose }: { view: CapacityView; onClose: () => void }) {
  const t = useT();
  const { data, failure } = useAccountRoster(ignoreRoster);
  const nowSec = usePanelClock();
  // Taken from the first roster and held: a poll does not move the rows under
  // the reader.
  const [order, setOrder] = useState<string[] | null>(null);
  useEffect(() => {
    if (order == null && data) setOrder(panelOrder(data.accounts ?? [], nowSec));
  }, [data, order, nowSec]);
  return (
    <DialogPresence when={order != null || failure != null}>
      {() => (
        <AccountsUsageReport accounts={data?.accounts ?? null} order={order ?? []}
          failed={failure?.reload ? reloadText(failure, t) : null}
          nowSec={nowSec} onClose={onClose} view={view} />
      )}
    </DialogPresence>
  );
}
