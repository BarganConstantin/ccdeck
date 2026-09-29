// The supervisor's upgrade path — worker exits 76, and it comes back through
// `npx -y <spec>@latest` carrying the user's original argv.
//
// On Windows npx is a .cmd, and the obvious way to launch one is `shell: true`.
// That is what this guards against: Node joins the argument array into a single
// cmd.exe command line with spaces and no quoting whatsoever, so the forwarded
// `--workspace C:\Users\John Smith\proj` reaches the new deck as two arguments
// and its parser silently ignores the orphan — the upgraded deck then watches
// the wrong directory and shows no sessions, for good. Windows is the platform
// this repo cannot execute, so the command line is asserted instead.
//
// The relaunch now prefers npm's own npx-cli.js under process.execPath and
// reaches a PATH shim only when that is missing (see npx-launch.test.ts). This
// file pins what the fallback must still do when it is reached.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error — .mjs server module, no types
import { spawnSpec } from "../../server/exec.mjs";
// @ts-expect-error — .mjs server module, no types
import { npxRelaunchArgs, withoutPortAndOpen } from "../../server/supervisor.mjs";

/** What launchNpx hands npx, for a deck bound to 4317. */
const relaunch = (forwarded: string[]) => npxRelaunchArgs("ccdeck@latest", forwarded, 4317);

describe("what the relaunch keeps of the user's own argv", () => {
  it("drops --no-open and --port in both spellings, and keeps the rest in order", () => {
    // Appended again by launchNpx, so a copy left in the user's argv would be
    // `--port 4317 --no-open --port 4317 --no-open` in `ps`.
    expect(withoutPortAndOpen(["--workspace", "/a b", "--port", "4317", "--no-open", "--port=4400", "--no-codex"]))
      .toEqual(["--workspace", "/a b", "--no-codex"]);
  });

  it("takes --port's value with it, so the number is not left behind as an argument", () => {
    expect(withoutPortAndOpen(["--port", "4317", "--history", "/h.jsonl"])).toEqual(["--history", "/h.jsonl"]);
  });

  it("drops a --port at the end that never got its value", () => {
    expect(withoutPortAndOpen(["--no-codex", "--port"])).toEqual(["--no-codex"]);
  });

  it("answers with a copy, leaving the argv it was handed alone", () => {
    const argv = ["--port", "1", "--no-open"];
    expect(withoutPortAndOpen(argv)).toEqual([]);
    expect(argv).toEqual(["--port", "1", "--no-open"]);
  });
});

describe("the relaunch's own flags", () => {
  it("puts the spec first, then the user's argv, then the bound port and --no-open", () => {
    // The port is the one the deck is serving on, so the tab that asked for the
    // upgrade reconnects to the same URL; --no-open because that tab is already
    // there, and a second one would be the deck talking over itself.
    expect(npxRelaunchArgs("ccdeck@latest", ["--workspace", "/a b", "--port=4400", "--no-open", "--no-codex"], 4317))
      .toEqual(["-y", "ccdeck@latest", "--workspace", "/a b", "--no-codex", "--port", "4317", "--no-open"]);
  });

  it("names no port before a worker has bound one", () => {
    expect(npxRelaunchArgs("ccdeck@latest", ["--port", "4400"], null)).toEqual(["-y", "ccdeck@latest", "--no-open"]);
    expect(npxRelaunchArgs("ccdeck@latest", [])).toEqual(["-y", "ccdeck@latest", "--no-open"]);
  });

  it("is what the supervisor runs", () => {
    const supervisor = readFileSync(fileURLToPath(new URL("../../../bin/agent-dag.js", import.meta.url)), "utf8");
    expect(supervisor).toContain("const args = npxRelaunchArgs(spec, process.argv.slice(2), boundPort);");
    expect(supervisor).toContain("npxLaunch(args)");
  });
});

describe("the npx upgrade relaunch on Windows", () => {
  it("goes through cmd.exe verbatim, the same way Node's own shell does", () => {
    const { file, args, opts } = spawnSpec("npx.cmd", relaunch([]), "win32");
    expect(file.toLowerCase()).toContain("cmd");
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    // Verbatim, or Node quotes the already-quoted command line a second time.
    expect(opts.windowsVerbatimArguments).toBe(true);
  });

  it("keeps a workspace path with spaces as one argument", () => {
    const { args } = spawnSpec(
      "npx.cmd",
      relaunch(["--workspace", "C:\\Users\\John Smith\\proj"]),
      "win32",
    );
    expect(args[3]).toBe(
      '""npx.cmd" "-y" "ccdeck@latest" "--workspace" "C:\\Users\\John Smith\\proj"' +
      ' "--port" "4317" "--no-open""',
    );
  });

  it("defuses the cmd metacharacters a real path can contain", () => {
    // Unquoted, `&` ends the command and runs the rest as a second one, `|` and
    // `>` redirect, `^` escapes the next character away. Quoted, all four are
    // just characters — and the path stays a single argument either way.
    for (const path of ["C:\\dev\\R&D", "C:\\dev\\a|b", "C:\\dev\\a>b", "C:\\dev\\a^b", "C:\\dev\\proj (1)"]) {
      const { args } = spawnSpec("npx.cmd", ["--workspace", path], "win32");
      expect(args[3]).toBe(`""npx.cmd" "--workspace" "${path}""`);
    }
  });

  it("doubles an embedded quote rather than letting it end the argument", () => {
    const { args } = spawnSpec("npx.cmd", ["--history", 'C:\\a"b'], "win32");
    expect(args[3]).toBe('""npx.cmd" "--history" "C:\\a""b""');
  });

  it("spawns npx directly everywhere else, argument vector untouched", () => {
    const forwarded = relaunch(["--workspace", "/home/john smith/proj (1)"]);
    for (const platform of ["linux", "darwin"]) {
      const { file, args, opts } = spawnSpec("npx", forwarded, platform);
      expect(file).toBe("npx");
      expect(args).toEqual(forwarded);
      expect(opts).toEqual({});
    }
  });
});
