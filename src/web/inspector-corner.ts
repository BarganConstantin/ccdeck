// When Workspace draws the folded Inspector's tab, and when its 320 sheet is
// the Inspector (V4's Figma). Pure, so the whole table can be read without a
// renderer; App.tsx feeds it the window's answers.

export interface InspectorPlace {
  /** Workspace is up, with the Command Panel on. */
  workspace: boolean;
  /** 1100 and wider: under it the list is a sheet and the Inspector is the
   *  detail sheet as it was, with no tab. A phone is never wide. */
  wide: boolean;
  /** 1320 and wider: the Inspector is a column. */
  column: boolean;
  /** Zoom is on or moving: the panels are folded away. */
  zoom: boolean;
}

/** From 1100 to 1319 in Workspace the Inspector is a sheet over the pane that
 *  starts folded. */
export function inspectorIsSheet(p: Pick<InspectorPlace, "workspace" | "wide" | "column">): boolean {
  return p.workspace && p.wide && !p.column;
}

/** The tab is drawn from 1100 up, in Workspace, never under Zoom: from 1320
 *  only after a fold, from 1100 to 1319 whenever the sheet is closed. Never on
 *  the Board, under 1100 or on a phone. */
export function inspectorTabShown(p: InspectorPlace & { folded: boolean; shown: boolean }): boolean {
  if (!p.workspace || !p.wide || p.zoom || p.shown) return false;
  return p.column ? p.folded : true;
}
