// The re-sign-in prompt must stay quiet over a re-sign-in that just succeeded.
//
// The case: an account the deck signed in has collected nothing for over half
// a day, and claude-swap's cached verdict on it, asked minutes ago, is
// `relogin_required`. The owner signs it in again. `cswap add` clears the
// failure counter and the error but leaves `fetchedAt` where it was, so the
// row still reads as a collector that stopped — and the first `cswap list`
// after the sign-in stamps `lastAttemptAt` as it claims the slot, before it
// fetches anything. A roster read inside that claim found a stopped collector,
// the pre-sign-in verdict, and an attempt later than the sign-in: a new
// incident, named by the sign-in itself, which the prompt asked about again as
// soon as the sign-in dialog closed.
//
// A verdict asked before the last sign-in here is about the login that sign-in
// replaced, so it no longer counts. Driven through the real roster read, with
// the store in a temp directory and every process faked — this is the code that
// reads the account store, and nothing in it may reach the real one.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-resignin-home-"));
const FAKE_STORE = mkdtempSync(join(tmpdir(), "ccdeck-resignin-store-"));
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

// Nothing runs for real: every subprocess answers empty, and none is spawned.
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
const verdicts = await import("../../server/claude-verdicts.mjs");
// @ts-expect-error — plain JS module, no types
const { accountKey } = await import("../../server/lan-copies.mjs");
// @ts-expect-error — plain JS module, no types
const { readStore } = await import("../../server/cswap-admin.mjs");

const WORK = "work@example.invalid";
const KEY = accountKey(WORK, "org-work");

writeFileSync(join(FAKE_STORE, "sequence.json"), JSON.stringify({
  activeAccountNumber: 1,
  accounts: { 1: { email: "other@example.invalid", organizationUuid: "org-other" }, 2: { email: WORK, organizationUuid: "org-work" } },
}));
if (!homedir().startsWith(FAKE_HOME)) throw new Error(`refusing to run: homedir() is ${homedir()}`);
{
  const seen = await readStore();
  if (seen.emails["2"] !== WORK) throw new Error("refusing to run: the store resolved outside the sandbox");
}

/** usage.json as claude-swap leaves it, slot 2 in `row2`'s state. */
function usage(row2: Record<string, unknown>) {
  const sec = Date.now() / 1000;
  mkdirSync(join(FAKE_STORE, "cache"), { recursive: true });
  writeFileSync(join(FAKE_STORE, "cache", "usage.json"), JSON.stringify({ schemaVersion: 2, accounts: {
    1: { email: "other@example.invalid", organizationUuid: "org-other", consecutiveFailures: 0, lastError: null, fetchedAt: sec - 60, lastAttemptAt: sec - 60, nextPollAt: sec + 3600, lastGood: {} },
    2: { email: WORK, organizationUuid: "org-work", nextPollAt: sec + 3600, ...row2 },
  } }));
}

/** claude-swap's verdicts, asked now: slot 2's login needs a new sign-in. */
async function verdictReloginRequired() {
  const stdout = JSON.stringify({ accounts: [
    { number: 1, email: "other@example.invalid", organizationUuid: "org-other", usageStatus: "ok" },
    { number: 2, email: WORK, organizationUuid: "org-work", usageStatus: "relogin_required" },
  ] });
  const runner = async () => ({ ok: true, code: 0, killed: false, timedOut: false, stdout, stderr: "" });
  await verdicts.verdictsNow({ runner, bin: async () => "cswap" });
}

const tick = () => new Promise(r => setTimeout(r, 5));

async function reauthOfWork(signedInAt: number) {
  accounts.accountOriginsWith({ entries: () => ({ [KEY]: { origin: "ccdeck_signin", signedInAt } }), tidy: () => {} });
  accounts.invalidateClaudeAccountsCache();
  const r = await accounts.fetchClaudeAccounts({ force: true });
  return r.accounts.find((a: { email: string }) => a.email === WORK)?.reauth;
}

beforeEach(() => accounts.accountOriginsWith(null));

afterAll(() => {
  accounts.accountOriginsWith(null);
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(FAKE_HOME);
  rmTempDir(FAKE_STORE);
});

describe("a re-sign-in of an account dead for over half a day", () => {
  it("raises no new incident while the first collection after it holds the slot", async () => {
    // The verdict, cached minutes before the sign-in.
    await verdictReloginRequired();
    await tick();
    const signedInAt = Date.now();
    await tick();
    const sec = Date.now() / 1000;
    // After `cswap add` (counter and error cleared, fetchedAt untouched) and
    // the claim of the `cswap list` it starts (lastAttemptAt stamped, the
    // fetch still out).
    usage({
      consecutiveFailures: 0, lastError: null, fetchedAt: sec - 20 * 3600,
      lastAttemptAt: sec - 0.002, claimId: "c1", claimUntil: sec + 60,
    });
    expect(await reauthOfWork(signedInAt)).toBeNull();
  });

  it("still asks when claude-swap says so again after the sign-in", async () => {
    // A verdict asked after the sign-in, and an attempt recorded after it:
    // the new login is refused as well, and that is an incident.
    const signedInAt = Date.now() - 60_000;
    await verdictReloginRequired();
    const sec = Date.now() / 1000;
    usage({ consecutiveFailures: 0, lastError: null, fetchedAt: sec - 20 * 3600, lastAttemptAt: sec - 1 });
    expect(await reauthOfWork(signedInAt)).toEqual({ key: KEY, since: Math.floor(signedInAt), dismissed: false });
  });

  it("still asks about a refusal recorded after the sign-in, whatever the verdict", async () => {
    // Not the stopped path: claude-swap counted a refresh-token refusal.
    const signedInAt = Date.now() - 60_000;
    const sec = Date.now() / 1000;
    usage({ consecutiveFailures: 1, lastError: "invalid_grant", fetchedAt: sec - 3600, lastAttemptAt: sec - 1 });
    expect(await reauthOfWork(signedInAt)).toEqual({ key: KEY, since: Math.floor(signedInAt), dismissed: false });
  });
});
