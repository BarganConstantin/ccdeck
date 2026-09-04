// The usage range carries its sessions, not only its days.
//
// `ccusage daily` answers "what did this cost". `ccusage session` answers
// "which session spent it", and no flag on the first produces the second — they
// are two commands, so the range fetch now runs a second child.
//
// WHY THAT SECOND CHILD IS WORTH IT. On a session row ccusage puts the SESSION
// ID in `period` — the same uuid Claude Code writes into every hook payload,
// and therefore the same key the canvas files its agents under. So these rows
// join to the board by id, which is what lets a panel show ccusage's money
// against the deck's own project names. Without the join a session row is a
// uuid and a number.
//
// The failure rule is the one that matters most here and is asserted hardest:
// losing the sessions must never cost the totals. A ccusage too old to know the
// subcommand, one that prints rubbish to that command alone, one that exits
// non-zero — every one of them leaves `days` and `totals` exactly as they were
// and hands back an empty list, which draws one section short. That is the same
// state a machine with no ccusage at all is already in.
//
// Real children, launched by absolute path, from a sandboxed HOME.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

/** A ccusage that answers `daily` and `session` differently, because the range
 *  fetch runs both and the whole point is what happens when they disagree. */
function fakeCcusage(daily: string, session: string) {
  mkdirSync(join(PKG_DIR, "src"), { recursive: true });
  writeFileSync(join(PKG_DIR, "package.json"), JSON.stringify({ version: "0.0.0-test", bin: "./src/cli.js" }));
  writeFileSync(join(PKG_DIR, "src", "cli.js"), [
    "const cmd = process.argv[2];",
    `if (cmd === "session") { ${session} }`,
    `else { ${daily} }`,
  ].join("\n"));
}

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

describe("a range that answers both questions", () => {
  it("carries the days, the totals and the sessions", async () => {
    fakeCcusage(`console.log(${JSON.stringify(DAILY)});`, `console.log(${JSON.stringify(SESSION)});`);
    const r = await fetchCcusageDaily({ since: range() });
    expect(r.ok).toBe(true);
    expect(r.days).toHaveLength(1);
    expect(r.totals.totalCost).toBeCloseTo(803.58, 6);
    expect(r.sessions).toHaveLength(2);
  }, 40_000);

  it("keeps the session id, which is what joins a row to the canvas", async () => {
    // ccusage puts it in `period`. It is the same uuid Claude Code writes into
    // every hook payload, so the board can name these rows.
    fakeCcusage(`console.log(${JSON.stringify(DAILY)});`, `console.log(${JSON.stringify(SESSION)});`);
    const r = await fetchCcusageDaily({ since: range() });
    expect(r.sessions.map((s: { period: string }) => s.period)).toEqual([
      "07ac7b2b-7ee2-4633-a3cf-c0b1c193a65c",
      "093cb8a9-0000-4000-8000-000000000000",
    ]);
    expect(r.sessions[0]).toMatchObject({ agent: "claude", totalCost: 376.88 });
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
      fakeCcusage(`console.log(${JSON.stringify(DAILY)});`, body);
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
    // The second child must not turn a failed range into a half-good one.
    fakeCcusage('console.error("boom"); process.exit(1);', `console.log(${JSON.stringify(SESSION)});`);
    const r = await fetchCcusageDaily({ since: range() });
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  }, 40_000);
});
