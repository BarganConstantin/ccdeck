// #611. The transcript scan cursors are capped, and the cap used to count
// PATHS. A session does not occupy one path: it occupies its own JSONL plus one
// `subagents/agent-*.jsonl` for every subagent it ever ran, and that number is
// set by how heavily the session delegates rather than by anything the deck
// controls. Measured on the machine that reported it, two live sessions held
// 198 and 133 subagent files — 333 entries against a cap of 256 — so each
// session's throttled pass evicted the other's cursors and the next pass read
// both directories from byte 0. One of them is 130.8 MB and folds in 6456 ms
// cold against 18 ms warm, inside a 2500 ms throttle window: the O(n)-per-pass
// synchronous stall the cursor exists to remove, reintroduced through the unit
// the cap was counted in.
//
// So eviction now works in whole sessions. These pin the accounting: a session
// never evicts its own cursors however many files it has, several heavy
// sessions do not evict each other, and what the cap does take it takes whole
// and oldest-first.
import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Every path below lives inside this temp directory, and the server module
// resolves the Claude and Codex config directories from the home directory at
// import time — so all four point at the sandbox BEFORE any import of it, and
// no test here can reach the developer's real ~/.claude or ~/.codex on any
// platform.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-scan-session-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");

const SERVER = fileURLToPath(new URL("../../server/index.mjs", import.meta.url));

type Scanner = {
  readUsageFromTranscript(path: string): Promise<{ input_tokens: number } | null>;
  transcriptSessionKey(path: string): string;
};

/** A scan cache nothing else has touched. The cursors live in module state, so
 *  a shared import would make each case depend on how many sessions the cases
 *  before it left behind — and every number here is about how full the cache
 *  is. */
async function freshScanner(): Promise<Scanner> {
  vi.resetModules();
  // @ts-expect-error — .mjs server module, no types
  return await import(SERVER);
}

// Matches MAX_TRANSCRIPT_SCAN_SESSIONS in src/server/index.mjs, and the last
// case in this file fails if the two ever drift.
const SESSION_CAP = 256;

function assistant(inputTokens: number): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      model: "claude-opus-4-7",
      usage: {
        input_tokens: inputTokens, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      },
    },
  }) + "\n";
}

const FIRST = assistant(100);
// Same byte length as FIRST, so a cursor parked at its end cannot tell the
// prefix changed — the trick transcript-incremental.test.ts and
// transcript-scan-lru.test.ts both use to tell a tail read from a full re-read.
const REWRITTEN = FIRST.replace('"input_tokens":100', '"input_tokens":999');
const APPENDED = assistant(7);
const CURSOR_KEPT = 107;   // 100 folded on the first pass + the appended 7
const FULL_REREAD = 1006;  // the rewritten 999 + the appended 7

let nextSession = 0;

/** One session on disk in CC's current layout — `<slug>/<sessionId>.jsonl`
 *  beside `<slug>/<sessionId>/subagents/agent-<id>.jsonl` — and the paths the
 *  deck opens for it, main transcript first. That is exactly the set
 *  `readSubagentsFromDir` walks on every throttled pass. */
function session(subagents: number): string[] {
  const sid = `session-${nextSession++}`;
  const slugDir = join(DIR, "projects", "-Users-someone-Desktop-repo");
  const subDir = join(slugDir, sid, "subagents");
  if (!subDir.startsWith(DIR)) throw new Error("refusing to run: fixture path escaped the sandbox");
  mkdirSync(subDir, { recursive: true });
  const paths = [join(slugDir, `${sid}.jsonl`)];
  for (let i = 0; i < subagents; i++) {
    paths.push(join(subDir, `agent-${(i + 0x1000).toString(16)}.jsonl`));
  }
  for (const p of paths) writeFileSync(p, FIRST);
  return paths;
}

/** A throttled pass over one session: the deck reads the main transcript and
 *  every agent-*.jsonl beside it. */
async function pass(scan: Scanner, paths: string[]): Promise<void> {
  for (const p of paths) expect((await scan.readUsageFromTranscript(p))!.input_tokens).toBeGreaterThan(0);
}

/** Rewrite the bytes each cursor already folded, append one line, and scan
 *  again. A cursor that survived folds only the appended line; an evicted one
 *  starts at byte 0 and folds the rewritten prefix too. Returns how many of
 *  `paths` were read from byte 0.
 *
 *  Reading is itself a use, so this re-inserts every path it measures. That
 *  only matters for a case that expects eviction, and those measure the paths
 *  they expect to survive before the ones they expect to lose. */
async function rereadFromZero(scan: Scanner, paths: string[]): Promise<number> {
  let reread = 0;
  for (const p of paths) {
    writeFileSync(p, REWRITTEN + APPENDED);
    const total = (await scan.readUsageFromTranscript(p))!.input_tokens;
    if (total === FULL_REREAD) reread++;
    else expect(total, `${p} folded ${total}, which is neither a kept cursor nor a full re-read`).toBe(CURSOR_KEPT);
  }
  return reread;
}

describe("the transcript scan cache counted in sessions", () => {
  it("keeps every cursor of one session that has more subagent files than the cap has sessions", async () => {
    const scan = await freshScanner();
    // Deliberately past the cap: no fixed number of entries can be right when
    // the entry count is CC's to decide, and the reporter's heaviest session
    // already held 198 of these.
    const only = session(SESSION_CAP + 8);
    expect(only.length).toBeGreaterThan(SESSION_CAP);

    await pass(scan, only);
    expect(
      await rereadFromZero(scan, only),
      `all ${only.length} paths belong to one session, so none of them may evict another`,
    ).toBe(0);
  });

  it("does not let two heavy sessions evict each other's cursors", async () => {
    const scan = await freshScanner();
    // The two sessions measured on the machine that reported #611.
    const heavy = session(198);
    const other = session(133);
    expect(heavy.length + other.length).toBeGreaterThan(SESSION_CAP);

    // Two throttled passes each, interleaved the way two live sessions emit.
    await pass(scan, heavy);
    await pass(scan, other);
    await pass(scan, heavy);
    await pass(scan, other);

    expect(await rereadFromZero(scan, heavy), "the 198-subagent session lost cursors").toBe(0);
    expect(await rereadFromZero(scan, other), "the 133-subagent session lost cursors").toBe(0);
  });

  it("does not evict part of a session while it holds more paths than the cap counts sessions", async () => {
    const scan = await freshScanner();
    const held = session(3);
    await pass(scan, held);
    // One short of the cap in sessions, and over it in paths — the gap the old
    // accounting could not tell apart.
    const filler: string[][] = [];
    for (let i = 0; i < SESSION_CAP - 2; i++) filler.push(session(0));
    for (const f of filler) await pass(scan, f);

    const sessions = filler.length + 1;
    const paths = filler.length + held.length;
    expect(sessions).toBeLessThan(SESSION_CAP);
    expect(paths).toBeGreaterThan(SESSION_CAP);

    expect(
      await rereadFromZero(scan, held),
      `${sessions} sessions is under the cap, so none of the ${paths} cursors may be dropped`,
    ).toBe(0);
  });

  it("evicts the whole of the session that has gone longest without a scan", async () => {
    const scan = await freshScanner();
    const stale = session(3);
    await pass(scan, stale);
    const newer: string[][] = [];
    for (let i = 0; i < SESSION_CAP; i++) newer.push(session(0));
    for (const f of newer) await pass(scan, f);
    expect(newer.length + 1).toBeGreaterThan(SESSION_CAP);

    // The most recent session first: measuring is a use, and the stale one
    // comes back into the cache as soon as it is read.
    expect(await rereadFromZero(scan, newer[newer.length - 1]), "the newest session was evicted").toBe(0);
    expect(
      await rereadFromZero(scan, stale),
      "the oldest session must go whole — a partly evicted session still re-reads on the next pass",
    ).toBe(stale.length);
  });
});

describe("the session a transcript path belongs to", () => {
  it("puts a session's main transcript and its subagent transcripts under one key", async () => {
    const { transcriptSessionKey } = await freshScanner();
    const root = join(DIR, "projects", "-slug", "abc-123");
    const main = `${root}.jsonl`;
    const sub = join(root, "subagents", "agent-00ff.jsonl");
    expect(transcriptSessionKey(sub)).toBe(transcriptSessionKey(main));
  });

  it("keeps two sessions in the same project apart", async () => {
    const { transcriptSessionKey } = await freshScanner();
    const slug = join(DIR, "projects", "-slug");
    const a = transcriptSessionKey(join(slug, "abc-123", "subagents", "agent-1.jsonl"));
    const b = transcriptSessionKey(join(slug, "def-456", "subagents", "agent-1.jsonl"));
    expect(a).not.toBe(b);
  });

  it("gives a transcript in no recognised layout a session of its own", async () => {
    const { transcriptSessionKey } = await freshScanner();
    // A Codex rollout, which shares scanTranscript and has no subagents dir.
    const one = join(DIR, "codex", "sessions", "2026", "08", "24", "rollout-a.jsonl");
    const two = join(DIR, "codex", "sessions", "2026", "08", "24", "rollout-b.jsonl");
    expect(transcriptSessionKey(one)).not.toBe(transcriptSessionKey(two));
    expect(transcriptSessionKey(one)).toBe(resolve(one).replace(/\.jsonl$/i, ""));
  });

  it("normalises the path first, so the same file written two ways is one session", async () => {
    const { transcriptSessionKey } = await freshScanner();
    // The main transcript arrives from the hook payload as CC wrote it while
    // the subagent path is built with `join`, so the two spellings have to
    // agree before they are compared. The separator mismatch that produces
    // this is Windows-only — `C:/x/y.jsonl` from the payload against
    // `C:\x\y\subagents\agent-1.jsonl` from `join` — so the stand-in here is a
    // `..` segment, which every platform can spell and only normalisation can
    // reconcile. Built by concatenation on purpose: `join` would normalise it
    // before the function under test ever saw it, and the case would pass
    // whether or not the function normalises anything.
    const root = join(DIR, "projects", "-slug", "abc-123");
    const detour = `${DIR}/projects/-slug/zz/../abc-123.jsonl`;
    expect(transcriptSessionKey(detour)).toBe(transcriptSessionKey(`${root}.jsonl`));
  });
});

describe("the cap this file is written against", () => {
  it("is the one src/server/index.mjs actually uses", () => {
    const source = readFileSync(SERVER, "utf8");
    const sessions = /^const MAX_TRANSCRIPT_SCAN_SESSIONS = ([0-9_]+);/m.exec(source);
    expect(sessions, "MAX_TRANSCRIPT_SCAN_SESSIONS is no longer declared where this test can read it").not.toBeNull();
    expect(Number(sessions![1].replace(/_/g, "")), "SESSION_CAP in this file has drifted from the server's").toBe(SESSION_CAP);

    // The entry ceiling is the second half of the bound, and it has to stay
    // clear of the counts above or the cases here would be measuring it
    // instead of the session cap.
    const entries = /^const MAX_TRANSCRIPT_SCAN_ENTRIES = ([0-9_]+);/m.exec(source);
    expect(entries, "MAX_TRANSCRIPT_SCAN_ENTRIES is no longer declared where this test can read it").not.toBeNull();
    expect(Number(entries![1].replace(/_/g, ""))).toBeGreaterThan(SESSION_CAP + 198 + 133 + 8);
  });
});

// The sandbox outlives every case in this file and is the only thing written.
afterAll(() => {
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(DIR);
});
