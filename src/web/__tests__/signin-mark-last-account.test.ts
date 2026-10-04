// "Deck signed this in" goes with the last account too.
//
// The deck remembers which accounts its own `+ → Sign in` added (#1893), and a
// roster read forgets the mark of any account claude-swap's store no longer
// holds, so the same address arriving later by a share or Local network is not
// taken for one this deck signed in. Except when the account removed was the
// last one: claude-swap rewrites sequence.json with `accounts: {}`, and the
// read treated an empty store as one to wait out. The mark stayed, a pasted
// share of the same address inherited it with the old sign-in time, and the
// first refusal of that shared login opened a re-sign-in prompt for an account
// the deck never signed in.
//
// Driven through the real roster read, with the deck's memory held by the real
// mutators and the store in a temp directory, every process faked.
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-mark-home-"));
const FAKE_STORE = mkdtempSync(join(tmpdir(), "ccdeck-mark-store-"));
const ENV_KEYS = [
  "HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "CCDECK_HOME",
  "CLAUDE_SWAP_BACKUP", "AGENTS_DECK_CLAUDE", "AGENTS_DECK_CSWAP",
] as const;
const prevEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, ".claude");
process.env.CODEX_HOME = join(FAKE_HOME, ".codex");
process.env.XDG_CONFIG_HOME = join(FAKE_HOME, ".config");
process.env.CCDECK_HOME = join(FAKE_HOME, "ccdeck");
process.env.CLAUDE_SWAP_BACKUP = FAKE_STORE;
process.env.AGENTS_DECK_CLAUDE = join(FAKE_HOME, "no-such-claude");
process.env.AGENTS_DECK_CSWAP = join(FAKE_HOME, "no-such-cswap");

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    run: async () => ({ ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" }),
    runDetached: () => {},
    runInteractive: () => { throw new Error("refusing to run an interactive process here"); },
  };
});

// @ts-expect-error — plain JS module, no types
const accounts = await import("../../server/claude-accounts.mjs");
// @ts-expect-error — plain JS module, no types
const { SIGNED_IN_HERE, withTidied } = await import("../../server/account-origins.mjs");
// @ts-expect-error — plain JS module, no types
const { accountKey } = await import("../../server/lan-copies.mjs");
// @ts-expect-error — plain JS module, no types
const { readStore } = await import("../../server/cswap-admin.mjs");

const WORK = "work@example.invalid";
const KEY = accountKey(WORK, "org-work");
const SEQ = join(FAKE_STORE, "sequence.json");

const store = (slots: Record<string, { email: string; organizationUuid: string }>, active: number | null) =>
  writeFileSync(SEQ, JSON.stringify({ activeAccountNumber: active, accounts: slots }));

store({ 1: { email: WORK, organizationUuid: "org-work" } }, 1);
if (!homedir().startsWith(FAKE_HOME)) throw new Error(`refusing to run: homedir() is ${homedir()}`);
{
  const seen = await readStore();
  if (seen.emails["1"] !== WORK) throw new Error("refusing to run: the store resolved outside the sandbox");
}

/** prefs.json's `accounts`, held in memory and written by the real mutator,
 *  the way account-routes.mjs wires the roster's tidy to prefs.json. */
let prefs: { accounts: Record<string, unknown> } = { accounts: {} };
accounts.accountOriginsWith({
  entries: () => prefs.accounts,
  tidy: (found: unknown) => { prefs = withTidied(found as never)(prefs) ?? prefs; },
});

async function read() {
  accounts.invalidateClaudeAccountsCache();
  const r = await accounts.fetchClaudeAccounts({ force: true });
  return r.accounts as Array<{ email: string; origin: string | null; reauth: unknown }>;
}

afterAll(() => {
  accounts.accountOriginsWith(null);
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(FAKE_HOME);
  rmTempDir(FAKE_STORE);
});

describe("the mark on the store's last account", () => {
  it("goes when that account is removed, so a share of the same address arrives unmarked", async () => {
    const sec = Math.floor(Date.now() / 1000);
    const signedInAt = (sec - 7200) * 1000;
    prefs = { accounts: { [KEY]: { origin: SIGNED_IN_HERE, signedInAt } } };
    expect((await read())[0]).toMatchObject({ email: WORK, origin: SIGNED_IN_HERE });

    // Removed — the panel's Remove or `cswap remove` — and it was the last one.
    store({}, null);
    await read();
    expect(prefs.accounts).toEqual({});

    // The same address pasted from a share, whose stored login claude-swap
    // then has refused.
    store({ 1: { email: WORK, organizationUuid: "org-work" } }, 1);
    mkdirSync(join(FAKE_STORE, "cache"), { recursive: true });
    writeFileSync(join(FAKE_STORE, "cache", "usage.json"), JSON.stringify({ schemaVersion: 2, accounts: {
      1: { email: WORK, organizationUuid: "org-work", consecutiveFailures: 2, lastError: "invalid_grant",
        fetchedAt: sec - 3600, lastAttemptAt: sec - 60, nextPollAt: sec + 3600 },
    } }));
    expect((await read())[0]).toMatchObject({ email: WORK, origin: null, reauth: null });
  });

  it("is kept while sequence.json cannot be read at all", async () => {
    prefs = { accounts: { [KEY]: { origin: SIGNED_IN_HERE, signedInAt: 1 } } };
    writeFileSync(SEQ, "{ half a fi");
    await read();
    expect(Object.keys(prefs.accounts)).toEqual([KEY]);
    store({ 1: { email: WORK, organizationUuid: "org-work" } }, 1);
  });
});
