// Three command strings were built out of environment paths with only `"` around
// them, and POSIX double quotes suppress none of `$(…)`, a backtick or `\`.
//
//   installer.mjs   `"<node>" "<hookPath>" --provider claude` — written into the
//                   user's settings.json as a type:"command" hook, which Claude
//                   Code runs THROUGH A SHELL on every tool call.
//   sound-hook.mjs  `"<node>" "<notifyPath>"` — the same, at the end of a turn.
//   quota.mjs       `"<bin>" --print /usage < /dev/null` — straight into exec().
//
// Every ingredient comes from outside: $CLAUDE_CONFIG_DIR (resolve()d, never
// validated), homedir(), process.execPath, %APPDATA%. A config directory called
// `/tmp/a$(id)b` therefore became shell code — and for the two hook commands,
// shell code PERSISTED into the user's settings file and executed on every hook
// fire. The quieter half cost only the feature: a bare `$` expands to nothing,
// so the hook path silently became wrong and hooks stopped firing with no error.
//
// quota.mjs stopped building a string at all (see quota-source.test.ts —
// quotaClaudeBin answers with the binary and exec.mjs spawns the vector). The
// two hook commands cannot: the settings.json format is a string and has no argv
// form, so they are escaped with a real escaper instead. These pin that escaper
// against a real /bin/sh, which is the only authority worth citing.
//
// ── the Windows half, #624 ───────────────────────────────────────────────────
//
// That was true of one half of the escaper. The other half — the one that runs
// on the platform this repo's hook bugs actually come from — was asserted
// against four literals somebody typed, and a literal is the escaper's own
// output written down a second time: it confirms the rule is self-consistent
// and confirms nothing about cmd.exe. Doubling a `"` is an MSVCRT convention,
// not a cmd.exe one; whether a produced line survives depends on the parser on
// the OTHER end, and no literal can answer that.
//
// So the same corpus treatment is applied below, with one deliberate difference
// in how it is put on the matrix. `throughCmd` (windows-command-line.ts) runs
// the produced line through a real `cmd.exe /d /s /c` on the Windows leg and
// reads back what the child RECEIVED as its arguments; on Linux and macOS it
// answers from a model of the two documented parsers instead.
//
// NOTHING IS GATED. The obvious spelling was `runIf(!posix)`, and it is the one
// shape skip-gate-inventory.test.ts bans — a case visible on exactly one runner
// — and it would have cost the register its zero-skip expectation for Linux and
// macOS, which is the strongest claim publish.yml makes anywhere. The assertion
// is therefore the same on all three legs and only its AUTHORITY differs, one
// case below pins which authority each leg was supposed to use, and every case
// compares the model against the real answer on Windows — so the model the
// other two legs lean on is itself checked by execution once per CI run.
//
// It found a defect on the first run, which is the reason for executing a rule
// rather than restating it. `"` + arg + `"` left a trailing backslash in front
// of the closing quote, and the child's parser reads `\"` as an escaped quote:
// `C:\Program Files\nodejs\` never closed its quoted region and swallowed
// `--provider claude` into the path. See shellQuoteArg in src/server/exec.mjs.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { parseWindowsArgv, throughCmd } from "./windows-command-line";
// @ts-expect-error — plain JS module, no types
import { shellQuoteArg } from "../../server/exec.mjs";
// @ts-expect-error — plain JS module, no types
import { hookCommand } from "../../server/installer.mjs";
// @ts-expect-error — plain JS module, no types
import { soundHookCommand } from "../../server/sound-hook.mjs";

// Paths a real machine can have. The first two are the attack, the rest are the
// ordinary characters that a naive escaper breaks instead.
const NASTY = [
  "/home/a$(id)b/.claude/agent-dag/hook.js",
  "/home/a`id`b/.claude/agent-dag/hook.js",
  "/home/$USER/.claude/agent-dag/hook.js",
  "/home/it's mine/.claude/agent-dag/hook.js",
  '/home/say "hi"/.claude/agent-dag/hook.js',
  "/home/a\\b/.claude/agent-dag/hook.js",
  "/home/a b;rm -rf x/.claude/agent-dag/hook.js",
  "/home/a&b|c>d/.claude/agent-dag/hook.js",
  "/home/a\nb/.claude/agent-dag/hook.js",
  "/home/plain/.claude/agent-dag/hook.js",
];

// The Windows corpus. Not a translation of the one above — the characters that
// are dangerous there are different ones, and two of them are dangerous to a
// DIFFERENT PARSER than the rest.
//
// Not every entry is a legal NTFS name: `|`, `<`, `>` and `"` cannot appear in
// a Windows path component. They are here because `shellQuoteArg` is the
// escaper for every argument viaCmd puts on a Windows command line and not only
// for paths — an alias, a package spec, a `--prefix` — and a rule that is only
// right for the arguments somebody remembered is not a rule.
const WIN_NASTY = [
  "C:\\Users\\John Smith\\.claude\\agent-dag\\hook.js",         // the ordinary one
  "C:\\Users\\a&b\\.claude\\agent-dag\\hook.js",                // `&` IS legal in a name
  "C:\\Users\\a|b>c<d\\.claude\\agent-dag\\hook.js",            // the pipe and redirection family
  "C:\\Users\\a^b\\.claude\\agent-dag\\hook.js",                // cmd.exe's own escape character
  "C:\\Users\\a(b)c\\.claude\\agent-dag\\hook.js",              // grouping, also legal in a name
  "C:\\Users\\a b&del x\\.claude\\agent-dag\\hook.js",          // the attack: a second command
  "C:\\Users\\%CCDECK_624_UNSET%\\.claude\\agent-dag\\hook.js", // a `%` naming nothing survives
  "C:\\Users\\a!b\\.claude\\agent-dag\\hook.js",                // delayed expansion, which is off
  'C:\\Users\\say "hi"\\.claude\\agent-dag\\hook.js',           // the doubling rule itself
  'C:\\Users\\a"b&c\\.claude\\agent-dag\\hook.js',              // an ODD quote, then a metacharacter
  'C:\\Users\\a\\"b\\.claude\\agent-dag\\hook.js',              // a backslash right before a quote
  "C:\\Users\\a\\\\b\\.claude\\agent-dag\\hook.js",             // a doubled separator
  "C:\\Program Files\\nodejs\\",                                // a TRAILING backslash — #624
  "C:\\Users\\Ünïcødé ñ\\.claude\\agent-dag\\hook.js",          // non-ASCII, in CP1252 and CP850
  "C:\\Users\\plain\\.claude\\agent-dag\\hook.js",
];

// The Windows node in the produced command lines. It does not exist on the
// runner, so the round-trip swaps it out for a script that prints its own argv —
// the same substitution the POSIX cases make with `printf`.
const WIN_NODE = "C:\\Program Files\\nodejs\\node.exe";

/** A produced command line with its leading program token taken off, so what is
 *  left is the arguments exactly as the escaper wrote them. Asserted rather than
 *  sliced blind: if the shape of a hook command ever changes, this says so. */
function argumentsOf(cmd: string, node: string): string {
  const head = `${shellQuoteArg(node, "win32")} `;
  expect(cmd.startsWith(head), cmd).toBe(true);
  return cmd.slice(head.length);
}

const posix = process.platform !== "win32";

/** What /bin/sh decides the arguments of `line` are, with `printf` standing in
 *  for the program. The NUL separator is what lets a path with a newline in it
 *  be compared as the single argument it is. */
function shellArgv(line: string): string[] {
  const out = execFileSync("/bin/sh", ["-c", `printf '%s\\0' ${line}`], {
    encoding: "utf8",
    // A stripped environment with one obvious tripwire in it: if `$USER` ever
    // reaches the shell unquoted, the value below is what comes back.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", USER: "SUBSTITUTED" },
  });
  return out.split("\0").slice(0, -1);
}

describe("shellQuoteArg on POSIX", () => {
  it.runIf(posix)("survives a real /bin/sh byte for byte", () => {
    for (const path of NASTY) {
      // `printf %s` writes its argument and nothing else, so what comes back is
      // exactly what the shell decided the argument was. If any of the quoting
      // leaks, this is where the substitution shows up.
      const out = execFileSync("/bin/sh", ["-c", `printf %s ${shellQuoteArg(path, "linux")}`], {
        encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", USER: "SUBSTITUTED" },
      });
      expect(out, path).toBe(path);
    }
  });

  it("leaves nothing live inside the quotes", () => {
    // Single quotes, and the one escape that form has: close, backslash-quote,
    // reopen. Spelled out because it is the whole mechanism.
    expect(shellQuoteArg("plain", "linux")).toBe("'plain'");
    expect(shellQuoteArg("$(id)", "linux")).toBe("'$(id)'");
    expect(shellQuoteArg("it's", "linux")).toBe(`'it'\\''s'`);
    expect(shellQuoteArg("", "linux")).toBe("''");
  });

  it("uses cmd.exe's rule on Windows, the same one viaCmd applies", () => {
    expect(shellQuoteArg("C:\\Program Files\\node.exe", "win32")).toBe('"C:\\Program Files\\node.exe"');
    expect(shellQuoteArg('say "hi"', "win32")).toBe('"say ""hi"""');
    // Everything cmd.exe treats as syntax is inert once quoted…
    expect(shellQuoteArg("a&b|c>d", "win32")).toBe('"a&b|c>d"');
    // …except `%VAR%`, which has no escape on a command line at all. Pinned as
    // a known limit of the platform rather than left as a surprise.
    expect(shellQuoteArg("%USERNAME%", "win32")).toBe('"%USERNAME%"');
    // The four above are the ones that stood here before #624, and all four
    // still hold — the defect was never in what they describe, which is exactly
    // why four literals could not see it. What they were missing is below: a
    // backslash that ends up in front of a quote is doubled, because the
    // CHILD's parser reads `\"` as an escaped quote even though cmd.exe does
    // not, and the closing quote this function adds counts as a quote.
    expect(shellQuoteArg("C:\\Program Files\\nodejs\\", "win32")).toBe('"C:\\Program Files\\nodejs\\\\"');
    expect(shellQuoteArg('a\\"b', "win32")).toBe('"a\\\\""b"');
    // A backslash NOT in front of a quote is left exactly as it is, which is
    // every backslash in every ordinary Windows path.
    expect(shellQuoteArg("C:\\Users\\a\\\\b\\hook.js", "win32")).toBe('"C:\\Users\\a\\\\b\\hook.js"');
  });
});

// ── the rule, executed rather than restated ─────────────────────────────────
//
// The mirror of the `/bin/sh` cases above, and the whole of #624. On Windows
// these run a real `cmd.exe /d /s /c` and read back the child's own argv; on
// Linux and macOS they answer from the model in windows-command-line.ts, which
// implements cmd.exe's quote counting and the UCRT's backslash rule from the
// documentation rather than from the escaper. Nothing here is skipped anywhere,
// which is what keeps the register's zero for Linux and macOS intact.
describe("shellQuoteArg against a real cmd.exe", () => {
  it("says which authority answered, so the real one cannot go quiet", () => {
    // The register's job, done inline. A `runIf(!posix)` case would have been
    // the obvious spelling and it is the one shape skip-gate-inventory.test.ts
    // bans — a case visible on exactly one leg — and it would have cost the
    // zero-skips expectation on Linux and macOS, which is the strongest claim
    // that workflow makes. Instead the case runs everywhere and states out loud
    // what it used: if the Windows leg ever stops reaching a real cmd.exe, this
    // is red there rather than green everywhere.
    const { authority } = throughCmd(shellQuoteArg("plain", "win32"));
    expect(authority).toBe(posix ? "model" : "cmd.exe");
  });

  it("parses the rows Microsoft's own table says it should", () => {
    // The model answers for Linux and macOS, so "the model is right" cannot
    // rest on the Windows leg alone — that leg is where it is checked against
    // reality, and this is where it is checked against a THIRD party on every
    // leg. These five rows are the worked examples in Microsoft's "Parsing C++
    // command-line arguments", which documents the parser node inherits. They
    // were not derived from this repo and they are the reason the backslash
    // rule is spelled the way it is.
    //
    // A dummy program token in front of each, because argv[0] is parsed by
    // different rules than the arguments and is not what is being checked.
    const rows: [string, string[]][] = [
      ['"a b c" d e', ["a b c", "d", "e"]],
      ['"ab\\"c" "\\\\" d', ['ab"c', "\\", "d"]],
      ['a\\\\\\b d"e f"g h', ["a\\\\\\b", "de fg", "h"]],
      ['a\\\\\\"b c d', ['a\\"b', "c", "d"]],
      ['a\\\\\\\\"b c" d e', ["a\\\\b c", "d", "e"]],
    ];
    for (const [line, want] of rows) {
      expect(parseWindowsArgv(`prog ${line}`).slice(1), line).toEqual(want);
    }
  });

  it("hands the child every argument byte for byte, whatever it contains", () => {
    // One line carrying the whole corpus, because the failure this found is
    // contagious: an argument whose quoted region never closes does not merely
    // come back wrong, it eats the arguments after it. Adjacency is the test.
    const trip = throughCmd(WIN_NASTY.map((p) => shellQuoteArg(p, "win32")).join(" "));
    expect(trip.unquoted, `cmd.exe would read these as syntax: ${trip.line}`).toEqual([]);
    expect(trip.argv).toEqual(WIN_NASTY);
    // On Windows this compares the model against reality, which is what earns
    // the model the right to answer on the other two legs. Off Windows the two
    // are the same array and this costs nothing.
    expect(trip.modelArgv).toEqual(trip.argv);
  });

  it("keeps an empty argument, and a lone backslash, an argument", () => {
    // The degenerate ends of the rule. An empty string must stay one argument
    // rather than disappearing, and a bare `\` must not be read as an escape.
    const trip = throughCmd(["", "\\", "\\\\", '"'].map((s) => shellQuoteArg(s, "win32")).join(" "));
    expect(trip.argv).toEqual(["", "\\", "\\\\", '"']);
  });

  it("names the two things a cmd.exe command line has no escape for", () => {
    // Not a gap in the escaper — a limit of the platform, and now an executed
    // fact rather than a sentence. `%VAR%` expands inside quotes; there is no
    // spelling that stops it. It is narrow because it needs the variable to
    // exist, which is why the corpus above can carry `%CCDECK_624_UNSET%` and
    // get it back unharmed.
    const env = { CCDECK_624_TRIPWIRE: "SUBSTITUTED" };
    const percent = throughCmd(shellQuoteArg("C:\\x\\%CCDECK_624_TRIPWIRE%\\hook.js", "win32"), { env });
    expect(percent.argv).toEqual(["C:\\x\\SUBSTITUTED\\hook.js"]);

    // `!VAR!` is the same limit on a machine with delayed expansion turned on.
    // It is off for `cmd /c` by default, which is why the corpus's `a!b` comes
    // back intact — but it is a registry setting, so the deck cannot assume it.
    const bang = "C:\\x\\!CCDECK_624_TRIPWIRE!\\hook.js";
    expect(throughCmd(shellQuoteArg(bang, "win32"), { env }).argv).toEqual([bang]);
    expect(throughCmd(shellQuoteArg(bang, "win32"), { env, delayedExpansion: true }).argv)
      .toEqual(["C:\\x\\SUBSTITUTED\\hook.js"]);
  });
});

describe("the hook command written into settings.json", () => {
  const NODE = "/usr/local/bin/node";

  it.runIf(posix)("is one command with three arguments, whatever the path contains", () => {
    for (const path of NASTY) {
      const cmd = hookCommand(path, "claude", NODE, "linux");
      // Read back through a shell the way the host CLI will read it: `printf
      // '%s\0'` writes one NUL-terminated field per argument, so this is the
      // argv the hook would actually receive. NUL rather than newline because
      // one of the paths below contains a newline, and splitting on that would
      // report the shell's correct answer as a failure.
      const argv = shellArgv(cmd.replace(shellQuoteArg(NODE, "linux"), "printf-args"));
      expect(argv, path).toEqual(["printf-args", path, "--provider", "claude"]);
    }
  });

  it("no longer wraps a path in double quotes and calls it escaped", () => {
    // The platform is named rather than inherited. The two rules are different
    // — POSIX single quotes, cmd.exe doubled double quotes — so a test that let
    // process.platform decide would assert the POSIX rule on Linux and macOS
    // and then fail on Windows for producing the correct Windows answer, which
    // is exactly what it did the first time this suite ran there.
    const cmd = hookCommand("/home/a$(id)b/hook.js", "claude", NODE, "linux");
    expect(cmd).not.toContain('"/home/a$(id)b/hook.js"');
    expect(cmd).toContain("'/home/a$(id)b/hook.js'");
    // The provider was not quoted at all. It is a PROVIDERS key rather than
    // anything a caller chose, so this is belt and braces — and belt and braces
    // is what stops the next argument added here being the loose one.
    expect(cmd).toContain("--provider 'claude'");
  });

  it("is one command with three arguments through cmd.exe too", () => {
    // The Windows mirror of the case above, and the one that would have caught
    // #624 the day it was written. `C:\Program Files\nodejs\` is in the corpus,
    // and under the old rule its argument never closed its quoted region: the
    // child received ONE argument spelled `C:\Program Files\nodejs" --provider
    // claude` and the hook lost both the flag and its value.
    //
    // Every corpus entry's arguments on ONE command line rather than one child
    // per path. Two reasons, and neither is only speed: a leak shows up as the
    // NEXT path's three arguments going missing, which is what the failure
    // actually does, and a Windows runner spawning a process per path is the
    // shape that turns a 20-second budget into a flake.
    const tails = WIN_NASTY.map((p) => argumentsOf(hookCommand(p, "claude", WIN_NODE, "win32"), WIN_NODE));
    const trip = throughCmd(tails.join(" "));
    expect(trip.unquoted, `cmd.exe would read these as syntax: ${trip.line}`).toEqual([]);
    WIN_NASTY.forEach((path, i) => {
      expect(trip.argv.slice(i * 3, i * 3 + 3), path).toEqual([path, "--provider", "claude"]);
    });
    expect(trip.argv).toHaveLength(WIN_NASTY.length * 3);
    expect(trip.modelArgv).toEqual(trip.argv);
  });

  it("uses cmd.exe's rule on Windows, where single quotes are not quoting", () => {
    // Windows is the platform this repo's hook bugs actually come from, and
    // until the CI matrix existed this half of the escaper had never run
    // anywhere. cmd.exe treats `'` as an ordinary character, so the POSIX form
    // would leave a path with a space in it split across two arguments.
    const cmd = hookCommand("C:\\Users\\John Smith\\hook.js", "claude",
      "C:\\Program Files\\nodejs\\node.exe", "win32");
    expect(cmd).toBe('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\John Smith\\hook.js" --provider "claude"');
    expect(cmd).not.toContain("'");
  });
});

describe("the sound hook command", () => {
  const NODE = "/usr/local/bin/node";

  it.runIf(posix)("is one command with one argument, whatever the path contains", () => {
    for (const path of NASTY) {
      const cmd = soundHookCommand(path, NODE, "linux");
      const argv = shellArgv(cmd.replace(shellQuoteArg(NODE, "linux"), "printf-args"));
      expect(argv, path).toEqual(["printf-args", path]);
    }
  });

  it("no longer wraps a path in double quotes and calls it escaped", () => {
    const cmd = soundHookCommand("/home/a`id`b/notify.mjs", NODE, "linux");
    expect(cmd).not.toContain('"/home/a`id`b/notify.mjs"');
    expect(cmd).toContain("'/home/a`id`b/notify.mjs'");
  });

  it("is one command with one argument through cmd.exe too", () => {
    // One line for the whole corpus, for the reasons the hook-command case
    // above gives. One argument per entry here, so a leak is a length mismatch
    // as well as a wrong element.
    const tails = WIN_NASTY.map((p) => argumentsOf(soundHookCommand(p, WIN_NODE, "win32"), WIN_NODE));
    const trip = throughCmd(tails.join(" "));
    expect(trip.unquoted, `cmd.exe would read these as syntax: ${trip.line}`).toEqual([]);
    expect(trip.argv).toEqual(WIN_NASTY);
    expect(trip.modelArgv).toEqual(trip.argv);
  });

  it("uses cmd.exe's rule on Windows, the same as the forwarder entry", () => {
    const cmd = soundHookCommand("C:\\Users\\John Smith\\notify.mjs",
      "C:\\Program Files\\nodejs\\node.exe", "win32");
    expect(cmd).toBe('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\John Smith\\notify.mjs"');
    expect(cmd).not.toContain("'");
  });
});
