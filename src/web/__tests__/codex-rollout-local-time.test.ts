// #609. `parseRolloutTime` read the wall clock out of a Codex rollout filename,
// appended a "Z", and handed it to `Date.parse` — which declares it UTC. It is
// not UTC. Codex names the file from the machine's LOCAL clock, so every start
// time the walk in `listRolloutFiles` compared against the window was out by
// the machine's offset, and the seven-day membership test moved with it.
//
// The direction is what made it lie quietly. West of UTC the window SHRINKS by
// the offset: on US Pacific in summer, seven hours at the old end of the week
// are judged too old and those rollouts are never opened. `listRolloutFiles`
// (WINDOW_7D_MS) is the only gate in front of the reads, so a file it drops is
// not merely missing from `window7d` — a long session still running right now
// is missing from `window5h` too, because `windowDelta(series, start5h)` never
// gets a series to work on. East of UTC the window STRETCHES by the offset and
// sessions older than seven days are opened and counted. At UTC, and only at
// UTC, the two readings agree — which is why a suite that had never asked the
// question anywhere else came up green for as long as it did.
//
// ── the measurement the fix rests on ────────────────────────────────────────
//
// Ten rollouts under `$CODEX_HOME` on this machine (TZ=Europe/Chisinau, +3).
// Read as UTC, the filename sits 179.3, 173.4, 178.5, 179.6, 179.7, 180.0,
// 179.8, 180.0 and 179.9 minutes AHEAD of the first event inside its own file.
// Read as local it lands between 0.0 and 6.6 minutes BEHIND that event, which
// is the gap between creating a file and writing the first line into it. The
// sign settles it: a session cannot log an event before it starts.
//
// The tenth is the interesting one and it is why the fix keys off the name.
// `rollout-2026-08-18T08-00-24-01a0133d-…` carries 06:33:07.513Z on line 1 —
// 92 minutes AFTER its own name, because the session sat at an empty prompt
// before its first turn — while the `session_meta` payload nested in that same
// line reads 05:00:24.355Z, which is 08:00:24 local, the filename to the
// second. The outer timestamp is the first APPEND; the name is the START.
//
// ── how these cases control the zone ────────────────────────────────────────
//
// In a child process, with TZ set in its environment before it starts. That is
// the only way that works everywhere: `usage-range.test.ts` explains at its own
// `ZonedNow` that assigning `process.env.TZ` mid-process is not honoured
// reliably, notably on Windows, and its Date subclass fakes READING local parts
// — where the fix has to build an instant FROM local parts, which no subclass
// can stand in for.
//
// The child writes the rollout files as well as reading them, for the same
// reason: only a process running in the target zone can render the name Codex
// would have rendered there. `codex-rollout-zone-probe.mjs` is that child. Each
// case asserts the offset the child reported and the filename it produced
// before asserting the totals, so a platform that ignored TZ fails loudly here
// instead of passing six cases in the runner's own zone.
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { rmTempDir } from "./rm-temp-dir";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE = fileURLToPath(new URL("./codex-rollout-zone-probe.mjs", import.meta.url));

const H = 60 * 60 * 1000;
const D = 24 * H;

const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-609-"));
afterAll(() => rmTempDir(ROOT));

type Session = { id: string; startAgeMs: number; events: Array<{ ageMs: number; total: number }> };
type Probe = {
  offsets: number[];
  names: string[];
  ok: boolean;
  window5h: { totalTokens: number; sessionCount: number } | null;
  window7d: { totalTokens: number; sessionCount: number } | null;
};

let runs = 0;

/** Run the deck's usage scan in `zone`, over rollouts that zone wrote itself. */
function scanIn(zone: string, cfg: { nowMs: number; sessions: Session[]; offsetProbeMs: number[] }): Probe {
  // A directory of its own per run: the module caches its last reading for a
  // minute and holds a forced read behind another, both keyed on a clock the
  // child freezes — so every case gets a fresh process over a fresh tree rather
  // than inheriting the previous one's answer.
  const dir = join(ROOT, `run-${runs++}`);
  const codexHome = join(dir, "codex-home");
  mkdirSync(dir, { recursive: true });
  // The config goes in as a file and the child is handed the directory, so
  // nothing this test writes has to survive a command line — Windows quoting of
  // a JSON argument is a fight with no upside.
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg), "utf8");

  const r = spawnSync(process.execPath, [PROBE, dir], {
    // HOME and USERPROFILE are redirected as well as CODEX_HOME: no fallback in
    // any of the five resolutions of ~/.codex may reach the developer's real
    // one, on any platform.
    env: { ...process.env, TZ: zone, CODEX_HOME: codexHome, HOME: dir, USERPROFILE: dir },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.status !== 0 || !r.stdout) {
    throw new Error(`probe in ${zone} failed (status ${r.status}): ${r.stderr || "(no stderr)"}`);
  }
  return JSON.parse(r.stdout) as Probe;
}

// Two sessions, both still running — each has an event within the last two
// hours — and both straddling the seven-day edge from opposite sides.
//
//   alpha  started 6d20h ago: INSIDE the window. Its whole cumulative total is
//          the window's, since it has no snapshot older than the window start.
//   beta   started 7d04h ago: OUTSIDE it. `listRolloutFiles` gates on when a
//          session STARTED, so beta does not count however recently it spent.
//
// Neither is a boundary case by accident: four hours is more than every zone's
// DST step and less than every zone's offset, so the answer is the same in all
// of them the moment the filename is read in the zone that wrote it.
const SESSIONS: Session[] = [
  { id: "alpha", startAgeMs: 7 * D - 4 * H, events: [{ ageMs: 7 * D - 4 * H, total: 1000 }, { ageMs: 2 * H, total: 5000 }] },
  { id: "beta",  startAgeMs: 7 * D + 4 * H, events: [{ ageMs: 7 * D + 4 * H, total: 2000 }, { ageMs: 1 * H, total: 9000 }] },
];

const WINTER = Date.UTC(2026, 0, 20, 12, 0, 0);   // 2026-01-20T12:00:00Z
const SUMMER = Date.UTC(2026, 6, 20, 12, 0, 0);   // 2026-07-20T12:00:00Z

// alpha starts at 2026-01-13T16:00:00Z / 2026-07-13T16:00:00Z. The name each
// zone gives that instant is the zone's own wall clock, and pinning it is how
// each case proves the child really ran where it was told to.
const ZONES = [
  { zone: "America/Los_Angeles", label: "west of UTC", nowMs: WINTER, season: "January", offset:  480, alpha: "rollout-2026-01-13T08-00-00-alpha.jsonl" },
  { zone: "America/Los_Angeles", label: "west of UTC", nowMs: SUMMER, season: "July",    offset:  420, alpha: "rollout-2026-07-13T09-00-00-alpha.jsonl" },
  { zone: "UTC",                 label: "at UTC",      nowMs: WINTER, season: "January", offset:    0, alpha: "rollout-2026-01-13T16-00-00-alpha.jsonl" },
  { zone: "UTC",                 label: "at UTC",      nowMs: SUMMER, season: "July",    offset:    0, alpha: "rollout-2026-07-13T16-00-00-alpha.jsonl" },
  { zone: "Asia/Kolkata",        label: "east of UTC", nowMs: WINTER, season: "January", offset: -330, alpha: "rollout-2026-01-13T21-30-00-alpha.jsonl" },
  { zone: "Asia/Kolkata",        label: "east of UTC", nowMs: SUMMER, season: "July",    offset: -330, alpha: "rollout-2026-07-13T21-30-00-alpha.jsonl" },
];

describe("the 7-day gate on Codex rollouts lands in the same place in every time zone", () => {
  it.each(ZONES)("$label — $zone in $season", ({ zone, nowMs, offset, alpha }) => {
    const got = scanIn(zone, { nowMs, sessions: SESSIONS, offsetProbeMs: [nowMs] });

    // The premise, before the conclusion: the child really was in that zone,
    // and it really named alpha's rollout with that zone's wall clock.
    expect(got.offsets).toEqual([offset]);
    expect(got.names).toContain(alpha);

    expect(got.ok).toBe(true);
    // alpha and only alpha. West of UTC the old code lost alpha — 6d20h plus a
    // seven- or eight-hour offset is past seven days — and reported nothing at
    // all. East of UTC it kept beta as well, because 7d04h minus five and a
    // half hours is not yet seven days.
    expect(got.window7d).toEqual({ totalTokens: 5000, sessionCount: 1 });
    // And the half that made the old bug more than a rounding error: alpha is
    // still running, so its recent spend belongs to the five-hour window too.
    // There is no second gate to recover it — a file `listRolloutFiles` drops
    // is a file nothing ever reads — so west of UTC this was flatly zero while
    // a session was burning tokens in front of the user.
    expect(got.window5h).toEqual({ totalTokens: 4000, sessionCount: 1 });
  });
});

describe("an offset is not a constant", () => {
  // The reason the fix builds a Date from parts instead of subtracting an
  // offset from an instant. A single number — even today's correct one — is
  // wrong for the part of the window that sits the other side of a DST change.
  //
  // 2026-03-12T12:00:00Z is 05:00 PDT, offset -7. The session starts
  // 6d23h30m earlier, at 2026-03-05T12:30:00Z, which is 04:30 PST, offset -8:
  // the seven-day window straddles the spring-forward on 2026-03-08. Reading
  // `04-30-00` with today's -7 puts the session half an hour PAST the edge and
  // drops it; reading it with the rules in force on 5 March keeps it, which is
  // the truth — it started 30 minutes inside the week.
  const NOW = Date.UTC(2026, 2, 12, 12, 0, 0);
  const START = NOW - (7 * D - 30 * 60 * 1000);

  it("keeps a session that started before a spring-forward and is still running", () => {
    const got = scanIn("America/Los_Angeles", {
      nowMs: NOW,
      sessions: [{ id: "gamma", startAgeMs: NOW - START, events: [{ ageMs: NOW - START, total: 700 }, { ageMs: 90 * 60 * 1000, total: 2500 }] }],
      offsetProbeMs: [NOW, START],
    });

    // The premise again, and this one is the whole case: two different offsets
    // inside one seven-day window. If the tz database ever stops agreeing that
    // 5 March 2026 was PST and 12 March PDT, this is where it says so.
    expect(got.offsets).toEqual([420, 480]);
    expect(got.names).toEqual(["rollout-2026-03-05T04-30-00-gamma.jsonl"]);

    expect(got.ok).toBe(true);
    expect(got.window7d).toEqual({ totalTokens: 2500, sessionCount: 1 });
    expect(got.window5h).toEqual({ totalTokens: 1800, sessionCount: 1 });
  });
});
