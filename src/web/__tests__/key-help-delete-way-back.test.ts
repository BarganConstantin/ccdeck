// The shortcuts sheet promised an Undo for Delete that no longer exists.
//
// "take the selected card off the board — Undo brings it back". The banner that
// carried Undo was dropped when the removal stopped drawing anything; what is
// left is a line for screen readers, and the way back is the session list (L),
// which is what the detail panel's own Remove button says. A sheet that names a
// control nobody can find sends the reader looking for it after the card is
// already gone.
import { describe, expect, it } from "vitest";
import { KEY_HELP } from "../key-help";

const rows = KEY_HELP.flatMap(g => g.rows);

describe("what the sheet says Delete's way back is", () => {
  it("names the session list, the way back there is", () => {
    const row = rows.find(r => r.binds?.includes("Delete"));
    expect(row?.action).toBe("take the selected card off the board — the session list (L) brings it back");
  });

  it("promises an Undo only where there is one: Re-arrange's, on its chord", () => {
    // Delete's row, or any other, naming an Undo still fails here. The one the
    // sheet may name is Re-arrange's, which the canvas really offers for a few
    // seconds after R — on its strip, and on ⌘Z / Ctrl+Z (rearrange-undo.ts).
    expect(rows.filter(r => /\bundo\b/i.test(r.action)).map(r => r.cap)).toEqual(["Ctrl + Z"]);
  });
});
