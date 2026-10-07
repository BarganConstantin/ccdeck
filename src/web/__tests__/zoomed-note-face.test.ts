// A session's note seen from a distance: the face RecapNoteNode draws over the
// note's box at the compact and overview zooms, in screen pixels (see
// `.lod-face`). Two things it owes a reader there: every line it paints is
// whole, and a line it cuts short is read whole in the deck's hover card, which
// opens over the face at both distances — not in a title of its own, which put
// the browser's tooltip on top of that card (note-face-one-hover.test.ts).
//
// The face measured on a board zoomed out a step at a time: with a content
// box 44.4px tall it drew two lines of the note, which then needed 45, and
// the second lost the bottom of its letters; and its age, cut to
// fit the face, read "3" for 39 minutes, with nothing on hover to say so.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { faceTitle } from "../node-face";
import { sheetRules } from "./sheet-cascade";
import { sheetText } from "./sheet-source";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const node = read("../components/RecapNoteNode.tsx");
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the top-level rule whose selector list is exactly `sels`. */
function rule(...sels: string[]): string {
  const hit = sheetRules().filter(r => r.media == null && r.selectors.length === sels.length && sels.every(s => r.selectors.includes(s)));
  expect(hit.length, sels.join(", ")).toBeGreaterThan(0);
  return hit.map(r => r.body).join("\n");
}
const px = (body: string, prop: string) => {
  const m = new RegExp(`(?:^|[;{\\s])${prop}:\\s*([\\d.]+)px`).exec(body);
  expect(m, `${prop} in ${body}`).not.toBeNull();
  return Number(m![1]);
};

describe("the note's text on a zoomed-out face", () => {
  // The face's content box, top to bottom: the mark row, the note face's gap,
  // then the lines of the note. The compact mark row is the taller one, so
  // what fits there fits in the overview's too.
  const row = px(rule(".lod-id"), "line-height");
  const face = rule('.canvas-wrap[data-lod="compact"] .lod-face', '.canvas-wrap[data-lod="overview"] .lod-face');
  const noteFace = rule('.canvas-wrap[data-lod="compact"] .lod-face.recap-face', '.canvas-wrap[data-lod="overview"] .lod-face.recap-face');
  const gap = px(noteFace, "gap");
  const line = px(face, "line-height");
  const need = (lines: number) => row + gap + line * lines;
  const tiers = [...css.matchAll(/@container lod \(height < ([\d.]+)px\) \{\s*\.recap-face-text \{([^}]*)\}\s*\}/g)]
    .map(m => ({ below: Number(m[1]), body: m[2], at: m.index! }));

  it("starts each tier at the height its last line fits in, whole", () => {
    // A tier of N lines holds from its own bound up to the next one, so the
    // bound below it is where N lines must already fit — and a tier that
    // started any later would leave a line's room empty.
    expect(tiers.map(t => t.below)).toEqual([need(4), need(3), need(2), need(1)]);
    expect(tiers.map(t => /display:\s*none/.test(t.body) ? 0 : Number(/-webkit-line-clamp:\s*(\d+)/.exec(t.body)?.[1])))
      .toEqual([3, 2, 1, 0]);
    for (const t of tiers.filter(t => !/display:\s*none/.test(t.body))) expect(t.body).toMatch(/(?:^|[;\s])line-clamp:\s*\d+/);
    // Taller faces first, so a shorter face's tier is the later rule and wins.
    expect(tiers.map(t => t.at)).toEqual([...tiers.map(t => t.at)].sort((a, b) => a - b));
    expect(rule(".recap-face-text")).toMatch(/-webkit-line-clamp:\s*4;/);
  });

  it("leaves its whole text to the hover card that opens over it, with no title of its own", () => {
    expect(node).toContain('<p className="recap-face-text">{note.text}</p>');
    expect(read("../components/SessionPeek.tsx")).toContain('<p className="recap-peek-text">{note.text}</p>');
  });

  it("puts the line itself above a tooltip that does not already hold it", () => {
    expect(faceTitle("39m ago", "6 Oct 2026, 16:15:02")).toBe("39m ago\n6 Oct 2026, 16:15:02");
    expect(faceTitle("Bump the aws provider", "From the session's newest reply")).toBe("Bump the aws provider\nFrom the session's newest reply");
    expect(faceTitle("Bump the aws provider", undefined)).toBe("Bump the aws provider");
    expect(faceTitle("shop-api-auth", "/w/shop-api-auth\nAdd the login route")).toBe("/w/shop-api-auth\nAdd the login route");
  });
});

describe("the note's age on a zoomed-out face", () => {
  it("is a value, so it is drawn whole or not at all", () => {
    // Never cut: "3" in the place of "39m ago" is a different number. A face
    // too narrow for it wraps it onto a second row the first row's height
    // hides, so nothing under the row moves either way.
    const age = rule(".recap-face-age");
    expect(age).toMatch(/flex:\s*none;/);
    expect(age).not.toMatch(/text-overflow|overflow:/);
    const id = rule(".recap-face .lod-id");
    expect(id).toMatch(/flex-wrap:\s*wrap;/);
    expect(id).toMatch(/align-content:\s*flex-start;/);
    expect(id).toMatch(/justify-content:\s*flex-start;/);
    // Clipped downward only, which leaves its box out of the flex column's
    // shrinking (a scroller's minimum height is 0, and it shrank under the
    // mark at the narrowest face) and lets a long mark run on as before.
    expect(id).toMatch(/overflow-x:\s*visible;/);
    expect(id).toMatch(/overflow-y:\s*clip;/);
    // One row tall at each distance: the row's own line height.
    expect(px(id, "height")).toBe(px(rule(".lod-id"), "line-height"));
    const overview = rule('.canvas-wrap[data-lod="overview"] .recap-face .lod-id');
    expect(px(overview, "height")).toBe(px(rule('.canvas-wrap[data-lod="overview"] .lod-id'), "line-height"));
  });

  it("takes no title under the hover card, and the full note's age keeps the moment it stands for", () => {
    expect(node).toContain('<span className="recap-face-age">{written.label}</span>');
    expect(node).toContain('<span className="recap-note-age" title={written.title}>{written.label}</span>');
  });
});
