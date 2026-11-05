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
  installedVersion, isNpxInstall, isOneOffRun, oneOffRunner, isGitCheckout, npxRoot, bareSpecName, npxSpecFromMeta,
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

import { isOlder } from "./version-order.mjs";
export { isOlder } from "./version-order.mjs";


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
