// #1540: after a move into a taken slot, focus could land on the other
// account's ⋯.
//
// A swap trades two slot numbers, and the rows are keyed by slot, so the ⋯ the
// popover was opened from stays in the document — showing the account that was
// displaced. As the popover left it handed focus back to that ⋯ (its own
// restore, in use-modal-dismiss.ts, whenever focus is on <body> when it
// unmounts), while the move asked for the moved account's ⋯ one frame later,
// and only if focus had fallen. Whichever ran first won. In an isolated deck
// the same swap gave the moved account's ⋯ in a short script and the displaced
// account's in a longer session, every time.
//
// The move now hands focus to the moved account's ⋯ before it drops the
// popover, so the popover's restore finds focus already placed and does
// nothing. A ⋯ the new roster has not drawn yet — a move into an empty slot —
// is still the frame-later rescue's, as before.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { withoutComments } from "./tsx-scan";

const menu = withoutComments(readFileSync(fileURLToPath(new URL("../use-account-menu.ts", import.meta.url)), "utf8"));
/** The move, from its declaration to the end of its body. */
const doMove = /const doMove = async \(from: number, to: number\) => \{[\s\S]*?\n  \};/.exec(menu)?.[0] ?? "";

describe("focus after a move into a taken slot (#1540)", () => {
  it("is found, so the cases below are about the move", () => {
    expect(doMove).not.toBe("");
  });

  it("goes to the moved account's ⋯ before the popover is dropped", () => {
    const handoff = doMove.indexOf("target.focus();");
    const drop = doMove.indexOf("if (menuRef.current?.num === from) dropMenu();");
    expect(handoff).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(handoff);
    expect(doMove).toMatch(/const target = document\.getElementById\(`ap-more-\$\{next\.menuFor\}`\);/);
  });

  it("only when focus was in the popover or had already fallen", () => {
    expect(doMove).toMatch(/const pop = document\.getElementById\(`ap-menu-\$\{from\}`\);/);
    expect(doMove).toMatch(/if \(target && \(pop\?\.contains\(document\.activeElement\) \|\| focusDropped\(document\.activeElement\?\.tagName \?\? null\)\)\) \{/);
  });

  it("still leaves a ⋯ the new roster has not drawn yet to the rescue", () => {
    expect(doMove.indexOf("rescueFocus(next.menuFor);")).toBeGreaterThan(doMove.indexOf("dropMenu();"));
  });
});
