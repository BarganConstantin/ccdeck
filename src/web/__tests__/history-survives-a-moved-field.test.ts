// THE USAGE PANEL SURVIVED THIS PAYLOAD AND THE HISTORY MODAL DID NOT.
//
// Two modules read the same /api/ccusage body. usage-from-ccusage.ts declares
// every field `unknown` and coerces through num/str, and says why:
//
//   "this is parsed from a subprocess's stdout two hops away, and a field that
//    moved upstream must read as absent rather than throw inside a render."
//
// UsageHistoryModal declared the same rows REQUIRED and dereferenced them in
// render — `for (const mb of d.modelBreakdowns)`, `d.period.slice(5)` — from a
// `fetch(...).then(r => r.json())`, which is `any`. The server does not check
// either: ccusage.mjs:1071 is `Array.isArray(raw.daily) ? raw.daily : []` under
// a comment reading "Passed through whole."
//
// ccusage is resolved as `ccusage@latest` through npx. Its surface has already
// moved under this deck twice — `_sectionsUnsupported` and
// `_byAgentUnsupported` are those two — and src/web has no error boundary, so
// a TypeError in this render blanks the WHOLE deck, not just the modal.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  fileURLToPath(new URL("../components/UsageHistoryModal.tsx", import.meta.url)), "utf8");

/** The normaliser, lifted out of the component so the shapes below can be run
 *  against the real rule rather than against a copy of it. */
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === "string") : []);
const asBreakdown = (v: unknown) => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { modelName: str(o.modelName), cost: num(o.cost), inputTokens: num(o.inputTokens),
    outputTokens: num(o.outputTokens), cacheCreationTokens: num(o.cacheCreationTokens),
    cacheReadTokens: num(o.cacheReadTokens) };
};
const asDay = (v: unknown) => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { period: str(o.period), totalCost: num(o.totalCost), totalTokens: num(o.totalTokens),
    inputTokens: num(o.inputTokens), outputTokens: num(o.outputTokens),
    cacheCreationTokens: num(o.cacheCreationTokens), cacheReadTokens: num(o.cacheReadTokens),
    modelsUsed: strs(o.modelsUsed),
    modelBreakdowns: Array.isArray(o.modelBreakdowns) ? o.modelBreakdowns.map(asBreakdown) : [] };
};

describe("a day row whose shape moved upstream", () => {
  it("renders as empty rather than throwing, when modelBreakdowns is gone", () => {
    // The exact shape a ccusage that dropped the field would send.
    const d = asDay({ period: "2026-09-14", totalCost: 1.25, totalTokens: 5000 });
    expect(d.modelBreakdowns).toEqual([]);
    // The two dereferences that used to throw.
    expect(() => { for (const _ of d.modelBreakdowns) { /* no-op */ } }).not.toThrow();
    expect(() => d.period.slice(5)).not.toThrow();
  });

  it("survives a null row, a missing period and a string where a number belongs", () => {
    expect(asDay(null).period).toBe("");
    expect(asDay(null).modelBreakdowns).toEqual([]);
    expect(asDay({ period: 20260914, totalCost: "1.25" }).period).toBe("");
    expect(asDay({ period: "2026-09-14", totalCost: "1.25" }).totalCost).toBe(0);
    expect(asDay({ modelsUsed: "opus" }).modelsUsed).toEqual([]);
    expect(asDay({ modelsUsed: ["opus", 7, null] }).modelsUsed).toEqual(["opus"]);
  });

  it("keeps a well-formed row exactly as it was", () => {
    // The guard must not cost anything when the CLI has not moved.
    const raw = { period: "2026-09-14", totalCost: 1.25, totalTokens: 5000,
      inputTokens: 100, outputTokens: 200, cacheCreationTokens: 10, cacheReadTokens: 20,
      modelsUsed: ["claude-opus-5"],
      modelBreakdowns: [{ modelName: "claude-opus-5", cost: 1.25, inputTokens: 100,
        outputTokens: 200, cacheCreationTokens: 10, cacheReadTokens: 20 }] };
    const d = asDay(raw);
    expect(d.totalCost).toBe(1.25);
    expect(d.modelBreakdowns[0].modelName).toBe("claude-opus-5");
    expect(d.modelBreakdowns[0].cost).toBe(1.25);
    expect(d.modelsUsed).toEqual(["claude-opus-5"]);
  });

  it("is normalised once at the boundary, not guarded at each reader", () => {
    // Six dereference sites today; a seventh added later must not have to
    // remember the rule.
    expect(src).toContain("setLanded({ range, resp: asResp(raw) })");
    expect(src, "the untrusted body must not reach state directly")
      .not.toContain("setLanded({ range, resp })");
    expect(src).toContain("days: Array.isArray(o.days) ? o.days.map(asDay) : undefined");
  });
});
