// Keyboard focus through a roster the accounts panel did not ask for (#1497).
//
// Remembers which control in the panel has focus, by id, and when a new roster
// has taken that control away hands focus to the first thing in
// refocusSelectors that is on screen — the same control drawn again in the
// other list, most often. Only when the roster is what dropped it: focus the
// reader moved themselves, off the panel or onto the page, forgets the id on
// the way out, so a later poll never pulls them back.
import { type FocusEvent, useLayoutEffect, useRef } from "react";

import { refocusSelectors } from "./account-refocus";
import { type AccountsData } from "./claude-accounts";
import { focusDropped } from "./panel-press";

export function useRosterFocus(data: AccountsData | null) {
  // The id of the control in the panel that has focus, or null for one with
  // no id — whose presses hand focus on for themselves — or for focus that
  // left the panel.
  const focusedId = useRef<string | null>(null);

  const onFocus = (e: FocusEvent<HTMLElement>) => {
    focusedId.current = e.target.id || null;
  };
  // A control that is still in the document lost focus because the reader
  // moved it, and that is theirs to keep. One the commit removed is not
  // connected any more — if a blur is dispatched for it at all — and its id is
  // what the roster below asks after.
  const onBlur = (e: FocusEvent<HTMLElement>) => {
    if (e.target.isConnected) focusedId.current = null;
  };

  // Before paint, in the commit that drew the new roster: the old row is gone
  // and the new one is already in the document.
  useLayoutEffect(() => {
    const id = focusedId.current;
    if (!id || !focusDropped(document.activeElement?.tagName ?? null)) return;
    for (const sel of refocusSelectors(id)) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el) { el.focus(); return; }
    }
  }, [data]);

  return { onFocus, onBlur };
}
