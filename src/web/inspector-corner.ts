// When Workspace's 320 sheet is the Inspector (V4's Figma). Pure, so the table
// can be read without a renderer; App.tsx feeds it the window's answers. The
// Inspector's door on the right stripe (rail-items.tsx) is what shows and hides
// it; there is no tab of its own.

/** The id of the Inspector's region (its <aside>), the door's aria-controls
 *  while it is mounted. */
export const INSPECTOR_REGION_ID = "inspector";

export interface InspectorPlace {
  /** Workspace is up, with the Command Panel on. */
  workspace: boolean;
  /** 1100 and wider: under it the list is a sheet and the Inspector is the
   *  detail sheet as it was. A phone is never wide. */
  wide: boolean;
  /** 1320 and wider: the Inspector is a column. */
  column: boolean;
}

/** From 1100 to 1319 in Workspace the Inspector is a sheet over the pane that
 *  starts folded. */
export function inspectorIsSheet(p: InspectorPlace): boolean {
  return p.workspace && p.wide && !p.column;
}

/** Whether the Inspector shows, so its door reads Open: the column in Workspace
 *  from 1320 until it is folded, or the detail panel / sheet while a session's
 *  Inspector is up (`shown`); never under Zoom, which folds the panels away. */
export function inspectorDoorOpen(p: { workspace: boolean; column: boolean; folded: boolean; shown: boolean; zoomed: boolean }): boolean {
  if (p.zoomed) return false;
  return p.shown || (p.workspace && p.column && !p.folded);
}

/** What a press of the door does. In Workspace, as a column or the 1100 to
 *  1319 sheet, it folds the Inspector while it shows and gives it back while it
 *  is folded ("fold" / "show"); on the Board and under 1100 it is exactly D
 *  ("d"): toggle the selection's panel, or with none pick a session for it. */
export function inspectorDoorPress(p: { workspace: boolean; column: boolean; sheet: boolean; open: boolean }): "fold" | "show" | "d" {
  if (!(p.workspace && (p.column || p.sheet))) return "d";
  return p.open ? "fold" : "show";
}
