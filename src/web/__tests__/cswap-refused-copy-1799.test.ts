// #1799: a claude-swap the deck refused at install went on being driven.
//
// installAndConfirm refuses a copy whose version is not the one it asked for —
// "refused v9.9.9 — asked for 0.26.0, not driving it" — and that refusal lived
// only in the value it returned. cswapBin memoized the same copy the moment it
// answered `--version`, so the Accounts panel's first poll reported
// `no_accounts` with version 9.9.9 (and its Add account would run `cswap add`
// with it), `/api/cswap-auto` spawned `cswap config` with it, and on the next
// launch ensureCswap's existing-install branch — which accepts any version,
// because a copy the user installed themselves is left alone — reported it as
// "accounts panel enabled" and the boot seeded it with `cswap add`.
//
// Nothing here runs a real tool or touches a real store. `run` is a table that
// records every argv; the install is answered, never executed; PyPI is a
// stubbed `fetch`; uv is never bootstrapped; and HOME, USERPROFILE,
// CLAUDE_CONFIG_DIR, XDG_DATA_HOME, XDG_BIN_HOME, UV_TOOL_DIR, PIPX_HOME and
// CLAUDE_SWAP_BACKUP all point into a temp directory before any module under
// test is imported, so the refusal record, the seed marker and the store are
// written there and nowhere else.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AccountsEmptyState from "../components/AccountsEmptyState";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-1799-refused-"));
const ENV_KEYS = [
  "HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME", "XDG_BIN_HOME", "UV_TOOL_DIR",
  "PIPX_HOME", "CLAUDE_SWAP_BACKUP", "AGENTS_DECK_CSWAP", "AGENTS_DECK_NO_INSTALL",
] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, ".claude");
process.env.XDG_DATA_HOME = join(DIR, ".local", "share");
process.env.XDG_BIN_HOME = join(DIR, ".local", "bin");
process.env.UV_TOOL_DIR = join(DIR, "uv-tools");
process.env.PIPX_HOME = join(DIR, "pipx");
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "cswap-store");
delete process.env.AGENTS_DECK_CSWAP;
delete process.env.AGENTS_DECK_NO_INSTALL;

const inside = (p: string) => resolve(p).startsWith(resolve(DIR));
for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME", "CLAUDE_SWAP_BACKUP"] as const) {
  if (!inside(process.env[k]!)) throw new Error(`sandbox escaped: ${k}=${process.env[k]}`);
}
if (!inside(homedir())) throw new Error(`sandbox escaped: homedir ${homedir()}`);

// `has` is the claude-swap on the machine (null: none); `lands` is what an
// install leaves behind. The case under test is the one where that differs
// from what the deck asked PyPI for.
const { calls, machine } = vi.hoisted(() => ({
  calls: [] as string[][],
  machine: { has: null as string | null, lands: "9.9.9" },
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const answer = (ok: boolean, stdout = "", stderr = "") =>
    ({ ok, code: ok ? 0 : "ENOENT", killed: false, timedOut: false, stdout, stderr });
  const run = async (cmd: string, args: string[] = []) => {
    calls.push([cmd, ...args]);
    if (/cswap/.test(cmd)) {
      if (!machine.has) return answer(false);
      if (args[0] === "--version") return answer(true, `claude-swap ${machine.has}`);
      return answer(true, "");
    }
    if (cmd === "uv" && args[0] === "--version") return answer(true, "uv 0.12.0");
    if (cmd === "uv" && args[0] === "tool" && args[1] === "install") {
      machine.has = machine.lands;
      return answer(true);
    }
    // safePythons and anything else: nothing else on this machine answers.
    return answer(false);
  };
  return {
    ...real,
    run,
    runDetached: (cmd: string, args: string[] = []) => { calls.push([cmd, ...args]); },
    runInteractive: (cmd: string, args: string[] = []) => {
      calls.push([cmd, ...args]);
      return { write() {}, kill() {}, onLine() {}, done: Promise.resolve(answer(false)) };
    },
  };
});

vi.mock("../../server/uv-bootstrap.mjs", () => ({
  existingBootstrappedUv: () => null,
  bootstrapUv: async () => ({ ok: false, reason: "test" }),
}));

// PyPI offers 0.26.0, so the install names `claude-swap==0.26.0`.
vi.stubGlobal("fetch", async () => ({
  ok: true,
  json: async () => ({ info: { version: "0.26.0" }, releases: { "0.25.0": [{ yanked: false }], "0.26.0": [{ yanked: false }] } }),
}));

type Modules = {
  ensureCswap: () => Promise<Record<string, unknown>>;
  resetCswapBin: () => void;
  fetchClaudeAccounts: (o?: { force?: boolean }) => Promise<Record<string, unknown>>;
  seedFirstAccount: () => Promise<Record<string, unknown>>;
  readCswapConfig: () => Promise<unknown>;
};

/** A fresh process: every module re-evaluated, only what is on disk carried over. */
async function fresh(): Promise<Modules> {
  vi.resetModules();
  const install = await import("../../server/cswap-install.mjs");
  const accounts = await import("../../server/claude-accounts.mjs");
  const readers = await import("../../server/cswap-auto-readers.mjs");
  return { ...install, ...accounts, ...readers } as unknown as Modules;
}

/** Every argv that would have run a claude-swap. */
const cswapRuns = () => calls.filter(c => /cswap/.test(c[0]));

beforeEach(() => {
  calls.length = 0;
  machine.has = null;
  machine.lands = "9.9.9";
  delete process.env.AGENTS_DECK_CSWAP;
  rmTempDir(join(DIR, ".agents-deck"));
  rmTempDir(join(DIR, "cswap-store"));
  mkdirSync(join(DIR, "cswap-store"), { recursive: true });
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
  vi.unstubAllGlobals();
  rmTempDir(DIR);
});

const REFUSED = { state: "unavailable", reason: "unexpected_version", version: "9.9.9" };

describe("a claude-swap the deck refused at install", () => {
  it("is not driven by the Accounts panel, the auto-switch settings read or the seed", async () => {
    const m = await fresh();
    expect(await m.ensureCswap()).toMatchObject(REFUSED);

    calls.length = 0;
    const roster = await m.fetchClaudeAccounts({ force: true });
    expect(roster.reason, "the panel was told the refused copy is installed and empty").not.toBe("no_accounts");
    expect(roster.ok).toBe(false);
    expect(roster).toMatchObject({ reason: "cswap_refused", version: "9.9.9" });

    expect(await m.readCswapConfig()).toBeNull();
    expect(await m.seedFirstAccount()).not.toMatchObject({ state: "added" });
    expect(cswapRuns(), "the refused copy was run after the deck refused it").toEqual([]);
  });

  it("is still refused on the next launch, without being installed again or seeded", async () => {
    const first = await fresh();
    expect(await first.ensureCswap()).toMatchObject(REFUSED);

    // The issue's own step: the memo dropped, the same 9.9.9 still on disk.
    first.resetCswapBin();
    expect(await first.ensureCswap()).toMatchObject(REFUSED);

    // And a whole new process, which has only the disk to go on.
    const next = await fresh();
    calls.length = 0;
    const boot = await next.ensureCswap();
    expect(boot, "the next launch reported the refused copy as usable").toMatchObject(REFUSED);
    expect(calls.some(c => c.includes("install")), "the next launch installed again").toBe(false);
    expect(await next.fetchClaudeAccounts({ force: true })).toMatchObject({ reason: "cswap_refused" });
    expect(await next.seedFirstAccount()).not.toMatchObject({ state: "added" });
    // One `--version` is how the next launch knows the copy is the same one; it
    // is never handed anything else.
    expect(cswapRuns().filter(c => c[1] !== "--version")).toEqual([]);
    expect(existsSync(join(DIR, ".agents-deck", ".cswap-seeded")), "the seed burned its one attempt").toBe(false);
  });

  it("is left alone again once a different version is what answers", async () => {
    const first = await fresh();
    expect(await first.ensureCswap()).toMatchObject(REFUSED);

    // The user installs the version the deck asked for, themselves.
    machine.has = "0.26.0";
    const next = await fresh();
    expect(await next.ensureCswap()).toMatchObject({ state: "present", version: "0.26.0" });
    expect(await next.fetchClaudeAccounts({ force: true })).toMatchObject({ reason: "no_accounts", version: "0.26.0" });
  });

  it("is driven when AGENTS_DECK_CSWAP names it, because that is the user choosing it", async () => {
    const first = await fresh();
    expect(await first.ensureCswap()).toMatchObject(REFUSED);

    process.env.AGENTS_DECK_CSWAP = join(DIR, "their-cswap");
    const next = await fresh();
    expect(await next.ensureCswap()).toMatchObject({ state: "present", version: "9.9.9" });
    expect(await next.fetchClaudeAccounts({ force: true })).toMatchObject({ reason: "no_accounts" });
  });
});

describe("what the Accounts panel says for a refused copy", () => {
  it("names the refusal instead of calling the store unreadable", () => {
    const html = renderToStaticMarkup(createElement(AccountsEmptyState, {
      data: { reason: "cswap_refused", version: "9.9.9", want: "0.26.0" },
    }));
    expect(html).toContain("not the version the deck asked for");
    expect(html).toContain("v9.9.9 answered where 0.26.0 was asked for");
    expect(html).toContain("AGENTS_DECK_CSWAP");
    expect(html).not.toContain("Couldn&#x27;t read the account store");
  });
});
