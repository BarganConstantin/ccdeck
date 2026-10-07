// A session's note at the full card's size carries its whole text on hover.
//
// A status note holds three lines on the canvas, and what a running turn says
// is often longer: measured on a board at the full card, a 153-character reply
// was cut at its third line, the note's only tooltip said who wrote it and not
// what, and the hover preview that holds the whole text does not open at that
// zoom. So the cut text had nowhere to be read but the detail panel. The note's
// text now carries itself on hover, the way the zoomed-out face's line does
// (faceTitle): the text, then who wrote it. The suggested reply under a
// question, cut to one line with an ellipsis, carries its whole line too, on
// the canvas and in the session list.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { faceTitle } from "../node-face";
import { sheetRules } from "./sheet-cascade";

const node = readFileSync(fileURLToPath(new URL("../components/RecapNoteNode.tsx", import.meta.url)), "utf8");
const list = readFileSync(fileURLToPath(new URL("../components/SessionList.tsx", import.meta.url)), "utf8");
const body = (sel: string) => sheetRules().filter(r => r.media == null && r.selectors.includes(sel)).map(r => r.body).join("\n");

describe("the note at the full card's size", () => {
  it("cuts a status note at three lines, which is why it needs the tooltip", () => {
    expect(body(".recap-note.is-status .recap-note-text")).toMatch(/-webkit-line-clamp:\s*3;/);
    expect(body(".recap-note-reply")).toMatch(/text-overflow:\s*ellipsis;/);
  });

  it("carries its whole text on hover, with who wrote it under it, as its face does", () => {
    expect(node).toContain('<p className="recap-note-text" title={faceTitle(note.text, tip)}>{note.text}</p>');
    expect(node).toContain('<p className="recap-face-text" title={faceTitle(note.text, tip)}>{note.text}</p>');
    // What the hover says for a line the deck read off the newest reply, and
    // for a recap, which names itself in its mark and has no tooltip of its own.
    expect(faceTitle("Now I'll make the invoice preview pick up the customer's locale", "From the session's newest reply"))
      .toBe("Now I'll make the invoice preview pick up the customer's locale\nFrom the session's newest reply");
    expect(faceTitle("Shipped the login route", undefined)).toBe("Shipped the login route");
  });

  it("carries the whole suggested reply on hover, as the line reads, here and in the session list", () => {
    expect(node).toContain("{note.reply && <p className=\"recap-note-reply\" title={`suggested reply “${note.reply}”`}>suggested reply “{note.reply}”</p>}");
    // The list's line is cut the same way, and was the other place it had no tooltip.
    expect(body(".session-list .sl-status-reply")).toMatch(/text-overflow:\s*ellipsis;/);
    expect(list).toContain("{r.status?.reply && <span className=\"sl-status-reply\" title={`suggested reply “${r.status.reply}”`}>suggested reply “{r.status.reply}”</span>}");
  });
});
