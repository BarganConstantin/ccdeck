// Escape closes the crash screen's Send report dialog, as its × says it does.
//
// Escape reaches a modal through modalStack.dismissTop(), and the one listener
// that calls it lives in use-deck-shortcuts.ts, under Inner — the tree the
// error boundary has just replaced. So on the crash pane the report dialog
// registered on the stack and nothing was listening: Escape did nothing while
// the × read "Close (Esc)". The pane now answers the key itself, for as long
// as its dialog is open.
//
// Run, not read, with React's part kept by hand: the boundary is made and its
// lifecycle called the way React calls it when Send report opens and closes
// the dialog, the dialog's place on the stack is taken the way
// useModalDismiss takes it, and the key is a real event on a real
// EventTarget standing in for window. The suite has no DOM to draw the pane
// in; the pane itself was checked in a browser.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ErrorBoundary from "../components/ErrorBoundary";
import { modalStack } from "../modal-dismiss";

type State = ErrorBoundary["state"];
const props = { children: null };
const crashed: State = { error: new Error("Cannot read properties of undefined (reading 'agents')"), componentStack: null, reportOpen: false };

let win: EventTarget;
let leave: Array<() => void> = [];

function press(key: string) {
  win.dispatchEvent(Object.assign(new Event("keydown"), { key }));
}

/** The boundary on its crash pane, moved from `from` to `to` as a setState would. */
function move(boundary: ErrorBoundary, from: State, to: State) {
  boundary.state = to;
  boundary.componentDidUpdate?.(props, from);
}

/** What useModalDismiss does when the dialog mounts: its place on the stack. */
function dialogOnStack() {
  const dismiss = vi.fn();
  leave.push(modalStack.push(dismiss));
  return dismiss;
}

beforeEach(() => {
  win = new EventTarget();
  vi.stubGlobal("window", win);
});

afterEach(() => {
  for (const pop of leave) pop();
  leave = [];
  vi.unstubAllGlobals();
});

describe("the crash pane's report dialog", () => {
  it("closes on Escape", () => {
    const boundary = new ErrorBoundary(props);
    move(boundary, crashed, { ...crashed, reportOpen: true });
    const dismiss = dialogOnStack();
    press("Escape");
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("leaves every other key alone", () => {
    const boundary = new ErrorBoundary(props);
    move(boundary, crashed, { ...crashed, reportOpen: true });
    const dismiss = dialogOnStack();
    press("Enter");
    press("a");
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("stops listening once the dialog is closed, and when the pane goes", () => {
    const boundary = new ErrorBoundary(props);
    const open = { ...crashed, reportOpen: true };
    move(boundary, crashed, open);
    move(boundary, open, crashed);
    const dismiss = dialogOnStack();
    press("Escape");
    expect(dismiss).not.toHaveBeenCalled();

    move(boundary, crashed, open);
    boundary.componentWillUnmount?.();
    press("Escape");
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("does not listen while the deck is running, where use-deck-shortcuts.ts answers Escape", () => {
    // One press, one owner: a second listener here would close two dialogs.
    const boundary = new ErrorBoundary(props);
    const running: State = { error: null, componentStack: null, reportOpen: false };
    move(boundary, running, running);
    const dismiss = dialogOnStack();
    press("Escape");
    expect(dismiss).not.toHaveBeenCalled();
  });
});
