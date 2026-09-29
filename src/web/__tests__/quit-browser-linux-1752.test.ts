// On Linux the quit-browser reaction ran `pkill -x chrome` (#1752). Chrome,
// Chrome Beta and Chrome Canary all name their processes `chrome`, and so does
// every Playwright or Puppeteer browser, headless or not, each with a
// `--user-data-dir` of its own — so a finding in one Chrome quit all of them,
// test runs in progress included, and the feed said it had quit "the browser".
// The presence probe asked the same bare `pgrep -x chrome`, so Chrome Beta read
// as running whenever anything named `chrome` was.
//
// The Linux leg now signals only the process holding the lock in the profile's
// own user-data root, after checking in /proc that it is a browser's main
// process for that root and not a headless one. Anything it cannot establish is
// a `could not`, never a wider signal.
//
// NOTHING HERE RUNS OR SIGNALS ANYTHING. The machine is linux-browser-fixture.ts:
// a home, its locks and a /proc held in memory under a root that does not exist,
// and a `run` that records the argv it was handed and answers success.
import { describe, it, expect } from "vitest";
import { quitBrowser, react } from "../../server/browser-react.mjs";
import { browserSurvey } from "../../server/browser-presence.mjs";
import { HOME, linuxMachine } from "./linux-browser-fixture";

const CHROME = "/opt/google/chrome/chrome";
const PLAYWRIGHT = `${HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;

/** The user's Chrome (pid 100, no flags: its default root) and a headless
 *  Playwright Chromium (pid 200) with a profile in /tmp, both named `chrome`. */
function twoChromes() {
  const m = linuxMachine();
  m.started(100, [CHROME, "--enable-crashpad"]);
  m.lock(".config/google-chrome", 100);
  m.started(200, [PLAYWRIGHT, "--headless", "--user-data-dir=/tmp/playwright_chromiumdev_profile-Xk2Q"]);
  return m;
}

describe("quitting Chrome on Linux", () => {
  it("signals the Chrome holding the profile, and nothing else named chrome", async () => {
    const m = twoChromes();
    const out = await quitBrowser("chrome", "linux", m.deps);
    expect(m.signals(), "a name-wide signal reached every chrome process").toEqual([
      { cmd: "kill", args: ["-TERM", "100"] },
    ]);
    expect(out).toEqual({ ok: true, reason: "quit" });
  });

  it("does nothing for Chrome Beta when no Chrome Beta holds its profile", async () => {
    // Stable Chrome and a Playwright browser are both running. Neither is Beta.
    const m = twoChromes();
    const out = await quitBrowser("chrome-beta", "linux", m.deps);
    expect(m.signals()).toEqual([]);
    expect(out.ok).toBe(false);
    // And the feed says so, as the `could not` line react files as a warning.
    const done = await react("quit-browser", { host: "x.example", browser: "chrome-beta", count: 1, urls: [] },
      { platform: "linux", deps: m.deps, env: { AGENTS_DECK_NO_NOTIFY: "1" } });
    expect(done.at(-1)).toMatch(/^could not quit the browser — /);
    expect(m.signals()).toEqual([]);
  });

  it("refuses a lock whose pid is now a headless browser", async () => {
    // Chrome crashed and left its lock behind, and the pid came round again as
    // a Playwright run. A stale lock is the case where trusting it blindly
    // would quit somebody else's browser.
    const m = twoChromes();
    m.lock(".config/google-chrome", 200);
    expect(await quitBrowser("chrome", "linux", m.deps)).toMatchObject({ ok: false });
    expect(m.signals()).toEqual([]);
  });

  it("refuses a lock held for another user-data root", async () => {
    // The pid is a Chrome, and a non-headless one, but it was started on a
    // profile of its own: automation run headful, or a second instance.
    const m = linuxMachine();
    m.started(300, [CHROME, "--user-data-dir=/tmp/puppeteer_dev_chrome_profile-a1b2"]);
    m.lock(".config/google-chrome", 300);
    expect(await quitBrowser("chrome", "linux", m.deps)).toMatchObject({ ok: false });
    expect(m.signals()).toEqual([]);
  });

  it("accepts a lock held by a Chrome started on this very root by flag", async () => {
    const m = linuxMachine();
    m.started(400, [CHROME, `--user-data-dir=${HOME}/.config/google-chrome/`]);
    m.lock(".config/google-chrome", 400);
    expect(await quitBrowser("chrome", "linux", m.deps)).toEqual({ ok: true, reason: "quit" });
    expect(m.signals()).toEqual([{ cmd: "kill", args: ["-TERM", "400"] }]);
  });

  it("refuses a lock taken on another machine, and a pid that is not a browser at all", async () => {
    // A home on a network share: the lock names the host that holds it, and
    // that pid means nothing here.
    const far = linuxMachine();
    far.started(100, [CHROME]);
    far.lock(".config/google-chrome", 100, "other-host");
    expect(await quitBrowser("chrome", "linux", far.deps)).toMatchObject({ ok: false });
    expect(far.signals()).toEqual([]);

    const reused = linuxMachine();
    reused.started(500, ["/usr/bin/python3", "worker.py"]);
    reused.lock(".config/google-chrome", 500);
    expect(await quitBrowser("chrome", "linux", reused.deps)).toMatchObject({ ok: false });
    expect(reused.signals()).toEqual([]);
  });
});

describe("whether a Chrome channel is running, on Linux", () => {
  it("answers for the channel's own profile rather than for anything named chrome", async () => {
    const m = twoChromes();
    const installed = [`${HOME}/.config/google-chrome`, `${HOME}/.config/google-chrome-beta`];
    const rows = await browserSurvey({
      relayHost: "bridge.example.com", platform: "linux", env: {}, home: HOME,
      deps: {
        ...m.deps,
        existsSync: (p: string) => installed.includes(p),
        fs: { readdirSync: () => [], statSync: () => ({ isDirectory: () => true }), existsSync: () => false },
      },
    });
    const byKey = Object.fromEntries(rows.map((r: any) => [r.key, r]));
    expect(byKey["chrome-beta"].running, "Beta read as running because a chrome process exists").toBe(false);
    expect(byKey.chrome.running).toBe(true);
    expect(m.signals()).toEqual([]);
  });
});
