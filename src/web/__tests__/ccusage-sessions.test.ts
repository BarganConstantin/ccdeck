// The usage range carries its sessions, not only its days.
//
// `daily` answers "what did this cost". `session` answers "which session spent
// it". They used to be two commands and therefore two children — two Node
// starts and two full walks of every transcript on the machine for the same set
// of files — and `--sections daily,session` is ccusage's own answer to that:
// one load, both reports in one JSON object.
//
// WHY THE SESSIONS ARE WORTH ASKING FOR. On a session row ccusage puts the
// SESSION ID in `period` — the same uuid Claude Code writes into every hook
// payload, and therefore the same key the canvas files its agents under. So
// these rows join to the board by id, which is what lets a panel show ccusage's
// money against the deck's own project names. Without the join a session row is
// a uuid and a number.
//
// Two rules are asserted hardest here:
//   * losing the sessions must never cost the totals — every way the session
//     half can fail leaves `days` and `totals` exactly as they were and hands
//     back an empty list, which draws one section short; that is the same state
//     a machine with no ccusage at all is already in;
//   * a ccusage that TOOK the flag is never asked twice. The second child
//     belongs to the older builds, and this file counts children to prove it.
//
// Real children, launched by absolute path, from a sandboxed HOME.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-ccusage-sessions-"));
const prev = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  AGENTS_DECK_NO_INSTALL: process.env.AGENTS_DECK_NO_INSTALL,
  PATH: process.env.PATH,
  AGENTS_DECK_CCUSAGE: process.env.AGENTS_DECK_CCUSAGE,
};
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, ".claude");
process.env.CODEX_HOME = join(SANDBOX, ".codex");
process.env.AGENTS_DECK_NO_INSTALL = "1";
// The developer's own PATH may hold a real ccusage, and a real one would answer
// with this machine's transcripts rather than with the fixture below.
process.env.PATH = SANDBOX;
delete process.env.AGENTS_DECK_CCUSAGE;
if (!homedir().startsWith(SANDBOX)) {
  throw new Error(`refusing to run: homedir() is ${homedir()}, outside ${SANDBOX}`);
}

// @ts-expect-error — .mjs server module, no types
const { fetchCcusageDaily } = await import("../../server/ccusage.mjs");

const PKG_DIR = join(SANDBOX, ".agents-deck", "ccusage", "node_modules", "ccusage");
if (!PKG_DIR.startsWith(SANDBOX)) throw new Error(`refusing to run: ${PKG_DIR} escaped ${SANDBOX}`);

const RUNS = join(SANDBOX, "runs.log");

/**
 * A fake ccusage, written as the deck's managed install.
 *
 * `sections` is what the modern CLI does: when `--sections` is on the command
 * line it emits both reports from one run. `session` is the separate subcommand
 * the fallback path uses. Every run appends its argument vector to RUNS, which
 * is how the child COUNT is asserted rather than assumed — the whole point of
 * the change this file covers is that there is one child where there were two.
 */
function fakeCcusage({ daily, session, sections, rejectsSections = false }: {
  daily: string; session?: string; sections?: string; rejectsSections?: boolean;
}) {
  mkdirSync(join(PKG_DIR, "src"), { recursive: true });
  writeFileSync(join(PKG_DIR, "package.json"), JSON.stringify({ version: "0.0.0-test", bin: "./src/cli.js" }));
  writeFileSync(join(PKG_DIR, "src", "cli.js"), [
    'const fs = require("node:fs");',
    `fs.appendFileSync(${JSON.stringify(RUNS)}, process.argv.slice(2).join(" ") + "\\n");`,
    'const cmd = process.argv[2];',
    'const wantsSections = process.argv.includes("--sections");',
    rejectsSections
      ? 'if (wantsSections) { console.error("Unknown option \'--sections\'"); process.exit(2); }'
      : "",
    session ? `if (cmd === "session") { ${session} }` : 'if (cmd === "session") { process.exit(0); }',
    sections ? `else if (wantsSections) { ${sections} }` : "",
    `else { ${daily} }`,
  ].join("\n"));
  writeFileSync(RUNS, "");
}

/** The argument vectors of every child since the last fake was written. */
const runs = (): string[] =>
  readFileSync(RUNS, "utf8").split("\n").filter(Boolean);

afterAll(() => {
  for (const [key, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(SANDBOX);
});

/** The shape `daily --json` really returns, trimmed to what is read. */
const DAILY = JSON.stringify({
  daily: [{
    period: "2026-09-04", agent: "all", totalCost: 803.58, totalTokens: 1_115_675_828,
    modelBreakdowns: [{ modelName: "claude-opus-5", cost: 723.56 }],
  }],
  totals: { totalCost: 803.58, totalTokens: 1_115_675_828 },
});

/** And `session --json`. The array is named after the COMMAND, not after its
 *  contents — `session`, singular. `sessions` reads as the obvious guess and is
 *  always undefined, which is the one shape mistake this parser can make. */
const SESSION = JSON.stringify({
  session: [
    { period: "07ac7b2b-7ee2-4633-a3cf-c0b1c193a65c", agent: "claude", totalCost: 376.88,
      modelsUsed: ["claude-opus-5", "claude-sonnet-5"] },
    { period: "093cb8a9-0000-4000-8000-000000000000", agent: "claude", totalCost: 88.0,
      modelsUsed: ["claude-opus-5"] },
  ],
  totals: { totalCost: 464.88 },
});

// Results are cached per range, so every case asks for its own date.
let day = 20260101;
const range = () => String(++day);

/** Both reports in one object, which is what `--sections daily,session`
 *  returns. Trimmed to the fields the server reads. */
const BOTH = JSON.stringify({
  daily: [{
    period: "2026-09-04", agent: "all", totalCost: 803.58, totalTokens: 1_115_675_828,
    modelBreakdowns: [{ modelName: "claude-opus-5", cost: 723.56 }],
  }],
  session: [
    { period: "07ac7b2b-7ee2-4633-a3cf-c0b1c193a65c", agent: "claude", totalCost: 376.88,
      modelsUsed: ["claude-opus-5", "claude-sonnet-5"] },
    { period: "093cb8a9-0000-4000-8000-000000000000", agent: "claude", totalCost: 88.0,
      modelsUsed: ["claude-opus-5"] },
  ],
  totals: { totalCost: 803.58, totalTokens: 1_115_675_828 },
});

describe("one load, both reports", () => {
  it("carries the days, the totals and the sessions from a single child", async () => {
    fakeCcusage({ daily: `console.log(${JSON.stringify(DAILY)});`, sections: `console.log(${JSON.stringify(BOTH)});` });
    const r = await fetchCcusageDaily({ since: range() });
    expect(r.ok).toBe(true);
    expect(r.days).toHaveLength(1);
    expect(r.totals.totalCost).toBeCloseTo(803.58, 6);
    expect(r.sessions).toHaveLength(2);
    // The measurement this change exists for.
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toContain("--sections daily,session");
  }, 40_000);

  it("keeps the session id, which is what joins a row to the canvas", async () => {
    fakeCcusage({ daily: `console.log(${JSON.stringify(DAILY)});`, sections: `console.log(${JSON.stringify(BOTH)});` });
    const r = await fetchCcusageDaily({ since: range() });
    expect(r.sessions.map((s: { period: string }) => s.period)).toEqual([
      "07ac7b2b-7ee2-4633-a3cf-c0b1c193a65c",
      "093cb8a9-0000-4000-8000-000000000000",
    ]);
    expect(r.sessions[0]).toMatchObject({ agent: "claude", totalCost: 376.88 });
  }, 40_000);

  it("never asks a second time when the section came back empty", async () => {
    // A build that took the flag reported what it had. An empty list there
    // means the range holds no sessions, and asking again as a separate command
    // would buy the same silence for a second walk of every transcript.
    fakeCcusage({
      daily: `console.log(${JSON.stringify(DAILY)});`,
      sections: `console.log(JSON.stringify({ daily: ${JSON.stringify(DAILY)} && ${JSON.stringify(JSON.parse(DAILY).daily)}, session: [], totals: ${JSON.stringify(JSON.parse(DAILY).totals)} }));`,
    });
    const r = await fetchCcusageDaily({ since: range() });
    expect(r.ok).toBe(true);
    expect(r.sessions).toEqual([]);
    expect(runs()).toHaveLength(1);
  }, 40_000);
});

describe("a ccusage too old for --sections", () => {
  it("falls back to the two commands rather than losing the sessions", async () => {
    fakeCcusage({
      rejectsSections: true,
      daily: `console.log(${JSON.stringify(DAILY)});`,
      session: `console.log(${JSON.stringify(SESSION)});`,
    });
    const r = await fetchCcusageDaily({ since: range() });
    expect(r.ok).toBe(true);
    expect(r.totals.totalCost).toBeCloseTo(803.58, 6);
    expect(r.sessions).toHaveLength(2);
    // Refused, retried flagless, then asked for the sessions.
    const vectors = runs();
    expect(vectors.some(v => v.includes("--sections"))).toBe(true);
    expect(vectors.at(-1)).toContain("session");
  }, 40_000);

  it("stops offering the flag once that ccusage has refused it", async () => {
    // Process-scoped memory, the same narrow kind `--by-agent` keeps: the retry
    // costs one child on a machine already failing, and remembering costs the
    // extra section for as long as this deck runs.
    fakeCcusage({
      rejectsSections: true,
      daily: `console.log(${JSON.stringify(DAILY)});`,
      session: `console.log(${JSON.stringify(SESSION)});`,
    });
    await fetchCcusageDaily({ since: range() });
    writeFileSync(RUNS, "");
    const r = await fetchCcusageDaily({ since: range() });
    expect(r.sessions).toHaveLength(2);
    expect(runs().some(v => v.includes("--sections"))).toBe(false);
  }, 40_000);
});

describe("when only the sessions fail", () => {
  const cases: Array<[string, string]> = [
    ["the subcommand is not known to this ccusage",
      'console.error("Unknown command: session"); process.exit(1);'],
    ["it exits non-zero with nothing to say", "process.exit(2);"],
    ["it prints something that is not JSON", 'console.log("<html>nope</html>");'],
    ["it prints JSON with no session array", 'console.log(JSON.stringify({ totals: {} }));'],
    ["it names the array the way a reader would guess",
      'console.log(JSON.stringify({ sessions: [{ period: "x" }] }));'],
  ];

  for (const [what, body] of cases) {
    it(`still returns the totals when ${what}`, async () => {
      // The rule: the panel is mostly about the money, and the money comes from
      // `daily`. A missing session list draws one section short; a missing
      // total draws a panel that is wrong.
      fakeCcusage({ rejectsSections: true, daily: `console.log(${JSON.stringify(DAILY)});`, session: body });
      const r = await fetchCcusageDaily({ since: range() });
      expect(r.ok, what).toBe(true);
      expect(r.totals.totalCost).toBeCloseTo(803.58, 6);
      expect(r.days).toHaveLength(1);
      expect(r.sessions, what).toEqual([]);
    }, 40_000);
  }
});

describe("when the day itself fails", () => {
  it("reports the failure rather than an empty success", async () => {
    fakeCcusage({ daily: 'console.error("boom"); process.exit(1);', sections: 'console.error("boom"); process.exit(1);' });
    const r = await fetchCcusageDaily({ since: range() });
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  }, 40_000);
});
