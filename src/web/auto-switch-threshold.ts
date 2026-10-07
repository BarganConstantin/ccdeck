// The auto-switch threshold picker's options, its custom value, and what a
// press of `save` may send.
//
// Lifted out of AccountsPanel.tsx unchanged. It was exported there and imported
// by nothing, so the one rule the picker has that is not a press — which values
// it can show — had no test, and the case it exists for, a store holding a
// number the picker does not offer, is one only a run can pin.
//
// The picker's last option is `Custom…`, which puts a number field in its
// place. Everything that decides what the field does lives here rather than in
// the hook or the row, for the reason picker-commit.ts gives: the suite is plain
// node with no DOM, so a rule that only exists inside JSX is a rule nothing can
// check.
import { type PickerCommit } from "./picker-commit";

const THRESHOLDS = [70, 80, 85, 90, 95];

/** The picker's value for its `Custom…` option. Never a threshold, and never
 *  what the picker shows: choosing it opens the field instead of proposing. */
export const CUSTOM_PICK = "custom";

/** What the custom field accepts: whole percentages, both ends included. The
 *  server takes 50 to 99.9 (cswap-auto.mjs SETTINGS) and stays the rule; the
 *  page asks for less, because a tenth of a percent is not a decision anybody
 *  makes about a limit, and `inputMode="numeric"` has no decimal key to type
 *  one with. A value set to a tenth from the terminal is still shown. */
export const CUSTOM_MIN = 50;
export const CUSTOM_MAX = 99;

/** What the field says under itself while it is open and nothing is wrong. It
 *  names the unit, because the field's `%` is drawn for the eye and hidden from
 *  a screen reader, which hears this as the field's description. */
export const CUSTOM_HINT = `A whole percent from ${CUSTOM_MIN} to ${CUSTOM_MAX}.`;

/** The threshold picker's options: the five, plus whatever the store holds if
 *  it is none of them — `cswap config set` takes any number, and a picker that
 *  cannot show the stored value shows its first option instead, which is a
 *  setting the loop is not using. */
export function thresholdChoices(stored: string): number[] {
  const n = Number(stored);
  const all = Number.isFinite(n) && n > 0 && !THRESHOLDS.includes(n) ? [...THRESHOLDS, n] : THRESHOLDS;
  return [...all].sort((a, b) => a - b);
}

export type ThresholdCheck =
  | { ok: true; value: string }
  | { ok: false; reason: "empty" | "not_a_number" | "not_whole" | "too_low" | "too_high"; message: string };

/**
 * Whether the page may send this pick, and the number it sends if so.
 *
 * Every pick goes through it, the five included, so nothing the page can type
 * or choose reaches the route outside CUSTOM_MIN to CUSTOM_MAX. A trailing `%`
 * is allowed, since the field draws one, and leading zeros are dropped.
 */
export function checkThreshold(text: string): ThresholdCheck {
  const typed = text.trim().replace(/\s*%$/, "");
  if (typed === "") return { ok: false, reason: "empty", message: `Enter a number from ${CUSTOM_MIN} to ${CUSTOM_MAX}.` };
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(typed)) {
    return { ok: false, reason: "not_a_number", message: `Enter a number from ${CUSTOM_MIN} to ${CUSTOM_MAX}.` };
  }
  const n = Number(typed);
  if (!Number.isInteger(n)) return { ok: false, reason: "not_whole", message: `Use a whole number from ${CUSTOM_MIN} to ${CUSTOM_MAX}.` };
  if (n < CUSTOM_MIN) return { ok: false, reason: "too_low", message: `The lowest is ${CUSTOM_MIN}%.` };
  if (n > CUSTOM_MAX) return { ok: false, reason: "too_high", message: `The highest is ${CUSTOM_MAX}%.` };
  return { ok: true, value: String(n) };
}

/** The threshold the panel holds instead of the store's, until it is saved. */
export interface ThresholdDraft {
  /** What the picker proposes: one of its options, or the custom field's text.
   *  Null follows the store. */
  pick: string | null;
  /** Set while the custom field stands in for the picker. `from` is the
   *  proposal it goes back to on Escape. */
  custom: { from: string | null } | null;
  /** Why the field's last commit was refused, said under it until the text
   *  changes. */
  refusal: string | null;
}

export const NO_DRAFT: ThresholdDraft = { pick: null, custom: null, refusal: null };

export type ThresholdEdit =
  /** The picker's change: an option, or `Custom…`. */
  | { kind: "pick"; pick: string }
  /** The custom field's change. */
  | { kind: "type"; text: string }
  /** Escape: back to the picker, showing what it showed before. */
  | { kind: "cancel" }
  /** A commit the page would not send. */
  | { kind: "refuse"; message: string }
  /** Back to following the store: a commit that landed or had nothing to send. */
  | { kind: "settle" }
  /** The field losing focus. It closes when it holds nothing to save, which is
   *  the way back to the picker for a pointer or a touch that has no Escape;
   *  one with a change in it stays, the way a picked option does. Decided on
   *  the draft as it is when the edit lands, so a blur that arrives after
   *  Escape has already closed the field changes nothing. */
  | { kind: "leave"; stored: string };

/** The draft after one edit. Pure, so every move the field makes is a call. */
export function editThreshold(draft: ThresholdDraft, edit: ThresholdEdit): ThresholdDraft {
  switch (edit.kind) {
    case "pick":
      return edit.pick === CUSTOM_PICK
        ? { ...draft, custom: { from: draft.pick }, refusal: null }
        : { pick: edit.pick, custom: null, refusal: null };
    case "type":
      return { ...draft, pick: edit.text, refusal: null };
    case "cancel":
      return draft.custom ? { pick: draft.custom.from, custom: null, refusal: null } : draft;
    case "refuse":
      return { ...draft, refusal: edit.message };
    case "settle":
      return NO_DRAFT;
    case "leave":
      return draft.custom && (draft.pick ?? edit.stored) === edit.stored ? NO_DRAFT : draft;
  }
}

export type ThresholdOutcome =
  | { kind: "refused"; message: string }
  | { kind: "unchanged" }
  | { kind: "sent"; ok: boolean };

/**
 * What `save` does with the pick before the panel hears about it: refuses one
 * the page will not send, skips the round trip for one the store already holds,
 * and sends anything else as the number checkThreshold made of it. The one
 * place the threshold is written from, for the picker and the field alike.
 */
export async function commitThreshold(
  pick: string,
  commit: PickerCommit,
  post: (body: Record<string, unknown>, tag: string) => Promise<{ ok?: boolean } | null>,
): Promise<ThresholdOutcome> {
  if (!commit.sends) return { kind: "unchanged" };
  const checked = checkThreshold(pick);
  if (!checked.ok) return { kind: "refused", message: checked.message };
  const out = await post({ action: "setting", key: "autoswitch.threshold", value: checked.value }, "threshold");
  return { kind: "sent", ok: out?.ok === true };
}
