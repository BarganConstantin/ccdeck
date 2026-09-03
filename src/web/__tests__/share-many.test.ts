// Moving a set of accounts between two machines, and saying truthfully what
// happened to each one.
//
// Three things here can be wrong in a way the user acts on rather than sees.
//
//   • A bundle that is quietly SHORT. `cswap export --account` names one
//     account, so the deck folds N envelopes itself; a fold that loses an entry
//     hands somebody a clipboard they believe holds five logins and does not,
//     and they find out on the other machine, later, with no error to read.
//
//   • A report that CLAIMS an import. The result list is what a person reads
//     before they close the tab and trust the deck. "imported" over an account
//     that never arrived is worse than no report at all.
//
//   • A `--force` that reaches further than the row it was pressed on.
//     Overwriting a healthy login with a stale one is not recoverable from the
//     deck — the fix is a re-login — so the flag is only ever allowed to carry
//     one named account.
//
// Nothing spawns. `run` and `runInteractive` answer from here, and the store is
// a sequence.json in a temp directory, so every assertion is about what this
// module composes rather than about a claude-swap that happens to be installed.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { brotliDecompressSync } from "node:zlib";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const store = vi.hoisted(() => ({ dir: "" }));
const cli = vi.hoisted(() => ({
  /** Every `run` call, in order. */
  calls: [] as { cmd: string; args: string[] }[],
  /** Answers for `run`, consumed in order; the last one repeats. */
  replies: [] as Record<string, unknown>[],
  /** The one `runInteractive`, and what was written to its stdin. */
  interactive: null as null | { args: string[]; stdin: string },
  interactiveReply: { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" } as Record<string, unknown>,
  /** What the run does to the store before it reports back - which is the
   *  whole of what a real `cswap import` is, from this module's side. */
  duringImport: null as null | (() => void),
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    run: async (cmd: string, args: string[] = []) => {
      cli.calls.push({ cmd, args });
      return cli.replies.length > 1 ? cli.replies.shift() : (cli.replies[0] ?? { ok: true, code: 0, stdout: "", stderr: "" });
    },
    runInteractive: (_cmd: string, args: string[] = []) => {
      const child = { args, stdin: "" };
      cli.interactive = child;
      return {
        write: (text: string) => { child.stdin += text; },
        end: () => {},
        // Resolved through a tick, with the store written first: importAccount
        // reads the store on either side of this promise, and the difference
        // between those two reads is the whole of its verdict.
        done: Promise.resolve().then(() => { cli.duringImport?.(); return cli.interactiveReply; }),
      };
    },
    runDetached: () => {},
  };
});

vi.mock("../../server/cswap-install.mjs", () => ({
  cswapBin: async () => "cswap-under-test",
  cswapVersion: async () => "0.25.0",
  installHint: () => "",
}));

vi.mock("../../server/claude-accounts.mjs", () => ({
  backupRoot: () => store.dir,
  invalidateClaudeAccountsCache: () => {},
}));

const admin = await import("../../server/cswap-admin.mjs") as any;
const {
  identityKey, mergeExports, shareAccounts, bundleAccounts,
  narrowBundle, importOutcomes, importAccount, wrapShare,
} = admin;

/** One account as `export_accounts` writes it, minus the credential body. */
const acct = (number: string, email: string, org = "org-a") => ({
  number, email, organizationUuid: org, organizationName: "Acme", config: {}, credentials: {},
});

/** One envelope as `cswap export - --account N` writes it. */
const envelope = (accounts: unknown[], activeAccountNumber: number | null = null) => JSON.stringify({
  version: 3,
  exportedAt: "2026-09-02T00:00:00Z",
  exportedFrom: "macos",
  swapVersion: "0.25.0",
  encrypted: false,
  activeAccountNumber,
  accounts,
});

/** What `run` returns for an export that worked. */
const exported = (text: string) => ({ ok: true, code: 0, killed: false, timedOut: false, stdout: text, stderr: "" });

/** Write a claude-swap store with these slots. */
const writeStore = (accounts: Record<string, { email: string; organizationUuid?: string }>) => {
  writeFileSync(join(store.dir, "sequence.json"), JSON.stringify({
    activeAccountNumber: null,
    lastUpdated: "",
    sequence: Object.keys(accounts),
    accounts,
  }), "utf8");
};

/** The bundle inside a wrapped share, as an object. */
const unwrapped = (blob: string) => {
  const body = JSON.parse(brotliDecompressSync(
    Buffer.from(blob.slice("ccdeck2:".length), "base64")).toString("utf8"));
  return JSON.parse(body.payload);
};

const dirs: string[] = [];
beforeEach(() => {
  store.dir = mkdtempSync(join(tmpdir(), "ccdeck-share-"));
  dirs.push(store.dir);
  writeStore({});
  cli.calls.length = 0;
  cli.replies.length = 0;
  cli.interactive = null;
  cli.duringImport = null;
  cli.interactiveReply = { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" };
});
afterAll(() => { for (const d of dirs) rmTempDir(d); });

describe("identityKey", () => {
  it("keeps one address under two organizations apart", () => {
    expect(identityKey("me@x.com", "org-a")).not.toBe(identityKey("me@x.com", "org-b"));
  });

  it("folds the case and the padding of an address, which the store and the bundle disagree about", () => {
    expect(identityKey(" Me@X.com ", "org-a")).toBe(identityKey("me@x.com", "org-a"));
  });
});

describe("mergeExports", () => {
  it("folds several envelopes into one that carries every account", () => {
    const out = mergeExports([envelope([acct("2", "a@x.com")]), envelope([acct("3", "b@x.com")])]);
    expect(out.ok).toBe(true);
    expect(out.envelope.accounts.map((a: any) => a.email)).toEqual(["a@x.com", "b@x.com"]);
  });

  it("carries claude-swap's own stamps rather than any this repo invented", () => {
    // The whole reason the head is spread instead of rebuilt: a FORMAT_VERSION
    // copied out of another project's source is a constant that drifts, and the
    // receiving cswap refuses an envelope whose version it does not know.
    const out = mergeExports([envelope([acct("2", "a@x.com")])]);
    expect(out.envelope).toMatchObject({ version: 3, exportedFrom: "macos", swapVersion: "0.25.0" });
  });

  it("keeps the active slot only when that account is actually in the bundle", () => {
    const kept = mergeExports([envelope([acct("2", "a@x.com")], 2)]);
    expect(kept.envelope.activeAccountNumber).toBe(2);
    // The head named slot 4 active, and slot 4 was not ticked. Carrying it
    // would have the far side seed an active account that never arrived.
    const cut = mergeExports([envelope([acct("2", "a@x.com")], 4)]);
    expect(cut.envelope.activeAccountNumber).toBe(null);
  });

  it("keeps one address under two organizations as two accounts", () => {
    const out = mergeExports([
      envelope([acct("2", "me@x.com", "org-a")]),
      envelope([acct("3", "me@x.com", "org-b")]),
    ]);
    expect(out.envelope.accounts).toHaveLength(2);
    expect(out.dropped).toEqual([]);
  });

  it("drops a repeated identity instead of shipping a bundle cswap would refuse whole", () => {
    // `import_accounts` raises on a duplicate (email, org) and imports NOTHING.
    // Carrying it would trade every other account in the bundle for that one.
    const out = mergeExports([
      envelope([acct("2", "me@x.com", "org-a")]),
      envelope([acct("5", "ME@x.com", "org-a")]),
    ]);
    expect(out.envelope.accounts).toHaveLength(1);
    expect(out.dropped).toEqual([{ num: "5", email: "ME@x.com" }]);
  });

  it("refuses a part that is not an envelope at all", () => {
    expect(mergeExports(['{"account":1}'])).toEqual({ ok: false, reason: "unreadable_export" });
    expect(mergeExports(["not json"])).toEqual({ ok: false, reason: "unreadable_export" });
  });

  it("refuses parts that disagree about the format version", () => {
    const other = JSON.parse(envelope([acct("3", "b@x.com")]));
    other.version = 4;
    expect(mergeExports([envelope([acct("2", "a@x.com")]), JSON.stringify(other)]))
      .toEqual({ ok: false, reason: "mixed_versions" });
  });
});

describe("shareAccounts", () => {
  it("asks for each ticked account by itself, and hands back one bundle", async () => {
    cli.replies.push(exported(envelope([acct("2", "a@x.com")])), exported(envelope([acct("3", "b@x.com")])));
    const out = await shareAccounts([2, 3]);

    expect(out.ok).toBe(true);
    expect(cli.calls.map(c => c.args)).toEqual([
      ["export", "-", "--account", "2"],
      ["export", "-", "--account", "3"],
    ]);
    expect(unwrapped(out.blob).accounts.map((a: any) => a.email)).toEqual(["a@x.com", "b@x.com"]);
    expect(out.shared).toEqual([{ num: "2", email: "a@x.com" }, { num: "3", email: "b@x.com" }]);
  });

  it("never reads an account that was not ticked", async () => {
    writeStore({ "2": { email: "a@x.com" }, "3": { email: "b@x.com" }, "4": { email: "c@x.com" } });
    cli.replies.push(exported(envelope([acct("3", "b@x.com")])));
    await shareAccounts([3]);
    // The alternative — export the whole store and prune — would have pulled
    // two refresh tokens this deck was never asked to move into this process.
    expect(cli.calls).toHaveLength(1);
    expect(cli.calls[0].args).toEqual(["export", "-", "--account", "3"]);
  });

  it("ships the accounts that worked and names the one that did not", async () => {
    writeStore({ "2": { email: "a@x.com" }, "4": { email: "broken@x.com" } });
    cli.replies.push(
      exported(envelope([acct("2", "a@x.com")])),
      { ok: false, code: 1, killed: false, timedOut: false, stdout: "", stderr: "Error: no backup credentials found for account 4" },
    );
    const out = await shareAccounts([2, 4]);

    expect(out.ok).toBe(true);
    // The count on the copy button reads off `shared`, so a short bundle says
    // it is short instead of presenting itself as the full set.
    expect(out.shared).toEqual([{ num: "2", email: "a@x.com" }]);
    expect(out.failed).toEqual([
      { num: "4", email: "broken@x.com", detail: "no backup credentials found for account 4" },
    ]);
  });

  it("builds the failure sentence from stderr alone, because that stdout is the credential", async () => {
    const SECRET = '  "refreshToken": "sk-ant-ort01-DEADBEEFdeadbeef-not-a-real-token",';
    cli.replies.push({ ok: false, code: 1, killed: false, timedOut: false, stdout: SECRET, stderr: "Error: nope" });
    const out = await shareAccounts([2]);
    expect(JSON.stringify(out)).not.toContain("sk-ant-ort01");
  });

  it("refuses outright when nothing at all could be exported", async () => {
    cli.replies.push({ ok: false, code: 1, killed: false, timedOut: false, stdout: "", stderr: "Error: nope" });
    const out = await shareAccounts([2]);
    expect(out).toMatchObject({ ok: false, reason: "export_failed", detail: "nope" });
  });

  it("asks once for an account named twice", async () => {
    cli.replies.push(exported(envelope([acct("2", "a@x.com")])));
    const out = await shareAccounts([2, 2]);
    expect(cli.calls).toHaveLength(1);
    expect(out.shared).toHaveLength(1);
  });

  it("refuses a list longer than any store, before spawning anything", async () => {
    // One spawn per account, so the length of the list is a length of time the
    // request holds open. Nine hundred numbers is not a person picking from a
    // panel of three.
    const many = Array.from({ length: 51 }, (_, i) => i + 1);
    expect(await shareAccounts(many)).toEqual({ ok: false, reason: "too_many" });
    expect(cli.calls).toHaveLength(0);
  });

  it("runs nothing for a slot number that is not one", async () => {
    for (const bad of [0, 1000, -1, 1.5, "x", null]) {
      expect(await shareAccounts([2, bad])).toEqual({ ok: false, reason: "bad_account" });
    }
    expect(await shareAccounts([])).toEqual({ ok: false, reason: "bad_account" });
    expect(cli.calls).toHaveLength(0);
  });

  it("wraps the bundle in the same envelope a single share has always used", async () => {
    cli.replies.push(exported(envelope([acct("2", "a@x.com")])));
    const out = await shareAccounts([2]);
    expect(out.blob.startsWith("ccdeck2:")).toBe(true);
    expect(out.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("narrowBundle", () => {
  const bundle = envelope([acct("2", "a@x.com", "org-a"), acct("3", "a@x.com", "org-b")], 3);

  it("cuts the bundle down to the one account named", () => {
    const out = narrowBundle(bundle, identityKey("a@x.com", "org-b"));
    expect(out.ok).toBe(true);
    const env = JSON.parse(out.payload);
    expect(env.accounts).toHaveLength(1);
    expect(env.accounts[0].organizationUuid).toBe("org-b");
  });

  it("drops an active slot that the cut removed", () => {
    const out = narrowBundle(bundle, identityKey("a@x.com", "org-a"));
    expect(JSON.parse(out.payload).activeAccountNumber).toBe(null);
  });

  it("refuses an identity the bundle does not carry", () => {
    expect(narrowBundle(bundle, identityKey("nobody@x.com", ""))).toEqual({ ok: false, reason: "not_in_bundle" });
  });
});

describe("bundleAccounts", () => {
  it("reads back the identities and nothing else", () => {
    expect(bundleAccounts(envelope([acct("2", "a@x.com", "org-a")])))
      .toEqual([{ email: "a@x.com", org: "org-a" }]);
  });

  it("says nothing rather than throwing on a payload it cannot read", () => {
    expect(bundleAccounts("not json")).toEqual([]);
    expect(bundleAccounts('{"accounts":"nope"}')).toEqual([]);
  });

  it("names all of them or none, so no count is taken against a short list", () => {
    // A bundle read as one when it holds two reports "1 of 1 imported" about a
    // paste of two: the second arrives and is never named, and a non-empty list
    // stops the store-diff fallback from running to catch it.
    const short = envelope([acct("2", "a@x.com"), { number: "3", config: {}, credentials: {} }]);
    expect(bundleAccounts(short)).toEqual([]);
  });
});

describe("importOutcomes", () => {
  const before = { slots: ["2"], emails: { "2": "here@x.com" }, orgs: { "2": "org-a" } };
  const after = {
    slots: ["2", "5"],
    emails: { "2": "here@x.com", "5": "new@x.com" },
    orgs: { "2": "org-a", "5": "org-a" },
  };

  it("calls an account that took a slot it did not hold before imported", () => {
    const out = importOutcomes(before, after, [{ email: "new@x.com", org: "org-a" }]);
    expect(out).toEqual([{ email: "new@x.com", org: "org-a", num: "5", state: "imported" }]);
  });

  it("calls an account that was already here present, not imported", () => {
    const out = importOutcomes(before, after, [{ email: "here@x.com", org: "org-a" }]);
    expect(out[0].state).toBe("present");
  });

  it("calls an account that is in neither store failed", () => {
    const out = importOutcomes(before, after, [{ email: "ghost@x.com", org: "org-a" }]);
    expect(out).toEqual([{ email: "ghost@x.com", org: "org-a", num: null, state: "failed" }]);
  });

  it("reads the one thing a store diff cannot show: credentials rewritten in place", () => {
    const healed = importOutcomes(before, after, [{ email: "here@x.com", org: "org-a" }],
      "Replaced here@x.com (slot 2 was quarantined: refresh token dead)");
    expect(healed[0].state).toBe("healed");
    const forced = importOutcomes(before, after, [{ email: "here@x.com", org: "org-a" }],
      "Overwrote here@x.com (slot 2)");
    expect(forced[0].state).toBe("updated");
  });

  it("degrades to the true word rather than the wrong one when cswap rewords itself", () => {
    // The store diff is the fact; stderr only refines it. A release that
    // renames "Replaced" costs the nuance and nothing else.
    const out = importOutcomes(before, after, [{ email: "here@x.com", org: "org-a" }],
      "Swapped-in here@x.com (slot 2)");
    expect(out[0].state).toBe("present");
  });

  it("refuses to guess which of two same-address rows a Replaced line meant", () => {
    // cswap's narration carries the address and not the organization, so with
    // one address held under two of them the line resolves to neither. Marking
    // both healed would be the wrong report, which is the one thing the store
    // diff exists to rule out; both stay at what the slots say.
    const before = {
      slots: ["2", "6"],
      emails: { "2": "here@x.com", "6": "here@x.com" },
      orgs: { "2": "org-a", "6": "org-b" },
    };
    const out = importOutcomes(before, before, [
      { email: "here@x.com", org: "org-a" },
      { email: "here@x.com", org: "org-b" },
    ], "Replaced here@x.com (slot 2 was quarantined: refresh token dead)");
    expect(out.map((r: any) => r.state)).toEqual(["present", "present"]);
  });

  it("judges one address under two organizations separately", () => {
    const two = {
      slots: ["2", "6"],
      emails: { "2": "here@x.com", "6": "here@x.com" },
      orgs: { "2": "org-a", "6": "org-b" },
    };
    const out = importOutcomes(before, two, [
      { email: "here@x.com", org: "org-a" },
      { email: "here@x.com", org: "org-b" },
    ]);
    expect(out.map((r: any) => r.state)).toEqual(["present", "imported"]);
  });
});

describe("importAccount", () => {
  const bundle = () => wrapShare(envelope([acct("2", "a@x.com", "org-a"), acct("3", "b@x.com", "org-b")]));

  it("refuses a blob that is not a share before anything is spawned", async () => {
    expect(await importAccount("hello")).toEqual({ ok: false, reason: "not_a_share" });
    expect(await importAccount(wrapShare("{}", Date.now() - 60_000, 0))).toEqual({ ok: false, reason: "expired" });
    expect(cli.interactive).toBe(null);
  });

  it("never passes --force for a plain paste, however the request asks", async () => {
    // The whole bundle plus --force would rewrite every matching credential on
    // this machine. The flag is meaningless without an account to aim it at.
    await importAccount(bundle(), { force: true });
    expect(cli.interactive?.args).toEqual(["import", "-"]);
  });

  it("forces exactly the one account named, and sends only that account", async () => {
    writeStore({ "2": { email: "a@x.com", organizationUuid: "org-a" } });
    cli.interactiveReply = {
      ok: true, code: 0, killed: false, timedOut: false, stdout: "",
      stderr: "Overwrote a@x.com (slot 2)",
    };
    const out = await importAccount(bundle(), { force: true, only: { email: "a@x.com", org: "org-a" } });

    expect(cli.interactive?.args).toEqual(["import", "-", "--force"]);
    const sent = JSON.parse(cli.interactive!.stdin);
    expect(sent.accounts.map((a: any) => a.email)).toEqual(["a@x.com"]);
    expect(out.results).toEqual([{ email: "a@x.com", org: "org-a", num: "2", state: "updated" }]);
  });

  it("reports every account in the bundle, not just a total", async () => {
    // One already here, one arriving. "3 of 5 imported, 2 already here" is the
    // sentence somebody needs before they trust the deck and close the tab; a
    // bare "done" is what makes people run an import twice and then wonder
    // whether they doubled something.
    writeStore({ "2": { email: "a@x.com", organizationUuid: "org-a" } });
    cli.duringImport = () => writeStore({
      "2": { email: "a@x.com", organizationUuid: "org-a" },
      "3": { email: "b@x.com", organizationUuid: "org-b" },
    });
    cli.interactiveReply = {
      ok: true, code: 0, killed: false, timedOut: false, stdout: "",
      stderr: "Skipped a@x.com (already exists, use --force)\nImported b@x.com to slot 3",
    };
    const out = await importAccount(bundle());

    expect(out.ok).toBe(true);
    expect(out.results).toEqual([
      { email: "a@x.com", org: "org-a", num: "2", state: "present" },
      { email: "b@x.com", org: "org-b", num: "3", state: "imported" },
    ]);
    expect(out.added).toBe(true);
  });

  it("still says what arrived when the envelope itself cannot be read", async () => {
    // cswap is the one entitled to refuse a malformed payload. If it took it,
    // the naming is all that was lost - so the store's new slots answer instead
    // of the dialog claiming nothing happened.
    cli.duringImport = () => writeStore({ "7": { email: "late@x.com", organizationUuid: "org-c" } });
    const out = await importAccount(wrapShare("not json at all"));
    expect(out.results).toEqual([{ email: "late@x.com", org: "org-c", num: "7", state: "imported" }]);
  });

  it("reports the refusal rather than a store diff when the import fails", async () => {
    cli.interactiveReply = {
      ok: false, code: 1, killed: false, timedOut: false, stdout: "",
      stderr: "Error: unsupported export version",
    };
    const out = await importAccount(bundle());
    expect(out).toMatchObject({ ok: false, reason: "import_failed", detail: "unsupported export version" });
  });
});
