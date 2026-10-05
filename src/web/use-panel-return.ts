// Where keyboard focus goes when a docked panel is closed with its own control.
//
// Usage, This machine, Claude accounts, the detail panel and the session list
// each close with a × (the list with a ‹) that leaves with the panel. Pressed
// from the keyboard, it left focus on <body>: the next Tab began again at "Skip
// to the canvas", and a screen reader said nothing. The rule is panel-press.ts's
// (#518), kept through useFocusRescue (#1762): a control the update takes away
// hands focus to the nearest thing that outlived it. For a panel that is the
// topbar button that opens it; for the detail panel, the card it was about,
// which stays selected, or the canvas when that card is not drawn.
//
// Only a press made from the keyboard is followed. A mouse user's focus falling
// to <body> is where #851 wants it: left on the topbar button, it would keep
// Space for that button, and the next Space would open the panel again instead
// of pausing the stream. The browser already tells the two apart — it draws a
// ring on the pressed control for the keyboard only, and re-decides that on
// the keystroke itself (canvas-pointer-focus.test.ts).
import { useRef, type RefObject } from "react";
import { focusCanvasNode } from "./canvas-node-element";
import { useFocusRescue } from "./components/use-focus-rescue";
import { focusDropped } from "./panel-press";

/** The topbar buttons the four toggled panels open from. */
export interface PanelToggles {
  sessionList: RefObject<HTMLButtonElement>;
  usage: RefObject<HTMLButtonElement>;
  accounts: RefObject<HTMLButtonElement>;
  machine: RefObject<HTMLButtonElement>;
}

/** Whether the control being pressed was reached and pressed by keyboard. */
function keyboardPress(): boolean {
  return document.activeElement?.matches?.(":focus-visible") === true;
}

export function usePanelReturn({
  sessionListShown, usageShown, machineShown, accountsShown, detailShown, primarySelectedId, canvasRef,
}: {
  /** Whether each panel is in the DOM — a panel that animates out is still. */
  sessionListShown: boolean;
  usageShown: boolean;
  machineShown: boolean;
  accountsShown: boolean;
  detailShown: boolean;
  primarySelectedId: string | null;
  canvasRef: RefObject<HTMLElement | null>;
}) {
  const toggles: PanelToggles = {
    sessionList: useRef<HTMLButtonElement>(null),
    usage: useRef<HTMLButtonElement>(null),
    accounts: useRef<HTMLButtonElement>(null),
    machine: useRef<HTMLButtonElement>(null),
  };
  const keyed = (arm: () => void) => () => { if (keyboardPress()) arm(); };
  return {
    toggles,
    sessionList: keyed(useFocusRescue(!sessionListShown, toggles.sessionList)),
    usage: keyed(useFocusRescue(!usageShown, toggles.usage)),
    machine: keyed(useFocusRescue(!machineShown, toggles.machine)),
    accounts: keyed(useFocusRescue(!accountsShown, toggles.accounts)),
    detail: keyed(useFocusRescue(!detailShown, () => {
      if (primarySelectedId) focusCanvasNode(primarySelectedId);
      if (focusDropped(document.activeElement?.tagName ?? null)) canvasRef.current?.focus({ preventScroll: true });
    })),
  };
}
