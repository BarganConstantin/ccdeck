// A Workspace pane's tab closes from a × of its own, as a browser's or an
// editor's tab does (PaneTabs.tsx StripTab, workspace-split.css). Under the
// pointer, or with the keyboard on it, a tab draws a × at its end, the tab on
// show too; at rest none does. A press on it closes the tab as a middle press
// does: the session runs on, the tab beside it comes on, and the tab is never
// shown first. Tab and × are two buttons side by side in one slot, never one
// inside the other, and the × is no tab stop: the strip keeps its one stop,
// its arrows and its Delete. The × lies over the tab's end and its words fade
// out under it, so drawing it moves nothing.
//
// Before: a tab closed only by Delete on the strip, a middle press, or the ×
// in the strip's menu; hovering a tab drew no × at all.
import { describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import StageHeader, { tabWords, type StageHeaderProps } from "../components/terminal/StageHeader";
import { StripTab, stripKey, stripStop, type PaneTabItem, type PaneTabsView } from "../components/terminal/PaneTabs";
import { en } from "../i18n/en";
import { sourceOf } from "./client-source";
import { withoutComments } from "./tsx-scan";

const items: PaneTabItem[] = [
  { key: "s:s1", id: "wsp-ptab-p0-s:s1", name: "api refactor", status: { state: "idle", phrase: "idle" }, on: true, panel: "workspace-pane" },
  { key: "s:s2", id: "wsp-ptab-p0-s:s2", name: "docs pass", status: { state: "waiting", phrase: "waiting", emphasis: "6m" }, on: false, panel: "workspace-pane" },
  { key: "s:s3", id: "wsp-ptab-p0-s:s3", name: "Desktop · 9969", status: { state: "idle", phrase: "idle" }, on: false, panel: "workspace-pane" },
];
const closeName = (name: string) => en["board.stage.tabs.close"].replace("{name}", name);

const header = (view: PaneTabsView) => renderToStaticMarkup(createElement(StageHeader, {
  identity: "session:s1", name: "api refactor", provider: "claude", workspace: "pane", split: true,
  status: { state: "idle", phrase: "idle" }, keysOwner: "pane", chordLabel: "Ctrl+Shift+X",
  canType: true, expanded: false, takeover: false, onKeys() {}, onExpand() {}, onClose() {},
  tabs: view,
} satisfies StageHeaderProps));

/** The strip's markup alone: from its tablist to the tablist's end. */
function stripOf(out: string): string {
  const at = out.indexOf('role="tablist"');
  expect(at).toBeGreaterThan(-1);
  const open = out.lastIndexOf("<div", at);
  let depth = 0;
  for (const m of out.slice(open).matchAll(/<(\/?)div\b[^>]*>/g)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return out.slice(open, open + m.index! + m[0].length);
  }
  throw new Error("the tablist never closes");
}

/** Every element of a tree drawn by a component with no hooks, depth first. */
function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach(n => walk(n, out));
  else if (isValidElement(node)) {
    out.push(node);
    walk((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}
type Props = Record<string, unknown> & { className?: string; role?: string; children?: ReactNode };
const propsOf = (el: ReactElement) => el.props as Props;

/** One tab of the strip as StripTab draws it, with its view's presses spied. */
function drawn(x: PaneTabItem) {
  const view = { onSelect: vi.fn(), onClose: vi.fn() };
  const slot = StripTab({ x, w: tabWords(x.status), stop: stripStop(items, null), view, closeName: closeName(x.name) });
  const all = walk(slot);
  const tab = all.find(el => propsOf(el).role === "tab")!;
  const close = all.find(el => propsOf(el).className?.split(" ").includes("ts-tab-x"))!;
  return { view, slot, tab, close };
}
const press = (button = 0) => ({ button, preventDefault: vi.fn(), stopPropagation: vi.fn() });

describe("each tab of the strip", () => {
  const strip = stripOf(header({ items, onSelect() {}, onClose() {} }));
  const slots = strip.split('<div role="presentation" class="ts-tab-slot"').slice(1);

  it("sits in a slot of its own with a × beside it, two buttons side by side, never one inside the other", () => {
    expect(slots).toHaveLength(3);
    slots.forEach((slot, i) => {
      const buttons = [...slot.matchAll(/<button[^>]*>/g)].map(m => m[0]);
      expect(buttons, "the tab and its ×").toHaveLength(2);
      expect(buttons[0]).toContain('role="tab"');
      expect(buttons[0]).toContain(`id="${items[i]!.id}"`);
      // The tab's button ends before the × begins.
      expect(slot.indexOf("</button>")).toBeLessThan(slot.indexOf(buttons[1]!));
      expect(buttons[1]).toContain('class="glyph-btn ts-tab-x"');
    });
    // The slots are no items of the tablist's (presentation), so the tabs
    // stay its own, and nothing else sits in it.
    const divs = [...strip.matchAll(/<div\b[^>]*>/g)].map(m => m[0]).slice(1);
    expect(divs).toHaveLength(3);
    for (const d of divs) expect(d).toMatch(/^<div role="presentation" class="ts-tab-slot"/);
    expect(strip.match(/role="tab"/g)).toHaveLength(3);
  });

  it("names its × Close and the tab's name, for a screen reader, a voice and the tooltip alike", () => {
    expect(en["board.stage.tabs.close"]).toBe("Close {name}");
    slots.forEach((slot, i) => {
      const x = /<button[^>]*class="glyph-btn ts-tab-x"[^>]*>/.exec(slot)![0];
      expect(x).toContain(`aria-label="${closeName(items[i]!.name)}"`);
      expect(x).toContain(`title="${closeName(items[i]!.name)}"`);
      // A plain button with its name: not hidden from a screen reader, and no
      // second tab of the strip.
      expect(x).not.toContain("aria-hidden");
      expect(x).not.toContain("role=");
      expect(x).toContain('type="button"');
    });
    // Every tab has one, the tab on show among them.
    expect(strip.match(/class="glyph-btn ts-tab-x"/g)).toHaveLength(3);
    expect(slots[0]).toMatch(/^ data-on=/);
    expect(slots[1]).not.toMatch(/^ data-on/);
  });

  it("is still the strip's one tab stop on the tab on show, and its × is no stop at all", () => {
    expect(strip.match(/tabindex="0"/g)).toHaveLength(1);
    expect(slots[0]).toMatch(/role="tab"[^>]*tabindex="0"/);
    for (const slot of slots) expect(/<button[^>]*class="glyph-btn ts-tab-x"[^>]*>/.exec(slot)![0]).toContain('tabindex="-1"');
  });
});

describe("a press on a tab's ×", () => {
  it("closes that tab as a middle press does, and never shows it", () => {
    for (const x of items) {
      const { view, close } = drawn(x);
      (propsOf(close).onClick as () => void)();
      expect(view.onClose).toHaveBeenCalledTimes(1);
      expect(view.onClose).toHaveBeenCalledWith(x.key, { keys: false });
      expect(view.onSelect, x.name).not.toHaveBeenCalled();
    }
  });

  it("is a middle press's: the same close, keys false, from either", () => {
    const { view, tab, close } = drawn(items[1]!);
    (propsOf(tab).onAuxClick as (e: unknown) => void)(press(1));
    (propsOf(close).onAuxClick as (e: unknown) => void)(press(1));
    expect(view.onClose.mock.calls).toEqual([["s:s2", { keys: false }], ["s:s2", { keys: false }]]);
    // A right press is not a close.
    (propsOf(close).onAuxClick as (e: unknown) => void)(press(2));
    expect(view.onClose).toHaveBeenCalledTimes(2);
    expect(view.onSelect).not.toHaveBeenCalled();
  });

  it("takes no focus, so the keyboard stays where it was and the strip gains no stop", () => {
    const { view, close } = drawn(items[0]!);
    const e = press(0);
    (propsOf(close).onMouseDown as (e: unknown) => void)(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(view.onClose).not.toHaveBeenCalled();
    expect(view.onSelect).not.toHaveBeenCalled();
  });

  it("is outside the tab, so the tab's own press, which shows it, never runs for it", () => {
    for (const x of items) {
      const { view, slot, tab, close } = drawn(x);
      expect(walk(propsOf(tab).children)).not.toContain(close);
      // The slot holds the two side by side, the tab first.
      const kids = walk(propsOf(slot).children).filter(el => el === tab || el === close);
      expect(kids).toEqual([tab, close]);
      // The tab itself still shows on a press, and a middle press still closes.
      (propsOf(tab).onClick as () => void)();
      expect(view.onSelect).toHaveBeenCalledWith(x.key, { keys: true });
      expect(view.onClose).not.toHaveBeenCalled();
    }
  });
});

describe("the strip's keys, with a × on every tab", () => {
  const key = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey", boolean>> = {}) =>
    ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });
  const tabs = withoutComments(sourceOf("components/terminal/PaneTabs.tsx"));

  it("walk the tabs alone: the arrows skip the ×, Space shows and Delete closes the tab under the keyboard", () => {
    expect(stripKey(key("ArrowRight"), 0, items)).toEqual({ kind: "focus", key: "s:s2" });
    expect(stripKey(key("ArrowRight"), 2, items)).toEqual({ kind: "focus", key: "s:s1" });
    expect(stripKey(key("End"), 0, items)).toEqual({ kind: "focus", key: "s:s3" });
    expect(stripKey(key(" "), 1, items)).toEqual({ kind: "show", key: "s:s2" });
    expect(stripKey(key("Delete"), 2, items)).toEqual({ kind: "close", key: "s:s3" });
    // The strip reads the tab a key came from by its role, which the ×, a
    // sibling of the tab, does not wear: a key on it is not the strip's.
    expect(tabs).toContain('const tab = (target as HTMLElement | null)?.closest?.("[role=tab]");');
    expect(tabs).toContain("view.onClose(ask.key, { keys: true });");
    // An arrow moves the keyboard to the tab by its id, never to a ×.
    expect(tabs).toContain("const el = to ? document.getElementById(to.id) : null;");
  });
});

describe("the × on screen", () => {
  const read = (file: string) => readFileSync(fileURLToPath(new URL(`../styles/${file}`, import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  type Rule = { sel: string; body: string; media: string[] };
  /** Every rule of a sheet, with the @media headers around it. */
  function rules(css: string): Rule[] {
    const out: Rule[] = [];
    const stack: string[] = [];
    let start = 0;
    for (let i = 0; i < css.length; i++) {
      if (css[i] === "{") {
        const head = css.slice(start, i).trim();
        const close = css.indexOf("}", i);
        const next = css.indexOf("{", i + 1);
        if (head.startsWith("@") || (next !== -1 && next < close)) { stack.push(head); start = i + 1; continue; }
        for (const sel of head.split(",")) out.push({ sel: sel.trim().replace(/\s+/g, " "), body: css.slice(i + 1, close), media: [...stack] });
        i = close;
        start = i + 1;
      } else if (css[i] === "}") {
        stack.pop();
        start = i + 1;
      }
    }
    return out;
  }
  const split = rules(read("workspace-split.css"));
  const touch = rules(read("touch-and-forced-colours.css"));
  const decl = (body: string, prop: string) => new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;]+);`).exec(body)?.[1].trim();
  const props = (body: string) => [...body.matchAll(/(?:^|[;{\s])([-a-z]+):/g)].map(m => m[1]!);
  const one = (list: Rule[], sel: string, media?: (m: string[]) => boolean) => {
    const found = list.filter(r => r.sel === sel && (!media || media(r.media)));
    expect(found.length, sel).toBeGreaterThan(0);
    return found.map(r => r.body).join(";");
  };
  const mice = (m: string[]) => m.some(h => /\(hover: hover\) and \(pointer: fine\)/.test(h));
  const reveals = (r: Rule) => /\.ts-tab-x$|\.ts-tab-in$/.test(r.sel) && /:hover|:focus-visible|\[data-on\]/.test(r.sel) && !/\.ts-tab-x:hover$/.test(r.sel);

  it("lies over the tab's end and takes no room of its own, so drawing it moves nothing", () => {
    expect(decl(one(split, ".ts-tabs .ts-tab-slot"), "position")).toBe("relative");
    const x = one(split, ".ts-tabs .ts-tab-x");
    expect(decl(x, "position")).toBe("absolute");
    // Drawing it changes how it looks, never a width, a padding or a place.
    const drawing = [...split, ...touch].filter(reveals).filter(r => !r.media.some(m => /hover: none|pointer: coarse/.test(m)));
    expect(drawing.length).toBeGreaterThanOrEqual(4);
    for (const r of drawing) {
      expect([r.sel, props(r.body).filter(p => !["opacity", "pointer-events", "mask-image", "-webkit-mask-image"].includes(p))]).toEqual([r.sel, []]);
    }
  });

  it("is not drawn at rest and lets a press through to its tab, the tab on show's too", () => {
    const x = one(split, ".ts-tabs .ts-tab-x");
    expect(decl(x, "opacity")).toBe("0");
    expect(decl(x, "pointer-events")).toBe("none");
    // Nothing draws it on the tab on show for a mouse: no [data-on] reveal
    // outside the touch block.
    expect(split.filter(r => reveals(r) && r.sel.includes("[data-on]"))).toEqual([]);
  });

  it("is drawn under the pointer on any tab, and with the keyboard on its tab", () => {
    expect(decl(one(split, ".ts-tab-slot:hover > .ts-tab-x", mice), "opacity")).toBe("1");
    expect(decl(one(split, ".ts-tab-slot:hover > .ts-tab-x", mice), "pointer-events")).toBe("auto");
    expect(decl(one(split, ".ts-tab-slot:has(> .ts-tab:focus-visible) > .ts-tab-x"), "opacity")).toBe("1");
    // The tab keeps its pointer fill while the pointer is on its ×.
    expect(decl(one(split, ".ts-tab-slot:hover > .ts-tab:not([data-on])", mice), "background")).toBe("var(--selected)");
  });

  it("fades the tab's words out under it, clear beneath the whole ×", () => {
    const x = one(split, ".ts-tabs .ts-tab-x");
    const reach = Number.parseInt(decl(x, "right")!) + Number.parseInt(decl(x, "width")!);
    const pad = Number.parseInt(decl(one(split, ".ts-tabs .ts-tab"), "padding")!.split(" ")[1]!);
    for (const sel of [".ts-tab-slot:hover .ts-tab-in", ".ts-tab-slot:has(> .ts-tab:focus-visible) .ts-tab-in"]) {
      const mask = decl(one(split, sel), "mask-image")!;
      expect(decl(one(split, sel), "-webkit-mask-image")).toBe(mask);
      const clear = Number(/^linear-gradient\(to left, transparent (\d+)px, #000 (\d+)px\)$/.exec(mask)?.[1]);
      expect(clear, sel).toBe(reach - pad);
    }
  });

  it("is always drawn on the tab on show where there is no hover, in room of its own", () => {
    const fingers = (m: string[]) => m.some(h => /\(hover: none\), \(pointer: coarse\)/.test(h));
    const x = one(touch, ".ts-tabs .ts-tab-slot[data-on] > .ts-tab-x", fingers);
    expect(decl(x, "opacity")).toBe("1");
    expect(decl(x, "pointer-events")).toBe("auto");
    expect(decl(one(touch, ".ts-tabs .ts-tab-slot[data-on] > .ts-tab", fingers), "padding-right")).toBe("32px");
    expect(decl(one(touch, ".ts-tabs .ts-tab-slot[data-on] > .ts-tab > .ts-tab-in", fingers), "mask-image")).toBe("none");
    // Only the tab on show's: the others still wait for the keyboard.
    expect(touch.filter(r => fingers(r.media) && r.sel.includes("ts-tab-x") && !r.sel.includes("[data-on]"))).toEqual([]);
  });

  it("comes and goes without motion when asked for less, and keeps its hover in forced colours", () => {
    const still = one(split, ".ts-tabs .ts-tab-x", m => m.some(h => /prefers-reduced-motion: reduce/.test(h)));
    expect(decl(still, "transition")).toBe("none");
    const forced = one(touch, ".ts-tabs .ts-tab-x:hover", m => m.some(h => /forced-colors: active/.test(h)) && mice(m));
    expect(decl(forced, "color")).toBe("Highlight");
  });
});
