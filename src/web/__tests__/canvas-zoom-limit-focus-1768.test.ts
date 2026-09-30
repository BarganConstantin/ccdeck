// #1768: Zoom in and Zoom out keep their focus at the ends of the zoom range.
//
// Both went `disabled` at their limit, and a button that becomes disabled while
// it holds focus drops that focus to <body>: three Enters on Zoom in from 1.0
// reach the 1.6 ceiling, the button goes dead under the keyboard, and the next
// Tab starts over at the top of the document. The deck's rule for a control
// that may hold focus is to refuse with aria-disabled and ignore the press
// (#518/#620), which is what these two do now.
//
// No DOM here. React Flow's store is mocked to a transform sitting at a limit
// and its Controls frame to a plain wrapper; ControlButton is React Flow's own,
// so the markup is what the browser would get. The press is the button's own
// onClick, read off the element tree.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const rf = vi.hoisted(() => ({
  state: { transform: [0, 0, 1] as [number, number, number], minZoom: 0.2, maxZoom: 1.6 },
  zoomIn: (() => {}) as () => void,
  zoomOut: (() => {}) as () => void,
}));

vi.mock("reactflow", async importOriginal => {
  const actual = await importOriginal<typeof import("reactflow")>();
  return {
    ...actual,
    Controls: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    useStore: (select: (s: typeof rf.state) => unknown) => select(rf.state),
    useReactFlow: () => ({ zoomIn: () => rf.zoomIn(), zoomOut: () => rf.zoomOut() }),
  };
});

import CanvasControls from "../components/CanvasControls";

const props = {
  autoFitDisabled: false,
  enableAutoFitAndRefit: () => {},
  paused: false,
  pauseGate: { size: 0, dropped: 0 } as never,
  togglePause: () => {},
  handleRelayout: () => {},
  requestClear: () => {},
  setKeyHelpOpen: () => {},
};

const at = (zoom: number) => { rf.state = { ...rf.state, transform: [0, 0, zoom] }; };

/** The `<button …>` opening tag carrying this accessible name. */
function buttonTag(label: string): string {
  const html = renderToStaticMarkup(createElement(CanvasControls, props));
  const tag = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
  if (!tag) throw new Error(`no button named ${label}`);
  return tag;
}

/** Press the button carrying this accessible name, the way a click would. */
function press(label: string) {
  const tree = CanvasControls(props) as ReactElement<{ children: ReactNode }>;
  const kids = ([] as ReactNode[]).concat(tree.props.children) as ReactElement<{ "aria-label"?: string; onClick?: () => void }>[];
  const button = kids.find(k => k?.props?.["aria-label"] === label);
  if (!button) throw new Error(`no button named ${label}`);
  button.props.onClick?.();
}

describe("CanvasControls — the zoom pair at the ends of the range", () => {
  let zoomIn: ReturnType<typeof vi.fn>;
  let zoomOut: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    zoomIn = vi.fn(); zoomOut = vi.fn();
    rf.zoomIn = zoomIn; rf.zoomOut = zoomOut;
  });

  it("keeps Zoom in focusable at the ceiling, reports it refused, and ignores the press", () => {
    at(1.6);
    const tag = buttonTag("Zoom in");
    expect(tag).toContain('aria-disabled="true"');
    expect(tag).not.toMatch(/\sdisabled(=|\s|>)/);
    press("Zoom in");
    expect(zoomIn).not.toHaveBeenCalled();
  });

  it("keeps Zoom out focusable at the floor, reports it refused, and ignores the press", () => {
    at(0.2);
    const tag = buttonTag("Zoom out");
    expect(tag).toContain('aria-disabled="true"');
    expect(tag).not.toMatch(/\sdisabled(=|\s|>)/);
    press("Zoom out");
    expect(zoomOut).not.toHaveBeenCalled();
  });

  it("leaves both live and unmarked inside the range", () => {
    at(1);
    for (const label of ["Zoom in", "Zoom out"]) {
      const tag = buttonTag(label);
      expect(tag, label).not.toContain("aria-disabled");
      expect(tag, label).not.toMatch(/\sdisabled(=|\s|>)/);
    }
    press("Zoom in");
    press("Zoom out");
    expect(zoomIn).toHaveBeenCalledTimes(1);
    expect(zoomOut).toHaveBeenCalledTimes(1);
  });

  it("still lets the other end move: Zoom out works at the ceiling, Zoom in at the floor", () => {
    at(1.6);
    expect(buttonTag("Zoom out")).not.toContain("aria-disabled");
    press("Zoom out");
    expect(zoomOut).toHaveBeenCalledTimes(1);
    at(0.2);
    expect(buttonTag("Zoom in")).not.toContain("aria-disabled");
    press("Zoom in");
    expect(zoomIn).toHaveBeenCalledTimes(1);
  });
});
