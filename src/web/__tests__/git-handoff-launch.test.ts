// The command line each hand-off app is opened with, per OS: always a fixed
// argument vector with the folder as one whole entry, never a string a shell
// parses; and who counts as a browser on the deck's own machine.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { REFUSALS, browserPlatform, launchEnv, launchSpec, viewerIsLocal } from "../../server/git-handoff-launch.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { isLoopbackHost } from "../../server/request-gates.mjs";

const app = (id: string, slot: string, path: string, kind = "exe") => ({ id, slot, name: id, target: { kind, path } });

// A folder whose name is every character a shell would act on.
const NASTY = "/tmp/a b;$(touch x)`id`'\"&|>*";
const NASTY_WIN = "C:\\Users\\ada\\a b&^(x)\"y";

describe("macOS", () => {
  const F = "/Users/ada/code/shop api";
  const P = "/Users/ada/code/shop api/src/a.ts";
  const spec = (a: ReturnType<typeof app>, extra = {}) => launchSpec(a, { folder: F, platform: "darwin", ...extra });

  it("opens a bundle through LaunchServices with the folder, and an editor with the file too", () => {
    expect(spec(app("fork", "git", "/Applications/Fork.app", "app")))
      .toEqual({ file: "/usr/bin/open", args: ["-a", "/Applications/Fork.app", F], cwd: F, verbatim: false });
    expect(spec(app("vscode", "editor", "/Applications/Visual Studio Code.app", "app"), { file: P }).args)
      .toEqual(["-a", "/Applications/Visual Studio Code.app", F, P]);
    // A file is for an editor only.
    expect(spec(app("fork", "git", "/Applications/Fork.app", "app"), { file: P }).args).toEqual(["-a", "/Applications/Fork.app", F]);
  });

  it("hands GitKraken and GitHub Desktop the flags their own command lines use", () => {
    expect(spec(app("gitkraken", "git", "/Applications/GitKraken.app", "app")).args)
      .toEqual(["-na", "/Applications/GitKraken.app", "--args", "-p", F]);
    expect(spec(app("github-desktop", "git", "/Applications/GitHub Desktop.app", "app")).args)
      .toEqual(["-n", "/Applications/GitHub Desktop.app", "--args", `--cli-open=${F}`]);
  });

  it("runs a Toolbox script directly", () => {
    expect(spec(app("idea", "editor", "/Users/ada/Library/Application Support/JetBrains/Toolbox/scripts/idea"), { file: P }))
      .toMatchObject({ file: "/Users/ada/Library/Application Support/JetBrains/Toolbox/scripts/idea", args: [F, P] });
  });

  it("starts a JetBrains bundle as a new instance with the paths as its arguments", () => {
    expect(spec(app("idea", "editor", "/Applications/IntelliJ IDEA.app", "app"), { file: P }))
      .toEqual({ file: "/usr/bin/open", args: ["-na", "/Applications/IntelliJ IDEA.app", "--args", F, P], cwd: F, verbatim: false });
    expect(spec(app("rider", "editor", "/Users/ada/Applications/Rider.app", "app")).args)
      .toEqual(["-na", "/Users/ada/Applications/Rider.app", "--args", F]);
  });

  it("runs the command line tool inside Fork's and Tower's bundles with the folder", () => {
    expect(spec(app("fork", "git", "/Applications/Fork.app/Contents/Resources/fork_cli")))
      .toEqual({ file: "/Applications/Fork.app/Contents/Resources/fork_cli", args: [F], cwd: F, verbatim: false });
    expect(spec(app("tower", "git", "/Applications/Tower.app/Contents/MacOS/gittower")))
      .toEqual({ file: "/Applications/Tower.app/Contents/MacOS/gittower", args: [F], cwd: F, verbatim: false });
  });

  it("opens each terminal on the folder", () => {
    expect(spec(app("terminal", "terminal", "/System/Applications/Utilities/Terminal.app", "app")).args)
      .toEqual(["-a", "/System/Applications/Utilities/Terminal.app", F]);
    expect(spec(app("iterm", "terminal", "/Applications/iTerm.app", "app")).args).toEqual(["-a", "/Applications/iTerm.app", F]);
    expect(spec(app("ghostty", "terminal", "/Applications/Ghostty.app", "app")).args).toEqual(["-a", "/Applications/Ghostty.app", F]);
    expect(spec(app("wezterm", "terminal", "/Applications/WezTerm.app", "app")))
      .toMatchObject({ file: "/Applications/WezTerm.app/Contents/MacOS/wezterm", args: ["start", "--cwd", F] });
  });

  it("runs lazygit inside the chosen terminal, the folder and the program as argv of a constant script", () => {
    const lazy = app("lazygit", "git", "/opt/homebrew/bin/lazygit");
    const s = spec(lazy, { terminal: app("terminal", "terminal", "/System/Applications/Utilities/Terminal.app", "app"), folder: NASTY });
    expect(s.file).toBe("/usr/bin/osascript");
    expect(s.args.slice(-2)).toEqual([NASTY, "/opt/homebrew/bin/lazygit"]);
    const script = s.args.slice(0, -2);
    expect(script.filter((_: string, i: number) => i % 2 === 0).every((x: string) => x === "-e")).toBe(true);
    expect(script.join("\n")).not.toContain(NASTY);
    expect(script.join("\n")).toContain("quoted form of (item 1 of argv)");
    expect(spec(lazy, { terminal: app("iterm", "terminal", "/Applications/iTerm.app", "app") }).args.join(" ")).toContain('tell application "iTerm"');
    expect(spec(lazy, { terminal: app("ghostty", "terminal", "/Applications/Ghostty.app", "app") }).args)
      .toEqual(["-na", "/Applications/Ghostty.app", "--args", `--working-directory=${F}`, "-e", "/opt/homebrew/bin/lazygit"]);
    expect(spec(lazy, { terminal: app("wezterm", "terminal", "/Applications/WezTerm.app", "app") }).args)
      .toEqual(["start", "--cwd", F, "--", "/opt/homebrew/bin/lazygit"]);
    expect(spec(lazy, { terminal: null })).toEqual({ refused: REFUSALS.noTerminal });
  });
});

describe("Linux", () => {
  const F = "/home/ada/code/shop";
  const P = "/home/ada/code/shop/src/a.ts";
  const spec = (a: ReturnType<typeof app>, extra = {}) => launchSpec(a, { folder: F, platform: "linux", ...extra });

  it("hands editors the folder and the file, and git clients the folder", () => {
    for (const [id, path] of [["vscode", "/usr/share/code/bin/code"], ["cursor", "/usr/bin/cursor"], ["zed", "/usr/bin/zeditor"], ["rider", "/snap/bin/rider"], ["sublime-text", "/usr/bin/subl"]]) {
      expect(spec(app(id, "editor", path), { file: P }), id).toEqual({ file: path, args: [F, P], cwd: F, verbatim: false });
      expect(spec(app(id, "editor", path)).args, id).toEqual([F]);
    }
    expect(spec(app("sublime-merge", "git", "/usr/bin/smerge")).args).toEqual([F]);
    expect(spec(app("gitkraken", "git", "/usr/bin/gitkraken")).args).toEqual(["-p", F]);
  });

  const TERMINALS: [string, string[], string[]][] = [
    ["gnome-terminal", [`--working-directory=${F}`], [`--working-directory=${F}`, "--", "/usr/bin/lazygit"]],
    ["ptyxis", ["--new-window", "-d", F], ["-d", F, "--", "/usr/bin/lazygit"]],
    ["konsole", ["--workdir", F], ["--workdir", F, "-e", "/usr/bin/lazygit"]],
    ["kitty", ["--directory", F], ["--directory", F, "/usr/bin/lazygit"]],
    ["alacritty", ["--working-directory", F], ["--working-directory", F, "-e", "/usr/bin/lazygit"]],
    ["wezterm", ["start", "--cwd", F], ["start", "--cwd", F, "--", "/usr/bin/lazygit"]],
    ["ghostty", [`--working-directory=${F}`], [`--working-directory=${F}`, "-e", "/usr/bin/lazygit"]],
    ["x-terminal-emulator", [], ["-e", "/usr/bin/lazygit"]],
  ];
  for (const [id, plain, withLazy] of TERMINALS) {
    it(`opens ${id} on the folder, and lazygit in it`, () => {
      const t = app(id, "terminal", `/usr/bin/${id}`);
      expect(spec(t)).toEqual({ file: `/usr/bin/${id}`, args: plain, cwd: F, verbatim: false });
      expect(spec(app("lazygit", "git", "/usr/bin/lazygit"), { terminal: t })).toEqual({ file: `/usr/bin/${id}`, args: withLazy, cwd: F, verbatim: false });
    });
  }

  it("keeps a folder full of shell syntax as one argument", () => {
    const s = launchSpec(app("vscode", "editor", "/usr/bin/code"), { folder: NASTY, platform: "linux" });
    expect(s.args).toEqual([NASTY]);
    expect(s.cwd).toBe(NASTY);
  });
});

describe("Windows", () => {
  const F = "C:\\Users\\ada\\code\\shop";
  const P = "C:\\Users\\ada\\code\\shop\\src\\a.ts";
  const comspec = "C:\\Windows\\System32\\cmd.exe";
  const spec = (a: ReturnType<typeof app>, extra = {}) => launchSpec(a, { folder: F, platform: "win32", comspec, ...extra });

  it("starts GUI apps directly with the folder", () => {
    expect(spec(app("fork", "git", "C:\\Users\\ada\\AppData\\Local\\Fork\\Fork.exe")))
      .toEqual({ file: "C:\\Users\\ada\\AppData\\Local\\Fork\\Fork.exe", args: [F], cwd: F, verbatim: false });
    expect(spec(app("vscode", "editor", "C:\\Program Files\\Microsoft VS Code\\Code.exe"), { file: P }).args).toEqual([F, P]);
    expect(spec(app("tower", "git", "C:\\Users\\ada\\AppData\\Local\\Tower\\current\\Tower.exe")).args).toEqual(["-o", F]);
    expect(spec(app("gitkraken", "git", "C:\\Users\\ada\\AppData\\Local\\gitkraken\\gitkraken.exe")).args).toEqual(["-p", F]);
    expect(spec(app("github-desktop", "git", "C:\\Users\\ada\\AppData\\Local\\GitHubDesktop\\GitHubDesktop.exe")).args).toEqual([`--cli-open=${F}`]);
    expect(spec(app("windows-terminal", "terminal", "C:\\Users\\ada\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe")).args).toEqual(["-d", F]);
  });

  it("opens a console program in a console of its own, with a constant line and the folder as its working directory", () => {
    const ps = spec(app("powershell", "terminal", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"));
    expect(ps).toEqual({
      file: comspec,
      args: ["/d", "/s", "/c", '"start "" "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" "-NoLogo""'],
      cwd: F,
      verbatim: true,
    });
    const lazy = launchSpec(app("lazygit", "git", "C:\\tools\\lazygit.exe"), { folder: NASTY_WIN, platform: "win32", comspec });
    expect(lazy.args).toEqual(["/d", "/s", "/c", '"start "" "C:\\tools\\lazygit.exe""']);
    expect(lazy.args.join(" ")).not.toContain("a b&");
    expect(lazy.cwd).toBe(NASTY_WIN);
    expect(spec(app("pwsh", "terminal", "C:\\Program Files\\PowerShell\\7\\pwsh.exe")).args[3])
      .toBe('"start "" "C:\\Program Files\\PowerShell\\7\\pwsh.exe" "-NoLogo""');
  });

  it("refuses what a second parser would misread", () => {
    expect(spec(app("windows-terminal", "terminal", "C:\\wt.exe"), { folder: "C:\\a;b" })).toEqual({ refused: REFUSALS.separator });
    expect(spec(app("lazygit", "git", "C:\\%TOOLS%\\lazygit.exe"))).toEqual({ refused: REFUSALS.unquotable });
    const script = app("rider", "editor", "C:\\Users\\ada\\AppData\\Local\\JetBrains\\Toolbox\\scripts\\rider.cmd");
    expect(spec(script, { folder: "C:\\code\\%USERNAME%" })).toEqual({ refused: REFUSALS.unquotable });
    expect(spec(script)).toMatchObject({ file: script.target.path, args: [F] });
    // An .exe gets the same folder untouched: nothing parses its arguments but itself.
    expect(spec(app("vscode", "editor", "C:\\Code.exe"), { folder: "C:\\code\\%USERNAME%" }).args).toEqual(["C:\\code\\%USERNAME%"]);
  });
});

describe("what a launched app inherits", () => {
  it("drops the deck's own markers and keeps the person's environment", () => {
    const env = launchEnv({
      PATH: "/usr/bin", HOME: "/home/ada", AGENTS_DECK_NO_LAN: "1",
      ELECTRON_RUN_AS_NODE: "1", AGENTS_DECK_DETACHED: "1", AGENTS_DECK_SUPERVISOR_PID: "42", CLAUDECODE: "1",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/ada", AGENTS_DECK_NO_LAN: "1" });
  });
});

describe("who is on this machine", () => {
  const req = (headers: Record<string, string>, remoteAddress = "127.0.0.1") => ({ headers: { host: "127.0.0.1:4317", ...headers }, socket: { remoteAddress } });
  const local = (r: ReturnType<typeof req>, platform = "linux") => viewerIsLocal(r, { platform, isLoopbackHost });
  const UA = {
    linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    android: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
    firefoxMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0",
  };

  it("reads the browser's operating system from the hint, then the user agent", () => {
    expect(browserPlatform({ "sec-ch-ua-platform": '"macOS"' })).toBe("darwin");
    expect(browserPlatform({ "sec-ch-ua-platform": '"Windows"', "user-agent": UA.linux })).toBe("win32");
    expect(browserPlatform({ "sec-ch-ua-platform": '"Android"' })).toBe("other");
    expect(browserPlatform({ "user-agent": UA.linux })).toBe("linux");
    expect(browserPlatform({ "user-agent": UA.mac })).toBe("darwin");
    expect(browserPlatform({ "user-agent": UA.firefoxMac })).toBe("darwin");
    expect(browserPlatform({ "user-agent": UA.win })).toBe("win32");
    expect(browserPlatform({ "user-agent": UA.android })).toBe("other");
    expect(browserPlatform({ "user-agent": "curl/8.5.0" })).toBeNull();
    expect(browserPlatform({})).toBeNull();
  });

  it("is a loopback connection to a loopback name, unforwarded, from a browser on this OS", () => {
    expect(local(req({ "user-agent": UA.linux }))).toEqual({ local: true, reason: "loopback" });
    expect(local(req({}, "::ffff:127.0.0.1"))).toEqual({ local: true, reason: "loopback" });
    expect(local(req({ host: "localhost:4317" }, "::1")).local).toBe(true);
    expect(local(req({ "user-agent": UA.mac }), "darwin").local).toBe(true);
  });

  it("is not a LAN address, a rebound name, a proxied request, or a browser on another OS", () => {
    expect(local(req({}, "192.168.1.20"))).toEqual({ local: false, reason: "address" });
    expect(local(req({}, "100.66.1.2"))).toEqual({ local: false, reason: "address" });
    expect(local(req({ host: "deck.example:4317" }))).toEqual({ local: false, reason: "host" });
    expect(local(req({ "x-forwarded-for": "192.168.1.20" }))).toEqual({ local: false, reason: "proxy" });
    expect(local(req({ forwarded: "for=192.168.1.20" }))).toEqual({ local: false, reason: "proxy" });
    expect(local(req({ "tailscale-user-login": "ada@example.com" }))).toEqual({ local: false, reason: "proxy" });
    expect(local(req({ "user-agent": UA.mac }))).toEqual({ local: false, reason: "other-os" });
    expect(local(req({ "user-agent": UA.android }))).toEqual({ local: false, reason: "other-os" });
    expect(local(req({ "sec-ch-ua-platform": '"Windows"' }), "linux")).toEqual({ local: false, reason: "other-os" });
  });
});

describe("the runner a launch goes through", () => {
  it("starts the program detached, in the folder, with the environment it was handed", async () => {
    // @ts-expect-error — plain .mjs server module, no types
    const { runDetached } = await import("../../server/exec.mjs");
    const { mkdtempSync, readFileSync, existsSync, realpathSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { rmTempDir } = await import("./rm-temp-dir");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ccdeck-handoff-run-")));
    const out = join(dir, "out.json");
    try {
      runDetached(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ cwd: process.cwd(), marker: process.env.HANDOFF_MARK ?? null, electron: process.env.ELECTRON_RUN_AS_NODE ?? null }))`], {
        cwd: dir,
        env: launchEnv({ ...process.env, HANDOFF_MARK: "kept", ELECTRON_RUN_AS_NODE: "1" }),
        ownGroup: true,
        window: true,
      });
      for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise(r => setTimeout(r, 50));
      // Windows will not remove a folder a running process stands in.
      await new Promise(r => setTimeout(r, 300));
      const seen = JSON.parse(readFileSync(out, "utf8"));
      expect(realpathSync(seen.cwd)).toBe(dir);
      expect(seen.marker).toBe("kept");
      expect(seen.electron).toBeNull();
    } finally {
      rmTempDir(dir);
    }
  });
});
