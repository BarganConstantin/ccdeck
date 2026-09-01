// What the watch does when it finds something, and — mostly — what it refuses
// to offer.
//
// The rule this file exists for: a reaction a platform cannot carry out must
// never appear in the panel. A mode that silently does nothing is worse than
// one that was never offered, because the user arms it, believes they are
// covered, and finds out on the day it mattered.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  appName, available, closeTabScript, closeTab, notify, performable, quitBrowser, react,
} from "../../server/browser-react.mjs";

const src = readFileSync(
  fileURLToPath(new URL("../../server/browser-react.mjs", import.meta.url)), "utf8");

/** A fake `run` that records what it was asked to do. */
function recorder(result: { ok: boolean; stdout?: string } = { ok: true, stdout: "closed" }) {
  const calls: { cmd: string; args: string[] }[] = [];
  return { calls, run: async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return result; } };
}

describe("what each platform is allowed to offer", () => {
  it("offers closing one tab only where one tab can be closed", () => {
    // AppleScript is the one interface that can close a single tab BY URL. On
    // Windows the nearest thing matches on the page title, which two tabs can
    // share; under Wayland there is nothing at all.
    expect(available("darwin")).toEqual(["notify", "close-tab", "quit-browser"]);
    expect(available("win32")).toEqual(["notify", "quit-browser"]);
    expect(available("linux")).toEqual(["notify", "quit-browser"]);
  });

  it("refuses a stored setting the current platform cannot perform", () => {
    // A store written on a Mac and carried to a Linux machine. The setting is
    // still in the file; it must not silently do nothing.
    expect(performable("close-tab", "darwin")).toBe(true);
    expect(performable("close-tab", "linux")).toBe(false);
    expect(performable("notify", "linux")).toBe(true);
  });

  it("does nothing at all for a browser it has no name for", async () => {
    // Guessing an application name means telling the wrong program to quit.
    expect(await closeTab("netscape", "https://x.example", "darwin", { run: recorder().run }))
      .toEqual({ ok: false, reason: "unknown_browser" });
    expect(await quitBrowser("netscape", "darwin", { run: recorder().run }))
      .toEqual({ ok: false, reason: "unknown_browser" });
    expect(appName("brave")).toBe("Brave Browser");
    expect(appName("netscape")).toBeNull();
  });
});

describe("the URL never reaches the script source", () => {
  it("passes it as an argument, on every path that takes one", async () => {
    // The whole premise of this feature is that somebody else may have opened
    // that page, so its address is the last string in the deck that should be
    // pasted into a script. The shell tool this descends from verified that an
    // interpolated URL could reach `do shell script`.
    const rec = recorder();
    await closeTab("brave", "https://evil.example/\" & (do shell script \"id\") & \"", "darwin", { run: rec.run });
    const [call] = rec.calls;
    expect(call.cmd).toBe("osascript");
    // The script is one argument and the url is another; the script contains
    // neither the url nor any part of it.
    const script = call.args[1];
    expect(script).not.toContain("evil.example");
    expect(script).not.toContain("do shell script");
    expect(call.args.at(-1)).toContain("evil.example");
    expect(script).toContain("item 1 of argv");
  });

  it("keeps the host out of the notification source too", async () => {
    // The one place the tool this descends from had left the pattern it banned
    // everywhere else: it built its notification by interpolation.
    const rec = recorder({ ok: true });
    await notify("Browser watch", 'evil"; do shell script "id', "darwin", { run: rec.run });
    const script = rec.calls[0].args[1];
    expect(script).not.toContain("evil");
    expect(script).toContain("item 2 of argv");
    expect(rec.calls[0].args).toContain('evil"; do shell script "id');
  });

  it("interpolates only the application name, and only from the table", () => {
    // AppleScript will not load an app's terminology from a variable — `tell
    // application appName` leaves `tabs` and `URL` unresolvable — so this one
    // string has to be interpolated. It comes from a fixed table.
    const script = closeTabScript("Brave Browser");
    expect(script).toContain('tell application "Brave Browser"');
    // And the guard that stops the script LAUNCHING a browser the user quit.
    expect(script).toContain('if application "Brave Browser" is not running then return "not-running"');
  });
});

describe("what it reports", () => {
  it("calls a tab closed only when the script says it closed one", async () => {
    for (const [said, ok] of [["closed", true], ["missing", false], ["not-running", false]] as const) {
      const out = await closeTab("brave", "https://x.example", "darwin",
        { run: recorder({ ok: true, stdout: `${said}\n` }).run });
      expect(out.ok, said).toBe(ok);
      expect(out.reason, said).toBe(said);
    }
  });

  it("does not claim to have closed anything on a platform that cannot", async () => {
    expect(await closeTab("brave", "https://x.example", "linux", { run: recorder().run }))
      .toEqual({ ok: false, reason: "unsupported" });
  });
});

describe("reacting to an episode", () => {
  const episode = {
    host: "gitlab.example.com", browser: "brave", count: 3,
    startMs: 1, endMs: 2,
    urls: [{ url: "https://gitlab.example.com/a", timeMs: 1 }, { url: "https://gitlab.example.com/b", timeMs: 2 }],
  };

  it("always notifies, whatever else it does", async () => {
    // A tab that closed itself with no explanation is a mystery rather than a
    // warning, and the point of the feature is that the user finds out.
    for (const reaction of ["notify", "close-tab", "quit-browser"]) {
      const rec = recorder({ ok: true, stdout: "closed" });
      const done = await react(reaction, episode, { platform: "darwin", deps: { run: rec.run } });
      expect(done[0], reaction).toBe("notified");
    }
  });

  it("closes every page in the run, not just the first", async () => {
    // An episode is a run. Closing only its first page leaves the rest open.
    const rec = recorder({ ok: true, stdout: "closed" });
    const done = await react("close-tab", episode, { platform: "darwin", deps: { run: rec.run } });
    expect(done.filter(d => d.startsWith("closed"))).toHaveLength(2);
  });

  it("notifies and stops where the reaction cannot be performed", async () => {
    const rec = recorder({ ok: true });
    const done = await react("close-tab", episode, { platform: "linux", deps: { run: rec.run } });
    expect(done).toEqual(["notified"]);
    // One call, the notification. Nothing tried to close anything.
    expect(rec.calls).toHaveLength(1);
  });
});

describe("how the watch arms it", () => {
  const watch = readFileSync(
    fileURLToPath(new URL("../../server/browser-watch.mjs", import.meta.url)), "utf8");

  it("reacts only to what is new, and only after the record is written", () => {
    // An episode still growing must not notify again on every page it gains —
    // that is the difference between a watch and a nuisance. And a reaction
    // that closed a tab and then lost the record of why would leave the user
    // with a vanished page and nothing to read about it.
    const write = watch.indexOf("appendLog");
    const reactAt = watch.indexOf("deps.react ?? react");
    expect(reactAt, "the reaction runs before the record is written").toBeGreaterThan(write);
    expect(watch).toMatch(/for \(const episode of fresh\)/);
  });

  it("never lets a reaction fail the read", () => {
    expect(watch).toMatch(/\.catch\(\(\) => \[\]\)/);
  });

  it("tells the panel what this platform can do, rather than letting it guess", () => {
    expect(watch).toMatch(/reactions: available\(platform\)/);
  });
});
