// #1803. In either guide — the welcome tour, or "How Local network works" —
// Back on step 2 took itself away: it is drawn only after the first step, so
// the press that went back removed the button that had focus. Focus fell to
// <body> behind the dialog, where the arrow keys the dialog listens for never
// arrive and Enter has no button to press, and the next Tab was pulled to the
// ×. The guide's own header promises that somebody who opened it pressing
// Enter can keep pressing Enter to the end. The last step's quiet second way
// out goes the same way when an arrow leaves that step under it.
//
// Run, not read: the dialog is called on fake-react.ts's React, against a
// document whose focused element the test holds and which drops focus when a
// render takes the focused button away, as a browser does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));
// The dialog's own start: focus goes to the ref it was handed, once, on mount.
vi.mock("../components/use-modal-dismiss", async orig => {
  const { react } = await import("./fake-react");
  return {
    ...(await orig<typeof import("../components/use-modal-dismiss")>()),
    useModalDismiss: (_: unknown, opts: { focusRef?: { current: { focus(): void } | null } } = {}) => {
      react.useEffect(() => { opts.focusRef?.current?.focus(); }, []);
      return react.useRef(null);
    },
  };
});

const { default: GuideModal } = await import("../components/GuideModal");

/** A focusable node, and how to find the element it is in a tree. */
interface Node { tagName: string; find?: (tree: unknown) => Drawn | null; focus(): void }
const BODY: Node = { tagName: "BODY", focus() {} };
let page: { activeElement: Node; body: null };
const node = (find: (tree: unknown) => Drawn | null): Node => {
  const n: Node = { tagName: "BUTTON", find, focus: () => { page.activeElement = n; } };
  return n;
};
const button = (match: (el: Drawn) => boolean) => (tree: unknown) => one(tree, el => el.type === "button" && match(el));

const nextButton = button(el => el.props.className === "btn primary");
const backButton = button(el => textOf(el) === "Back");
const asideButton = button(el => el.props.className === "ap-lan-word guide-aside");
const dotButton = (i: number) => button(el => el.props["aria-label"] === `Step ${i} of 3`);

const next = node(nextButton);
const back = node(backButton);
const aside = node(asideButton);
const firstDot = node(dotButton(1));

beforeEach(() => {
  page = { activeElement: BODY, body: null };
  vi.stubGlobal("document", page);
});

afterEach(() => { vi.unstubAllGlobals(); });

function open() {
  const view = mount(GuideModal, {
    title: "How Local network works",
    steps: [{ art: null, line: "One." }, { art: null, line: "Two." }, { art: null, line: "Three." }],
    aside: { label: "Not now", act: () => {} },
    onClose: () => {},
  }, {
    // What the document does with a render: Next's node goes to its ref, and a
    // focused button the render took away takes focus with it.
    commit: tree => {
      const el = nextButton(tree);
      if (el?.ref && typeof el.ref === "object") (el.ref as { current: unknown }).current = next;
      if (page.activeElement.find && !page.activeElement.find(tree)) page.activeElement = BODY;
    },
  });
  const counter = () => textOf(one(view.tree, el => el.props.className === "modal-tool-id"));
  const click = (find: (tree: unknown) => Drawn | null) => (find(view.tree)!.props.onClick as () => void)();
  /** A key pressed wherever focus is: the dialog hears it only from inside. */
  const press = (key: string) => {
    if (page.activeElement === BODY) return;
    const dialog = one(view.tree, el => el.props.role === "dialog")!;
    (dialog.props.onKeyDown as (e: unknown) => void)({ key, preventDefault() {}, stopPropagation() {} });
  };
  return { counter, click, press, tree: () => view.tree };
}

describe("a guide keeps focus when a step change takes the focused button away (#1803)", () => {
  it("opens on Next", () => {
    open();
    expect(page.activeElement).toBe(next);
  });

  it("hands focus to Next when Back goes with the first step, and the arrows still move", () => {
    const { counter, click, press, tree } = open();
    click(nextButton);
    expect(counter()).toBe("2 / 3");
    back.focus();
    click(backButton);
    expect(counter()).toBe("1 / 3");
    expect(backButton(tree())).toBeNull();
    expect(page.activeElement).toBe(next);
    press("ArrowRight");
    expect(counter()).toBe("2 / 3");
  });

  it("does the same for ArrowLeft pressed on Back", () => {
    const { counter, press } = open();
    press("ArrowRight");
    back.focus();
    press("ArrowLeft");
    expect(counter()).toBe("1 / 3");
    expect(page.activeElement).toBe(next);
    press("ArrowRight");
    expect(counter()).toBe("2 / 3");
  });

  it("does the same for the last step's aside, when an arrow leaves that step", () => {
    const { counter, press } = open();
    press("ArrowRight");
    press("ArrowRight");
    expect(counter()).toBe("3 / 3");
    aside.focus();
    press("ArrowLeft");
    expect(counter()).toBe("2 / 3");
    expect(page.activeElement).toBe(next);
  });

  it("leaves focus where the reader put it when nothing took it away", () => {
    // A step dot survives every step, so pressing one keeps the reader on it.
    const { counter, click, press } = open();
    press("ArrowRight");
    firstDot.focus();
    click(dotButton(1));
    expect(counter()).toBe("1 / 3");
    expect(page.activeElement).toBe(firstDot);
  });
});
