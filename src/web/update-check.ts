// What What's new says about updates, under its row of actions.
//
// "Check for updates" is a second door to things the deck already does, never
// a new way of doing them. The check is the version chip's own
// `loadVersion(true)`, so the server's floor and hour apply to it exactly as
// they do to the chip (npm-latest.mjs). The offer, once npm names a newer
// release, is whatever the update banner offers on this install
// (VersionBanner.tsx): Update now, Update & restart, or the command to run.
// Inside the desktop app, whose deck leaves updates to the app, there is no
// check this page can start, so the line reports the app's own updater and
// names the menu that can.
//
// A pure function of what the deck has already said, so every state and every
// channel can be pinned without a browser.
import type { DesktopUpdateState } from "./desktop-update";
import { agoLabel } from "./browser-watch-model";
import { ownRow } from "./own-row";
import type { VersionInfo } from "./use-version-check";

/** The banner's own action for this install, offered on the line. The two
 *  that update carry the banner's own sentence for what a press does, since
 *  the press closes the dialog and the deck restarts afterwards. */
export type UpdateLineAction =
  | { kind: "install"; label: string; busy: boolean; why: string }
  | { kind: "npx"; label: string; busy: boolean; why: string }
  | { kind: "copy"; label: string; busy: false };

/** The small line under the actions: the answer, and the way to act on it. */
export type UpdateLine = {
  /** The words, stable while time passes, so the live region they sit in
   *  speaks when the answer changes and not when a minute goes by. */
  said: string;
  /** How loud: an answer somebody asked for is in the text's ink, a standing
   *  note about this install in the muted one, and a check that came to
   *  nothing in the warning's, like the app update's own failed press. */
  tone: "answer" | "note" | "warn";
  /** When the answer was had, after the words and kept out of the live
   *  region: "Checked 4 min ago." */
  age: string | null;
  /** The command to type, when that is the offer. */
  command: string | null;
  action: UpdateLineAction | null;
};

export type UpdateCheckState = {
  /** Whether "Check for updates" is offered. It is not where no check can run:
   *  the line says why instead. */
  canCheck: boolean;
  /** A forced check is out: the button turns its arrow. */
  checking: boolean;
  line: UpdateLine;
};

export type UpdateCheckFacts = {
  version: VersionInfo | null;
  /** The version the chip wears. */
  running: string;
  /** A forced check is out, this row's or the chip's. */
  checking: boolean;
  /** A check has answered since the dialog opened. */
  answered: boolean;
  /** The last press got no answer from the deck at all. */
  unreachable: boolean;
  now: number;
  /** The banner's install, as use-deck-upgrade.ts reports it. */
  upgradeState: "idle" | "running" | "done" | "failed";
  /** The banner's copy button has just copied. */
  copied: boolean;
  /** The restart route is out — npx's update is a restart. */
  restarting: boolean;
  /** Inside the desktop app: its updater, its own version and the menu that can check. */
  app: { inApp: boolean; update: DesktopUpdateState | null; version: string | null; menu: string } | null;
};

export const CHECK_LABEL = "Check for updates";
export const CHECK_WHY = "Ask npm now whether a newer ccdeck is out.";
export const CHECKING = "Checking…";
export const NPM_UNREACHABLE = "Couldn't reach npm. Try again.";
export const DECK_UNREACHABLE = "Couldn't reach the deck. Try again.";
export const CHECKS_OFF = "Update checks are off on this deck (AGENTS_DECK_NO_UPDATE_CHECK or AGENTS_DECK_NO_INSTALL).";
export const PENDING_RETRY = "The deck looks again in five minutes.";

/** "3.38.7 is out", and why this install is offered a command rather than a
 *  button, in the banner's own words (VersionBanner.tsx's UPGRADE_BLOCK_TEXT).
 *  An own row, as the banner reads it (#474): the reason arrives over the wire. */
export function outWithReason(to: string, reasons: Record<string, string>, blocked: string | null | undefined, npxUnsupervised: boolean): string {
  const reason = npxUnsupervised ? reasons.npx : (blocked ? ownRow(reasons, blocked) : undefined);
  return reason ? `${to} is out, but ${reason}` : `${to} is out. Run:`;
}

const line = (said: string, more: Partial<UpdateLine> = {}): UpdateLine => ({ said, tone: "answer", age: null, command: null, action: null, ...more });
const note = (said: string): UpdateLine => line(said, { tone: "note" });

function ago(at: number, now: number): string {
  return agoLabel(at, now) ?? "just now";
}

/** The desktop app's own updater, which this page can read but not ask. Null
 *  once its update is ready: the door at the top of the dialog is that. */
function appLine(app: NonNullable<UpdateCheckFacts["app"]>, running: string): UpdateLine | null {
  const u = app.update;
  const where = `Check for updates in ${app.menu}`;
  if (u?.status === "ready") return null;
  if (u?.status === "checking") return note("The app is checking for updates…");
  if (u?.status === "downloading") return note(u.version ? `${u.version} is out. The app is downloading it.` : "The app is downloading an update.");
  if (u?.status === "current") return note(`You're on the latest, ${app.version ?? running}. To check again, use ${where}.`);
  if (u?.status === "error") return note(`The app's last update check failed. Try ${where}.`);
  return note(`The app keeps itself up to date. To check now, use ${where}.`);
}

/** npm names a newer release: the banner's offer for this install. */
function availableLine(f: UpdateCheckFacts, to: string, reasons: Record<string, string>): UpdateLine {
  const v = f.version;
  if (v?.upgradeMode === "install" && f.upgradeState !== "failed") {
    if (f.upgradeState === "done") return line(`${to} is installed.`);
    const busy = f.upgradeState === "running";
    const why = `Runs ${v.upgrade?.command ?? v.command} here, then restarts once nothing is running.`;
    return line(busy ? `Installing ${to}…` : `${to} is out.`, { action: { kind: "install", label: "Update now", busy, why } });
  }
  if (v?.upgradeMode === "npx" && v.canRestart) {
    const retry = f.upgradeState === "failed";
    return line(retry ? `The last update to ${to} came back on ${f.running}.` : `${to} is out.`, {
      action: {
        kind: "npx", label: retry ? "Retry update" : "Update & restart", busy: f.restarting,
        why: `Runs ${v.command} and hands it this port. Nothing is installed globally — npx unpacks its own copy.`,
      },
    });
  }
  const said = f.upgradeState === "failed"
    ? `Installing ${to} failed. Run it yourself:`
    : outWithReason(to, reasons, v?.upgradeBlocked, v?.upgradeMode === "npx");
  const command = v?.command ?? null;
  return line(said, { command, action: command ? { kind: "copy", label: f.copied ? "Copied" : "Copy", busy: false } : null });
}

/** Nothing to act on: what the last check found, or when it ran. */
function settledLine(f: UpdateCheckFacts): UpdateLine {
  const v = f.version;
  if (f.unreachable) return line(DECK_UNREACHABLE, { tone: "warn" });
  const failedAt = v?.checkFailedAt && v.checkFailedAt > (v.checkedAt ?? 0) ? v.checkFailedAt : null;
  if (failedAt) return line(NPM_UNREACHABLE, { tone: "warn", age: f.answered ? null : `Last tried ${ago(failedAt, f.now)}.` });
  const pending = v?.latestPending && v.latestPending !== f.running ? v.latestPending : null;
  if (pending) return line(`${pending} is tagged on npm but can't be installed yet. ${PENDING_RETRY}`);
  const checked = v?.checkedAt ? ago(v.checkedAt, f.now) : null;
  if (f.answered && v?.latest) {
    const said = v.latest === f.running ? `You're on the latest, ${f.running}.` : `You're on ${f.running}, ahead of npm's ${v.latest}.`;
    return line(said, { age: checked ? `Checked ${checked}.` : null });
  }
  return line("", { age: checked ? `Last checked ${checked}.` : null });
}

/**
 * What the dialog offers and says about updates, or null where the door at its
 * top already says it all: the desktop app's verified update.
 */
export function updateCheckState(f: UpdateCheckFacts, reasons: Record<string, string>): UpdateCheckState | null {
  const v = f.version;
  if (f.app?.inApp && v?.checkDisabled) {
    const l = appLine(f.app, f.running);
    return l && { canCheck: false, checking: false, line: l };
  }
  if (v?.checkDisabled) return { canCheck: false, checking: false, line: note(CHECKS_OFF) };

  const notice = v?.notice ?? null;
  if (notice?.kind === "upgrade") return { canCheck: true, checking: f.checking, line: availableLine(f, notice.to, reasons) };
  if (notice?.kind === "restart") {
    const said = v?.canRestart
      ? `${notice.to} is installed. Restart the deck to start running it.`
      : `${notice.to} is installed. Restart ccdeck to start running it.`;
    return { canCheck: true, checking: f.checking, line: line(said) };
  }
  if (f.checking) return { canCheck: true, checking: true, line: line(CHECKING) };
  return { canCheck: true, checking: false, line: settledLine(f) };
}

/** How long the button stays busy at the least. A check the server answers
 *  from its floor comes back in a few milliseconds, and an arrow that turns
 *  for one frame reads as a flicker rather than as a check. */
export const CHECK_MIN_BUSY_MS = 450;

/** The press: the chip's own forced check, held for at least the minimum. */
export async function runUpdateCheck(
  loadVersion: (force?: boolean) => Promise<VersionInfo | null>,
  wait: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
): Promise<"answered" | "unreachable"> {
  const [answer] = await Promise.all([loadVersion(true), wait(CHECK_MIN_BUSY_MS)]);
  return answer ? "answered" : "unreachable";
}
