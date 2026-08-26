// The "is the user already running cswap auto?" probe could not see a quoted
// command line, and could not see a wrapped one either (#552).
//
// externalAutoRunning decides whether the deck's own auto-switch loop stands
// down. A wrong `true` is a feature that quietly never runs; a wrong `false` is
// TWO engines moving the same live Claude account, at double the poll rate,
// against the OAuth request budget the whole module is built around — while the
// panel reports `external: false` and gives the user nowhere to look.
//
// It answered `false` for almost every real Windows launch, for two independent
// reasons that meet on the same call.
//
// ── 1. the quote between the executable and its subcommand ──────────────────
//
// The matcher was
//
//     /(^|[\\/])cswap(\.exe|\.cmd|\.bat)?\s+auto(\s|$)/i
//
// which requires whitespace IMMEDIATELY after the executable token.
// `Win32_Process.CommandLine` reports the line as its creator wrote it, and .NET
// `Process.Start` quotes the executable:
//
//     "C:\Users\dorin\.local\bin\cswap.exe" auto
//
// That is how PowerShell, Windows Terminal's default profile, Task Scheduler and
// an Explorer shortcut all start a program. A `"` sits where the pattern wanted
// a space, so it matched none of them. Only a literal `cswap auto` typed at
// cmd.exe stayed unquoted — and all four Windows fixtures in
// cswap-auto-readers.test.ts happened to be that one shape.
//
// The deck writes the same shape itself, which is why the fixtures here are
// BUILT rather than typed: `spawnSpec` in src/server/exec.mjs launches a `.cmd`
// shim as `cmd.exe /d /s /c ""C:\…\cswap.cmd" "auto""`, quoted per argument and
// then wrapped in one more pair for `cmd /c`. Running the real spawnSpec and
// feeding its command line back into the probe is the only way to be sure the
// two halves of this repo agree about a string neither of them can be watched
// producing from a Mac. `cmdTokens` from ./spawned-argv is the helper that
// already knows how to take that line apart, and it is used here to state that
// the fixture really is the line the deck builds — two tests broke on Windows CI
// recently for reading a recorded spawn by hand instead.
//
// ── 2. PowerShell's formatter wraps at the console width ────────────────────
//
// `Select-Object -ExpandProperty CommandLine` emits strings, and strings leave
// PowerShell through its console FORMATTER, which hard-wraps at the host buffer
// width — 80 columns for the redirected stdout a spawned child always has. A
// real cswap path is longer than that, so the executable and its subcommand
// arrived on SEPARATE LINES and no per-line matcher could ever see both. That
// half cannot be fixed in the pattern at any price, which is why the case below
// asserts the shape of the COMMAND the deck sends: `Out-String -Width 32767`,
// 32767 being the longest command line Windows permits.
//
// Nothing is spawned. `run` answers from the test and everything else in
// exec.mjs stays real, so a regression here is a wrong parse rather than a real
// PowerShell on whatever machine is running the suite. Every Windows case runs
// on Linux and macOS too, by setting process.platform rather than skipping.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { cmdTokens } from "./spawned-argv";

/** Every `run` the module made, and the answer handed back. */
const exec = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[] }[],
  stdout: { value: "" },
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    run: async (cmd: string, args: string[] = []) => {
      exec.calls.push({ cmd, args });
      return { ok: true, code: 0, killed: false, timedOut: false, stdout: exec.stdout.value, stderr: "" };
    },
  };
});

// cswapBin() probes the real filesystem for an installed claude-swap; the name
// it resolves to is irrelevant here and the probe is not.
vi.mock("../../server/cswap-install.mjs", () => ({ cswapBin: async () => "cswap" }));

// @ts-expect-error — .mjs server module, no types
const { externalAutoRunning, looksLikeAutoLoop, commandTokens, invalidateCswapAutoCache } = await import("../../server/cswap-auto.mjs") as {
  externalAutoRunning: () => Promise<boolean>;
  looksLikeAutoLoop: (line: string) => boolean;
  commandTokens: (line: string) => string[];
  invalidateCswapAutoCache: () => void;
};

// @ts-expect-error — .mjs server module, no types
const { spawnSpec } = await import("../../server/exec.mjs") as {
  spawnSpec: (file: string, args: string[], platform: string) => { file: string; args: string[] };
};

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const asPlatform = (value: string) =>
  Object.defineProperty(process, "platform", { value, configurable: true });
afterAll(() => { Object.defineProperty(process, "platform", realPlatform); });

// #616 gave externalAutoRunning a minimum gap and a shared in-flight promise, so
// a finished reading answers the next caller rather than starting a second
// child. Every case here feeds it a different process table and wants its own
// reading, so each one says the previous is finished with;
// invalidateCswapAutoCache is the module's own reset.
beforeEach(() => { exec.calls.length = 0; exec.stdout.value = ""; invalidateCswapAutoCache(); });

/** Answer the next `run` with a process listing holding these lines. */
const listing = (...lines: string[]) => {
  exec.stdout.value = ["System Idle Process", "C:\\WINDOWS\\Explorer.EXE", ...lines, ""].join("\r\n");
};

/**
 * The command line the deck itself writes for a `.cmd` shim, straight out of
 * the real spawnSpec — `cmd.exe /d /s /c ""C:\…\cswap.cmd" "auto" …"` — joined
 * back into the single string a process table reports.
 */
const deckCommandLine = (shim: string, args: string[]) => {
  const spec = spawnSpec(shim, args, "win32");
  return [spec.file, ...spec.args].join(" ");
};

const CSWAP_EXE = "C:\\Users\\dorin\\.local\\bin\\cswap.exe";
const CSWAP_CMD = "C:\\Users\\dorin\\AppData\\Roaming\\Python\\Python312\\Scripts\\cswap.cmd";

describe("the command line shapes a Windows process table really reports", () => {
  beforeEach(() => { asPlatform("win32"); });

  it("sees the loop when Process.Start quoted the executable", async () => {
    // PowerShell, Windows Terminal's default profile, Task Scheduler and an
    // Explorer shortcut all produce exactly this. Before #552 the probe
    // answered false for every one of them, and the deck ticked alongside the
    // user's own engine.
    listing(`"${CSWAP_EXE}" auto`);
    expect(await externalAutoRunning()).toBe(true);
  });

  it("sees it when the path inside the quotes has a space in it", async () => {
    // The reason quoting exists in the first place, and the case a pattern
    // written against unquoted lines never had to think about.
    listing('"C:\\Program Files\\claude swap\\cswap.exe" auto --verbose');
    expect(await externalAutoRunning()).toBe(true);
  });

  it("sees it through the very command line this repo builds for a .cmd shim", async () => {
    // Not a hand-typed fixture: spawnSpec is asked for the Windows answer and
    // its command line is fed straight back in. If viaCmd's quoting ever
    // changes, this case changes with it — which is the point, since the deck
    // and the probe are the two ends of the same string.
    const line = deckCommandLine(CSWAP_CMD, ["auto"]);
    expect(cmdTokens(line.split(" /c ")[1])).toEqual([CSWAP_CMD, "auto"]);

    listing(line);
    expect(await externalAutoRunning()).toBe(true);
  });

  it("still lets the deck's own tick through, in that same built shape", async () => {
    // The deck ticks with `--once`, and on Windows its tick appears in the
    // process table as this exact cmd.exe line. Counting it would make the deck
    // stand down permanently the moment it started working.
    listing(deckCommandLine(CSWAP_CMD, ["auto", "--once", "--json"]));
    expect(await externalAutoRunning()).toBe(false);
  });

  it("still lets a quoted one-shot through", async () => {
    listing(`"${CSWAP_EXE}" auto --once --json`);
    expect(await externalAutoRunning()).toBe(false);
  });

  it("asks PowerShell not to wrap the lines it prints", async () => {
    // The half no matcher can fix. `-ExpandProperty` emits strings, strings go
    // through PowerShell's console formatter, and the formatter hard-wraps at
    // the buffer width of a redirected stdout — which splits a real cswap path
    // from the `auto` after it. 32767 is the longest command line Windows
    // permits, so nothing real can wrap at it.
    listing();
    await externalAutoRunning();
    const command = exec.calls[0].args.join(" ");
    expect(exec.calls[0].cmd).toBe("powershell.exe");
    expect(command).toContain("Win32_Process");
    expect(command).toMatch(/Out-String\s+-Width\s+32767/);
  });

  it("cannot see a loop PowerShell split across two lines, which is why the width is asked for", async () => {
    // The failure the width setting prevents, stated so the reason the command
    // string carries `Out-String` is written down rather than remembered. The
    // probe reads one line at a time by construction — the process table is a
    // list of command lines — so a wrapped one is simply gone.
    listing(
      '"C:\\Users\\dorin\\AppData\\Roaming\\Python\\Python312\\Scripts\\cswap.exe"',
      " auto",
    );
    expect(await externalAutoRunning()).toBe(false);
  });
});

describe("looksLikeAutoLoop, read off the tokens rather than the characters", () => {
  it("accepts every way the three platforms spell a launch", () => {
    // All of these are the same program running the same subcommand. The
    // platform is irrelevant to the matcher, which is why none of these cases
    // needs a process.platform at all.
    for (const line of [
      "cswap auto",
      "/home/dorin/.local/bin/cswap auto --verbose",
      `"${CSWAP_EXE}" auto`,
      `${CSWAP_EXE} auto`,
      "C:\\bin\\CSWAP.EXE AUTO",
      "C:\\bin\\cswap.cmd auto",
      "C:\\bin\\cswap.bat auto",
      "/bin/sh -c cswap auto",
    ]) {
      expect(looksLikeAutoLoop(line), line).toBe(true);
    }
  });

  it("refuses a name that merely ends in cswap", () => {
    // The anchoring the old pattern got from `(^|[\\/])` and this one gets from
    // comparing the last path component. Somebody else's program is not ours.
    expect(looksLikeAutoLoop("/opt/bin/mycswap auto")).toBe(false);
    expect(looksLikeAutoLoop("python -m notcswap auto")).toBe(false);
    expect(looksLikeAutoLoop('"C:\\bin\\notcswap.exe" auto')).toBe(false);
  });

  it("refuses a subcommand that merely starts with auto", () => {
    expect(looksLikeAutoLoop("cswap autopilot")).toBe(false);
    expect(looksLikeAutoLoop('"C:\\bin\\cswap.exe" automate --forever')).toBe(false);
  });

  it("refuses a quoted filename that happens to contain both words", () => {
    // Splitting on quotes as well as whitespace is what makes the quoted
    // launcher visible, and this is the case it must not also let in: the token
    // after `cswap.exe` is `auto.txt`, not `auto`.
    expect(looksLikeAutoLoop('notepad.exe "C:\\docs\\cswap.exe auto.txt"')).toBe(false);
  });

  it("refuses anything carrying --once, wherever it sits", () => {
    expect(looksLikeAutoLoop(`"${CSWAP_EXE}" auto --once`)).toBe(false);
    expect(looksLikeAutoLoop("cswap auto --json --once")).toBe(false);
  });

  it("answers false rather than throwing for the shapes a process table can hand it", () => {
    // CIM reports a null CommandLine for a process the query cannot open, and
    // the trailing blank line of any listing is empty. Neither may be an
    // exception on a poll.
    expect(looksLikeAutoLoop("")).toBe(false);
    expect(looksLikeAutoLoop(undefined as unknown as string)).toBe(false);
    expect(looksLikeAutoLoop(null as unknown as string)).toBe(false);
  });
});

describe("commandTokens", () => {
  it("collapses the outer pair, the per-argument pairs and the bare case alike", () => {
    // One rule, three shapes, no knowledge of which launcher wrote the line.
    expect(commandTokens("cswap auto")).toEqual(["cswap", "auto"]);
    expect(commandTokens('"C:\\bin\\cswap.exe" auto')).toEqual(["C:\\bin\\cswap.exe", "auto"]);
    expect(commandTokens('cmd.exe /d /s /c ""C:\\bin\\cswap.cmd" "auto""'))
      .toEqual(["cmd.exe", "/d", "/s", "/c", "C:\\bin\\cswap.cmd", "auto"]);
  });

  it("drops the carriage return a CRLF listing leaves on every line", () => {
    // PowerShell prints CRLF and the caller splits on "\n" alone, so the CR is
    // still on the last token when it arrives here.
    expect(commandTokens('"C:\\bin\\cswap.exe" auto\r')).toEqual(["C:\\bin\\cswap.exe", "auto"]);
  });
});
