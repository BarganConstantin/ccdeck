// Browser Watch's relay report: whether somebody else's Claude Code can drive
// the browsers on this machine, read off disk for relay-guard.mjs to judge.
//
// Moved out of browser-watch.mjs unchanged. relay-guard.mjs holds every rule
// and does no reading of its own; this file is the reading — the hosts file
// once, and each profile's Secure Preferences behind a cache keyed on the
// file's mtime (browser-watch-mtime.mjs, the stamp the History cache in
// browser-watch.mjs keys on too). The snapshot calls relayGuard on every poll
// that reads the browsers and puts its answer on the reply as `relay` (#799).
import { readFile } from "node:fs/promises";
import { mtimeMs } from "./browser-watch-mtime.mjs";
import { RELAY_HOST, hostsPath, readKillswitch, extensionReport, killswitchCommand, verdict } from "./relay-guard.mjs";

/** Secure Preferences reports, keyed on the file and its mtime — see
 *  `relayGuard` for why this one needs a cache more than the History read
 *  does. */
const extCache = new Map();

/**
 * What relay-guard can say about this machine, from two reads it does not do
 * itself.
 *
 * THE MODULE WAS BUILT AND NEVER PLUGGED IN (#799). Every export but
 * `RELAY_HOST` greped to its own declaration and its test, so the header's
 * promise — "the one command that closes it … hands back the command that would
 * change it, as text, for the user to paste" — reached no surface. A reader
 * auditing this repo's security posture would have believed the killswitch and
 * the grant report ship. This is that promise kept: the panel now renders both.
 *
 * relay-guard imports node:path and nothing else, on purpose, so the reading is
 * here. Two sources:
 *
 *   THE HOSTS FILE, once. Small, and the same file for every profile.
 *
 *   EACH PROFILE'S "Secure Preferences", only where `hasExtension` already said
 *   the directory is there. This one is why there is a cache: it is a single
 *   JSON document holding every extension's settings and it runs to megabytes
 *   on a profile with a few installed, while the panel polls every ten seconds.
 *   Keyed on mtime like the History cache in browser-watch.mjs, and for the
 *   same reason — a browser that is closed cannot invalidate it.
 *
 * A read that fails is not a report of "nothing installed": `null` for that
 * profile, and the aggregate says so. The difference matters here more than
 * anywhere else in Browser Watch, because the reassuring answer and the
 * unreadable answer are the same shape.
 */
export async function relayGuard(profiles, { platform, env, deps }) {
  const readOne = async (file) => {
    const stamp = mtimeMs(file, deps);
    if (stamp === null) return null;
    const hit = extCache.get(file);
    if (hit && hit.stamp === stamp) return hit.report;
    let report = null;
    try {
      report = extensionReport(JSON.parse(await (deps.readFile ?? readFile)(file, "utf8")));
    } catch {
      // Unreadable or not JSON — a profile being written as we looked, a
      // hardened profile we cannot open. Not cached, so the next poll retries.
      return null;
    }
    extCache.set(file, { stamp, report });
    return report;
  };

  const seen = [];
  for (const profile of profiles) {
    // `hasClaudeExt` is an existsSync on `Extensions/<id>` and is already
    // computed; it cannot see `enabled`, `allUrls` or `sensitiveApis`, which is
    // the whole reason this reads the preferences at all. But it is a free way
    // to skip every profile that has no extension to report on.
    if (!profile.hasClaudeExt) continue;
    const report = await readOne(profile.securePrefsPath);
    seen.push({
      browser: profile.browser,
      name: profile.name,
      profile: profile.profile,
      // Null when the file could not be read, which the panel says out loud
      // rather than rendering as an absence of permissions.
      report,
    });
  }

  let hostsText = null;
  const hosts = (deps.hostsPath ?? hostsPath)(platform, env);
  try { hostsText = await (deps.readFile ?? readFile)(hosts, "utf8"); } catch { /* no file, or no permission to read it */ }
  const killswitch = readKillswitch(hostsText);

  // ONE ENABLED COPY ANYWHERE IS ENOUGH, which is `verdict`'s own rule: the
  // relay is registered per ANTHROPIC ACCOUNT, not per profile, so a second
  // profile with the extension switched off protects nothing.
  const anyExtension = seen.some(p => p.report?.present === true && p.report.enabled === true);

  return {
    relayHost: RELAY_HOST,
    hostsPath: hosts,
    // Whether the hosts file could be read at all. `blocked: false` from an
    // unreadable file and `blocked: false` from a file with no entry are the
    // same value and not the same fact.
    hostsRead: typeof hostsText === "string",
    profiles: seen,
    anyExtension,
    killswitch,
    verdict: verdict({ anyExtension, blocked: killswitch.blocked }),
    // Both, always, so the panel can offer the one that matches the state
    // without having to know how either is spelled. Text only — nothing here
    // runs it, and relay-guard could not if it tried.
    command: {
      block: killswitchCommand(platform, { on: true }),
      unblock: killswitchCommand(platform, { on: false }),
    },
  };
}
