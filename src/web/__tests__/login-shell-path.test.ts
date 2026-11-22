// Accounts › Add account › Sign in said "The sign-in page did not open — Claude
// Code is not installed on this machine, or ccdeck cannot find it", on a Mac
// or a Linux machine whose Claude Code sessions, started from the user's own
// terminal, were live on the board beside the dialog.
//
// The deck had been started by the desktop app or a service, with a PATH that
// never read the shell's startup files, and `claude` came from nvm, mise,
// volta or the like, which put it on PATH only there. The candidate list in
// claude-dir.mjs cannot know those folders. And an npm `claude` is a
// `#!/usr/bin/env node` script, so even its absolute path exits 127 unless
// node's folder is on PATH too — which is why the fix adopts the login shell's
// whole PATH (login-shell-path.mjs) rather than looking for one more file.
//
// WHY THE TESTS ARE SHAPED LIKE THIS. Nothing here starts the developer's own
// shell or reads their rc files: every function is handed an env of its own,
// the spawn is a fake, and the two end-to-end cases run stand-in shell
// scripts in a temp folder with a scratch HOME. The suite's setup file sets
// AGENTS_DECK_NO_LOGIN_SHELL=1 in process.env for every other suite; none of
// these cases reads process.env.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const shellPathModule = await import("../../server/login-shell-path.mjs");
const {
  loginShellArgv, parseShellPath, mergePath, readLoginShellPath, adoptLoginShellPath,
  resetLoginShellPathAdoption, resolveWithLoginShell, adoptLoginShellPathAtBoot,
} = shellPathModule;
// @ts-expect-error — plain .mjs module, no types
const { adminClaudeBin, claudeRunnable, deckFindsClaude } = await import("../../server/claude-identity.mjs");
// @ts-expect-error — plain .mjs module, no types
const { deckFindsClaude: installerFindsClaude } = await import("../../server/claude-install.mjs");

const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-login-shell-"));
afterAll(() => rmTempDir(ROOT));

const BEGIN = "__CCDECK_PATH_BEGIN__";
const END = "__CCDECK_PATH_END__";
const COMMAND = `echo ${BEGIN}; printenv PATH; echo ${END}`;
const NVM_BIN = "/home/alice/.nvm/versions/node/v22.14.0/bin";

beforeEach(() => resetLoginShellPathAdoption());

type Call = { file: string; args: string[]; options: any };

type FakeOptions = {
  stdout?: string | string[];
  exit?: number;
  fail?: boolean;
  hang?: boolean;
  throws?: boolean;
  holdOpen?: boolean;
};

/**
 * A spawn that starts nothing: each child prints `stdout` (one chunk per array
 * item) and closes with `exit`, or fails to start, or never ends (`hang`, which
 * leaves the test to emit), or exits with something it started still holding
 * stdout (`holdOpen`: 'exit' without 'close'). The children carry no pid, so a
 * kill reaches only the fake's own `kill` and never a real process group.
 */
function fakeSpawn({ stdout = "", exit = 0, fail = false, hang = false, throws = false, holdOpen = false }: FakeOptions = {}) {
  const calls: Call[] = [];
  const children: any[] = [];
  const spawn = (file: string, args: string[], options: any) => {
    calls.push({ file, args, options });
    if (throws) throw new Error("spawn EACCES");
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = Object.assign(new EventEmitter(), { resume: vi.fn() });
    child.kill = vi.fn();
    children.push(child);
    setImmediate(() => {
      if (fail) { child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })); return; }
      if (hang) return;
      for (const chunk of [stdout].flat()) if (chunk) child.stdout.emit("data", chunk);
      child.emit("exit", exit, null);
      if (!holdOpen) child.emit("close", exit, null);
    });
    return child;
  };
  return { spawn, calls, children };
}

const block = (path: string) => `${BEGIN}\n${path}\n${END}\n`;

describe("reading the PATH out of what the shell printed", () => {
  it("finds it between the markers, whatever the rc files print around it", () => {
    const out = [
      "Welcome back, alice!",
      "\x1b[32mnvm: using node v22.14.0\x1b[0m",
      block(`${NVM_BIN}:/usr/bin:/bin`).trimEnd(),
      "Have a nice day (from .bash_logout)",
      "",
    ].join("\n");
    expect(parseShellPath(out)).toBe(`${NVM_BIN}:/usr/bin:/bin`);
  });

  it("takes the last block when there are two", () => {
    const out = `${COMMAND}\n${block("/stale/bin")}noise\n${block("/real/bin:/usr/bin")}`;
    expect(parseShellPath(out)).toBe("/real/bin:/usr/bin");
  });

  it("does not take the command echoed back for a block: BEGIN ends its line, END starts one", () => {
    // An rc file that echoes what it runs prints the command, markers and all.
    expect(parseShellPath(`${COMMAND}\n`)).toBeNull();
    expect(parseShellPath(`${COMMAND}\n${block("/real/bin")}`)).toBe("/real/bin");
    // Whatever precedes BEGIN on its line is allowed: a title escape with no newline.
    expect(parseShellPath(`\x1b]0;alice@mac\x07${block("/opt/a")}`)).toBe("/opt/a");
  });

  it("is null without the markers, with only one of them, or with nothing between them", () => {
    expect(parseShellPath("")).toBeNull();
    expect(parseShellPath(undefined)).toBeNull();
    expect(parseShellPath("/usr/bin:/bin\n")).toBeNull();
    expect(parseShellPath(`${BEGIN}\n/usr/bin:/bin\n`)).toBeNull();
    expect(parseShellPath(`/usr/bin:/bin\n${END}\n`)).toBeNull();
    expect(parseShellPath(`${BEGIN}\n  \n${END}\n`)).toBeNull();
  });
});

describe("merging the shell's PATH into the deck's", () => {
  it("keeps the deck's own entries first and in order, and appends only what is missing", () => {
    expect(mergePath("/usr/bin:/bin", `${NVM_BIN}:/usr/bin:/bin:/home/alice/.local/share/mise/shims`)).toEqual({
      path: `/usr/bin:/bin:${NVM_BIN}:/home/alice/.local/share/mise/shims`,
      added: 2,
    });
  });

  it("ignores relative, empty and repeated entries, and a folder already there with a trailing slash", () => {
    // An empty or relative entry means the current directory to a PATH search.
    expect(mergePath("/usr/bin", "::./bin:node_modules/.bin:/opt/a:/opt/a:/usr/bin/:/opt/b:")).toEqual({
      path: "/usr/bin:/opt/a:/opt/b",
      added: 2,
    });
  });

  it("hands the deck's PATH back exactly as it was when the shell adds nothing", () => {
    expect(mergePath("/usr/bin::/bin", "/bin:/usr/bin")).toEqual({ path: "/usr/bin::/bin", added: 0 });
    expect(mergePath("/usr/bin:/bin", "")).toEqual({ path: "/usr/bin:/bin", added: 0 });
  });

  it("starts no empty entry when the deck had no PATH at all", () => {
    expect(mergePath("", "/opt/a:/opt/b")).toEqual({ path: "/opt/a:/opt/b", added: 2 });
    expect(mergePath(undefined, "/opt/a")).toEqual({ path: "/opt/a", added: 1 });
  });
});

describe("which shells are asked, and how", () => {
  it("asks bash, zsh, fish, ksh, mksh, dash and sh as a login, interactive shell", () => {
    for (const name of ["bash", "zsh", "fish", "ksh", "mksh", "dash", "sh"]) {
      for (const dir of ["/bin", "/usr/local/bin", "/opt/homebrew/bin"]) {
        expect(loginShellArgv(`${dir}/${name}`)).toEqual([`${dir}/${name}`, "-l", "-i", "-c", COMMAND]);
      }
    }
  });

  it("asks nothing that is not an absolute path", () => {
    for (const shell of ["bash", "./bash", "bin/zsh", "", "   ", undefined, null, 42]) {
      expect(loginShellArgv(shell), String(shell)).toBeNull();
    }
  });

  it("asks no shell whose -l -i -c means something else", () => {
    for (const shell of ["/bin/csh", "/bin/tcsh", "/usr/bin/nu", "/usr/local/bin/pwsh", "/usr/bin/elvish", "/usr/bin/xonsh", "/bin/bash5"]) {
      expect(loginShellArgv(shell), shell).toBeNull();
    }
  });
});

describe("asking the login shell", () => {
  const env = { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin", HOME: "/home/alice", TERM: "xterm-256color" };

  it("answers the PATH it printed, from a shell started on its own, with no stdin and a dumb terminal", async () => {
    const fake = fakeSpawn({ stdout: `Welcome!\n${block(`${NVM_BIN}:/usr/bin:/bin`)}` });
    expect(await readLoginShellPath({ env, platform: "darwin", spawn: fake.spawn })).toBe(`${NVM_BIN}:/usr/bin:/bin`);
    expect(fake.calls).toHaveLength(1);
    const [{ file, args, options }] = fake.calls;
    expect([file, ...args]).toEqual(["/bin/zsh", "-l", "-i", "-c", COMMAND]);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(options.detached).toBe(true);
    expect(options.shell).toBe(false);
    expect(options.env).toEqual({ ...env, TERM: "dumb" });
    // The caller's environment is not the one changed.
    expect(env.TERM).toBe("xterm-256color");
    expect(fake.children[0].stderr.resume).toHaveBeenCalled();
  });

  it("answers it after a non-zero exit too: an rc file whose last command failed still set PATH", async () => {
    const fake = fakeSpawn({ stdout: block("/opt/a:/usr/bin"), exit: 1 });
    expect(await readLoginShellPath({ env, platform: "linux", spawn: fake.spawn })).toBe("/opt/a:/usr/bin");
  });

  it("answers as soon as the markers are in, though something the rc file started still holds stdout, and kills the group", async () => {
    // 'exit' without 'close': a background job inherited the pipe. Waiting for
    // 'close' would sit out the whole deadline with the answer in hand.
    const fake = fakeSpawn({ stdout: block("/opt/lazy/bin:/usr/bin"), holdOpen: true });
    const started = Date.now();
    expect(await readLoginShellPath({ env, platform: "linux", spawn: fake.spawn, timeoutMs: 5_000 })).toBe("/opt/lazy/bin:/usr/bin");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fake.children[0].kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("ends early only on a complete block: END across chunks, and not on the command echoed back", async () => {
    const fake = fakeSpawn({ hang: true });
    let got: unknown = "pending";
    const read = readLoginShellPath({ env, platform: "linux", spawn: fake.spawn, timeoutMs: 5_000 });
    read.then((v: unknown) => { got = v; });
    const tick = () => new Promise(r => setImmediate(r));
    await tick();
    const child = fake.children[0];
    for (const chunk of [`${COMMAND}\n`, `Welcome!\n${BEGIN}\n/opt/a:`, "/usr/bin\n", `${END.slice(0, 5)}`]) {
      child.stdout.emit("data", chunk);
      await tick();
      expect(got, JSON.stringify(chunk)).toBe("pending");
    }
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.emit("data", `${END.slice(5)}\n`);
    expect(await read).toBe("/opt/a:/usr/bin");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("is null when the markers never came", async () => {
    const fake = fakeSpawn({ stdout: "zsh: command not found: printenv\n" });
    expect(await readLoginShellPath({ env, platform: "linux", spawn: fake.spawn })).toBeNull();
  });

  it("is null when the shell could not be started", async () => {
    expect(await readLoginShellPath({ env, platform: "linux", spawn: fakeSpawn({ fail: true }).spawn })).toBeNull();
    expect(await readLoginShellPath({ env, platform: "linux", spawn: fakeSpawn({ throws: true }).spawn })).toBeNull();
  });

  it("is null when the shell outlives its deadline, and the shell is killed", async () => {
    const fake = fakeSpawn({ hang: true });
    expect(await readLoginShellPath({ env, platform: "linux", spawn: fake.spawn, timeoutMs: 20 })).toBeNull();
    // SIGKILL: an interactive bash ignores SIGTERM.
    expect(fake.children[0].kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("starts nothing on Windows, without a SHELL it can ask, or with AGENTS_DECK_NO_LOGIN_SHELL=1", async () => {
    const cases = [
      { env, platform: "win32" },
      { env: { PATH: "/usr/bin" }, platform: "linux" },
      { env: { SHELL: "", PATH: "/usr/bin" }, platform: "linux" },
      { env: { SHELL: "zsh", PATH: "/usr/bin" }, platform: "darwin" },
      { env: { SHELL: "/bin/tcsh", PATH: "/usr/bin" }, platform: "darwin" },
      { env: { ...env, AGENTS_DECK_NO_LOGIN_SHELL: "1" }, platform: "linux" },
    ];
    for (const c of cases) {
      const fake = fakeSpawn({ stdout: block("/opt/a") });
      expect(await readLoginShellPath({ ...c, spawn: fake.spawn }), JSON.stringify(c)).toBeNull();
      expect(fake.calls, JSON.stringify(c)).toEqual([]);
    }
  });
});

describe("adopting it into the deck's environment", () => {
  it("appends the missing folders to env.PATH and says how many", async () => {
    const env: Record<string, string> = { PATH: "/usr/bin:/bin" };
    const read = vi.fn(async () => `${NVM_BIN}:/usr/bin:/bin`);
    expect(await adoptLoginShellPath({ env, platform: "linux", read })).toEqual({ added: 1 });
    expect(env.PATH).toBe(`/usr/bin:/bin:${NVM_BIN}`);
    expect(read).toHaveBeenCalledWith({ env, platform: "linux" });
  });

  it("asks once per process: the second call is the first call's promise", async () => {
    const env: Record<string, string> = { PATH: "/usr/bin" };
    const read = vi.fn(async () => "/opt/a");
    const first = adoptLoginShellPath({ env, platform: "linux", read });
    const second = adoptLoginShellPath({ env, platform: "linux", read: vi.fn(async () => "/opt/b") });
    expect(second).toBe(first);
    expect(await second).toEqual({ added: 1 });
    expect(read).toHaveBeenCalledTimes(1);
    expect(env.PATH).toBe("/usr/bin:/opt/a");
  });

  it("leaves env.PATH alone when the shell gave nothing, or nothing new", async () => {
    const env: Record<string, string> = { PATH: "/usr/bin:/bin" };
    expect(await adoptLoginShellPath({ env, platform: "linux", read: async () => null })).toEqual({ added: 0 });
    expect(env.PATH).toBe("/usr/bin:/bin");
    resetLoginShellPathAdoption();
    expect(await adoptLoginShellPath({ env, platform: "linux", read: async () => "/bin:/usr/bin" })).toEqual({ added: 0 });
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("never rejects", async () => {
    const env: Record<string, string> = { PATH: "/usr/bin" };
    await expect(adoptLoginShellPath({ env, platform: "linux", read: async () => { throw new Error("boom"); } }))
      .resolves.toEqual({ added: 0 });
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("the sign-in's rule: resolve, and only when that is nothing runnable, adopt and resolve again", () => {
  it("starts no shell when the first answer runs", async () => {
    const adopt = vi.fn(async () => ({ added: 0 }));
    const resolve = vi.fn(() => "/home/alice/.local/bin/claude");
    expect(await resolveWithLoginShell({ resolve, runnable: () => true, adopt })).toBe("/home/alice/.local/bin/claude");
    expect(adopt).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("adopts once and answers the second resolution when the first is not runnable", async () => {
    const order: string[] = [];
    let adopted = false;
    const adopt = vi.fn(async () => { order.push("adopt"); adopted = true; return { added: 1 }; });
    const resolve = vi.fn(() => { order.push("resolve"); return adopted ? "claude" : "claude-not-on-path"; });
    expect(await resolveWithLoginShell({ resolve, runnable: (bin: string) => bin === "claude", adopt })).toBe("claude");
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["resolve", "adopt", "resolve"]);
  });

  it("answers the second resolution even when adopting failed", async () => {
    const adopt = vi.fn(async () => { throw new Error("boom"); });
    expect(await resolveWithLoginShell({ resolve: () => "claude", runnable: () => false, adopt })).toBe("claude");
    expect(adopt).toHaveBeenCalledTimes(1);
  });

  it("is what cswap-admin.mjs's claudeBin runs, over adminClaudeBin and claudeRunnable", () => {
    const src = readFileSync(fileURLToPath(new URL("../../server/cswap-admin.mjs", import.meta.url)), "utf8");
    expect(src).toMatch(/async function claudeBin\(\) \{\s*return resolveWithLoginShell\(\{ resolve: \(\) => adminClaudeBin\(\), runnable: \(bin\) => claudeRunnable\(bin\) \}\);\s*\}/);
    expect(src).toMatch(/runInteractive\(bin, args, \{ timeout: LOGIN_TIMEOUT_MS \}\)/);
  });
});

describe("whether a resolved claude is runnable", () => {
  it("is a stat for a path and a PATH walk for a bare name", () => {
    const disk = (...files: string[]) => (p: string) => files.includes(String(p));
    expect(claudeRunnable("/opt/claude", { platform: "linux", env: { PATH: "" }, exists: disk("/opt/claude") })).toBe(true);
    expect(claudeRunnable("/opt/claude", { platform: "linux", env: { PATH: "" }, exists: disk() })).toBe(false);
    expect(claudeRunnable("claude", { platform: "linux", env: { PATH: `/usr/bin:${NVM_BIN}` }, exists: disk(`${NVM_BIN}/claude`) })).toBe(true);
    expect(claudeRunnable("claude", { platform: "linux", env: { PATH: "/usr/bin:/bin" }, exists: disk(`${NVM_BIN}/claude`) })).toBe(false);
    expect(claudeRunnable("", { platform: "linux", env: { PATH: "/usr/bin" }, exists: () => true })).toBe(false);
  });

  it("is the same question the installer asks, from one place", () => {
    expect(installerFindsClaude).toBe(deckFindsClaude);
  });
});

describe("the boot's half", () => {
  it("fires the adoption, without waiting, when nothing names a claude and the deck finds none", () => {
    const env: Record<string, string> = { PATH: "/usr/bin" };
    const adopt = vi.fn(() => new Promise(() => { /* a shell that never answers */ }));
    expect(adoptLoginShellPathAtBoot({ env, platform: "darwin", findsClaude: () => false, adopt })).toBe(true);
    expect(adopt).toHaveBeenCalledWith({ env, platform: "darwin" });
  });

  it("starts nothing when the deck finds claude, when AGENTS_DECK_CLAUDE names one, or on Windows", () => {
    const adopt = vi.fn(async () => ({ added: 0 }));
    const findsClaude = vi.fn(() => true);
    expect(adoptLoginShellPathAtBoot({ env: { PATH: "/usr/bin" }, platform: "linux", findsClaude, adopt })).toBe(false);
    const notAsked = vi.fn(() => false);
    expect(adoptLoginShellPathAtBoot({ env: { AGENTS_DECK_CLAUDE: "/opt/claude" }, platform: "linux", findsClaude: notAsked, adopt })).toBe(false);
    expect(adoptLoginShellPathAtBoot({ env: { PATH: "C:\\Windows" }, platform: "win32", findsClaude: notAsked, adopt })).toBe(false);
    expect(notAsked).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
  });

  it("never throws into the boot", () => {
    const adopt = vi.fn(async () => { throw new Error("boom"); });
    expect(adoptLoginShellPathAtBoot({ env: {}, platform: "linux", findsClaude: () => { throw new Error("stat"); }, adopt })).toBe(false);
    expect(adoptLoginShellPathAtBoot({ env: {}, platform: "linux", findsClaude: () => false, adopt })).toBe(true);
  });

  it("is fired by bin/deck.js below the second start and above startServer, and not awaited", () => {
    const deck = readFileSync(fileURLToPath(new URL("../../../bin/deck.js", import.meta.url)), "utf8");
    const ask = deck.indexOf("await settleSecondStart(");
    const fire = deck.indexOf("adoptLoginShellPathAtBoot({ findsClaude: () => deckFindsClaude() });");
    const bind = deck.indexOf("const starting = startServer({");
    expect(ask).toBeGreaterThan(0);
    expect(fire).toBeGreaterThan(ask);
    expect(bind).toBeGreaterThan(fire);
    expect(deck).not.toMatch(/await adoptLoginShellPathAtBoot/);
  });
});

/** Whether `pid` is gone: no such process, or (Linux) a zombie nobody has reaped yet. */
function processGone(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return true; }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return false;
  }
}

// The two cases that run a real stand-in shell script. The deck never asks a
// shell on Windows; everything else above runs on all three legs.
describe.skipIf(process.platform === "win32")("a deck whose PATH never read the shell's startup files (the reported bug)", () => {
  it("answers as soon as the PATH is printed though a background job holds stdout, and kills that job", async () => {
    const root = mkdtempSync(join(ROOT, "lazy-"));
    const pidFile = join(root, "sleeper.pid");
    mkdirSync(join(root, "shells"));
    const shell = join(root, "shells", "zsh");
    // An rc file that starts a lazy loader in the background: it inherits
    // stdout and outlives the shell, so the pipe never closes on its own.
    writeFileSync(shell, [
      "#!/bin/sh",
      "sleep 30 &",
      `echo $! > '${pidFile}'`,
      `echo ${BEGIN}`,
      "printf '%s\\n' '/opt/lazy/bin:/usr/bin:/bin'",
      `echo ${END}`,
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(shell, 0o755);

    const started = Date.now();
    const path = await readLoginShellPath({ env: { SHELL: shell, PATH: "/usr/bin:/bin", HOME: root }, timeoutMs: 5_000 });
    const took = Date.now() - started;
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try {
      expect(path).toBe("/opt/lazy/bin:/usr/bin:/bin");
      expect(took).toBeLessThan(2_000);
      expect(pid).toBeGreaterThan(1);
      // Killed with the shell's group; whoever adopted it reaps it a moment later.
      const deadline = Date.now() + 2_000;
      while (!processGone(pid) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
      expect(processGone(pid), "the background job outlived the read").toBe(true);
    } finally {
      if (pid > 1 && !processGone(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
  });

  it("finds the nvm claude the login shell puts on PATH, and only after asking it", async () => {
    const root = mkdtempSync(join(ROOT, "machine-"));
    // The install the user's terminal finds: an nvm-style folder no list knows.
    // A stand-in that is never run.
    const nvmBin = join(root, "nvm", "bin");
    mkdirSync(nvmBin, { recursive: true });
    const claude = join(nvmBin, "claude");
    writeFileSync(claude, "#!/bin/sh\nexit 0\n");
    chmodSync(claude, 0o755);
    // The user's login shell: ignores its arguments, greets like an rc file,
    // and prints the PATH that rc file set between the markers.
    mkdirSync(join(root, "shells"));
    const shell = join(root, "shells", "bash");
    writeFileSync(shell, [
      "#!/bin/sh",
      "echo 'Welcome back! (from .bashrc)'",
      `echo ${BEGIN}`,
      `printf '%s\\n' '${nvmBin}:/usr/bin:/bin'`,
      `echo ${END}`,
      "",
    ].join("\n"));
    chmodSync(shell, 0o755);

    const env: Record<string, string> = { SHELL: shell, PATH: "/usr/bin:/bin", HOME: root };
    // Only this temp tree counts as disk, so a claude installed on the machine
    // running the suite — /usr/local/bin, beside node — cannot answer for it.
    const exists = (p: string) => String(p).startsWith(`${root}/`) && existsSync(p);

    expect(deckFindsClaude({ platform: "linux", env, home: root, exists })).toBe(false);
    expect(claudeRunnable(adminClaudeBin("linux", env, root, exists), { platform: "linux", env, exists })).toBe(false);

    expect(await adoptLoginShellPath({ env })).toEqual({ added: 1 });
    expect(env.PATH).toBe(`/usr/bin:/bin:${nvmBin}`);

    expect(deckFindsClaude({ platform: "linux", env, home: root, exists })).toBe(true);
    const bin = adminClaudeBin("linux", env, root, exists);
    expect(bin).toBe("claude");
    expect(claudeRunnable(bin, { platform: "linux", env, exists })).toBe(true);
  });
});
