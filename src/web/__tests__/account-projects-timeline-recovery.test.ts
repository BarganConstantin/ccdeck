import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain server ES module
import { createProjectRollup } from "../../server/account-projects.mjs";
// @ts-expect-error — plain server ES module
import { readSwapLog, recordSwap, seedActive } from "../../server/swap-log.mjs";

const START = Date.parse("2026-11-09T10:00:00Z");
const KEY = "reader@example.test@@synthetic-org";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const line = (tokens: number, offset = 0) => JSON.stringify({ type: "assistant", timestamp: new Date(START + offset).toISOString(),
  cwd: "/synthetic/project", message: { model: "synthetic-model", usage: { input_tokens: tokens, output_tokens: 1 } } }) + "\n";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "ccdeck-project-timeline-"));
  dirs.push(dir);
  const projects = join(dir, "projects");
  await mkdir(join(projects, "-synthetic-project"), { recursive: true });
  const root = await realpath(projects);
  const first = join(root, "-synthetic-project", "first.jsonl");
  const next = join(root, "-synthetic-project", "next.jsonl");
  await writeFile(first, line(100));
  const timelineDir = join(dir, "timeline");
  const swapLog = join(timelineDir, "swaps.jsonl");
  await mkdir(timelineDir);
  await writeFile(swapLog, JSON.stringify({ at: START - 1000, slot: 1, email: "reader@example.test", orgUuid: "synthetic-org",
    source: "manual", projectsRoot: root }) + "\n");
  const options = { roots: [root], state: join(dir, "state.json"), swapLog, storeRoot: join(dir, "missing-store"), now: () => START + 60000 };
  return { dir, root, first, next, timelineDir, swapLog, options, rollup: createProjectRollup(options) };
}

async function blockTimeline(f: Awaited<ReturnType<typeof fixture>>) {
  const parked = join(f.dir, "parked-timeline");
  await rename(f.timelineDir, parked);
  await writeFile(f.timelineDir, "temporarily unavailable");
  await expect(readFile(f.swapLog, "utf8")).rejects.toMatchObject({ code: "ENOTDIR" });
  return async () => { await rm(f.timelineDir); await rename(parked, f.timelineDir); };
}

describe("project rollup after its account timeline recovers", () => {
  it("defers new transcript bytes until the existing timeline is readable", async () => {
    const f = await fixture();
    await f.rollup.tick();
    expect((await f.rollup.report(KEY, 0)).projects[0].models["synthetic-model"].i).toBe(100);
    const before = structuredClone(f.rollup._state());
    await writeFile(f.next, line(25, 1000));
    expect(await readFile(f.next, "utf8")).toBe(line(25, 1000));

    // A real, portable read error, isolated to the log path; transcript
    // enumeration and transcript file reads still work throughout the fault.
    const restore = await blockTimeline(f);
    await expect(f.rollup.tick()).resolves.toBeUndefined();
    await expect(f.rollup.tick()).resolves.toBeUndefined();
    expect(f.rollup._state()).toEqual(before);
    expect(f.rollup._state().cursors[f.next]).toBeUndefined();
    expect(JSON.parse(await readFile(f.options.state, "utf8"))).toEqual(before);
    // Reporting remains best-effort for the route and never folds new bytes.
    const duringFault = await f.rollup.report(KEY, 0);
    expect(duringFault.projects[0].models["synthetic-model"].i).toBe(100);
    expect(duringFault.unattributed).toBeNull();
    const restarted = createProjectRollup(f.options);
    await expect(restarted.tick()).resolves.toBeUndefined();
    expect(restarted._state()).toEqual(before);
    await restore();

    await restarted.tick();
    await restarted.tick();
    const report = await restarted.report(KEY, 0);
    expect(report.projects[0].models["synthetic-model"].i, "recovery must attribute all 125 tokens, including the deferred 25").toBe(125);
    expect(report.unattributed).toBeNull();
    const persisted = JSON.parse(await readFile(f.options.state, "utf8"));
    expect(persisted.tally).toEqual(restarted._state().tally);
    expect(persisted.cursors[f.next]).toBe(Buffer.byteLength(line(25, 1000)));
    const again = createProjectRollup(f.options);
    await again.tick();
    expect(await again.report(KEY, 0)).toEqual(report);
  });

  it.each(["missing", "empty"])("still consumes usage as unattributed with a genuinely %s timeline", async kind => {
    const f = await fixture();
    if (kind === "missing") await rm(f.swapLog);
    else await writeFile(f.swapLog, "");
    expect(await readSwapLog(f.swapLog, { strict: true })).toEqual([]);
    await f.rollup.tick();
    await f.rollup.tick();
    const report = await f.rollup.report(KEY, 0);
    expect(report.projects).toEqual([]);
    expect(report.unattributed["synthetic-model"].i).toBe(100);
    expect(f.rollup._state().cursors[f.first]).toBe(Buffer.byteLength(line(100)));
    const restarted = createProjectRollup(f.options);
    await restarted.tick();
    expect(await restarted.report(KEY, 0)).toEqual(report);
  });

  it("retains honest attribution gaps and work before tracking began", async () => {
    const f = await fixture();
    const identity = { slot: 1, email: "reader@example.test", orgUuid: "synthetic-org", projectsRoot: f.root };
    await appendFile(f.swapLog, [
      { at: START + 500, slot: 0, email: "", orgUuid: "", source: "stop", projectsRoot: f.root },
      { at: START + 1500, ...identity, source: "start" },
    ].map(row => JSON.stringify(row) + "\n").join(""));
    await writeFile(f.next, line(7, -2000) + line(25, 1000) + line(40, 2000));
    await f.rollup.tick();
    await f.rollup.tick();
    const report = await f.rollup.report(KEY, 0);
    expect(report.projects[0].models["synthetic-model"].i).toBe(140);
    expect(report.unattributed["synthetic-model"].i).toBe(32);
  });

  it("keeps a long read outage from becoming a false downtime gap after restart", async () => {
    const f = await fixture();
    let clock = START + 60000;
    const options = { ...f.options, now: () => clock };
    const rollup = createProjectRollup(options);
    await rollup.tick();
    // This usage was written during the outage, AFTER the last good heartbeat.
    // A line dated before that heartbeat cannot expose a fabricated stop fence.
    await writeFile(f.next, line(25, 5 * 60000));
    const restore = await blockTimeline(f);
    // The process is still ticking well inside GAP_MS; a read failure should
    // not stop its persisted heartbeat and turn the whole outage into downtime.
    for (const minutes of [7, 13, 19]) {
      clock = START + minutes * 60000;
      await rollup.tick();
    }
    const restarted = createProjectRollup(options);
    await restarted.tick();
    await restore();
    await restarted.tick();
    const report = await restarted.report(KEY, 0);
    expect(report.projects[0].models["synthetic-model"].i).toBe(125);
    expect(report.unattributed).toBeNull();
    expect((await readSwapLog(f.swapLog)).filter((entry: { source: string }) => entry.source === "stop")).toEqual([]);
    const again = createProjectRollup(options);
    await again.tick();
    expect(await again.report(KEY, 0)).toEqual(report);
  });

  it("preserves a real restart gap when its first passes cannot read the timeline", async () => {
    const f = await fixture();
    let clock = START + 60000;
    const options = { ...f.options, now: () => clock };
    const beforeShutdown = createProjectRollup(options);
    await beforeShutdown.tick();
    await writeFile(f.next, line(25, 5 * 60000)); // written while the deck is down
    const restore = await blockTimeline(f);
    clock = START + 20 * 60000;
    const restarted = createProjectRollup(options);
    await restarted.tick();
    clock += 6 * 60000;
    await restarted.tick();
    await restore();
    // Neither the unreadable boot nor another process restart may erase the
    // last pre-shutdown heartbeat before its stop fence reaches the timeline.
    const recovered = createProjectRollup(options);
    await recovered.tick();
    await recovered.tick();
    const report = await recovered.report(KEY, 0);
    expect(report.projects[0].models["synthetic-model"].i).toBe(100);
    expect(report.unattributed["synthetic-model"].i).toBe(25);
    const stops = (await readSwapLog(f.swapLog)).filter((entry: { source: string }) => entry.source === "stop");
    expect(stops).toHaveLength(1);
    expect(stops[0].at).toBe(START + 60000 + 1);
    const again = createProjectRollup(options);
    await again.tick();
    expect(await again.report(KEY, 0)).toEqual(report);
  });

  it("keeps seed and account-switch logging best-effort when the timeline cannot be read", async () => {
    const f = await fixture();
    const store = join(f.dir, "store");
    await mkdir(store);
    await writeFile(join(store, "sequence.json"), JSON.stringify({ activeAccountNumber: 1,
      accounts: { "1": { email: "reader@example.test", organizationUuid: "synthetic-org" } } }));
    const original = await readFile(f.swapLog, "utf8");
    const restore = await blockTimeline(f);
    await expect(readSwapLog(f.swapLog, { strict: true })).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(await readSwapLog(f.swapLog)).toEqual([]);
    expect(await seedActive({ root: store, path: f.swapLog, projectsRoot: f.root })).toBeNull();
    expect(await recordSwap(1, "manual", { root: store, path: f.swapLog, projectsRoot: f.root })).toBeNull();
    await restore();
    expect(await readFile(f.swapLog, "utf8")).toBe(original);
    expect(await seedActive({ root: store, path: f.swapLog, projectsRoot: f.root })).toBeNull();
  });

  it("starts and retries a scheduled pass without rejecting on a temporary read failure", async () => {
    const f = await fixture();
    await f.rollup.tick();
    await writeFile(f.next, line(25, 1000));
    const restore = await blockTimeline(f);
    let scheduled: (() => void) | undefined;
    const rollup = createProjectRollup({ ...f.options,
      setInterval: (cb: () => void) => { scheduled = cb; return { unref() {} }; }, clearInterval() {},
    });
    try {
      await expect(rollup.start()).resolves.toBe(rollup);
      scheduled!();
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(rollup._state().cursors[f.next]).toBeUndefined();
      await restore();
      await rollup.tick();
      expect((await rollup.report(KEY, 0)).projects[0].models["synthetic-model"].i).toBe(125);
    } finally { rollup.stop(); }
  });
});
