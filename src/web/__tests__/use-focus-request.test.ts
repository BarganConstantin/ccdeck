// The stage's request for the keys (use-focus-request.ts): met the moment the
// pane can take them, and dropped when the stage moves to another session
// before it could be — an Enter meant for nothing must not land in the next
// agent's prompt.
import { describe, expect, it, vi } from "vitest";
import { useFocusRequest, type FocusRequest } from "../components/terminal/use-focus-request";
import { mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

function Harness(p: FocusRequest) {
  useFocusRequest(p);
  return null;
}

function rig(first: Partial<FocusRequest> = {}) {
  const focus = vi.fn();
  let props: FocusRequest = { key: "session:a", request: null, launch: false, typing: false, focus, ...first };
  const view = mount(Harness, props);
  const go = (next: Partial<FocusRequest>) => { props = { ...props, ...next }; view.rerender(props); };
  return { focus, go };
}

describe("a request for the keys", () => {
  it("is met at once on a pane that takes keys, and only once", () => {
    const { focus, go } = rig({ typing: true });
    go({ request: 1 });
    expect(focus).toHaveBeenCalledTimes(1);
    go({});
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("waits for the pane when there is none yet", () => {
    const { focus, go } = rig();
    go({ request: 1 });
    expect(focus).not.toHaveBeenCalled();
    go({ typing: true });
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("is dropped when the stage moves to another session before it could be met", () => {
    // The asks run lands on a card (started outside the deck), then j moves
    // the stage to a live deck session: the keys stay on the board.
    const { focus, go } = rig();
    go({ request: 1 });
    go({ key: "session:b", typing: true });
    expect(focus).not.toHaveBeenCalled();
  });

  it("is kept when the move brings it along, as the asks run and Enter on a tile do", () => {
    const { focus, go } = rig();
    go({ key: "session:b", request: 2, typing: true });
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("is made by a launch on its own, whose welcome screen waits for a prompt", () => {
    const { focus, go } = rig();
    go({ key: "launch:n1", launch: true });
    go({ typing: true });
    expect(focus).toHaveBeenCalledTimes(1);
  });
});

describe("a request the stage answers with a card", () => {
  it("is met by landing on the card's action, once", () => {
    const land = vi.fn(() => true);
    const { focus, go } = rig({ settled: true, land });
    go({ request: 1 });
    expect(land).toHaveBeenCalledTimes(1);
    expect(focus, "no pane to put the keys in").not.toHaveBeenCalled();
    go({});
    expect(land).toHaveBeenCalledTimes(1);
  });

  it("waits through a pane on its way, and lands when the card arrives instead", () => {
    const land = vi.fn(() => true);
    const { go } = rig({ land });
    go({ request: 1 });
    expect(land, "attaching: the pane may still come").not.toHaveBeenCalled();
    go({ settled: true });
    expect(land).toHaveBeenCalledTimes(1);
  });

  it("asks again while the card has nothing drawn to land on yet", () => {
    let drawn = false;
    const land = vi.fn(() => drawn);
    const { go } = rig({ settled: true, land });
    go({ request: 1 });
    drawn = true;
    go({});
    go({});
    expect(land).toHaveBeenCalledTimes(2);
  });

  it("puts the keys in the pane, not on a card, when the pane can take them", () => {
    const land = vi.fn(() => true);
    const { focus, go } = rig({ settled: true, land, typing: true });
    go({ request: 1 });
    expect(focus).toHaveBeenCalledTimes(1);
    expect(land).not.toHaveBeenCalled();
  });
});
