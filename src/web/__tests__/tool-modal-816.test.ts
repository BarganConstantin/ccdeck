// #816, the dialog half: it renders what tool-view.ts makes of a call instead
// of JSON.stringify, holds long blocks behind "show all", and puts a copy
// button on the input and on the response.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const modal = read("../components/ToolModal.tsx");
const code = modal.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\r\n]*/g, "$1");
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

describe("the tool dialog shows a call as what it is (#816)", () => {
  it("renders tool-view's blocks and no longer stringifies the payload", () => {
    expect(code).toMatch(/const view = toolView\(tool\.name, input, response\);/);
    // CHANGED ON PURPOSE: a block is handed the session's folder too, which a file's path is read from (PathText).
    expect(code).toMatch(/view\.input\.map\(\(b, n\) => <ToolBlock key=\{n\} block=\{b\} cwd=\{cwd\} \/>\)/);
    expect(code).toMatch(/view\.response\.map\(\(b, n\) => <ToolBlock key=\{n\} block=\{b\} cwd=\{cwd\} \/>\)/);
    expect(code).not.toMatch(/JSON\.stringify|safeJson/);
  });

  it("still falls back to the previews once the payloads were released", () => {
    // Through what the dialog holds of the call since it opened, which is the
    // reducer's copy until trimTools lets go of it:
    // tool-modal-held-payload.test.ts draws both.
    expect(code).toMatch(/const input = held\.current\.input \?\? tool\.inputPreview;/);
    expect(code).toMatch(/const response = held\.current\.response \?\? tool\.errorPreview;/);
    expect(code).toMatch(/<pre>\{t\("insights\.tool\.waiting"\)\}<\/pre>/);
  });

  it("colours a change by side through classes the sheet defines", () => {
    expect(code).toMatch(/const TONE_CLASS = \{ del: "tm-del", add: "tm-add", ctx: "tm-ctx" \} as const;/);
    for (const cls of ["tm-del", "tm-add", "tm-ctx"]) expect(css).toMatch(new RegExp(`\\.${cls} \\{ color: var\\(--`));
  });

  it("holds a long block behind show all", () => {
    // A disclosure since #1762: the same button reads "show less" once the
    // block is open, rather than leaving with the press that opened it.
    // tool-block-show-less-1762.test.ts draws both states.
    expect(code).toMatch(/const \{ shown \} = clip\(lines, open\);/);
    expect(code).toMatch(/const more = moreControl\(lines, open\);/);
    expect(code).toMatch(/\{more && \(\s*<button type="button" className="btn tm-more" aria-expanded=\{more\.expanded\} onClick=\{\(\) => setOpen\(o => !o\)\}>\s*\{more\.label\}\s*<\/button>\s*\)\}/);
  });

  it("puts a copy button on the input and, once there is one, on the response", () => {
    // The strings are worked out once per payload beside the view, not on every
    // render: tool-modal-render-cost.test.ts counts them.
    expect(code).toMatch(/copyInput: copyOf\(tool\.name, "input", input\),/);
    expect(code).toMatch(/copyResponse: copyOf\(tool\.name, "response", response\),/);
    expect(code).toMatch(/<CopyButton text=\{drawn\.copyInput\} what="input" \/>/);
    expect(code).toMatch(/\{tool\.endedAt != null && <CopyButton text=\{drawn\.copyResponse\} what="response" \/>\}/);
    // CHANGED ON PURPOSE (V4's Figma): the copy is a 24 icon button, so the word
    // it showed is gone and its accessible name carries what it copies, before
    // and after the copy (the label and the title are the one string), while the
    // glyph turns to a tick for the moment it is copied.
    expect(code).toMatch(/const label = t\(copied \? `insights\.tool\.copied\.\$\{what\}` : `insights\.tool\.copy\.\$\{what\}`\);/);
    expect(code).toMatch(/aria-label=\{label\} title=\{label\}/);
    expect(code).toMatch(/\{copied \? <KitStateGlyph name="done" \/> : <KitIcon name="copy" \/>\}/);
    expect(code).not.toMatch(/insights\.tool\.copyWord/);
  });

  it("keeps the × the first control in the dialog, so focus lands where it did", () => {
    // The first control in source order is the header's ×: either the shell's
    // DialogClose or a button of the dialog's own that wears the glyph-btn class.
    const first = /<DialogClose\b[^>]*>|<button(?:=>|[^>])*>/.exec(code)?.[0] ?? "";
    expect(first.startsWith("<DialogClose") || first.includes('className="glyph-btn"')).toBe(true);
    // And DialogClose is the kit's glyph-btn ×.
    // CHANGED ON PURPOSE (V4's Figma): it draws the kit's Close icon, not a
    // typed ×, and its name is still the label it is handed.
    expect(read("../components/Dialog.tsx")).toMatch(/<button type="button" className="glyph-btn"[^>]*aria-label=\{label\}[^>]*><KitIcon name="close" \/><\/button>/);
  });
});
