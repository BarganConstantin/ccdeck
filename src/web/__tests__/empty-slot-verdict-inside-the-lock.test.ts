// #1040: a peer's credential could replace a login created seconds earlier,
// because "is this slot empty" was answered before the lock the write takes.
//
// The LAN sync's one destructive move is the forced import, and the whole of
// what makes it safe is one sentence, which index.mjs already wrote down:
//
// > ASKED NOW, NOT READ FROM THE CACHE. The cached verdicts are up to ten
// > minutes old, which is right for a label and wrong for a decision that
// > writes a credential: somebody who signed in two minutes ago still reads as
// > `no_credentials` there, and acting on that would replace the login they had
// > just created.
//
// Replacing the ten-minute cache with a fresh `cswap list --json` SHORTENED
// that window. It did not close it, because the read was outside the store
// mutex and the write is inside it: `importAccount` opens `withStoreLock` in
// its own body. The two were never one critical section, and the gap between
// them is not microseconds — it is however long the queue is:
//
//   registerSignedIn   `cswap add`     CSWAP_TIMEOUT_MS   60 s
//                      `cswap list`    CSWAP_TIMEOUT_MS   60 s
//   restoreActive      `cswap switch`                     30 s
//
// WHAT WAS OBSERVED, driven below against the real verdictNow and the real
// importAccount, with the pre-fix sequence copied out of index.mjs line for
// line: a round took the verdict `no_credentials` for a slot, queued on a
// mutex a sign-in was holding, and — after the sign-in had finished and
// claude-swap was reporting that same account as healthy — ran
// `cswap import - --force` over it anyway. The blob that won was the peer's,
// which may be older, may be revoked, may be from the wrong device; and a
// fresh token replaced by a stale one is not recoverable from this deck, the
// fix is a re-login. The verdict the write acted on was, by then, a statement
// about a store that no longer existed.
//
// So the check moved inside the write. `fillEmptySlot` opens the lock once and
// re-reads the verdict as its FIRST statement inside it; `importAccount` takes
// the same re-entrant lock again, so the whole decision is one uninterrupted
// hold and the promise holds by construction rather than by timing.
//
// Nothing here runs a real subprocess, reads a real store, or holds a real
// credential: exec.mjs's three spawners are replaced, AGENTS_DECK_CSWAP points
// at a path that is not there, HOME and CLAUDE_SWAP_BACKUP are checked to be
// inside a temp directory before the modules are imported, and the only token
// string in the file is the literal text "not-a-token".
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-empty-slot-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_SWAP_BACKUP", "AGENTS_DECK_CSWAP"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "cswap");
process.env.AGENTS_DECK_CSWAP = join(DIR, "no-such-cswap");

const inside = (p: string) => resolve(p).startsWith(resolve(DIR));
for (const k of ENV_KEYS) {
  if (!inside(process.env[k]!)) throw new Error(`sandbox escaped: ${k}=${process.env[k]}`);
}
if (!inside(homedir())) throw new Error(`sandbox escaped: homedir ${homedir()}`);
mkdirSync(join(DIR, "cswap"), { recursive: true });

// A made-up account on a reserved test domain. `.test` never resolves, by RFC
// 2606, and the credential is the string "not-a-token".
const EMAIL = "alice@example.test";
const ORG = "org-a";
const SLOT = 3;

const { proc } = vi.hoisted(() => ({
  proc: {
    calls: [] as string[][],
    // Every payload handed to a `cswap import` on stdin. What the CLI is given
    // is the only place the narrowing is visible; the argument vector says only
    // that `--force` was passed, not what it was allowed to overwrite.
    written: [] as string[],
    // What claude-swap says about the slot RIGHT NOW. The test moves this the
    // way a sign-in would.
    verdict: "no_credentials",
  },
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const okay = { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" };
  return {
    ...real,
    run: async (_cmd: string, args: string[] = []) => {
      proc.calls.push(args);
      if (args[0] === "list" && args[1] === "--json") {
        return { ...okay, stdout: JSON.stringify({ accounts: [
          { number: 3, email: "alice@example.test", organizationUuid: "org-a", usageStatus: proc.verdict },
        ] }) };
      }
      return okay;
    },
    runDetached: (_cmd: string, args: string[] = []) => { proc.calls.push(args); },
    runInteractive: (_cmd: string, args: string[] = []) => {
      proc.calls.push(args);
      // claude-swap's own narration for a `--force` that replaced a row, which
      // is the only place a forced replace is visible: it moves no slot, so the
      // store diff cannot show it. See importOutcomes.
      return {
        done: Promise.resolve({ ...okay, stderr: "Overwrote alice@example.test" }),
        write(text: string) { proc.written.push(text); },
        end() {}, onLine() {}, kill() {},
      };
    },
  };
});

// @ts-expect-error — plain .mjs server module, no types
const admin = await import("../../server/cswap-admin.mjs");

const rest = (ms: number) => new Promise(r => setTimeout(r, ms));
const forcedImports = () => proc.calls.filter(a => a[0] === "import" && a.includes("--force"));
const verdictReads = () => proc.calls.filter(a => a[0] === "list" && a[1] === "--json");

/** A bundle carrying the shape of one account and nothing that is a secret. */
const BLOB = admin.wrapShare(JSON.stringify({
  version: 1,
  activeAccountNumber: SLOT,
  accounts: [{ number: SLOT, email: EMAIL, organizationUuid: ORG, oauth: { accessToken: "not-a-token" } }],
}));

/** A second account in the same bundle, to check what a forced import narrows to. */
const PAIR_BLOB = admin.wrapShare(JSON.stringify({
  version: 1,
  activeAccountNumber: SLOT,
  accounts: [
    { number: SLOT, email: EMAIL, organizationUuid: ORG, oauth: { accessToken: "not-a-token" } },
    { number: 9, email: "bob@example.test", organizationUuid: "org-b", oauth: { accessToken: "not-a-token" } },
  ],
}));

/** claude-swap's sequence.json, with the slot present — which it is either way:
 *  an account with no stored login still holds its number and its address. */
writeFileSync(join(DIR, "cswap", "sequence.json"), JSON.stringify({
  activeAccountNumber: SLOT,
  accounts: { [SLOT]: { email: EMAIL, organizationUuid: ORG } },
}));

beforeEach(() => {
  proc.calls.length = 0;
  proc.written.length = 0;
  proc.verdict = "no_credentials";
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k]!;
  }
  rmTempDir(DIR);
});

describe("filling an empty slot from a peer", () => {
  it("does not replace a login that landed while the write was queued", async () => {
    // THE RACE, DRIVEN. A LAN round reaches the step for this account at the
    // moment a sign-in is holding the mutex. Before the fix the verdict was
    // read here, out in the open, and only the import queued — so by the time
    // the import ran, the answer it was acting on was minutes old and wrong.
    let release!: () => void;
    let acquired!: () => void;
    const reached = new Promise<void>(r => { acquired = r; });
    const held = admin.withStoreLock(() => {
      acquired();
      return new Promise<void>(r => { release = r; });
    });
    await reached;

    const filling = admin.fillEmptySlot(BLOB, { email: EMAIL, org: ORG });
    await rest(40);
    // Nothing at all has been asked yet: the verdict belongs inside the lock,
    // and a verdict taken out here is the defect however fresh it is.
    expect(verdictReads(), "the verdict was taken outside the lock").toEqual([]);

    // THE LOGIN LANDS. The user pasted their code; `cswap add` captured live
    // credentials for this very account, and claude-swap now says so.
    proc.verdict = "active";
    release();
    await held;

    expect(await filling).toMatchObject({ ok: false, why: "claude-swap kept the slot it already has" });
    expect(forcedImports(), "a peer's blob was written over a fresh login").toEqual([]);
  });

  it("never forces over a slot this Mac's Keychain will not open, and says which refusal it was", async () => {
    // An unreadable Keychain is an UNKNOWN, not an empty slot. The refusal
    // itself is the `!== "no_credentials"` line; the name only changes on a
    // Mac, because elsewhere claude-swap's `keychain_unavailable` is an .enc
    // file it cannot open and the Keychain sentence would be about nothing.
    for (const [platform, why] of [
      ["darwin", "unreadable_here"],
      ["linux", "claude-swap kept the slot it already has"],
      ["win32", "claude-swap kept the slot it already has"],
    ]) {
      proc.calls.length = 0;
      proc.verdict = "keychain_unavailable";
      expect(await admin.fillEmptySlot(BLOB, { email: EMAIL, org: ORG, platform }), platform)
        .toEqual({ ok: false, why });
      expect(forcedImports(), `${platform}: forced over an unreadable slot`).toEqual([]);
    }
  });

  it("still fills a slot that is genuinely empty, which is the feature", async () => {
    // The other half, and the reason this cannot simply be made timid: an
    // account with no stored login is the one case pairing exists for, and the
    // one a plain `cswap import` will never repair — claude-swap replaces a row
    // only when its usage row is quarantined as refresh-token-dead, "never
    // triggered by the live store's `no credentials` state".
    const out = await admin.fillEmptySlot(BLOB, { email: EMAIL, org: ORG });
    expect(out).toMatchObject({ ok: true, filled: true });
    expect(forcedImports()).toEqual([["import", "-", "--force"]]);
    // And it asked, rather than assuming — once, inside the lock.
    expect(verdictReads().length).toBe(1);
  });

  it("refuses a slot claude-swap says is not empty, and never reaches the CLI to be told", async () => {
    proc.verdict = "active";
    expect(await admin.fillEmptySlot(BLOB, { email: EMAIL, org: ORG }))
      .toMatchObject({ ok: false, why: "claude-swap kept the slot it already has" });
    expect(forcedImports()).toEqual([]);
  });

  it("refuses when the verdict cannot be read at all, rather than treating silence as empty", async () => {
    // verdictNow answers null for an account claude-swap does not know, for a
    // refusal, and for no claude-swap at all. Null is not `no_credentials`, and
    // the difference is a credential.
    expect(await admin.fillEmptySlot(BLOB, { email: "nobody@example.test", org: "org-z" }))
      .toMatchObject({ ok: false, why: "claude-swap kept the slot it already has" });
    expect(forcedImports()).toEqual([]);
  });

  it("forces only the account it was asked about, never the rest of the bundle", async () => {
    // `--force` overwrites every account it matches. A bundle of two carried in
    // behind a verdict about one would rewrite a credential nobody looked at,
    // and a fresh token replaced by a stale one is not recoverable from here.
    // The narrowing is what keeps an overwrite a named act, so it is asserted
    // on the payload rather than trusted to the flag.
    const out = await admin.fillEmptySlot(PAIR_BLOB, { email: EMAIL, org: ORG });
    expect(out).toMatchObject({ ok: true, filled: true });
    expect(forcedImports()).toEqual([["import", "-", "--force"]]);
    // The envelope the CLI was actually given, which is where the narrowing is.
    const sent = JSON.parse(proc.written.join("")) as { accounts: Array<{ email: string }> };
    expect(sent.accounts.map(a => a.email)).toEqual([EMAIL]);
  });
});

describe("the wiring that reaches it", () => {
  const indexSrc = readFileSync(fileURLToPath(new URL("../../server/index.mjs", import.meta.url)), "utf8");
  const step = indexSrc.slice(indexSrc.indexOf("  importAccount: async (blob, step) =>"));
  const fn = step.slice(0, step.indexOf("\n  },"));

  it("hands the whole decision over rather than making it out here", () => {
    // The pair is what the defect WAS. Keeping the verdict on this side of the
    // call — however fresh, however close to the import — puts the check back
    // outside the lock the write takes, which is the entire bug.
    expect(fn).toMatch(/fillEmptySlot\(blob, \{ email: want, org: wantOrg \?\? "", collect: !CHECKS_IMPORTS \}\)/);
    expect(fn, "the verdict belongs inside the lock, not in the route").not.toMatch(/verdictNow/);
    expect(fn, "a forced import out here is the unlocked write again").not.toMatch(/force: true/);
  });

  it("still never forces on the ordinary path, and still narrows it", () => {
    // Two separate promises on the first import in this callback, and they are
    // kept by two separate things.
    //
    // NO `force`: a peer cannot overwrite a working credential of this deck's
    // even by lying about its own, because the flag that would allow it is not
    // passed. Asserted as the flag's absence, since that is how it is kept.
    //
    // AND `only`: #974's, and it is not implied by the first. The seal's AAD
    // binds the envelope to the key that was requested and says nothing about
    // the contents, so a peer asked for A could seal a bundle carrying A plus
    // B, C and D under A's AAD and every one of them would land as an "add".
    // `only` narrows without implying `force` — `overwrite` is
    // `force === true && narrowing` — so both promises hold at once.
    expect(fn).toMatch(/const out = await importAccount\(blob, \{ only: \{ email: want, org: wantOrg \?\? "" \}, collect: !CHECKS_IMPORTS \}\);/);
    // Comments dropped first: the prose above the call explains at length why
    // the flag is absent, and a test that failed on its own explanation would
    // be worse than no test.
    const code = fn.split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
    const end = code.indexOf("if (landed(out.results))");
    expect(end, "the ordinary path's arrival check moved; this slice would cover the whole route").toBeGreaterThan(-1);
    const first = code.slice(0, end);
    expect(first, "the ordinary import must not force").not.toMatch(/force/);
  });
});
