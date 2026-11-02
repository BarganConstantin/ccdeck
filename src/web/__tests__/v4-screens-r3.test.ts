// The Decision card and Chat geometry as V4's Figma draws it, read from the sheets:
// the free-text answer, the outcome rows, the tree, the chat column and its tool
// rows. The numbers are the drawing's; the behaviour (keys, lock, sending, the
// outcome machine) is pinned in the other screen tests.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../components/${rel}`, import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const dc = read("decision/decision.css");
const chat = read("chat/chat.css");

/** The first rule whose selector is exactly `sel` (a rule that starts a line). */
const rule = (css: string, sel: string) => {
  const at = css.indexOf(`\n${sel} {`);
  expect(at, `${sel} has a rule`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};

describe("the free-text answer", () => {
  it("puts the input under the title, at the title's x, 409 x 34", () => {
    // 8 (border and padding) + the 20 wide chip + 8 gap = 36, the title's x.
    expect(rule(dc, ".dc-chip")).toContain("min-width: 20px;");
    expect(rule(dc, ".dc-opt")).toContain("gap: 8px;");
    expect(rule(dc, ".dc-field")).toContain("padding: 0 15px 0 36px;");
    expect(460 - 36 - 15).toBe(409);
    expect(rule(dc, ".dc-input")).toContain("height: 34px;");
  });

  it("draws the input 6 round, --bg over a 1px --line, its text 400 12/16 --text", () => {
    const input = rule(dc, ".dc-input");
    expect(input).toContain("background: var(--bg);");
    expect(input).toContain("border: 1px solid var(--line);");
    expect(input).toContain("border-radius: var(--r-ctl);");
    expect(input).toContain("font-size: calc(12px + var(--ui-text-increase, 0px));");
    expect(input).toContain("line-height: 16px;");
    expect(input).toContain("color: var(--text);");
    expect(input).toContain("padding: 0 56px 0 10px;");
  });

  it("keeps Send inside the input as plain text, and the typed text clear of it", () => {
    const send = rule(dc, ".dc-send");
    expect(send).toContain("position: absolute;");
    expect(send).toContain("top: 50%;");
    expect(send).toContain("font-weight: 500;");
    expect(send).toContain("color: var(--accent);");
    expect(send).not.toMatch(/background|border|box-shadow/);
    // 15 of the field's right padding + 9 = 24 from the field's right edge: 9 inside the input.
    expect(send).toContain("right: 24px;");
    // The input's right padding: 9 + about 39 for the word + a gap, never under it.
    expect(Number(/padding: 0 (\d+)px 0 10px/.exec(rule(dc, ".dc-input"))?.[1])).toBeGreaterThanOrEqual(9 + 39);
  });
});

describe("the outcome rows", () => {
  it("top-aligns the glyph with the first line and puts the link on the sub line", () => {
    expect(rule(dc, ".dc-out")).toContain("align-items: flex-start;");
    // 12.5 (border and padding) + 0.5 = 13; 12.5 + 19.5 = 32.
    expect(rule(dc, ".dc-out-glyph")).toContain("margin-top: 0.5px;");
    expect(rule(dc, ".dc-out .dc-link")).toContain("margin-top: 19.5px;");
    expect(12.5 + 0.5).toBe(13);
    expect(12.5 + 19.5).toBe(32);
  });

  // CHANGED ON PURPOSE (V4's Figma): the frame draws the outcome box 9 round,
  // and no token is 9, so the corner is V4's literal rather than --r-panel (8).
  it("draws the box 9 round", () => {
    expect(rule(dc, ".dc-out")).toContain("border-radius: 9px;");
    expect(rule(dc, ".dc-out")).not.toContain("var(--r-panel)");
  });
});

describe("the tree", () => {
  it("is a 24 wide column", () => {
    expect(rule(dc, ".dc-decision")).toContain("grid-template-columns: 300px 24px minmax(0, 460px);");
  });

  it("has a 12 x 1 stub at the card's middle, in --line", () => {
    const stub = rule(dc, ".dc-stub");
    expect(stub).toContain("left: 0;");
    expect(stub).toContain("top: 50%;");
    expect(stub).toContain("width: 12px;");
    expect(stub).toContain("height: 1px;");
    expect(rule(dc, ".dc-tree")).toContain("color: var(--line);");
  });

  it("has 12 x 1 ticks at x 12, and a 1px spine at x 12 drawn tick to tick", () => {
    const tick = rule(dc, ".dc-tick::after");
    expect(tick).toContain("left: 12px;");
    expect(tick).toContain("width: 12px;");
    expect(tick).toContain("top: 50%;");
    expect(tick).toContain("height: 1px;");
    // The spine's upper half: from the 4 gap above down to this tick's own line.
    const spine = rule(dc, ".dc-tick + .dc-tick::before");
    expect(spine).toContain("left: 12px;");
    expect(spine).toContain("width: 1px;");
    expect(spine).toContain("top: -4px;");
    expect(spine).toContain("height: calc(50% + 4px + 1px);");
    expect(spine).toContain("background: currentColor;");
    // Its lower half: from the line down to the tick's foot, on every tick but the last.
    expect(rule(dc, ".dc-tick:not(:last-child)")).toContain("background: linear-gradient(currentColor, currentColor) 12px 100% / 1px 50% no-repeat;");
  });

  it("puts the open field's tick at its box's middle: 104 high, 52 down", () => {
    expect(rule(dc, ".dc-tick[data-typing]")).toContain("height: calc(var(--row-option) + 10px + 34px + 16px);");
    expect(44 + 10 + 34 + 16).toBe(104);
    // The third box starts at 2 x 48 = 96; its middle is 96 + 52 = 148.
    expect(2 * (44 + 4) + 104 / 2).toBe(148);
  });

  it("keeps the ticks one row-option high, 4 apart, and the icons 12", () => {
    expect(rule(dc, ".dc-tick")).toContain("height: var(--row-option);");
    expect(rule(dc, ".dc-tree")).toContain("gap: 4px;");
    const kit = readFileSync(fileURLToPath(new URL("../components/kit-icons.tsx", import.meta.url)), "utf8");
    expect(kit).toMatch(/external:\s*\{\s*size:\s*12,/);
  });
});

describe("the chat column", () => {
  it("is 12 above and below, 20 at the sides, content 776 at x 20", () => {
    expect(rule(chat, ".chat-body")).toContain("padding: 12px 20px;");
    const col = rule(chat, ".chat-col");
    expect(col).toContain("max-width: 776px;");
    expect(col).toContain("gap: 12px;");
    expect(816 - 2 * 20).toBe(776);
  });

  it("runs consecutive tool rows together, 24 high, with 12 after the run", () => {
    expect(rule(chat, ".chat-tool + .chat-tool")).toContain("margin-top: -12px;");
    expect(rule(chat, ".chat-tool")).toContain("height: var(--row-tool);");
    expect(read("../styles/reading.css")).toContain("--row-tool: 24px;");
  });

  it("sets a tool row 0 8, 6 round, 6 between its parts, mono 12/16", () => {
    const tool = rule(chat, ".chat-tool");
    expect(tool).toContain("padding: 0 8px;");
    expect(tool).toContain("border-radius: var(--r-ctl);");
    expect(tool).toContain("gap: 6px;");
    expect(tool).toContain("font: 400 12px/16px var(--font-mono);");
    expect(tool).toContain("color: var(--muted);");
    expect(rule(chat, ".chat-tool-name")).toMatch(/font-weight: 500;[^}]*color: var\(--text-secondary\);/);
    expect(rule(chat, ".chat-tool-arg")).toContain("text-overflow: ellipsis;");
  });

  it("sets the assistant 13/20 --text up to 640, the divider 12/16 --muted with --line-soft rules", () => {
    const said = rule(chat, ".chat-said");
    expect(said).toContain("max-width: 640px;");
    expect(said).toContain("line-height: 20px;");
    expect(said).toContain("color: var(--text);");
    expect(rule(chat, ".chat-since")).toMatch(/gap: 12px;[^}]*color: var\(--muted\);/);
    expect(rule(chat, ".chat-since-line")).toContain("background: var(--line-soft);");
  });

  it("sets your message right-aligned, 8 12, 12 12 4 12 round, on --your-message", () => {
    expect(rule(chat, ".chat-you")).toContain("justify-content: flex-end;");
    const text = rule(chat, ".chat-you-text");
    expect(text).toContain("padding: 8px 12px;");
    expect(text).toContain("background: var(--your-message);");
    expect(text).toContain("border-radius: var(--r-overlay) var(--r-overlay) var(--r-tag) var(--r-overlay);");
  });
});
