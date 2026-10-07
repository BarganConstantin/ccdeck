// The threshold picker's `Custom…`.
//
// The picker offered 70, 80, 85, 90 and 95, and a value set from the terminal
// was kept on offer once it was there; there was no way to set one from the
// deck. `Custom…` is now the last option, and choosing it puts a number field
// in the picker's place: whole numbers from 50 to 99, Enter or `save` to store,
// Escape to go back. The server takes 50 to 99.9 and stays the rule.
//
// What the field does is editThreshold and commitThreshold
// (auto-switch-threshold.ts), which are plain functions, so the moves are
// asked of them directly; what it looks like is the row rendered to markup;
// and the bounds are asked of both ends — the page's check, and the server's
// own refusal of a value that got past it — with exec.mjs mocked so nothing is
// ever spawned.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const runs: Array<{ file: string; args: string[] }> = [];
vi.mock("../../server/exec.mjs", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return {
    ...real,
    run: async (file: string, args: string[]) => { runs.push({ file, args }); return { ok: true, stdout: "", stderr: "" }; },
  };
});

// @ts-expect-error — .mjs server module, no types
const { setCswapConfig, settingArg } = await import("../../server/cswap-auto.mjs");

import AutoSwitchPolicy from "../components/AutoSwitchPolicy";
import {
  checkThreshold, commitThreshold, CUSTOM_HINT, CUSTOM_MAX, CUSTOM_MIN, CUSTOM_PICK, editThreshold, NO_DRAFT,
  type ThresholdDraft,
} from "../auto-switch-threshold";
import { thresholdCommit } from "../picker-commit";
import { type AutoStatus } from "../claude-accounts";
import { accountsSurface } from "./accounts-surface";
import { withoutComments } from "./tsx-scan";

const auto = (stored: string): AutoStatus => ({
  ok: true, enabled: true, external: false, lastTick: null,
  settings: { "autoswitch.threshold": { value: stored, isDefault: false } },
});

/** The policy row for a draft over a stored value, given what the panel's hook
 *  hands it: the pick is the draft's or the store's, the field is open while
 *  the draft says so. */
function row(draft: ThresholdDraft, stored: string): string {
  const pick = draft.pick ?? stored;
  return renderToStaticMarkup(createElement(AutoSwitchPolicy, {
    auto: auto(stored), threshold: stored, thresholdPick: pick,
    thresholdCtl: thresholdCommit(pick, stored), thresholdSaved: false,
    thresholdRef: null, thresholdSaveRef: null, thresholdFieldRef: null,
    thresholdCustom: draft.custom != null, thresholdRefusal: draft.refusal,
    proposeThreshold: () => {}, typeThreshold: () => {}, cancelThreshold: () => {}, leaveThreshold: () => {},
    doThreshold: () => {}, pressProps: () => ({}), post: async () => null, load: async () => {},
  }));
}

const options = (html: string) => [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(m => m[2]);
const selected = (html: string) => /<option value="([^"]*)" selected="">/.exec(html)?.[1] ?? null;
const input = (html: string) => /<input[^>]*>/.exec(html)?.[0] ?? null;

const choose = (draft: ThresholdDraft, pick: string) => editThreshold(draft, { kind: "pick", pick });
const type = (draft: ThresholdDraft, text: string) => editThreshold(draft, { kind: "type", text });
const cancel = (draft: ThresholdDraft) => editThreshold(draft, { kind: "cancel" });

describe("choosing Custom…", () => {
  it("is the picker's last option, after the five", () => {
    const html = row(NO_DRAFT, "90");
    expect(options(html)).toEqual(["70%", "80%", "85%", "90%", "95%", "Custom…"]);
    expect(html).toContain(`<option value="${CUSTOM_PICK}">Custom…</option>`);
    expect(selected(html)).toBe("90");
  });

  it("puts a field in the picker's place, holding what the picker showed", () => {
    const open = choose(NO_DRAFT, CUSTOM_PICK);
    expect(open.custom).toEqual({ from: null });
    const html = row(open, "90");
    expect(html).not.toContain("<select");
    const field = input(html);
    expect(field).not.toBeNull();
    expect(field).toContain('aria-label="Switch threshold"');
    expect(field).toContain('inputMode="numeric"');
    expect(field).toContain('value="90"');
    expect(field).not.toContain("aria-invalid");
    expect(html).toMatch(/<span class="ap-threshold-unit" aria-hidden="true">%<\/span>/);
  });

  it("says what it takes under itself, and is described by it", () => {
    const html = row(choose(NO_DRAFT, CUSTOM_PICK), "90");
    expect(CUSTOM_HINT).toBe("A whole percent from 50 to 99.");
    const note = /<p id="([^"]+)" class="ap-threshold-note">([^<]+)<\/p>/.exec(html);
    expect(note?.[2]).toBe(CUSTOM_HINT);
    expect(input(html)).toContain(`aria-describedby="${note?.[1]}"`);
  });

  it("starts from a pick nobody saved yet, when one was showing", () => {
    const open = choose(choose(NO_DRAFT, "80"), CUSTOM_PICK);
    expect(open).toEqual({ pick: "80", custom: { from: "80" }, refusal: null });
    expect(input(row(open, "90"))).toContain('value="80"');
  });

  it("is a form, so Enter is the same press as save", () => {
    const policy = withoutComments(accountsSurface());
    expect(policy).toMatch(/onSubmit=\{e => \{ e\.preventDefault\(\); doThreshold\(thresholdPick, thresholdCtl\); \}\}/);
    expect(policy).toMatch(/onClick=\{\(\) => doThreshold\(thresholdPick, thresholdCtl\)\}/);
  });
});

describe("Escape", () => {
  it("puts the picker back showing what it showed before", () => {
    expect(cancel(type(choose(NO_DRAFT, CUSTOM_PICK), "77"))).toEqual(NO_DRAFT);
    expect(cancel(type(choose(choose(NO_DRAFT, "80"), CUSTOM_PICK), "77"))).toEqual({ pick: "80", custom: null, refusal: null });
    expect(selected(row(cancel(type(choose(NO_DRAFT, CUSTOM_PICK), "77")), "90"))).toBe("90");
  });

  it("takes a refusal away with the field", () => {
    const refused = editThreshold(type(choose(NO_DRAFT, CUSTOM_PICK), "40"), { kind: "refuse", message: "x" });
    expect(cancel(refused)).toEqual(NO_DRAFT);
  });

  it("does nothing to a draft with no field open", () => {
    const picked = choose(NO_DRAFT, "80");
    expect(cancel(picked)).toBe(picked);
  });

  it("is answered by the row only while the field is open, and never mid-composition", () => {
    const surface = withoutComments(accountsSurface());
    expect(surface).toMatch(/<div className="ap-policy" onKeyDown=\{thresholdCustom \? cancelThreshold : undefined\}>/);
    const handler = /const cancelThreshold = \(e: KeyboardEvent\) => \{[\s\S]*?\n {2}\};/.exec(surface)?.[0] ?? "";
    expect(handler).toMatch(/e\.key !== "Escape" \|\| e\.nativeEvent\.isComposing \|\| !draft\.custom/);
    expect(handler).toMatch(/e\.stopPropagation\(\)/);
    expect(handler).toMatch(/refocusPicker\.current = true/);
  });
});

describe("what the page will send", () => {
  it("takes a whole number from 50 to 99, as the number it is", () => {
    expect([CUSTOM_MIN, CUSTOM_MAX]).toEqual([50, 99]);
    expect(checkThreshold("88")).toEqual({ ok: true, value: "88" });
    expect(checkThreshold("50")).toEqual({ ok: true, value: "50" });
    expect(checkThreshold("99")).toEqual({ ok: true, value: "99" });
    expect(checkThreshold(" 088 ")).toEqual({ ok: true, value: "88" });
    expect(checkThreshold("75%")).toEqual({ ok: true, value: "75" });
  });

  it("refuses each kind of value it will not send, in a short plain sentence", () => {
    const cases: Array<[string, string, string]> = [
      ["", "empty", "Enter a number from 50 to 99."],
      ["   ", "empty", "Enter a number from 50 to 99."],
      ["%", "empty", "Enter a number from 50 to 99."],
      ["abc", "not_a_number", "Enter a number from 50 to 99."],
      ["8a", "not_a_number", "Enter a number from 50 to 99."],
      ["-60", "not_a_number", "Enter a number from 50 to 99."],
      ["1e2", "not_a_number", "Enter a number from 50 to 99."],
      ["88.5", "not_whole", "Use a whole number from 50 to 99."],
      ["99.9", "not_whole", "Use a whole number from 50 to 99."],
      ["49", "too_low", "The lowest is 50%."],
      ["0", "too_low", "The lowest is 50%."],
      ["100", "too_high", "The highest is 99%."],
      ["150", "too_high", "The highest is 99%."],
    ];
    for (const [text, reason, message] of cases) {
      expect(checkThreshold(text), JSON.stringify(text)).toEqual({ ok: false, reason, message });
    }
  });

  it("never sends a refused value, and says why under the field", async () => {
    for (const text of ["", "abc", "88.5", "49", "100"]) {
      const post = vi.fn(async () => ({ ok: true }));
      const outcome = await commitThreshold(text, thresholdCommit(text, "90"), post);
      expect(outcome, text).toEqual({ kind: "refused", message: (checkThreshold(text) as { message: string }).message });
      expect(post, text).not.toHaveBeenCalled();
    }
    const refused = editThreshold(type(choose(NO_DRAFT, CUSTOM_PICK), "49"), { kind: "refuse", message: "The lowest is 50%." });
    const html = row(refused, "90");
    expect(input(html)).toContain('aria-invalid="true"');
    expect(input(html)).toContain('value="49"');
    expect(html).toMatch(/<p id="[^"]+" class="ap-threshold-note" role="alert" data-tone="err">The lowest is 50%\.<\/p>/);
    expect(html).not.toContain(CUSTOM_HINT);
  });

  it("clears the refusal as soon as the text changes", () => {
    const refused = editThreshold(type(choose(NO_DRAFT, CUSTOM_PICK), "49"), { kind: "refuse", message: "The lowest is 50%." });
    expect(type(refused, "5")).toEqual({ pick: "5", custom: { from: null }, refusal: null });
  });

  it("sends a valid one through the threshold's one write, as a whole number", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    expect(await commitThreshold(" 088", thresholdCommit(" 088", "90"), post)).toEqual({ kind: "sent", ok: true });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ action: "setting", key: "autoswitch.threshold", value: "88" }, "threshold");
    // And there is no second way to write it from the panel: the key appears in
    // one request body, commitThreshold's, and doThreshold goes through it.
    const surface = withoutComments(accountsSurface());
    expect([...surface.matchAll(/key: "autoswitch\.threshold"/g)]).toHaveLength(1);
    expect(surface).toMatch(/const doThreshold = async[\s\S]*?await commitThreshold\(pick, commit, post\)/);
  });

  it("skips the round trip for the value the store already holds", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    expect(await commitThreshold("90", thresholdCommit("90", "90"), post)).toEqual({ kind: "unchanged" });
    // A tenth set from the terminal is the store's own value, so the field it
    // pre-fills closes on Enter rather than refusing it.
    expect(await commitThreshold("92.5", thresholdCommit("92.5", "92.5"), post)).toEqual({ kind: "unchanged" });
    expect(post).not.toHaveBeenCalled();
  });

  it("reports a write the server refused, so the field stays to be fixed", async () => {
    const post = vi.fn(async () => ({ ok: false }));
    expect(await commitThreshold("88", thresholdCommit("88", "90"), post)).toEqual({ kind: "sent", ok: false });
    const absent = vi.fn(async () => null);
    expect(await commitThreshold("88", thresholdCommit("88", "90"), absent)).toEqual({ kind: "sent", ok: false });
  });
});

describe("after a save", () => {
  it("follows the store again, with the field closed", () => {
    const typed = type(choose(NO_DRAFT, CUSTOM_PICK), "88");
    expect(editThreshold(typed, { kind: "settle" })).toEqual(NO_DRAFT);
  });

  it("shows the custom value as an ordinary chosen option, with Custom… still last", () => {
    const html = row(NO_DRAFT, "88");
    expect(options(html)).toEqual(["70%", "80%", "85%", "88%", "90%", "95%", "Custom…"]);
    expect(selected(html)).toBe("88");
    expect(html).not.toContain("ap-threshold-note");
  });

  it("opens the field again from there, holding the custom value", () => {
    expect(input(row(choose(NO_DRAFT, CUSTOM_PICK), "88"))).toContain('value="88"');
  });

  it("hands focus back to the picker when Enter closed the field under it", () => {
    const surface = withoutComments(accountsSurface());
    const commit = /const doThreshold = async[\s\S]*?\n {2}\};/.exec(surface)?.[0] ?? "";
    expect(commit).toMatch(/refocusPicker\.current = document\.activeElement === thresholdFieldRef\.current;\s*edit\(\{ kind: "settle" \}\)/);
    expect(surface).toMatch(/else if \(refocusPicker\.current\) \{\s*thresholdRef\.current\?\.focus\(\);/);
  });
});

describe("a field losing focus", () => {
  const leave = (draft: ThresholdDraft, stored: string) => editThreshold(draft, { kind: "leave", stored });

  it("closes when it holds nothing to save, which is the way back for a pointer with no Escape", () => {
    expect(leave(choose(NO_DRAFT, CUSTOM_PICK), "90")).toEqual(NO_DRAFT);
    expect(leave(type(choose(NO_DRAFT, CUSTOM_PICK), "90"), "90")).toEqual(NO_DRAFT);
    const surface = withoutComments(accountsSurface());
    expect(surface).toMatch(/onBlur=\{\(\) => leaveThreshold\(\)\}/);
    expect(surface).toMatch(/const leaveThreshold = \(\) => edit\(\{ kind: "leave", stored: threshold \}\);/);
  });

  it("stays while it holds a change, refused or not, the way a picked option does", () => {
    const typed = type(choose(NO_DRAFT, CUSTOM_PICK), "88");
    expect(leave(typed, "90")).toBe(typed);
    const refused = editThreshold(type(choose(NO_DRAFT, CUSTOM_PICK), "45"), { kind: "refuse", message: "The lowest is 50%." });
    expect(leave(refused, "90")).toBe(refused);
  });

  it("changes nothing once Escape has closed it, so a late blur cannot drop the pick Escape restored", () => {
    const restored = cancel(type(choose(choose(NO_DRAFT, "80"), CUSTOM_PICK), "90"));
    expect(restored).toEqual({ pick: "80", custom: null, refusal: null });
    expect(leave(restored, "90")).toBe(restored);
  });
});

describe("the server's own bounds, behind the page's", () => {
  const before = process.env.AGENTS_DECK_CSWAP;
  beforeAll(() => { process.env.AGENTS_DECK_CSWAP = "cswap-test-double"; });
  afterAll(() => {
    if (before === undefined) delete process.env.AGENTS_DECK_CSWAP;
    else process.env.AGENTS_DECK_CSWAP = before;
  });
  beforeEach(() => { runs.length = 0; });

  it("accepts every value the page can send", () => {
    for (let n = CUSTOM_MIN; n <= CUSTOM_MAX; n++) {
      const checked = checkThreshold(String(n));
      expect(checked.ok, String(n)).toBe(true);
      expect(settingArg("autoswitch.threshold", (checked as { value: string }).value), String(n)).toEqual({ ok: true, str: String(n) });
    }
  });

  it("refuses a value outside 50 to 99.9 that got past the page, and spawns nothing", async () => {
    for (const value of [49, 49.99, "49", 100, "100", 1000, -1, "abc", ""]) {
      expect(await setCswapConfig("autoswitch.threshold", value), String(value)).toEqual({ ok: false, reason: "out_of_range" });
    }
    expect(runs).toEqual([]);
  });

  it("still writes the edges it allows", async () => {
    for (const value of ["50", "99", "99.9"]) {
      expect(await setCswapConfig("autoswitch.threshold", value), value).toEqual({ ok: true });
    }
    expect(runs.map(r => r.args)).toEqual([
      ["config", "set", "autoswitch.threshold", "50"],
      ["config", "set", "autoswitch.threshold", "99"],
      ["config", "set", "autoswitch.threshold", "99.9"],
    ]);
  });
});
