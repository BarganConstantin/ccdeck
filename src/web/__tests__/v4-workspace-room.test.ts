// V4 top-10 #7: in Workspace the terminal pane gets the room. At 1440 the view
// was five columns, two worded stripes (156 each), the Sessions list, the pane
// and a 320 Inspector, and the pane had 38% of the window. Now the stripes are
// icons in Workspace (v4-stripe-words.test.ts), the Inspector starts closed on
// every entry and the Board gets its own back on leaving (below, run as hooks
// under fake-react over the real use-right-panels.ts), and the pane header is
// the name and one state word (v4-term-pane.test.ts). The last block is the
// width arithmetic, from the sheet's own tokens.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "./fake-react";
import { sourceOf } from "./client-source";
import { withoutComments } from "./tsx-scan";
import { sheetRules, declared } from "./sheet-cascade";

vi.mock("react", async () => (await import("./fake-react")).react);

const { useState, useEffect, useRef } = (await import("./fake-react")).react;
const { useRightPanels } = await import("../use-right-panels");
const { useWorkspaceInspector } = await import("../use-workspace-inspector");
const { inspectorDoorOpen } = await import("../inspector-corner");
const { STRIPE_W, STRIPE_WORDS_KEY, setStripeWorkspace, stripeWidth } = await import("../stripe-words");
const { leftColumnWidth } = await import("../use-left-column");
const { fitRailWidth, railCap } = await import("../rail-width");
const { DEFAULT_DENSITY } = await import("../reading-preferences");

const DETAIL_KEY = "agent-dag.detailOpen";
let store: Map<string, string>;
function browser(width = 1440) {
  (globalThis as Record<string, unknown>).window = {
    innerWidth: width,
    matchMedia: (q: string) => {
      const min = /^\(min-width: (\d+)px\)$/.exec(q);
      const max = /^\(max-width: (\d+)px\)$/.exec(q);
      return { matches: min ? width >= +min[1] : max ? width <= +max[1] : false, addEventListener() {}, removeEventListener() {} };
    },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  };
}
beforeEach(() => { store = new Map(); browser(); });
afterEach(() => { setStripeWorkspace(false); delete (globalThis as Record<string, unknown>).window; });

/** App's Inspector in Workspace, as App.tsx wires it at 1320 and wider: the
 *  Board's flag (use-right-panels.ts), the column's fold, the unfold on an
 *  open, and the hook. `shows` is what the column draws (inspector-corner.ts). */
interface Props { workspace: boolean }
function Harness({ workspace }: Props) {
  const { detailOpen, setDetailOpen, hold } = useRightPanels();
  const [folded, setFolded] = useState(false);
  const detailWasOpen = useRef(detailOpen);
  useEffect(() => {
    if (detailOpen && !detailWasOpen.current) setFolded(false);
    detailWasOpen.current = detailOpen;
  }, [detailOpen]);
  useWorkspaceInspector({ active: workspace, detailOpen, fold: () => setFolded(true), hold: hold.detail, restore: setDetailOpen });
  return {
    detailOpen,
    shows: inspectorDoorOpen({ workspace, column: true, folded, shown: detailOpen, zoomed: false }),
    /** The door's or D's open in Workspace (App.tsx showInspector). */
    open: () => { setFolded(false); setDetailOpen(true); },
    /** The Inspector's Fold (App.tsx foldInspector). */
    fold: () => { setFolded(true); setDetailOpen(false); },
  };
}
const setup = (props: Props) => {
  const view = mount(Harness, props);
  const now = () => view.tree as ReturnType<typeof Harness>;
  return { view, now, go: (next: Props) => view.rerender(next) };
};

describe("the Inspector starts closed in Workspace", () => {
  it("closes on entering, and leaving gives the Board the Inspector it had open", () => {
    store.set(DETAIL_KEY, "1");
    const { now, go } = setup({ workspace: false });
    expect(now().shows, "the Board's own").toBe(true);
    go({ workspace: true });
    expect(now().shows, "Workspace opens on the pane").toBe(false);
    expect(now().detailOpen).toBe(false);
    go({ workspace: false });
    expect(now().detailOpen, "the Board's Inspector is back").toBe(true);
    expect(now().shows).toBe(true);
  });

  it("leaves a Board that had it closed closed, even after the reader opened it inside", () => {
    store.set(DETAIL_KEY, "0");
    const { now, go } = setup({ workspace: false });
    go({ workspace: true });
    expect(now().shows).toBe(false);
    now().open();
    expect(now().shows).toBe(true);
    go({ workspace: false });
    expect(now().detailOpen).toBe(false);
    expect(store.get(DETAIL_KEY), "the Board's choice, as it was").toBe("0");
  });

  it("stays open for the rest of the visit once the reader opens it, and the next visit starts closed again", () => {
    const { now, go, view } = setup({ workspace: false });
    go({ workspace: true });
    now().open();
    for (let i = 0; i < 3; i++) view.rerender({ workspace: true });
    expect(now().shows, "nothing closes it but the reader").toBe(true);
    go({ workspace: false });
    go({ workspace: true });
    expect(now().shows, "each visit starts on the pane").toBe(false);
  });

  it("stores nothing of its own: the Board's flag stays as it was while Workspace holds it shut", () => {
    store.set(DETAIL_KEY, "1");
    const { now, go, view } = setup({ workspace: false });
    go({ workspace: true });
    view.rerender({ workspace: true });
    expect(now().detailOpen).toBe(false);
    expect(store.get(DETAIL_KEY), "held, not closed").toBe("1");
    go({ workspace: false });
    expect(store.get(DETAIL_KEY)).toBe("1");
  });

  it("keeps a fold the reader makes inside for the visit, and still gives the Board its own on leaving", () => {
    store.set(DETAIL_KEY, "1");
    const { now, go } = setup({ workspace: false });
    go({ workspace: true });
    now().open();
    now().fold();
    expect(now().shows).toBe(false);
    go({ workspace: false });
    expect(now().detailOpen).toBe(true);
    expect(store.get(DETAIL_KEY)).toBe("1");
  });

  it("starts closed on a load that lands in Workspace, though the Board's flag was open", () => {
    // The flag as it stood at mount used to unfold the column after the hold,
    // and the save effect's first run, with that flag, ended a hold made in the
    // load's layout effect, so the close was stored as the reader's: every
    // reload in Workspace closed the Board's Inspector for good.
    store.set(DETAIL_KEY, "1");
    const { now, go, view } = setup({ workspace: true });
    expect(now().shows).toBe(false);
    expect(now().detailOpen, "held, so D and the door open it").toBe(false);
    expect(store.get(DETAIL_KEY), "the Board's choice survives the reload").toBe("1");
    view.rerender({ workspace: true });
    expect(store.get(DETAIL_KEY)).toBe("1");
    go({ workspace: false });
    expect(now().detailOpen).toBe(true);
  });

  it("opens on the first press after a load in Workspace, and that open is stored as the reader's", () => {
    store.set(DETAIL_KEY, "0");
    const { now } = setup({ workspace: true });
    expect(now().shows).toBe(false);
    now().open();
    expect(now().shows).toBe(true);
    expect(store.get(DETAIL_KEY)).toBe("1");
  });

  it("is wired in App with the Board's own setter, the hold and the column's fold, keyed on the view", () => {
    const app = withoutComments(sourceOf("App.tsx"));
    expect(app).toContain("useWorkspaceInspector({");
    expect(app).toMatch(/active: inWorkspace, detailOpen,\s*fold: \(\) => setInspectorFolded\(true\), hold: holdRight\.detail, restore: setDetailStored,/);
    // The door and D still unfold it.
    const show = app.slice(app.indexOf("const showInspector = useCallback("), app.indexOf("const toggleInspector"));
    expect(show).toContain("setInspectorFolded(false)");
    expect(app).toMatch(/if \(detailOpen && !detailWasOpen\.current\) setInspectorFolded\(false\);/);
  });
});

describe("the pane's share of a 1440 window", () => {
  const rules = sheetRules();
  /** A token's value on :root (or on the selector given), in px. */
  const px = (prop: string, selector = ":root") => {
    const hit = rules.filter(r => r.media === null && r.selectors.includes(selector)).map(r => declared(r.body, prop)).filter(Boolean).at(-1);
    expect(hit, `${selector} ${prop}`).toMatch(/^\d+px$/);
    return parseFloat(hit!);
  };
  const W = 1440;
  // V4's Compact is the density a page draws at with no choice (reading.css).
  const compact = ':root[data-density="compact"]';

  it("draws the Sessions list, the stripes and the Inspector at the widths the sheet gives them", () => {
    expect(DEFAULT_DENSITY).toBe("compact");
    expect(px("--edge-w")).toBe(STRIPE_W.icons);
    expect(px("--edge-words-w")).toBe(STRIPE_W.words);
    expect(px("--rail-w", compact)).toBe(264);
    expect(px("--inspector-w", compact)).toBe(320);
    // With the Inspector's column gone the grid is [the list] [the pane]: the
    // Board's own template, which no Workspace rule at 1320 and wider replaces
    // unless a side column, Zoom or the Inspector is up.
    expect(rules.some(r => r.media === null && r.selectors.includes(".app:has(.left-column):not(:has(.detail))")
      && declared(r.body, "grid-template-columns") === "auto 1fr")).toBe(true);
    const wide = rules.filter(r => r.selectors.some(s => s.includes('[data-view="workspace"]')) && declared(r.body, "grid-template-columns") != null
      && !/max-width: (1319|1099)px/.test(r.media ?? ""));
    for (const r of wide) expect(r.selectors.every(s => /\[data-side\]|\[data-zoom\]|:has\(\.detail\)/.test(s)), r.selectors.join(", ")).toBe(true);
  });

  it("gives the pane at least 65% with the Sessions list open and the Inspector closed (it had 38%)", () => {
    const rail = px("--rail-w", compact);
    const list = leftColumnWidth("session-list", rail, fitRailWidth(null, rail, railCap(rail, W)));
    expect(list).toBe(264);
    // Before: two worded stripes and the Inspector's 320.
    const before = W - 2 * STRIPE_W.words - list - px("--inspector-w", compact);
    expect(before).toBe(544);
    expect(before / W).toBeLessThan(0.38);
    // After: the stripes as Workspace draws them, the Inspector closed on entry.
    store.set(STRIPE_WORDS_KEY, "on");
    expect(stripeWidth(), "the Board's words, at 1440").toBe(STRIPE_W.words);
    setStripeWorkspace(true);
    const stripe = stripeWidth();
    expect(stripe).toBe(STRIPE_W.icons);
    const after = W - 2 * stripe - list;
    expect(after).toBe(1096);
    expect(after / W).toBeGreaterThanOrEqual(0.65);
    expect(Math.round((after / W) * 1000) / 10).toBe(76.1);
  });
});
