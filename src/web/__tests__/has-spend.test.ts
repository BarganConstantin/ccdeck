// "Has this been billed for anything?" — the one question three readers of a
// transcript's usage ask before they report it: a file's own totals, one
// model's bucket of them, and each subagent file a session delegated to. Each
// spelled the four tests out by hand, two as `=== 0` and one as truthiness, so
// the rule is held here once, on the function they all call now.
import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs server module, no types
const { hasSpend, newUsageTotals } = await import("../../server/transcript-scan.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { readUsageFromTranscript, readUsageByModelFromTranscript } = await import("../../server/session-enrichment.mjs");

type Totals = Record<string, number>;
const zero = (): Totals => newUsageTotals();
const FLAT = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
const SPLIT = ["ephemeral_1h_input_tokens", "ephemeral_5m_input_tokens"];

describe("hasSpend", () => {
  it("is false for a zeroed set of totals", () => {
    expect(hasSpend(zero())).toBe(false);
  });

  it("is true when any one of the four billed counters is", () => {
    for (const k of FLAT) {
      const u = zero();
      u[k] = 1;
      expect(hasSpend(u), k).toBe(true);
    }
  });

  it("does not count the TTL split, which divides cache writes rather than adding to them", () => {
    for (const k of SPLIT) {
      const u = zero();
      u[k] = 5;
      expect(hasSpend(u), k).toBe(false);
    }
  });

  it("counts a counter that overflowed to Infinity as spent", () => {
    const u = zero();
    u.output_tokens = Number("9".repeat(400));
    expect(hasSpend(u)).toBe(true);
  });
});

describe("the readers that ask it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccdeck-has-spend-"));
  afterAll(() => rmTempDir(dir));
  const line = (usage: Totals & { cache_creation?: Totals }) =>
    JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-7", usage } }) + "\n";

  it("report nothing for a transcript whose only tokens are the TTL split", async () => {
    const path = join(dir, "split-only.jsonl");
    writeFileSync(path, line({ ...zero(), cache_creation: { ephemeral_1h_input_tokens: 7, ephemeral_5m_input_tokens: 0 } }));
    expect(await readUsageFromTranscript(path)).toBeNull();
    expect(await readUsageByModelFromTranscript(path)).toBeNull();
  });

  it("report the totals, and the model they belong to, once one billed counter is non-zero", async () => {
    const path = join(dir, "billed.jsonl");
    writeFileSync(path, line({ ...zero(), cache_read_input_tokens: 3 }));
    expect((await readUsageFromTranscript(path))?.cache_read_input_tokens).toBe(3);
    expect(Object.keys((await readUsageByModelFromTranscript(path)) ?? {})).toEqual(["claude-opus-4-7"]);
  });
});
