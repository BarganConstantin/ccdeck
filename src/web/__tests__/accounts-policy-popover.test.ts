// The Auto-switch row and its popover, run rather than read.
//
// The popover is drawn over the foot of the column, holds the keyboard while it
// is open, and stores what is pressed in it: the threshold chips, the custom
// field, the two next-account options and the switch. These drive the real
// component and the real draft hook (fake-react.ts has no DOM, so the refs are
// handed in by the test where the document would attach them) and pin what a
// press sends, where a refusal is said, where focus goes, and what is on the
// row with the fold shut.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("react", async () => (await import("./fake-react")).react);

const { all, flush, mount, one, textOf } = await import("./fake-react");
const { default: AutoSwitchPolicy, AutoSwitchSettings } = await import("../components/AutoSwitchPolicy");
const { useThresholdDraft } = await import("../use-threshold-draft");
const { useSettingPost } = await import("../use-setting-post");
import type { AutoStatus } from "../claude-accounts";
import type { Say } from "../use-setting-post";
import { accountsSurface } from "./accounts-surface";
import { withoutComments } from "./tsx-scan";

type El = import("./fake-react").Drawn;

const status = (over: Partial<AutoStatus> = {}, stored = "90"): AutoStatus => ({
  ok: true, enabled: true, external: false, lastTick: null,
  settings: { "autoswitch.threshold": { value: stored, isDefault: false } },
  choice: { next: "room", home: null },
  ...over,
});

interface Harness {
  posts: Array<{ body: Record<string, unknown>; tag: string }>;
  loads: number;
  /** What the next request answers. */
  answer: { ok: boolean };
}

let timers: Array<() => void> = [];
const active = { current: null as unknown };

beforeEach(() => {
  timers = [];
  active.current = { tag: "somewhere else" };
  vi.stubGlobal("window", { setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout: () => {} });
  vi.stubGlobal("document", { get activeElement() { return active.current; }, body: { tag: "body" } });
});
afterEach(() => { vi.unstubAllGlobals(); });

/** The popover's settings over the real draft hook and the real failure line. */
function open(auto = status(), hasHome = false) {
  const h: Harness = { posts: [], loads: 0, answer: { ok: true } };
  let draft!: ReturnType<typeof useThresholdDraft>;
  const raw = async (body: Record<string, unknown>, tag: string, say?: Say) => {
    h.posts.push({ body, tag });
    if (!h.answer.ok) say?.({ text: "claude-swap refused it" });
    return { ok: h.answer.ok };
  };
  const view = mount(() => {
    const failure = useSettingPost(raw);
    draft = useThresholdDraft({ auto, post: failure.settingPost as never, load: async () => { h.loads++; } });
    return AutoSwitchSettings({
      auto, ...draft, titleId: "t", pressProps: () => ({}), post: raw as never,
      settingPost: failure.settingPost, settingFailure: failure.settingFailure, clearSettingFailure: failure.clearSettingFailure,
      load: async () => { h.loads++; }, boundaryId: "ap-scroll", hasHome,
    } as never);
  }, undefined);
  const chips = () => all(view.tree, el => el.type === "button" && el.props.className === "ap-chip");
  const chip = (text: string) => chips().find(c => String(c.props.children).replace(/,/g, "").includes(text))!;
  const failureLine = () => one(view.tree, el => el.props.className === "ap-pop-error");
  return { h, view, draft: () => draft, chips, chip, failureLine };
}

describe("the threshold chips", () => {
  it("store on a press, with the body the select sent", async () => {
    const p = open();
    // The chips carry the percent; the press reads the number.
    const eighty = p.chips().find(c => (c.props.title as string).includes("80%"))!;
    (eighty.props.onClick as () => void)();
    await flush();
    expect(p.h.posts).toEqual([{ body: { action: "setting", key: "autoswitch.threshold", value: "80" }, tag: "threshold" }]);
    expect(p.h.loads).toBe(1);
  });

  it("go back to following the store when the store kept its value", async () => {
    const p = open();
    p.h.answer.ok = false;
    const eighty = p.chips().find(c => (c.props.title as string).includes("80%"))!;
    (eighty.props.onClick as () => void)();
    await flush();
    // The pick is not left standing as a draft nobody can see.
    expect(p.draft().thresholdPick).toBe("90");
    // So `Custom…` opens on the stored value, not on the pick that failed.
    (p.chip("Custom").props.onClick as () => void)();
    await flush();
    expect(p.draft().thresholdCustom).toBe(true);
    expect(p.draft().thresholdPick).toBe("90");
  });

  it("say a refusal inside the popover, which is drawn over the column's foot", async () => {
    const p = open();
    expect(p.failureLine()).toBeNull();
    p.h.answer.ok = false;
    const eighty = p.chips().find(c => (c.props.title as string).includes("80%"))!;
    (eighty.props.onClick as () => void)();
    await flush();
    expect(p.failureLine()?.props.role).toBe("alert");
    expect(String(p.failureLine()?.props.children)).toContain("claude-swap refused it");
  });

  it("are toggle buttons in a labelled group, which owes no arrow keys", () => {
    const p = open();
    const group = one(p.view.tree, el => el.props.className === "ap-auto-chips")!;
    expect(group.props.role).toBe("group");
    expect(group.props["aria-labelledby"]).toBeTruthy();
    for (const c of p.chips()) expect(c.props["aria-pressed"], String(c.props.children)).toBeDefined();
    expect(p.chips().some(c => c.props.role === "radio")).toBe(false);
  });
});

describe("the custom field", () => {
  it("keeps what was typed when the store refuses it, so it can be retried, and says why in the popover", async () => {
    const p = open();
    (p.chip("Custom").props.onClick as () => void)();
    await flush();
    const field = () => one(p.view.tree, el => el.type === "input")!;
    (field().props.onChange as (e: unknown) => void)({ target: { value: "77" } });
    await flush();
    p.h.answer.ok = false;
    const form = one(p.view.tree, el => el.type === "form")!;
    (form.props.onSubmit as (e: unknown) => void)({ preventDefault() {} });
    await flush();
    expect(p.h.posts.at(-1)).toEqual({ body: { action: "setting", key: "autoswitch.threshold", value: "77" }, tag: "threshold" });
    expect(p.draft().thresholdCustom).toBe(true);
    expect(field().props.value).toBe("77");
    expect(p.failureLine()).not.toBeNull();
  });

  it("keeps its save control, and the saved note, after the field closes", async () => {
    const p = open();
    (p.chip("Custom").props.onClick as () => void)();
    await flush();
    const field = () => one(p.view.tree, el => el.type === "input")!;
    (field().props.onChange as (e: unknown) => void)({ target: { value: "77" } });
    await flush();
    const save = () => one(p.view.tree, el => el.type === "button" && el.props.className === "ap-manage-btn");
    expect(save()).not.toBeNull();
    (save()!.props.onClick as () => void)();
    await flush();
    // The field is gone; the form and its button are not, and the button says so.
    expect(p.draft().thresholdCustom).toBe(false);
    expect(one(p.view.tree, el => el.type === "form")).not.toBeNull();
    expect(String(save()?.props.children)).toBe("saved");
  });

  it("hands the keyboard to the Custom chip when saved goes, and not to the page", async () => {
    const p = open();
    const focus = vi.fn();
    p.draft().thresholdRef.current = { focus } as never;
    const saveButton = { name: "save" };
    p.draft().thresholdSaveRef.current = saveButton as never;
    (p.chip("Custom").props.onClick as () => void)();
    await flush();
    const field = () => one(p.view.tree, el => el.type === "input")!;
    (field().props.onChange as (e: unknown) => void)({ target: { value: "77" } });
    await flush();
    const save = one(p.view.tree, el => el.type === "button" && el.props.className === "ap-manage-btn")!;
    (save.props.onClick as () => void)();
    await flush();
    active.current = saveButton;
    for (const run of timers) run();
    expect(focus).toHaveBeenCalledTimes(1);
    await flush();
    expect(one(p.view.tree, el => el.type === "form")).toBeNull();
  });

  it("hands it to the chip when focus has already fallen to the page with the popover open", async () => {
    const p = open();
    const focus = vi.fn();
    p.draft().thresholdRef.current = { focus } as never;
    (p.chip("Custom").props.onClick as () => void)();
    await flush();
    const field = () => one(p.view.tree, el => el.type === "input")!;
    (field().props.onChange as (e: unknown) => void)({ target: { value: "77" } });
    await flush();
    const save = one(p.view.tree, el => el.type === "button" && el.props.className === "ap-manage-btn")!;
    (save.props.onClick as () => void)();
    await flush();
    active.current = (globalThis as { document: { body: unknown } }).document.body;
    for (const run of timers) run();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("returns the keyboard to the Custom chip on Escape, and when the field loses focus to nowhere", async () => {
    const p = open();
    const chipFocus = vi.fn();
    p.draft().thresholdRef.current = { focus: chipFocus } as never;
    p.draft().thresholdFieldRef.current = { focus: vi.fn(), select: vi.fn() } as never;
    (p.chip("Custom").props.onClick as () => void)();
    await flush();
    const escape = { key: "Escape", nativeEvent: { isComposing: false }, preventDefault() {}, stopPropagation() {} };
    p.draft().cancelThreshold(escape as never);
    await flush();
    expect(chipFocus).toHaveBeenCalledTimes(1);

    // And a blur that goes nowhere (the window losing focus), with nothing to save.
    (p.chip("Custom").props.onClick as () => void)();
    await flush();
    const input = one(p.view.tree, el => el.type === "input")!;
    (input.props.onBlur as (e: unknown) => void)({ relatedTarget: null });
    await flush();
    expect(p.draft().thresholdCustom).toBe(false);
    expect(chipFocus).toHaveBeenCalledTimes(2);
  });

  it("does not take the keyboard when the blur is focus moving to another control", async () => {
    const p = open();
    const chipFocus = vi.fn();
    p.draft().thresholdRef.current = { focus: chipFocus } as never;
    p.draft().thresholdFieldRef.current = { focus: vi.fn(), select: vi.fn() } as never;
    (p.chip("Custom").props.onClick as () => void)();
    await flush();
    const input = one(p.view.tree, el => el.type === "input")!;
    (input.props.onBlur as (e: unknown) => void)({ relatedTarget: { tag: "button" } });
    await flush();
    expect(chipFocus).not.toHaveBeenCalled();
  });
});

describe("the next-account options", () => {
  it("store on a press with the body they always sent, and a press on the chosen one sends nothing", async () => {
    const p = open();
    const options = all(p.view.tree, el => el.type === "button" && el.props.className === "ap-auto-option");
    expect(options.map(o => o.props["aria-pressed"])).toEqual([true, false]);
    (options[0].props.onClick as () => void)();
    await flush();
    expect(p.h.posts).toEqual([]);
    (options[1].props.onClick as () => void)();
    await flush();
    expect(p.h.posts).toEqual([{ body: { action: "next", value: "weekly" }, tag: "next" }]);
  });

  it("are a labelled group of toggle buttons, not a radio group", () => {
    const p = open();
    const group = one(p.view.tree, el => el.props.className === "ap-auto-options")!;
    expect(group.props.role).toBe("group");
    const options = all(p.view.tree, el => el.props.className === "ap-auto-option");
    expect(options.every(o => o.props.role === undefined)).toBe(true);
  });

  it("say a refusal in the popover", async () => {
    const p = open();
    p.h.answer.ok = false;
    const options = all(p.view.tree, el => el.type === "button" && el.props.className === "ap-auto-option");
    (options[1].props.onClick as () => void)();
    await flush();
    expect(p.failureLine()).not.toBeNull();
  });
});

describe("the switch in the popover", () => {
  it("sends the enable body it always sent, and its refusal is the popover's", async () => {
    const p = open(status({ enabled: false }));
    const toggle = one(p.view.tree, el => typeof el.type === "function" && "auto" in el.props && "pressProps" in el.props)!;
    p.h.answer.ok = false;
    const drawn = mount(() => (toggle.type as (props: unknown) => El)(toggle.props), undefined);
    ((drawn.tree as El).props.onClick as () => void)();
    await flush();
    expect(p.h.posts).toEqual([{ body: { action: "enable", enabled: true }, tag: "enable" }]);
    expect(p.failureLine()).not.toBeNull();
  });
});

describe("what the row says with the fold shut", () => {
  const props = (auto: AutoStatus, threshold: string) => ({
    auto, threshold, thresholdPick: threshold, thresholdCtl: { sends: false, label: "save", done: "saved", swaps: false, title: "" },
    thresholdSaved: false, thresholdRef: null, thresholdSaveRef: null, thresholdFieldRef: null, thresholdCustom: false,
    thresholdRefusal: null, proposeThreshold: () => {}, typeThreshold: () => {}, cancelThreshold: () => {}, leaveThreshold: () => {},
    doThreshold: () => {}, pressProps: () => ({}), post: async () => null, settingPost: async () => null, settingFailure: null,
    clearSettingFailure: () => {}, load: async () => {}, boundaryId: "ap-codex-scroll",
  });
  /** What the row draws, with the switch drawn too (it is its own component). */
  const row = (auto: AutoStatus, threshold: string) => {
    const view = mount(() => AutoSwitchPolicy(props(auto, threshold) as never), undefined);
    const toggle = one(view.tree, el => typeof el.type === "function" && "auto" in el.props)!;
    const sw = mount(() => (toggle.type as (p: unknown) => El)(toggle.props), undefined);
    return { text: textOf(view.tree), checked: (sw.tree as El).props["aria-checked"], role: (sw.tree as El).props.role };
  };

  it("shows on or off and where it trips, the same for either provider", () => {
    expect(row(status(), "85")).toMatchObject({ role: "switch", checked: true });
    expect(row(status(), "85").text).toContain("at 85%");
    expect(row(status({ enabled: false }), "70")).toMatchObject({ role: "switch", checked: false });
    expect(row(status({ enabled: false }), "70").text).toContain("at 70%");
  });
});

describe("the home note", () => {
  const note = "Home comes back first";
  it("is Claude's: shown with a home account to come back to, absent without one", () => {
    expect(open(status(), true).view.tree).toBeTruthy();
    const text = (hasHome: boolean) => JSON.stringify(open(status(), hasHome).view.tree);
    expect(text(true)).toContain(note);
    expect(text(false)).not.toContain(note);
  });
});

describe("the boundary the popover closes against", () => {
  const policy = withoutComments(accountsSurface());
  it("is named by the column that draws it, never hard-coded", () => {
    expect(policy).toMatch(/<AnchoredPopover anchorId=\{anchorId\} boundaryId=\{boundaryId\} id=\{popId\}/);
    expect(policy).toMatch(/boundaryId="ap-scroll" hasHome/);
    const codex = readFileSync(fileURLToPath(new URL("../components/CodexProfilesSection.tsx", import.meta.url)), "utf8");
    expect(codex).toMatch(/boundaryId="ap-codex-scroll"/);
    expect(codex).toMatch(/<div className="ap-scroll" id="ap-codex-scroll">/);
    expect(policy).not.toMatch(/AnchoredPopover anchorId=\{anchorId\} boundaryId="/);
  });
});
