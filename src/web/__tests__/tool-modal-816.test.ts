// #816, the dialog half: it renders what tool-view.ts makes of a call instead
// of JSON.stringify, holds long blocks behind "show all", and puts a copy
// button on the input and on the response.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const modal = read("../components/ToolModal.tsx");
const code = modal.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\r\n]*/g, "$1");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

describe("the tool dialog shows a call as what it is (#816)", () => {
  it("renders tool-view's blocks and no longer stringifies the payload", () => {
    expect(code).toMatch(/const view = toolView\(tool\.name, input, response\);/);
    expect(code).toMatch(/view\.input\.map\(\(b, n\) => <ToolBlock key=\{n\} block=\{b\} \/>\)/);
    expect(code).toMatch(/view\.response\.map\(\(b, n\) => <ToolBlock key=\{n\} block=\{b\} \/>\)/);
    expect(code).not.toMatch(/JSON\.stringify|safeJson/);
  });

  it("still falls back to the previews once the payloads were released", () => {
    expect(code).toMatch(/const input = tool\.input \?\? tool\.inputPreview;/);
    expect(code).toMatch(/const response = tool\.response \?\? tool\.errorPreview;/);
    expect(code).toMatch(/<pre>\(waiting…\)<\/pre>/);
  });

  it("colours a change by side through classes the sheet defines", () => {
    expect(code).toMatch(/const TONE_CLASS = \{ del: "tm-del", add: "tm-add", ctx: "tm-ctx" \} as const;/);
    for (const cls of ["tm-del", "tm-add", "tm-ctx"]) expect(css).toMatch(new RegExp(`\\.${cls} \\{ color: var\\(--`));
  });

  it("holds a long block behind show all", () => {
    expect(code).toMatch(/const \{ shown, cut \} = clip\(linesOf\(block\), open\);/);
    expect(code).toMatch(/\{cut && <button type="button" className="btn tm-more" onClick=\{\(\) => setOpen\(true\)\}>show all<\/button>\}/);
  });

  it("puts a copy button on the input and, once there is one, on the response", () => {
    expect(code).toMatch(/<CopyButton text=\{copyOf\(tool\.name, "input", input\)\} what="input" \/>/);
    expect(code).toMatch(/\{tool\.endedAt != null && <CopyButton text=\{copyOf\(tool\.name, "response", response\)\} what="response" \/>\}/);
    // Its visible word is inside its accessible name, before and after.
    expect(code).toMatch(/aria-label=\{copied \? `The \$\{what\} was copied` : `Copy the \$\{what\}`\}/);
    expect(code).toMatch(/\{copied \? "copied" : "copy"\}/);
  });

  it("keeps the × the first control in the dialog, so focus lands where it did", () => {
    const first = /<button(?:=>|[^>])*>/.exec(code)?.[0] ?? "";
    expect(first).toContain('className="glyph-btn"');
  });
});
