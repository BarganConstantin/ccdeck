// Reported (#992): a Codex session id the deck cannot resolve made it walk every
// rollout directory it has, every 2.5 seconds, for as long as that id kept
// arriving. findCodexRolloutPath cached a hit and did not cache a miss, and the
// walk that answers a miss is the whole tree — one readdir per year, per month
// and per day under $CODEX_HOME/sessions — ended early only by a hit. The id
// arrives on `/api/event`, which takes no credential and throttles per id, so
// any local process could also hand the deck a few hundred fresh ids at once and
// have every one of them walk the whole history concurrently.
//
// What is pinned here is the cost, counted in the unit the report counts it in:
// readdir calls under a year of history no live session is in. And beside it,
// the two lookups a cheaper walk must not lose — a rollout written after its id
// first missed, and a session whose rollout sits at the far end of the history.
import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

// Every readdir the process makes under the rollout tree, and how many of the
// ones under the old year are in flight at once. `slowUnder` holds those back
// for `slowMs` each, which is what makes two walks that overlap observable as
// overlapping rather than a matter of luck.
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

// The home, the Claude config dir and the Codex home the server resolves at
// import time — all temporary, all set before the import. Nothing in this file
// can reach the developer's own ~/.claude or ~/.codex.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-992-home-"));
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

// A year of history no live session is in — twelve months, two day directories
// each, one unrelated rollout in every one — and two recent day directories
// above it. A walk of the whole tree reads 1 + 12 + 24 = 37 directories under
// the old year; a walk of the newest two day directories reads none of them.
const OLD = join(SESSIONS, "2024");
const OLD_DIRS = 1 + 12 + 24;
const NEWEST_DAY = join(SESSIONS, "2026", "09", "15");
const RESUMED = "0d1e2f3a-0000-4000-8000-000000000001";

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
// A session begun at the far end of that history and resumed today: Codex goes
// on appending to the file it started with, so its rollout is where it was.
put(join(OLD, "01", "01"), RESUMED, "2024-01-01T09-00-00");
put(join(SESSIONS, "2026", "09", "14"), "bbbbbbbb-0914-4000-8000-000000000000", "2026-09-14T10-00-00");
put(NEWEST_DAY, "bbbbbbbb-0915-4000-8000-000000000000", "2026-09-15T10-00-00");

// No rollout watcher: its listing reads the newest two day directories every
// tick, which is noise in the count and has nothing to do with what is measured.
// The hook route resolves a Codex session whether or not the watcher runs.
const server: Server = await startServer({ port: 0, persist: null, workspace: "", codex: false });
const PORT = (server.address() as AddressInfo).port;

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmTempDir(FAKE_HOME);
  for (const [key, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));
// The throttle maybeResolveCodex keeps per session id, plus a margin.
const THROTTLE_MS = 2500 + 150;

const underOld = () => fsCtl.calls.filter(p => p === OLD || p.startsWith(OLD + sep)).length;
const lookups = () => fsCtl.calls.filter(p => p === SESSIONS).length;

/** A Codex hook event for `sid`, from a caller holding no credential. */
async function post(sid: string) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hook_event_name: "PreToolUse", session_id: sid, provider: "codex", tool_name: "shell", tool_use_id: `call-${sid}` }),
  });
  expect(res.status).toBe(200);
  await res.text();
}

/** Until no readdir under the tree has happened for `quietMs`. A lookup that
 *  misses emits nothing, so going quiet is the only sign it has finished. */
async function settle(quietMs = 300, maxMs = 20000) {
  const deadline = Date.now() + maxMs;
  let seen = fsCtl.calls.length;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await tick(25);
    if (fsCtl.calls.length !== seen) { seen = fsCtl.calls.length; quietSince = Date.now(); }
    else if (Date.now() - quietSince >= quietMs) return;
  }
}

const usageFor = (sid: string) => eventsSince(0).some((e: { payload: Record<string, unknown> }) =>
  e.payload?.hook_event_name === "UsageObserved" && e.payload?.session_id === sid);

async function waitFor(cond: () => boolean, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await tick(25);
  return cond();
}

describe("a Codex session id no rollout under this tree carries", () => {
  it("walks the whole tree once, not once per throttle window", async () => {
    const sid = "ffffffff-0000-4000-8000-00000000dead";
    const startedAt = Date.now();
    let before = underOld();
    await post(sid);
    await settle();
    // The first lookup is owed the whole history, and gets it: this is what
    // makes the next number mean something rather than pass on an empty tree.
    expect(underOld() - before).toBe(OLD_DIRS);

    await tick(Math.max(0, startedAt + THROTTLE_MS - Date.now()));
    const looked = lookups();
    before = underOld();
    await post(sid);
    await settle();
    // It did look again — a rollout may have appeared since — and it looked
    // where a new one can be, not through a year it has already read.
    expect(lookups()).toBeGreaterThan(looked);
    expect(underOld() - before).toBe(0);
  }, 30000);

  it("still finds a rollout that is written after the id first missed", async () => {
    // Keeping the miss must not mean keeping it forever: a hook can fire a
    // moment before its rollout is on disk, and a lookup that never looks again
    // would leave that session without usage for the rest of its life.
    const sid = "eeeeeeee-0000-4000-8000-00000000late";
    const startedAt = Date.now();
    await post(sid);
    await settle();
    expect(usageFor(sid)).toBe(false);

    put(NEWEST_DAY, sid, "2026-09-15T11-00-00");
    await tick(Math.max(0, startedAt + THROTTLE_MS - Date.now()));
    const before = underOld();
    await post(sid);
    expect(await waitFor(() => usageFor(sid))).toBe(true);
    await settle();
    expect(underOld() - before).toBe(0);
  }, 30000);

  it("still finds, on its first lookup, a session whose rollout is at the far end of history", async () => {
    // The other thing a cheaper walk must not lose. Bounding every lookup to the
    // newest two day directories — the watcher's bound — would answer this one
    // with nothing, and a resumed session would never show its usage.
    await post(RESUMED);
    expect(await waitFor(() => usageFor(RESUMED))).toBe(true);
    await settle();
  }, 30000);
});

describe("many Codex session ids nobody can resolve, at once", () => {
  it("never has more than one walk of the whole tree in flight", async () => {
    // The shape a caller with loopback and no credential can send: fresh ids
    // every time, so no cache of what already missed ever gets to answer.
    // Every read under the old year is held for a moment, so two walks of it
    // that overlap at all are seen overlapping.
    fsCtl.slowUnder = OLD;
    fsCtl.slowMs = 15;
    fsCtl.maxInFlight = 0;
    try {
      const ids = Array.from({ length: 6 }, (_, i) => `cccccccc-0000-4000-8000-00000000000${i}`);
      await Promise.all(ids.map(post));
      await settle(400);
      expect(fsCtl.maxInFlight).toBe(1);
    } finally {
      fsCtl.slowUnder = "";
      fsCtl.slowMs = 0;
    }
  }, 30000);
});
