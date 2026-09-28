// #1639: an account's armed Remove could stand down early.
//
// Pressing Remove in an account's ⋯ menu arms it for four seconds. The timer
// that stood it down was started on the press and cleared whichever arm was on
// that account when it fired — so arming, closing the menu, opening it again
// and arming within the four seconds left the new Confirm only the time the
// first one had left, and a press on it then armed again instead of removing.
// Local network's unpairs had the same fault and the same fix (#1539): the
// window is an effect keyed on the armed account, which a close clears and a
// new arm restarts.
import { describe, it, expect } from "vitest";
import { withoutComments } from "./tsx-scan";
import { sourceOf } from "./client-source";

const menu = withoutComments(sourceOf("use-account-menu.ts"));

/** The body of `const <name> = (...) => { ... };`, to its own closing line. */
function handler(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = (`);
  expect(at, `${name} is not in the source`).toBeGreaterThan(-1);
  const end = src.indexOf("\n  };\n", at);
  expect(end, `${name} has no closing line`).toBeGreaterThan(at);
  return src.slice(at, end);
}

describe("an armed Remove gets four seconds from its own arm (#1639)", () => {
  it("does not start a timer from the press", () => {
    const press = handler(menu, "pressRemove");
    expect(press).toMatch(/if \(press === "arm"\) \{\s*setConfirmRemove\(num\);\s*removeArmedAt\.current = now;\s*return;\s*\}/);
    expect(press).not.toMatch(/setTimeout/);
  });

  it("stands the arm down from an effect keyed on the armed account", () => {
    expect(menu).toMatch(
      /useEffect\(\(\) => \{\s*if \(confirmRemove == null\) return;\s*const t = window\.setTimeout\(\(\) => setConfirmRemove\(null\), REMOVE_ARMED_MS\);\s*return \(\) => window\.clearTimeout\(t\);\s*\}, \[confirmRemove\]\);/,
    );
  });

  it("clears the arm when the menu closes, so the next arm is a new window", () => {
    const drop = /const dropMenu = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/.exec(menu)?.[0] ?? "";
    expect(drop, "dropMenu is gone").not.toBe("");
    expect(drop).toMatch(/setConfirmRemove\(null\);/);
  });
});
