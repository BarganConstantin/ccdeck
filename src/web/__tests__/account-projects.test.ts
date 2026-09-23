// The account-projects rollup: who was active when, per-message attribution,
// the incremental transcript scan, and the per-window report.
//
// The engine is plain server .mjs (no build step), so the tests import it with
// an @ts-expect-error the way the other server-module tests here do. Everything
// touches a temp directory of its own — a fake claude-swap store, a swap log, a
// projects tree — so nothing reads or writes the real machine.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs server module, no types
import { appendSwap, readSwapLog, recordSwap, seedActive, accountAtTime, trackedSince, identityForSlot } from "../../server/swap-log.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { foldLine, reportFrom, countersFrom, localDay, windowCutoff, createProjectRollup, transcriptRoots, projectPath, UNATTRIBUTED } from "../../server/account-projects.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey } from "../../server/lan-sync.mjs";

const tmps: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "ap-proj-"));
  tmps.push(d);
  return d;
}
afterEach(async () => { for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true }); });

const ISO = (s: string) => Date.parse(s);
const line = (ts: string, model: string, cwd: string, i: number, o: number) =>
  JSON.stringify({ type: "assistant", timestamp: ts, cwd, message: { model, usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });

const TIMELINE = [
  { at: ISO("2026-09-22T09:00:00Z"), slot: 1, email: "a@x.com", orgUuid: "O1", source: "start" },
  { at: ISO("2026-09-22T11:00:00Z"), slot: 2, email: "b@x.com", orgUuid: "O2", source: "manual" },
];
const KEY_A = accountKey("a@x.com", "O1");
const KEY_B = accountKey("b@x.com", "O2");

describe("who was active when", () => {
  it("finds the account active at a moment, and none before tracking began", () => {
    expect(accountAtTime(TIMELINE, ISO("2026-09-22T08:59:59Z"))).toBeNull();       // before the first line
    expect(accountAtTime(TIMELINE, ISO("2026-09-22T09:00:00Z"))?.email).toBe("a@x.com"); // exactly on it
    expect(accountAtTime(TIMELINE, ISO("2026-09-22T10:59:59Z"))?.email).toBe("a@x.com");
    expect(accountAtTime(TIMELINE, ISO("2026-09-22T11:00:00Z"))?.email).toBe("b@x.com"); // the swap instant is the new one
    expect(accountAtTime(TIMELINE, ISO("2026-09-25T00:00:00Z"))?.email).toBe("b@x.com");
    expect(accountAtTime([], 1)).toBeNull();
    expect(trackedSince(TIMELINE)).toBe(TIMELINE[0].at);
    expect(trackedSince([])).toBeNull();
  });

  it("treats a stop marker as a gap: work inside it belongs to no account", () => {
    const withGap = [
      { at: ISO("2026-09-22T09:00:00Z"), slot: 1, email: "a@x.com", orgUuid: "O1", source: "start" },
      { at: ISO("2026-09-22T10:00:00Z"), slot: 0, email: "", orgUuid: "", source: "stop" },   // deck went down
      { at: ISO("2026-09-22T14:00:00Z"), slot: 1, email: "a@x.com", orgUuid: "O1", source: "start" }, // and came back
    ];
    expect(accountAtTime(withGap, ISO("2026-09-22T09:30:00Z"))?.email).toBe("a@x.com"); // before the gap
    expect(accountAtTime(withGap, ISO("2026-09-22T12:00:00Z"))).toBeNull();             // inside the gap
    expect(accountAtTime(withGap, ISO("2026-09-22T15:00:00Z"))?.email).toBe("a@x.com"); // after it resumed
  });

  it("round-trips the log and skips a torn last line", async () => {
    const path = join(await tmp(), "log.jsonl");
    await appendSwap(TIMELINE[0], path);
    await appendSwap(TIMELINE[1], path);
    await appendFile(path, '{"at":123,"slot":9,"email":"c@x', "utf8");   // a crash mid-append
    const got = await readSwapLog(path);
    expect(got.map((e: { email: string }) => e.email)).toEqual(["a@x.com", "b@x.com"]);
  });
});

describe("recording a swap from the store", () => {
  async function fakeStore(active: number): Promise<string> {
    const root = await tmp();
    await writeFile(join(root, "sequence.json"), JSON.stringify({
      activeAccountNumber: active,
      accounts: { "1": { email: "a@x.com", organizationUuid: "O1" }, "2": { email: "b@x.com", organizationUuid: "O2" } },
    }), "utf8");
    return root;
  }

  it("resolves a slot's identity and appends it", async () => {
    const root = await fakeStore(2);
    const path = join(await tmp(), "log.jsonl");
    const e = await recordSwap(2, "manual", { now: () => 1000, root, path });
    expect(e).toMatchObject({ at: 1000, slot: 2, email: "b@x.com", orgUuid: "O2", source: "manual" });
    expect((await readSwapLog(path)).length).toBe(1);
    expect(await identityForSlot(1, root)).toEqual({ email: "a@x.com", orgUuid: "O1" });
  });

  it("falls back to the active slot when given none, so the auto tick need not thread it", async () => {
    const root = await fakeStore(1);
    const path = join(await tmp(), "log.jsonl");
    const e = await recordSwap(undefined, "auto", { now: () => 1, root, path });
    expect(e).toMatchObject({ slot: 1, email: "a@x.com", source: "auto" });
  });

  it("seeds the active account once, then dedups a restart on the same account", async () => {
    const root = await fakeStore(2);
    const path = join(await tmp(), "log.jsonl");
    expect(await seedActive({ now: () => 10, root, path })).toMatchObject({ email: "b@x.com", source: "start" });
    expect(await seedActive({ now: () => 20, root, path })).toBeNull();   // same account, no new line
    expect((await readSwapLog(path)).length).toBe(1);
  });
});

describe("per-message attribution", () => {
  it("charges each message to whoever was active at its timestamp", () => {
    const tally: Record<string, unknown> = {};
    foldLine(tally, line("2026-09-22T10:30:00Z", "claude-opus-5", "/Users/c/agents-deck", 100, 50), TIMELINE);
    foldLine(tally, line("2026-09-22T11:30:00Z", "claude-opus-5", "/Users/c/agents-deck", 10, 5), TIMELINE);   // after the swap → B
    foldLine(tally, line("2026-09-22T08:30:00Z", "claude-opus-5", "/Users/c/other", 7, 7), TIMELINE);          // before tracking → unattributed
    foldLine(tally, "not json", TIMELINE);
    foldLine(tally, JSON.stringify({ timestamp: "2026-09-22T10:00:00Z", message: {} }), TIMELINE);              // no usage → ignored

    const a = reportFrom(tally, TIMELINE, KEY_A, 0, ISO("2026-09-22T12:00:00Z"));
    expect(a.projects).toEqual([
      { path: "/Users/c/agents-deck", name: "agents-deck", models: { "claude-opus-5": { i: 100, o: 50, cr: 0, cc: 0, c1h: 0, c5m: 0 } } },
    ]);
    // B's message is not in A's report.
    const b = reportFrom(tally, TIMELINE, KEY_B, 0, ISO("2026-09-22T12:00:00Z"));
    expect(b.projects[0].models["claude-opus-5"].i).toBe(10);
    // The pre-tracking message is the accountless bucket, on every report.
    expect(a.unattributed["claude-opus-5"]).toEqual({ i: 7, o: 7, cr: 0, cc: 0, c1h: 0, c5m: 0 });
  });

  it("slices the window by day for the chart, projects and unattributed apart", () => {
    const early = [{ at: ISO("2026-09-01T00:00:00Z"), slot: 1, email: "a@x.com", orgUuid: "O1", source: "start" }];
    const tally: Record<string, unknown> = {};
    foldLine(tally, line("2026-09-20T10:00:00Z", "claude-opus-5", "/p", 5, 0), early);
    foldLine(tally, line("2026-09-21T10:00:00Z", "claude-opus-5", "/p", 8, 0), early);
    foldLine(tally, line("2026-09-15T10:00:00Z", "claude-opus-5", "/q", 3, 0), early);   // before 7d
    const rep = reportFrom(tally, early, KEY_A, 7, ISO("2026-09-22T12:00:00Z"));
    const chartDays = rep.daily.map((d: { day: string }) => d.day);
    expect(chartDays).not.toContain("2026-09-15");   // outside the window
    const d20 = rep.daily.find((d: { day: string }) => d.day === "2026-09-20");
    expect(d20.projects[0].models["claude-opus-5"].i).toBe(5);
    expect(rep.daily.map((d: { day: string }) => d.day)).toEqual([...chartDays].sort());  // chronological
  });

  it("reads the cache-creation TTL split and skips a zero-billed block", () => {
    expect(countersFrom({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, cache_creation: { ephemeral_1h_input_tokens: 1, ephemeral_5m_input_tokens: 3 } }))
      .toEqual({ i: 1, o: 2, cr: 3, cc: 4, c1h: 1, c5m: 3 });
    const tally: Record<string, unknown> = {};
    foldLine(tally, JSON.stringify({ timestamp: "2026-09-22T10:00:00Z", cwd: "/p", message: { model: "claude-opus-5", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }), TIMELINE);
    expect(Object.keys(tally).length).toBe(0);
  });

  it("counts one usage record per API request, not every content block", () => {
    const tally: Record<string, unknown> = {};
    const first = JSON.stringify({
      type: "assistant", requestId: "req-1", apiBlockIndex: 0, timestamp: "2026-09-22T10:00:00Z",
      cwd: "/p", message: { model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
    });
    const repeated = first.replace('"apiBlockIndex":0', '"apiBlockIndex":1');
    foldLine(tally, first, TIMELINE);
    foldLine(tally, repeated, TIMELINE);
    const report = reportFrom(tally, TIMELINE, KEY_A, 0, ISO("2026-09-22T12:00:00Z"));
    expect(report.projects[0].models["claude-opus-5"]).toEqual({ i: 10, o: 5, cr: 100, cc: 0, c1h: 0, c5m: 0 });
  });

  it("windows by day and collapses the unattributed bucket across projects", () => {
    // A timeline that starts before both messages, so both attribute to A and
    // the only thing separating them is the day window.
    const early = [{ at: ISO("2026-09-01T00:00:00Z"), slot: 1, email: "a@x.com", orgUuid: "O1", source: "start" }];
    const tally: Record<string, unknown> = {};
    foldLine(tally, line("2026-09-10T10:00:00Z", "claude-opus-5", "/p", 5, 5), early);   // old, outside 7d
    foldLine(tally, line("2026-09-22T10:00:00Z", "claude-opus-5", "/p", 9, 9), early);   // recent, inside 7d
    const now = ISO("2026-09-22T12:00:00Z");
    expect(reportFrom(tally, early, KEY_A, 7, now).projects[0].models["claude-opus-5"].i).toBe(9);   // last 7d only
    expect(reportFrom(tally, early, KEY_A, 0, now).projects[0].models["claude-opus-5"].i).toBe(14);  // all time
    expect(windowCutoff(7, now)).toBe("2026-09-16");
    expect(localDay(ISO("2026-09-22T00:00:00")).length).toBe(10);
  });
});

describe("the incremental scan", () => {
  it("folds only appended lines and never double-counts across passes", async () => {
    const root = await tmp();
    const projects = join(root, "projects");
    const slug = join(projects, "-Users-c-agents-deck");
    await mkdir(slug, { recursive: true });
    const file = join(slug, "s1.jsonl");
    const stateFile = join(await tmp(), "state.json");
    const swapLog = join(await tmp(), "swap.jsonl");
    const bogusStore = join(await tmp(), "no-store");   // seedActive reads this, finds nothing, noops

    await appendSwap(TIMELINE[0], swapLog);
    await appendSwap(TIMELINE[1], swapLog);
    await writeFile(file, line("2026-09-22T10:30:00Z", "claude-opus-5", "/Users/c/agents-deck", 100, 0) + "\n", "utf8");

    const rollup = createProjectRollup({
      now: () => ISO("2026-09-22T12:00:00Z"),
      roots: [projects], state: stateFile, swapLog, storeRoot: bogusStore,
    });
    await rollup.tick();
    let rep = await rollup.report(KEY_A, 0);
    expect(rep.projects[0].models["claude-opus-5"].i).toBe(100);

    // Append one more line; the second pass must add only it.
    await appendFile(file, line("2026-09-22T10:31:00Z", "claude-opus-5", "/Users/c/agents-deck", 5, 0) + "\n", "utf8");
    await rollup.tick();
    rep = await rollup.report(KEY_A, 0);
    expect(rep.projects[0].models["claude-opus-5"].i).toBe(105);   // 100 + 5, not 205

    // A third pass with nothing appended changes nothing.
    await rollup.tick();
    rep = await rollup.report(KEY_A, 0);
    expect(rep.projects[0].models["claude-opus-5"].i).toBe(105);

    // The tally persisted to disk.
    const disk = JSON.parse(await readFile(stateFile, "utf8"));
    expect(disk.version).toBe(2);
    expect(disk.tally[KEY_A]["/Users/c/agents-deck"]).toBeTruthy();
    expect(disk.cursors[file]).toBeGreaterThan(0);
  });

  it("falls back to the folder name when a line carries no cwd", async () => {
    const root = await tmp();
    const projects = join(root, "projects");
    const slug = join(projects, "-Users-c-widget");
    await mkdir(slug, { recursive: true });
    await writeFile(join(slug, "s.jsonl"),
      JSON.stringify({ type: "assistant", timestamp: "2026-09-22T10:30:00Z", message: { model: "claude-opus-5", usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + "\n", "utf8");
    const swapLog = join(await tmp(), "swap.jsonl");
    await appendSwap(TIMELINE[0], swapLog);
    const rollup = createProjectRollup({
      now: () => ISO("2026-09-22T12:00:00Z"),
      roots: [projects], state: join(await tmp(), "st.json"), swapLog, storeRoot: join(await tmp(), "none"),
    });
    await rollup.tick();
    const rep = await rollup.report(KEY_A, 0);
    expect(rep.projects[0].name).toBe("widget");
  });

  it("fences off the time the deck was down, so that work is unattributed not mis-charged", async () => {
    const root = await tmp();
    const projects = join(root, "projects");
    const slug = join(projects, "-Users-c-p");
    await mkdir(slug, { recursive: true });
    const file = join(slug, "s.jsonl");
    // One message before the deck went down, one during the downtime.
    await writeFile(file,
      line("2026-09-05T10:00:00Z", "claude-opus-5", "/Users/c/p", 10, 0) + "\n" +
      line("2026-09-20T10:00:00Z", "claude-opus-5", "/Users/c/p", 7, 0) + "\n", "utf8");
    const swapLog = join(await tmp(), "swap.jsonl");
    await appendSwap({ at: ISO("2026-09-01T00:00:00Z"), slot: 1, email: "a@x.com", orgUuid: "O1", source: "start" }, swapLog);
    // A state file whose last heartbeat is well before now: the deck was down.
    const stateFile = join(await tmp(), "st.json");
    await writeFile(stateFile, JSON.stringify({ version: 1, cursors: {}, tally: {}, lastAlive: ISO("2026-09-10T00:00:00Z") }), "utf8");

    const rollup = createProjectRollup({
      now: () => ISO("2026-09-22T00:00:00Z"),   // ~12 days after lastAlive → a gap
      roots: [projects], state: stateFile, swapLog, storeRoot: join(await tmp(), "none"),
    });
    await rollup.tick();

    const rep = await rollup.report(KEY_A, 0);
    // The pre-downtime message is the account's; the downtime one is nobody's.
    expect(rep.projects[0].models["claude-opus-5"].i).toBe(10);
    expect(rep.unattributed["claude-opus-5"].i).toBe(7);
    // A stop marker was written at the last heartbeat.
    expect((await readSwapLog(swapLog)).some((e: { source: string }) => e.source === "stop")).toBe(true);
  });
});

describe("a worktree counts under its repo", () => {
  it("maps a .claude/worktrees/<name> cwd back to the repo, either separator", () => {
    expect(projectPath("/Users/c/Desktop/agents-deck/.claude/worktrees/account-projects")).toBe("/Users/c/Desktop/agents-deck");
    expect(projectPath("/Users/c/Desktop/agents-deck/.claude/worktrees/x/src/web")).toBe("/Users/c/Desktop/agents-deck");
    expect(projectPath("/Users/c/Desktop/agents-deck/.claude/worktrees")).toBe("/Users/c/Desktop/agents-deck");  // the worktrees dir itself
    expect(projectPath("C:\\code\\repo\\.claude\\worktrees\\feat")).toBe("C:\\code\\repo");
    expect(projectPath("/Users/c/Desktop/agents-deck")).toBe("/Users/c/Desktop/agents-deck");  // not a worktree, unchanged
    expect(projectPath("")).toBe("");
  });

  it("folds worktree work into the one repo row, not a row per worktree", () => {
    const tally: Record<string, unknown> = {};
    foldLine(tally, line("2026-09-22T10:00:00Z", "claude-opus-5", "/Users/c/agents-deck", 10, 0), TIMELINE);
    foldLine(tally, line("2026-09-22T10:01:00Z", "claude-opus-5", "/Users/c/agents-deck/.claude/worktrees/feat-a", 5, 0), TIMELINE);
    foldLine(tally, line("2026-09-22T10:02:00Z", "claude-opus-5", "/Users/c/agents-deck/.claude/worktrees/feat-b", 3, 0), TIMELINE);
    const rep = reportFrom(tally, TIMELINE, KEY_A, 0, ISO("2026-09-22T12:00:00Z"));
    expect(rep.projects).toHaveLength(1);
    expect(rep.projects[0].name).toBe("agents-deck");
    expect(rep.projects[0].models["claude-opus-5"].i).toBe(18);   // 10 + 5 + 3, one row
  });
});

describe("Codex stays out of it", () => {
  it("scans only Claude's projects directory, never ~/.codex", () => {
    const roots: string[] = transcriptRoots("/home/me", {});
    expect(roots.length).toBeGreaterThan(0);
    for (const r of roots) {
      expect(r.endsWith("/projects") || r.endsWith("\\projects")).toBe(true);
      expect(r.includes(".codex")).toBe(false);
    }
  });
});
