// Board | Workspace: the topbar's switch between the deck's two views of the
// same sessions (V4 Workspace, "Top bar"). A capsule of two buttons on the
// Inspector's tabs pill (detail-panel.css): a --bg-soft track, the chosen view
// a --panel chip on it, 24px tall, a 14px glyph and a 12px label each.
//
// FIRST-LOAD, NO STAGE CODE (see use-view.ts). It is drawn only where
// Workspace is on offer, so with the Command Panel off, or on a phone, the bar
// is the bar it was. Two buttons with aria-pressed rather than a tablist: it
// changes what fills the page, not what a panel under it shows, and Tab walks
// both buttons as it does the Inspector's tabs' siblings.
//
// HOW IT WAS PRESSED decides its motion (workspace.css): a click crossfades the
// middle of the deck; Enter or Space on the focused button, like the chord,
// switches at once. A click's `detail` is its count, 0 for a key.
import type { MouseEvent } from "react";
import type { View } from "../use-view";
import { KitIcon } from "./kit-icons";

export const VIEW_SWITCH_LABEL = "View";
export const BOARD_LABEL = "Board";
export const WORKSPACE_LABEL = "Workspace";

/** The Board. */
const BoardGlyph = () => <KitIcon name="board" className="glyph" />;

/** The Workspace: the list, the pane and the Inspector side by side. */
const WorkspaceGlyph = () => <KitIcon name="workspace" className="glyph" />;

export interface ViewSwitchProps {
  view: View;
  /** `pointer` for a click, `key` for Enter or Space on the button. */
  onChange(view: View, how: "pointer" | "key"): void;
}

export default function ViewSwitch({ view, onChange }: ViewSwitchProps) {
  const press = (next: View) => (e: MouseEvent) => {
    if (next !== view) onChange(next, e.detail === 0 ? "key" : "pointer");
  };
  return (
    <div className="view-switch" role="group" aria-label={VIEW_SWITCH_LABEL}>
      <button type="button" className="view-opt" aria-pressed={view === "board"} onClick={press("board")}>
        <BoardGlyph />{BOARD_LABEL}
      </button>
      <button type="button" className="view-opt" aria-pressed={view === "workspace"} onClick={press("workspace")}>
        <WorkspaceGlyph />{WORKSPACE_LABEL}
      </button>
    </div>
  );
}
