// Enter on Bug, Idea or Other sent the report. The kinds are native radios
// inside the form, and a browser submits a form implicitly on Enter in a
// radio, so picking a kind with the arrows and pressing Enter to settle on it
// posted the message there and then, before a screenshot or a contact could
// be added. Send and the shortcut are the only two ways a report leaves; the
// contact field already kept its bare Enter for that reason, and the kinds now
// do the same.
//
// FeedbackKinds has no hooks, so it is called as it is and its radios' key
// handlers are pressed with the keystrokes a browser would hand them.
import { describe, expect, it, vi } from "vitest";

import { all, type Drawn } from "./fake-react";
import FeedbackKinds from "../components/FeedbackKinds";
import { KINDS, type EnterKey } from "../feedback";

const radios = () => all(FeedbackKinds({ kind: "bug", onChange: () => {} }), el => el.type === "input" && el.props.type === "radio");

const key = (over: Partial<EnterKey> = {}): EnterKey =>
  ({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

/** Presses `k` on `radio`; answers whether the browser's own answer — the
 *  implicit submit — was stopped. */
function press(radio: Drawn, k: EnterKey): boolean {
  const preventDefault = vi.fn();
  (radio.props.onKeyDown as ((e: unknown) => void) | undefined)?.({ ...k, nativeEvent: k, preventDefault });
  return preventDefault.mock.calls.length > 0;
}

describe("Enter on a kind of feedback", () => {
  it("draws one radio per kind", () => {
    expect(radios().map(r => r.props.value)).toEqual(KINDS.map(k => k.value));
  });

  it("does not send the report from any of them", () => {
    for (const radio of radios()) expect(press(radio, key()), String(radio.props.value)).toBe(true);
  });

  it("leaves the send shortcut to the form, and an input method's Enter alone", () => {
    for (const radio of radios()) {
      expect(press(radio, key({ ctrlKey: true }))).toBe(false);
      expect(press(radio, key({ metaKey: true }))).toBe(false);
      expect(press(radio, key({ isComposing: true }))).toBe(false);
      expect(press(radio, key({ key: "ArrowRight" }))).toBe(false);
    }
  });
});
