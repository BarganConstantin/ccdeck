// What the boot set up and how long a new install's first session took — the
// activation half of the usage reports (activation.mjs, reports.mjs).
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

/** A fresh copy of the module: its setup is module state, set once per boot. */
async function fresh() {
  vi.resetModules();
  // @ts-expect-error — plain JS module, no types
  return import("../../server/activation.mjs");
}

describe("what the boot set up", () => {
  beforeEach(() => vi.useRealTimers());

  it("is nothing until the boot says", async () => {
    const a = await fresh();
    expect(a.setupFacts()).toEqual({});
  });

  it("reads the hook install job as ok, failed or off, and the Codex watcher as on or off", async () => {
    // Each job made only when its case runs: a rejected one made up front would
    // sit unhandled until its turn.
    const cases: [() => unknown, boolean, Record<string, string>][] = [
      [() => Promise.resolve({ ok: true }), false, { claudeHooks: "ok", codexWatch: "off" }],
      [() => Promise.resolve({ ok: false }), true, { claudeHooks: "failed", codexWatch: "on" }],
      [() => Promise.resolve(null), true, { claudeHooks: "off", codexWatch: "on" }],   // tried nothing: no Claude Code
      [() => null, false, { claudeHooks: "off", codexWatch: "off" }],                  // --no-claude
      [() => Promise.reject(new Error("settings.json")), false, { claudeHooks: "failed", codexWatch: "off" }],
      // A respawn that installed nothing: the first boot's token, handed down…
      [() => Promise.resolve("failed"), true, { claudeHooks: "failed", codexWatch: "on" }],
      // …or nothing handed down, which is said as nothing rather than guessed.
      [() => Promise.resolve(""), true, { codexWatch: "on" }],
      [() => Promise.resolve("maybe"), false, { codexWatch: "off" }],
    ];
    for (const [claude, codex, want] of cases) {
      const a = await fresh();
      a.noteSetup({ claude: claude(), codex });
      await a.whenSetupKnown(1000);
      expect(a.setupFacts()).toEqual(want);
    }
  });

  it("is waited for, but never for long", async () => {
    const a = await fresh();
    const started = Date.now();
    await a.whenSetupKnown(50);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(a.setupFacts()).toEqual({});
  });

  it("is said by the boot on both paths, the first boot and a respawn", () => {
    const src = readFileSync(new URL("../../../bin/deck.js", import.meta.url), "utf8");
    expect(src).toContain("noteSetup({ claude: jobs.hooks, codex: wantCodex })");
    expect(src).toContain("claude: respawnHooksJob({ wantClaude, reinstall, carried: process.env.AGENTS_DECK_BOOT_HOOKS })");
    // Never the "ok" a respawn used to assume before it had done anything.
    expect(src).not.toMatch(/noteSetup\(\{ claude: wantClaude \? \{ ok: true \}/);
  });

  it("is, on a respawn, its own re-install's answer, else the one handed down, else nothing", async () => {
    const a = await fresh();
    const job = (reinstall: unknown, carried?: string, wantClaude = true) =>
      Promise.resolve(a.respawnHooksJob({ wantClaude, reinstall: Promise.resolve(reinstall), carried }));
    expect(await job({ ok: false }, "ok")).toEqual({ ok: false });   // it re-installed, and that failed
    expect(await job({ ok: true }, "failed")).toEqual({ ok: true });
    expect(await job(null, "failed")).toBe("failed");                 // installed nothing: the first boot's
    expect(await job(null, undefined)).toBe("");                      // nothing handed down
    expect(await job(null, "ok", false)).toBeNull();                  // --no-claude
  });
});

describe("how long the first session took", () => {
  it("is a bucket, never a time", async () => {
    const a = await fresh();
    const at = "2026-09-30T10:00:00.000Z";
    const after = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
    const MIN = 60_000;
    expect(a.sinceInstallBucket(at, after(-5 * MIN))).toBe("5m");   // a clock that went back
    expect(a.sinceInstallBucket(at, after(4 * MIN))).toBe("5m");
    expect(a.sinceInstallBucket(at, after(30 * MIN))).toBe("1h");
    expect(a.sinceInstallBucket(at, after(5 * 60 * MIN))).toBe("1d");
    expect(a.sinceInstallBucket(at, after(3 * 24 * 60 * MIN))).toBe("7d");
    expect(a.sinceInstallBucket(at, after(30 * 24 * 60 * MIN))).toBe("later");
    expect(a.sinceInstallBucket("", at)).toBeUndefined();
  });
});
