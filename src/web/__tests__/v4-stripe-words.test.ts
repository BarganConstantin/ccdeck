// Words on the stripes (stripe-words.ts): a new profile sees each door's word
// beside its glyph on both desktop stripes, 156 wide; "Hide words" at the left
// stripe's foot folds both to 40 and icons, » brings them back, and the choice
// is kept per browser. A profile an earlier load wrote starts with icons. Under
// 1100px the stripes are icons and the switch is gone, the choice kept. The
// right panels at load measure the stripes as drawn. The phone's dock is
// untouched, and Capacity, This machine and Radar each have a glyph of their own.
//
// Run, not read, where it is behaviour: the stripes are drawn on fake-react.ts's
// React over a stubbed store. The width and the motion are the sheet's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { all, mount, one, textOf, type Drawn } from "./fake-react";
import { declared, sheetRules } from "./sheet-cascade";
import { sheetText } from "./sheet-source";
import { sourceOf } from "./client-source";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));
vi.mock("../use-single-key-shortcuts", () => ({ useSingleKeyShortcuts: () => true }));
vi.mock("../components/use-hint", () => ({ useHint: () => ({ bind: () => ({}), node: null }) }));

const { EdgeDock, EdgeRail, railHint, stripeDoorName, stripeHint } = await import("../components/EdgeRails");
const { railItems } = await import("../rail-items");
const { KIT_ICONS } = await import("../components/kit-icons");
const { SCHEMA_KEY, pruneStaleState } = await import("../storage");
const { STRIPE_W, STRIPE_WORDS_KEY, setStripeWords, settleStripeWords, stripeWidth, stripeWordsOn, stripeWordsShown } = await import("../stripe-words");
const { rightPanelsCrowd } = await import("../phone-load");

const noop = () => {};
const ref = () => ({ current: null });
function rails() {
  return railItems({
    providers: { kind: "reported", claude: true, codex: true },
    sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
    usagePanelOpen: false, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
    setUsageHistoryOpen: noop, watchOn: false, watchUnseen: 0, setBrowserWatchOpen: noop,
    setTrafficRadarOpen: noop, setRadioOpen: noop, openToolActivity: noop, openCapacity: noop,
    openSettings: noop, onFeedback: noop, openQuickOpen: noop, openExploreIntegrations: noop,
    toggles: { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() },
  } as unknown as Parameters<typeof railItems>[0]);
}

let stored: Record<string, string> = {};
function storeOf(seed: Record<string, string> = {}) {
  stored = { ...seed };
  return {
    getItem: (k: string) => stored[k] ?? null,
    setItem: (k: string, v: string) => { stored[k] = v; },
    removeItem: (k: string) => { delete stored[k]; },
  };
}
/** The window's width as matchMedia reads it, and who listens to it. */
const screen = { width: 1440, listeners: new Set<() => void>() };
function matchMedia(query: string) {
  const min = /^\(min-width: (\d+)px\)$/.exec(query);
  const max = /^\(max-width: (\d+)px\)$/.exec(query);
  return {
    matches: min ? screen.width >= +min[1] : max ? screen.width <= +max[1] : false,
    addEventListener: (_: string, fn: () => void) => { screen.listeners.add(fn); },
    removeEventListener: (_: string, fn: () => void) => { screen.listeners.delete(fn); },
  };
}
/** The window drawn `width` wide, as a resize would: every query asked again. */
function resize(width: number) {
  screen.width = width;
  for (const fn of [...screen.listeners]) fn();
}
function browser(seed: Record<string, string> = {}, width = 1440) {
  screen.width = width;
  vi.stubGlobal("window", {
    localStorage: storeOf(seed), innerWidth: width, matchMedia,
    addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
  });
}
/** What a test mounted, taken away after it so no stale stripe hears the next one. */
const views: Array<{ unmount(): void }> = [];
function kept<V extends { unmount(): void }>(view: V): V { views.push(view); return view; }
beforeEach(() => browser());
afterEach(() => {
  for (const view of views.splice(0)) view.unmount();
  vi.unstubAllGlobals();
});

/** Both stripes as App.tsx draws them. */
function stripes() {
  const r = rails();
  return {
    left: kept(mount(EdgeRail, { side: "left" as const, label: "Panels and tools", groups: r.leftStripe, foot: r.leftFoot })),
    right: kept(mount(EdgeRail, { side: "right" as const, label: "Usage and activity", groups: r.rightStripe })),
  };
}
const doors = (tree: unknown) => all(tree, e => typeof e.type === "function" && "item" in e.props);
const wordsOf = (tree: unknown) => doors(tree).map(d => d.props.word);
const toolbar = (tree: unknown) => one(tree, e => e.props.role === "toolbar")!;
const wordSwitch = (tree: unknown) => one(tree, e => e.type === "button" && e.props["data-rail-item"] === "stripe-words")!;

const LEFT_WORDS = ["Sessions", "Accounts", "Capacity", "Reset calendar", "Integrations", "Radio", "Settings"];
const RIGHT_WORDS = ["Inspector", "Usage", "This machine", "Usage history", "Tool activity", "Skill activity", "Browser watch", "Radar"];

describe("a new profile's stripes say their words", () => {
  it("draws each door's word on both stripes, the words of V4's critique", () => {
    const { left, right } = stripes();
    expect(wordsOf(left.tree)).toEqual(LEFT_WORDS);
    expect(wordsOf(right.tree)).toEqual(RIGHT_WORDS);
    expect(toolbar(left.tree).props["data-words"]).toBe(true);
    expect(toolbar(right.tree).props["data-words"]).toBe(true);
  });

  it("adds no word: each is the door's own label, short word or hint", () => {
    const r = rails();
    for (const item of [...r.leftStripe.flat(), ...r.leftFoot, ...r.rightStripe.flat()]) {
      const own = [item.label, item.short, item.hint, item.id === "inspector" ? "Inspector" : undefined];
      expect(own, item.id).toContain(item.stripeWord ?? item.short);
    }
  });

  it("ends the left stripe in Hide words, a « and the word, and gives the right one no switch", () => {
    const { left, right } = stripes();
    const button = wordSwitch(left.tree);
    expect(button.props["aria-label"]).toBe("Hide words");
    expect(textOf(button)).toBe("Hide words");
    expect(one(button, e => e.props.className === "rail-word")).not.toBeNull();
    expect(one(right.tree, e => e.props["data-rail-item"] === "stripe-words")).toBeNull();
    // Last in the foot, after Radio and Settings, and on the toolbar's arrows.
    const foot = one(left.tree, e => e.props.className === "rail-foot")!;
    const ids = all(foot, e => "item" in e.props || e.props["data-rail-item"] != null)
      .map(e => (e.props.item as { id: string } | undefined)?.id ?? e.props["data-rail-item"]);
    expect(ids).toEqual(["radio", "settings", "stripe-words"]);
    expect(button.props.tabIndex).toBe(-1);
    // The foot is named by all it holds, the switch too, by its name now.
    expect(foot.props.role).toBe("group");
    expect(foot.props["aria-label"]).toBe("Radio, Settings, Hide words");
    (button.props.onClick as () => void)();
    const after = one(left.tree, e => e.props.className === "rail-foot")!;
    expect(after.props["aria-label"]).toBe("Radio, Settings, Show words");
  });

  it("draws the word inside the door and names the door by a name that holds it", () => {
    const { left, right } = stripes();
    const sessions = doors(left.tree)[0];
    const drawn = kept(mount(sessions.type as (p: Record<string, unknown>) => unknown, sessions.props)).tree as Drawn;
    expect(one(drawn, e => e.props.className === "rail-word")?.props.children).toBe("Sessions");
    // "Session list" does not hold "Sessions": the word names it (WCAG 2.5.3).
    expect(drawn.props["aria-label"]).toBe("Sessions");
    const watch = doors(right.tree).find(d => (d.props.item as { id: string }).id === "browser-watch")!;
    const watchDrawn = kept(mount(watch.type as (p: Record<string, unknown>) => unknown, watch.props)).tree as Drawn;
    expect(watchDrawn.props["aria-label"]).toBe("Browser watch, not watching");
    expect(stripeDoorName("Machine", "This machine")).toBe("This machine");
    expect(stripeDoorName("Telemetry Radar", "Radar")).toBe("Telemetry Radar");
  });
});

describe("Hide words and »", () => {
  it("hides the words on both stripes, stores it, and leaves a » named Show words", () => {
    const { left, right } = stripes();
    (wordSwitch(left.tree).props.onClick as () => void)();
    expect(stored[STRIPE_WORDS_KEY]).toBe("off");
    expect(wordsOf(left.tree).every(w => w === null)).toBe(true);
    expect(wordsOf(right.tree).every(w => w === null)).toBe(true);
    expect(toolbar(left.tree).props["data-words"]).toBeUndefined();
    expect(toolbar(right.tree).props["data-words"]).toBeUndefined();
    const button = wordSwitch(left.tree);
    expect(button.props["aria-label"]).toBe("Show words");
    expect(one(button, e => e.props.className === "rail-word")).toBeNull();
  });

  it("brings the words back with », and stores that too", () => {
    browser({ [STRIPE_WORDS_KEY]: "off" });
    const { left, right } = stripes();
    expect(wordsOf(left.tree).every(w => w === null)).toBe(true);
    (wordSwitch(left.tree).props.onClick as () => void)();
    expect(stored[STRIPE_WORDS_KEY]).toBe("on");
    expect(wordsOf(left.tree)).toEqual(LEFT_WORDS);
    expect(wordsOf(right.tree)).toEqual(RIGHT_WORDS);
  });

  it("keeps the choice across loads, and in a tab whose store refuses it", () => {
    browser({ [STRIPE_WORDS_KEY]: "off" });
    expect(stripeWordsShown()).toBe(false);
    vi.stubGlobal("window", {
      localStorage: { getItem: () => null, setItem: () => { throw new Error("quota"); } },
      addEventListener: noop, removeEventListener: noop,
    });
    const { left } = stripes();
    (wordSwitch(left.tree).props.onClick as () => void)();
    expect(wordsOf(left.tree).every(w => w === null)).toBe(true);
    // A store that takes the choice again is where it lives from then on.
    browser();
    setStripeWords(true);
    expect(stored[STRIPE_WORDS_KEY]).toBe("on");
    expect(stripeWordsShown()).toBe(true);
  });

  it("names the door and its key in the hint while the word is hidden, and only what the word does not say while it shows", () => {
    const r = rails();
    const sessions = r.leftStripe[0][0];
    const capacity = r.leftStripe[1][0];
    const usage = r.rightStripe[1][0];
    const radio = r.leftFoot[0];
    // Icons: the name and its key, as before.
    expect(railHint(sessions, true, false)).toEqual({ label: "Session list", keys: "L", detail: undefined });
    // Words: the longer name where the word is short of it, the key, the help.
    expect(stripeHint(sessions, true, "Sessions")).toEqual({ label: "Session list", keys: "L", detail: undefined });
    expect(stripeHint(capacity, true, "Capacity")).toMatchObject({ label: "Account capacity", detail: capacity.detail });
    // The word is the whole name: the key alone, the help alone.
    expect(stripeHint(usage, true, "Usage")).toEqual({ label: "", keys: "U", detail: undefined });
    expect(stripeHint(radio, true, "Radio")).toEqual({ label: "", keys: undefined, detail: radio.detail });
    // Nothing to add, the single keys off: no hint at all.
    expect(stripeHint(usage, false, "Usage")).toBeNull();
  });

  it("draws no empty name in a hint that has only a key or a help line", () => {
    const src = sourceOf("components/use-hint.tsx");
    expect(src).toContain("{(shown.spec.label || shown.spec.keys) && <span className=\"hint-head\">");
    expect(src).toContain("{shown.spec.label && <span className=\"hint-label\">{shown.spec.label}</span>}");
  });
});

describe("an existing profile starts with icons, a new one with words, settled once", () => {
  const fresh = () => storeOf();
  /** One load of the deck as main.tsx boots it: the settle, then the stamp.
   *  What the stripes then show, read the way they read it. */
  function load(store: ReturnType<typeof storeOf>) {
    settleStripeWords(store);
    pruneStaleState(store);
    browser({ ...stored });
    return stripeWordsShown();
  }

  it("stores words for a new profile at its first load, so its second keeps them", () => {
    const store = fresh();
    expect(load(store)).toBe(true);
    expect(stored[STRIPE_WORDS_KEY]).toBe("on");
    // The first load stamped the schema key: the second must not read it as old.
    expect(stored[SCHEMA_KEY]).not.toBeUndefined();
    const second = storeOf({ ...stored });
    expect(settleStripeWords(second)).toBe(false);
    expect(load(second)).toBe(true);
    expect(stored[STRIPE_WORDS_KEY]).toBe("on");
  });

  it("stores icons for an earlier version's profile at its first load, and its second keeps them", () => {
    const store = storeOf({ [SCHEMA_KEY]: "1", "agent-dag.detailOpen": "1" });
    expect(load(store)).toBe(false);
    expect(stored[STRIPE_WORDS_KEY]).toBe("off");
    expect(load(storeOf({ ...stored }))).toBe(false);
    expect(stored[STRIPE_WORDS_KEY]).toBe("off");
  });

  it.each([SCHEMA_KEY, "agent-dag.detailOpen", "agent-dag.sessionListOpen"])(
    "stores icons for a profile that holds %s from an earlier load", key => {
      const store = storeOf({ [key]: "1" });
      expect(settleStripeWords(store)).toBe(true);
      expect(store.getItem(STRIPE_WORDS_KEY)).toBe("off");
      browser({ ...stored });
      expect(stripeWordsShown()).toBe(false);
    },
  );

  it("never overrides a choice the profile made", () => {
    for (const choice of ["on", "off"]) {
      const store = storeOf({ [SCHEMA_KEY]: "1", [STRIPE_WORDS_KEY]: choice });
      expect(settleStripeWords(store)).toBe(false);
      expect(store.getItem(STRIPE_WORDS_KEY)).toBe(choice);
    }
  });

  it("costs a refusing store nothing but the choice", () => {
    expect(settleStripeWords(null)).toBe(false);
    expect(settleStripeWords({ getItem: () => { throw new Error("blocked"); }, setItem: noop })).toBe(false);
  });

  it("is settled at boot before pruneStaleState stamps the schema key, so this load's stamp never counts", () => {
    const main = sourceOf("main.tsx");
    expect(main.indexOf("settleStripeWords();")).toBeGreaterThan(-1);
    expect(main.indexOf("settleStripeWords();")).toBeLessThan(main.indexOf("pruneStaleState(window.localStorage)"));
    // The order matters: a fresh store stamped first would read as an old one.
    const stampedFirst = fresh();
    pruneStaleState(stampedFirst);
    settleStripeWords(stampedFirst);
    expect(stampedFirst.getItem(STRIPE_WORDS_KEY)).toBe("off");
  });
});

describe("a window under 1100px has no room for words", () => {
  it("draws both stripes as icons and no switch, whatever is stored, and keeps what is stored", () => {
    browser({ [STRIPE_WORDS_KEY]: "on" }, 1099);
    const { left, right } = stripes();
    expect(wordsOf(left.tree).every(w => w === null)).toBe(true);
    expect(wordsOf(right.tree).every(w => w === null)).toBe(true);
    expect(toolbar(left.tree).props["data-words"]).toBeUndefined();
    expect(one(left.tree, e => e.props["data-rail-item"] === "stripe-words")).toBeNull();
    // The foot is Radio and Settings alone, named so.
    expect(one(left.tree, e => e.props.className === "rail-foot")!.props["aria-label"]).toBe("Radio, Settings");
    expect(stored[STRIPE_WORDS_KEY]).toBe("on");
    expect(stripeWordsShown()).toBe(true);
    expect(stripeWordsOn()).toBe(false);
  });

  it("gives the stored choice back once the window is wide again, and takes it away when narrow", () => {
    browser({ [STRIPE_WORDS_KEY]: "on" }, 1000);
    const { left, right } = stripes();
    expect(wordsOf(left.tree).every(w => w === null)).toBe(true);
    resize(1100);
    expect(wordsOf(left.tree)).toEqual(LEFT_WORDS);
    expect(wordsOf(right.tree)).toEqual(RIGHT_WORDS);
    expect(wordSwitch(left.tree).props["aria-label"]).toBe("Hide words");
    resize(1099);
    expect(wordsOf(right.tree).every(w => w === null)).toBe(true);
    expect(one(left.tree, e => e.props["data-rail-item"] === "stripe-words")).toBeNull();
    expect(stored[STRIPE_WORDS_KEY]).toBe("on");
  });

  it("keeps icons wide when they were chosen, with the » to bring the words", () => {
    browser({ [STRIPE_WORDS_KEY]: "off" }, 1440);
    const { left } = stripes();
    expect(wordsOf(left.tree).every(w => w === null)).toBe(true);
    expect(wordSwitch(left.tree).props["aria-label"]).toBe("Show words");
  });
});

describe("the right panels at load measure the stripes as drawn", () => {
  // At 1440 with no left column, the two right panels (588) leave the board
  // 772 beside two 40 stripes and 540 beside two 156 ones: under its 600.
  it("counts 156 a stripe with words and 40 with icons", () => {
    browser({ [STRIPE_WORDS_KEY]: "on" }, 1440);
    expect(rightPanelsCrowd(0)).toBe(true);
    browser({ [STRIPE_WORDS_KEY]: "off" }, 1440);
    expect(rightPanelsCrowd(0)).toBe(false);
  });

  it("counts 40 under 1100 whatever is stored, the icons drawn there", () => {
    browser({ [STRIPE_WORDS_KEY]: "on" }, 1099);
    expect(stripeWidth()).toBe(40);
    browser({ [STRIPE_WORDS_KEY]: "on" }, 1100);
    expect(stripeWidth()).toBe(156);
    browser({ [STRIPE_WORDS_KEY]: "off" }, 1100);
    expect(stripeWidth()).toBe(40);
    // And a fresh profile, nothing stored yet, is drawn with words.
    browser({}, 1440);
    expect(stripeWidth()).toBe(156);
  });

  it("takes the widths from the sheet's own tokens", () => {
    const root = sheetRules().filter(r => r.media === null && r.selectors.includes(":root"));
    const token = (prop: string) => root.map(r => declared(r.body, prop)).filter(Boolean).at(-1);
    expect(token("--edge-w")).toBe(`${STRIPE_W.icons}px`);
    expect(token("--edge-words-w")).toBe(`${STRIPE_W.words}px`);
  });
});

describe("the phone's dock is unchanged", () => {
  it("draws its own short words, whatever the stripes do", () => {
    const r = rails();
    for (const seed of [{}, { [STRIPE_WORDS_KEY]: "off" }]) {
      browser(seed);
      const view = kept(mount(EdgeDock, { items: [...r.left, ...r.right[0]], more: [...r.right.slice(1).flat(), r.utilities[0]] }));
      const buttons = doors(view.tree);
      expect(buttons).toHaveLength(r.left.length + r.right[0].length);
      expect(buttons.every(b => b.props.variant === "dock" && b.props.word === undefined)).toBe(true);
      expect(one(view.tree, e => e.props["data-rail-item"] === "stripe-words")).toBeNull();
    }
  });
});

describe("the sheet: 156 with words, the board keeps the rest", () => {
  const rules = sheetRules();
  /** The last value `selector` declares for `prop` in `media`, as written. */
  const decl = (selector: string, prop: string, media: string | null = null) => {
    let found: string | undefined;
    for (const r of rules) {
      if (r.media !== media || !r.selectors.includes(selector)) continue;
      found = declared(r.body, prop) ?? found;
    }
    return found;
  };

  it("widens --edge-w on .app itself, so its padding and everything kept clear of a stripe move with it", () => {
    expect(decl(":root", "--edge-words-w")).toBe("156px");
    expect(decl(":root", "--edge-w")).toBe("40px");
    // Only where the stripes may show words at all (stripe-words.ts's query).
    expect(decl(".app:has(> .edge-rail[data-words])", "--edge-w", "(min-width: 1100px)")).toBe("var(--edge-words-w)");
    expect(decl(".app:has(> .edge-rail[data-words])", "--edge-w", "(min-width: 641px)")).toBeUndefined();
    expect(decl(".app", "padding-inline")).toBe("var(--edge-w)");
    expect(decl(".edge-rail", "width")).toBe("var(--edge-w)");
  });

  it("grows on the column's tempo and never moves under reduced motion", () => {
    // Registered as a length, or a custom property would jump, not grow.
    expect(sheetText()).toMatch(/@property --edge-w \{ syntax: "<length>"; inherits: true; initial-value: 40px; \}/);
    expect(decl(".app:has(> .edge-rail[data-words])", "transition", "(min-width: 1100px)")).toBe("--edge-w var(--dur-move) var(--ease-stage)");
    expect(decl(".app:has(> .edge-rail[data-words])", "transition", "(prefers-reduced-motion: reduce)")).toBe("none");
  });

  it("draws a door as a row with its word cut by an ellipsis, the count at its end, Feedback still in the corner", () => {
    expect(decl(".edge-rail[data-words] .rail-btn-stripe", "width")).toBe("auto");
    expect(decl(".edge-rail[data-words] .rail-btn-stripe", "justify-content")).toBe("flex-start");
    expect(decl(".rail-btn-stripe .rail-word", "text-overflow")).toBe("ellipsis");
    expect(decl(".rail-btn-stripe .rail-word", "white-space")).toBe("nowrap");
    expect(decl(".rail-btn-stripe .rail-word", "min-width")).toBe("0");
    expect(decl(".edge-rail[data-words] .rail-btn-stripe .rail-badge", "position")).toBe("static");
    expect(decl(".edge-rail-left[data-words] .rail-btn-stripe::before", "right")).toBe("-6px");
    expect(decl(".edge-rail-right[data-words] .rail-btn-stripe::before", "left")).toBe("-6px");
    expect(decl(".topbar .tb-corner > .utility-run", "margin-left", "(min-width: 641px)")).toBe("auto");
    // No rule hides a word: a hidden word is not drawn at all.
    expect(rules.some(r => r.selectors.some(s => s.includes("rail-word")) && /display:\s*none/.test(r.body))).toBe(false);
  });
});

describe("three doors with a glyph of their own", () => {
  it("Capacity is a battery, This machine a screen, Radar rings with a centre", () => {
    expect(KIT_ICONS.capacity.els).toEqual([
      { d: "M1.8 4.4H10.6V9.6H1.8V4.4Z" },
      { d: "M12.4 6.2V7.8M4.2 6.5V7.5M6.4 6.5V7.5" },
    ]);
    expect(KIT_ICONS.machine.els).toEqual([
      { d: "M1.8 2.4H12.2V9.2H1.8V2.4Z" },
      { d: "M4.8 11.8H9.2M7 9.2V11.8" },
    ]);
    expect(KIT_ICONS.radar.els).toEqual([
      { d: "M12 7A5 5 0 1 1 7 2" },
      { d: "M9.4 7A2.4 2.4 0 1 1 7 4.6" },
      { d: "M7 7L11 3" },
      { cx: 7, cy: 7, r: 0.9, fill: true },
    ]);
    for (const name of ["capacity", "machine", "radar"] as const) expect(KIT_ICONS[name].size).toBe(14);
  });

  it("no longer shares a drawing with Usage or Settings", () => {
    const d = (name: keyof typeof KIT_ICONS) => JSON.stringify(KIT_ICONS[name].els);
    expect(new Set([d("usage"), d("capacity"), d("radar")]).size).toBe(3);
    expect(d("machine")).not.toBe(d("settings"));
  });
});
