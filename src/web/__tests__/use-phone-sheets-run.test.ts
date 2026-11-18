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

/** An element's inline style: the transform keeps every value written to it, so
 *  a test can read what was written at the moment of a release. */
class StyleBox {
  history: string[] = [];
  transition: string | undefined;
  private value: string | undefined;
  get transform() { return this.value; }
  set transform(v: string | undefined) { this.value = v; this.history.push(String(v)); }
}

class FakeNode {
  attrs = new Map<string, string>();
  style = new StyleBox();
  tabIndex = 0;
  isConnected = true;
  children: FakeNode[] = [];
  /** What the web animations API was asked to run on it. */
  animations: Array<{ frames: Array<Record<string, string>>; options: Record<string, unknown>; cancelled: boolean }> = [];
  constructor(readonly name: string, private readonly doc: FakeDocument, readonly classes: string[] = [], readonly tag = "div") {}
  animate(frames: Array<Record<string, string>>, options: Record<string, unknown>) {
    const run = { frames, options, cancelled: false };
    this.animations.push(run);
    return { cancel() { run.cancelled = true; } };
  }
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
  /** Every part the page has drawn, which `querySelectorAll` answers from by
   *  selector: a part is found if its class (".name") or its tag is named. */
  page: FakeNode[] = [];
  app = new FakeNode("app", this, ["app"]);
  /** A popover or a dialog is in the page. */
  over: FakeNode | null = null;
  listeners = new Map<string, Array<(e: unknown) => void>>();
  node(name: string, classes: string[] = [], tag = "div") { return new FakeNode(name, this, classes, tag); }
  /** Draws a part of the page. */
  place(name: string, classes: string[] = [], tag = "div") {
    const part = this.node(name, classes, tag);
    this.page.push(part);
    return part;
  }
  querySelector(sel: string) {
    if (sel === ".app") return this.app;
    if (sel.startsWith(".anchored-popover")) return this.over;
    if (sel.startsWith(".usage-panel")) return this.sheets.usage ?? null;
    if (sel.startsWith(".sysdetail")) return this.sheets.machine ?? null;
    if (sel.startsWith(".accounts-panel")) return this.sheets.accounts ?? null;
    // CHANGED ON PURPOSE: the Inspector is inside the right column's wrapper.
    if (sel.startsWith(".app > .right-col > .detail")) return this.sheets.inspector ?? null;
    return null;
  }
  querySelectorAll(sel: string) {
    const parts = sel.split(",").map(s => s.trim());
    return this.page.filter(n => parts.some(p => (p.startsWith(".") ? n.classes.includes(p.slice(1)) : n.tag === p)));
  }
  addEventListener(type: string, fn: (e: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeEventListener(type: string, fn: (e: unknown) => void) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(f => f !== fn)); }
  fire(type: string, e: Record<string, unknown>) { for (const fn of this.listeners.get(type) ?? []) fn({ type, pointerId: 1, pointerType: "touch", preventDefault() {}, ...e }); }
}

let doc: FakeDocument;
let frames: Array<() => void>;
let width = 1280;
/** The page's children changed: every observer that is watching hears of it. */
let observers: Array<{ cb(): void; watching: boolean }> = [];
const mutate = () => { for (const o of observers.filter(x => x.watching)) o.cb(); };

function stubPage() {
  doc = new FakeDocument();
  frames = [];
  observers = [];
  vi.stubGlobal("document", doc);
  vi.stubGlobal("MutationObserver", class {
    private readonly record: { cb(): void; watching: boolean };
    constructor(cb: () => void) { this.record = { cb, watching: false }; observers.push(this.record); }
    observe() { this.record.watching = true; }
    disconnect() { this.record.watching = false; }
  });
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
  const holds = { accounts: vi.fn(), usage: vi.fn(), machine: vi.fn() };
  const doors = {
    accounts: doc.node("accounts door"), usage: doc.node("usage door"), machine: doc.node("machine door"),
    inspector: doc.node("session row"), sessions: doc.node("sessions door"),
  };
  let result!: ReturnType<typeof usePhoneSheets>;
  type P = { phone: boolean; open: Flags };
  const m = mount((p: P) => {
    result = usePhoneSheets({
      phone: p.phone, open: p.open, close: closes, onLeavePhone: left, hold: holds, home: () => doors.sessions,
      openers: { accounts: () => doors.accounts, usage: () => doors.usage, machine: () => doors.machine, inspector: () => doors.inspector },
    });
    return null;
  }, { phone: first.phone, open: { ...NONE, ...first.open } } as P);
  mounted.push(m);
  return {
    closes, left, doors, holds,
    get sheet() { return result.sheet; },
    closeSheet: (name?: Name) => result.closeSheet(name),
    set(phone: boolean, open: Partial<Flags> = {}) { m.rerender({ phone, open: { ...NONE, ...open } } as P); },
    unmount: () => m.unmount(),
  };
}

const SHEET_CLASS: Record<Name, string> = { accounts: "accounts-panel", usage: "usage-panel", machine: "sysdetail", inspector: "detail" };

/** The page has drawn this sheet, with a header to grab inside it. It is a part
 *  of the page, so a covered set that named it would find it. */
function draw(name: Name) {
  const sheet = doc.place(`${name} sheet`, [SHEET_CLASS[name]]);
  const header = doc.node(`${name} header`);
  sheet.children.push(header);
  doc.sheets[name] = sheet;
  return { sheet, header };
}

/** The top bar, the list, the board and the stage are what the scrim covers,
 *  with the skip link; the dock (with a door in it) is not among them. */
function coverPage() {
  const covered = [
    doc.place("topbar", ["topbar"], "header"), doc.place("left column", ["left-column"]),
    doc.place("main", [], "main"), doc.place("stage", ["stage-dock"]), doc.place("skip link", ["skip-link"], "a"),
  ];
  const dock = doc.place("dock", ["edge-dock"]);
  dock.children.push(doc.node("a door"));
  return { covered, dock };
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

  // CHANGED ON PURPOSE (the phone layout): the test said the sheet "carries on
  // from where the finger left it" but only checked that the inline offset was
  // cleared. The fake sheet now runs animations, so it checks the slide itself:
  // the offset written at the last move is where the close starts, and it ends
  // at the bottom edge.
  it("a quick pull down closes the sheet, which carries on from where the finger left it", () => {
    const { r, sheet, header } = grab();
    doc.fire("pointermove", { target: header, clientY: 130, timeStamp: 30 });
    doc.fire("pointermove", { target: header, clientY: 160, timeStamp: 60 });
    expect(sheet.style.transform).toBe("translateY(30px)");
    doc.fire("pointerup", { target: header, clientY: 160, timeStamp: 80 });
    expect(r.closes.usage).toHaveBeenCalledTimes(1);
    expect(sheet.style.transform, "the inline offset is cleared at the release").toBe("");
    const offsetAtRelease = sheet.style.history.at(-2);
    expect(offsetAtRelease, "the last offset the finger wrote").toBe("translateY(30px)");
    expect(sheet.animations).toHaveLength(1);
    const slide = sheet.animations[0];
    expect(slide.frames[0].transform, "the close starts from where the finger left it").toBe(offsetAtRelease);
    expect(slide.frames[1].transform, "and ends at the bottom edge").toBe("translateY(100%)");
    expect(slide.options.fill).toBe("forwards");
  });

  it("a sheet that comes back while the slide holds it down is not held there", () => {
    const { r, sheet, header } = grab();
    doc.fire("pointermove", { target: header, clientY: 130, timeStamp: 30 });
    doc.fire("pointermove", { target: header, clientY: 160, timeStamp: 60 });
    doc.fire("pointerup", { target: header, clientY: 160, timeStamp: 80 });
    r.set(true, {});
    r.set(true, { usage: true });
    expect(sheet.animations[0].cancelled).toBe(true);
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
  // CHANGED ON PURPOSE (the phone layout): the fake page used to answer every
  // selector with the same list and had nodes with no children, so "never on
  // the dock" and "no sheet inside" could not fail. It now answers by selector
  // and holds children.
  it("sets inert on the top bar, the list, the board, the stage and the skip link, never on the dock or the sheet", () => {
    const r = rig({ phone: true });
    const { covered, dock } = coverPage();
    const { sheet, header } = draw("usage");
    r.set(true, { usage: true });
    expect(covered.map(c => c.name)).toEqual(["topbar", "left column", "main", "stage", "skip link"]);
    for (const el of covered) expect(el.hasAttribute("inert"), el.name).toBe(true);
    expect(dock.hasAttribute("inert"), "the dock stays reachable").toBe(false);
    expect(dock.children.every(c => !c.hasAttribute("inert"))).toBe(true);
    expect(sheet.hasAttribute("inert")).toBe(false);
    expect(header.hasAttribute("inert")).toBe(false);
    // No sheet sits inside what was made inert, and none of it is a sheet's.
    for (const el of covered) {
      expect(el.contains(sheet), el.name).toBe(false);
      expect(el.contains(header), el.name).toBe(false);
    }
  });

  it("the deck's banner is inert while a sheet is up, and a banner that mounts after the sheet opened is made inert as it arrives", () => {
    const r = rig({ phone: true });
    const early = doc.place("version banner", ["ver-banner"]);
    draw("usage");
    r.set(true, { usage: true });
    expect(early.hasAttribute("inert")).toBe(true);
    const late = doc.place("connection banner", ["conn-banner"]);
    expect(late.hasAttribute("inert"), "not yet: nothing has told the hook").toBe(false);
    mutate();
    expect(late.hasAttribute("inert"), "the page's children changed").toBe(true);
    r.set(true, {});
    expect(early.hasAttribute("inert")).toBe(false);
    expect(late.hasAttribute("inert"), "and it is let go with the rest").toBe(false);
    // Nothing watches the page once the sheet has gone.
    expect(observers.every(o => !o.watching)).toBe(true);
  });

  it("a part that mounts while no sheet is up is left alone, and a node another owner made inert is not cleared", () => {
    const r = rig({ phone: true });
    const owned = doc.place("owned", ["ver-banner"]);
    owned.setAttribute("inert", "");
    draw("usage");
    r.set(true, { usage: true });
    mutate();
    r.set(true, {});
    expect(owned.hasAttribute("inert"), "someone else's inert stays").toBe(true);
    const after = doc.place("after", ["conn-banner"]);
    mutate();
    expect(after.hasAttribute("inert")).toBe(false);
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

  it("when what opened the sheet is gone (the session's row left the list), focus goes to the Sessions door", () => {
    const r = rig({ phone: true });
    const { header } = draw("inspector");
    r.set(true, { inspector: true });
    flushFrames();
    doc.activeElement = header;
    r.doors.inspector.isConnected = false;
    r.set(true, {});
    expect(doc.activeElement).toBe(r.doors.sessions);
  });
});

describe("crossing 640 keeps one sheet, the one on top, closes nothing and writes nothing", () => {
  // CHANGED ON PURPOSE (the phone layout): narrowing with several panels open
  // used to leave all of them open, with the bottom one named as the sheet.
  // Now the one on top keeps the screen and the others are held shut in
  // memory, through the panels' holds.
  it("narrowing with Usage, Machine and the Inspector open keeps the Inspector, the one on top, and holds the others", () => {
    const r = rig({ phone: false, open: { usage: true, machine: true, inspector: true } });
    r.set(true, { usage: true, machine: true, inspector: true });
    expect(r.sheet, "the sheet is the one the reader sees").toBe("inspector");
    expect(r.holds.usage).toHaveBeenCalledTimes(1);
    expect(r.holds.machine).toHaveBeenCalledTimes(1);
    expect(r.holds.accounts).not.toHaveBeenCalled();
    for (const n of ["usage", "machine", "inspector", "accounts"] as const) expect(r.closes[n], n).not.toHaveBeenCalled();
  });

  it("narrowing with Accounts and Usage open keeps Usage and holds Accounts", () => {
    const r = rig({ phone: false, open: { accounts: true, usage: true } });
    r.set(true, { accounts: true, usage: true });
    expect(r.sheet).toBe("usage");
    expect(r.holds.accounts).toHaveBeenCalledTimes(1);
    expect(r.holds.usage).not.toHaveBeenCalled();
  });

  it("a window already a phone's width holds nothing when a panel opens: that is one at a time", () => {
    const r = rig({ phone: true });
    r.set(true, { usage: true });
    r.set(true, { usage: true, machine: true });
    expect(r.holds.usage).not.toHaveBeenCalled();
    expect(r.closes.usage).toHaveBeenCalledTimes(1);
  });

  it("one-at-a-time applies to what is opened after the crossing", () => {
    const r = rig({ phone: false, open: { usage: true, machine: true, inspector: true } });
    r.set(true, { usage: true, machine: true, inspector: true });
    r.set(true, { usage: true, machine: true, inspector: true, accounts: true });
    expect(r.closes.usage).toHaveBeenCalledTimes(1);
    expect(r.closes.accounts).not.toHaveBeenCalled();
    expect(r.sheet).toBe("accounts");
  });

  it("widening takes no hold and asks for none", () => {
    const r = rig({ phone: true, open: { usage: true } });
    r.set(false, { usage: true, machine: true });
    expect(r.holds.usage).not.toHaveBeenCalled();
    expect(r.holds.machine).not.toHaveBeenCalled();
  });

  it("the crossing is settled in a layout effect, before a frame is painted", async () => {
    const { useEffect } = await import("react");
    const order: string[] = [];
    const m = mount((p: { phone: boolean }) => {
      // Declared ahead of the hook: among passive effects it would run first.
      useEffect(() => { order.push("passive"); }, [p.phone]);
      usePhoneSheets({ phone: p.phone, open: { ...NONE, usage: true }, close: { accounts() {}, usage() {}, machine() {}, inspector() {} }, onLeavePhone: () => { order.push("left"); } });
      return null;
    }, { phone: true });
    mounted.push(m);
    order.length = 0;
    m.rerender({ phone: false });
    expect(order).toEqual(["left", "passive"]);
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

describe("a window narrowed with several panels open draws one sheet, the one on top, and stores nothing", () => {
  /** The real hooks, as App wires them, on a wide window. */
  function deck(stored0: Record<string, string>) {
    width = 1600;
    stored = { "agent-dag.sessionListOpen": "0", "agent-dag.accountsPanelOpen": "0", "agent-dag.usagePanelOpen": "0",
      "agent-dag.systemPanelOpen": "0", "agent-dag.detailOpen": "0", ...stored0 };
    let left!: ReturnType<typeof useLeftColumn>;
    let right!: ReturnType<typeof useRightPanels>;
    let sheets!: ReturnType<typeof usePhoneSheets>;
    const m = mount((p: { phone: boolean }) => {
      left = useLeftColumn();
      right = useRightPanels(leftColumnWidth(left.panel));
      sheets = usePhoneSheets({
        phone: p.phone,
        open: { accounts: left.accountsPanelOpen, usage: right.usagePanelOpen, machine: right.machinePanelOpen, inspector: right.detailOpen },
        close: {
          accounts: left.closeAccountsPanel, usage: () => right.setUsagePanelOpen(false),
          machine: () => right.setMachinePanelOpen(false), inspector: () => right.setDetailOpen(false),
        },
        onLeavePhone: left.leavePhone,
        hold: { accounts: left.holdAccounts, usage: right.hold.usage, machine: right.hold.machine },
      });
      return null;
    }, { phone: false });
    mounted.push(m);
    const open = () => ({ accounts: left.accountsPanelOpen, usage: right.usagePanelOpen, machine: right.machinePanelOpen, inspector: right.detailOpen });
    return { m, left: () => left, right: () => right, sheet: () => sheets.sheet, open };
  }

  it("Accounts and Usage open at 1280, the window narrows: Usage is the one sheet, Accounts waits, nothing is stored", () => {
    const d = deck({ "agent-dag.accountsPanelOpen": "1", "agent-dag.usagePanelOpen": "1" });
    expect(d.open()).toEqual({ accounts: true, usage: true, machine: false, inspector: false });
    const settled = writes.length;
    const storedBefore = { ...stored };
    width = 390;
    d.m.rerender({ phone: true });
    expect(d.open(), "exactly one sheet is drawn").toEqual({ accounts: false, usage: true, machine: false, inspector: false });
    expect(d.sheet(), "and it is the top one").toBe("usage");
    expect(writes.length, "no flag is written").toBe(settled);
    expect(stored).toEqual(storedBefore);
    // One Esc closes it, and nothing else appears.
    expect(modalStack.dismissTop()).toBe(true);
    expect(d.open()).toEqual({ accounts: false, usage: false, machine: false, inspector: false });
    expect(d.sheet()).toBeNull();
    // Esc closed Usage on purpose, which is the reader's, and is stored.
    expect(stored["agent-dag.usagePanelOpen"]).toBe("0");
    expect(stored["agent-dag.accountsPanelOpen"], "Accounts' stored flag is as it was").toBe("1");
    vi.advanceTimersByTime(1000);
    expect(modalStack.depth()).toBe(0);
  });

  it("Usage, This machine and the Inspector open, the window narrows: the Inspector is the sheet, one Esc closes it only", () => {
    const d = deck({ "agent-dag.usagePanelOpen": "1", "agent-dag.systemPanelOpen": "1", "agent-dag.detailOpen": "1" });
    expect(d.open()).toEqual({ accounts: false, usage: true, machine: true, inspector: true });
    const settled = writes.length;
    width = 390;
    d.m.rerender({ phone: true });
    expect(d.open()).toEqual({ accounts: false, usage: false, machine: false, inspector: true });
    expect(d.sheet()).toBe("inspector");
    expect(writes.length, "no flag is written").toBe(settled);
    expect(modalStack.dismissTop()).toBe(true);
    expect(d.open(), "the Inspector closed and nothing came up in its place").toEqual({ accounts: false, usage: false, machine: false, inspector: false });
    expect(stored["agent-dag.usagePanelOpen"]).toBe("1");
    expect(stored["agent-dag.systemPanelOpen"]).toBe("1");
  });

  it("what was held waits shut when the window widens again, and the reader's own open ends the hold", () => {
    const d = deck({ "agent-dag.accountsPanelOpen": "1", "agent-dag.usagePanelOpen": "1" });
    width = 390;
    d.m.rerender({ phone: true });
    width = 1600;
    d.m.rerender({ phone: false });
    expect(d.open(), "the hold is the existing one: it ends on an open, not on a widening").toEqual({ accounts: false, usage: true, machine: false, inspector: false });
    d.left().toggleAccountsPanel();
    expect(d.left().accountsPanelOpen).toBe(true);
    expect(stored["agent-dag.accountsPanelOpen"]).toBe("1");
  });
});
