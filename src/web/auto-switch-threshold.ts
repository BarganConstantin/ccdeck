// The auto-switch threshold picker's options.
//
// Lifted out of AccountsPanel.tsx unchanged. It was exported there and imported
// by nothing, so the one rule the picker has that is not a press — which values
// it can show — had no test, and the case it exists for, a store holding a
// number the picker does not offer, is one only a run can pin.

const THRESHOLDS = [70, 80, 85, 90, 95];

/** The threshold picker's options: the five, plus whatever the store holds if
 *  it is none of them — `cswap config set` takes any number, and a picker that
 *  cannot show the stored value shows its first option instead, which is a
 *  setting the loop is not using. */
export function thresholdChoices(stored: string): number[] {
  const n = Number(stored);
  const all = Number.isFinite(n) && n > 0 && !THRESHOLDS.includes(n) ? [...THRESHOLDS, n] : THRESHOLDS;
  return [...all].sort((a, b) => a - b);
}
