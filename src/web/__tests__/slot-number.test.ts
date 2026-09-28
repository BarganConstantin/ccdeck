// What may stand in a claude-swap argument vector as a slot number.
//
// The account switch (claude-accounts.mjs) and the rotation flag
// (cswap-auto.mjs) each put `String(n)` straight into argv, and each wrote the
// bound out for itself. It is one rule now, slotNumber, and both ask it. The
// routes are driven end to end in every-store-writer-takes-the-mutex.test.ts,
// which checks that a refused slot never reaches the lock; this file pins the
// rule's own answers and that it is written once.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error — .mjs server module, no types
import { slotNumber } from "../../server/claude-accounts.mjs";

const codeOf = (name: string) => readFileSync(new URL(`../../server/${name}`, import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

describe("slotNumber", () => {
  it("answers a whole number from 1 to 999 as that number", () => {
    for (const n of [1, 2, 42, 999]) expect(slotNumber(n)).toBe(n);
  });

  it("reads the number out of the string a route hands it", () => {
    expect(slotNumber("3")).toBe(3);
    expect(slotNumber("999")).toBe(999);
  });

  it("answers null for anything a child's parser could take for an option", () => {
    // `String(-1)` is "-1", which is as flag-shaped as "-h".
    for (const v of [-1, "-1", "-h", "--help", 0, "0"]) expect(slotNumber(v), String(v)).toBeNull();
  });

  it("answers null for a number past the last slot, a fraction, or no number at all", () => {
    for (const v of [1000, 1.5, NaN, Infinity, "2; rm -rf /", "two", undefined, null, ""]) {
      expect(slotNumber(v), String(v)).toBeNull();
    }
  });

  it("is the one place the bound is written, and both mutations ask it", () => {
    const accounts = codeOf("claude-accounts.mjs");
    const auto = codeOf("cswap-auto.mjs");
    expect((accounts + auto).match(/\b999\b/g) ?? []).toHaveLength(1);
    expect(accounts).toMatch(/export function switchClaudeAccount[\s\S]*?const num = slotNumber\(accountNum\);/);
    expect(auto).toMatch(/export async function setAccountEnabled[\s\S]*?const num = slotNumber\(accountNum\);/);
  });
});
