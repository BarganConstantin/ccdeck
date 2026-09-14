// #854: tool bubbles open a call only by mouse and are hidden from assistive
// tech, while a comment claimed they were focusable.
//
// The bubbles being mouse-only is a decision, written down in ToolBursts.tsx:
// they are a transient trace that fades and moves with the viewport, and a live
// deck once put 105 of its 166 focusables inside their aria-hidden layer. The
// keyboard's way to the same tool call is the detail panel's list, where every
// call is a real <button>. What was wrong was two things around that decision:
// shortcuts.ts still said the bursts are "written with tabIndex", and the panel
// itself opened only with D. #814 made any selection open it, and the comment
// now says what is true. This file holds the three halves together.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const code = (src: string) => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

const bursts = code(read("../components/ToolBursts.tsx"));
const app = code(read("../App.tsx"));
const shortcuts = read("../shortcuts.ts");

describe("the bubbles stay decoration, and the keyboard has its own way in (#854)", () => {
  it("keeps the bubble layer out of the accessibility tree, and no bubble takes focus", () => {
    expect(bursts).toMatch(/<div className="tool-bursts-layer" aria-hidden>/);
    const layer = bursts.slice(bursts.indexOf('className="tool-bursts-layer"'));
    expect(layer).not.toMatch(/tabIndex/);
    expect(layer).not.toMatch(/role="button"/);
  });

  it("lists every tool call in the detail panel as a real button", () => {
    expect(app).toMatch(/function ToolRow[\s\S]*?<button className="tool clickable"/);
  });

  it("opens that panel from the keyboard, because a selection opens it (#814)", () => {
    expect(app).toMatch(/if \(!additive\) setDetailOpen\(true\);/);
  });

  it("no longer says the bursts are written with tabIndex", () => {
    expect(shortcuts).not.toMatch(/how\s+(\/\/\s*)?the tool bursts are written/);
  });
});
