// V4's kit controls (R3-7b): the switch, the field and select, the segmented
// control with its sliding thumb, the radio dot, the checkbox, the icon button,
// the key cap, the waiting loader, the write state and the row fold. The looks
// are pinned from the stylesheets (declarations, as the other v4-*.test.ts files
// read them); the optimistic switch, the loader's timing and the Saved fade are
// pinned by behaviour. Tokens only; no hex here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { sheetText } from "./sheet-source";
import { all, flush, mount, one, textOf } from "./fake-react";

vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(), ...(await import("./fake-react")).react }));
const { useOptimisticSwitch } = await import("../use-optimistic-switch");
const { useWaitingLoader } = await import("../use-waiting-loader");
const { WriteState } = await import("../components/WriteState");
const { default: SessionRecoverySettings } = await import("../components/SessionRecoverySettings");

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

describe("item 1: the switch", () => {
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

describe("item 1: the switch flips at once (optimistic)", () => {
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
  it("is the path the session-recovery switches take: flips on the press, back on a refused write, and says Failed", async () => {
    let answer: (r: unknown) => void = () => {};
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: { method?: string }) => init?.method === "POST"
      ? new Promise(r => { answer = r; })
      : Promise.resolve({ ok: true, json: async () => ({ ok: true, prefs: { recoverClaudeSessions: true, continueStopped: false } }) })));
    const view = mount(SessionRecoverySettings, { provider: "Codex" as const });
    await flush();
    const control = () => (all(view.tree, e => e.props.settingId === "codex-session-recovery")[0].props.control as { props: Record<string, unknown> }).props;
    expect(control()["aria-checked"]).toBe(true);
    void (control().onClick as () => void)();
    expect(control()["aria-checked"]).toBe(false);
    answer({ ok: false, json: async () => ({}) });
    await flush();
    expect(control()["aria-checked"]).toBe(true);
    expect(all(view.tree, e => e.props.state === "failed" && typeof e.props.sentence === "string")[0].props.sentence).toBe("Could not save this setting. Try again.");
    view.unmount();
  });
});

describe("item 2: the field and select, disabled", () => {
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

describe("item 3: the segmented control (.ap-sides)", () => {
  it("is the kit's box: 1px padding, 1px --line-soft, r8, --bg-soft", () => {
    expect(decl(".ap-sides", "padding")).toBe("1px");
    expect(decl(".ap-sides", "border")).toBe("1px solid var(--line-soft)");
    expect(decl(".ap-sides", "background")).toBe("var(--bg-soft)");
    expect(decl(".ap-sides", "border-radius")).toBe("var(--r-panel)");
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

describe("items 4 and 5: the radio dot and the checkbox", () => {
  it("brings the dot in from half size over Fast and only fades it out, with a fade alone under reduced motion", () => {
    expect(css).toMatch(/@keyframes radio-dot-in \{ from \{ opacity: 0; transform: scale\(0\.5\); \} \}/);
    expect(decl(".reading-selected-mark", "transition")).toBe("opacity var(--dur-fast) var(--ease)");
    expect(decl(".reading-selected-mark", "transform")).toBeUndefined();
    expect(decl(".reading-choice:has(input:checked) .reading-selected-mark", "animation")).toBe("radio-dot-in var(--dur-fast) var(--ease) both");
    expect(decl(".reading-choice:has(input:checked) .reading-selected-mark", "animation", REDUCED)).toBe("none");
    expect(decl('.character-choice[aria-checked="true"] .character-check', "animation")).toBe("radio-dot-in var(--dur-fast) var(--ease) both");
    expect(decl('.character-choice[aria-checked="true"] .character-check', "animation", REDUCED)).toBe("none");
  });
  it("moves the label colour in Fast on --ease", () => {
    expect(decl(".reading-choice", "transition")).toContain("border-color var(--dur-fast) var(--ease)");
    expect(decl(".character-choice", "transition")).toContain("border-color var(--dur-fast) var(--ease)");
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
    expect(decl(".cbx-tick", "transition", REDUCED)).toBe("opacity var(--dur-fast) var(--ease)");
  });
});

describe("item 6: the icon button", () => {
  it("hovers on --line-soft on a pointer, and is --selected pressed or open", () => {
    expect(decl(".glyph-btn:hover:not(:disabled)", "background", POINTER)).toBe("var(--line-soft)");
    expect(decl('.glyph-btn:active:not(:disabled)', "background")).toBe("var(--selected)");
    expect(decl('.glyph-btn[aria-expanded="true"]', "background")).toBe("var(--selected)");
    expect(decl('.glyph-btn[aria-pressed="true"]', "background")).toBe("var(--selected)");
    expect(decl(".glyph-btn", "transition")).toContain("background-color var(--dur-fast) var(--ease)");
    expect(decl(".glyph-btn", "border-radius")).toBe("var(--r-ctl)");
  });
  it("presses on the pointer only, in the glyph button and in the Board's zoom buttons", () => {
    expect(decl(".glyph-btn:active:not(:disabled):not(:focus-visible)", "transform")).toBe("scale(var(--press-small))");
    const zoom = '.react-flow__controls-button:active:not(:disabled):not([aria-disabled="true"]):not(:focus-visible)';
    expect(decl(zoom, "transform")).toBe("scale(var(--press-small))");
    expect(decl(".react-flow__controls-button", "transition")).toContain("transform var(--dur-fast) var(--ease)");
  });
});

describe("item 7: the key cap", () => {
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
      expect(decl(sel, "color"), sel).toBe(sel === ".qo-foot kbd" ? "var(--text)" : "var(--muted)");
      expect(decl(sel, "font"), sel).toBe("500 calc(11px + var(--ui-text-increase, 0px))/calc(14px + var(--ui-text-increase, 0px)) var(--font-mono)");
    }
  });
  it("gives quick open's caps no motion", () => {
    const quick = rules.filter(r => r.selectors.some(s => /\.qo-(key|esc|foot)/.test(s)));
    for (const r of quick) {
      expect(r.decls.transition, r.selectors.join()).toBeUndefined();
      expect(r.decls.animation, r.selectors.join()).toBeUndefined();
    }
  });
});

describe("item 9: the waiting loader", () => {
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

describe("item 10: the write state", () => {
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

describe("item 11: the row fold", () => {
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

describe("item 12: two durations", () => {
  it("runs the new-session popover and the drag trash on Base, keeping the keyframes", () => {
    expect(css).toMatch(/animation: ns-pop-in var\(--dur-base\) var\(--ease\)/);
    expect(css).toMatch(/animation: dragTrashIn var\(--dur-base\) var\(--ease\) both/);
    expect(css).toMatch(/@keyframes dragTrashIn/);
    expect(css).toMatch(/@keyframes ns-pop-in/);
  });
});
