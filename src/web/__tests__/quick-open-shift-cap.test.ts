// Two Shift taps open Quick open from everywhere ⌘K (Ctrl+K) does, and from
// the terminal too, where the chord is the session's. So Search's field in the
// top bar shows the taps, its hint keeps the chord, the Keys sheet lists both,
// and every place that names the taps says it the same way: one cap,
// SHIFT_TAPS_CAP, never a second spelling.
import { describe, expect, it } from "vitest";
import { SHIFT_TAPS_CAP } from "../quick-open";
import { keyHelpFor } from "../key-help";
import { sourceOf } from "./client-source";

const panels = (singleKeys: boolean, workspace = false) =>
  keyHelpFor(singleKeys, () => true, workspace).find(g => g.id === "panels")!.rows;

describe("the two Shift taps' cap", () => {
  it("is one cap, the words the status bar and the Keys sheet already used", () => {
    expect(SHIFT_TAPS_CAP).toBe("Shift ×2");
  });

  it("is listed beside the chord on the Keys sheet, with the single keys on or off", () => {
    for (const singleKeys of [true, false]) {
      for (const workspace of [false, true]) {
        const caps = panels(singleKeys, workspace).map(r => r.cap);
        expect(caps, `single keys ${singleKeys}, workspace ${workspace}`).toContain("Ctrl + K");
        expect(caps, `single keys ${singleKeys}, workspace ${workspace}`).toContain(SHIFT_TAPS_CAP);
        expect(caps.indexOf(SHIFT_TAPS_CAP)).toBe(caps.indexOf("Ctrl + K") + 1);
      }
    }
  });

  it("is spelled in one place: the sheet, the status bar and Search's field all name the constant", () => {
    for (const file of ["key-help.ts", "components/StatusBar.tsx", "rail-items.tsx", "components/EdgeRails.tsx"]) {
      expect(sourceOf(file), file).not.toContain("Shift ×2");
    }
    expect(sourceOf("components/StatusBar.tsx")).toContain("<Kbd>{SHIFT_TAPS_CAP}</Kbd>");
    expect(sourceOf("rail-items.tsx")).toContain("fieldKey: SHIFT_TAPS_CAP");
  });
});
