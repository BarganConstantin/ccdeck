// The child half of codex-rollout-local-time.test.ts.
//
// A separate process because the thing under test is the machine's TIME ZONE,
// and a zone is a property of a process rather than of a call. `process.env.TZ`
// assigned to a process that is already running is not honoured reliably —
// usage-range.test.ts says so at the top of its own `ZonedNow`, and works around
// it by faking the Date. That trick fakes READING local parts; the fix here has
// to construct an instant FROM local parts, which no subclass can stand in for.
// So the zone is set the one way that is reliable everywhere: in the environment
// of a process before it starts.
//
// It also means this half writes the rollout files, not the parent. A filename
// is Codex's local-time rendering of the session start, and only a process
// actually running in the target zone can render one — the parent sits in
// whatever zone the runner happens to be in, which is exactly the assumption
// this test exists to remove.
//
// Reads one argument: a directory holding `config.json`. Everything it touches
// lives under that directory. Writes one line of JSON to stdout.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));

// Frozen before the module is imported, and before anything below asks the
// time. The module reads `Date.now()` inside its functions, so this reaches the
// window arithmetic, the 60s cache and the forced-read floor alike.
const NOW = cfg.nowMs;
Date.now = () => NOW;

const pad = n => String(n).padStart(2, "0");

/** Codex's own name for a session that started at `ms`, rendered the way Codex
 *  renders it: the LOCAL wall clock, with dashes where a colon would be
 *  illegal on Windows. */
function rolloutName(ms, id) {
  const d = new Date(ms);
  return `rollout-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
       + `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${id}.jsonl`;
}

/** sessions/YYYY/MM/DD, also local — Codex files the day by the local date. */
function dayDir(ms) {
  const d = new Date(ms);
  return join(process.env.CODEX_HOME, "sessions", String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
}

/** One cumulative token_count event, timestamped as a real instant in UTC —
 *  which is what Codex writes inside the file, and what makes the arithmetic
 *  downstream of the filename filter honest whatever the zone. */
function tokenCount(atMs, total) {
  return JSON.stringify({
    timestamp: new Date(atMs).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: total,
          output_tokens: 0,
          cached_input_tokens: 0,
          total_tokens: total,
        },
      },
    },
  }) + "\n";
}

const names = [];
for (const s of cfg.sessions) {
  const startMs = NOW - s.startAgeMs;
  const day = dayDir(startMs);
  mkdirSync(day, { recursive: true });
  const name = rolloutName(startMs, s.id);
  names.push(name);
  writeFileSync(join(day, name), s.events.map(e => tokenCount(NOW - e.ageMs, e.total)).join(""), "utf8");
}

// Imported only now, so the frozen clock and CODEX_HOME are both already in
// place when the module body resolves its sessions directory.
const { fetchCodexUsage } = await import("../../server/codex-usage.mjs");
const res = await fetchCodexUsage({ force: true });

/** The two numbers these cases are about, so the parent can assert an exact
 *  object rather than a subset. The per-bucket split is somebody else's test. */
const counted = w => (w ? { totalTokens: w.totalTokens, sessionCount: w.sessionCount } : null);

process.stdout.write(JSON.stringify({
  // What this process believes its zone to be, at each instant the parent asked
  // about. The parent asserts these: a platform that ignored TZ would otherwise
  // let every case pass for the wrong reason, in the runner's own zone.
  offsets: (cfg.offsetProbeMs ?? []).map(ms => new Date(ms).getTimezoneOffset()),
  names,
  ok: res.ok === true,
  window5h: counted(res.window5h),
  window7d: counted(res.window7d),
}));
