// The feedback dialog closed under a text selection and took the report with
// it. A click goes to the nearest element its press and its release share, so
// a drag that selects part of the message and is let go past the dialog's
// edge, over the scrim, arrives as a click whose target is the backdrop — the
// dialog's own stopPropagation is not on that path — and the backdrop closed
// on any click. The message, the contact and every screenshot were state in
// the dialog, and went with it.
//
// Only a press that starts on the scrim and ends there closes it now. Run on
// fake-react.ts's React: the backdrop's handlers are called with the targets
// the browser would hand them.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { mount, one, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("../components/use-modal-dismiss", async orig => ({
  ...(await orig<typeof import("../components/use-modal-dismiss")>()),
  useModalDismiss: () => ({ current: null }),
}));
// Built with forwardRef when it loads; the thanks is not what is under test.
vi.mock("../components/SuccessMark", () => ({ default: () => null }));

const { default: FeedbackDialog } = await import("../components/FeedbackDialog");

beforeEach(() => {
  // The facts the dialog asks for on open; never answered, which it allows.
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});
afterEach(() => { vi.unstubAllGlobals(); });

const scrim = (tree: unknown) => one(tree, el => el.props.className === "modal-backdrop") as Drawn;

/** Stand-ins for the nodes a press can land on: the scrim itself, and the
 *  message field inside the dialog. */
const SCRIM = { node: "scrim" };
const FIELD = { node: "message field" };

/** One mouse press, as the backdrop sees it: down on one node, up on
 *  another, and the click the browser then sends to the nearest node the two
 *  share — the scrim whenever either end was on it, since the dialog is
 *  inside it. Handlers the backdrop does not have are skipped. */
function press(tree: unknown, down: object, up: object) {
  const call = (name: string, target: object) =>
    (scrim(tree).props[name] as ((e: unknown) => void) | undefined)?.({
      target, currentTarget: SCRIM, stopPropagation() {}, preventDefault() {},
    });
  call("onPointerDown", down);
  call("onPointerUp", up);
  call("onClick", down === FIELD && up === FIELD ? FIELD : SCRIM);
}

describe("the feedback dialog's scrim", () => {
  it("stays open when a selection begun in the message is let go over the scrim", () => {
    const onClose = vi.fn();
    const view = mount(FeedbackDialog, { onClose });
    press(view.tree, FIELD, SCRIM);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stays open when a press begun on the scrim is let go inside the dialog", () => {
    // Moving off a control before letting go is how a press is taken back.
    const onClose = vi.fn();
    const view = mount(FeedbackDialog, { onClose });
    press(view.tree, SCRIM, FIELD);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on a press that starts and ends on the scrim", () => {
    const onClose = vi.fn();
    const view = mount(FeedbackDialog, { onClose });
    press(view.tree, SCRIM, SCRIM);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on the next scrim press after a selection that did not", () => {
    const onClose = vi.fn();
    const view = mount(FeedbackDialog, { onClose });
    press(view.tree, FIELD, SCRIM);
    press(view.tree, SCRIM, SCRIM);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
