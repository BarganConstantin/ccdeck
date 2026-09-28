// The two requests the accounts panel makes outside the ⋯ menu: switching to
// an account, and every auto-switch control's POST — with the confirmation a
// switch that took leaves on its row.
//
// Lifted out of AccountsPanel.tsx unchanged: `switched` and the effect that
// clears it when a fresh roster says the account is no longer the live one,
// doSwitch, and post. What that buys is the writer count on `switched`: a
// switch sets it, the next switch takes it down, and a roster that has moved
// on clears it — all three here, and the setter with them. The panel reads the
// confirmation to draw and presses the two requests by name.
//
// Where each answer is said is unchanged, and none of it is this file's: a
// refused switch lands on its row through the roster hook's failure line, an
// auto-switch refusal at the foot of the panel or, when the press came from
// the menu, under the control in it (sayInMenu), and a switch that took away
// its own button hands focus on through the panel's rescueFocus.
import { useCallback, useEffect, useState } from "react";

import { activeSwitchNote } from "./active-switch-note";
import { commandOutput, explainCommandFailure } from "./admin-failure";
import { type Failure } from "./accounts-reload";
import { type AccountsData } from "./claude-accounts";

export interface AccountSwitchingDeps {
  /** The roster as last read — see use-account-roster.ts. */
  data: AccountsData | null;
  /** The panel's one request slot — see use-request-slot.ts. */
  claim: (tag: string) => boolean;
  release: () => void;
  /** Read the roster again, the way the header's ↻ does. */
  load: (force?: boolean) => Promise<void>;
  /** The panel's failure line — see use-account-roster.ts. */
  sayFailure: (f: Failure | null) => void;
  clearFailure: () => void;
  /** The ⋯ menu's refusal line — see use-account-menu.ts. */
  sayInMenu: (f: Failure | null) => void;
  /** Focus the nearest control that outlived the press — see the panel. */
  rescueFocus: (row: number | null) => void;
}

export function useAccountSwitching({
  data, claim, release, load, sayFailure, clearFailure, sayInMenu, rescueFocus,
}: AccountSwitchingDeps) {
  /** The account a switch from this panel just landed on (#827), said on its
   *  own row until the next switch or until it stops being the active one. The
   *  `active` chip moving rows used to be the only answer, and a screen reader
   *  heard nothing at all. */
  const [switched, setSwitched] = useState<{ num: number; name: string } | null>(null);

  /** Every auto-switch control is one POST; they all reload afterwards. The
   *  refusal is said where the press was: at the foot of the column for the
   *  policy row, and inside the ⋯ menu for an account held out or put back. */
  const post = useCallback(async (body: Record<string, unknown>, tag: string, where: "panel" | "menu" = "panel") => {
    if (!claim(tag)) return null;
    const say = where === "menu" ? sayInMenu : sayFailure;
    say(null);
    try {
      const res = await fetch("/api/cswap-auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => null);
      // This route's `detail` is cswap's stderr verbatim, not a sentence
      // anybody wrote — same as the switch below, and unlike the admin route.
      // The status matters, not only the body: the deck's own gate refuses a
      // mutation before any command runs, and says so with no `reason` for the
      // map to find. See GATE_REASONS.
      if (!out?.ok) say({ text: explainCommandFailure(out, "command failed", res.status), raw: commandOutput(out) });
      return out;
    } catch {
      say({ text: "server unreachable" });
      return null;
    } finally {
      release();
    }
  }, [claim, release, sayInMenu, sayFailure]);

  // A switch from the panel can be superseded by auto-switch or by a command
  // outside the panel. Clear its confirmation when a fresh roster says that
  // account is no longer active, so it cannot reappear if it becomes active
  // again later. This runs on roster changes rather than on `switched` changes:
  // the previous roster may still describe the account before our POST lands.
  useEffect(() => {
    if (!data?.ok || !data.accounts) return;
    setSwitched(previous => activeSwitchNote(previous, data.accounts));
  }, [data]);

  const doSwitch = async (num: number, name: string) => {
    if (!claim(`switch-${num}`)) return;
    clearFailure();
    setSwitched(null);
    try {
      const res = await fetch("/api/claude-accounts/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: num }),
      });
      const body = await res.json().catch(() => null);
      // Both answers land on the row that was pressed (#827): the refusal is
      // tagged with it, and a switch that took names the account it took to.
      if (!body?.ok) sayFailure({ text: explainCommandFailure(body, "the switch failed"), raw: commandOutput(body), row: num });
      else setSwitched({ num, name });
      await load(true);
    } catch {
      sayFailure({ text: "server unreachable", row: num });
    } finally {
      release();
      // A switch that landed replaces this button with the `active` marker,
      // which is a span and cannot hold focus. One that failed leaves the
      // button standing, still focused, and this is a no-op — the rescue only
      // fires when focus was actually dropped. See panel-press.ts.
      rescueFocus(num);
    }
  };

  return { switched, post, doSwitch };
}
