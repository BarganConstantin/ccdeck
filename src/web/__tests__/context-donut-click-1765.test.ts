// #1765: the context donut sits inside a card, and a click on it is a click on
// the card too unless it says otherwise. React Flow's node wrapper does not
// filter clicks that start on a button inside the node, so the donut's press
// also ran the canvas's node click: it selected the card, closed a detail panel
// open on another agent, animated the camera to the card behind the modal and
// turned auto-fit off. The recap pin in the same header stops the click for
// exactly this reason; the donut now does the same.
//
// The component is called as a function, which is all it is, and the button it
// returns is pressed through its own onClick with an event that records whether
// the press was stopped.
import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";
import { ContextDonut } from "../components/ContextModal";

interface ButtonProps { onClick?: (e: { stopPropagation: () => void }) => void }

describe("ContextDonut — its press opens the breakdown and nothing else", () => {
  it("stops the click before it reaches the card, and still opens the breakdown", () => {
    const open = vi.fn();
    const stopPropagation = vi.fn();
    const button = ContextDonut({ currentContextTokens: 50_000, modelId: "claude-sonnet-4-5", onClick: open }) as ReactElement<ButtonProps>;
    expect(button.type).toBe("button");
    button.props.onClick?.({ stopPropagation });
    expect(open).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalled();
  });

  it("stops the click even with no breakdown to open", () => {
    // A donut drawn without a handler is still inside the card; a press on it
    // is aimed at the donut, not at the card behind it.
    const stopPropagation = vi.fn();
    const button = ContextDonut({ currentContextTokens: 50_000, modelId: "claude-sonnet-4-5" }) as ReactElement<ButtonProps>;
    button.props.onClick?.({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalled();
  });
});
