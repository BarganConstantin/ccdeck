// The Workspace pane as a landmark the skip link can reach.
//
// The Board's skip link points at <main id="canvas">; in Workspace the canvas is
// mounted but out of sight (workspace.css), so a link to it lands on nothing.
// There the link reads "Skip to the pane" and moves the focus to the pane's
// own element: the stage's root, which carries this id and a negative tabIndex
// only while it is the Workspace pane (TerminalStage.tsx). Nothing here reaches
// stage code, so App can import it in the first-load chunk.

/** The id the Workspace pane's element carries. */
export const WORKSPACE_PANE_ID = "workspace-pane";

/** What the skip link says. */
export const SKIP_TO_PANE = "Skip to the pane";

/**
 * Moves the focus to the pane. True when there was a pane to focus, so the
 * caller may cancel the link's own jump to the fragment; false leaves the
 * link to do what a link does. Never the canvas: it is not on screen.
 */
export function skipToPane(find: (id: string) => HTMLElement | null = id => document.getElementById(id)): boolean {
  const pane = find(WORKSPACE_PANE_ID);
  if (!pane) return false;
  pane.focus({ preventScroll: true });
  return true;
}
