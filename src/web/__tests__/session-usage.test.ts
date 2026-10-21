import { describe, it, expect, vi, beforeEach } from "vitest";
import { canInspectSession, sessionFailure } from "../session-usage";
// @ts-expect-error — server ES module
import { sessionDetail, validSessionLookup } from "../../server/ccusage-session.mjs";

const calls = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../server/ccusage-runner.mjs", () => ({
  runCcusage: calls.run, userCcusage: () => null, overrideIsThere: () => false,
}));
// @ts-expect-error — server ES module
const { fetchCcusageSession, fetchCcusageDaily } = await import("../../server/ccusage.mjs");
const id = "01a0bb8c-c7c0-7630-9d82-860b875930f0";
const codex = {
  sessionId: `sessions/2026/10/12/rollout-2026-10-12T09-00-00-${id}`,
  totalCost: 2.4, totalTokens: 1010, inputTokens: 700, outputTokens: 100,
  cacheReadTokens: 200, cacheCreationTokens: 10, reasoningOutputTokens: 40,
  lastActivity: "2026-10-12T09:00:00Z",
  models: { "gpt-6-sol": { inputTokens: 700, outputTokens: 100, cacheReadTokens: 200, cacheCreationTokens: 10, reasoningOutputTokens: 40 } },
};

describe("session lookup boundary", () => {
  it("accepts full Codex IDs and opaque Claude filenames, never shell options or paths", () => {
    expect(validSessionLookup("codex", id, "flex")).toBe(true);
    expect(validSessionLookup("claude", "project-conversation-123")).toBe(true);
    for (const bad of ["", "--help", "../auth", "a/b", "a\\b", "a;echo", "$(id)", "abc", "a\n"]) {
      expect(validSessionLookup("codex", bad)).toBe(false);
      expect(canInspectSession("codex", bad)).toBe(false);
    }
    expect(validSessionLookup("claude", "../auth")).toBe(false);
    expect(validSessionLookup("other", id)).toBe(false);
    expect(validSessionLookup("claude", id, "fast")).toBe(false);
    expect(validSessionLookup("codex", id, "turbo")).toBe(false);
    expect(canInspectSession("claude", "project-conversation-123")).toBe(true);
  });
});

describe("whole-session figures", () => {
  it("uses Claude's calculated total while aggregating tokens and activity across models", () => {
    const detail = sessionDetail({ sessionId: "claude-session", totalCost: 7.5, totalTokens: 46, entries: [
      { timestamp: "2026-10-12T10:00:00Z", model: "claude-haiku-5-5", inputTokens: 10, outputTokens: 2, cacheReadTokens: 20, costUSD: 0 },
      { timestamp: "2026-10-11T09:00:00Z", model: "claude-sonnet-5-5", inputTokens: 5, outputTokens: 3, cacheCreationTokens: 6, costUSD: 0 },
    ] }, "claude", "claude-session");
    expect(detail).toMatchObject({ totalCost: 7.5, totalTokens: 46, inputTokens: 15, outputTokens: 5, cacheReadTokens: 20, cacheCreationTokens: 6, entries: 2 });
    expect(detail.firstActivity).toBe("2026-10-11T09:00:00Z");
    expect(detail.lastActivity).toBe("2026-10-12T10:00:00Z");
    expect(detail.models.map((row: { totalTokens: number }) => row.totalTokens)).toEqual([32, 14]);
    expect(JSON.stringify(detail)).not.toContain("costUSD");
  });
  it("keeps Codex reasoning inside output and missing prices explicit", () => {
    const detail = sessionDetail({ ...codex, models: {
      ...codex.models, "unknown-model": { inputTokens: 3, outputTokens: 2, missingPricing: true },
    } }, "codex", id, "fast");
    expect(detail).toMatchObject({ totalCost: 2.4, totalTokens: 1010, reasoningOutputTokens: 40, speed: "fast", firstActivity: null });
    expect(detail.models[0].totalTokens).toBe(1010);
    expect(detail.models[1]).toMatchObject({ model: "unknown-model", missingPricing: true, totalTokens: 5 });
    expect(detail).not.toHaveProperty("directory");
  });
  it("rejects another session, unsupported output and non-finite cost", () => {
    expect(sessionDetail(codex, "codex", "11111111-1111-1111-1111-111111111111")).toBeNull();
    expect(sessionDetail({ ...codex, totalCost: NaN }, "codex", id)).toBeNull();
    expect(sessionDetail({ ...codex, totalCost: -1 }, "codex", id)).toBeNull();
    expect(sessionDetail({ ...codex, models: null }, "codex", id)).toBeNull();
    expect(sessionDetail(null, "claude", "empty")).toBeNull();
  });
});

describe("session reads share the bounded ccusage queue", () => {
  beforeEach(() => { calls.run.mockReset(); });
  it("sends explicit scenarios, deduplicates in-flight reads and serves its cache", async () => {
    calls.run.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { out: JSON.stringify(codex) }; });
    const [first, second] = await Promise.all([
      fetchCcusageSession({ agent: "codex", sessionId: id, speed: "flex" }),
      fetchCcusageSession({ agent: "codex", sessionId: id, speed: "flex", force: true }),
    ]);
    expect(first).toEqual(second);
    expect(calls.run).toHaveBeenCalledTimes(1);
    expect(calls.run).toHaveBeenCalledWith(["codex", "session", "--id", id, "--json", "--speed", "flex"]);
    await fetchCcusageSession({ agent: "codex", sessionId: id, speed: "flex" });
    expect(calls.run).toHaveBeenCalledTimes(1);
    await fetchCcusageSession({ agent: "codex", sessionId: id, speed: "flex", force: true });
    expect(calls.run).toHaveBeenCalledTimes(2);
  });
  it("never retries an unsupported scenario as standard pricing", async () => {
    calls.run.mockRejectedValue(new Error("Unknown option '--speed'"));
    const result = await fetchCcusageSession({ agent: "codex", sessionId: id, speed: "fast", force: true });
    expect(result.ok).toBe(false);
    expect(calls.run).toHaveBeenCalledTimes(1);
    expect(sessionFailure(result)).toContain("Update ccusage");
  });
  it("recognizes null and validates before starting a runner", async () => {
    calls.run.mockResolvedValue({ out: "null\n" });
    const result = await fetchCcusageSession({ agent: "claude", sessionId: "missing" });
    expect(result.reason).toBe("not_found");
    await fetchCcusageSession({ agent: "codex", sessionId: "--help" });
    expect(calls.run).toHaveBeenCalledTimes(1);
  });
  it("recognizes Codex's missing-session error without assigning another session's usage", async () => {
    calls.run.mockRejectedValue(new Error(`No Codex session found with ID: ${id}`));
    const result = await fetchCcusageSession({ agent: "codex", sessionId: id, speed: "standard", force: true });
    expect(result.reason).toBe("not_found");
    expect(result).not.toHaveProperty("detail");
    expect(sessionFailure(result)).toContain("No usage found");
  });
  it("allows only four outstanding reads, serialized together with daily history", async () => {
    let active = 0, peak = 0;
    calls.run.mockImplementation(async (args: string[]) => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 15));
      --active;
      return { out: JSON.stringify(args[0] === "daily" ? { daily: [], session: [], totals: {} }
        : { sessionId: args[3], totalCost: 0, totalTokens: 0, entries: [] }) };
    });
    const reads = [fetchCcusageDaily({ since: "20261001", force: true }), ...[1, 2, 3, 4].map(n =>
      fetchCcusageSession({ agent: "claude", sessionId: `queue-${n}`, force: true }))];
    const results = await Promise.all(reads);
    expect(results[4].reason).toBe("busy");
    expect(results.slice(0, 4).every(row => row.ok)).toBe(true);
    expect(calls.run).toHaveBeenCalledTimes(4);
    expect(peak).toBe(1);
  });
});
