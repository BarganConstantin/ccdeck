// The phone sheets' hook, RUN: one at a time, Esc through the deck's dismiss
// stack, the flick and the tap that is not one, crossing 640 in both directions,
// a quick re-open during a close, what is inert under the scrim, and where focus
// goes. The rules themselves are phone-sheet.ts's and are tested in
// v4-phone-layout.test.ts; this runs the wiring.
//
// On fake-react.ts's React (the way phone-load-panels.test.ts runs the panels'
// hooks), against a stubbed window and a document of a few nodes that know what
// the hook asks of them: attributes, focus, containment, a bounding box.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("../feature-use", () => ({ useFeatureUse: () => {} }));

const { usePhoneSheets } = await import("../use-phone-sheets");
const { useLeftColumn, leftColumnWidth } = await import("../use-left-column");
const { useRightPanels } = await import("../use-right-panels");
const { modalStack } = await import("../modal-dismiss");

type Name = "accounts" | "usage" | "machine" | "inspector";
type Flags = Record<Name, boolean>;
const NONE: Flags = { accounts: false, usage: false, machine: false, inspector: false };

// ── a document of a few nodes ───────────────────────────────────────────────

class FakeNode {
  attrs = new Map<string, string>();
  style: Record<string, string> = {};
  tabIndex = 0;
  isConnected = true;
  children: FakeNode[] = [];
  constructor(readonly name: string, private readonly doc: FakeDocument) {}
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  removeAttribute(k: string) { this.attrs.delete(k); }
  hasAttribute(k: string) { return this.attrs.has(k); }
  focus() { this.doc.activeElement = this; this.doc.focused.push(this.name); }
  contains(o: unknown): boolean { return o === this || this.children.some(c => c.contains(o)); }
  closest() { return null; }
  getBoundingClientRect() { return { top: 100, height: 400 }; }
  setPointerCapture() { this.doc.captured += 1; }
  releasePointerCapture() {}
}

class FakeDocument {
  activeElement: FakeNode | null = null;
  focused: string[] = [];
  captured = 0;
  body = new FakeNode("body", this);
  /** What the page has drawn, by the part of the selector the hook asks with. */
  sheets: Partial<Record<Name, FakeNode>> = {};
  covered: FakeNode[] = [];
  /** A popover or a dialog is in the page. */
  over: FakeNode | null = null;
  listeners = new Map<string, Array<(e: unknown) => void>>();
  node(name: string) { return new FakeNode(name, this); }
  querySelector(sel: string) {
    if (sel.startsWith(".anchored-popover")) return this.over;
    if (sel.startsWith(".usage-panel")) return this.sheets.usage ?? null;
    if (sel.startsWith(".sysdetail")) return this.sheets.machine ?? null;
    if (sel.startsWith(".accounts-panel")) return this.sheets.accounts ?? null;
    if (sel.startsWith(".app > .detail")) return this.sheets.inspector ?? null;
    return null;
  }
  querySelectorAll(sel: string) { return sel.startsWith(".topbar") ? this.covered : []; }
  addEventListener(type: string, fn: (e: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeEventListener(type: string, fn: (e: unknown) => void) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(f => f !== fn)); }
  fire(type: string, e: Record<string, unknown>) { for (const fn of this.listeners.get(type) ?? []) fn({ type, pointerId: 1, pointerType: "touch", preventDefault() {}, ...e }); }
}

let doc: FakeDocument;
let frames: Array<() => void>;
let width = 1280;

function stubPage() {
  doc = new FakeDocument();
  frames = [];
  vi.stubGlobal("document", doc);
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    cancelAnimationFrame: () => {},
    get innerWidth() { return width; },
    matchMedia: (q: string) => ({ matches: q === "(max-width: 640px)" && width <= 640 }),
    localStorage: { getItem: (k: string) => stored[k] ?? null, setItem: (k: string, v: string) => { stored[k] = v; writes.push([k, v]); } },
  });
}
const flushFrames = () => { const run = frames; frames = []; for (const f of run) f(); };

let stored: Record<string, string> = {};
let writes: Array<[string, string]> = [];

beforeEach(() => {
  vi.useFakeTimers();
  stored = {};
  writes = [];
  width = 1280;
  stubPage();
});
/** Every hook mounted by a case, taken away after it so no sheet is left on the
 *  deck's one dismiss stack for the next. */
let mounted: Array<{ unmount(): void }> = [];

afterEach(() => {
  for (const m of mounted) m.unmount();
  mounted = [];
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── the hook on a page ──────────────────────────────────────────────────────

function rig(first: { phone: boolean; open?: Partial<Flags> }) {
  const closes = { accounts: vi.fn(), usage: vi.fn(), machine: vi.fn(), inspector: vi.fn() };
  const left = vi.fn();
  const doors = { accounts: doc.node("accounts door"), usage: doc.node("usage door"), machine: doc.node("machine door"), inspector: doc.node("session row") };
  let result!: ReturnType<typeof usePhoneSheets>;
  type P = { phone: boolean; open: Flags };
  const m = mount((p: P) => {
    result = usePhoneSheets({
      phone: p.phone, open: p.open, close: closes, onLeavePhone: left,
      openers: { accounts: () => doors.accounts, usage: () => doors.usage, machine: () => doors.machine, inspector: () => doors.inspector },
    });
    return null;
  }, { phone: first.phone, open: { ...NONE, ...first.open } } as P);
  mounted.push(m);
  return {
    closes, left, doors,
    get sheet() { return result.sheet; },
    closeSheet: (name?: Name) => result.closeSheet(name),
    set(phone: boolean, open: Partial<Flags> = {}) { m.rerender({ phone, open: { ...NONE, ...open } } as P); },
    unmount: () => m.unmount(),
  };
}

/** The page has drawn this sheet, with a header to grab inside it. */
function draw(name: Name) {
  const sheet = doc.node(`${name} sheet`);
  const header = doc.node(`${name} header`);
  sheet.children.push(header);
  doc.sheets[name] = sheet;
  return { sheet, header };
}

/** The top bar, the list, the board and the stage are what the scrim covers; the
 *  dock is not among them. */
function coverPage() {
  doc.covered = ["topbar", "left column", "main", "stage"].map(n => doc.node(n));
  return { covered: doc.covered, dock: doc.node("dock") };
}

describe("one sheet at a time, only on a phone", () => {
  it("opening Machine while Usage is up asks Usage to close and keeps Machine", () => {
    const r = rig({ phone: true });
    r.set(true, { usage: true });
    expect(r.sheet).toBe("usage");
    r.set(true, { usage: true, machine: true });
    expect(r.closes.usage).toHaveBeenCalledTimes(1);
    expect(r.closes.machine).not.toHaveBeenCalled();
    expect(r.sheet).toBe("machine");
  });

  it("asks for nothing to close on a wider window, where the panels sit side by side", () => {
    const r = rig({ phone: false });
    r.set(false, { usage: true });
    r.set(false, { usage: true, machine: true });
    expect(r.closes.usage).not.toHaveBeenCalled();
    expect(r.sheet).toBeNull();
  });
});

describe("Esc has one owner: the deck's dismiss stack", () => {
  it("a sheet on a phone is on the stack, and one Esc closes it once", () => {
    const r = rig({ phone: true });
    r.set(true, { usage: true });
    expect(modalStack.depth()).toBe(1);
    expect(modalStack.dismissTop()).toBe(true);
    expect(r.closes.usage).toHaveBeenCalledTimes(1);
    // A second Esc during the close is nothing.
    modalStack.dismissTop();
    expect(r.closes.usage).toHaveBeenCalledTimes(1);
    r.set(true, {});
    vi.advanceTimersByTime(1000);
    expect(modalStack.depth()).toBe(0);
  });

  it("on a wider window the sheet is not on the stack, so Esc is the canvas's", () => {
    const r = rig({ phone: false });
    r.set(false, { usage: true });
    expect(modalStack.depth()).toBe(0);
    expect(r.sheet).toBeNull();
  });

  it("with a popover in the page the sheet stands aside, and without one it closes", () => {
    const r = rig({ phone: true });
    r.set(true, { usage: true });
    doc.over = doc.node("anchored popover");
    modalStack.dismissTop();
    expect(r.closes.usage, "a popover is up: Esc is its").not.toHaveBeenCalled();
    doc.over = null;
    modalStack.dismissTop();
    expect(r.closes.usage, "nothing over it: Esc closes the sheet").toHaveBeenCalledTimes(1);
  });

  it("a popover opened over the sheet is asked first, because it is on the stack above it", () => {
    const r = rig({ phone: true });
    r.set(true, { usage: true });
    const popover = vi.fn();
    const off = modalStack.push(popover, 0, "popover");
    modalStack.dismissTop();
    expect(popover).toHaveBeenCalledTimes(1);
    expect(r.closes.usage).not.toHaveBeenCalled();
    off();
  });

  it("after an Esc close focus goes to the door that opened the sheet, not to the page", () => {
    const r = rig({ phone: true });
    coverPage();
    const { sheet } = draw("usage");
    r.set(true, { usage: true });
    flushFrames();
    expect(doc.activeElement).toBe(sheet);
    modalStack.dismissTop();
    r.set(true, {});
    expect(doc.activeElement).toBe(r.doors.usage);
  });
});

describe("one close, safe to ask twice, and a quick re-open stays open", () => {
  it("a second ask during the close is nothing; closing a named sheet closes that one", () => {
    const r = rig({ phone: true });
    r.set(true, { usage: true, inspector: false });
    r.closeSheet();
    r.closeSheet();
    expect(r.closes.usage).toHaveBeenCalledTimes(1);
    r.closeSheet("inspector");
    expect(r.closes.inspector).toHaveBeenCalledTimes(1);
  });

  it("closed and opened again inside the slide, the sheet stays open and no late close shuts it", () => {
    const r = rig({ phone: true });
    r.set(true, { inspector: true });
    r.closeSheet();
    r.set(true, {});
    r.set(true, { inspector: true });
    expect(r.sheet).toBe("inspector");
    // Back up, it can be closed again at once: the earlier close is over.
    r.closeSheet();
    expect(r.closes.inspector).toHaveBeenCalledTimes(2);
    // And no late close from the first one shuts it afterwards.
    r.set(true, { inspector: true });
    vi.advanceTimersByTime(2000);
    expect(r.closes.inspector, "only the two asked for").toHaveBeenCalledTimes(2);
  });
});

describe("the flick, and the tap that is not one", () => {
  /** A sheet is up and drawn, and the finger goes down on its header. */
  function grab(y = 110) {
    const r = rig({ phone: true });
    const { sheet, header } = draw("usage");
    r.set(true, { usage: true });
    const down = { target: header, clientY: y, timeStamp: 0 };
    doc.fire("pointerdown", down);
    return { r, sheet, header };
  }

  it("a quick pull down closes the sheet, which carries on from where the finger left it", () => {
    const { r, sheet, header } = grab();
    doc.fire("pointermove", { target: header, clientY: 130, timeStamp: 30 });
    doc.fire("pointermove", { target: header, clientY: 160, timeStamp: 60 });
    expect(sheet.style.transform).toBe("translateY(30px)");
    doc.fire("pointerup", { target: header, clientY: 160, timeStamp: 80 });
    expect(r.closes.usage).toHaveBeenCalledTimes(1);
    expect(sheet.style.transform, "the inline offset is handed to the close").toBe("");
  });

  it("a slow short pull lets go and the sheet returns", () => {
    const { r, sheet, header } = grab();
    doc.fire("pointermove", { target: header, clientY: 130, timeStamp: 1000 });
    doc.fire("pointerup", { target: header, clientY: 130, timeStamp: 1001 });
    expect(r.closes.usage).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe("");
    expect(sheet.hasAttribute("data-sheet-dragging")).toBe(false);
  });

  it("a tap with a little jitter is left alone: no drag, no capture, no close", () => {
    const { r, sheet, header } = grab();
    doc.fire("pointermove", { target: header, clientY: 112, timeStamp: 16 });
    expect(sheet.style.transform, "6px or less of travel moves nothing").toBeUndefined();
    doc.fire("pointermove", { target: header, clientY: 116, timeStamp: 32 });
    doc.fire("pointerup", { target: header, clientY: 116, timeStamp: 33 });
    expect(r.closes.usage).not.toHaveBeenCalled();
    expect(doc.captured).toBe(0);
  });

  it("the drag begins at 8px and follows the finger from there, without jumping", () => {
    const { sheet, header } = grab();
    doc.fire("pointermove", { target: header, clientY: 118, timeStamp: 20 });
    expect(sheet.style.transform).toBe("translateY(0px)");
    doc.fire("pointermove", { target: header, clientY: 148, timeStamp: 40 });
    expect(sheet.style.transform).toBe("translateY(30px)");
    expect(doc.captured).toBe(1);
  });

  it("crossing 640 in the middle of a drag leaves nothing on the panel", () => {
    const { r, sheet, header } = grab();
    doc.fire("pointermove", { target: header, clientY: 150, timeStamp: 40 });
    expect(sheet.hasAttribute("data-sheet-dragging")).toBe(true);
    r.set(false, { usage: true });
    expect(sheet.style.transform).toBe("");
    expect(sheet.style.transition).toBe("");
    expect(sheet.hasAttribute("data-sheet-dragging")).toBe(false);
  });
});

describe("what is under the scrim is inert, and focus is in the sheet", () => {
  it("sets inert on the top bar, the list, the board and the stage, never on the dock or the sheet", () => {
    const r = rig({ phone: true });
    const { covered, dock } = coverPage();
    const { sheet } = draw("usage");
    r.set(true, { usage: true });
    for (const el of covered) expect(el.hasAttribute("inert"), el.name).toBe(true);
    expect(dock.hasAttribute("inert")).toBe(false);
    expect(sheet.hasAttribute("inert")).toBe(false);
    // No sheet sits inside what was made inert.
    for (const el of covered) expect(el.contains(sheet), el.name).toBe(false);
  });

  it("takes inert off the moment the sheet starts leaving, and when the window grows", () => {
    const r = rig({ phone: true });
    const { covered } = coverPage();
    draw("usage");
    r.set(true, { usage: true });
    r.set(true, {});
    for (const el of covered) expect(el.hasAttribute("inert"), `${el.name} while the sheet slides`).toBe(false);
    r.set(true, { usage: true });
    for (const el of covered) expect(el.hasAttribute("inert"), el.name).toBe(true);
    r.set(false, { usage: true });
    for (const el of covered) expect(el.hasAttribute("inert"), `${el.name} on a wide window`).toBe(false);
  });

  it("moves focus into the sheet's own container when it opens, without a Tab trap", () => {
    const r = rig({ phone: true });
    const { sheet } = draw("machine");
    r.set(true, { machine: true });
    flushFrames();
    expect(sheet.tabIndex).toBe(-1);
    expect(doc.activeElement).toBe(sheet);
  });

  it("waits a few frames for a sheet that is drawn a render after its flag", () => {
    const r = rig({ phone: true });
    r.set(true, { usage: true });
    flushFrames();
    expect(doc.activeElement).toBeNull();
    const { sheet } = draw("usage");
    flushFrames();
    expect(doc.activeElement).toBe(sheet);
    expect(r.sheet).toBe("usage");
  });

  it("returns focus to the opener on close when it was in the sheet or on the page, and leaves it where the reader put it", () => {
    const r = rig({ phone: true });
    const { header } = draw("inspector");
    r.set(true, { inspector: true });
    flushFrames();
    doc.activeElement = header;
    r.set(true, {});
    expect(doc.activeElement, "was inside the sheet").toBe(r.doors.inspector);

    doc.activeElement = null;
    r.set(true, { inspector: true });
    flushFrames();
    doc.activeElement = doc.body;
    r.set(true, {});
    expect(doc.activeElement, "had fallen to the page").toBe(r.doors.inspector);

    r.set(true, { inspector: true });
    flushFrames();
    const elsewhere = doc.node("another door");
    doc.activeElement = elsewhere;
    r.set(true, {});
    expect(doc.activeElement, "the reader had moved it").toBe(elsewhere);
  });

  it("does not take focus anywhere when the window grows past a phone", () => {
    const r = rig({ phone: true });
    draw("usage");
    r.set(true, { usage: true });
    flushFrames();
    const before = doc.focused.length;
    r.set(false, { usage: true });
    expect(doc.focused.length).toBe(before);
  });
});

describe("crossing 640 closes nothing and writes nothing", () => {
  it("narrowing the window with Usage, Machine and the Inspector open keeps all three open", () => {
    const r = rig({ phone: false, open: { usage: true, machine: true, inspector: true } });
    r.set(true, { usage: true, machine: true, inspector: true });
    for (const n of ["usage", "machine", "inspector", "accounts"] as const) expect(r.closes[n], n).not.toHaveBeenCalled();
    // One-at-a-time applies to what is opened from here on.
    r.set(true, { usage: true, machine: true, inspector: true, accounts: true });
    expect(r.closes.usage).toHaveBeenCalledTimes(1);
    expect(r.closes.accounts).not.toHaveBeenCalled();
    expect(r.sheet).toBe("accounts");
  });

  it("tells the page the window grew past a phone, and only then", () => {
    const r = rig({ phone: true });
    r.set(false);
    expect(r.left).toHaveBeenCalledTimes(1);
    r.set(true);
    expect(r.left).toHaveBeenCalledTimes(1);
  });

  it("writes nothing of the panels' stored state either way, and the evicted Accounts comes back with the list gone", () => {
    width = 1600;
    stored = { "agent-dag.sessionListOpen": "1", "agent-dag.accountsPanelOpen": "1", "agent-dag.usagePanelOpen": "1", "agent-dag.systemPanelOpen": "1" };
    let left!: ReturnType<typeof useLeftColumn>;
    let right!: ReturnType<typeof useRightPanels>;
    const m = mount((p: { phone: boolean }) => {
      left = useLeftColumn();
      right = useRightPanels(leftColumnWidth(left.panel));
      usePhoneSheets({
        phone: p.phone,
        open: { accounts: left.accountsPanelOpen, usage: right.usagePanelOpen, machine: right.machinePanelOpen, inspector: right.detailOpen },
        close: {
          accounts: left.closeAccountsPanel, usage: () => right.setUsagePanelOpen(false),
          machine: () => right.setMachinePanelOpen(false), inspector: () => right.setDetailOpen(false),
        },
        onLeavePhone: left.leavePhone,
      });
      return null;
    }, { phone: false });
    mounted.push(m);
    const settled = writes.length;
    const panels = () => ({ list: left.sessionListOpen, accounts: left.accountsPanelOpen, usage: right.usagePanelOpen, machine: right.machinePanelOpen });
    const desktop = panels();

    // Desktop to phone and back, with the panels as they were.
    width = 390;
    m.rerender({ phone: true });
    expect(panels(), "narrowing changes no panel").toEqual(desktop);
    width = 1600;
    m.rerender({ phone: false });
    expect(panels(), "widening changes none either").toEqual(desktop);
    expect(writes.length, "and no flag is stored").toBe(settled);

    // On a phone, with Accounts a sheet over the open list: the window grows.
    width = 390;
    m.rerender({ phone: true });
    left.openAccountsPanel();
    if (!left.sessionListOpen) left.toggleSessionList();
    expect(left.accountsPanelOpen && left.sessionListOpen).toBe(true);
    const before = writes.length;
    const stored1 = { ...stored };
    width = 1600;
    m.rerender({ phone: false });
    expect(left.sessionListOpen, "the list keeps the column").toBe(true);
    expect(left.accountsPanelOpen, "Accounts waits behind it").toBe(false);
    expect(writes.length, "waiting is not the reader closing it: nothing is stored").toBe(before);
    expect(stored).toEqual(stored1);
    left.toggleSessionList();
    expect(left.accountsPanelOpen, "the list goes and Accounts is back").toBe(true);
  });
});
