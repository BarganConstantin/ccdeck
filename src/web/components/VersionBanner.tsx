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
import { sentences } from "../banner-sentences";
import { selfPressProps } from "../panel-press";
import { restartCountdown } from "../restart";
import type { useAutoRestart } from "../use-auto-restart";
import type { useDeckUpgrade } from "../use-deck-upgrade";
import type { VersionInfo, VersionNotice } from "../use-version-check";
import { ownRow } from "../own-row";
import { t, useT } from "../i18n";
import BannerMark from "./BannerMark";
import { KitIcon, KitStateGlyph } from "./kit-icons";

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

/** The same reasons as the banner says them (V4's Figma): sentences of their
 *  own, capitalised and with full stops. The table above keeps the clause the
 *  What's new dialog sets after "is out, but". Getters and own rows, for the
 *  same reasons as above. */
export const UPGRADE_BLOCK_SENTENCE: Record<string, string> = {
  get git_checkout() { return t("shell.banner.blockSentence.git_checkout"); },
  get npx() { return t("shell.banner.blockSentence.npx"); },
  get one_off() { return t("shell.banner.blockSentence.one_off"); },
  get not_writable() { return t("shell.banner.blockSentence.not_writable"); },
  get opted_out() { return t("shell.banner.blockSentence.opted_out"); },
  get retired_name() { return t("shell.banner.blockSentence.retired_name"); },
};

type Restart = ReturnType<typeof useAutoRestart>;
type Upgrade = ReturnType<typeof useDeckUpgrade>;

export default function VersionBanner({
  notice, version, dismissNotice,
  upgradeState, startUpgrade, copyCommand, cmdCopied,
  askRestart, restartCopy, restartFuseMs, restarting,
}: {
  /** What drifted, and which way: a restart would pick it up, or an upgrade would fetch it. */
  notice: VersionNotice;
  version: VersionInfo | null;
  dismissNotice: () => void;
  upgradeState: Upgrade["upgradeState"];
  startUpgrade: Upgrade["startUpgrade"];
  copyCommand: Upgrade["copyCommand"];
  cmdCopied: Upgrade["cmdCopied"];
  askRestart: Restart["askRestart"];
  restartCopy: Restart["restartCopy"];
  restartFuseMs: Restart["restartFuseMs"];
  restarting: Restart["restarting"];
}) {
  const t = useT();
  const update = notice.kind !== "restart";
  const failed = update && upgradeState === "failed";
  const npx = update && version?.upgradeMode === "npx";
  // The command gets a row of its own, with Copy, only where the reader has to
  // run it (V4's Figma): npx's re-run, a failed install, and a copy this deck
  // cannot write over. Under a working "Update now" the button is the way, and
  // the command is in its title.
  const canInstall = update && version?.upgradeMode === "install" && !failed;
  const command = update && !canInstall ? version?.command : undefined;
  // Waiting only where an agent would lose something (V4's Figma): a restart
  // over running agents, or over a paused canvas that cannot tell. Everything
  // else here is news, in the Info tone; a failed install is the error.
  const risky = notice.kind === "restart" && version?.canRestart === true && restartCopy.risky;
  const failedText = t("shell.banner.failedLine", {
    what: version?.upgradeMode === "npx" ? t("shell.banner.updateFailed") : t("shell.banner.installFailed"),
    error: version?.upgrade?.error ?? t("shell.banner.unknownError"),
  });
  const isOutShort = t("shell.banner.isOutShort", { product: PRODUCT, to: notice.to });
  // The message, one run of sentences in the words V4 writes. The countdown is
  // the one part that changes every second: it is drawn, and a screen reader
  // hears the stable `said` instead, because this banner is a role="status" and
  // a sentence that renamed itself every second would be read out every second.
  let said: string;
  let drawn: string | null = null;
  if (notice.kind === "restart") {
    const installed = t("shell.banner.isInstalled", { to: notice.to });
    const stale = t("shell.banner.installedStale", { to: notice.to, from: notice.from });
    if (!version?.canRestart) said = sentences(stale, t("shell.banner.restartNeeded"));
    else if (restarting) said = stale;
    else if (restartFuseMs != null) {
      const before = sentences(installed, risky && restartCopy.clause);
      said = sentences(before, t("shell.banner.restartingWhenIdle"));
      drawn = sentences(before, restartCountdown(restartFuseMs));
    } else if (risky) said = sentences(installed, restartCopy.clause);
    else said = sentences(stale, restartCopy.clause);
  } else if (failed) {
    /* The failure leads the row, as V4 draws it: the error mark, what failed
       and why, and the command to run yourself in the box under it. npx
       installs nothing — its failure is a fetch that came back on the old
       version, not a broken install. */
    said = failedText;
  } else if (npx) {
    said = sentences(isOutShort, version?.canRestart ? t("shell.banner.npxRerun") : UPGRADE_BLOCK_SENTENCE.npx);
  } else if (version?.upgradeBlocked) {
    // An own row, not a bare `??` — see ownRow (#474). The reason is a string
    // off /api/version, so a build that sends one naming an Object.prototype
    // member would put a function here. A checkout says only that (V4's
    // Figma): a pull takes whatever the branch has, not this release.
    const reason = ownRow(UPGRADE_BLOCK_SENTENCE, version.upgradeBlocked) ?? t("shell.banner.cannotInstall");
    said = version.upgradeBlocked === "git_checkout" ? reason : sentences(isOutShort, reason);
  } else {
    said = t("shell.banner.isOut", { product: PRODUCT, to: notice.to, from: notice.from });
  }
  // The whole command box copies, as the pill it replaced did; a drag that
  // selects the command by hand is not a press on it.
  const copyBox = () => { if (!window.getSelection()?.toString()) copyCommand(); };
  const row = (
    <>
      {/* Still, until something is actually about to happen. It pulsed for
          days over a fact that does not change, in the one visual grammar
          this deck reserves for "running right now" — and it pulsed
          identically whether or not a restart was counting down, so the one
          moment motion would have carried information was the moment it
          carried none. */}
      <BannerMark glyph={failed ? "unreachable" : risky ? "warning" : "info"} tone={failed ? "err" : risky ? "warn" : "info"}
        armed={restartFuseMs != null} />
      {/* The product's name, not the `name` /api/version reports: that one is
          the npm package the registry was asked about, and it is `ccdeck`,
          `agents-deck` or `agent-dag` depending on how this deck was started.
          A release announcement whose subject changes with the install method
          names three products where there is one, and contradicts the
          wordmark directly above it. The package belongs where it is
          actionable — the button's title below, which is the command that
          actually installs. A long npm error ends in an ellipsis on the row,
          so the whole failure line is the title too. */}
      {drawn != null ? (
        <strong><span aria-hidden="true">{drawn}</span><span className="vis-hidden">{said}</span></strong>
      ) : (
        <strong title={failed ? said : undefined}>{said}</strong>
      )}
      {notice.kind === "restart" && version?.canRestart && (
        /* #620: `disabled={restarting}` disabled the control the press came
           from — askRestart sets `restarting` before its first await — and
           the banner has no focus trap to hand the keyboard back. The word
           already says which state it is in; `aria-busy` says it to a reader,
           and askRestart's own ref refuses the second press.
           The word changes with the machine's own answer. `Restart anyway` is
           the honest name for a press that drops the hook events fired while
           the server is down — restart.ts:1 says that is what happens — and it
           is a label rather than a confirmation dialog because a modal over a
           live canvas is worse than a true word. */
        <button type="button" className="ver-act" onClick={() => askRestart()} {...selfPressProps(restarting)}
          title={t("shell.banner.restartTitle")}>
          {restarting ? t("shell.banner.restarting") : restartCopy.label}
        </button>
      )}
      {/* One button when we can actually install; the command, in a row of its
          own, when the reader has to run it.

          The tooltip's fallback matters more than it looks:
          `upgrade.command` is the vector npm was actually spawned with and
          exists only once an install has started, so before the first click
          the fallback is the whole of what it says — and a hardcoded
          `agents-deck` was wrong for every `npm i -g ccdeck`, which back then
          installed a launcher package of its own. #340 removed that launcher,
          and the argument survives it: the name to reinstall is still
          whichever of the three the user typed, and this component has no way
          to know which. `version.command` is the server's own answer to the
          same question, correct in every install shape, and the same string
          the copy button carries. */}
      {canInstall && (
        /* #620, and the one of the nine whose flag is not set in its own
           handler: `running` arrives from the /api/version poll a moment after
           the click, and the button is still the focused element when it does
           — the same drop, one round trip later. So `running` is this press's
           in-flight state and goes to `aria-busy`; `done` is not — the install
           has finished and there is nothing left to press, which is an
           unavailability `disabled` is exactly right for. */
        <button type="button" className="ver-act" onClick={startUpgrade}
          {...selfPressProps(upgradeState === "running", upgradeState === "done")}
          title={t("shell.banner.installTitle", { command: version?.upgrade?.command ?? version?.command ?? "npm i -g" })}>
          {upgradeState === "running" ? t("shell.banner.installing")
            : upgradeState === "done" ? t("shell.banner.installed")
            : t("shell.update.now")}
        </button>
      )}
      {/* npx never installs anything — there is nothing here to install over.
          The update IS the restart: the supervisor re-runs the spec, npx
          unpacks a fresh copy, and it takes this port. V4's frame draws the
          sentence and the command alone; the button stays, because it is the
          one press that does it from here. */}
      {npx && version?.canRestart && (
        /* #620, the same as Restart now: askRestart sets `restarting` before
           its first await, and this is the button the press came from. An npx
           fetch is measured in tens of seconds, so this is the longest of the
           four in App.tsx to spend with focus on `<body>`. */
        <button type="button" className="ver-act" onClick={() => askRestart({ upgrade: true })}
          {...selfPressProps(restarting)}
          title={t("shell.banner.npxTitle", { command: version?.command ?? "" })}>
          {restarting ? t("shell.banner.fetching")
            /* A retry after a failure must not look like the first click: the
               last one already came back on the same version, and the label
               is where that shows. */
            : upgradeState === "failed" ? t("shell.update.retry")
            : t("shell.update.andRestart")}
        </button>
      )}
      {/* A real button, like the controls beside it. As a role="button" span
          this re-implemented Enter and Space by hand — and its Space branch
          existed only to undo the global preventDefault this handler now never
          reaches, since ownsKeystroke() leaves a focused <button> alone. */}
      <button type="button" aria-label={t("shell.dismiss")} className="ver-close" onClick={dismissNotice}><KitIcon name="close" /></button>
    </>
  );
  if (!command) {
    return <div className={`ver-banner ${notice.kind}`} role="status">{row}</div>;
  }
  return (
    // Two rows, as V4 draws an update: the banner row, then the command in a
    // full-width box of its own with Copy at its end.
    <div className={`ver-banner ver-stack ${notice.kind}`} role="status">
      <div className="ver-row">{row}</div>
      <div className="ver-cmdrow">
        <div className="ver-cmd" onClick={copyBox} title={t("shell.banner.copyTitle")}>
          <code>{command}</code>
          {/* The press is the box's: the button's own click (mouse, Enter or
              Space) bubbles up to it, so it runs once. The word is said by the
              banner's status region, which the icon alone could not do. */}
          <button type="button" className="ver-copy" aria-label={t("shell.banner.copyTitle")}>
            {cmdCopied ? <KitStateGlyph name="done" /> : <KitIcon name="copy" />}
          </button>
          <span className="vis-hidden">{cmdCopied ? t("shell.banner.copiedHint") : ""}</span>
        </div>
      </div>
    </div>
  );
}
