// #1539: an armed unpair on the Local network list stood down early.
//
// The row's unpair arms on the first press and reads `confirm` for four
// seconds. The timer that stood it down was set by the press and left running,
// and all it asked when it fired was whether the same row was still armed. So a
// row armed, left for another row and armed again inside those four seconds was
// stood down by its FIRST arm's timer — measured in a browser, two seconds into
// the second arm — and a press on `confirm` in that moment armed it again
// instead of unpairing.
//
// The deck's own dialog never had this: both of its unpairs stand down from an
// effect keyed on the arm, so a new arm clears the old timer. The row does the
// same now, and every arm on the section's surface is held to it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import { WEB_DIR } from "./client-source";
import { lanPeerSurface } from "./lan-peer-surface";
import { lanSectionSurface } from "./lan-section-surface";
import { withoutComments } from "./tsx-scan";

const section = withoutComments(lanSectionSurface());
/** The dialog's two unpairs, which moved out of LanPeerModal.tsx into a hook
 *  of their own; the dialog and every file lifted out of it, for the sweep. */
const modal = withoutComments(readFileSync(`${WEB_DIR}use-peer-unpair.ts`, "utf8"));
const dialog = lanPeerSurface(withoutComments);

/** The body of `const <name> = (...) => { ... };`, to its own closing line. */
function handler(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = (`);
  expect(at, `${name} is not in the source`).toBeGreaterThan(-1);
  const end = src.indexOf("\n  };\n", at);
  expect(end, `${name} has no closing line`).toBeGreaterThan(at);
  return src.slice(at, end);
}

describe("an armed unpair gets four seconds from its own arm (#1539)", () => {
  it("does not start a timer from the press", () => {
    // A timer the press starts outlives the arm it was started for. Whatever
    // it asks when it fires, a later arm of the same row looks like its own.
    const press = handler(section, "pressUnpair");
    expect(press).toMatch(/if \(press === "arm"\) \{\s*setArmed\(p\.fp\);\s*armedAt\.current = now;\s*return;\s*\}/);
    expect(press).not.toMatch(/setTimeout/);
  });

  it("stands the row down from an effect keyed on the arm, which a new arm clears", () => {
    expect(section).toMatch(
      /useEffect\(\(\) => \{\s*if \(armed == null\) return;\s*const t = window\.setTimeout\(\(\) => setArmed\(null\), 4_000\);\s*return \(\) => window\.clearTimeout\(t\);\s*\}, \[armed\]\);/,
    );
  });

  it("is the shape the deck's own dialog already used, for both of its unpairs", () => {
    expect(modal).toMatch(
      /useEffect\(\(\) => \{\s*if \(!armed\) return;\s*const t = window\.setTimeout\(\(\) => setArmed\(false\), 4_000\);\s*return \(\) => window\.clearTimeout\(t\);\s*\}, \[armed\]\);/,
    );
    expect(modal).toMatch(
      /useEffect\(\(\) => \{\s*if \(!armedTwin\) return;\s*const t = window\.setTimeout\(\(\) => setArmedTwin\(null\), 4_000\);\s*return \(\) => window\.clearTimeout\(t\);\s*\}, \[armedTwin\]\);/,
    );
  });

  it("leaves no stand-down timer anywhere on the section or the dialog that a press starts", () => {
    // The old spelling, in any of the three: a functional update that checks
    // the target when the timer fires.
    for (const [name, src] of [["the section", section], ["the dialog", dialog]] as const) {
      expect(`${name}: ${/window\.setTimeout\(\(\) => setArmed\w*\(\w+ => \(\w+ === /.test(src)}`).toBe(`${name}: false`);
    }
  });
});
