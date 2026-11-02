// The version chip at the top bar's right end: drawn ONLY when there is
// something to say about the version (V4's Figma, Top bar: "4.0.1 is ready",
// the chip is optional), and what a click does about it.
//
// It draws one of two buttons — an update the desktop app has already
// downloaded, or a version that has drifted from the one on disk or on npm —
// and both open the release notes first (#715). A deck that is simply current
// draws nothing: the plain "v3.52.0" chip that asked npm now is gone from the
// bar, and its two jobs stand where the version always was — About and
// Settings > Updates hold the number, the check, and What's new
// (versionChipNeeded, version-chip.ts, says when the bar speaks). Its props are
// the version check's answer, the desktop updater's, and the things a click can
// do. The ready update's own Restart to update is drawn after the chip while the
// app has one (see readyButtonCopy).
//
// Each chip leads with a 14px icon slot holding the version dot, which stays
// still (V4's motion spec: Paused, Lost and Version hold a still dot).
import type { readyDesktopUpdate } from "../desktop-update";
import { desktopAppVersion, readyButtonCopy, readyChipCopy } from "../desktop-update";
import { useLanguage, t } from "../i18n";
import type { VersionNotice } from "../use-version-check";
import { versionChipNeeded, versionNoticeLabel } from "../version-chip";

export default function VersionChip({
  readyAppUpdate, notice, noticeOpen, chipVersion,
  openReleaseNotes, showNotice, restartToUpdate, updateRestarting = false,
}: {
  /** An update the desktop app has downloaded and verified, or null. */
  readyAppUpdate: ReturnType<typeof readyDesktopUpdate>;
  /** The banner the server offered, or null. */
  notice: VersionNotice | null;
  noticeOpen: boolean;
  /** The version the chip names: the server's, not the bundle's. */
  chipVersion: string;
  openReleaseNotes: () => void;
  showNotice: () => void;
  /** Apply the ready update, the press the What's new dialog makes. Without
   *  it there is no button, only the chip. */
  restartToUpdate?: (version: string) => void;
  /** That press is out and has not been answered. */
  updateRestarting?: boolean;
}) {
  useLanguage(); // the copy helpers below read the language on show
  if (!versionChipNeeded({ readyAppUpdate, notice })) return null;
  return (
    <>
      {/* Stale → the chip stays lit even after the banner is dismissed, and
          clicking it brings the banner back.

          One rule across both branches since #715: clicking the version
          opens what changed in it. While this branch is the one on screen it
          is the ONLY way back into a dismissed dialog. */}
      {readyAppUpdate ? (() => {
        // Good news, so not the stale chip's amber: that colour is this
        // bar's warning, and an update the app has already downloaded
        // and verified is the opposite of something being wrong. It
        // wears the accent instead — see .v.ready.
        const copy = readyChipCopy(desktopAppVersion() ?? chipVersion, readyAppUpdate.version);
        // The press itself, beside the chip that explains it (owner's call,
        // 2026-10-18, after a user asked for agency over updates). Busy, never
        // disabled, while its request is out (#620): the second press is
        // refused by the same ref the dialog's button meets.
        const press = restartToUpdate && readyButtonCopy(readyAppUpdate.version, updateRestarting);
        return (
          <>
            <button
              type="button"
              className="v ready"
              onClick={openReleaseNotes}
              aria-haspopup="dialog"
              aria-label={copy.label}
              title={copy.title}
            >
              <span className="v-icon" aria-hidden><span className="v-dot" /></span>
              {copy.text}
            </button>
            {press && (
              <button
                type="button"
                className="v ready v-update"
                onClick={() => restartToUpdate(readyAppUpdate.version)}
                aria-busy={updateRestarting || undefined}
                aria-label={press.label}
                title={press.title}
              >
                {press.text}
              </button>
            )}
          </>
        );
      })() : notice ? (
        <button
          type="button"
          className="v stale"
          onClick={() => { openReleaseNotes(); showNotice(); }}
          aria-haspopup="dialog"
          /* The accessible name says what the chip HAS (#381); see
             versionNoticeLabel. */
          aria-label={versionNoticeLabel({ ...notice, open: noticeOpen })}
          title={notice.kind === "restart"
            ? t("shell.chip.runningRestart", { from: notice.from, to: notice.to })
            : t("shell.chip.runningUpgrade", { from: notice.from, to: notice.to })}
        >
          <span className="v-icon" aria-hidden><span className="v-dot" /></span>
          {`${notice.to} is ready`}
        </button>
      ) : null}
    </>
  );
}
