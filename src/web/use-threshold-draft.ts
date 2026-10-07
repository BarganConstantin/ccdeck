// The auto-switch threshold as the accounts panel holds it: where the store
// has it, what the picker is proposing instead, and the press that stores the
// proposal and says `saved`.
//
// Lifted out of AccountsPanel.tsx unchanged. It is held by the panel and not
// by the policy row, because the row unmounts whenever the fold is shut and a
// pick nobody saved has to outlive that — a hook the panel calls keeps it at
// exactly that height. The row gets what to draw and the presses, and the
// draft stays here: the picker proposes through proposeThreshold, the custom
// field through typeThreshold, and every move either makes is editThreshold's
// (auto-switch-threshold.ts), which is pure.
import { type KeyboardEvent, useEffect, useReducer, useRef, useState } from "react";

import { commitThreshold, editThreshold, NO_DRAFT } from "./auto-switch-threshold";
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
  // (#516). A null pick follows whatever the store holds.
  const [draft, edit] = useReducer(editThreshold, NO_DRAFT);
  const [thresholdSaved, setThresholdSaved] = useState(false);
  // `save` only exists while there is a pick to store, so it leaves the panel
  // under the reader's focus: the press that stored the pick is the press that
  // unmounts it. The picker is where focus goes when that happens.
  const thresholdRef = useRef<HTMLSelectElement>(null);
  const thresholdSaveRef = useRef<HTMLButtonElement>(null);
  // The custom field takes the picker's place, so each is where focus goes
  // when the other leaves: into the field when `Custom…` is chosen, back to the
  // picker when the field closes from under the keyboard.
  const thresholdFieldRef = useRef<HTMLInputElement>(null);
  const refocusPicker = useRef(false);

  // Where auto-switch trips, as the store holds it. The live percentage it
  // races is the active row's own, one glance up the column — the policy row
  // no longer prints a second copy of it.
  const threshold = auto?.settings["autoswitch.threshold"]?.value ?? "90";
  // The percentage the picker is showing, or the custom field's text, which is
  // a proposal until it is saved.
  const thresholdPick = draft.pick ?? threshold;
  const thresholdCtl = thresholdCommit(thresholdPick, threshold);
  const thresholdCustom = draft.custom != null;
  const thresholdRefusal = draft.refusal;

  // Run on the field opening and closing, never on the row remounting, so a
  // fold opened over a field nobody finished does not take the keyboard.
  const wasCustom = useRef(thresholdCustom);
  useEffect(() => {
    if (wasCustom.current === thresholdCustom) return;
    wasCustom.current = thresholdCustom;
    if (thresholdCustom) {
      thresholdFieldRef.current?.focus();
      thresholdFieldRef.current?.select();
    } else if (refocusPicker.current) {
      thresholdRef.current?.focus();
    }
    refocusPicker.current = false;
  }, [thresholdCustom]);

  /** What the picker shows, as the reader picks it — or the field, for
   *  `Custom…`. A proposal: nothing is stored until `save` is pressed (#516). */
  const proposeThreshold = (pick: string) => edit({ kind: "pick", pick });
  /** The custom field's text, which is the proposal while it is open. */
  const typeThreshold = (text: string) => edit({ kind: "type", text });

  /** Escape, from the field or the `save` beside it: the picker comes back
   *  showing what it showed before `Custom…`, with the keyboard on it. Not
   *  during an IME composition, whose own Escape cancels the composition. */
  const cancelThreshold = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.nativeEvent.isComposing || !draft.custom) return;
    e.preventDefault();
    e.stopPropagation();
    refocusPicker.current = true;
    edit({ kind: "cancel" });
  };

  /** A field left with nothing in it to save closes itself — see the `leave`
   *  edit. */
  const leaveThreshold = () => edit({ kind: "leave", stored: threshold });

  /** The slot picker's rule (doSlot, in use-account-menu.ts) for the
   *  threshold: the picker proposes, `save` stores it. Enter in the custom
   *  field is the same press. */
  const doThreshold = async (pick: string, commit: PickerCommit) => {
    const outcome = await commitThreshold(pick, commit, post);
    if (outcome.kind === "refused") {
      edit({ kind: "refuse", message: outcome.message });
      return;
    }
    if (outcome.kind === "sent") {
      await load(true);
      if (!outcome.ok) return;
    }
    // Enter in the field is the press that closes it, and a focused field that
    // unmounts drops focus on <body>.
    refocusPicker.current = document.activeElement === thresholdFieldRef.current;
    edit({ kind: "settle" });
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

  return {
    threshold, thresholdPick, thresholdCtl, thresholdSaved, thresholdRef, thresholdSaveRef,
    thresholdCustom, thresholdRefusal, thresholdFieldRef,
    proposeThreshold, typeThreshold, cancelThreshold, leaveThreshold, doThreshold,
  };
}
