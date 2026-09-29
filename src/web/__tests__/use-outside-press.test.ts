// The outside-press rule both popovers dismiss by.
//
// SoundMenu and AnchoredPopover each wrote the same pointerdown listener out:
// on window, in the capture phase, ignoring presses inside the popover and on
// the control that opened it. It is use-outside-press.ts once now. The decision
// is pressIsOutside, run here against stand-ins for the two elements; the
// listener and its two callers are read as source, because a hook's effect
// does not run under this suite's renderer.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withoutComments } from "./tsx-scan";
import { pressIsOutside } from "../components/use-outside-press";

const read = (rel: string) => withoutComments(readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8"));

/** An element that contains exactly the nodes it is given. */
const holding = (...nodes: object[]) => ({ contains: (n: Node | null) => nodes.includes(n as object) });

describe("pressIsOutside", () => {
  const inPopover = {} as Node;
  const onOpener = {} as Node;
  const elsewhere = {} as Node;
  const popover = holding(inPopover);
  const opener = holding(onOpener);

  it("is true for a press that lands on neither the popover nor its opener", () => {
    expect(pressIsOutside(elsewhere, popover, opener)).toBe(true);
  });

  it("is false inside the popover, and on the opener, whose own click toggles", () => {
    expect(pressIsOutside(inPopover, popover, opener)).toBe(false);
    expect(pressIsOutside(onOpener, popover, opener)).toBe(false);
  });

  it("is false for a press with no target", () => {
    expect(pressIsOutside(null, popover, opener)).toBe(false);
  });

  it("still dismisses when the popover or the opener is not in the page", () => {
    // An anchor looked up by id can be gone for a render; the press that lands
    // meanwhile is outside whatever is left.
    expect(pressIsOutside(elsewhere, null, opener)).toBe(true);
    expect(pressIsOutside(elsewhere, popover, null)).toBe(true);
    expect(pressIsOutside(onOpener, popover, undefined)).toBe(true);
  });
});

describe("the listener, and the two popovers that use it", () => {
  const hook = read("components/use-outside-press.ts");

  it("listens for pointerdown on window, in the capture phase, and removes the same one", () => {
    expect(hook).toMatch(/window\.addEventListener\("pointerdown", onDown, true\)/);
    expect(hook).toMatch(/window\.removeEventListener\("pointerdown", onDown, true\)/);
    expect(hook).toMatch(/pressIsOutside\(e\.target as Node \| null, popover\.current, openerRef\.current\(\)\)/);
  });

  it("is what both popovers dismiss by, and neither keeps a copy", () => {
    const sound = read("components/SoundMenu.tsx");
    const anchored = read("components/AnchoredPopover.tsx");
    expect(sound).toContain("useOutsidePress(dialogRef, () => openerRef.current, onClose);");
    expect(anchored).toContain("useOutsidePress(ref, () => document.getElementById(anchorId), onClose);");
    for (const [name, text] of [["SoundMenu.tsx", sound], ["AnchoredPopover.tsx", anchored]]) {
      expect(text, `${name} listens for pointerdown itself again`).not.toMatch(/addEventListener\("pointerdown"/);
    }
  });
});
