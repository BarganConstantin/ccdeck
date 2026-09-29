// #1731. `codex resume` writes a resumed session into its ORIGINAL rollout —
// the file named for the moment the session first started, in the day folder
// of that day. listRolloutFiles chose which rollouts to read from that name
// alone, so a session started more than seven days ago and resumed today was
// never opened: every token spent in it since was left out of both the 5-hour
// and the 7-day Codex totals, and when it was the only Codex session of the
// week `window7d.sessionCount` was 0 and the panel hid the Codex token line as
// though Codex had not run at all.
//
// windowDelta already splits a file whose events straddle the window edge; the
// file simply never reached it. So these stage exactly that file — named twenty
// days ago, written to an hour ago — and one beside it that has not been
// touched since it was named, which must still count for nothing.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// Every rollout the scan opens, by file name. Hoisted because vi.mock factories
// run before the module body.
const opened = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      opened.push(String(args[0]).replace(/^.*[\\/]/, ""));
      return actual.open(...args);
    },
  };
});

// Everything lives under this temp directory. CODEX_HOME is resolved at import
// time, and HOME/USERPROFILE are redirected too, so the developer's own
// ~/.codex is never read.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-resumed-"));
const CODEX_HOME = join(DIR, "codex-home");
const SESSIONS = join(CODEX_HOME, "sessions");
const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CODEX_HOME = CODEX_HOME;

// @ts-expect-error — .mjs server module, no types
const { fetchCodexUsage } = await import("../../server/codex-usage.mjs");

// A forced read is rationed to one a minute (#600), and each case here is a
// forced read of a tree it has just written, so each is given a minute of its
// own by moving the clock rather than waiting on it — the way
// codex-usage-bounded-reads.test.ts does.
const FLOOR_MS = 60_000;
let skew = 0;
const FROZEN_AT = Date.now();
vi.spyOn(Date, "now").mockImplementation(() => FROZEN_AT + skew);
beforeEach(() => { skew += FLOOR_MS + 1_000; });

afterAll(() => {
  vi.restoreAllMocks();
  for (const [key, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[key]; else process.env[key] = was;
  }
  rmTempDir(DIR);
});

const H = 60 * 60 * 1000;
const D = 24 * H;
const pad = (n: number) => String(n).padStart(2, "0");

/** A rollout named, and filed, for a session that started at `startMs` — in
 *  LOCAL time, which is how Codex names them (#609). */
function rolloutPath(startMs: number, id: string): string {
  const t = new Date(startMs);
  const dir = join(SESSIONS, String(t.getFullYear()), pad(t.getMonth() + 1), pad(t.getDate()));
  mkdirSync(dir, { recursive: true });
  const stamp = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}-${pad(t.getMinutes())}-${pad(t.getSeconds())}`;
  return join(dir, `rollout-${stamp}-${id}.jsonl`);
}

/** One token_count event at `atMs`; `total` is the session's running total. */
function tokenCount(atMs: number, total: number): string {
  return JSON.stringify({
    timestamp: new Date(atMs).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: total, output_tokens: 0, cached_input_tokens: 0, total_tokens: total } },
    },
  }) + "\n";
}

/** Write a rollout and give it the mtime its last line would have left. */
function writeRollout(path: string, lines: string, lastWriteMs: number): void {
  writeFileSync(path, lines, "utf8");
  utimesSync(path, lastWriteMs / 1000, lastWriteMs / 1000);
}

describe("a Codex session resumed from a rollout more than seven days old", () => {
  it("counts the tokens spent in it inside the windows", async () => {
    rmTempDir(SESSIONS);
    const now = Date.now();
    const started = now - 20 * D;
    const resumed = now - 1 * H;
    writeRollout(
      rolloutPath(started, "0190aaaa-0000-7000-8000-000000000001"),
      tokenCount(started, 1_000) + tokenCount(resumed, 51_000),
      resumed,
    );

    const usage = await fetchCodexUsage({ force: true });
    expect(usage.ok).toBe(true);
    expect(usage.window5h.totalTokens).toBe(50_000);
    expect(usage.window7d.totalTokens).toBe(50_000);
    expect(usage.window7d.sessionCount).toBe(1);
  });

  it("counts nothing for an old rollout nobody has written to since", async () => {
    rmTempDir(SESSIONS);
    const now = Date.now();
    const started = now - 20 * D;
    const lastWrite = now - 19 * D;
    writeRollout(
      rolloutPath(started, "0190bbbb-0000-7000-8000-000000000002"),
      tokenCount(started, 1_000) + tokenCount(lastWrite, 51_000),
      lastWrite,
    );

    const usage = await fetchCodexUsage({ force: true });
    expect(usage.ok).toBe(true);
    expect(usage.window5h.totalTokens).toBe(0);
    expect(usage.window7d.totalTokens).toBe(0);
    expect(usage.window7d.sessionCount).toBe(0);
  });

  it("counts nothing for an old rollout touched without being written to", async () => {
    // An mtime inside the window is a reason to open the file, not a reason to
    // count it: a backup restore or a sync tool can move it without a single
    // token being spent, and windowDelta stays the judge of how much counts.
    rmTempDir(SESSIONS);
    const now = Date.now();
    const started = now - 20 * D;
    writeRollout(
      rolloutPath(started, "0190cccc-0000-7000-8000-000000000003"),
      tokenCount(started, 1_000) + tokenCount(now - 19 * D, 51_000),
      now - 1 * H,
    );

    const usage = await fetchCodexUsage({ force: true });
    expect(usage.window7d.totalTokens).toBe(0);
    expect(usage.window7d.sessionCount).toBe(0);
  });
});

describe("what finding them costs", () => {
  it("reads an old rollout once while it sits still, and again when it grows", async () => {
    // The mtime test means statting every rollout named before the window on
    // every scan. Reading them is the expensive half, and a file whose mtime and
    // size have not moved since the last scan has nothing new to say.
    rmTempDir(SESSIONS);
    const now = Date.now();
    const started = now - 20 * D;
    const path = rolloutPath(started, "0190dddd-0000-7000-8000-000000000004");
    writeRollout(path, tokenCount(started, 1_000) + tokenCount(now - 1 * H, 51_000), now - 1 * H);
    const name = basename(path);
    opened.length = 0;

    expect((await fetchCodexUsage({ force: true })).window7d.totalTokens).toBe(50_000);
    skew += FLOOR_MS + 1_000;
    expect((await fetchCodexUsage({ force: true })).window7d.totalTokens).toBe(50_000);
    expect(opened.filter(n => n === name)).toHaveLength(1);

    appendFileSync(path, tokenCount(Date.now() - 60_000, 61_000), "utf8");
    skew += FLOOR_MS + 1_000;
    expect((await fetchCodexUsage({ force: true })).window7d.totalTokens).toBe(60_000);
    expect(opened.filter(n => n === name)).toHaveLength(2);
  });
});
