// Swap lines written before a swap recorded its projects root carry no
// `projectsRoot`. The rebuild to scoped attribution (state version 8) must not
// hide history that was never ambiguous: with one transcript root, and no other
// root ever known, those lines can only have spoken for that root, so the work
// they cover stays with the account that did it, as it did before the upgrade.
// With two roots, or another root on record, they stay unattributed, as the
// scoped log intends (see usage-account-cost-audit.test.ts).
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs server module, no types
import { createProjectRollup, UNATTRIBUTED } from "../../server/account-projects.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey } from "../../server/lan-sync.mjs";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "ap-legacy-"));
  dirs.push(d);
  return d;
}

const ISO = (s: string) => Date.parse(s);
const MODEL = "claude-sonnet-5";
// Placeholder identities: the rollup keys on (email, organisation) and needs no real address.
const A = { email: "first-account", orgUuid: "org-1" };
const B = { email: "second-account", orgUuid: "org-2" };
const KEY_A = accountKey(A.email, A.orgUuid);
const KEY_B = accountKey(B.email, B.orgUuid);
const CWD = "/work/demo";
const line = (ts: string, i: number) =>
  JSON.stringify({ type: "assistant", timestamp: ts, cwd: CWD, message: { model: MODEL, usage: { input_tokens: i, output_tokens: 0 } } }) + "\n";
// The swap log as a deck wrote it before swaps were scoped: no projectsRoot.
// A starts, B takes over, the deck is down for a while (a stop fence), and B is
// active again when it comes back.
const LEGACY = [
  { at: ISO("2026-10-17T09:00:00Z"), slot: 1, ...A, source: "start" },
  { at: ISO("2026-10-17T12:00:00Z"), slot: 2, ...B, source: "manual" },
  { at: ISO("2026-10-17T14:00:00Z"), slot: 0, email: "", orgUuid: "", source: "stop" },
  { at: ISO("2026-10-17T16:00:00Z"), slot: 2, ...B, source: "start" },
];
const TRANSCRIPT =
  line("2026-10-17T08:00:00Z", 1) +       // before tracking began: nobody's
  line("2026-10-17T10:00:00Z", 10) +      // A was active
  line("2026-10-17T13:00:00Z", 100) +     // B was active
  line("2026-10-17T15:00:00Z", 1000) +    // the deck was down: nobody's
  line("2026-10-17T17:00:00Z", 10000);    // B again
const NOW = ISO("2026-10-18T11:00:00Z");

/** A projects root holding one session, a pre-upgrade swap log and a claude-swap
 *  store whose active account is B, the way the machine looked at upgrade time. */
async function machine(roots = 1) {
  const dir = await tmp();
  const projects: string[] = [];
  for (let r = 0; r < roots; r++) {
    const root = join(dir, `config-${r}`, "projects");
    await mkdir(join(root, "demo"), { recursive: true });
    await writeFile(join(root, "demo", "s.jsonl"), TRANSCRIPT, "utf8");
    projects.push(root);
  }
  const swapLog = join(dir, "swap.jsonl");
  await writeFile(swapLog, LEGACY.map(e => JSON.stringify(e)).join("\n") + "\n", "utf8");
  const store = join(dir, "store");
  await mkdir(store, { recursive: true });
  await writeFile(join(store, "sequence.json"), JSON.stringify({
    activeAccountNumber: 2,
    accounts: { "1": { email: A.email, organizationUuid: A.orgUuid }, "2": { email: B.email, organizationUuid: B.orgUuid } },
  }), "utf8");
  return { dir, projects, swapLog, store, state: join(dir, "account-projects.json") };
}

const tokens = (rep: { projects: { path: string; models: Record<string, { i: number }> }[] }) =>
  Object.fromEntries(rep.projects.map(p => [p.path, p.models[MODEL].i]));

async function expectAttributed(rollup: { report(key: string, days: number): Promise<any> }) {
  const a = await rollup.report(KEY_A, 0);
  expect(tokens(a)).toEqual({ [CWD]: 10 });
  expect(a.unattributed[MODEL].i).toBe(1 + 1000);
  expect(a.trackedSince).toBe(LEGACY[0].at);
  const b = await rollup.report(KEY_B, 0);
  expect(tokens(b)).toEqual({ [CWD]: 100 + 10000 });
  expect(b.unattributed[MODEL].i).toBe(1 + 1000);
}

describe("pre-upgrade swap history with a single projects root", () => {
  it("stays with the accounts that did the work after the rebuild from version 7", async () => {
    const m = await machine();
    const file = join(m.projects[0], "demo", "s.jsonl");
    // What version 7 had built from the same log, every line folded.
    const c = (i: number) => ({ [MODEL]: { i, o: 0, cr: 0, cc: 0, c1h: 0, c5m: 0 } });
    await writeFile(m.state, JSON.stringify({
      version: 7,
      cursors: { [file]: (await readFile(file)).length },
      tally: {
        [KEY_A]: { [CWD]: { "2026-10-17": c(10) } },
        [KEY_B]: { [CWD]: { "2026-10-17": c(10100) } },
        [UNATTRIBUTED]: { [CWD]: { "2026-10-17": c(1001) } },
      },
      folders: {}, requests: {}, lastAlive: NOW - 60_000,
    }), "utf8");
    const rollup = createProjectRollup({ roots: m.projects, state: m.state, swapLog: m.swapLog, storeRoot: m.store, now: () => NOW });
    await rollup.tick();
    await expectAttributed(rollup);
    // A restart reads the rebuilt state and keeps the attribution.
    const again = createProjectRollup({ roots: m.projects, state: m.state, swapLog: m.swapLog, storeRoot: m.store, now: () => NOW + 60_000 });
    await again.tick();
    await expectAttributed(again);
  });

  it("stays with the accounts that did the work on a first fold", async () => {
    const m = await machine();
    const rollup = createProjectRollup({ roots: m.projects, state: m.state, swapLog: m.swapLog, storeRoot: m.store, now: () => NOW });
    await rollup.tick();
    await expectAttributed(rollup);
  });
});

describe("pre-upgrade swap history stays unattributed when its root is ambiguous", () => {
  it("with two independent projects roots", async () => {
    const m = await machine(2);
    const rollup = createProjectRollup({ roots: m.projects, state: m.state, swapLog: m.swapLog, storeRoot: m.store, now: () => NOW });
    await rollup.tick();
    expect((await rollup.report(KEY_A, 0)).projects).toEqual([]);
    const b = await rollup.report(KEY_B, 0);
    expect(b.projects).toEqual([]);
    expect(b.unattributed[MODEL].i).toBe(2 * 11111);
  });

  it("with one projects root when the log names another root", async () => {
    const m = await machine();
    // A deck that ran with a second Claude directory scoped a later line to it:
    // which directory the unscoped lines controlled can no longer be told.
    const other = join(m.dir, "elsewhere", "projects");
    await mkdir(other, { recursive: true });
    await writeFile(m.swapLog, JSON.stringify({ at: ISO("2026-10-18T09:00:00Z"), slot: 1, ...A, source: "manual", projectsRoot: await realpath(other) }) + "\n", { flag: "a" });
    const rollup = createProjectRollup({ roots: m.projects, state: m.state, swapLog: m.swapLog, storeRoot: m.store, now: () => NOW });
    await rollup.tick();
    expect((await rollup.report(KEY_A, 0)).projects).toEqual([]);
    const b = await rollup.report(KEY_B, 0);
    expect(b.projects).toEqual([]);
    expect(b.unattributed[MODEL].i).toBe(11111);
  });
});
