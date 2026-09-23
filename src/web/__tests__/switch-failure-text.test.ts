// A switch that failed printed cswap's stderr into the accounts panel. The
// panel preferred `output` — 500 characters of whichever of the child's streams
// was not empty — so the 288px column at 10px got a Click usage block, a Python
// traceback, or, on Windows, cmd.exe's "'cswap' is not recognized as an
// internal or external command,/operable program or batch file." The only thing
// behind that preference was the reason code, and the codes are `no_cswap`,
// `timeout`, `switch_failed` and `bad_account` — none of which is a sentence
// either. /api/cswap-auto answers in the same shape under the name `detail`.
//
// These pin the ranking that keeps the child's bytes out of the box: the map
// speaks, and the raw text comes back separately for the title. The keychain
// case is the exception that makes hiding the rest safe — it is the one remedy
// that only ever arrived inside the raw output, and a deck started as a
// background service on macOS hits it on every credential move.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMAND_REASONS, GATE_REASONS, commandOutput, explainCommandFailure, explainFailure } from "../admin-failure";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// Real shapes, taken from what each platform actually puts on stderr.
const TRACEBACK = [
  "Traceback (most recent call last):",
  '  File "/opt/homebrew/lib/python3.12/site-packages/claude_swap/cli.py", line 214, in switch',
  "    store.activate(num)",
  "FileNotFoundError: [Errno 2] No such file or directory: '/Users/x/.claude/.credentials.json'",
].join("\n");
const CMD_SHIM = "'cswap' is not recognized as an internal or external command,\r\noperable program or batch file.";
const USAGE = "Usage: cswap switch [OPTIONS] ACCOUNT\nTry 'cswap switch --help' for help.";
const KEYCHAIN = "cswap: the login keychain is unreadable right now (SecKeychainFindGenericPassword: -25308)";

describe("what the accounts panel says when a switch fails", () => {
  it("says claude-swap refused the switch instead of showing its traceback", () => {
    const said = explainCommandFailure({ reason: "switch_failed", output: TRACEBACK }, "the switch failed");
    expect(said).toBe(COMMAND_REASONS.switch_failed);
    expect(said).not.toMatch(/Traceback|FileNotFoundError|credentials\.json/);
  });

  it("says the same for a usage block, which is what a rejected argument prints", () => {
    expect(explainCommandFailure({ reason: "switch_failed", output: USAGE }, "the switch failed"))
      .toBe(COMMAND_REASONS.switch_failed);
  });

  it("names PATH and AGENTS_DECK_CSWAP rather than repeating cmd.exe's two lines", () => {
    // exec.mjs reads a batch shim cmd.exe could not find as ENOENT, so Windows
    // arrives here as no_cswap carrying the shell's words as its output.
    const said = explainCommandFailure({ reason: "no_cswap", output: CMD_SHIM }, "the switch failed");
    expect(said).toBe(COMMAND_REASONS.no_cswap);
    expect(said).toMatch(/AGENTS_DECK_CSWAP/);
    expect(said).not.toMatch(/operable program|is not recognized/);
  });

  it("blames the deadline for a timeout, not the tail the killed child left behind", () => {
    const said = explainCommandFailure({ reason: "timeout", output: "reading account 2…" }, "the switch failed");
    expect(said).toBe(COMMAND_REASONS.timeout);
    expect(said).toMatch(/too long/);
  });

  it("keeps the keychain remedy, the one thing the raw output was carrying", () => {
    const said = explainCommandFailure({ reason: "switch_failed", output: KEYCHAIN }, "the switch failed");
    expect(said).toMatch(/Terminal window/);
    expect(said).toMatch(/keychain/);
    expect(said).not.toBe(COMMAND_REASONS.switch_failed);
  });

  it("does not offer that remedy for a tool that never ran, whose output is the shell's", () => {
    // Hypothetically: a shell reporting a path under a keychain-ish directory
    // must not turn "not installed" into advice about Terminal windows.
    expect(explainCommandFailure({ reason: "no_cswap", output: "C:\\keychain\\cswap.cmd not found" }, "x"))
      .toBe(COMMAND_REASONS.no_cswap);
  });

  it("still names a reason this build has no sentence for, but never the output", () => {
    expect(explainCommandFailure({ reason: "store_locked", output: TRACEBACK }, "the switch failed"))
      .toBe("store_locked");
  });

  it("falls back when the reply carried neither a reason nor anything else", () => {
    expect(explainCommandFailure(null, "the switch failed")).toBe("the switch failed");
    expect(explainCommandFailure({}, "the switch failed")).toBe("the switch failed");
    expect(explainCommandFailure({ output: TRACEBACK }, "the switch failed")).toBe("the switch failed");
  });
});

// The deck turns a mutation away before any command runs when the page asking
// is not the page it served — a reverse proxy, a tunnel, or a dev server
// forwarding /api at another port all produce exactly that. The refusal carries
// `{error}` and no `reason`, so it ranked as the fallback and reached the panel
// as `command failed`: the one thing that had not happened.
describe("a refusal from the deck's own gate, which is not a command failing", () => {
  const blocked = { error: "cross-site request blocked" };

  it("names what actually happened, on both routes", () => {
    expect(explainCommandFailure(blocked, "command failed", 403)).toBe(GATE_REASONS[403]);
    expect(explainFailure(blocked, "command failed", 403)).toBe(GATE_REASONS[403]);
    expect(explainCommandFailure({ error: "unauthenticated" }, "command failed", 401)).toBe(GATE_REASONS[401]);
  });

  it("says nothing was changed, because nothing was", () => {
    // A reader who has just been told `command failed` has no way to know
    // whether the setting took. Both sentences settle it.
    for (const said of Object.values(GATE_REASONS)) {
      expect(said).toMatch(/nothing was changed|refused/);
      expect(said).not.toMatch(/claude-swap|command/);
    }
  });

  it("outranks everything the body could carry, because it happened first", () => {
    const withReason = { reason: "set_failed", detail: "Error: …" };
    expect(explainCommandFailure(withReason, "command failed", 403)).toBe(GATE_REASONS[403]);
    // And a status the gate has no sentence for changes nothing: 400 is the
    // route answering, not the gate refusing.
    expect(explainCommandFailure(withReason, "command failed", 400)).toBe(COMMAND_REASONS.set_failed);
    expect(explainCommandFailure(withReason, "command failed")).toBe(COMMAND_REASONS.set_failed);
  });

  it("is read off the response, not guessed from the body", () => {
    const panel = read("../components/AccountsPanel.tsx");
    expect(panel).toMatch(/explainCommandFailure\(out, "command failed", res\.status\)/);
    expect(panel).toMatch(/explainFailure\(out, "command failed", res\.status\)/);
  });

  it("is a gate the dev server no longer trips, so writes work while developing", () => {
    // Reads worked through the proxy and writes did not, which is the worst
    // shape a dev server can have: the panel fills with real accounts and every
    // press comes back refused.
    const cfg = read("../../../vite.config.ts");
    expect(cfg).toMatch(/changeOrigin: true/);
    expect(cfg).toMatch(/req\.setHeader\("origin", "http:\/\/127\.0\.0\.1:4317"\)/);
  });
});

describe("the auto-switch route, which answers in the same shape under another name", () => {
  it("translates a refused setting instead of printing cswap's stderr", () => {
    const said = explainCommandFailure(
      { reason: "set_failed", detail: "Error: invalid literal for int() with base 10: '90%'" },
      "command failed",
    );
    expect(said).toBe(COMMAND_REASONS.set_failed);
  });

  it("says which account claude-swap rejected holding out of rotation", () => {
    expect(explainCommandFailure({ reason: "bad_account" }, "command failed")).toBe(COMMAND_REASONS.bad_account);
    expect(explainCommandFailure({ reason: "command_failed", detail: TRACEBACK }, "command failed"))
      .toBe(COMMAND_REASONS.command_failed);
  });

  it("has a sentence for every reason the two routes can answer with", () => {
    // claude-accounts.mjs switchClaudeAccount, and cswap-auto.mjs
    // setCswapConfig + setAccountEnabled. A code added there without one here
    // reaches the panel as itself.
    for (const reason of [
      "bad_account", "no_cswap", "timeout", "switch_failed",
      "unknown_setting", "out_of_range", "bad_value", "set_failed", "command_failed",
    ]) {
      expect(COMMAND_REASONS[reason], reason).toBeTruthy();
    }
  });
});

describe("the raw output the panel hangs on the title", () => {
  it("hands back whichever field the route used for it", () => {
    expect(commandOutput({ reason: "switch_failed", output: TRACEBACK })).toBe(TRACEBACK);
    expect(commandOutput({ reason: "set_failed", detail: "  boom  " })).toBe("boom");
  });

  it("is empty when there is nothing to show, so no empty tooltip is attached", () => {
    expect(commandOutput({ reason: "bad_account" })).toBe("");
    expect(commandOutput(null)).toBe("");
    expect(commandOutput({ reason: "timeout", output: "   " })).toBe("");
  });
});
