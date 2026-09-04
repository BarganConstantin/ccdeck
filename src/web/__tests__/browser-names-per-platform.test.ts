// The browser probes were asking for macOS bundle names on every platform.
//
// `APP_NAME` held "Google Chrome", "Brave Browser", "Microsoft Edge" — the
// names Finder shows — and sent them to all three probes:
//
//   * Windows got `tasklist /FI "IMAGENAME eq Google Chrome.exe"`, which
//     matches nothing and exits **0** printing `INFO: No tasks are running…`.
//     So `out.ok` was true and the probe returned a confident `false`.
//   * Linux got `pgrep -x "Google Chrome"`, which matches against `comm` —
//     `chrome`, `msedge`, `brave` — and procps-ng refuses a pattern longer than
//     15 characters outright.
//
// Every browser therefore read "not running" on two of the three platforms,
// `relayLink` was never called, and the relay half of the panel was dead there
// — while this module's own header forbids a state meaning "definitely not
// connected" that nothing established.
//
// The reaction had the same table mangled a third way: `quitBrowser` built
// `GoogleChrome.exe` and `google-chrome`, neither of which is a process, so
// `quit-browser` was offered on Windows and Linux and could never once have
// worked.
import { describe, it, expect } from "vitest";

// @ts-expect-error — .mjs server module, no types
const { processName, isRunning } = await import("../../server/browser-presence.mjs");
// @ts-expect-error — .mjs server module, no types
const { quitBrowser, notify } = await import("../../server/browser-react.mjs");

type Call = { cmd: string; args: string[]; opts?: { env?: Record<string, string> } };
const recorder = (result: unknown = { ok: true, stdout: "", stderr: "" }) => {
  const calls: Call[] = [];
  return { calls, run: async (cmd: string, args: string[], opts?: Call["opts"]) => { calls.push({ cmd, args, opts }); return result; } };
};

describe("the process name each platform actually uses", () => {
  it("is the image name on Windows and comm on Linux, not the Finder name", () => {
    expect(processName("chrome", "win32")).toBe("chrome");
    expect(processName("edge", "win32")).toBe("msedge");
    expect(processName("brave", "linux")).toBe("brave");
    expect(processName("edge", "linux")).toBe("msedge");
    expect(processName("vivaldi", "linux")).toBe("vivaldi-bin");
    expect(processName("chrome", "darwin")).toBe("Google Chrome");
  });

  it("keeps every POSIX pattern inside pgrep's 15-character limit", () => {
    // procps-ng refuses a longer pattern rather than truncating it, which is
    // how "Google Chrome Canary" produced an error rather than an answer.
    for (const key of ["chrome", "chrome-beta", "chrome-canary", "chromium", "brave", "edge", "vivaldi"]) {
      const name = processName(key, "linux");
      expect(name, key).toBeTruthy();
      expect(name.length, `${key} → ${name}`).toBeLessThanOrEqual(15);
    }
  });

  it("says it has no name rather than guessing one", () => {
    // Arc is macOS-only. A root with no entry is reported as installed and
    // never as running, which is the honest answer.
    expect(processName("arc", "win32")).toBe(null);
    expect(processName("arc", "linux")).toBe(null);
    expect(processName("nonesuch", "darwin")).toBe(null);
  });

  it("asks tasklist for a name it can match", async () => {
    const rec = recorder({ ok: true, stdout: "chrome.exe   4321 Console   1   250,000 K\n" });
    expect(await isRunning(processName("chrome", "win32"), "win32", { run: rec.run })).toBe(true);
    expect(rec.calls[0].args).toEqual(["/FI", "IMAGENAME eq chrome.exe", "/NH"]);
  });

  it("still reads tasklist's exit-0 'no tasks' as not running", async () => {
    const rec = recorder({ ok: true, stdout: "INFO: No tasks are running which match the specified criteria.\n" });
    expect(await isRunning(processName("brave", "win32"), "win32", { run: rec.run })).toBe(false);
  });
});

describe("quitting a browser", () => {
  it("kills the process, not the display name with its spaces removed", async () => {
    const win = recorder();
    await quitBrowser("chrome", "win32", { run: win.run });
    expect(win.calls[0]).toMatchObject({ cmd: "taskkill", args: ["/IM", "chrome.exe", "/F"] });

    const lin = recorder();
    await quitBrowser("edge", "linux", { run: lin.run });
    expect(lin.calls[0]).toMatchObject({ cmd: "pkill", args: ["-x", "msedge"] });
  });

  it("refuses a browser this platform has no name for", async () => {
    const rec = recorder();
    expect(await quitBrowser("arc", "linux", { run: rec.run })).toEqual({ ok: false, reason: "unknown_browser" });
    expect(rec.calls).toEqual([]);
  });

  it("still quits by application name on macOS, which is what AppleScript wants", async () => {
    const rec = recorder();
    await quitBrowser("brave", "darwin", { run: rec.run });
    expect(rec.calls[0].cmd).toBe("osascript");
    expect(rec.calls[0].args.at(-1)).toBe("Brave Browser");
  });
});

describe("the Windows toast", () => {
  it("passes its strings through the environment, not as trailing script text", async () => {
    // PowerShell documents that a string `-Command` must be the last
    // parameter: everything after it is appended to the command. `-t <title>
    // -b <body>` was therefore more script, pasted after `…Show($x)`, and the
    // toast never appeared at all.
    const rec = recorder({ ok: true });
    await notify("Browser watch", "gitlab.example.com — 3 pages", "win32", { run: rec.run });
    const [call] = rec.calls;
    expect(call.cmd).toBe("powershell.exe");
    expect(call.args.at(-1)).toContain("$env:CCDECK_TOAST_BODY");
    expect(call.args).not.toContain("-t");
    expect(call.args).not.toContain("-b");
    expect(call.opts?.env?.CCDECK_TOAST_TITLE).toBe("Browser watch");
    expect(call.opts?.env?.CCDECK_TOAST_BODY).toBe("gitlab.example.com — 3 pages");
  });

  it("keeps an attacker-chosen host out of the script text", async () => {
    // `body` carries `episode.host`, which came out of the browser's own
    // history — the premise of the feature is that somebody else may have
    // opened that page.
    const rec = recorder({ ok: true });
    const nasty = 'evil.example"; Start-Process calc; "';
    await notify("Browser watch", `${nasty} — 1 page`, "win32", { run: rec.run });
    const script = rec.calls[0].args.at(-1)!;
    expect(script).not.toContain("evil.example");
    expect(script).not.toContain("Start-Process");
    expect(rec.calls[0].opts?.env?.CCDECK_TOAST_BODY).toContain(nasty);
  });
});
