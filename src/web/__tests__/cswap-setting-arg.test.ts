// What an auto-switch setting's value becomes before it reaches
// `cswap config set <key> <value>`, asked of the rule directly.
//
// settingArg is setCswapConfig's validation, lifted out so that it can be
// called without a `cswap` behind it: it spawns nothing, so every case here is
// a plain call. The routes that reach it — and the flag-shaped values a child's
// own parser would read as options — are driven end to end, through
// setCswapConfig and a scripted exec.mjs, in cswap-argv-position.test.ts and
// settings-allowlist-prototype.test.ts. This file pins the answers themselves.
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs server module, no types
import { settingArg } from "../../server/cswap-auto.mjs";

describe("settingArg", () => {
  it("refuses a key that is not one of the settings the deck writes", () => {
    for (const key of ["autoswitch.doesNotExist", "", "threshold", "constructor", "__proto__", "toString"]) {
      expect(settingArg(key, "1"), key).toEqual({ ok: false, reason: "unknown_setting" });
    }
  });

  it("sends a number as the number it is, not as it was typed", () => {
    expect(settingArg("autoswitch.threshold", 85)).toEqual({ ok: true, str: "85" });
    expect(settingArg("autoswitch.threshold", "085")).toEqual({ ok: true, str: "85" });
    expect(settingArg("autoswitch.threshold", " 92.5 ")).toEqual({ ok: true, str: "92.5" });
    expect(settingArg("autoswitch.intervalSeconds", "6e1")).toEqual({ ok: true, str: "60" });
  });

  it("holds every number to its own range, both ends included", () => {
    expect(settingArg("autoswitch.threshold", 50)).toEqual({ ok: true, str: "50" });
    expect(settingArg("autoswitch.threshold", 99.9)).toEqual({ ok: true, str: "99.9" });
    expect(settingArg("autoswitch.intervalSeconds", 15)).toEqual({ ok: true, str: "15" });
    expect(settingArg("autoswitch.cooldownSeconds", 0)).toEqual({ ok: true, str: "0" });
    for (const [key, value] of [
      ["autoswitch.threshold", 49.9], ["autoswitch.threshold", 100],
      ["autoswitch.intervalSeconds", 14], ["autoswitch.intervalSeconds", 3601],
      ["autoswitch.cooldownSeconds", -1], ["autoswitch.cooldownSeconds", 86401],
      ["autoswitch.hysteresisPct", 51],
    ] as const) {
      expect(settingArg(key, value), `${key}=${value}`).toEqual({ ok: false, reason: "out_of_range" });
    }
  });

  it("refuses a number that is not one, rather than sending NaN", () => {
    for (const value of ["abc", NaN, Infinity, "-h", {}, undefined]) {
      expect(settingArg("autoswitch.threshold", value), String(value)).toEqual({ ok: false, reason: "out_of_range" });
    }
  });

  it("sends a model list trimmed, dashes inside names and all", () => {
    expect(settingArg("autoswitch.model", "all")).toEqual({ ok: true, str: "all" });
    expect(settingArg("autoswitch.model", "  opus,sonnet ")).toEqual({ ok: true, str: "opus,sonnet" });
    expect(settingArg("autoswitch.model", "claude-3-5-sonnet-20241022, claude-opus-4-1"))
      .toEqual({ ok: true, str: "claude-3-5-sonnet-20241022, claude-opus-4-1" });
  });

  it("passes an empty model list through as an empty argument", () => {
    expect(settingArg("autoswitch.model", "")).toEqual({ ok: true, str: "" });
    expect(settingArg("autoswitch.model", "   ")).toEqual({ ok: true, str: "" });
    expect(settingArg("autoswitch.model", null)).toEqual({ ok: true, str: "" });
  });

  it("refuses a model list that would read as an option, or carries anything but plain names", () => {
    for (const value of ["-h", "--help", " -h ", "-all", "opus;rm", "opus|sonnet", "a".repeat(121)]) {
      expect(settingArg("autoswitch.model", value), value).toEqual({ ok: false, reason: "bad_value" });
    }
    expect(settingArg("autoswitch.model", "a".repeat(120))).toEqual({ ok: true, str: "a".repeat(120) });
  });
});
