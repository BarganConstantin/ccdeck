// #1798: ↻ on the Accounts panel never re-read claude-swap's store while the
// panel was open.
//
// `mayReadAccounts` gave a forced read a sixty-second floor and an unforced one
// the cache's five seconds, both measured from `_lastReadAt`. The panel's own
// fifteen-second poll stamps that every time, so a `?refresh=1` was always
// inside its minute and was handed the held reading — while an ordinary poll at
// the same instant would have gone to disk. #984 closed this for the deck's own
// mutations, which invalidate and reset the stamp; a `cswap switch` typed in a
// terminal, or the user's own engine moving the account, has no such path, so
// the press visibly did nothing at exactly the moment it was wanted.
//
// Nothing here spawns anything or touches a real store. `run` is mocked and
// records argv; HOME, USERPROFILE, CLAUDE_CONFIG_DIR, XDG_DATA_HOME and
// CLAUDE_SWAP_BACKUP all point into a temp directory before the module is
// imported; AGENTS_DECK_CSWAP names a path there that is never executed; and the
// store is seeded with nothing due, with AGENTS_DECK_NO_FRESHEN on as well, so
// the collector nudge has nothing to start.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { reads, spawned } = vi.hoisted(() => ({
  reads: [] as string[],
  spawned: [] as string[][],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async readFile(...args: Parameters<typeof actual.readFile>) {
      reads.push(String(args[0]));
      return actual.readFile(...args);
    },
  };
});

vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    spawned.push([cmd, ...args]);
    return { ok: false, code: 1, killed: false, stdout: "", stderr: "not in this test" };
  },
  runDetached: (cmd: string, args: string[] = []) => { spawned.push([cmd, ...args]); },
}));

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-1798-forced-reload-"));
const STORE = join(DIR, "cswap-store");
const KEYS = [
  "HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME", "CLAUDE_SWAP_BACKUP",
  "AGENTS_DECK_CSWAP", "AGENTS_DECK_NO_FRESHEN",
] as const;
const prevEnv = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, ".claude");
process.env.XDG_DATA_HOME = join(DIR, ".local", "share");
process.env.CLAUDE_SWAP_BACKUP = STORE;
process.env.AGENTS_DECK_CSWAP = join(DIR, "fake-cswap");
process.env.AGENTS_DECK_NO_FRESHEN = "1";
if (!resolve(STORE).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// Frozen and moved by hand, so "ten seconds later" is ten seconds exactly.
let skew = 0;
const FROZEN_AT = Date.now();
vi.spyOn(Date, "now").mockImplementation(() => FROZEN_AT + skew);
const advance = (ms: number) => { skew += ms; };

afterAll(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmTempDir(DIR);
});

/** Two accounts, `active` signed in, nothing due for collection. */
function seedStore(active: number): void {
  const sec = Math.floor(Date.now() / 1000);
  const acct = (n: number) => ({ email: `acct${n}@example.invalid`, organizationUuid: `org-${n}` });
  const row = (n: number, pct: number) => ({
    email: `acct${n}@example.invalid`,
    organizationUuid: `org-${n}`,
    fetchedAt: sec - 60,
    nextPollAt: sec + 3600,
    consecutiveFailures: 0,
    lastGood: { five_hour: { pct, resets_at: new Date((sec + 7200) * 1000).toISOString() } },
  });
  mkdirSync(join(STORE, "cache"), { recursive: true });
  writeFileSync(join(STORE, "sequence.json"), JSON.stringify({
    activeAccountNumber: active,
    sequence: [1, 2],
    accounts: { 1: acct(1), 2: acct(2) },
  }));
  writeFileSync(join(STORE, "cache", "usage.json"), JSON.stringify({
    schemaVersion: 2,
    accounts: { 1: row(1, active === 1 ? 91 : 20), 2: row(2, active === 2 ? 12 : 30) },
  }));
}

/** One roster read is exactly these two files. */
const rosterReads = () => reads.filter(p => p.endsWith("sequence.json") || p.endsWith("usage.json"));

type Roster = { ok: boolean; activeNum?: number | null; stale?: boolean; accounts?: unknown[] };
async function freshModule() {
  vi.resetModules();
  return await import("../../server/claude-accounts.mjs") as unknown as {
    fetchClaudeAccounts: (o?: { force?: boolean }) => Promise<Roster>;
  };
}

beforeEach(() => {
  reads.length = 0;
  spawned.length = 0;
  advance(120_000);
});

describe("↻ after a switch made outside the deck", () => {
  it("returns the store's current active account, not the reading the last poll took", async () => {
    seedStore(1);
    const { fetchClaudeAccounts } = await freshModule();
    const polled = await fetchClaudeAccounts();     // the panel's background poll
    expect(polled.activeNum).toBe(1);

    // `cswap switch 2` in a terminal: nothing in the deck is told.
    seedStore(2);
    advance(10_000);
    const pressed = await fetchClaudeAccounts({ force: true });

    expect(pressed.activeNum, "the press handed back the account from before the switch").toBe(2);
    expect(pressed.stale, "the press was answered with a held reading").toBeUndefined();
    expect(spawned, "a roster read spawned something").toEqual([]);
  });

  it("stays rate-limited: two presses a second apart cost one trip to the store", async () => {
    seedStore(1);
    const { fetchClaudeAccounts } = await freshModule();
    await fetchClaudeAccounts();
    seedStore(2);
    advance(10_000);

    reads.length = 0;
    const first = await fetchClaudeAccounts({ force: true });
    expect(first.activeNum).toBe(2);
    expect(rosterReads()).toHaveLength(2);

    advance(1_000);
    const second = await fetchClaudeAccounts({ force: true });
    expect(rosterReads(), "a press held down read the store twice inside five seconds").toHaveLength(2);
    expect(second.activeNum).toBe(2);
    expect(second.stale).toBe(true);
    expect(spawned).toEqual([]);
  });
});
