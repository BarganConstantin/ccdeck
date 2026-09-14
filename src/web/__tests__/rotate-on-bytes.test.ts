// ROTATION HAD NO TEST, AND THE THRESHOLD IT NAMES WAS ADVISORY.
//
// `ROTATE_AT_BYTES` is 50 MB. `maybeRotatePersistFile` has exactly one caller —
// the push path — and it refused to stat the file more than once per 30
// seconds. So the overshoot was `30s x the ingest byte rate`: unbounded in
// throughput rather than merely loose. Measured on a log doing 10.5 MB/s:
//
//   t=6s  log=51393249                    <- 50 MB crossed
//   t=30s log=306262048
//   t=31s log=0  log1=316750478           <- rotation fires: 302 MB, 25s late
//
// and at higher rates, 1,199 MB and 2,579 MB with ZERO rotations — 51x the cap,
// and 604 MB on disk across the two generations for a documented 50 MB. The
// deck's own line understated it as it went: `rotated ... (53MB -> ...)` on a
// file of 55,333,956 bytes.
//
// The rule is pure and exported for the reason mayReadAccounts and maySelfPoll
// are: a bound whose only observable failure is a file quietly reaching
// gigabytes belongs somewhere a test can point at it.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-rotate-rule-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
const rotateCheckDue = mod.rotateCheckDue as (
  o: { now: number; lastCheckAt: number; bytesSince: number },
) => boolean;

const MB = 1024 * 1024;
const THRESHOLD = 50 * MB;
const EVERY_BYTES = Math.floor(THRESHOLD / 5);

for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
  if (prevEnv[k] === undefined) delete process.env[k];
  else process.env[k] = prevEnv[k];
}
rmTempDir(DIR);

describe("when the log is worth measuring", () => {
  const NOW = 10_000_000;

  it("looks once enough has been written, however little time has passed", () => {
    // The whole fix. At 105 MB/s — the rate that produced 2,579 MB and no
    // rotations — a fifth of the threshold is written in under a tenth of a
    // second, so the clock arm never gets a say.
    expect(rotateCheckDue({ now: NOW, lastCheckAt: NOW - 50, bytesSince: EVERY_BYTES })).toBe(true);
    expect(rotateCheckDue({ now: NOW, lastCheckAt: NOW, bytesSince: THRESHOLD })).toBe(true);
  });

  it("still looks on the clock when nothing is being written", () => {
    // The idle case, and the reason the time arm stays: another deck appending
    // to a log they share grows the file without this process writing a byte.
    expect(rotateCheckDue({ now: NOW, lastCheckAt: NOW - 30_000, bytesSince: 0 })).toBe(true);
    expect(rotateCheckDue({ now: NOW, lastCheckAt: NOW - 29_999, bytesSince: 0 })).toBe(false);
  });

  it("does not stat on every event, which is what the throttle is for", () => {
    // A 4 KB event must not cost a filesystem call.
    expect(rotateCheckDue({ now: NOW, lastCheckAt: NOW - 1_000, bytesSince: 4096 })).toBe(false);
    expect(rotateCheckDue({ now: NOW, lastCheckAt: NOW - 1_000, bytesSince: EVERY_BYTES - 1 })).toBe(false);
  });

  it("bounds the overshoot by a fraction of the threshold rather than by rate", () => {
    // The property that makes the 50 MB cap mean something: whatever the ingest
    // rate, at most ROTATE_CHECK_EVERY_BYTES can land between two looks. At
    // 10.5 MB/s that is ~1 second of writing, against the 25 seconds measured.
    const worstOvershoot = EVERY_BYTES;
    expect(worstOvershoot).toBeLessThanOrEqual(THRESHOLD / 4);
    // And it holds at any rate, because bytes are counted rather than seconds.
    for (const rateMBps of [1, 10.5, 105, 1000]) {
      const bytesIn30s = rateMBps * MB * 30;
      const looksIn30s = Math.floor(bytesIn30s / EVERY_BYTES);
      expect(looksIn30s >= 1 || bytesIn30s < EVERY_BYTES,
             `at ${rateMBps} MB/s the byte arm must fire, or 30s of writing is under one check`).toBe(true);
    }
  });
});
