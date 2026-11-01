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
import { t, useT } from "../i18n";

// Said in the UI's voice, not npm's. Each of these is a decision we made on
// purpose, so each gets a reason rather than a disabled button.
//
// Getters, so each read is worded in the language on show and the table keeps
// its shape: own properties an ownRow() lookup can ask for by name (#474).
export const UPGRADE_BLOCK_TEXT: Record<string, string> = {
  get git_checkout() { return t("shell.banner.block.git_checkout"); },
  get npx() { return t("shell.banner.block.npx"); },
  // pnpm dlx, bunx and yarn dlx: the same cache problem without npx's record
  // of what to re-run, so the command is the global install.
  get one_off() { return t("shell.banner.block.one_off"); },
  get not_writable() { return t("shell.banner.block.not_writable"); },
  get opted_out() { return t("shell.banner.block.opted_out"); },
  // The deck was installed under a name npm no longer serves a deck for, so
  // reinstalling it would fetch a pointer package and take this install with
  // it. The command beneath this moves the machine onto the published name,
  // which is the only update it can have.
  get retired_name() { return t("shell.banner.block.retired_name"); },
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
  const t = useT();
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
          <strong>{t("shell.banner.installedStale", { to: notice.to, from: notice.from })}</strong>
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
                title={t("shell.banner.restartTitle")}>
                {restarting ? t("shell.banner.restarting") : restartCopy.label}
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
                aria-label={t("shell.banner.autoRestart")}
                title={autoRestart ? t("shell.banner.autoOnTitle") : t("shell.banner.autoOffTitle")}>
                <span className="switch-knob" />
              </button>
              <span aria-hidden>{autoRestartLabel(autoRestart, restartFuseMs)}</span>
              </label>
            </>
          ) : (
            <span
              className="ver-sub"
              title={t("shell.banner.restartNeededTitle")}
            >{t("shell.banner.restartNeeded")}</span>
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
          <strong>{t("shell.banner.isOut", { product: PRODUCT, to: notice.to, from: notice.from })}</strong>
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
              title={t("shell.banner.installTitle", { command: version?.upgrade?.command ?? version?.command ?? "npm i -g" })}>
              {upgradeState === "running" ? t("shell.banner.installing")
                : upgradeState === "done" ? t("shell.banner.installed")
                : t("shell.update.now")}
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
              title={t("shell.banner.npxTitle", { command: version?.command ?? "" })}>
              {restarting ? t("shell.banner.fetching")
                /* A retry after a failure must not look like the first
                   click: the last one already came back on the same
                   version, and the label is where that shows. */
                : upgradeState === "failed" ? t("shell.update.retry")
                : t("shell.update.andRestart")}
            </button>
          )}
          {upgradeState === "failed" ? (
            <span className="ver-sub fail" title={version?.upgrade?.error ?? ""}>
              {/* npx installs nothing — its failure is a fetch that came
                  back on the old version, not a broken install. */}
              {t("shell.banner.failedLine", {
                what: version?.upgradeMode === "npx" ? t("shell.banner.updateFailed") : t("shell.banner.installFailed"),
                error: version?.upgrade?.error ?? t("shell.banner.unknownError"),
              })}
            </span>
          ) : version?.upgradeMode === "npx" ? (
            <span className="ver-sub">
              {version?.canRestart
                ? t("shell.banner.npxRerun")
                : UPGRADE_BLOCK_TEXT.npx}
            </span>
          ) : version?.upgradeBlocked ? (
            <span className="ver-sub">
              {/* An own row, not a bare `??` — see ownRow (#474). The reason
                  is a string off /api/version, so a build that sends one naming
                  an Object.prototype member would put a function here. */}
              {ownRow(UPGRADE_BLOCK_TEXT, version.upgradeBlocked) ?? t("shell.banner.cannotInstall")}
            </span>
          ) : null}
          <button type="button" className="ver-cmd" onClick={copyCommand} title={t("shell.banner.copyTitle")}>
            <code>{version?.command}</code>
            <span className="ver-cmd-hint">{cmdCopied ? t("shell.banner.copiedHint") : t("shell.banner.copyHint")}</span>
          </button>
        </>
      )}
      {/* A real button, like the five controls beside it. As a
          role="button" span this re-implemented Enter and Space by hand —
          and its Space branch existed only to undo the global preventDefault
          this handler now never reaches, since ownsKeystroke() leaves a
          focused <button> alone. */}
      <button type="button" aria-label={t("shell.dismiss")} className="ver-close" onClick={dismissNotice}>×</button>
    </div>
  );
}
