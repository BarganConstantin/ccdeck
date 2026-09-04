// Which browsers are on this machine, which are running, and what can honestly
// be said about whether any of them is talking to the relay.
//
// THE ANSWER IS MOSTLY "I CANNOT TELL", AND SAYING SO IS THE FEATURE. Two facts
// measured on the machine this was written on decide the whole shape of this
// file:
//
//   dig +short bridge.claudeusercontent.com  ->  160.79.104.10
//   dig +short api.anthropic.com             ->  160.79.104.10
//
// The relay shares an address with the API and with claude.ai. An established
// connection to it is therefore NOT evidence of a relay session — an open
// claude.ai tab is indistinguishable — and blocking by address would sever
// Claude Code itself, which is why the killswitch blocks the NAME.
//
//   lsof -nP -i TCP -a -c "Brave Browser"  ->  14 lines
//   lsof -nP -i TCP -a -c "Google Chrome"  ->  0 lines
//
// And lsof cannot see some browsers' sockets at all. Zero lines for a browser
// that is plainly running is a blind probe, not a quiet one, so absence is not
// evidence either.
//
// Both directions therefore fail, and the honest report has three states rather
// than two: `live` (with the caveat attached), `none-seen` (the probe worked and
// found nothing) and `unknown` (the probe could not see, or does not exist on
// this platform). There is deliberately no state that means "definitely not
// connected", because nothing here can establish that.
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { browserRoots, hasExtension, profileDirs } from "./browser-profiles.mjs";
import { run } from "./exec.mjs";

/**
 * The name each browser's processes carry — PER PLATFORM, because they do not
 * agree.
 *
 * This used to be one table of macOS bundle display names, sent to all three
 * probes. `tasklist /FI "IMAGENAME eq Google Chrome.exe"` matches nothing and
 * exits **0** printing `INFO: No tasks are running…`, so the probe read
 * `ok: true` and returned a confident `false`; `pgrep -x "Google Chrome"`
 * matches against `comm`, which on Linux is `chrome`. Every browser on Windows
 * and Linux therefore reported "not running", `relayLink` was never called, and
 * the relay half of this panel was dead on two of the three platforms — while
 * the module's own header forbids exactly that: a state that means "definitely
 * not connected" when nothing established it.
 *
 * Arc is macOS-only and has no entry elsewhere, which is the honest answer: a
 * root with no name here is reported as installed and never as running.
 */
const APP_NAME = {
  darwin: {
    chrome: "Google Chrome",
    "chrome-beta": "Google Chrome Beta",
    "chrome-canary": "Google Chrome Canary",
    chromium: "Chromium",
    brave: "Brave Browser",
    edge: "Microsoft Edge",
    vivaldi: "Vivaldi",
    arc: "Arc",
  },
  // Image names, which is what tasklist's IMAGENAME filter compares against.
  // The probe appends `.exe`, so these are spelled without it, exactly as the
  // POSIX ones are.
  win32: {
    chrome: "chrome",
    "chrome-beta": "chrome",
    "chrome-canary": "chrome",
    chromium: "chrome",
    brave: "brave",
    edge: "msedge",
    vivaldi: "vivaldi",
  },
  // `comm`, which is what `pgrep -x` matches and what the packages install as.
  linux: {
    chrome: "chrome",
    "chrome-beta": "chrome",
    "chrome-canary": "chrome",
    chromium: "chromium",
    brave: "brave",
    edge: "msedge",
    vivaldi: "vivaldi-bin",
  },
};

/** The process name for a browser on a platform, or null when this platform
 *  has no name for it — which is a different answer from "not running". */
export function processName(key, platform = process.platform) {
  const table = APP_NAME[platform] ?? APP_NAME.linux;
  return table[key] ?? null;
}

/** Every address the relay currently resolves to.
 *
 *  Empty is not an error — a machine with no `dig`, or one where the name is
 *  already blocked in /etc/hosts, both land here — and an empty list makes
 *  every connection probe answer `unknown`, which is the correct answer when
 *  there is nothing to compare against. */
export async function relayAddresses(host, deps = {}) {
  const exec = deps.run ?? run;
  const out = await exec("dig", ["+short", host]).catch(() => null);
  if (!out?.ok) return [];
  return String(out.stdout ?? "").split("\n")
    .map(l => l.trim())
    .filter(l => /^[0-9.]+$/.test(l) || /^[0-9a-f:]+$/i.test(l) && l.includes(":"));
}

/** Whether a named application has any process at all. */
export async function isRunning(app, platform = process.platform, deps = {}) {
  const exec = deps.run ?? run;
  if (platform === "win32") {
    const out = await exec("tasklist", ["/FI", `IMAGENAME eq ${app}.exe`, "/NH"]).catch(() => null);
    if (!out?.ok) return null;
    return String(out.stdout ?? "").toLowerCase().includes(`${app.toLowerCase()}.exe`);
  }
  const out = await exec("pgrep", ["-x", app]).catch(() => null);
  // pgrep exits 1 when it matched nothing, which `run` reports as not-ok — the
  // same shape as "pgrep is missing". Distinguished by whether it said anything
  // on stderr, because only one of the two is a failure to ask.
  if (out === null) return null;
  if (out.ok) return true;
  return String(out.stderr ?? "").trim() === "" ? false : null;
}

/**
 * What can be said about this browser's connections to the relay.
 *
 * -> { state: "live" | "none-seen" | "unknown", count, why }
 *
 * `why` is not decoration. Every one of these three answers is qualified, and a
 * panel that showed the state without the qualification would be making a claim
 * this module has already established it cannot make.
 */
export async function relayLink(app, addresses, platform = process.platform, deps = {}) {
  const exec = deps.run ?? run;
  if (platform === "win32") {
    return { state: "unknown", count: 0, why: "this check needs lsof, which Windows does not have" };
  }
  if (addresses.length === 0) {
    return { state: "unknown", count: 0, why: "the relay name did not resolve, so there is nothing to match against" };
  }
  const out = await exec("lsof", ["-nP", "-i", "TCP", "-a", "-c", app]).catch(() => null);
  if (out === null) return { state: "unknown", count: 0, why: "lsof is not available here" };

  const lines = String(out.stdout ?? "").split("\n").filter(l => l.trim() !== "");
  // A browser with no visible sockets at all is a BLIND probe, not a quiet one.
  // Measured: lsof sees fourteen TCP lines for Brave and zero for Google Chrome
  // while both are running. Reporting "none seen" here would turn "I cannot
  // look" into "I looked and it was clear".
  if (lines.length <= 1) {
    return { state: "unknown", count: 0, why: "lsof cannot see this browser's sockets, so absence proves nothing" };
  }
  const hit = lines.filter(l => l.includes("ESTABLISHED") && addresses.some(a => l.includes(a)));
  if (hit.length === 0) {
    return { state: "none-seen", count: 0, why: "no TCP connection to that address; QUIC would not appear here" };
  }
  return {
    state: "live",
    count: hit.length,
    why: "the relay shares an address with api.anthropic.com and claude.ai, so an open claude.ai tab looks the same",
  };
}

/**
 * Every browser this deck knows how to look at, whether or not it is here.
 *
 * Installed browsers with no profile are included on purpose. "Chrome is
 * installed and has never been opened" and "Chrome is not installed" are
 * different answers, and a panel that lists only what it found makes them
 * indistinguishable — which is the same failure browser-profiles.mjs guards
 * against one level down.
 */
export async function browserSurvey({
  relayHost,
  platform = process.platform,
  env = process.env,
  home,
  deps = {},
} = {}) {
  const exists = deps.existsSync ?? existsSync;
  const roots = browserRoots(platform, env, home);
  const addresses = await relayAddresses(relayHost, deps);

  const out = [];
  for (const root of roots) {
    const installed = exists(root.root);
    const profiles = installed ? profileDirs(root.root, deps.fs) : [];
    const app = processName(root.key, platform);
    const running = installed && app ? await isRunning(app, platform, deps) : false;
    out.push({
      key: root.key,
      name: root.name,
      installed,
      profiles: profiles.length,
      withExtension: profiles.filter(d => hasExtension(d, undefined, deps.fs)).map(d => basename(d)),
      running,
      relay: installed && running && app
        ? await relayLink(app, addresses, platform, deps)
        : { state: "unknown", count: 0, why: running ? "no process name known for this browser" : "not running" },
    });
  }
  return out;
}
