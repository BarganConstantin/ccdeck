import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain server ES module
import { createProjectRollup } from "../../server/account-projects.mjs";

const STAMP = Date.parse("2026-11-09T10:00:00Z");
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function fixture(rootName = "projects") {
  const dir = await mkdtemp(join(tmpdir(), "ccdeck-project-scan-"));
  dirs.push(dir);
  const root = join(dir, rootName);
  await mkdir(join(root, "-synthetic-project"), { recursive: true });
  const canonical = await realpath(root);
  const file = join(canonical, "-synthetic-project", "session.jsonl");
  const text = JSON.stringify({ type: "assistant", timestamp: new Date(STAMP).toISOString(), cwd: "/synthetic/project",
    message: { id: "request-one", model: "synthetic-model", usage: { input_tokens: 100, output_tokens: 5 } } }) + "\n";
  await writeFile(file, text);
  const swapLog = join(dir, "swaps.jsonl");
  await writeFile(swapLog, JSON.stringify({ at: STAMP - 1000, slot: 1, email: "reader@example.test",
    orgUuid: "synthetic-org", source: "manual", projectsRoot: canonical }) + "\n");
  const state = join(dir, "state.json");
  const options = { roots: [canonical], state, swapLog, storeRoot: join(dir, "missing-store"), now: () => STAMP + 60000 };
  return { dir, root: canonical, file, text, state, options, rollup: createProjectRollup(options) };
}

const input = async (rollup: ReturnType<typeof createProjectRollup>) =>
  (await rollup.report("reader@example.test@@synthetic-org", 0)).projects[0].models["synthetic-model"].i;

async function blockRoot(root: string, parked: string) {
  await rename(root, parked);
  await writeFile(root, "temporarily unavailable");
  await expect(readdir(root, { recursive: true, withFileTypes: true })).rejects.toMatchObject({ code: "ENOTDIR" });
  return async () => { await rm(root); await rename(parked, root); };
}

function record(cwd: string, tokens: number, id: string, at = STAMP) {
  return { type: "assistant", apiBlockIndex: 0, requestId: id, timestamp: new Date(at).toISOString(), cwd,
    message: { id, stop_reason: "end_turn" as string | null, model: "synthetic-model", usage: { input_tokens: tokens, output_tokens: 5 } } };
}
const jsonLine = (obj: unknown) => JSON.stringify(obj) + "\n";

describe("project rollup after transcript enumeration recovers", () => {
  it("does not recount unchanged transcripts after a real filesystem scan error", async () => {
    const f = await fixture();
    await f.rollup.tick();
    expect(await input(f.rollup)).toBe(100);
    const offset = f.rollup._state().cursors[f.file];
    expect(offset).toBeGreaterThan(0);
    await f.rollup.tick();
    expect(await input(f.rollup)).toBe(100);

    // A temporary non-directory at the same path produces a real ENOTDIR on
    // every platform, without chmod/root-user gates or changing anyone's home.
    const restore = await blockRoot(f.root, join(f.dir, "parked-projects"));
    await f.rollup.tick();
    expect(f.rollup._state().cursors[f.file]).toBe(offset);
    await restore();
    expect(await readFile(f.file, "utf8")).toBe(f.text);

    await f.rollup.tick();
    expect(await input(f.rollup), "recovered scan must not bill the same 100 input tokens again").toBe(100);
    const disk = JSON.parse(await readFile(f.state, "utf8"));
    expect(disk.tally).toEqual(f.rollup._state().tally);
    expect(disk.cursors[f.file]).toBe(offset);
    const restarted = createProjectRollup(f.options);
    await restarted.tick();
    await restarted.tick();
    expect(await input(restarted)).toBe(100);
  });

  it("preserves failed-root ledgers and folders while a healthy sibling appends and prunes real deletions", async () => {
    const f = await fixture("projects-unavailable");
    const snapshot = record("/synthetic/project", 100, "streaming");
    snapshot.message.stop_reason = null;
    await writeFile(f.file, jsonLine(snapshot));
    // A shared path prefix is deliberate: scanning projects does not prove
    // anything about the unavailable projects-unavailable root next to it.
    const healthyPath = join(f.dir, "projects");
    await mkdir(join(healthyPath, "-synthetic-healthy"), { recursive: true });
    await mkdir(join(healthyPath, "-synthetic-obsolete"));
    const healthyRoot = await realpath(healthyPath);
    const healthy = join(healthyRoot, "-synthetic-healthy", "healthy.jsonl");
    const deleted = join(healthyRoot, "-synthetic-obsolete", "deleted.jsonl");
    await writeFile(healthy, jsonLine(record("/synthetic/healthy", 40, "healthy-one")));
    await writeFile(deleted, jsonLine(record("/synthetic/obsolete", 60, "deleted-one")));
    await appendFile(f.options.swapLog, jsonLine({ at: STAMP - 1000, slot: 1, email: "reader@example.test",
      orgUuid: "synthetic-org", source: "manual", projectsRoot: healthyRoot }));
    const options = { ...f.options, roots: [f.root, healthyRoot] };
    const rollup = createProjectRollup(options);
    await rollup.tick();
    const before = structuredClone(rollup._state());
    expect(before.requests[f.file].streaming.id).toBe("streaming");
    expect(before.folders[f.root]["-synthetic-project"]).toBe("/synthetic/project");
    expect(before.requests[deleted]).toBeDefined();

    const restore = await blockRoot(f.root, join(f.dir, "parked-projects"));
    await appendFile(healthy, jsonLine(record("/synthetic/healthy", 10, "healthy-two", STAMP + 1000)));
    await rm(join(healthyRoot, "-synthetic-obsolete"), { recursive: true });
    await rollup.tick();
    await rollup.tick();
    expect(rollup._state().cursors[f.file]).toBe(before.cursors[f.file]);
    expect(rollup._state().requests[f.file]).toEqual(before.requests[f.file]);
    expect(rollup._state().folders[f.root]).toEqual(before.folders[f.root]);
    expect(rollup._state().cursors[healthy]).toBeGreaterThan(before.cursors[healthy]);
    expect(rollup._state().cursors[deleted]).toBeUndefined();
    expect(rollup._state().requests[deleted]).toBeUndefined();
    expect(rollup._state().folders[healthyRoot]["-synthetic-obsolete"]).toBeUndefined();

    const disk = JSON.parse(await readFile(f.state, "utf8"));
    expect(disk.cursors[f.file]).toBe(before.cursors[f.file]);
    expect(disk.requests[f.file]).toEqual(before.requests[f.file]);
    expect(disk.folders[f.root]).toEqual(before.folders[f.root]);
    const restarted = createProjectRollup(options);
    await restarted.tick(); // still unavailable after restart
    await restore();
    const final = record("/synthetic/project", 120, "streaming");
    final.apiBlockIndex = 1;
    await appendFile(f.file, jsonLine(final) + jsonLine(record("/synthetic/project", 15, "new-request", STAMP + 1000)));
    await restarted.tick();
    await restarted.tick();
    const report = await restarted.report("reader@example.test@@synthetic-org", 0);
    const totals = Object.fromEntries(report.projects.map((p: any) => [p.path, p.models["synthetic-model"].i]));
    expect(totals).toEqual({ "/synthetic/project": 135, "/synthetic/healthy": 50, "/synthetic/obsolete": 60 });
    const persisted = JSON.parse(await readFile(f.state, "utf8"));
    expect(persisted.tally).toEqual(restarted._state().tally);
    expect(persisted.cursors).toEqual(restarted._state().cursors);
    expect(persisted.requests).toEqual(restarted._state().requests);
    const again = createProjectRollup(options);
    await again.tick();
    expect(await again.report("reader@example.test@@synthetic-org", 0)).toEqual(report);
  });

  it("prunes progress and folder maps when a successful scan proves the root is empty", async () => {
    const f = await fixture();
    await writeFile(f.file, jsonLine(record("/synthetic/project", 100, "finished")));
    await f.rollup.tick();
    expect(f.rollup._state().requests[f.file]).toBeDefined();
    await rm(join(f.root, "-synthetic-project"), { recursive: true });
    await f.rollup.tick();
    const disk = JSON.parse(await readFile(f.state, "utf8"));
    expect(disk.cursors).toEqual({});
    expect(disk.requests).toEqual({});
    expect(disk.folders).toEqual({});
    // Historical usage stays in the tally even though its transcript is gone.
    expect(await input(f.rollup)).toBe(100);
  });
});
