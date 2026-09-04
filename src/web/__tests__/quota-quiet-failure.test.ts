// A CLI that is not installed is said once, not three times a minute (#742).
//
// The report was a screenshot from a Windows machine with no Claude Code on it.
// The banner had already said so — "Claude hooks skipped — no Claude Code
// found" — and then the terminal filled with
//
//   ●  listening — Ctrl+C to stop        ccdeck quota: claude CLI failed: claude exited ENOENT
//   ●  listening — Ctrl+C to stop        ccdeck quota: claude CLI failed: claude exited ENOENT
//   ●  listening — Ctrl+C to stop        ccdeck quota: claude CLI failed: claude exited ENOENT
//
// Two separate faults, and this file covers the quota half. Every poll ran the
// CLI three times — a retry written for a Claude Code that RAN and left the
// quota lines out of a cold invocation — and every attempt printed. A binary
// that is absent will not be there 1.2 seconds later, so the retries bought
// nothing and cost two spawns, 2.4 seconds of the caller's wait, and two more
// copies of one sentence.
//
// (The other half is the collision with the pulse line, which bin/deck.js now
// prevents at the stream. See pulse-at-rest.test.ts.)
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

const world = vi.hoisted(() => ({
  /** Every `run(cmd, args)` the module made. */
  calls: [] as string[][],
  /** What `run` answers next. */
  reply: { ok: false, code: "ENOENT", stdout: "", stderr: "" } as Record<string, unknown>,
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    run: async (cmd: string, args: string[] = []) => {
      world.calls.push([cmd, ...args]);
      return { killed: false, timedOut: false, ...world.reply };
    },
  };
});

// The three things ahead of the CLI, all made to answer nothing — which is what
// sends _doFetch down to source 3, the only path this file is about.
//
// claude-swap's store is source 1.
vi.mock("../../server/claude-accounts.mjs", () => ({
  activeAccountUsage: async () => null,
  requestCollection: async () => false,
}));

// The OAuth usage API is source 2, and it reads a credential out of the config
// directory. Pointed at an empty temp directory so this test does not depend on
// whether the machine running it happens to be signed in — and so it never
// reaches the network.
const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-quota-quiet-"));
vi.mock("../../server/claude-dir.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, claudeConfigDir: () => SANDBOX, claudeCliCandidates: () => ["claude"] };
});

// @ts-expect-error — a plain .mjs module, no types
const quota = await import("../../server/quota.mjs");
const { fetchClaudeQuota, invalidateQuotaCache, forgetQuotaFailureNotice, resetQuotaPollFloor } = quota;

// Nothing here talks to a network, and a test that quietly did would be a test
// whose result depends on the machine it ran on.
const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("no network in this test"); }) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; rmTempDir(SANDBOX); });

let said: string[] = [];
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  world.calls.length = 0;
  world.reply = { ok: false, code: "ENOENT", stdout: "", stderr: "" };
  said = [];
  forgetQuotaFailureNotice();
  resetQuotaPollFloor();
  invalidateQuotaCache();
  spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    said.push(a.map(String).join(" "));
  });
});
afterEach(() => { spy.mockRestore(); });

const claudeRuns = () => world.calls.filter(c => c.includes("/usage"));

describe("a machine with no Claude Code", () => {
  it("runs the CLI once, not three times", async () => {
    // The retry is for a CLI that answered without the quota lines. ENOENT is
    // not that, and `run` normalises a missing binary to exactly that code on
    // every platform — see exec.mjs, where it is the value every panel keys
    // its "not installed" message off.
    await fetchClaudeQuota({ force: true });
    expect(claudeRuns()).toHaveLength(1);
  }, 30_000);

  it("says so once, however many times it is asked", async () => {
    await fetchClaudeQuota({ force: true });
    invalidateQuotaCache();
    resetQuotaPollFloor();
    await fetchClaudeQuota({ force: true });
    invalidateQuotaCache();
    resetQuotaPollFloor();
    await fetchClaudeQuota({ force: true });

    // Three polls, three spawns — the deck still checks, because Claude Code
    // can be installed while it runs. One line.
    expect(claudeRuns().length).toBeGreaterThanOrEqual(3);
    expect(said.filter(l => l.includes("claude CLI failed"))).toHaveLength(1);
  }, 30_000);

  it("still names the failure the first time, rather than swallowing it", async () => {
    await fetchClaudeQuota({ force: true });
    expect(said.some(l => l.includes("claude CLI failed") && l.includes("ENOENT"))).toBe(true);
  }, 30_000);
});

describe("a Claude Code that is there and answering badly", () => {
  it("still retries, because a cold invocation really does omit the lines", async () => {
    // The case the retry was written for: the CLI ran, said something, and
    // simply had no quota lines yet. Nothing here is missing, so all three
    // attempts happen.
    world.reply = { ok: true, code: 0, stdout: "Claude Code usage\nsubscription: max\n", stderr: "" };
    await fetchClaudeQuota({ force: true });
    expect(claudeRuns()).toHaveLength(3);
  }, 30_000);

  it("speaks again when the failure changes", async () => {
    // Said-once is per message, not per process. A machine whose CLI starts
    // failing for a NEW reason has something the user has not been told.
    world.reply = { ok: false, code: 1, stdout: "", stderr: "not logged in" };
    await fetchClaudeQuota({ force: true });
    invalidateQuotaCache();
    resetQuotaPollFloor();
    world.reply = { ok: false, code: 1, stdout: "", stderr: "rate limited" };
    await fetchClaudeQuota({ force: true });

    const failures = said.filter(l => l.includes("claude CLI failed"));
    expect(failures.some(l => l.includes("not logged in"))).toBe(true);
    expect(failures.some(l => l.includes("rate limited"))).toBe(true);
  }, 30_000);

  it("forgets a failure once the CLI works, so the next one is heard", async () => {
    world.reply = { ok: false, code: 1, stdout: "", stderr: "not logged in" };
    await fetchClaudeQuota({ force: true });
    invalidateQuotaCache();
    resetQuotaPollFloor();

    world.reply = { ok: true, code: 0, stdout: "Claude Code usage\nsubscription: max\n", stderr: "" };
    await fetchClaudeQuota({ force: true });
    invalidateQuotaCache();
    resetQuotaPollFloor();

    world.reply = { ok: false, code: 1, stdout: "", stderr: "not logged in" };
    await fetchClaudeQuota({ force: true });

    expect(said.filter(l => l.includes("not logged in"))).toHaveLength(2);
  }, 30_000);
});
