// Reported (#1134, item 1): a Codex rollout written after its id first missed
// could stay lost for the rest of the process. #1111 kept the miss from a walk
// of the whole rollout tree, so that an id no rollout carries stopped walking
// the whole history on every throttled pass (#992), and every later lookup for
// that id read only the newest two day directories. That is where a rollout
// written after the walk lands — until two newer day directories appear. A
// session whose first hook fired before its rollout existed, and whose next
// hook came two days later (`codex resume`), was never read again: its rollout
// was in the third-newest directory, behind a miss nothing cleared but
// forgetSession or a restart.
//
// Measured on main at 1887d95, a rollout written into the newest day and two
// newer days added after it: main never found its usage, and the tree before
// #1111 (c9e54a6) did. A fresh id in the same directory was found on both.
//
// What is pinned here is the fix and both of the things #1111 bought that it
// must not give back. The miss expires, so the lost rollout is found. It
// expires once per bound and not before, counted in #992's own unit — readdir
// calls under a year of history no live session is in. And lookups whose
// misses expired together still share one walk of that history.
import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Every readdir the process makes under the rollout tree, and how many of the
// ones under the old year are in flight at once — the same instrument
// codex-unresolved-session-walk-992.test.ts reads #992 with.
const { fsCtl } = vi.hoisted(() => ({
  fsCtl: { root: "", calls: [] as string[], slowUnder: "", slowMs: 0, inFlight: 0, maxInFlight: 0 },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readdir = (async (p: unknown, ...rest: unknown[]) => {
    const path = String(p);
    if (fsCtl.root && path.startsWith(fsCtl.root)) fsCtl.calls.push(path);
    const slow = fsCtl.slowUnder !== "" && path.startsWith(fsCtl.slowUnder);
    if (slow) {
      fsCtl.inFlight++;
      fsCtl.maxInFlight = Math.max(fsCtl.maxInFlight, fsCtl.inFlight);
    }
    try {
      if (slow) await new Promise(r => setTimeout(r, fsCtl.slowMs));
      return await (actual.readdir as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    } finally {
      if (slow) fsCtl.inFlight--;
    }
  }) as typeof actual.readdir;
  return { ...actual, default: { ...actual, readdir }, readdir };
});

// The real clock, captured before anything can fake it. The clock is moved
// below rather than sat through — days, and a ten-minute bound — and a faked
// `Date` does not tick on its own, so every wait here reads this instead.
const realNow = Date.now.bind(Date);

// The home, the Claude config dir and the Codex home the server resolves at
// import time — all temporary, all set before the import. Nothing in this file
// can reach the developer's own ~/.claude or ~/.codex.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-1134-home-"));
const FAKE_CODEX = join(FAKE_HOME, "codex");
const prev = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, "claude");
process.env.CODEX_HOME = FAKE_CODEX;

// @ts-expect-error — .mjs server module, no types
const { startServer, eventsSince, CODEX_SESSIONS_DIR } = await import("../../server/index.mjs");

const SESSIONS: string = CODEX_SESSIONS_DIR;
if (!SESSIONS.startsWith(FAKE_HOME)) throw new Error(`refusing to run: resolved ${SESSIONS}, outside ${FAKE_HOME}`);
fsCtl.root = SESSIONS;

const INDEX_SRC = readFileSync(fileURLToPath(new URL("../../server/index.mjs", import.meta.url)), "utf8");
/** The bound under test, stated here and pinned against the source below. */
const MISS_TTL_MS = 10 * 60 * 1000;
// The throttle maybeResolveCodex keeps per session id, plus a margin.
const THROTTLE_MS = 2500 + 150;
const DAY_MS = 24 * 60 * 60 * 1000;

// A year of history no live session is in — twelve months, two day directories
// each, one unrelated rollout in every one — and two recent day directories
// above it. A walk of the whole tree reads 1 + 12 + 24 = 37 directories under
// the old year; a lookup of the newest two day directories reads none of them.
const OLD = join(SESSIONS, "2024");
const OLD_DIRS = 1 + 12 + 24;
const day = (d: string) => join(SESSIONS, "2026", "09", d);

const rollout = (sid: string) =>
  JSON.stringify({ type: "session_meta", payload: { id: sid, cwd: "/srv/proj" } }) + "\n" +
  JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: 12, cached_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0, total_tokens: 15 } } },
  }) + "\n";
const put = (dir: string, sid: string, stamp: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-${stamp}-${sid}.jsonl`), rollout(sid), "utf8");
};

for (let m = 1; m <= 12; m++) {
  for (const d of [1, 15]) {
    const mm = String(m).padStart(2, "0");
    const dd = String(d).padStart(2, "0");
    put(join(OLD, mm, dd), `aaaaaaaa-${mm}${dd}-4000-8000-000000000000`, `2024-${mm}-${dd}T10-00-00`);
  }
}
put(day("14"), "bbbbbbbb-0914-4000-8000-000000000000", "2026-09-14T10-00-00");
put(day("15"), "bbbbbbbb-0915-4000-8000-000000000000", "2026-09-15T10-00-00");

// No rollout watcher: its listing reads the newest two day directories every
// tick, which is noise in the count. The hook route resolves a Codex session
// whether or not the watcher runs. The port is from a band clear of 4317, the
// default a developer's own deck holds, and of startServer's fallback range.
const server: Server = await startServer({ port: 4630, portRange: [4631, 4639], persist: null, workspace: "", codex: false });
const PORT = (server.address() as AddressInfo).port;

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  // Before rmTempDir, which waits out a Windows delete on the wall clock.
  vi.useRealTimers();
  rmTempDir(FAKE_HOME);
  for (const [key, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

/** Move the wall clock forward by `ms`, and hold it there until the next move. */
let faking = false;
function jump(ms: number): void {
  if (!faking) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(realNow());
    faking = true;
  }
  vi.setSystemTime(Date.now() + ms);
}

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));
const underOld = () => fsCtl.calls.filter(p => p === OLD || p.startsWith(OLD + sep)).length;

/** A Codex hook event for `sid`, from a caller holding no credential. */
async function post(sid: string) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hook_event_name: "PreToolUse", session_id: sid, provider: "codex", tool_name: "shell", tool_use_id: `call-${sid}-${fsCtl.calls.length}` }),
  });
  expect(res.status).toBe(200);
  await res.text();
}

/** Until no readdir under the tree has happened for `quietMs`. A lookup that
 *  misses emits nothing, so going quiet is the only sign it has finished. */
async function settle(quietMs = 300, maxMs = 20000) {
  const deadline = realNow() + maxMs;
  let seen = fsCtl.calls.length;
  let quietSince = realNow();
  while (realNow() < deadline) {
    await tick(25);
    if (fsCtl.calls.length !== seen) { seen = fsCtl.calls.length; quietSince = realNow(); }
    else if (realNow() - quietSince >= quietMs) return;
  }
}

const usageFor = (sid: string) => eventsSince(0).some((e: { payload: Record<string, unknown> }) =>
  e.payload?.hook_event_name === "UsageObserved" && e.payload?.session_id === sid);

async function waitFor(cond: () => boolean, ms = 8000) {
  const deadline = realNow() + ms;
  while (!cond() && realNow() < deadline) await tick(25);
  return cond();
}

describe("a rollout written after its id first missed", () => {
  it("is found once two newer day directories have appeared", async () => {
    const sid = "eeeeeeee-1134-4000-8000-00000000late";
    // The session's first hook fires before its rollout is on disk: the whole
    // tree is walked, nothing is there, and the miss is kept.
    await post(sid);
    await settle();
    expect(usageFor(sid)).toBe(false);

    // Then the rollout is written, into what is the newest day at that moment,
    // and two more days of other sessions follow it.
    put(day("15"), sid, "2026-09-15T11-00-00");
    put(day("16"), "bbbbbbbb-0916-4000-8000-000000000000", "2026-09-16T10-00-00");
    put(day("17"), "bbbbbbbb-0917-4000-8000-000000000000", "2026-09-17T10-00-00");

    // `codex resume` two days later: the same id, appending to the same file,
    // which is now the third-newest directory's.
    jump(2 * DAY_MS);
    await post(sid);
    expect(await waitFor(() => usageFor(sid)), "the resumed session's usage is read").toBe(true);
    await settle();
  }, 30000);

  it("sits where a first lookup finds it — the control", async () => {
    // The same directory, an id never looked up before: the whole tree is
    // walked and the rollout is there. So the case above is about the kept
    // miss, not about a directory this harness cannot reach.
    const sid = "cccccccc-1134-4000-8000-00000000ctrl";
    put(day("15"), sid, "2026-09-15T12-00-00");
    await post(sid);
    expect(await waitFor(() => usageFor(sid))).toBe(true);
    await settle();
  }, 30000);
});

describe("an id no rollout carries", () => {
  it("walks the whole tree again once its miss is older than the bound, and only then", async () => {
    const sid = "ffffffff-1134-4000-8000-00000000dead";

    let before = underOld();
    await post(sid);
    await settle();
    // The first lookup is owed the whole history, and gets it.
    expect(underOld() - before).toBe(OLD_DIRS);

    // A minute short of the bound the miss still holds, which is #992 kept
    // fixed: the newest two directories, and nothing of the old year.
    jump(MISS_TTL_MS - 60_000);
    before = underOld();
    await post(sid);
    await settle();
    expect(underOld() - before, "inside the bound").toBe(0);

    // A minute past it, one more walk of the whole history...
    jump(2 * 60_000);
    before = underOld();
    await post(sid);
    await settle();
    expect(underOld() - before, "past the bound").toBe(OLD_DIRS);

    // ...whose miss is kept afresh, so the next pass is back to the newest two.
    jump(THROTTLE_MS);
    before = underOld();
    await post(sid);
    await settle();
    expect(underOld() - before, "the pass after that walk").toBe(0);
  }, 30000);

  it("is held to the ten minutes the case above moves the clock past", () => {
    // Pinned on its own, like codex-cursor-ttl-981.test.ts pins its TTL, so a
    // change to the bound is a change to this file too, and the case above
    // fails on what the server does rather than on how the source spells it.
    expect(INDEX_SRC).toMatch(/const CODEX_MISS_TTL_MS = 10 \* 60 \* 1000;/);
  });
});

describe("ids whose misses expired together", () => {
  it("still have one walk of the whole tree in flight between them, not one each", async () => {
    // #1111's other guarantee, asked of the new way in. Each id first walks the
    // whole tree alone and keeps its miss; then all of those misses expire at
    // once and every id comes back in the same moment. Every read under the old
    // year is held for a moment, so two walks of it that overlap at all are seen
    // overlapping.
    const ids = Array.from({ length: 6 }, (_, i) => `dddddddd-1134-4000-8000-00000000000${i}`);
    for (const id of ids) {
      await post(id);
      await settle();
    }
    jump(MISS_TTL_MS + 60_000);
    fsCtl.slowUnder = OLD;
    fsCtl.slowMs = 15;
    fsCtl.maxInFlight = 0;
    try {
      const before = underOld();
      await Promise.all(ids.map(post));
      await settle(400);
      expect(fsCtl.maxInFlight, "whole-tree walks in flight at once").toBe(1);
      // One walk of the history between the six; the other five read the
      // newest two directories and get theirs on a later pass.
      expect(underOld() - before).toBe(OLD_DIRS);
    } finally {
      fsCtl.slowUnder = "";
      fsCtl.slowMs = 0;
    }
  }, 30000);
});
