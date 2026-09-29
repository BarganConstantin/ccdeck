// #1747: in the add dialog, making an invite or cancelling one dropped
// keyboard focus to the page.
//
// `make one to send` is drawn only while no invite is live, and the invite's
// `cancel` only inside the live invite. Each press succeeds, reloads the
// section's status, and the status that comes back takes the pressed control
// away — after the request, so the #518 busy rule that keeps it enabled while
// its own request is out never covered it. The effect that puts focus on the
// invite's copy ran only for a dialog opened from a nearby row's `invite`, not
// for an invite made in the dialog.
//
// Now a successful make or cancel remembers which it was, and once the invite
// has arrived or gone, focus goes to what replaced the pressed control: Copy
// invite after a make, `make one to send` after a cancel. Only when focus fell
// with the control — whoever tabbed on while the request was out stays put.
//
// Read from the source because the suite has no DOM to mount the dialog in —
// the same way #1411 and #1540 pin where focus goes.
import { describe, expect, it } from "vitest";

import { sourceOf } from "./client-source";

const add = sourceOf("components/LanAddDeckModal.tsx");
/** The make button's opening tag, up to its handler. */
const make = /<button type="button" className="ap-lan-word lan-h-act"[\s\S]*?onClick=\{\(\) => void invite\("make"\)\}/.exec(add)?.[0] ?? "";
/** The invite request, from its declaration to the end of its body. */
const invite = /const invite = useCallback\(async \(action: "make" \| "withdraw"\) => \{[\s\S]*?\n {2}\}, \[/.exec(add)?.[0] ?? "";
/** The effect that follows a press here to the control that replaced it. */
const follow = /useEffect\(\(\) => \{\s*const pressed = pressedInvite\.current;[\s\S]*?\}, \[live\]\);/.exec(add)?.[0] ?? "";

describe("focus after making or cancelling an invite in the add dialog (#1747)", () => {
  it("finds the make button, the request and the effect, so the cases below are about them", () => {
    expect(make).not.toBe("");
    expect(invite).not.toBe("");
    expect(follow).not.toBe("");
  });

  it("holds the make button, which is what a cancelled invite gives back", () => {
    expect(make).toMatch(/\bref=\{makeRef\}/);
    expect(add).toMatch(/const makeRef = useRef<HTMLButtonElement>\(null\);/);
    // The copy button already had its ref, for the nearby row's door.
    expect(add).toMatch(/ref=\{copyRef\}/);
  });

  it("remembers which press worked, before the reload that takes it away", () => {
    // Only a press that the deck answered yes to: a refused make leaves the
    // button where it was, and focus with it.
    expect(invite).toMatch(/if \(out\?\.ok\) \{ pressedInvite\.current = action; setFailure\(null\); setCopied\(null\); onChanged\(\); \}/);
  });

  it("waits until the invite is there or gone, then lands on what replaced the press", () => {
    // A make is answered by an invite arriving, a cancel by it going, and
    // either one waits for the status reload rather than the response.
    expect(follow).toMatch(/if \(!pressed \|\| \(pressed === "make"\) !== Boolean\(live\)\) return;/);
    expect(follow).toMatch(/pressedInvite\.current = null;/);
    expect(follow).toMatch(/if \(!focusDropped\(document\.activeElement\?\.tagName \?\? null\)\) return;/);
    expect(follow).toMatch(/\(pressed === "make" \? copyRef : makeRef\)\.current\?\.focus\(\);/);
    expect(add).toMatch(/import \{[^}]*\bfocusDropped\b[^}]*\} from "\.\.\/panel-press";/);
  });

  it("leaves the nearby row's door as it was", () => {
    // Opened from a row's `invite`, focus goes to Copy once the invite made on
    // arrival is there, wherever it is — the reader never pressed anything here.
    expect(add).toMatch(/if \(startWith !== "invite" \|\| focusedCopy\.current \|\| !live\) return;/);
  });
});
