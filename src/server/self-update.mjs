// Tells the deck when the code it is executing is no longer the code on disk.
//
// Node caches every module at import. A deck that was already running when
// `npm i -g agents-deck` replaced its files keeps executing the OLD code until
// the process restarts — and nothing says so. The terminal banner still prints
// the version it booted with, and the browser's __APP_VERSION__ is baked into
// whichever bundle it happened to load, so the UI can even show the NEW number
// while the server runs the old one.
//
// That is not theoretical. On 2026-08-12 a deck left running from before
// v1.30.4 kept spawning `claude --print /usage` once a minute, burning the
// whole hourly usage-endpoint budget and 429-ing claude-swap, while the fix sat
// unused on disk. The user had no way to see it.
//
// So we report three distinct versions:
//   running   — captured at boot by the caller, before an upgrade can land
//   installed — re-read from disk per call; what a restart would run
//   latest    — npm's dist-tag, fetched at most once an hour (CHECK_MS in
//               npm-latest.mjs, which also explains why it is not the daily
//               cadence it was)
//
// Installing is opt-in and narrow. `npm i -g` runs only when the user asks for
// it by name and only where it can actually work: a global install, on a
// directory we can write, outside a git checkout and outside an npx cache.
// Everywhere else this stays what it has always been — a printed command. That
// policy and the install are in npm-upgrade.mjs.
import { inApp } from "./app-host.mjs";
// Which install this is, which package would replace it, and the command that
// does — see install-layout.mjs. Exported from this file before they moved, and
// still.
import {
  installedVersion, PUBLISHED_NAME, registryName, upgradeCommand, upgradeName,
} from "./install-layout.mjs";
export {
  installedVersion, isNpxInstall, isOneOffRun, isGitCheckout, npxRoot, bareSpecName, npxSpecFromMeta,
  npxRestartSpec, ALIAS_PACKAGES, PUBLISHED_NAME, RETIRED_NAMES, currentName, installedName,
  hostRoot, hostNameFromMeta, hostPackage, successorRoot, frozenNameInstall, upgradeName,
  upgradeCommand, registryName,
} from "./install-layout.mjs";
// The registry check, its marker and its floor — see npm-latest.mjs. The
// version report reads its answer; the five names exported here were exported
// from this file before they moved, and still are.
import { latestOnNpm, readMarker } from "./npm-latest.mjs";
export { checkDue, lastKnownLatest, markerFileName, mayAskNpm, nextMarker } from "./npm-latest.mjs";
// The note a failed npx relaunch leaves behind — see restart-note.mjs. The
// version report reads it; the supervisor writes it through the names exported
// here, which were exported from this file before they moved, and still are.
import { readRestartFailure, restartFailureNotice } from "./restart-note.mjs";
export {
  claimRestartFailureKey, clearRestartFailure, readRestartFailure, recordRestartFailure,
  restartFailureFileName, restartFailureKey, restartFailureNotice,
} from "./restart-note.mjs";
// Whether this copy may install over itself, and the install — see
// npm-upgrade.mjs. The version report asks it why an upgrade is refused and how
// the last one went; the names exported here were exported from this file
// before they moved, and still are.
import { upgradeBlock, upgradeMode, upgradeStatus } from "./npm-upgrade.mjs";
export {
  lastMeaningfulLine, startUpgrade, upgradeBlock, upgradeBlockedReason, upgradeMode, upgradeSpec,
  upgradeStatus,
} from "./npm-upgrade.mjs";

// ── version comparison ───────────────────────────────────────────────────────

/** Numeric-segment compare of one version's parts: -1, 0 or 1. Non-numeric
 *  segments count as 0 and missing segments pad with 0, so "1.30" sorts before
 *  "1.30.1" and "1.9.0" before "1.10.0". */
function cmpParts(x, y) {
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** A version split at the FIRST `-`: the release on one side, the prerelease
 *  identifiers on the other, or null when there is no prerelease at all.
 *
 *  `+` stays inside the release half rather than starting a third part, which
 *  keeps build metadata reading exactly as it read before — `1.0.0+build.7`
 *  segments to [1,0,0,0,7] and therefore sorts above `1.0.0`. That is inherited
 *  behaviour rather than a design, this repo has never published one, and a
 *  change to it belongs in its own issue. */
function versionParts(v) {
  const nums = (s) => s.split(/[.+]/).map(n => parseInt(n, 10)).map(n => Number.isNaN(n) ? 0 : n);
  const dash = v.indexOf("-");
  if (dash === -1) return { release: nums(v), pre: null };
  return { release: nums(v.slice(0, dash)), pre: nums(v.slice(dash + 1)) };
}

/** True when `a` sorts before `b`.
 *
 *  A PRERELEASE SORTS BELOW THE RELEASE IT PRECEDES (#976), which is semver's
 *  rule and was not this function's. Splitting on `[.\-+]` and mapping
 *  non-numeric segments to 0 made `3.23.0-rc.1` segment to [3,23,0,0,1] — five
 *  numbers against the release's three, so it compared ABOVE `3.23.0` and the
 *  release compared below the candidate it was meant to supersede:
 *
 *      isOlder("3.23.0-rc.1", "3.23.0") = false    ← the release never looked newer
 *      isOlder("3.23.0", "3.23.0-rc.1") = true     ← and the deck would go backwards
 *
 *  What that costs is not a cosmetic ordering. `autoUpdate` defaults on, so a
 *  deck that has ended up on a prerelease — installed by hand by a tester, or
 *  by the dist-tag accident publish.yml now prevents — produces no upgrade
 *  notice when the real release ships, shows nothing in the banner, and has no
 *  way to come back off it from inside the product. A bad release can be
 *  followed by a good one; a fleet that cannot SEE the good one cannot be
 *  rescued by publishing it, which is why this half matters even with the
 *  dist-tag half in place.
 *
 *  Ordinary numeric ordering is untouched — the release halves are compared
 *  exactly as before — and so is build metadata; see versionParts.
 *
 *  cswap-install.mjs had this written out a second time, without the type guard
 *  below, and imports it from here now (#374). The two bodies were identical:
 *  swept over 271,441 version-string pairs they disagreed on none, and the
 *  guard was the whole difference — `isOlder(null, "1.0.0")` answers false here
 *  and threw a TypeError there. Nothing could reach that call with a non-string
 *  (both arguments are behind `typeof v === "string"` checks at the one call
 *  site), so this is the copy with a test behind it absorbing the one without,
 *  not a bug fix. That sweep is now one-sided on prerelease pairs and
 *  duplicated-helpers.test.ts says which, rather than asserting an equality
 *  that has deliberately stopped holding. */
export function isOlder(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = versionParts(a), y = versionParts(b);
  const release = cmpParts(x.release, y.release);
  if (release !== 0) return release < 0;
  // Same release. A version carrying a prerelease is below the plain one, and
  // never the other way round; two prereleases of one release compare on their
  // own identifiers, so rc.2 is above rc.1.
  if (x.pre && !y.pre) return true;
  if (!x.pre || !y.pre) return false;
  return cmpParts(x.pre, y.pre) < 0;
}

// ── the notice ───────────────────────────────────────────────────────────────

/** Pure: turns three version strings into at most one thing worth saying.
 *
 *  "restart" outranks "upgrade" because it is the free fix — the newer code is
 *  already on the machine and a restart is all that stands between the user and
 *  it. Once restarted, the next check surfaces the upgrade if one is still due. */
export function pickNotice({ running, installed, latest }) {
  if (running && installed && isOlder(running, installed)) {
    return { kind: "restart", from: running, to: installed };
  }
  const have = installed ?? running;
  if (have && latest && isOlder(have, latest)) {
    return { kind: "upgrade", from: have, to: latest };
  }
  return null;
}

/** Full answer for GET /api/version. Never throws, and answers the local half
 *  even when the registry is unreachable.
 *
 *  Network worst case is 2 x FETCH_TIMEOUT_MS, not one: the dist-tag lookup,
 *  plus — only when the tag has moved to a version this deck has not confirmed
 *  yet — the installability probe (see runCheck), each carrying its own
 *  AbortSignal timeout. That second request costs its timeout at most once per
 *  release; a deck sitting on the current release stays inside one. */
export async function versionReport({ running, pkgRoot, name = PUBLISHED_NAME, now = Date.now(), force = false }) {
  const installed = installedVersion(pkgRoot);
  // Asked about the package the command installs, not about the one this build
  // happens to be named after — see upgradeName — except that a retired name
  // is asked about as ccdeck, the only dist-tag that still moves (registryName).
  // `target` is what the command installs and what the failure note is filed
  // under; `asked` is whose version this reports and the marker it is cached in.
  const target = upgradeName(pkgRoot, name);
  const asked = registryName(pkgRoot, name);
  // Only an explicit opt-out silences the registry.
  //
  // A checkout used to be excluded here too, on the reasoning that its version
  // leads npm's. That reasoning holds for the COMMAND — telling someone to
  // `npm i -g` over their working copy is wrong — but not for the question.
  // Knowing a release shipped is useful however you would install it, and
  // suppressing the lookup meant `latest` was always null, so the upgrade
  // notice could never appear and the "this is a checkout" explanation had
  // nowhere to render. A checkout that is ahead of npm still says nothing:
  // isOlder decides that, not this.
  const skipRegistry =
    process.env.AGENTS_DECK_NO_UPDATE_CHECK === "1" ||
    process.env.AGENTS_DECK_NO_INSTALL === "1" ||
    inApp();
  const latest = skipRegistry ? null : await latestOnNpm(asked, now, force);
  const marker = skipRegistry ? null : readMarker(asked);
  const blocked = upgradeBlock(pkgRoot);
  // An install started in THIS process outranks the note on disk: it is newer
  // by construction, and a running one must not be reported as a past failure.
  // The note is read whatever the registry is doing — it is a local event, not
  // a lookup — so an offline deck still explains why its update did nothing.
  // Only the note addressed to this deck's own supervisor is read: the decks
  // sharing this home directory are usually the same package at the same
  // version, and none of them may answer for another's failed upgrade.
  const live = upgradeStatus();
  const upgrade = live.state === "idle"
    ? (restartFailureNotice(readRestartFailure(target), installed) ?? live)
    : live;
  return {
    name: target,
    running: running ?? null,
    installed,
    latest,
    // When npm last ANSWERED, so the UI can say it rather than leaving the
    // user to wonder whether the check runs at all. A lookup that failed does
    // not move this: "checked 2 minutes ago" over an hour-old answer is the
    // one thing this field must never say.
    checkedAt: marker?.at ?? null,
    // …and when it last failed, null once one succeeds. Without it, the single
    // most common reason for a missing update button — a proxy, a flaky line,
    // an offline machine — is indistinguishable from being up to date.
    checkFailedAt: marker?.failedAt ?? null,
    // A version npm's dist-tag names that the registry cannot serve yet — the
    // one thing `latest` deliberately will not say, since saying it is what
    // sent a deck into a restart that ended in ETARGET. Reported so the state
    // is visible rather than looking like nothing was published at all.
    latestPending: marker?.pending ?? null,
    checkDisabled: skipRegistry,
    notice: pickNotice({ running, installed, latest }),
    command: upgradeCommand(pkgRoot, name),
    // Why an in-app `npm i -g` is refused, when it is — so the UI can say so
    // instead of leaving a gap the user has to guess about. "npx" is a refusal
    // of the install, not of the update: upgradeMode says so.
    upgradeBlocked: blocked,
    upgradeMode: upgradeMode(blocked),
    upgrade,
  };
}
