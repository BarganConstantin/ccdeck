// #516: a `<select>` fires `change` on a keystroke, and a keystroke is not a
// decision.
//
// Both pickers in the accounts panel posted straight out of their onChange.
// The value of a focused, closed `<select>` moves on any key that matches an
// option, and every option in the slot picker begins with the same word —
// `slot 2 · swap`, `slot 3 · free`, built by slotChoices — so type-ahead
// matched on a single `s`. Driven through CDP against the panel: focus the slot
// picker, press `s` once, and the panel sent
// `POST /api/claude-accounts/admin {action:"move",account:2,slot:3}`. Slot 3
// was occupied. The threshold picker had the same shape with a setting write on
// the other end: `8` then `7`, two writes.
//
// The slot case is the one that hurts, and account-move.ts opens with the
// reason. A move into an OCCUPIED slot is a swap, not a relocation: two
// accounts trade places, and the second one is an account the user never
// pointed at. slotChoices names the options `· swap` and `· free` precisely so
// that consequence is readable BEFORE the choice is made. A keystroke skips the
// reading entirely — and there is no confirmation and no undo, while `remove`,
// the block's other irreversible action, costs two clicks and arms with a
// countdown.
//
// So neither picker sends anything any more. Each one proposes; a control
// beside it commits. That is the shape the alias field in the same block has
// always had — a field paired with `save` — and it is one answer rather than
// two, which is what the report asked for. Confirming only the destructive half
// was the alternative and it fails on both counts: a pick that lands on a FREE
// slot still relocates an account from one keystroke, and there is no
// destructive half of a threshold to arm, so the panel would have ended with
// one rule for the slot and another for the setting.
//
// What is left is what the commit control has to say, and that is a function of
// the choice alone: the word on the button, whether pressing it needs the
// server at all, and — the part worth having a name for — whether what it sends
// moves a SECOND thing. It lives out here rather than inside the onChange it
// replaces for the reason account-move.ts gives for the same move: the suite is
// plain node with no DOM, so a rule that only exists inside JSX is a rule
// nothing can check.
import type { SlotChoice } from "./account-move";

/** What a picker's commit control reads, and what pressing it does. */
export interface PickerCommit {
  /** The word on the control, which is the verb of what pressing it does. */
  label: string;
  /** What it reads for the moment after a press, the way `save` reads `saved`. */
  done: string;
  /** Whether pressing it has to reach the server. False when the pick is
   *  already what the store holds, which is not a failure and not worth a round
   *  trip — the same call aliasSave makes for an unchanged alias. */
  sends: boolean;
  /** Whether what it sends moves a second thing the user did not point at.
   *  This is the destructive half of the question, and it is decided by the
   *  choice and nothing else. */
  swaps: boolean;
  /** The hover sentence. It states the consequence a second time, at the moment
   *  of committing rather than only in the list of options. */
  title: string;
}

/**
 * The slot the picker should be showing: the pending pick while it is still one
 * of the choices, and the account's own slot otherwise.
 *
 * A pick now outlives a poll — that is the whole point of holding it — and the
 * roster reloads every fifteen seconds, so an account removed from another
 * terminal takes its slot out of the list underneath a draft pointing at it. A
 * `<select>` whose value matches no option renders its FIRST one, which would
 * leave the number on screen and the number the commit control was built from
 * disagreeing: the same class of defect this file exists to close.
 */
export function slotShowing(choices: SlotChoice[], draft: number | null, current: number): number {
  return draft != null && choices.some(c => c.slot === draft) ? draft : current;
}

/**
 * The slot picker's commit control, for the slot showing in it.
 *
 * `picked` is what the select is displaying and `current` is where the account
 * actually is; they are equal when the block opens, which is the resting state
 * and the one press that has nothing to send. The kinds come from slotChoices,
 * so the button and the option it commits are reading the same answer — the
 * button says `swap` exactly when the option said `· swap`.
 */
export function slotCommit(choices: SlotChoice[], picked: number, current: number): PickerCommit {
  // A pick that is not in the list at all is the account's own slot as far as
  // this is concerned: there is nowhere to send it, so the control does not.
  const kind = choices.find(c => c.slot === picked)?.kind ?? "here";

  if (kind === "swap") {
    return {
      label: "swap",
      done: "swapped",
      sends: true,
      swaps: true,
      title: `Send this account to slot ${picked}. That slot is taken, so the two accounts trade places `
           + `and the one standing there moves to slot ${current}.`,
    };
  }

  if (kind === "free") {
    return {
      label: "move",
      done: "moved",
      sends: true,
      swaps: false,
      title: `Send this account to slot ${picked}. That slot is empty, so no other account moves.`,
    };
  }

  return {
    label: "move",
    done: "here",
    sends: false,
    swaps: false,
    title: `This account already holds slot ${current}.`,
  };
}

/**
 * The auto-switch threshold's commit control, for the percentage showing in it.
 *
 * Nothing here is destructive — it writes one setting and the next write
 * replaces it — so `swaps` is false for every choice. The control exists for
 * the other half of the same defect: a picker that acted on `change` wrote a
 * setting per keystroke. `save` and `saved` are the words the alias field
 * already uses for a stored value, and this is one.
 */
export function thresholdCommit(picked: string, stored: string): PickerCommit {
  return {
    label: "save",
    done: "saved",
    sends: picked !== stored,
    swaps: false,
    title: `Switch the active account out once it passes ${picked}% of its limit.`,
  };
}
