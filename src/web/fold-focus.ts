// Where the keyboard goes when the Inspector folds in the Workspace: to the
// pane, never the page. Its terminal, or else its first control, or else the
// session's row in the rail.
//
// A terminal under a state card is in the tree but takes no focus, so being
// found is not enough: each one is focused and checked, and the first that
// keeps the focus ends the walk.

/** The places to try, in order. */
export const FOLD_FOCUS_SELECTORS = [
  ".stage-dock .xterm-helper-textarea",
  ".stage-dock button:not(:disabled)",
  ".sl-row[aria-current=\"true\"]",
] as const;

/** The two things the walk reads from the document. */
type FocusRoot = {
  querySelector(selector: string): Element | null;
  readonly activeElement: Element | null;
};

/** Focuses the first of `selectors` that keeps the focus, and returns it; null
 *  when none does. */
export function focusFirstTaking(
  root: FocusRoot,
  selectors: readonly string[] = FOLD_FOCUS_SELECTORS,
): HTMLElement | null {
  for (const selector of selectors) {
    const el = root.querySelector(selector) as HTMLElement | null;
    if (!el) continue;
    el.focus();
    if (root.activeElement === el) return el;
  }
  return null;
}

/** Where the keyboard goes when the folded Inspector's tab is all there is to
 *  take it: the tab's one button. */
export const INSPECTOR_TAB_BUTTON = ".insp-corner button";

/** After a fold: the pane (above), or else the tab's button, so the keyboard
 *  is never left on nothing. */
export function focusAfterFold(root: FocusRoot): HTMLElement | null {
  const pane = focusFirstTaking(root);
  if (pane) return pane;
  const tab = root.querySelector(INSPECTOR_TAB_BUTTON) as HTMLElement | null;
  if (!tab) return null;
  tab.focus();
  return root.activeElement === tab ? tab : null;
}
