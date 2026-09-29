// What the accounts panel is told while the deck is installing claude-swap.
//
// On a first run the install happens behind a deck that is already serving:
// reportStartup stops waiting the moment ensureCswap commits to it, and the
// panel's first polls land while uv is still building the environment. The
// roster read saw only that `cswap` would not answer and replied `no_cswap`,
// with installHint's command — so the panel said "claude-swap isn't installed"
// and told the person to install it by hand, over a tool that was a minute from
// arriving by itself. Measured on a fresh home with the install held at 75s:
// seven consecutive polls said `no_cswap`, then `ok` with no restart.
//
// exec.mjs's `run` is a script here and the install blocks on a promise the
// test releases, so "during" is a place the test can stand rather than a race
// against a clock. PyPI is stubbed to not answer, which is the range-spec path.
// The store is an empty temp CLAUDE_SWAP_BACKUP. Every case gets fresh modules,
// since the install flag, the binary memo and the roster cache are all module
// state — and claude-accounts.mjs and cswap-install.mjs are imported inside the
// same reset, so they share the one instance the server has.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-installing-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_SWAP_BACKUP", "AGENTS_DECK_CSWAP", "AGENTS_DECK_NO_INSTALL"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "cswap");
delete process.env.AGENTS_DECK_CSWAP;
delete process.env.AGENTS_DECK_NO_INSTALL;

const inside = (p: string) => resolve(p).startsWith(resolve(DIR));
for (const k of ["HOME", "USERPROFILE", "CLAUDE_SWAP_BACKUP"] as const) {
  if (!inside(process.env[k]!)) throw new Error(`sandbox escaped: ${k}=${process.env[k]}`);
}
if (!inside(homedir())) throw new Error(`sandbox escaped: homedir ${homedir()}`);

// `installed` is whether `cswap --version` answers; `release` is what the
// install command waits on; `succeeds` is how it exits once released.
const { tool } = vi.hoisted(() => ({
  tool: {
    installed: false,
    succeeds: true,
    release: Promise.resolve() as Promise<void>,
  },
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const answer = (ok: boolean, stdout = "", stderr = "") =>
    ({ ok, code: ok ? 0 : "ENOENT", killed: false, timedOut: false, stdout, stderr });
  return {
    ...real,
    run: async (cmd: string, args: string[] = []) => {
      if (args[0] === "--version") {
        if (cmd === "uv") return answer(true, "uv 0.12.0");
        if (/cswap/.test(cmd) && tool.installed) return answer(true, "claude-swap 0.26.0");
        return answer(false);
      }
      if (cmd === "uv" && args[0] === "tool" && args[1] === "install") {
        await tool.release;
        tool.installed = tool.succeeds;
        return tool.succeeds ? answer(true) : answer(false, "", "error: resolution failed");
      }
      // installHint's interpreter check, and anything else: a machine where
      // things run.
      return answer(true);
    },
    runDetached: () => {},
  };
});

vi.stubGlobal("fetch", async () => ({ ok: false, json: async () => ({}) }));

type Roster = { ok: boolean; reason?: string; hint?: string };
type Modules = {
  fetchClaudeAccounts: () => Promise<Roster>;
  invalidateClaudeAccountsCache: () => void;
  ensureCswap: (o?: { onInstalling?: () => void }) => Promise<{ state: string }>;
  cswapInstalling: () => boolean;
};

async function fresh(): Promise<Modules> {
  vi.resetModules();
  const accounts = await import("../../server/claude-accounts.mjs");
  const install = await import("../../server/cswap-install.mjs");
  return { ...accounts, ...install } as unknown as Modules;
}

/** A read that is real work, the way the panel's next poll after an install is. */
async function reread(m: Modules) {
  m.invalidateClaudeAccountsCache();
  return m.fetchClaudeAccounts();
}

beforeEach(() => {
  tool.installed = false;
  tool.succeeds = true;
  tool.release = Promise.resolve();
  rmTempDir(join(DIR, "cswap"));
  mkdirSync(join(DIR, "cswap"), { recursive: true });
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
  vi.unstubAllGlobals();
  rmTempDir(DIR);
});

describe("the roster while the deck installs claude-swap", () => {
  it("says it is installing, with no command to type, until the install has landed", async () => {
    const m = await fresh();
    let release!: () => void;
    tool.release = new Promise(r => { release = r; });
    let announced = false;

    const job = m.ensureCswap({ onInstalling: () => { announced = true; } });
    await vi.waitFor(() => expect(announced).toBe(true));
    expect(m.cswapInstalling()).toBe(true);

    const during = await reread(m);
    expect(during).toMatchObject({ ok: false, reason: "cswap_installing" });
    expect(during.hint).toBeUndefined();

    release();
    expect((await job).state).toBe("installed");
    expect(m.cswapInstalling()).toBe(false);

    // Installed, nothing added yet: the panel's next poll moves on by itself.
    expect(await reread(m)).toMatchObject({ ok: false, reason: "no_accounts" });
  });

  it("goes back to no_cswap, command and all, when the install fails", async () => {
    const m = await fresh();
    tool.succeeds = false;

    expect((await m.ensureCswap()).state).toBe("unavailable");
    expect(m.cswapInstalling()).toBe(false);

    // Now nothing is coming, so the hand-typed command is the right answer.
    const after = await reread(m);
    expect(after).toMatchObject({ ok: false, reason: "no_cswap" });
    expect(after.hint).toBeTruthy();
  });

  it("never says installing on a machine that already has it", async () => {
    const m = await fresh();
    tool.installed = true;

    expect((await m.ensureCswap()).state).toBe("present");
    expect(m.cswapInstalling()).toBe(false);
    expect(await reread(m)).toMatchObject({ ok: false, reason: "no_accounts" });
  });
});
