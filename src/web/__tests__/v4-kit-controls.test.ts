// V4's kit controls: the switch, the field and select, the segmented
// control with its sliding thumb, the radio dot, the checkbox, the icon button,
// the key cap, the waiting loader, the write state and the row fold. The looks
// are pinned from the stylesheets (declarations, as the other v4-*.test.ts files
// read them); the optimistic switch, the loader's timing and the Saved fade are
// pinned by behaviour. Tokens only; no hex here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { sheetText } from "./sheet-source";
import { CLAUDE_SETTINGS } from "../../server/claude-settings-catalog.mjs";
import { all, flush, mount, one, textOf } from "./fake-react";

vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(), ...(await import("./fake-react")).react }));
const { useOptimisticSwitch } = await import("../use-optimistic-switch");
const { useWaitingLoader } = await import("../use-waiting-loader");
const { WriteState } = await import("../components/WriteState");
const { default: SessionRecoveryRow } = await import("../components/SessionRecoverySettings");
const { settingsFailure, setSettingsFailure } = await import("../settings-failure");
const { ClaudeRow } = await import("../components/ClaudeCodeSettings");
const { useSegmentThumb } = await import("../use-segment-thumb");

interface Rule { media: string; selectors: string[]; decls: Record<string, string> }

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

function parse(text: string): Rule[] {
  const rules: Rule[] = [];
  const block = (from: number): number => {
    let depth = 0;
    for (let i = from; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) return i;
    }
    throw new Error("unbalanced braces");
  };
  const walk = (start: number, end: number, media: string) => {
    let i = start;
    while (i < end) {
      const open = text.indexOf("{", i);
      if (open < 0 || open >= end) return;
      const prelude = text.slice(i, open).trim().replace(/\s+/g, " ");
      const close = block(open);
      const inner = text.slice(open + 1, close);
      if (prelude.startsWith("@keyframes")) { /* read as text below */ }
      else if (prelude.startsWith("@")) walk(open + 1, close, prelude.startsWith("@media") ? (media ? `${media} and ${prelude.slice(6).trim()}` : prelude.slice(6).trim()) : media);
      else {
        const decls: Record<string, string> = {};
        for (const m of inner.matchAll(/([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) decls[m[1]] = m[2].replace(/\s+/g, " ");
        const selectors = prelude.split(/,(?![^()]*\))/).map(s => s.trim().replace(/\s+/g, " "));
        rules.push({ media, selectors, decls });
      }
      i = close + 1;
    }
  };
  walk(0, text.length, "");
  return rules;
}
const rules = parse(css);
function decl(selector: string, prop: string, media = ""): string | undefined {
  let found: string | undefined;
  for (const r of rules) if (r.media === media && r.selectors.includes(selector) && prop in r.decls) found = r.decls[prop];
  return found;
}
const REDUCED = "(prefers-reduced-motion: reduce)";
const POINTER = "(hover: hover) and (pointer: fine)";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("switch: looks", () => {
  const knob = '.switch[aria-checked="true"] .switch-knob';
  const press = ".switch:active:not(:disabled):not(:focus-visible) .switch-knob";
  it("starts 2px in from the outer edge and travels 14px; the press stretches to 18 and keeps the right edge", () => {
    expect(decl(".switch-knob", "left")).toBe("1px");
    expect(decl(".switch-knob", "width")).toBe("14px");
    expect(decl(knob, "transform")).toBe("translateY(-50%) translateX(14px)");
    expect(decl(press, "width")).toBe("18px");
    expect(decl(`.switch[aria-checked="true"]${press.slice(".switch".length)}`, "transform")).toBe("translateY(-50%) translateX(10px)");
    // right edge of the stretched on knob: 1 + 10 + 18 = 29 = 1 + 14 + 14
    expect(1 + 10 + 18).toBe(1 + 14 + 14);
  });
  it("moves the knob and the track in Base, and the track in Fast under reduced motion", () => {
    expect(decl(".switch-knob", "transition")).toContain("transform var(--dur-base) var(--ease)");
    expect(decl(".switch", "transition")).toContain("background-color var(--dur-base) var(--ease)");
    expect(decl(".switch", "transition", REDUCED)).toContain("background-color var(--dur-fast) var(--ease)");
    expect(decl(".switch-knob", "transition", REDUCED)).toBe("background-color var(--dur-fast) var(--ease)");
  });
  it("hovers on a real pointer only, keeps the 24px target and the warn tone, and no longer scales the track", () => {
    expect(decl(".switch:hover:not(:disabled)", "border-color", POINTER)).toBe("var(--text)");
    expect(decl(".switch::after", "height")).toBe("24px");
    expect(decl('.switch[data-tone="warn"][aria-checked="true"]', "background")).toBe("var(--warn)");
    expect(css).not.toMatch(/\.switch:active:not\(:disabled\)\s*[,{]/);
  });
});

describe("switch: flips at once (optimistic)", () => {
  function probe(write: (next: boolean) => Promise<boolean>, committed: boolean | null = false) {
    return mount((p: { committed: boolean | null }) => {
      const s = useOptimisticSwitch(p.committed, write);
      return { type: "button", props: { role: "switch", "aria-checked": s.checked, "data-failed": s.failed, onClick: s.flip, children: null } };
    }, { committed });
  }
  const sw = (view: ReturnType<typeof probe>) => one(view.tree, e => e.props.role === "switch")!;
  it("moves the knob on the press, before the write has answered", async () => {
    let answer: (ok: boolean) => void = () => {};
    const view = probe(() => new Promise<boolean>(r => { answer = r; }));
    void (sw(view).props.onClick as () => Promise<void>)();
    expect(sw(view).props["aria-checked"]).toBe(true);
    answer(true);
    await flush();
    view.unmount();
  });
  it("slides it back and says Failed when the write is refused", async () => {
    const view = probe(async () => false);
    void (sw(view).props.onClick as () => Promise<void>)();
    expect(sw(view).props["aria-checked"]).toBe(true);
    await flush();
    expect(sw(view).props["aria-checked"]).toBe(false);
    expect(sw(view).props["data-failed"]).toBe(true);
    view.unmount();
  });
  it("slides it back when the write throws, and clears Failed on the next press", async () => {
    let fail = true;
    const view = probe(async () => { if (fail) throw new Error("no"); return true; });
    void (sw(view).props.onClick as () => Promise<void>)();
    await flush();
    expect(sw(view).props["aria-checked"]).toBe(false);
    expect(sw(view).props["data-failed"]).toBe(true);
    fail = false;
    void (sw(view).props.onClick as () => Promise<void>)();
    expect(sw(view).props["data-failed"]).toBe(false);
    view.unmount();
  });
  it("refuses a press before the store has said, and a second press mid-write", async () => {
    const write = vi.fn(async () => true);
    const idle = probe(write, null);
    void (sw(idle).props.onClick as () => Promise<void>)();
    expect(write).not.toHaveBeenCalled();
    idle.unmount();
    let answer: (ok: boolean) => void = () => {};
    const slow = vi.fn(() => new Promise<boolean>(r => { answer = r; }));
    const view = probe(slow);
    void (sw(view).props.onClick as () => Promise<void>)();
    void (sw(view).props.onClick as () => Promise<void>)();
    expect(slow).toHaveBeenCalledTimes(1);
    answer(true);
    await flush();
    view.unmount();
  });
  it("is the path the session-recovery switches take: flips on the press, back on a refused write, and says why under the page head", async () => {
    // CHANGED ON PURPOSE (V4's failed write): the row no longer says a red
    // Failed word under itself; the one line under the page head says it, in
    // V4's words, and a write that takes clears it.
    let answer: (r: unknown) => void = () => {};
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: { method?: string }) => init?.method === "POST"
      ? new Promise(r => { answer = r; })
      : Promise.resolve({ ok: true, json: async () => ({ ok: true, prefs: { recoverClaudeSessions: true, continueStopped: false } }) })));
    const view = mount(SessionRecoveryRow, { provider: "Codex" as const });
    await flush();
    const control = () => (all(view.tree, e => e.props.settingId === "codex-session-recovery")[0].props.control as { props: Record<string, unknown> }).props;
    expect(control()["aria-checked"]).toBe(true);
    void (control().onClick as () => void)();
    expect(control()["aria-checked"]).toBe(false);
    answer({ ok: false, json: async () => ({}) });
    await flush();
    expect(control()["aria-checked"]).toBe(true);
    expect(all(view.tree, e => e.props.state === "failed")).toHaveLength(0);
    expect(settingsFailure()?.line).toEqual({ text: "Could not save that setting. Try again.", giveBack: false, done: false });
    void (control().onClick as () => void)();
    answer({ ok: true, json: async () => ({ ok: true, prefs: { recoverCodexSessions: false } }) });
    await flush();
    expect(control()["aria-checked"]).toBe(false);
    expect(settingsFailure()).toBeNull();
    view.unmount();
  });
});

describe("switch: Settings › Claude Code says a refused write under the page head", () => {
  afterEach(() => { setSettingsFailure(null); });
  it("slides back, and the page's one failure line says why, with no word in the row", async () => {
    // CHANGED ON PURPOSE (V4's failed write): the Failed word under the row is
    // gone; the line under the page head carries the sentence.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const entry = CLAUDE_SETTINGS.find(e => e.kind === "switch")!;
    const row = { id: entry.id, value: false, isSet: true, editable: true };
    const view = mount(ClaudeRow, { entry, row, saving: null, said: "" });
    const control = () => (one(view.tree, e => e.props.settingId === `claude-${entry.id}`)!.props.control as { props: { flip: { checked: boolean; flip: () => Promise<void> } } }).props.flip;
    expect(settingsFailure()).toBeNull();
    void control().flip();
    expect(control().checked).toBe(true);
    await flush();
    expect(control().checked).toBe(false);
    expect(all(view.tree, e => e.props.state === "failed")).toHaveLength(0);
    expect(settingsFailure()?.line.text).toBe("Could not save that setting. Try again.");
    view.unmount();
  });
});

describe("segmented control: the thumb goes live", () => {
  function fakeGroup(selected: { current: boolean }) {
    const attrs = new Map<string, string>();
    const on = { offsetLeft: 4, offsetWidth: 40, offsetTop: 2, offsetHeight: 20 };
    return {
      attrs,
      el: {
        querySelector: () => (selected.current ? on : null),
        style: { setProperty: () => {} },
        getAttribute: (k: string) => attrs.get(k) ?? null,
        hasAttribute: (k: string) => attrs.has(k),
        setAttribute: (k: string, v: string) => { attrs.set(k, v); },
        removeAttribute: (k: string) => { attrs.delete(k); },
      },
    };
  }
  it("mounts with nothing selected, then gets a selection: placed without a slide, then live on the next frame", () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const selected = { current: false };
    const { attrs, el } = fakeGroup(selected);
    const ref = { current: el as unknown as HTMLElement };
    const view = mount((p: { n: number }) => { useSegmentThumb(ref); return { type: "div", props: { n: p.n } }; }, { n: 0 });
    expect(attrs.has("data-thumb")).toBe(false);
    selected.current = true;
    view.rerender({ n: 1 });
    expect(attrs.get("data-thumb")).toBe("set");
    frames.splice(0).forEach(run => run());
    expect(attrs.get("data-thumb")).toBe("live");
    view.unmount();
  });
  it("goes live again after it loses its selection and regains it", () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const selected = { current: true };
    const { attrs, el } = fakeGroup(selected);
    const ref = { current: el as unknown as HTMLElement };
    const view = mount((p: { n: number }) => { useSegmentThumb(ref); return { type: "div", props: { n: p.n } }; }, { n: 0 });
    frames.splice(0).forEach(run => run());
    expect(attrs.get("data-thumb")).toBe("live");
    selected.current = false;
    view.rerender({ n: 1 });
    expect(attrs.has("data-thumb")).toBe(false);
    selected.current = true;
    view.rerender({ n: 2 });
    expect(attrs.get("data-thumb")).toBe("set");
    frames.splice(0).forEach(run => run());
    expect(attrs.get("data-thumb")).toBe("live");
    view.unmount();
  });
});

describe("field and select: disabled", () => {
  it("draws the disabled field in --line and --muted-dim with the default cursor, hover or not", () => {
    for (const [sel, media] of [[".ap-manage-input:disabled", ""], [".sm-select:disabled", ""],
      [".ap-manage-input:disabled:hover:not(:focus-visible)", POINTER], [".sm-select:disabled:hover:not(:focus-visible)", POINTER]]) {
      expect(decl(sel, "border-color", media), sel).toBe("var(--line)");
      expect(decl(sel, "color", media), sel).toBe("var(--muted-dim)");
      expect(decl(sel, "cursor", media), sel).toBe("default");
    }
  });
  it("eases the border in Fast on a pointer focus and drops the ease after a key", () => {
    expect(decl(".ap-manage-input", "transition")).toContain("border-color var(--dur-fast) var(--ease)");
    expect(css).toMatch(/:root\[data-motion="instant"\] :is\(\.ap-manage-input, \.sm-select[^)]*\) \{ transition: none; \}/);
  });
  it("fades an error message in over Fast", () => {
    expect(decl(".fb-error", "animation")).toBe("wstate-in var(--dur-fast) var(--ease) both");
  });
});

describe("button: disabled", () => {
  it("draws a disabled button with no fill, a --line-soft edge and --muted-dim words, at full opacity, hover or not", () => {
    // V4's kit: the disabled button is drawn, not faded, so its words stay
    // crisp and every variant (primary, danger, quiet) reads as the same
    // not-clickable thing.
    for (const [sel, media] of [["button.btn:disabled", ""], ["button.btn:disabled:hover", POINTER]]) {
      expect(decl(sel, "background", media), sel).toBe("transparent");
      expect(decl(sel, "border-color", media), sel).toBe("var(--line-soft)");
      expect(decl(sel, "color", media), sel).toBe("var(--muted-dim)");
    }
    expect(decl("button.btn:disabled", "cursor")).toBe("default");
    expect(rules.filter(r => r.selectors.some(s => /^button\.btn:disabled/.test(s)) && "opacity" in r.decls)).toEqual([]);
  });
  it("outranks every variant's own colours, so a disabled primary or danger is not still painted", () => {
    // `button.btn:disabled` ties `button.btn.primary` and `button.btn.danger`
    // (0,2,1), and their :hover with its own, so it is written after them all.
    // The one variant that can be disabled and outranks it, LAN's Unpair, says
    // the same three things itself.
    const sheet = readFileSync(new URL("../styles/topbar-controls.css", import.meta.url), "utf8");
    const disabled = sheet.indexOf("button.btn:disabled {");
    expect(disabled).toBeGreaterThan(-1);
    expect(sheet.indexOf("button.btn:disabled:hover {")).toBeGreaterThan(disabled);
    for (const variant of ["button.btn.primary {", "button.btn.danger {", "button.btn.danger:hover {"]) {
      expect(sheet.indexOf(variant), variant).toBeGreaterThan(-1);
      expect(sheet.indexOf(variant), variant).toBeLessThan(disabled);
    }
    expect(decl(".lan-peer-foot .btn.danger:disabled", "background")).toBe("transparent");
    expect(decl(".lan-peer-foot .btn.danger:disabled", "border-color")).toBe("var(--line-soft)");
    expect(decl(".lan-peer-foot .btn.danger:disabled", "color")).toBe("var(--muted-dim)");
  });
});

describe("segmented control (.ap-sides)", () => {
  it("is the kit's box: 1px padding, 1px --line-soft, r8, --bg-soft", () => {
    expect(decl(".ap-sides", "padding")).toBe("1px");
    expect(decl(".ap-sides", "border")).toBe("1px solid var(--line-soft)");
    expect(decl(".ap-sides", "background")).toBe("var(--bg-soft)");
    // CHANGED ON PURPOSE (owner 2026-11-10 critique: type scale 11/12/13/16/22, radii 4/8/pill): a segmented control is a control, at 4.
    expect(decl(".ap-sides", "border-radius")).toBe("var(--r-ctl)");
    expect(decl(".ap-sides", "box-sizing")).toBe("border-box");
    // 24 outside: 1 + 1 + 20 + 1 + 1.
    expect(decl(".ap-side", "padding")).toBe("2px 8px");
    expect(decl(".ap-side", "line-height")).toBe("calc(16px + var(--ui-text-increase, 0px))");
  });
  it("sets the segment 12/500/16 in --muted, --text when selected, r6, with no hover fill", () => {
    expect(decl(".ap-side", "font-weight")).toBe("500");
    expect(decl(".ap-side", "color")).toBe("var(--muted)");
    expect(decl(".ap-side", "border-radius")).toBe("var(--r-ctl)");
    expect(decl('.ap-side[aria-checked="true"]', "color")).toBe("var(--text)");
    expect(decl(".ap-side:hover", "background", POINTER)).toBeUndefined();
    expect(decl(".ap-side", "transition")).toContain("color var(--dur-fast) var(--ease)");
  });
  it("slides a --panel thumb with transform and width in Base, at once after a key, jumping under reduced motion", () => {
    expect(decl("[data-thumb]::before", "background")).toBe("var(--panel)");
    expect(decl("[data-thumb]::before", "transform")).toBe("translateX(var(--thumb-x, 0))");
    expect(decl("[data-thumb]::before", "width")).toBe("var(--thumb-w, 0)");
    expect(decl('[data-thumb="live"]::before', "transition")).toBe("transform var(--dur-base) var(--ease), width var(--dur-base) var(--ease)");
    expect(decl("[data-thumb]::before", "transition")).toBeUndefined();
    expect(decl(':root[data-motion="instant"] [data-thumb]::before', "transition")).toBe("none");
    expect(decl('[data-thumb="live"]::before', "transition", REDUCED)).toBe("none");
  });
  it("is used by the Accounts switch, and the hook leaves the first placement without a transition", () => {
    expect(readFileSync(new URL("../components/AccountsSwitch.tsx", import.meta.url), "utf8")).toContain('<SegmentGroup className="ap-sides"');
    const hook = readFileSync(new URL("../use-segment-thumb.ts", import.meta.url), "utf8");
    expect(hook).toContain('"data-thumb", "set"');
    expect(hook).toContain('"data-thumb", "live"');
  });
});

describe("radio dot and checkbox", () => {
  it("grows the dot in from half size by a transition over Fast, only fades it out, and fades alone under reduced motion", () => {
    const dots: Array<[string, string]> = [
      // CHANGED ON PURPOSE (V4 Figma): the sizes and spacings are Selects now, so the
      // framed previews and their selected mark are gone; the companion check stays.
      [".character-check", '.character-choice[aria-checked="true"] .character-check'],
    ];
    for (const [off, on] of dots) {
      expect(css).not.toContain("radio-dot-in");
      expect(decl(off, "animation"), off).toBeUndefined();
      expect(decl(on, "animation"), on).toBeUndefined();
      expect(decl(off, "opacity"), off).toBe("0");
      expect(decl(off, "transform"), off).toBe("scale(0.5)");
      expect(decl(off, "transition"), off).toBe("opacity var(--dur-fast) var(--ease), transform 0s var(--ease) var(--dur-fast)");
      expect(decl(on, "opacity"), on).toBe("1");
      expect(decl(on, "transform"), on).toBe("none");
      expect(decl(on, "transition"), on).toBe("opacity var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease)");
      expect(decl(off, "transform", REDUCED), off).toBe("none");
      expect(decl(off, "transition", REDUCED), off).toBe("opacity var(--dur-fast) var(--ease)");
      expect(decl(on, "transform", REDUCED), on).toBe("none");
      expect(decl(on, "transition", REDUCED), on).toBe("opacity var(--dur-fast) var(--ease)");
    }
  });
  it("moves the label colour in Fast on --ease", () => {
    // CHANGED ON PURPOSE (V4's Figma): a companion tile is a name under a framed
    // preview, so the frame (the preview) moves its border in Fast and the name
    // its colour in Fast, where the whole tile moved its border.
    expect(decl(".character-preview", "transition")).toContain("border-color var(--dur-fast) var(--ease)");
    expect(decl(".character-choice", "transition")).toContain("color var(--dur-fast) var(--ease)");
  });
  it("draws the box empty when off, and the tick at 1.5 in --bg on the accent when on", () => {
    expect(decl(".cbx > input", "background")).toBe("transparent");
    expect(decl(".cbx-tick", "stroke")).toBe("var(--bg)");
    expect(decl(".cbx-tick", "stroke-width")).toBe("1.5");
  });
  it("fills the box in Fast and draws the tick by its dash offset in Fast", () => {
    expect(decl(".cbx > input", "transition")).toBe("background-color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)");
    expect(decl(".cbx-tick", "stroke-dasharray")).toBe("1");
    expect(decl(".cbx-tick", "stroke-dashoffset")).toBe("1");
    expect(decl(".cbx > input:checked + .cbx-tick", "stroke-dashoffset")).toBe("0");
    expect(decl(".cbx > input:checked + .cbx-tick", "transition")).toBe("stroke-dashoffset var(--dur-fast) var(--ease)");
  });
  it("unticks by fading the tick, resetting the dash only after the fade, and fades under reduced motion", () => {
    expect(decl(".cbx-tick", "transition")).toBe("opacity var(--dur-fast) var(--ease), stroke-dashoffset 0s var(--ease) var(--dur-fast)");
    expect(decl(".cbx > input:checked + .cbx-tick", "transition", REDUCED)).toBe("opacity var(--dur-fast) var(--ease)");
    expect(decl(".cbx-tick", "transition", REDUCED)).toBe("opacity var(--dur-fast) var(--ease), stroke-dashoffset 0s var(--ease) var(--dur-fast)");
  });
  it("steps the focus ring of a ticked box outside, where the accent fill would swallow it", () => {
    const ring = rules.find(r => r.media === "" && r.decls["outline-offset"] === "2px" && r.selectors.includes(".switch[aria-checked=\"true\"]:focus-visible"));
    expect(ring?.selectors).toContain(".cbx > input:checked:focus-visible");
  });
});

describe("icon button", () => {
  it("hovers on --line-soft on a pointer, and is --selected pressed or open", () => {
    expect(decl(".glyph-btn:hover:not(:disabled)", "background", POINTER)).toBe("var(--line-soft)");
    expect(decl('.glyph-btn:active:not(:disabled)', "background")).toBe("var(--selected)");
    expect(decl('.glyph-btn[aria-expanded="true"]:not(:disabled)', "background")).toBe("var(--selected)");
    expect(decl('.glyph-btn[aria-pressed="true"]:not(:disabled)', "background")).toBe("var(--selected)");
    expect(decl(".glyph-btn", "transition")).toContain("background-color var(--dur-fast) var(--ease)");
    expect(decl(".glyph-btn", "border-radius")).toBe("var(--r-ctl)");
  });
  it("keeps the open fill under the pointer: the open selectors tie hover's specificity and come after it", () => {
    const at = (selector: string) => rules.findIndex(r => r.selectors.includes(selector));
    const hover = at(".glyph-btn:hover:not(:disabled)");
    for (const open of ['.glyph-btn[aria-expanded="true"]:not(:disabled)', '.glyph-btn[aria-pressed="true"]:not(:disabled)']) {
      expect(at(open), open).toBeGreaterThan(hover);
    }
    expect(hover).toBeGreaterThan(-1);
  });
  it("presses on the pointer only, in the glyph button and in the Board's zoom buttons", () => {
    expect(decl(".glyph-btn:active:not(:disabled):not(:focus-visible)", "transform")).toBe("scale(var(--press-small))");
    const zoom = '.react-flow__controls-button:active:not(:disabled):not([aria-disabled="true"]):not(:focus-visible)';
    expect(decl(zoom, "transform")).toBe("scale(var(--press-small))");
    expect(decl(".react-flow__controls-button", "transition")).toContain("transform var(--dur-fast) var(--ease)");
  });
  it("gives the card's recap pin the same open state: no circle and no wash of its own", () => {
    const pinOpen = rules.filter(r => r.selectors.some(s => /\.recap-pin\[aria-expanded/.test(s)));
    expect(pinOpen).toEqual([]);
    expect(decl(".agent-node .recap-pin", "border-radius")).toBeUndefined();
    expect(decl(".agent-node .recap-pin", "background")).toBeUndefined();
  });
});

describe("key cap", () => {
  const caps = ["kbd.qo-key", ".qo-esc", ".qo-foot kbd", ".fb-shortcut kbd"];
  it("is 16 high with 0 4px of padding inside a 1px --line border, r4, --bg-soft, mono 11/500/14 --muted", () => {
    for (const sel of caps) {
      expect(decl(sel, "height"), sel).toBe("16px");
      expect(decl(sel, "min-width"), sel).toBe("17px");
      expect(decl(sel, "padding"), sel).toBe("0 4px");
      expect(decl(sel, "box-sizing"), sel).toBe("border-box");
      expect(decl(sel, "border"), sel).toBe("1px solid var(--line)");
      expect(decl(sel, "border-radius"), sel).toBe("var(--r-tag)");
      expect(decl(sel, "background"), sel).toBe("var(--bg-soft)");
      // CHANGED ON PURPOSE: the command menu's foot caps take the kit's --muted
      // like every other cap; they were the one cap left in --text.
      expect(decl(sel, "color"), sel).toBe("var(--muted)");
      expect(decl(sel, "font"), sel).toBe("500 calc(11px + var(--ui-text-increase, 0px))/calc(14px + var(--ui-text-increase, 0px)) var(--font-mono)");
    }
  });
  it("keeps the Esc chip 16 high but makes its target 24 high with an invisible ::after", () => {
    expect(decl(".qo-esc", "position")).toBe("relative");
    expect(decl(".qo-esc::after", "content")).toBe('""');
    expect(decl(".qo-esc::after", "position")).toBe("absolute");
    expect(decl(".qo-esc::after", "height")).toBe("24px");
    expect(decl(".qo-esc", "height")).toBe("16px");
  });
  it("gives quick open's caps no motion", () => {
    const quick = rules.filter(r => r.selectors.some(s => /\.qo-(key|esc|foot)/.test(s)));
    for (const r of quick) {
      expect(r.decls.transition, r.selectors.join()).toBeUndefined();
      expect(r.decls.animation, r.selectors.join()).toBeUndefined();
    }
  });
});

describe("waiting loader", () => {
  function probe() {
    return mount((p: { busy: boolean }) => {
      const w = useWaitingLoader(p.busy);
      return { type: "i", props: { "data-draw": w.draw, "data-leaving": w.leaving, children: null } };
    }, { busy: false });
  }
  const read = (v: ReturnType<typeof probe>) => ({ draw: v.tree && (v.tree as { props: Record<string, unknown> }).props["data-draw"], leaving: (v.tree as { props: Record<string, unknown> }).props["data-leaving"] });
  it("shows nothing for a wait under 150 ms", () => {
    const v = probe();
    v.rerender({ busy: true });
    vi.advanceTimersByTime(149);
    v.rerender({ busy: false });
    vi.advanceTimersByTime(1000);
    expect(read(v)).toEqual({ draw: false, leaving: false });
    v.unmount();
  });
  it("draws at 150 ms, stays at least 300 ms, then leaves over 150 ms and is gone", () => {
    const v = probe();
    v.rerender({ busy: true });
    vi.advanceTimersByTime(150);
    expect(read(v)).toEqual({ draw: true, leaving: false });
    vi.advanceTimersByTime(100);
    v.rerender({ busy: false });          // the answer came 250 ms in, 100 ms after it was drawn
    vi.advanceTimersByTime(199);
    expect(read(v)).toEqual({ draw: true, leaving: false });   // 300 ms not yet reached
    vi.advanceTimersByTime(1);
    expect(read(v)).toEqual({ draw: true, leaving: true });
    vi.advanceTimersByTime(149);
    expect(read(v).draw).toBe(true);
    vi.advanceTimersByTime(1);
    expect(read(v)).toEqual({ draw: false, leaving: false });
    v.unmount();
  });
  it("leaves at once-plus-exit when it has already been on screen longer than 300 ms", () => {
    const v = probe();
    v.rerender({ busy: true });
    vi.advanceTimersByTime(700);
    v.rerender({ busy: false });
    vi.advanceTimersByTime(0);
    expect(read(v)).toEqual({ draw: true, leaving: true });
    vi.advanceTimersByTime(150);
    expect(read(v)).toEqual({ draw: false, leaving: false });
    v.unmount();
  });
  it("fades in over Fast and out over Exit, never removed at full opacity", () => {
    expect(decl(".loader[data-timed]", "animation")).toBe("loader-in var(--dur-fast) linear both");
    expect(decl(".loader[data-timed][data-leaving]", "animation")).toBe("loader-out var(--dur-exit) var(--ease) both");
    expect(decl(".loader[data-timed][data-idle]", "opacity")).toBe("0");
  });
});

describe("write state", () => {
  it("shows Saving after the Loader's 150 ms, and Saved fades out after 1.5 s", () => {
    const v = mount(WriteState, { state: "saving" as const });
    const root = () => v.tree as { props: Record<string, unknown> };
    expect(root().props["data-quiet"]).toBe(true);
    vi.advanceTimersByTime(150);
    expect(root().props["data-quiet"]).toBeUndefined();
    v.rerender({ state: "saved" as const });
    expect(textOf(v.tree)).toContain("Saved");
    expect(root().props["data-gone"]).toBeUndefined();
    vi.advanceTimersByTime(1499);
    expect(root().props["data-gone"]).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(root().props["data-gone"]).toBe(true);
    v.unmount();
  });
  it("keeps Failed and Uncertain on screen, with the full sentence for a screen reader", () => {
    const v = mount(WriteState, { state: "failed" as const, sentence: "Could not save this setting. Try again." });
    vi.advanceTimersByTime(60_000);
    const root = v.tree as { props: Record<string, unknown> };
    expect(root.props["data-gone"]).toBeUndefined();
    expect(textOf(v.tree)).toContain("Failed");
    expect(textOf(v.tree)).toContain("Could not save this setting. Try again.");
    v.rerender({ state: "uncertain" as const, sentence: "Not sure it saved." });
    expect(textOf(v.tree)).toContain("Not sure");
    v.unmount();
  });
  it("crossfades the word in Fast and colours Failed in --err", () => {
    expect(decl(".wstate-word", "animation")).toBe("wstate-in var(--dur-fast) var(--ease) both");
    expect(decl('.wstate[data-state="failed"]', "color")).toBe("var(--err)");
    expect(decl(".wstate", "transition")).toBe("opacity var(--dur-fast) var(--ease)");
  });
});

describe("row fold", () => {
  it("opens over Base and folds over Exit, rows and opacity together", () => {
    expect(decl(".tt-fold[data-open]", "transition")).toBe("grid-template-rows var(--dur-base) var(--ease), opacity var(--dur-base) var(--ease)");
    expect(decl(".tt-fold", "transition")).toBe("grid-template-rows var(--dur-exit) var(--ease), opacity var(--dur-exit) var(--ease)");
    expect(decl(".tt-caret", "transition")).toBe("transform var(--dur-exit) var(--ease)");
    expect(decl('.tt-lane[aria-expanded=true] .tt-caret', "transition-duration")).toBe("var(--dur-base)");
  });
  it("opens at once under reduced motion, and the content fades", () => {
    expect(decl(".tt-fold", "transition", REDUCED)).toBe("none");
    expect(decl(".tt-level-body", "transition", REDUCED)).toBe("opacity var(--dur-fast) var(--ease)");
  });
});

describe("two durations", () => {
  it("runs the new-session popover on Base with its keyframes, and the drag trash on Base as a transition", () => {
    expect(css).toMatch(/animation: ns-pop-in var\(--dur-base\) var\(--ease\)/);
    // The drag trash is a transition from @starting-style (opacity and 8px, Base in, Exit out) so a card picked up
    // again while it leaves turns it round; its keyframes are gone.
    expect(css).toMatch(/opacity var\(--dur-base\) var\(--ease\), translate var\(--dur-base\) var\(--ease\);/);
    expect(css).toMatch(/@starting-style\s*\{\s*\.drag-trash-zone\s*\{\s*opacity:\s*0;\s*translate:\s*0 8px;/);
    expect(css).not.toMatch(/@keyframes dragTrash/);
    expect(css).toMatch(/@keyframes ns-pop-in/);
  });
});
