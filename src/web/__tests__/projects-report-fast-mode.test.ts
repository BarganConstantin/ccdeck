// The Projects report and fast mode. Claude Code's `/fast` runs the same model
// id at `usage.speed: "fast"`, billed at a premium, and the board prices those
// tokens at the fast rate card (#754). The report's own pass over the
// transcripts kept its counters by model alone and never read the speed, so a
// fast turn was priced at the standard rate: half the board's figure for an
// Opus 5.5 turn where ccusage did not calibrate the day, and on a day it did,
// the day's one drift spread the premium over every project alike — a
// fast-heavy project undercharged and a standard-only one overcharged.
//
// Pinned here end to end, from a transcript line through foldLine, reportFrom
// and reconcile to the dollars, against the board's own pricing of the same
// tokens.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectRollup, foldLine, reportFrom } from "../../server/account-projects.mjs";
import { ccCellsFrom, reconcile, type Counters, type DayInput } from "../account-projects-reconcile";
import { costForUsage, STANDARD_SPEED } from "../pricing";
import type { TokenUsage } from "../types";

const NOW = Date.parse("2026-10-03T18:00:00Z");
const MODEL = "claude-opus-5-5";
const TIMELINE = [{ at: Date.parse("2026-10-01T00:00:00Z"), slot: 1, email: "a@x.com", orgUuid: "O1", source: "start" }];

/** One assistant line as Claude Code writes it, at `speed`. */
function line(cwd: string, id: string, speed: string | undefined, u: { i: number; o: number; cr: number; c1h: number }) {
  const usage: Record<string, unknown> = {
    input_tokens: u.i, output_tokens: u.o, cache_read_input_tokens: u.cr,
    cache_creation_input_tokens: u.c1h,
    cache_creation: { ephemeral_1h_input_tokens: u.c1h, ephemeral_5m_input_tokens: 0 },
  };
  if (speed !== undefined) usage.speed = speed;
  return JSON.stringify({
    type: "assistant", timestamp: "2026-10-03T12:00:00.000Z", cwd,
    message: { id, model: MODEL, usage, content: [{ type: "text", text: "x" }] },
  });
}

const TURN = { i: 1_000, o: 20_000, cr: 500_000, c1h: 30_000 };
const usageOf = (u: typeof TURN): TokenUsage => ({
  inputTokens: u.i, outputTokens: u.o, cacheReadTokens: u.cr, cacheCreateTokens: u.c1h,
  cacheCreate1hTokens: u.c1h, cacheCreate5mTokens: 0,
});
/** What the board charges for that turn at each speed (#754). */
const BOARD_FAST = costForUsage({ ...usageOf(TURN), bySpeed: { fast: usageOf(TURN) } }, MODEL, NOW).total;
const BOARD_STANDARD = costForUsage(usageOf(TURN), MODEL, NOW).total;

/** The report's input for the tally's only account, the way the modal gets it. */
function dailyOf(tally: Record<string, unknown>): DayInput[] {
  const [key] = Object.keys(tally);
  return reportFrom(tally, TIMELINE, key, 0, NOW).daily;
}

const costOf = (rec: ReturnType<typeof reconcile>, path: string) => rec.projects.find(p => p.path === path)?.cost;

describe("the Projects report prices a fast turn the way the board does", () => {
  it("is not the standard rate: the premium is real money", () => {
    expect(BOARD_FAST / BOARD_STANDARD).toBeGreaterThan(1.9);
  });

  it("charges a fast turn at the fast rate where ccusage has not calibrated the day", () => {
    const tally: Record<string, unknown> = {};
    foldLine(tally, line("/w/fast", "m1", "fast", TURN), TIMELINE);
    const rec = reconcile(dailyOf(tally), null, new Map(), NOW);
    expect(rec.calibrated).toBe(false);
    expect(costOf(rec, "/w/fast")).toBeCloseTo(BOARD_FAST, 6);
    expect(rec.unpricedTokens).toBe(0);
  });

  it("leaves a standard turn, and one that names no speed, at the standard rate", () => {
    const tally: Record<string, unknown> = {};
    foldLine(tally, line("/w/std", "m1", STANDARD_SPEED, TURN), TIMELINE);
    foldLine(tally, line("/w/old", "m2", undefined, TURN), TIMELINE);
    const rec = reconcile(dailyOf(tally), null, new Map(), NOW);
    expect(costOf(rec, "/w/std")).toBeCloseTo(BOARD_STANDARD, 6);
    expect(costOf(rec, "/w/old")).toBeCloseTo(BOARD_STANDARD, 6);
  });

  it("splits a calibrated day between projects by what each was billed at", () => {
    // Two projects, one turn each, on one day: the fast one and a standard one.
    // ccusage prices fast mode as well, so its cost for the day is the board's
    // two figures added, over tokens it reports as one flat count.
    const tally: Record<string, unknown> = {};
    foldLine(tally, line("/w/fast", "m1", "fast", TURN), TIMELINE);
    foldLine(tally, line("/w/std", "m2", STANDARD_SPEED, TURN), TIMELINE);
    const flat = (n: number) => ({
      inputTokens: TURN.i * n, outputTokens: TURN.o * n, cacheReadTokens: TURN.cr * n, cacheCreationTokens: TURN.c1h * n,
    });
    const flatOne = { ...usageOf(TURN), cacheCreate1hTokens: 0, cacheCreate5mTokens: 0 };
    const ccCost = costForUsage({ ...flatOne, bySpeed: { fast: flatOne } }, MODEL, NOW).total
      + costForUsage(flatOne, MODEL, NOW).total;
    const cells = ccCellsFrom({ days: [{ period: "2026-10-03", modelBreakdowns: [{ modelName: MODEL, cost: ccCost, ...flat(2) }] }] });
    const rec = reconcile(dailyOf(tally), null, cells, NOW);
    expect(rec.calibrated).toBe(true);
    // The day is ccusage's to the cent, as before…
    expect(rec.totalCost).toBeCloseTo(ccCost, 6);
    // …and the fast project carries its premium rather than half of it.
    const fast = costOf(rec, "/w/fast")!;
    const std = costOf(rec, "/w/std")!;
    expect(fast + std).toBeCloseTo(ccCost, 6);
    expect(fast / std).toBeCloseTo(BOARD_FAST / BOARD_STANDARD, 2);
  });

  it("prices Unattributed fast turns at the fast rate too", () => {
    const un: Record<string, Counters> = {};
    const tally: Record<string, unknown> = {};
    foldLine(tally, line("/w/fast", "m1", "fast", TURN), []);   // before tracking: no account
    for (const days of Object.values(Object.values(tally)[0] as Record<string, Record<string, Record<string, Counters>>>)) {
      for (const models of Object.values(days)) Object.assign(un, models);
    }
    const rec = reconcile([], un, new Map(), NOW);
    expect(rec.unattributed?.cost).toBeCloseTo(BOARD_FAST, 6);
  });

  it("counts a fast share it has no rate for as unpriced, never at the standard rate", () => {
    const tally: Record<string, unknown> = {};
    // A speed this build has never read a price for.
    foldLine(tally, line("/w/odd", "m1", "turbo", TURN), TIMELINE);
    const rec = reconcile(dailyOf(tally), null, new Map(), NOW);
    expect(costOf(rec, "/w/odd")).toBe(0);
    expect(rec.unpricedTokens).toBe(TURN.i + TURN.o + TURN.cr + TURN.c1h);
  });
});

describe("a tally written before the speed was kept", () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

  it("is rebuilt from the transcripts rather than read with every fast turn at standard", async () => {
    const root = await mkdtemp(join(tmpdir(), "ap-fast-"));
    dirs.push(root);
    const stateFile = join(root, "st.json");
    // The previous version's file: counters with no speed, its cursors past
    // everything it folded.
    await writeFile(stateFile, JSON.stringify({
      version: 3, cursors: { "/gone.jsonl": 10 }, folders: {},
      tally: { k: { "/w": { "2026-10-03": { [MODEL]: { i: 1, o: 0, cr: 0, cc: 0, c1h: 0, c5m: 0 } } } } },
      lastAlive: NOW,
    }), "utf8");
    const rollup = createProjectRollup({
      now: () => NOW, roots: [join(root, "projects")], state: stateFile,
      swapLog: join(root, "swap.jsonl"), storeRoot: join(root, "no-store"),
    });
    await rollup.tick();
    const disk = JSON.parse(await readFile(stateFile, "utf8"));
    expect(disk.version).toBeGreaterThan(3);
    expect(disk.tally.k).toBeUndefined();
    expect(disk.lastAlive).toBe(NOW);
  });
});
