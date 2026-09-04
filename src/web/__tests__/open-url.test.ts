// The browser opens without a dependency, on all four platforms (#742).
//
// `open@10` was this package's only runtime dependency and brought nine more
// with it. Every one of them is fetched, extracted and linked on a cold `npx
// ccdeck` before the deck's own tarball is unpacked, for one call whose whole
// job is to hand a localhost URL to the desktop. src/server/open-url.mjs is
// what replaced it, and this file is the reason that swap is checkable from the
// Mac it was written on: the Windows command line and the Linux fallback chain
// are values a function returns, not behaviour only their own OS can show.
//
// Three of the four cases below cannot be run for real anywhere in this suite's
// CI matrix either — a Windows runner has no `xdg-open` to fall through and no
// WSL to be inside — so the command line is asserted as text. What that buys is
// exactly the mistake that would be silent otherwise: `start` without its empty
// title argument opens a console window named after the URL and no browser at
// all, and nothing on a developer's Mac would ever say so.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-expect-error — a plain .mjs module, no types
const { launchers, startCommand, isOpenable, isWsl, openUrl, LAUNCH_GRACE_MS } =
  await import("../../server/open-url.mjs");

const URL_ = "http://127.0.0.1:4317";

describe("launchers, per platform", () => {
  it("opens macOS through /usr/bin/open, by full path first", () => {
    const tries = launchers(URL_, { platform: "darwin", env: {} });
    expect(tries[0]).toEqual({ file: "/usr/bin/open", args: [URL_] });
    // The bare name is the fallback and not the first choice: `open` is a shell
    // builtin in a few setups and a user's own script by that name on the PATH
    // is not unheard of, while /usr/bin/open has been on every macOS this
    // package supports.
    expect(tries[1]).toEqual({ file: "open", args: [URL_] });
  });

  it("leads with PowerShell on Windows, which is the one with field evidence", () => {
    // `open@10` — the dependency this replaced — launches a Windows URL through
    // `powershell -EncodedCommand` running `Start "<url>"`. Read out of its own
    // source on a real Windows 10 box while checking this change. Every ccdeck
    // install on Windows has been using that path, and `cmd /c start` has no
    // such history.
    const [first] = launchers(URL_, { platform: "win32", env: {} });
    expect(first.file).toBe("powershell.exe");
    // The URL as its own argv entry rather than inside a script string, where
    // `;` and `&` are PowerShell's own operators.
    expect(first.args).toEqual(["-NoProfile", "-NonInteractive", "-Command", "Start-Process", URL_]);
  });

  it("does not lead with the launcher whose failure is invisible", () => {
    // Measured on Windows 10 19045 over SSH: `cmd /d /s /c start "" "<url>"`
    // exits 0 and creates no browser process. A candidate list that led with it
    // would never reach a second candidate however badly the first had done, so
    // the fallback would be decoration. Leading with the one whose failure is
    // visible is the only ordering in which having a fallback means anything.
    const files = launchers(URL_, { platform: "win32", env: {} }).map((t: any) => t.file);
    expect(files.indexOf("powershell.exe")).toBeLessThan(files.indexOf("cmd.exe"));
  });

  it("still gives cmd the empty title argument `start` needs", () => {
    const viaCmd = launchers(URL_, { platform: "win32", env: {} }).find((t: any) => t.file === "cmd.exe");
    // The empty string is the window TITLE. Without it `start "http://…"` opens
    // a console window named after the URL and no browser at all, which is the
    // one mistake here that nothing on a Mac would ever reveal.
    expect(viaCmd.args).toEqual(["/d", "/s", "/c", `start "" "${URL_}"`]);
    // Without this Node quotes the line a second time and cmd.exe receives
    // something it cannot parse — the same reason exec.mjs's viaCmd sets it.
    expect(viaCmd.opts).toEqual({ windowsVerbatimArguments: true });
  });

  it("keeps a way through when comspec points somewhere that is gone", () => {
    const files = launchers(URL_, { platform: "win32", env: { ComSpec: "D:\\gone\\cmd.exe" } })
      .map((t: any) => t.file);
    expect(files).toEqual(["powershell.exe", "D:\\gone\\cmd.exe", "cmd.exe"]);
    // And not twice when comspec is already the bare name.
    expect(launchers(URL_, { platform: "win32", env: { ComSpec: "cmd.exe" } }).map((t: any) => t.file))
      .toEqual(["powershell.exe", "cmd.exe"]);
  });

  it("honours comspec, because that is what Node does everywhere else here", () => {
    expect(startCommand(URL_, { ComSpec: "C:\\Windows\\System32\\cmd.exe" }).file)
      .toBe("C:\\Windows\\System32\\cmd.exe");
    expect(startCommand(URL_, { comspec: "D:\\cmd.exe" }).file).toBe("D:\\cmd.exe");
  });

  it("quotes the URL so a query string cannot end the command", () => {
    // No caller passes one today — bin/deck.js builds `http://127.0.0.1:PORT`
    // and nothing else. The quoting is here for the day one does, because an
    // unquoted `&` in cmd.exe does not fail: it runs the rest as a command.
    const { args } = startCommand("http://127.0.0.1:4317/?a=1&b=2", {});
    expect(args[3]).toBe('start "" "http://127.0.0.1:4317/?a=1&b=2"');
  });

  it("tries xdg-open first on Linux, and does not stop there", () => {
    const files = launchers(URL_, { platform: "linux", env: {}, wsl: false }).map((t: any) => t.file);
    expect(files[0]).toBe("xdg-open");
    // A machine without xdg-utils is not a machine without a browser. The rest
    // exist precisely there.
    expect(files).toContain("gio");
    expect(files).toContain("x-www-browser");
  });

  it("crosses to Windows on WSL, where xdg-open opens nothing anybody can see", () => {
    const files = launchers(URL_, { platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } }).map((t: any) => t.file);
    expect(files[0]).toBe("wslview");
    expect(files.some((f: string) => f.endsWith("cmd.exe"))).toBe(true);
    // Last rather than absent: a WSL that really does run a desktop exists.
    expect(files[files.length - 1]).toBe("xdg-open");
  });
});

describe("isWsl", () => {
  const noProc = () => "";

  it("is never true off Linux, whatever the environment says", () => {
    // WSL_DISTRO_NAME survives into a Windows terminal that launched something
    // through wsl.exe, so the platform check has to come first.
    expect(isWsl("win32", { WSL_DISTRO_NAME: "Ubuntu" }, noProc)).toBe(false);
    expect(isWsl("darwin", { WSL_INTEROP: "/run/WSL/1" }, noProc)).toBe(false);
  });

  it("reads the kernel when the environment has been scrubbed", () => {
    // Both signals exist because either can be missing: the variables are set
    // by the WSL launcher and lost by anything that clears the environment,
    // and /proc/version is the kernel's own answer.
    expect(isWsl("linux", {}, () => "Linux version 5.15.0-microsoft-standard-WSL2")).toBe(true);
    expect(isWsl("linux", {}, () => "Linux version 6.8.0-generic")).toBe(false);
    expect(isWsl("linux", { WSL_DISTRO_NAME: "Ubuntu" }, noProc)).toBe(true);
  });
});

describe("isOpenable", () => {
  it("takes http and https and nothing else", () => {
    expect(isOpenable("http://127.0.0.1:4317")).toBe(true);
    expect(isOpenable("https://example.com/x")).toBe(true);
  });

  it("refuses everything a launcher would happily run", () => {
    // The one caller builds its own localhost URL, so this is not guarding
    // against a hostile input today. It is guarding against the day a second
    // caller passes a path, because `start` would EXECUTE it.
    for (const bad of ["file:///etc/passwd", "/tmp/x.sh", "C:\\x.bat", "javascript:alert(1)", "", null, undefined]) {
      expect(isOpenable(bad as any)).toBe(false);
    }
  });
});

describe("openUrl", () => {
  const fakeChild = () => {
    const handlers: Record<string, ((...a: any[]) => void)[]> = {};
    return {
      on(ev: string, cb: (...a: any[]) => void) { (handlers[ev] ??= []).push(cb); return this; },
      unref() {},
      emit(ev: string, ...a: any[]) { for (const cb of handlers[ev] ?? []) cb(...a); },
    };
  };

  it("spawns nothing at all for a URL it will not open", () => {
    const spawnFn = vi.fn();
    openUrl("/tmp/x", { platform: "darwin", env: {}, spawnFn });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("moves to the next launcher when one is not installed", () => {
    const kids: any[] = [];
    const spawnFn = vi.fn(() => { const c = fakeChild(); kids.push(c); return c; });
    openUrl(URL_, { platform: "linux", env: {}, spawnFn });
    expect(spawnFn.mock.calls[0][0]).toBe("xdg-open");
    // ENOENT arrives on the child as an event, after spawn has already
    // returned — which is why this cannot be a try/catch.
    kids[0].emit("error", Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }));
    expect(spawnFn.mock.calls[1][0]).toBe("gio");
  });

  it("moves on when a launcher exits at once with nothing opened", () => {
    const kids: any[] = [];
    const spawnFn = vi.fn(() => { const c = fakeChild(); kids.push(c); return c; });
    openUrl(URL_, { platform: "linux", env: {}, spawnFn });
    // xdg-open's exit 3 is "no handler found for this scheme". Present,
    // executable, and no use.
    kids[0].emit("exit", 3);
    expect(spawnFn.mock.calls[1][0]).toBe("gio");
  });

  it("stops on the one that worked", () => {
    const kids: any[] = [];
    const spawnFn = vi.fn(() => { const c = fakeChild(); kids.push(c); return c; });
    openUrl(URL_, { platform: "darwin", env: {}, spawnFn });
    kids[0].emit("exit", 0);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("leaves a launcher that is still running alone", () => {
    // xdg-open stays up as the browser's parent on a cold start, so "has not
    // exited" is the success case and not a reason to try the next one.
    vi.useFakeTimers();
    try {
      const kids: any[] = [];
      const spawnFn = vi.fn(() => { const c = fakeChild(); kids.push(c); return c; });
      openUrl(URL_, { platform: "linux", env: {}, spawnFn });
      vi.advanceTimersByTime(LAUNCH_GRACE_MS + 1);
      // The browser window is closed an hour later and xdg-open finally exits
      // non-zero. Opening a second browser then would be absurd.
      kids[0].emit("exit", 1);
      expect(spawnFn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaches everywhere except Windows, where that means a console window", () => {
    const mac = vi.fn(() => fakeChild());
    openUrl(URL_, { platform: "darwin", env: {}, spawnFn: mac });
    expect(mac.mock.calls[0][2]).toMatchObject({ detached: true, stdio: "ignore" });

    const win = vi.fn(() => fakeChild());
    openUrl(URL_, { platform: "win32", env: {}, spawnFn: win });
    expect(win.mock.calls[0][2]).toMatchObject({ detached: false, windowsHide: true });
  });

  it("survives a spawn that throws outright", () => {
    let n = 0;
    const spawnFn = vi.fn(() => { if (n++ === 0) throw new Error("EACCES"); return fakeChild(); });
    expect(() => openUrl(URL_, { platform: "linux", env: {}, spawnFn })).not.toThrow();
    expect(spawnFn.mock.calls[1][0]).toBe("gio");
  });
});

describe("the dependency it replaced", () => {
  const pkg = JSON.parse(readFileSync(
    fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8"));

  it("is gone, and nothing has taken its place", () => {
    // The install-time claim this whole change is for. `open` pulled in nine
    // transitive packages; a runtime dependency added later would put the cost
    // back without anybody noticing, so the assertion is on the count and not
    // on the name.
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it("is not imported from anywhere any more", () => {
    const deck = readFileSync(fileURLToPath(new URL("../../../bin/deck.js", import.meta.url)), "utf8");
    expect(deck).not.toMatch(/import\(\s*["']open["']\s*\)/);
    expect(deck).toContain("open-url.mjs");
  });
});
