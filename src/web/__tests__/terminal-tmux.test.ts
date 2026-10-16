// Which tmux the terminal panel runs, and how a tmux command is spelled.
//
// tmux.mjs is the only place that knows the binary, the server and the
// environment a tmux client gets, so every rule it holds is pinned here
// without a tmux anywhere near the run: the probe is driven by injected
// `exists` and `run`, and the argv builders are pure. What only a real tmux
// can show — that the escapes below are the ones tmux itself honours — is in
// terminal-sessions-real-tmux.test.ts.
//
// Three of the rules came from measuring tmux 3.6 rather than reading about
// it, and each would fail without an error anywhere: a project folder whose
// name ends in `;` splits the command in two, a `#{...}` in a folder name is
// expanded as a format (and `#(...)` would run), and a client with no UTF-8
// locale prints every non-ASCII character as `_`.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import {
  DECK_SOCKET, MIN_TMUX_VERSION, SCOPE_ARGS, cgroupPath, findTmux, paneArgv, parseTmuxVersion, resetServerScope,
  resetTmuxCache, runTmux, serverScope, tmuxArg, tmuxCandidates, tmuxCommand, tmuxEnv, tmuxFormatLiteral,
  tmuxHasNoServer, tmuxInstallLine, tmuxSequence,
} from "../../server/tmux.mjs";

type Probe = { ok: boolean; path?: string; version?: number[] | null; raw?: string; reason?: string; install?: string; warning?: string };

afterEach(() => resetTmuxCache());

/** A machine with exactly these files, whose tmux binaries answer `-V` with
 *  the text given (or fail, for `null`). Records the order they were asked. */
function machine(files: Record<string, string | null>) {
  const asked: string[] = [];
  return {
    asked,
    exists: (p: string) => Object.prototype.hasOwnProperty.call(files, p),
    run: async (p: string, args: string[]) => {
      asked.push(p);
      expect(args, "the probe only ever asks for the version").toEqual(["-V"]);
      const out = files[p];
      return out == null ? { code: 1, stdout: "", stderr: "cannot execute" } : { code: 0, stdout: `${out}\n`, stderr: "" };
    },
    readFile: () => "ID=ubuntu\nID_LIKE=debian\n",
  };
}

describe("reading `tmux -V`", () => {
  it("reads the major and minor of every release spelling, and nothing out of a version it cannot vouch for", () => {
    const cases: [string, number[] | null][] = [
      ["tmux 3.6a", [3, 6]],
      ["tmux 3.2a", [3, 2]],
      ["tmux 3.6", [3, 6]],
      ["tmux next-3.6", [3, 6]],
      ["tmux 3.10", [3, 10]],
      ["tmux 2.9a", [2, 9]],
      ["  tmux 3.4\n", [3, 4]],
      // OpenBSD numbers its base tmux after the OS. 7.4 is not a tmux version,
      // and reading it as one would be a guess that happens to pass.
      ["tmux openbsd-7.4", null],
      ["tmux master", null],
      ["", null],
      ["v22.11.0", null],
    ];
    for (const [raw, want] of cases) expect(parseTmuxVersion(raw), JSON.stringify(raw)).toEqual(want);
  });

  it("puts the floor at 3.2, where refresh-client -f arrived", () => {
    expect(MIN_TMUX_VERSION).toEqual([3, 2]);
  });
});

describe("finding tmux", () => {
  it("asks PATH first, then Homebrew, then /usr/local, then /usr/bin — each once", async () => {
    const m = machine({ "/b/tmux": "tmux 3.1", "/opt/homebrew/bin/tmux": "tmux 3.0", "/usr/bin/tmux": "tmux 2.8" });
    const found: Probe = await findTmux({ env: { PATH: "/a:/b:/usr/bin" }, platform: "darwin", ...m });
    expect(m.asked, "every candidate, in order, and /usr/bin only once although PATH names it too")
      .toEqual(["/b/tmux", "/opt/homebrew/bin/tmux", "/usr/bin/tmux"]);
    expect(found).toMatchObject({ ok: false, reason: "too-old", path: "/b/tmux", version: [3, 1], raw: "tmux 3.1" });
    expect(found.install).toBe("brew install tmux");
  });

  it("uses a current tmux behind an old one rather than calling the machine too old", async () => {
    const m = machine({ "/b/tmux": "tmux 3.0a", "/opt/homebrew/bin/tmux": "tmux 3.5a" });
    const found: Probe = await findTmux({ env: { PATH: "/b" }, platform: "darwin", ...m });
    expect(found).toEqual({ ok: true, path: "/opt/homebrew/bin/tmux", version: [3, 5], raw: "tmux 3.5a" });
  });

  it("skips a tmux that is there but will not run", async () => {
    const m = machine({ "/b/tmux": null, "/usr/bin/tmux": "tmux 3.4" });
    const found: Probe = await findTmux({ env: { PATH: "/b" }, platform: "linux", ...m });
    expect(found).toMatchObject({ ok: true, path: "/usr/bin/tmux", version: [3, 4] });
  });

  it("lets a tmux with an unreadable version through, with a warning", async () => {
    const m = machine({ "/usr/bin/tmux": "tmux openbsd-7.4" });
    const found: Probe = await findTmux({ env: { PATH: "" }, platform: "openbsd", ...m });
    expect(found).toEqual({ ok: true, path: "/usr/bin/tmux", version: null, raw: "tmux openbsd-7.4", warning: "unknown-version" });
  });

  it("takes CCDECK_TMUX as the only candidate when it is set", async () => {
    const m = machine({ "/opt/x/tmux": "tmux 3.3a", "/usr/bin/tmux": "tmux 3.6" });
    const found: Probe = await findTmux({ env: { CCDECK_TMUX: "/opt/x/tmux", PATH: "/usr/bin" }, platform: "linux", ...m });
    expect(found).toMatchObject({ ok: true, path: "/opt/x/tmux", version: [3, 3] });
    expect(m.asked).toEqual(["/opt/x/tmux"]);
  });

  it("calls a CCDECK_TMUX that is not there missing, rather than quietly running another tmux", async () => {
    const m = machine({ "/usr/bin/tmux": "tmux 3.6" });
    const found: Probe = await findTmux({ env: { CCDECK_TMUX: "/opt/gone/tmux", PATH: "/usr/bin" }, platform: "linux", ...m });
    expect(found).toEqual({ ok: false, reason: "missing", install: "sudo apt install tmux" });
    expect(m.asked, "nothing else may be run in its place").toEqual([]);
  });

  it("tries ccdeck's own tmux last, after every tmux the user installed", () => {
    const managed = "/home/u/.local/share/ccdeck/tools/tmux/tmux-3.8-1/tmux";
    const all = (p: string) => p === "/usr/bin/tmux" || p === "/opt/homebrew/bin/tmux" || p === managed;
    expect(tmuxCandidates({ env: { PATH: "/usr/bin" }, platform: "darwin", exists: all, managed }))
      .toEqual(["/usr/bin/tmux", "/opt/homebrew/bin/tmux", managed]);
    expect(tmuxCandidates({ env: { PATH: "/usr/bin" }, platform: "linux", exists: (p: string) => p !== managed, managed }),
      "not listed before it has been fetched").not.toContain(managed);
    expect(tmuxCandidates({ env: { CCDECK_TMUX: "/usr/bin/tmux", PATH: "/usr/bin" }, platform: "linux", exists: all, managed }),
      "CCDECK_TMUX is still the only one").toEqual(["/usr/bin/tmux"]);
  });

  it("looks a bare CCDECK_TMUX up on PATH", () => {
    const exists = (p: string) => p === "/tools/tmux-3.6";
    expect(tmuxCandidates({ env: { CCDECK_TMUX: "tmux-3.6", PATH: "/usr/bin:/tools" }, platform: "linux", exists }))
      .toEqual(["/tools/tmux-3.6"]);
  });

  it("answers missing with this machine's install line when there is no tmux at all", async () => {
    const m = machine({});
    const found: Probe = await findTmux({ env: { PATH: "/usr/bin" }, platform: "linux", ...m });
    expect(found).toEqual({ ok: false, reason: "missing", install: "sudo apt install tmux" });
  });

  it("does not look for tmux on Windows at all", async () => {
    const m = machine({ "C:\\tmux.exe": "tmux 3.6" });
    const found: Probe = await findTmux({ env: { CCDECK_TMUX: "C:\\tmux.exe", PATH: "C:\\" }, platform: "win32", ...m });
    expect(found).toEqual({ ok: false, reason: "unsupported-platform" });
    expect(m.asked).toEqual([]);
  });
});

describe("remembering the answer", () => {
  it("asks once, and hands every later caller the same answer until the cache is reset", async () => {
    const m = machine({ "/usr/bin/tmux": "tmux 3.6" });
    const at = (now: number) => findTmux({ env: { PATH: "" }, platform: "linux", ...m, now: () => now });
    const first = at(0);
    expect(at(0), "a second caller shares the probe in flight").toBe(first);
    expect(((await first) as Probe).ok).toBe(true);
    expect(at(86_400_000), "a usable tmux is kept, however long the deck runs").toBe(first);
    expect(m.asked, "one `tmux -V` for all of that").toEqual(["/usr/bin/tmux"]);
    resetTmuxCache();
    expect(at(0)).not.toBe(first);
  });

  it("asks again ten seconds after a miss, so a tmux installed meanwhile is seen without a restart", async () => {
    const files: Record<string, string | null> = {};
    const m = machine(files);
    const at = (now: number) => findTmux({ env: { PATH: "" }, platform: "linux", ...m, now: () => now });
    const miss = at(1_000);
    expect(((await miss) as Probe).reason).toBe("missing");
    files["/usr/bin/tmux"] = "tmux 3.6";
    expect(at(9_000), "within the ten seconds the miss stands").toBe(miss);
    expect(await at(11_001), "after them, the new install is found").toMatchObject({ ok: true, path: "/usr/bin/tmux" });
  });

  it("never answers one set of fakes from another's memory", async () => {
    const a = machine({ "/usr/bin/tmux": "tmux 3.6" });
    const b = machine({ "/usr/bin/tmux": "tmux 3.0" });
    expect(await findTmux({ env: { PATH: "" }, platform: "linux", ...a })).toMatchObject({ ok: true });
    expect(await findTmux({ env: { PATH: "" }, platform: "linux", ...b })).toMatchObject({ ok: false, reason: "too-old" });
  });

  it("never answers one PATH from another's memory", async () => {
    const m = machine({ "/a/tmux": "tmux 3.6", "/b/tmux": "tmux 3.4" });
    expect(await findTmux({ env: { PATH: "/a" }, platform: "linux", ...m })).toMatchObject({ path: "/a/tmux" });
    expect(await findTmux({ env: { PATH: "/b" }, platform: "linux", ...m })).toMatchObject({ path: "/b/tmux" });
  });
});

describe("the install line", () => {
  it("is the package manager of the distribution, or of the one it derives from", () => {
    const cases: [string, string][] = [
      ["ID=ubuntu\nID_LIKE=debian", "sudo apt install tmux"],
      ['ID="debian"', "sudo apt install tmux"],
      ['ID=linuxmint\nID_LIKE="ubuntu debian"', "sudo apt install tmux"],
      ["ID=fedora", "sudo dnf install tmux"],
      ['ID="rocky"\nID_LIKE="rhel centos fedora"', "sudo dnf install tmux"],
      ["ID=arch", "sudo pacman -S tmux"],
      ["ID=manjaro\nID_LIKE=arch", "sudo pacman -S tmux"],
      ['ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"', "sudo zypper install tmux"],
      ["ID=alpine", "sudo apk add tmux"],
    ];
    for (const [release, line] of cases) expect(tmuxInstallLine("linux", release), release).toBe(line);
  });

  it("says it in words where no command is known", () => {
    const neutral = "Install tmux 3.2 or newer with your system's package manager.";
    expect(tmuxInstallLine("linux", "ID=nixos")).toBe(neutral);
    expect(tmuxInstallLine("linux", "")).toBe(neutral);
    expect(tmuxInstallLine("openbsd", "")).toBe(neutral);
  });

  it("is Homebrew on a Mac, pkg on FreeBSD, and nothing on Windows", () => {
    expect(tmuxInstallLine("darwin")).toBe("brew install tmux");
    expect(tmuxInstallLine("freebsd")).toBe("sudo pkg install tmux");
    expect(tmuxInstallLine("win32")).toBeUndefined();
  });
});

describe("a tmux command", () => {
  it("goes to the deck's own server, never the user's default one", () => {
    expect(DECK_SOCKET).toEqual({ name: "ccdeck" });
    expect(Object.isFrozen(DECK_SOCKET), "nothing may repoint the deck's server at runtime").toBe(true);
    expect(tmuxCommand("/usr/bin/tmux", DECK_SOCKET, ["list-sessions"]))
      .toEqual(["/usr/bin/tmux", "-u", "-L", "ccdeck", "list-sessions"]);
  });

  it("names a server by its socket file for the user's own tmux, and takes findTmux's answer as the binary", () => {
    expect(tmuxCommand({ ok: true, path: "/opt/homebrew/bin/tmux" }, { path: "/tmp/tmux-501/default" }, ["list-panes", "-a"]))
      .toEqual(["/opt/homebrew/bin/tmux", "-u", "-S", "/tmp/tmux-501/default", "list-panes", "-a"]);
    expect(tmuxCommand("tmux", null, ["-V"]), "null is the default server, with no socket flag").toEqual(["tmux", "-u", "-V"]);
    expect(tmuxCommand("tmux", { name: "x" }, ["resize-window", "-x", 80]), "every argument is a string")
      .toEqual(["tmux", "-u", "-L", "x", "resize-window", "-x", "80"]);
  });

  it("asks for UTF-8 output on every call, because a client with no UTF-8 locale prints `_` for every other character", () => {
    expect(tmuxCommand("tmux", DECK_SOCKET, [])[1]).toBe("-u");
    expect(tmuxCommand("tmux", { path: "/s" }, [])[1]).toBe("-u");
  });

  it("refuses a socket it cannot spell, and a missing binary", () => {
    expect(() => tmuxCommand("tmux", { name: "../default" }, [])).toThrow(/separator/);
    expect(() => tmuxCommand("tmux", {}, [])).toThrow(/socket/);
    expect(() => tmuxCommand("", DECK_SOCKET, [])).toThrow(/binary/);
    expect(() => tmuxCommand({ ok: false, reason: "missing" }, DECK_SOCKET, [])).toThrow(/binary/);
  });

  it("never rejects, and says why when the binary is not there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cct-"));
    try {
      const r = await runTmux(join(dir, "no-such-tmux"), { name: "ccdeck-test-absent" }, ["list-sessions"]);
      expect(r).toMatchObject({ ok: false, code: "ENOENT", stdout: "" });
    } finally {
      rmTempDir(dir);
    }
  });
});

describe("the environment the deck's tmux server is started with", () => {
  const deckEnv = {
    PATH: "/usr/local/bin:/usr/bin", HOME: "/home/me", LANG: "ro_RO.UTF-8", SHELL: "/bin/zsh",
    CLAUDE_CONFIG_DIR: "/home/me/.claude-work", CODEX_HOME: "/home/me/.codex", CLAUDE_CODE_USE_BEDROCK: "1",
    TMUX_TMPDIR: "/run/user/1000", COLORTERM: "truecolor",
    AGENTS_DECK_INTERNAL: "1", AGENTS_DECK_NO_LAN: "1", AGENT_DAG_PORT: "4317", AGENT_DAG_DIR: "/x",
    CCDECK_HOME: "/tmp/sandbox", CCDECK_TMUX: "/opt/tmux", CCDECK_TERMINAL: "1",
    TMUX: "/tmp/tmux-1000/default,1234,0", TMUX_PANE: "%3",
    CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "92d89c18-fa11-489f-944b-32e8b196bcb1",
    CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ATTENDED: "0", CLAUDE_PID: "2356881",
    CLAUDE_CODE_MESSAGING_SOCKET: "/run/user/1000/cc-socks/2356881.sock", CLAUDE_CODE_EXECPATH: "/x/claude",
    CODEX_SANDBOX: "seatbelt", CODEX_SANDBOX_NETWORK_DISABLED: "1",
  };

  it("keeps the user's environment, settings for both agents included", () => {
    expect(tmuxEnv(deckEnv)).toEqual({
      PATH: "/usr/local/bin:/usr/bin", HOME: "/home/me", LANG: "ro_RO.UTF-8", SHELL: "/bin/zsh",
      CLAUDE_CONFIG_DIR: "/home/me/.claude-work", CODEX_HOME: "/home/me/.codex", CLAUDE_CODE_USE_BEDROCK: "1",
      TMUX_TMPDIR: "/run/user/1000", COLORTERM: "truecolor",
    });
  });

  it("drops the deck's own variables, which would silence the hook in a launched session", () => {
    const out = tmuxEnv(deckEnv);
    for (const k of ["AGENTS_DECK_INTERNAL", "AGENTS_DECK_NO_LAN", "AGENT_DAG_PORT", "AGENT_DAG_DIR", "CCDECK_HOME", "CCDECK_TMUX", "CCDECK_TERMINAL"]) {
      expect(out, k).not.toHaveProperty(k);
    }
  });

  it("drops TMUX and TMUX_PANE, so a deck started inside tmux does not nest its server in the user's", () => {
    expect(tmuxEnv(deckEnv)).not.toHaveProperty("TMUX");
    expect(tmuxEnv(deckEnv)).not.toHaveProperty("TMUX_PANE");
  });

  it("drops what an agent stamps on its children, so a deck started by an agent launches independent sessions", () => {
    const out = tmuxEnv(deckEnv);
    for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_PID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_EXECPATH",
      "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED"]) {
      expect(out, k).not.toHaveProperty(k);
    }
  });

  it("returns a copy and leaves the deck's own environment alone", () => {
    const before = { ...deckEnv };
    tmuxEnv(deckEnv);
    expect(deckEnv).toEqual(before);
    expect(tmuxEnv({ A: "1", B: undefined })).toEqual({ A: "1" });
  });
});

describe("arguments tmux would otherwise reinterpret", () => {
  it("escapes a trailing semicolon, which tmux reads as the end of a command", () => {
    expect(tmuxArg("/home/me/notes;")).toBe("/home/me/notes\\;");
    expect(tmuxArg(";")).toBe("\\;");
    expect(tmuxArg("a\\;"), "a literal backslash-semicolon survives as one").toBe("a\\\\;");
    expect(tmuxArg("a;b"), "only a TRAILING one is special").toBe("a;b");
    expect(tmuxArg("")).toBe("");
  });

  it("joins commands with lone semicolons and escapes every argument inside them", () => {
    expect(tmuxSequence([["new-session", "-c", "/p;"], ["set-option", "@x", ";"], ["kill-server"]]))
      .toEqual(["new-session", "-c", "/p\\;", ";", "set-option", "@x", "\\;", ";", "kill-server"]);
  });

  it("doubles every # in a value tmux expands as a format", () => {
    expect(tmuxFormatLiteral("/w/x#{pane_id}#(rm -rf ~)")).toBe("/w/x##{pane_id}##(rm -rf ~)");
    expect(tmuxFormatLiteral("/plain")).toBe("/plain");
  });

  it("runs a one-word command through /bin/sh's exec rather than the user's shell", () => {
    expect(paneArgv(["/Volumes/My Disk/bin/codex"])).toEqual(["/bin/sh", "-c", 'exec "$0"', "/Volumes/My Disk/bin/codex"]);
    expect(paneArgv(["claude", "--resume", "x"]), "two or more words are exec'd by tmux directly").toEqual(["claude", "--resume", "x"]);
  });
});

describe("a tmux that has no server", () => {
  it("is told apart from a tmux that failed", () => {
    expect(tmuxHasNoServer("no server running on /tmp/tmux-1000/ccdeck\n")).toBe(true);
    expect(tmuxHasNoServer("error connecting to /tmp/tmux-1000/ccdeck (No such file or directory)\n")).toBe(true);
    expect(tmuxHasNoServer("no sessions\n")).toBe(true);
    expect(tmuxHasNoServer("can't find session: ccdeck-claude-00000000\n")).toBe(false);
    expect(tmuxHasNoServer("unknown command: frobnicate\n")).toBe(false);
    expect(tmuxHasNoServer("")).toBe(false);
  });
});

describe("a server that outlives the deck's systemd service", () => {
  afterEach(() => resetServerScope());
  const SERVICE = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/ccdeck.service\n";
  const TERMINAL = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-ghostty-surface-transient-1713847.scope\n";
  const onPath = (p: string) => p === "/usr/bin/systemd-run";

  it("reads the cgroup from systemd's own hierarchy on a v1 or hybrid host, else from the unified line", () => {
    expect(cgroupPath(SERVICE)).toBe("/user.slice/user-1000.slice/user@1000.service/app.slice/ccdeck.service");
    expect(cgroupPath("12:cpu,cpuacct:/user.slice\n1:name=systemd:/user.slice/user-1000.slice/user@1000.service/ccdeck.service\n0::/\n"),
      "a hybrid host's unified line says only /").toBe("/user.slice/user-1000.slice/user@1000.service/ccdeck.service");
    expect(cgroupPath("12:cpu,cpuacct:/user.slice\n1:name=systemd:/user.slice/user@1000.service/ccdeck.service\n"))
      .toBe("/user.slice/user@1000.service/ccdeck.service");
    expect(cgroupPath("")).toBe("");
  });

  it("is systemd-run's scope prefix for a deck inside a service, once systemd-run has shown it can start one", async () => {
    const probed: string[] = [];
    const probe = async (bin: string) => { probed.push(bin); return true; };
    const got = await serverScope({ platform: "linux", env: { PATH: "/usr/bin" }, readCgroup: () => SERVICE, exists: onPath, probe });
    expect(got).toEqual(["/usr/bin/systemd-run", ...SCOPE_ARGS]);
    expect(SCOPE_ARGS).toEqual(["--user", "--scope", "--collect", "--quiet", "--description=ccdeck terminal sessions", "--"]);
    await serverScope({ platform: "linux", env: { PATH: "/usr/bin" }, readCgroup: () => SERVICE, exists: onPath, probe });
    expect(probed, "asked once").toEqual(["/usr/bin/systemd-run"]);
  });

  it("finds systemd-run where distributions put it when a service's PATH is bare", async () => {
    const got = await serverScope({ platform: "linux", env: { PATH: "" }, readCgroup: () => SERVICE, exists: onPath, probe: async () => true });
    expect(got?.[0]).toBe("/usr/bin/systemd-run");
  });

  it("is null outside a service, off Linux, without systemd-run, or when systemd will not start a scope", async () => {
    const probe = async () => true;
    expect(await serverScope({ platform: "linux", env: {}, readCgroup: () => TERMINAL, exists: onPath, probe }), "a terminal's scope").toBeNull();
    expect(await serverScope({ platform: "darwin", env: {}, readCgroup: () => SERVICE, exists: onPath, probe })).toBeNull();
    expect(await serverScope({ platform: "linux", env: {}, readCgroup: () => { throw new Error("no /proc"); }, exists: onPath, probe })).toBeNull();
    expect(await serverScope({ platform: "linux", env: {}, readCgroup: () => SERVICE, exists: () => false, probe })).toBeNull();
    expect(await serverScope({ platform: "linux", env: {}, readCgroup: () => SERVICE, exists: onPath, probe: async () => false }), "no user bus").toBeNull();
  });

  it("runs the same tmux command after the prefix", async () => {
    // A prefix that prints what it was handed, standing in for systemd-run.
    const echo = [process.execPath, "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--"];
    const r = await runTmux("/opt/tmux", { name: "ccdeck" }, ["new-session", "-d"], { scope: echo, timeoutMs: 10_000 });
    expect(r.ok, r.stderr).toBe(true);
    expect(JSON.parse(r.stdout)).toEqual(["/opt/tmux", "-u", "-L", "ccdeck", "new-session", "-d"]);
  });
});

describe("tmux.mjs", () => {
  it("imports only Node built-ins and the deck's own modules", () => {
    const src = readFileSync(new URL("../../server/tmux.mjs", import.meta.url), "utf8");
    const from = [...src.matchAll(/^import [^;]*? from "([^"]+)";/gms)].map(m => m[1]);
    expect(from.length).toBeGreaterThan(0);
    for (const spec of from) expect(spec, "a runtime dependency").toMatch(/^(node:|\.\/)/);
  });
});
