// The banner that says the deck is behind — a newer version on disk or on npm —
// and offers the way forward: restart, upgrade, or the command to run.
//
// Moved out of App.tsx's markup unchanged. DeckBanner.tsx decides WHICH banner
// the strip under the topbar shows (a finished restart, then a lost
// connection, then this, then the old-name notice); this file is only what
// this one says and does. The restart and the upgrade are use-auto-restart's
// and use-deck-upgrade's operations, press guards included, and the props are
// typed from those hooks so the two cannot drift apart.
import { PRODUCT } from "../brand";
import { selfPressProps } from "../panel-press";
import { autoRestartLabel } from "../restart";
import type { useAutoRestart } from "../use-auto-restart";
import type { useDeckUpgrade } from "../use-deck-upgrade";
import type { VersionInfo, VersionNotice } from "../use-version-check";
import { ownRow } from "../own-row";

// Said in the UI's voice, not npm's. Each of these is a decision we made on
// purpose, so each gets a reason rather than a disabled button.
const UPGRADE_BLOCK_TEXT: Record<string, string> = {
  git_checkout: "this deck runs from a git checkout — pull instead:",
  npx: "npx runs from a cache that cannot be upgraded in place — run:",
  not_writable: "the install directory is not writable by this user — run:",
  opted_out: "installs are off (AGENTS_DECK_NO_INSTALL=1) — run:",
  // The deck was installed under a name npm no longer serves a deck for, so
  // reinstalling it would fetch a pointer package and take this install with
  // it. The command beneath this moves the machine onto the published name,
  // which is the only update it can have.
  retired_name: "this install came from a name that is no longer published — run:",
};

type Restart = ReturnType<typeof useAutoRestart>;
type Upgrade = ReturnType<typeof useDeckUpgrade>;

export default function VersionBanner({
  notice, version, dismissNotice,
  upgradeState, startUpgrade, copyCommand, cmdCopied,
  autoRestart, toggleAutoRestart, askRestart, restartCopy, restartFuseMs, restarting,
}: {
  /** What drifted, and which way: a restart would pick it up, or an upgrade would fetch it. */
  notice: VersionNotice;
  version: VersionInfo | null;
  dismissNotice: () => void;
  upgradeState: Upgrade["upgradeState"];
  startUpgrade: Upgrade["startUpgrade"];
  copyCommand: Upgrade["copyCommand"];
  cmdCopied: Upgrade["cmdCopied"];
  autoRestart: Restart["autoRestart"];
  toggleAutoRestart: Restart["toggleAutoRestart"];
  askRestart: Restart["askRestart"];
  restartCopy: Restart["restartCopy"];
  restartFuseMs: Restart["restartFuseMs"];
  restarting: Restart["restarting"];
}) {
  return (
    // Both banners want grid row 2, and a dead connection is the more
    // urgent of the two — the version notice waits its turn.
    <div className={`ver-banner ${notice.kind}`} role="status">
      {/* Still, until something is actually about to happen. It pulsed for
          days over a fact that does not change, in the one visual grammar
          this deck reserves for "running right now" — and it pulsed
          identically whether or not a restart was counting down, so the one
          moment motion would have carried information was the moment it
          carried none. */}
      <span className={`ver-dot${restartFuseMs == null ? "" : " armed"}`} />
      {notice.kind === "restart" ? (
        <>
          <strong>v{notice.to} is installed — this deck still runs v{notice.from}.</strong>
          {version?.canRestart ? (
            <>
              {/* #620: `disabled={restarting}` disabled the control the
                  press came from — askRestart sets `restarting` before its
                  first await — and the banner has no focus trap to hand
                  the keyboard back. The word already says which state it is
                  in; `aria-busy` says it to a reader, and askRestart's own
                  ref refuses the second press. */}
              {/* The word changes with the machine's own answer. `Restart
                  anyway` is the honest name for a press that drops the hook
                  events fired while the server is down — restart.ts:1 says
                  that is what happens — and it is a label rather than a
                  confirmation dialog because a modal over a live canvas is
                  worse than a true word. */}
              {/* WHY A RESTART IS NEEDED AT ALL, on the branch where the
                  reader can actually do something about it. The sentence
                  existed and rendered only under `canRestart: false` — the
                  one audience that cannot act on it. */}
              <button type="button" className="ver-act" onClick={() => askRestart()} {...selfPressProps(restarting)}
                title={"Stop this process and bring it back on the same port. The canvas replays from the event log.\n\n"
                  + "Node loads every module once, at startup. An upgrade replaces the files on disk but not the code already in memory, so this process keeps running the old version until it is restarted."}>
                {restarting ? "restarting…" : restartCopy.label}
              </button>
              {/* And the consequence, in the open. It was in a `title`,
                  which is reachable by mouse and by nothing else — the
                  defect this file spends a paragraph on thirty lines up. */}
              {!restarting && <span className="ver-sub">{restartCopy.clause}</span>}
              {/* The countdown is the cancel: a reader who can see fourteen
                  seconds has time to reach this switch, and one who sees
                  `auto when idle` has only the outcome.
                  aria-hidden on the changing half, with a stable name on the
                  button, because this banner is a role="status" — a label
                  that renamed itself every second would read the whole
                  banner out loud every second with it. */}
              {/* The shared switch (#886) with the state's word beside it, in
                  a label so pressing the word throws it too. The word stays
                  aria-hidden and the name stable, for the reason above. */}
              <label className="ver-auto">
              <button type="button" className="switch"
                role="switch" aria-checked={autoRestart} onClick={toggleAutoRestart}
                aria-label="Auto-restart when idle"
                title={autoRestart
                  ? "Updates on its own. While you are here it restarts once nothing has been running for 30 seconds; while you are away it also installs the new version first. Click to require a click instead."
                  : "Only updates when you click. Click to let it update itself when idle or while you are away."}>
                <span className="switch-knob" />
              </button>
              <span aria-hidden>{autoRestartLabel(autoRestart, restartFuseMs)}</span>
              </label>
            </>
          ) : (
            <span
              className="ver-sub"
              title="Node loads every module once, at startup. An upgrade replaces the files on disk but not the code already in memory, so this process keeps running the old version until it is restarted."
            >Restart it to pick up the new code.</span>
          )}
        </>
      ) : (
        <>
          {/* The product's name, not the `name` /api/version reports: that
              one is the npm package the registry was asked about, and it is
              `ccdeck`, `agents-deck` or `agent-dag` depending on how this
              deck was started. A release announcement whose subject changes
              with the install method names three products where there is
              one, and contradicts the wordmark directly above it. The
              package belongs where it is actionable — the button's title
              below, which is the command that actually installs. */}
          <strong>{PRODUCT} v{notice.to} is out — you are on v{notice.from}.</strong>
          {/* One button when we can actually install; the command, always,
              because the button can fail and the command never does.

              The tooltip's fallback matters more than it looks:
              `upgrade.command` is the vector npm was actually spawned with
              and exists only once an install has started, so before the
              first click the fallback is the whole of what it says — and a
              hardcoded `agents-deck` was wrong for every `npm i -g ccdeck`,
              which back then installed a launcher package of its own. #340
              removed that launcher, and the argument survives it: the name
              to reinstall is still whichever of the three the user typed,
              and this component has no way to know which. `version.command`
              is the server's own answer to the same question, correct in
              every install shape, and the same string the copy button
              carries. */}
          {version?.upgradeMode === "install" && upgradeState !== "failed" && (
            /* #620, and the one of the nine whose flag is not set in its
               own handler: `running` arrives from the /api/version poll a
               moment after the click, and the button is still the focused
               element when it does — the same drop, one round trip later.
               So `running` is this press's in-flight state and goes to
               `aria-busy`; `done` is not — the install has finished and
               there is nothing left to press, which is an unavailability
               `disabled` is exactly right for. */
            <button type="button" className="ver-act" onClick={startUpgrade}
              {...selfPressProps(upgradeState === "running", upgradeState === "done")}
              title={`Runs ${version?.upgrade?.command ?? version?.command ?? "npm i -g"} here, then restarts once nothing is running.`}>
              {upgradeState === "running" ? "installing…"
                : upgradeState === "done" ? "installed"
                : "Update now"}
            </button>
          )}
          {/* npx never installs anything — there is nothing here to install
              over. The update IS the restart: the supervisor re-runs the
              spec, npx unpacks a fresh copy, and it takes this port. */}
          {version?.upgradeMode === "npx" && version?.canRestart && (
            /* #620, the same as Restart now beside it: askRestart sets
               `restarting` before its first await, and this is the button
               the press came from. An npx fetch is measured in tens of
               seconds, so this is the longest of the four in App.tsx to
               spend with focus on `<body>`. */
            <button type="button" className="ver-act" onClick={() => askRestart({ upgrade: true })}
              {...selfPressProps(restarting)}
              title={`Runs ${version?.command} and hands it this port. Nothing is installed globally — npx unpacks its own copy.`}>
              {restarting ? "fetching…"
                /* A retry after a failure must not look like the first
                   click: the last one already came back on the same
                   version, and the label is where that shows. */
                : upgradeState === "failed" ? "Retry update"
                : "Update & restart"}
            </button>
          )}
          {upgradeState === "failed" ? (
            <span className="ver-sub fail" title={version?.upgrade?.error ?? ""}>
              {/* npx installs nothing — its failure is a fetch that came
                  back on the old version, not a broken install. */}
              {version?.upgradeMode === "npx" ? "update failed" : "install failed"}
              : {version?.upgrade?.error ?? "unknown error"} — run it yourself:
            </span>
          ) : version?.upgradeMode === "npx" ? (
            <span className="ver-sub">
              {version?.canRestart
                ? "npx cannot upgrade in place, so the deck re-runs:"
                : UPGRADE_BLOCK_TEXT.npx}
            </span>
          ) : version?.upgradeBlocked ? (
            <span className="ver-sub">
              {/* An own row, not a bare `??` — see ownRow (#474). The reason
                  is a string off /api/version, so a build that sends one naming
                  an Object.prototype member would put a function here. */}
              {ownRow(UPGRADE_BLOCK_TEXT, version.upgradeBlocked) ?? "cannot install from here"}
            </span>
          ) : null}
          <button type="button" className="ver-cmd" onClick={copyCommand} title="Copy to clipboard">
            <code>{version?.command}</code>
            <span className="ver-cmd-hint">{cmdCopied ? "copied" : "copy"}</span>
          </button>
        </>
      )}
      {/* A real button, like the five controls beside it. As a
          role="button" span this re-implemented Enter and Space by hand —
          and its Space branch existed only to undo the global preventDefault
          this handler now never reaches, since ownsKeystroke() leaves a
          focused <button> alone. */}
      <button type="button" aria-label="Dismiss" className="ver-close" onClick={dismissNotice}>×</button>
    </div>
  );
}
