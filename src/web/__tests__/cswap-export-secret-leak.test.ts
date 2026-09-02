// `cswap export`'s stdout IS the credential, and it could become the accounts
// panel's error message.
//
// The chain: shareAccount's guard is `if (!r.ok || !r.stdout.trim())` — it knows
// stdout may hold the payload — and then called `failureText(r, "cswap export")`,
// which builds its text from `${stderr}\n${stdout}` and hands it to
// `firstUseful`, which deliberately takes the LAST non-empty line. stdout is
// concatenated second, so any stdout at all outranks the real error. From there
// `detail` goes to explainFailure, which ranks `detail` first, and onto the
// panel.
//
// claude-swap writes diagnostics to stderr specifically so stdout stays pure
// JSON in pipe mode, and it writes the envelope as its last act — so a non-zero
// exit after a partial write puts the tail of an indented `json.dumps` on
// screen, and one of those lines is the refresh token on its own.
//
// The fix is to build the sentence from stderr alone for this one command.
// These pin that, and pin that the failure is still explained rather than
// blanked.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Names the binary outright so cswapBin does not go looking for one — otherwise
// its `cswap --version` probe is the first thing the recorder below sees, and it
// would be answered with whatever this file staged for the export.
const prevBin = process.env.AGENTS_DECK_CSWAP;
process.env.AGENTS_DECK_CSWAP = "cswap-under-test";
afterAll(() => {
  if (prevBin === undefined) delete process.env.AGENTS_DECK_CSWAP;
  else process.env.AGENTS_DECK_CSWAP = prevBin;
});

// A recorded answer for the next `run`, so nothing here executes cswap. Only
// `run` is replaced: everything else in exec.mjs — looksMissing above all, which
// failureText consults — stays real, because the point is what the real
// composition does with a hostile result.
const { nextRun, calls } = vi.hoisted(() => ({
  nextRun: { value: null as unknown },
  calls: [] as { cmd: string; args: string[] }[],
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    run: (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return Promise.resolve(nextRun.value);
    },
  };
});

// @ts-expect-error — plain JS module, no types
const { shareAccount } = await import("../../server/cswap-admin.mjs");

// One line of a truncated `json.dumps(envelope, indent=2)`: the refresh token,
// alone, exactly as it would sit in the middle of the document.
const SECRET_LINE = '  "refreshToken": "sk-ant-ort01-DEADBEEFdeadbeef-not-a-real-token",';

/** What `cswap export - --account N` writes, with the credential left out. */
const ENVELOPE = JSON.stringify({
  version: 3,
  exportedAt: "2026-09-02T00:00:00Z",
  exportedFrom: "macos",
  swapVersion: "0.25.0",
  encrypted: false,
  activeAccountNumber: 2,
  accounts: [{ number: "2", email: "one@example.com", organizationUuid: "org-a", config: {}, credentials: {} }],
});

beforeEach(() => { calls.length = 0; });

describe("shareAccount when the export fails after writing", () => {
  it("says nothing that came out of stdout", async () => {
    nextRun.value = { ok: false, code: 1, killed: false, timedOut: false, stdout: SECRET_LINE, stderr: "" };
    const out = await shareAccount(1);

    expect(out.ok).toBe(false);
    expect(out.reason).toBe("export_failed");
    // Not "does not equal": no SUBSTRING of the secret line may appear. A
    // 300-character slice of it would still be the token.
    expect(out.detail).not.toContain("refreshToken");
    expect(out.detail).not.toContain("sk-ant-ort01");
    expect(JSON.stringify(out)).not.toContain("sk-ant-ort01");
  });

  it("still explains the failure, from the stream that was written for a reader", async () => {
    nextRun.value = {
      ok: false, code: 1, killed: false, timedOut: false,
      stdout: SECRET_LINE,
      stderr: "Error: account 1 has no stored credentials",
    };
    const out = await shareAccount(1);
    expect(out.detail).toBe("account 1 has no stored credentials");
    expect(out.detail).not.toContain("sk-ant-ort01");
  });

  it("keeps the two messages that do not come from a stream at all", async () => {
    // The missing-tool sentence keys off `run`'s own code, so dropping stdout
    // cannot cost it — and it is the only message in the panel that names a fix.
    nextRun.value = { ok: false, code: "ENOENT", killed: false, timedOut: false, stdout: SECRET_LINE, stderr: "" };
    expect((await shareAccount(1)).detail).toMatch(/AGENTS_DECK_CSWAP/);

    // A run its deadline stopped has no last line worth quoting, and the tail it
    // did capture is the same secret.
    nextRun.value = { ok: false, code: "ETIMEDOUT", killed: true, timedOut: true, stdout: SECRET_LINE, stderr: "" };
    const out = await shareAccount(1);
    expect(out.detail).toBe("cswap export took too long and was stopped");
    expect(out.detail).not.toContain("refreshToken");
  });

  it("does not run cswap at all for an account number that is not one", async () => {
    for (const bad of [0, 1000, -1, 1.5, "x", null]) {
      expect(await shareAccount(bad)).toEqual({ ok: false, reason: "bad_account" });
    }
    expect(calls).toHaveLength(0);
  });

  it("hands the blob back when the export works, which is the case all this protects", async () => {
    // A real envelope rather than a token JSON object: since #723 the share
    // path folds what cswap wrote into one bundle, so it parses this and would
    // refuse a stand-in that has no `accounts` array. The fixture is the shape
    // `export_accounts` actually writes, minus the credential body.
    nextRun.value = { ok: true, code: 0, killed: false, timedOut: false, stdout: ENVELOPE, stderr: "" };
    const out = await shareAccount(2);
    expect(out.ok).toBe(true);
    expect(out.blob.startsWith("ccdeck1:")).toBe(true);
    expect(calls[0]).toEqual({ cmd: "cswap-under-test", args: ["export", "-", "--account", "2"] });
    // What went in came out: one account, named, under the envelope cswap's
    // own version stamp rather than one this repo invented.
    expect(out.shared).toEqual([{ num: "2", email: "one@example.com" }]);
    expect(out.failed).toEqual([]);
    const body = JSON.parse(Buffer.from(out.blob.slice("ccdeck1:".length), "base64").toString("utf8"));
    expect(JSON.parse(body.payload)).toMatchObject({ version: 3, accounts: [{ email: "one@example.com" }] });
  });
});
