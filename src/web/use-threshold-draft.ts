// The auto-switch threshold as the accounts panel holds it: where the store
// has it, what the picker is proposing instead, and the press that stores the
// proposal and says `saved`.
//
// Lifted out of AccountsPanel.tsx unchanged. It is held by the panel and not
// by the policy row, because the row unmounts whenever the fold is shut and a
// pick nobody saved has to outlive that — a hook the panel calls keeps it at
// exactly that height. The row gets what to draw and the two presses.
import { useRef, useState } from "react";

import { type AutoStatus } from "./claude-accounts";
import { type PickerCommit, thresholdCommit } from "./picker-commit";

// How long the threshold's `save` stands as `saved`. The panel's other
// transient confirmation — `copied` on a share — uses the same 1.8s, and the
// word is the whole signal.
const SAVED_MS = 1_800;

export interface ThresholdDraftDeps {
  /** The auto-switch status as last read — see use-account-roster.ts. */
  auto: AutoStatus | null;
  /** The auto-switch POST — see use-account-switching.ts. */
  post: (body: Record<string, unknown>, tag: string) => Promise<{ ok?: boolean } | null>;
  /** Read the roster again, the way the header's ↻ does. */
  load: (force?: boolean) => Promise<void>;
}

export function useThresholdDraft({ auto, post, load }: ThresholdDraftDeps) {
  // The same split for the auto-switch threshold as the slot picker's in
  // use-account-menu.ts — the picker proposes, the button under it commits —
  // because it had the same defect with a setting write on the other end
  // (#516). Null follows whatever the store holds.
  const [thresholdDraft, setThresholdDraft] = useState<string | null>(null);
  const [thresholdSaved, setThresholdSaved] = useState(false);
  // `save` only exists while there is a pick to store, so it leaves the panel
  // under the reader's focus: the press that stored the pick is the press that
  // unmounts it. The picker is where focus goes when that happens.
  const thresholdRef = useRef<HTMLSelectElement>(null);
  const thresholdSaveRef = useRef<HTMLButtonElement>(null);

  // Where auto-switch trips, as the store holds it. The live percentage it
  // races is the active row's own, one glance up the column — the policy row
  // no longer prints a second copy of it.
  const threshold = auto?.settings["autoswitch.threshold"]?.value ?? "90";
  // The percentage the picker is showing, which is a proposal until it is
  // saved.
  const thresholdPick = thresholdDraft ?? threshold;
  const thresholdCtl = thresholdCommit(thresholdPick, threshold);

  /** The slot picker's rule (doSlot, in use-account-menu.ts) for the
   *  threshold: the picker proposes, `save` stores it. */
  const doThreshold = async (pick: string, commit: PickerCommit) => {
    if (commit.sends) {
      const out = await post({ action: "setting", key: "autoswitch.threshold", value: pick }, "threshold");
      await load(true);
      if (!out?.ok) return;
      setThresholdDraft(null);
    }
    setThresholdSaved(true);
    window.setTimeout(() => {
      // `saved` is the last thing the control says before it goes. A focused
      // button that unmounts drops focus on <body>, so hand it to the picker
      // first — only if it is still there, never out from under a reader who
      // has moved on.
      if (document.activeElement === thresholdSaveRef.current) thresholdRef.current?.focus();
      setThresholdSaved(false);
    }, SAVED_MS);
  };

  return { threshold, thresholdPick, thresholdCtl, thresholdSaved, thresholdRef, thresholdSaveRef, setThresholdDraft, doThreshold };
}
