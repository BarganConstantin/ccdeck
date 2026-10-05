// "show all" in the tool inspector took itself away (#1762).
//
// The button was drawn on `cut`, and pressing it opened the block, which is no
// longer cut — so the press removed the control it was made on, focus fell to
// <body>, and the dialog's trap sent the next Tab to the × at the top, far
// from the text that had just opened. It is a disclosure now: "show all" while
// the block is held to the budget, "show less" once it is open, the same
// button either way and `aria-expanded` saying which.
//
// Run, not read. ToolBlock is called under a React whose one hook, useState,
// answers the open state the test chooses; the elements it returns are the
// real JSX runtime's, drawn to markup by react-dom/server.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const react = vi.hoisted(() => ({
  open: false,
  set: [] as unknown[],
}));

vi.mock("react", () => ({
  useState: () => [react.open, (v: unknown) => { react.set.push(v); }],
  useRef: (init: unknown) => ({ current: init }),
  useEffect: () => {},
  useMemo: (make: () => unknown) => make(),
}));

const { ToolBlock } = await import("../components/ToolModal");
const { CLIP_LINES, moreControl, linesOf } = await import("../tool-view");

const long = { label: "output", text: Array.from({ length: CLIP_LINES + 20 }, (_, n) => `line ${n}`).join("\n") };
const short = { label: "output", text: "one\ntwo" };

const draw = (block: typeof long, open: boolean) => {
  react.open = open;
  return renderToStaticMarkup(ToolBlock({ block }));
};

beforeEach(() => { react.set = []; });

describe("a long block's control", () => {
  it("is there before the press, saying what it will do", () => {
    const html = draw(long, false);
    expect(html).toContain('<button type="button" class="btn tm-more" aria-expanded="false">show all</button>');
    expect(html).not.toContain(`line ${CLIP_LINES + 19}`);
  });

  it("is still there after it, so the press keeps its focus", () => {
    const html = draw(long, true);
    expect(html).toContain(`line ${CLIP_LINES + 19}`);
    expect(html).toContain('<button type="button" class="btn tm-more" aria-expanded="true">show less</button>');
  });

  it("opens the block and closes it again", () => {
    // The setter is handed an updater, so the one button is both halves.
    const button = (open: boolean) => {
      react.open = open;
      const find = (node: unknown): { props: { onClick: () => void } } | null => {
        if (!node || typeof node !== "object") return null;
        const el = node as { props?: { className?: string; children?: unknown } };
        if (el.props?.className === "btn tm-more") return el as { props: { onClick: () => void } };
        const kids = el.props?.children;
        for (const kid of Array.isArray(kids) ? kids : [kids]) {
          const hit = find(kid);
          if (hit) return hit;
        }
        return null;
      };
      return find(ToolBlock({ block: long }));
    };
    button(false)!.props.onClick();
    button(true)!.props.onClick();
    const [first, second] = react.set as Array<(v: boolean) => boolean>;
    expect(typeof first === "function" ? first(false) : first).toBe(true);
    expect(typeof second === "function" ? second(true) : second).toBe(false);
  });

  it("is not drawn under a block that fits, open or not", () => {
    for (const open of [false, true]) expect(draw(short, open)).not.toContain("tm-more");
  });
});

describe("moreControl", () => {
  it("offers show all on a long block and show less once it is open", () => {
    const lines = linesOf(long);
    expect(moreControl(lines, false)).toEqual({ label: "show all", expanded: false });
    expect(moreControl(lines, true)).toEqual({ label: "show less", expanded: true });
  });

  it("offers nothing on a block that fits", () => {
    const lines = linesOf(short);
    expect(moreControl(lines, false)).toBeNull();
    expect(moreControl(lines, true)).toBeNull();
  });
});
