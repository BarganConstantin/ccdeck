// #1607: a deck's dialog could show two armed unpairs at once.
//
// A machine running more than one deck lists each extra deck in its dialog
// with an unpair of its own, and the footer has the machine's own Unpair.
// Arming one did not stand the other down, so both read `confirm` and either
// press would unpair — and because the two share the moment of arming, a press
// on the one armed first, just after arming the second, was taken for the
// second half of a double-click and ignored. The list in the Local network
// view never allowed two: one `armed`, so arming a row stands the last down.
// The dialog's note says one deck at a time, and now it is.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import { WEB_DIR } from "./client-source";
import { withoutComments } from "./tsx-scan";

/** The dialog's two unpairs, which moved out of LanPeerModal.tsx into a hook
 *  of their own. */
const modal = withoutComments(readFileSync(`${WEB_DIR}use-peer-unpair.ts`, "utf8"));

/** The body of every `if (press === "arm") { ... }` in the dialog. */
const arms = [...modal.matchAll(/if \(press === "arm"\) \{([^}]*)\}/g)].map(m => m[1]);

describe("one armed unpair at a time in a deck's dialog (#1607)", () => {
  it("has the two arms it always had: the footer's and a folded deck's", () => {
    expect(arms).toHaveLength(2);
  });

  it("stands a folded deck's arm down when the footer's Unpair arms", () => {
    const own = arms.find(a => /setArmed\(true\)/.test(a));
    expect(own).toBeDefined();
    expect(own).toMatch(/setArmedTwin\(null\)/);
  });

  it("stands the footer's arm down when a folded deck's unpair arms", () => {
    const twin = arms.find(a => /setArmedTwin\(fpT\)/.test(a));
    expect(twin).toBeDefined();
    expect(twin).toMatch(/setArmed\(false\)/);
  });
});
