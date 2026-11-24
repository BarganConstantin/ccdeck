// The split between Sessions and Accounts in the left column (2026-11-24).
//
// The owner: with both open, the line between Sessions and Accounts should be
// draggable, as the one between Usage and This machine is in Workspace, so a
// short session list gives its room to the accounts under it, or the other
// way round, and the share is kept. The rules are pure functions and run as a
// table; the split runs under fake-react with stand-ins for the elements it
// writes; the sheet and App's wiring are read from their source.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("react", async () => (await import("./fake-react")).react);

const { mount, one } = await import("./fake-react");
const {
  ACCOUNTS_MIN, SESSIONS_MIN, STACK_KEY, STACK_KEY_STEP, STACK_KEY_STEP_BIG, STACK_SPLIT_H,
  parseStackShare, stackShareFor, useStackShare,
} = await import("../stack-split");
const { default: StackSplit } = await import("../components/StackSplit");
const { default: LeftColumn } = await import("../components/LeftColumn");
type El = import("./fake-react").Drawn;

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let store: Map<string, string>;
type Heard = { type: string; fn: (e: unknown) => void; capture: boolean };
let heard: Heard[];
/** The window's keydown listeners in the capture phase: the drag's Esc. */
const escapes = () => heard.filter(h => h.type === "keydown" && h.capture);
const pressOnWindow = (k: string) => {
  const e = { key: k, stopped: false, prevented: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  for (const h of escapes()) h.fn(e);
  return e;
};
beforeEach(() => {
  store = new Map();
  heard = [];
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
    innerWidth: 1440,
    dispatchEvent() { return true; },
    addEventListener(type: string, fn: (e: unknown) => void, capture?: boolean) { heard.push({ type, fn, capture: capture === true }); },
    removeEventListener(type: string, fn: (e: unknown) => void, capture?: boolean) {
      heard = heard.filter(h => !(h.type === type && h.fn === fn && h.capture === (capture === true)));
    },
  };
});
afterEach(() => { delete (globalThis as Record<string, unknown>).window; });

describe("the numbers", () => {
  it("is 8 px high, keeps 140 for Sessions and 160 for Accounts, moves 8 a key and 32 with Shift", () => {
    expect(STACK_SPLIT_H).toBe(8);
    expect([SESSIONS_MIN, ACCOUNTS_MIN]).toEqual([140, 160]);
    expect([STACK_KEY_STEP, STACK_KEY_STEP_BIG]).toEqual([8, 32]);
    expect(STACK_KEY).toBe("agent-dag.leftColumnStack");
  });

  it("reads a kept share between 0 and 1, and nothing from a missing or broken one", () => {
    expect(parseStackShare(null)).toBeNull();
    expect(parseStackShare("")).toBeNull();
    expect(parseStackShare("tall")).toBeNull();
    expect(parseStackShare("0")).toBeNull();
    expect(parseStackShare("1")).toBeNull();
    expect(parseStackShare("-0.2")).toBeNull();
    expect(parseStackShare("1.5")).toBeNull();
    expect(parseStackShare("0.4")).toBe(0.4);
    expect(parseStackShare("0.12345")).toBe(0.123);
  });

  it("gives Sessions the share of the room the split stands at, each part kept at its least", () => {
    // 700 px of column, 692 between the two parts.
    expect(stackShareFor(300, 692)).toBe(0.434);
    expect(stackShareFor(10, 692), "Sessions keeps 140").toBe(0.202);
    expect(stackShareFor(690, 692), "Accounts keeps 160").toBe(0.769);
  });

  it("shares a column too short for both minimums as their own proportion, and a column with no room in half", () => {
    expect(stackShareFor(250, 200)).toBe(0.467);
    expect(stackShareFor(150, 300)).toBe(0.467);
    expect(stackShareFor(100, 0)).toBe(0.5);
    expect(stackShareFor(100, Number.NaN)).toBe(0.5);
  });
});

describe("the kept share", () => {
  it("is written when one is chosen, refused when it is not a share, and removed on a reset", () => {
    let api: ReturnType<typeof useStackShare> | null = null;
    mount(() => { api = useStackShare(); return null; }, {});
    expect(api!.share).toBeNull();
    api!.choose(0.4567);
    expect(store.get(STACK_KEY)).toBe("0.457");
    expect(api!.share).toBe(0.457);
    api!.choose(1.2);
    expect(store.get(STACK_KEY)).toBe("0.457");
    api!.reset();
    expect(store.has(STACK_KEY)).toBe(false);
    expect(api!.share).toBeNull();
  });

  it("comes back on the next load, and a broken one reads as none", () => {
    store.set(STACK_KEY, "0.3");
    let api: ReturnType<typeof useStackShare> | null = null;
    mount(() => { api = useStackShare(); return null; }, {});
    expect(api!.share).toBe(0.3);
    store.set(STACK_KEY, "wide");
    mount(() => { api = useStackShare(); return null; }, {});
    expect(api!.share).toBeNull();
  });
});

/** A stand-in for the split and the column a drag writes: the column's top at
 *  40, 700 high, and the split `at` px under its top. */
function elements(at = 300) {
  const column = {
    clientHeight: 700,
    style: {
      values: new Map<string, string>(),
      setProperty(k: string, v: string) { this.values.set(k, v); },
      removeProperty(k: string) { this.values.delete(k); },
    },
    attrs: new Map<string, string>(),
    setAttribute(k: string, v: string) { this.attrs.set(k, v); },
    removeAttribute(k: string) { this.attrs.delete(k); },
    getBoundingClientRect() { return { top: 40 }; },
  };
  const split = {
    attrs: new Map<string, string>(), captured: new Set<number>(), focused: false,
    setPointerCapture(id: number) { this.captured.add(id); },
    hasPointerCapture(id: number) { return this.captured.has(id); },
    releasePointerCapture(id: number) { this.captured.delete(id); },
    focus() { this.focused = true; },
    setAttribute(k: string, v: string) { this.attrs.set(k, v); },
    getBoundingClientRect() { return { top: 40 + at }; },
    closest(sel: string) { return sel === ".left-column" ? column : null; },
  };
  return { column, split };
}

describe("the split", () => {
  const drawn = (p: Partial<Parameters<typeof StackSplit>[0]> = {}) => {
    const calls = { share: [] as number[], reset: 0 };
    const m = mount(StackSplit, {
      share: null,
      onShare: (s: number) => calls.share.push(s), onReset: () => { calls.reset++; },
      ...p,
    });
    const split = () => one(m.tree, el => String(el.props.className ?? "").startsWith("stack-split")) as El;
    return { m, calls, split };
  };
  const key = (el: El, k: string, shiftKey = false, at = 300) => {
    const e = { key: k, shiftKey, defaultPrevented: false, stopped: false, currentTarget: elements(at).split,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    (el.props.onKeyDown as (e: unknown) => void)(e);
    return e;
  };
  const pointer = (clientY: number, target: unknown, more: Record<string, unknown> = {}) => ({
    button: 0, pointerId: 7, clientY, currentTarget: target,
    preventDefault() {}, stopPropagation() {}, ...more,
  });

  it("is a horizontal separator a keyboard can reach, named, for the list above it", () => {
    const s = drawn().split();
    expect(s.props.role).toBe("separator");
    expect(s.props.tabIndex).toBe(0);
    expect(s.props["aria-orientation"]).toBe("horizontal");
    expect(s.props["aria-controls"]).toBe("session-list");
    expect([s.props["aria-valuemin"], s.props["aria-valuemax"]]).toEqual([0, 100]);
    expect(s.props["aria-label"]).toBe("Share of the height between Sessions and Accounts");
    expect(s.props.title).toBe("Drag to share the height · arrow keys move it · double-click resets it");
  });

  it("moves 8 px an arrow, 32 with Shift, down gives Sessions more; Home and End to each part's least; other keys are the deck's", () => {
    const { calls, split } = drawn();
    expect(key(split(), "ArrowDown").stopped).toBe(true);
    key(split(), "ArrowDown", true);
    key(split(), "ArrowUp");
    key(split(), "ArrowUp", true);
    key(split(), "Home");
    key(split(), "End");
    const other = key(split(), "a");
    expect([other.defaultPrevented, other.stopped]).toEqual([false, false]);
    // From 300 of 692: 308, 332, 292, 268, then 140 and 692 - 160.
    expect(calls.share).toEqual([0.445, 0.48, 0.422, 0.387, 0.202, 0.769]);
  });

  it("gives the column back its own layout on Enter and on a double click", () => {
    const { calls, split } = drawn({ share: 0.6 });
    key(split(), "Enter");
    (split().props.onDoubleClick as (e: unknown) => void)({ preventDefault() {} });
    expect(calls.reset).toBe(2);
    expect(calls.share).toEqual([]);
  });

  it("drags the column with the pointer, takes no focus, and settles once on release", () => {
    const { calls, split } = drawn();
    const el = elements();
    const s = split();
    (s.props.onPointerDown as (e: unknown) => void)(pointer(500, el.split));
    expect(el.split.captured.has(7)).toBe(true);
    expect(el.split.focused).toBe(false);
    expect(escapes()).toHaveLength(1);
    expect(el.column.attrs.has("data-stack-resizing")).toBe(true);
    (s.props.onPointerMove as (e: unknown) => void)(pointer(530, el.split));
    (s.props.onPointerMove as (e: unknown) => void)(pointer(560, el.split));
    expect(el.column.style.values.get("--stack-share")).toBe("0.52");
    expect(el.column.attrs.has("data-stack-share"), "the share rule holds while nothing was kept yet").toBe(true);
    expect(el.split.attrs.get("aria-valuenow")).toBe("52");
    expect(calls.share).toEqual([]);
    (s.props.onPointerUp as (e: unknown) => void)(pointer(560, el.split));
    (s.props.onLostPointerCapture as (e: unknown) => void)(pointer(560, el.split));
    expect(calls.share).toEqual([0.52]);
    expect(el.column.attrs.has("data-stack-resizing")).toBe(false);
    expect(escapes()).toHaveLength(0);
    expect(pressOnWindow("Escape").stopped).toBe(false);
  });

  it("holds the drag to each part's least", () => {
    const { calls, split } = drawn();
    const el = elements();
    const s = split();
    (s.props.onPointerDown as (e: unknown) => void)(pointer(500, el.split));
    (s.props.onPointerMove as (e: unknown) => void)(pointer(2000, el.split));
    expect(el.column.style.values.get("--stack-share")).toBe("0.769");
    (s.props.onPointerMove as (e: unknown) => void)(pointer(-1000, el.split));
    (s.props.onPointerUp as (e: unknown) => void)(pointer(-1000, el.split));
    expect(calls.share).toEqual([0.202]);
  });

  it("puts the column back as React drew it when the browser takes the pointer, or on Esc", () => {
    const cancelled = drawn({ share: 0.6 });
    const a = elements();
    const s = cancelled.split();
    (s.props.onPointerDown as (e: unknown) => void)(pointer(500, a.split));
    (s.props.onPointerMove as (e: unknown) => void)(pointer(400, a.split));
    (s.props.onPointerCancel as (e: unknown) => void)(pointer(400, a.split));
    expect(cancelled.calls.share).toEqual([]);
    expect(a.column.style.values.get("--stack-share")).toBe("0.6");
    expect(a.column.attrs.has("data-stack-share")).toBe(true);
    expect(a.column.attrs.has("data-stack-resizing")).toBe(false);

    const escaped = drawn();
    const b = elements();
    const t = escaped.split();
    (t.props.onPointerDown as (e: unknown) => void)(pointer(500, b.split));
    (t.props.onPointerMove as (e: unknown) => void)(pointer(560, b.split));
    expect(pressOnWindow("a").stopped).toBe(false);
    const esc = pressOnWindow("Escape");
    expect([esc.stopped, esc.prevented]).toEqual([true, true]);
    expect(b.split.captured.has(7)).toBe(false);
    expect(escapes()).toHaveLength(0);
    (t.props.onPointerUp as (e: unknown) => void)(pointer(560, b.split));
    expect(escaped.calls.share).toEqual([]);
    // Nothing was kept: the column lays the two out itself again.
    expect(b.column.style.values.has("--stack-share")).toBe(false);
    expect(b.column.attrs.has("data-stack-share")).toBe(false);
  });

  it("puts the column back and stops listening for Esc when a panel goes mid-drag", () => {
    const { m, split } = drawn();
    const el = elements();
    (split().props.onPointerDown as (e: unknown) => void)(pointer(500, el.split));
    (split().props.onPointerMove as (e: unknown) => void)(pointer(560, el.split));
    expect(escapes()).toHaveLength(1);
    m.unmount();
    expect(escapes()).toHaveLength(0);
    expect(el.column.attrs.has("data-stack-resizing")).toBe(false);
    expect(el.column.attrs.has("data-stack-share")).toBe(false);
  });

  it("settles nothing for a press that does not move, and ignores any button but the main one", () => {
    const { calls, split } = drawn();
    const el = elements();
    (split().props.onPointerDown as (e: unknown) => void)(pointer(500, el.split, { button: 2 }));
    expect(el.split.captured.size).toBe(0);
    expect(el.column.attrs.has("data-stack-resizing")).toBe(false);
    (split().props.onPointerDown as (e: unknown) => void)(pointer(500, el.split));
    (split().props.onPointerUp as (e: unknown) => void)(pointer(500, el.split));
    expect(calls.share).toEqual([]);
  });

  it("leaves with the panel that goes, as the panels do", () => {
    expect(drawn().split().props.className).toBe("stack-split");
    expect(drawn({ leaving: true }).split().props.className).toBe("stack-split leaving");
  });
});

describe("the column", () => {
  const column = (stackShare: number | null) => {
    const m = mount(LeftColumn, { width: 288, listWidth: 288, stackShare, children: null });
    return one(m.tree, el => el.props.className === "left-column") as El;
  };

  it("carries the kept share as --stack-share, marked for the share rule", () => {
    const kept = column(0.35);
    expect(kept.props["data-stack-share"]).toBe("");
    expect((kept.props.style as Record<string, string>)["--stack-share"]).toBe("0.35");
  });

  it("carries nothing when no share is kept", () => {
    const own = column(null);
    expect(own.props["data-stack-share"]).toBeUndefined();
    expect((own.props.style as Record<string, string>)["--stack-share"]).toBeUndefined();
  });
});

describe("the sheet", () => {
  const sheet = read("styles/left-column.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const workspace = read("styles/workspace.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const body = (src: string, sel: string) => {
    const at = src.indexOf(`${sel} {`);
    expect(at, sel).toBeGreaterThanOrEqual(0);
    return src.slice(src.indexOf("{", at) + 1, src.indexOf("}", at)).split(";").map(d => d.trim()).filter(Boolean);
  };

  it("looks like the split between Usage and This machine in Workspace", () => {
    const own = body(sheet, ".left-column > .stack-split");
    const theirs = body(workspace, '.app[data-view="workspace"] .ws-split');
    for (const d of theirs) expect(own, d).toContain(d);
    expect(body(sheet, ".left-column > .stack-split::after"))
      .toEqual(body(workspace, '.app[data-view="workspace"] .ws-split::after'));
  });

  it("darkens its grip when pointed at, held or focused, and rings it in the accent when focused", () => {
    expect(sheet).toMatch(/\.left-column > \.stack-split:focus-visible::after,\s*\.left-column\[data-stack-resizing\] > \.stack-split::after \{ background: var\(--muted\); \}/);
    expect(sheet).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{\s*\.left-column > \.stack-split:hover::after \{ background: var\(--muted\); \}/);
    expect(sheet).toMatch(/\.left-column > \.stack-split:focus-visible \{ outline: var\(--focus-w\) solid var\(--accent\); outline-offset: calc\(-1 \* var\(--focus-w\)\); \}/);
    expect(sheet).toContain(".left-column[data-stack-resizing] { user-select: none; }");
  });

  it("draws its own two lines in place of Accounts' top border", () => {
    expect(sheet).toContain(".left-column > .stack-split ~ .accounts-panel { border-top: 0; }");
  });

  it("gives Sessions the kept share, clamped as stackShareFor clamps it, and Accounts the rest, only while the split is drawn", () => {
    const list = body(sheet, ".left-column[data-stack-share] > .session-list:has(~ .stack-split)").join(";").replace(/\s+/g, " ");
    expect(list).toContain("flex: 0 0 clamp( min(140px, (100% - 8px) * 140 / 300), (100% - 8px) * var(--stack-share), max(100% - 168px, (100% - 8px) * 140 / 300))");
    expect(list).toContain("min-height: 0");
    expect(body(sheet, ".left-column[data-stack-share] > .stack-split ~ .accounts-panel")).toEqual(["flex: 1 1 0", "min-height: 0"]);
    // Before the phone's rules, where no split is drawn.
    expect(sheet.indexOf(".left-column > .stack-split {")).toBeLessThan(sheet.indexOf("@media (max-width: 640px)"));
  });

  it("keeps the grip in a Contrast theme, in the text colour, and in the highlight while held or focused", () => {
    const forced = read("styles/touch-and-forced-colours.css");
    expect(forced).toContain(".left-column > .stack-split::after { forced-color-adjust: none; background: CanvasText; }");
    expect(forced).toMatch(/\.left-column > \.stack-split:focus-visible::after,\s*\.left-column\[data-stack-resizing\] > \.stack-split::after \{ background: Highlight; \}/);
  });
});

describe("App's wiring", () => {
  const app = code("App.tsx");
  const open = app.indexOf("<LeftColumn width={leftColumnTarget}");
  const inColumn = app.slice(open, app.indexOf("</LeftColumn>", open));

  it("draws the split between Sessions and Accounts, never on a phone", () => {
    const list = inColumn.indexOf("<SessionList");
    const split = inColumn.indexOf("<StackSplit");
    const accounts = inColumn.indexOf("{!phone && accountsNodes}");
    expect(list).toBeGreaterThan(0);
    expect(split).toBeGreaterThan(list);
    expect(accounts).toBeGreaterThan(split);
    expect(inColumn).toContain("{!phone && sessionListDrawn && accountsDrawn && (");
    expect(inColumn).toMatch(/leaving=\{isLeaving\(listOnScreen, sessionListPhase\) \|\| isLeaving\(accountsOnScreen, accountsPhase\)\}/);
  });

  it("keeps one share for the Board and Workspace, and none on a phone", () => {
    expect(app).toContain("const stackChoice = useStackShare();");
    expect(inColumn).toContain("stackShare={phone ? null : stackChoice.share}");
    expect(inColumn).toContain("<StackSplit share={stackChoice.share} onShare={stackChoice.choose} onReset={stackChoice.reset}");
  });
});
