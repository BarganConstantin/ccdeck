// Board or Workspace: which of the deck's two views of the same sessions is on
// screen, and the browser's memory of the choice.
//
// IN THE FIRST-LOAD CHUNK, SO NO STAGE CODE. This file and components/
// ViewSwitch.tsx are what the deck loads whether or not anyone ever turns the
// Command Panel on, so they import nothing of the stage (terminal-stage-lazy.
// test.ts walks the import graph). The stage tells App whether Workspace is on
// offer (the gate, below), and everything about the pane is use-stage.ts's.
//
// THE CHOICE IS THE BROWSER'S, NOT THE ACCOUNT'S (Figma: "Remembered per
// browser, not per account"). It is one string in localStorage under
// agent-dag.view, and deliberately in neither account-ui-fields.ts's
// UI_STORAGE_KEYS (a ccdeck account would carry it to its other machines) nor
// storage.ts's SHAPE_KEYS (it is a preference, not a shape a new build prunes).
// Another tab keeps its own view: it is read once, at load. A blocked store
// means the choice is not remembered, never that it cannot be made.
//
// THE GATE. Workspace exists only where the Command Panel does: the terminal
// switch is on and the deck's platform has the panel at all, and never on a
// phone, which is the Board alone (640px and under). `effectiveView` is what
// the layout follows; `stored` is what the reader chose, and it survives a
// gate that is off for now.
import { useCallback, useState } from "react";
import { readStored, writeStored } from "./storage";

export type View = "board" | "workspace";

export const VIEW_KEY = "agent-dag.view";

/** The remembered view. Anything but "workspace" reads as the Board. */
export function readView(read: (key: string) => string | null = readStored): View {
  return read(VIEW_KEY) === "workspace" ? "workspace" : "board";
}

export function writeView(view: View, write: (key: string, value: string) => void = writeStored): void {
  write(VIEW_KEY, view);
}

/** Whether Workspace is on offer: the Command Panel's gate, off a phone. While
 *  the deck has not said whether its platform has the panel (`supported` is
 *  null) it is on offer, as the switch in Settings is: only a platform the deck
 *  says has none (`false`) refuses it. */
export function workspaceOffered(gate: { enabled: boolean; supported: boolean | null }, phone: boolean): boolean {
  return gate.enabled && gate.supported !== false && !phone;
}

/** The view the layout follows: the stored one where Workspace is on offer,
 *  else the Board. The stored value is left as it is. */
export function effectiveView(stored: View, offered: boolean): View {
  return offered ? stored : "board";
}

export interface ViewState {
  /** What the reader chose, whether or not Workspace is on offer now. */
  stored: View;
  set(view: View): void;
}

/**
 * The reader's view, read once at load and written on each change. What the
 * layout follows is `stored` only where Workspace is on offer, which is the
 * stage hook's to say (use-stage.ts: it holds the gate, and holds a Workspace
 * tab's layout until the deck has answered, so a reload does not flash the
 * Board first).
 */
export function useView(): ViewState {
  const [stored, setStored] = useState<View>(() => readView());
  const set = useCallback((next: View) => {
    setStored(next);
    writeView(next);
  }, []);
  return { stored, set };
}
