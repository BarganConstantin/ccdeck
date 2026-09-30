// #1748: in the network map, "the whole network" dropped keyboard focus to
// the page.
//
// The side panel keeps showing the last deck looked at after the ring loses
// focus, and its first control is `‹ the whole network`. Pressing it handed the
// panel back to the network as a whole, which swaps the deck's details for the
// network's — and the pressed button went with them. Nothing moved focus, so
// it fell to <body>, the next Tab was pulled back to the ×, and the reader had
// to walk back to the ring.
//
// The back button now puts focus on the ring button of the deck that was
// shown, which is the ring's own tab stop, and only then hands the panel back.
// The order matters: focusing a deck on the ring shows it in the panel, so the
// hand-back has to come after for the panel to end on the network.
//
// Read from the source because the suite has no DOM to mount the map in — the
// same way #1411 and #1540 pin where focus goes.
import { describe, expect, it } from "vitest";

import { sourceOf } from "./client-source";

const map = sourceOf("components/LanNetworkMap.tsx");
/** What the deck panel's back button calls, from its declaration to its end. */
const back = /const backToNetwork = \(\) => \{[\s\S]*?\n {2}\};/.exec(map)?.[0] ?? "";

describe("focus after leaving a deck's details in the network map (#1748)", () => {
  it("finds the back handler, so the cases below are about it", () => {
    expect(back).not.toBe("");
  });

  it("is what the deck panel's back button calls", () => {
    expect(map).toMatch(/onOpen=\{\(\) => onOpenDeck\(shownRow\.fp\)\} onBack=\{backToNetwork\} \/>/);
    expect(map).toMatch(/<button type="button" className="ap-lan-word nm-back" onClick=\{onBack\}>/);
  });

  it("focuses the shown deck's ring button, then hands the panel back", () => {
    const focus = back.indexOf("if (shownKey) nodeRefs.current.get(shownKey)?.focus();");
    const hand = back.indexOf("toNetwork();");
    expect(focus).toBeGreaterThan(-1);
    expect(hand).toBeGreaterThan(focus);
  });

  it("lands on a button that is the ring's tab stop once it has focus", () => {
    // Focusing a ring button moves the ring's cursor to it, so the deck focus
    // lands on is also the one Tab comes back to. The hold says which way it
    // came — the keyboard's arrives without the panel's entrance — and moves
    // the cursor either way.
    expect(map).toMatch(/onHold=\{via => \{ setCursorKey\(key\); hold\(key, via\); \}\}/);
    expect(map).toMatch(/onFocus=\{e => onHold\(e\.currentTarget\.matches\(":focus-visible"\) \? "keyboard" : "pointer"\)\}/);
  });
});
