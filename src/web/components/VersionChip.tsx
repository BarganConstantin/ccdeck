// The version chip beside the wordmark: which version the server is running,
// and what a click does about it.
//
// Moved out of App.tsx's topbar markup unchanged. It draws one of three
// buttons — an update the desktop app has already downloaded, a version that
// has drifted from the one on disk or on npm, or the healthy chip that asks npm
// now — and every one of them opens the release notes first (#715). Its props
// are the version check's answer, the desktop updater's, and the three things
// a click can do.
import type { readyDesktopUpdate } from "../desktop-update";
import { desktopAppVersion, readyChipCopy } from "../desktop-update";
import { shortAgo } from "../relative-time";
import type { VersionInfo, VersionNotice } from "../use-version-check";
import { versionChipLabel, versionChipTitle, versionNoticeLabel } from "../version-chip";

export default function VersionChip({
  readyAppUpdate, notice, noticeOpen, version, chipVersion, versionChecking, now,
  openReleaseNotes, showNotice, loadVersion,
}: {
  /** An update the desktop app has downloaded and verified, or null. */
  readyAppUpdate: ReturnType<typeof readyDesktopUpdate>;
  /** The banner the server offered, or null. */
  notice: VersionNotice | null;
  noticeOpen: boolean;
  version: VersionInfo | null;
  /** The version the chip names: the server's, not the bundle's. */
  chipVersion: string;
  versionChecking: boolean;
  now: number;
  openReleaseNotes: () => void;
  showNotice: () => void;
  loadVersion: (force?: boolean) => Promise<void>;
}) {
  return (
    <>
      {/* The server's own version, not the bundle's — an upgrade replaces
          dist/ too, so a reloaded page can show a number the running
          process never had. Stale → the chip stays lit even after the
          banner is dismissed, and clicking it brings the banner back.

          One rule across both branches since #715: clicking the version
          opens what changed in it. The rest of what a click does depends
          on which branch is drawn — the healthy one asks npm, this one
          puts the drift banner back — and neither of those can fail in a
          way that costs the notes, which is the half that has to work
          everywhere. It has to work here in particular: a deck that is
          behind stays behind until somebody upgrades it, and while this
          branch is the one on screen it is the ONLY way back into a
          dismissed dialog. */}
      {readyAppUpdate ? (() => {
        // Good news, so not the stale chip's amber: that colour is this
        // bar's warning, and an update the app has already downloaded
        // and verified is the opposite of something being wrong. It
        // wears the accent instead — see .v.ready.
        const copy = readyChipCopy(desktopAppVersion() ?? chipVersion, readyAppUpdate.version);
        return (
          <button
            type="button"
            className="v ready"
            onClick={openReleaseNotes}
            aria-haspopup="dialog"
            aria-label={copy.label}
            title={copy.title}
          >
            {copy.text}
            <span className="v-dot" aria-hidden />
          </button>
        );
      })() : notice ? (
        <button
          type="button"
          className="v stale"
          onClick={() => { openReleaseNotes(); showNotice(); }}
          aria-haspopup="dialog"
          /* The healthy branch below has carried an accessible name since it
             was written; this one did not, so its name was its text — the
             same bare version string, which made the chip that HAS news
             indistinguishable from the chip that has none. See
             versionNoticeLabel for the rest of the reasoning (#381). */
          aria-label={versionNoticeLabel({ ...notice, open: noticeOpen })}
          title={notice.kind === "restart"
            ? `Running v${notice.from}; v${notice.to} is installed on disk. Restart to pick it up · click for what's new`
            : `Running v${notice.from}; v${notice.to} is on npm · click for what's new`}
        >
          v{notice.from}
          <span className="v-dot" aria-hidden />
        </button>
      ) : (
        // Not decoration: "no banner" and "the check never ran" look the
        // same from a chair, and on a machine that only ever runs
        // `npx ccdeck` the difference is the whole feature. Clicking asks
        // npm now, ahead of the poll — so it has to look like a control and
        // say so out loud, which a dim version number does neither of.
        //
        // And since #715 it opens the release notes too, which is the
        // half that is answered instantly. The ORDER below is the
        // interesting part and it is not incidental: the notes are in
        // this bundle and npm is across a network that may not be there,
        // so the dialog is on screen before the request leaves. Written
        // the other way round — awaiting the check and opening after —
        // the button would sit still for the length of a registry
        // round-trip, and on a deck with no route to npm it would open
        // nothing at all until the fetch gave up. Nothing the dialog
        // draws depends on the answer, so there is nothing to wait for.
        (() => {
          const copy = {
            running: chipVersion,
            latest: version?.latest,
            latestPending: version?.latestPending,
            checkedAgo: version?.checkedAt ? shortAgo(now - version.checkedAt) : null,
            // Only when it is the NEWER of the two. A failure older than
            // the last success is history, and saying so would describe a
            // problem that has already gone away.
            checkFailedAgo: version?.checkFailedAt
              && version.checkFailedAt > (version.checkedAt ?? 0)
              ? shortAgo(now - version.checkFailedAt) : null,
            checkDisabled: version?.checkDisabled,
            checking: versionChecking,
          };
          return (
            <button
              type="button"
              className={versionChecking ? "v checking" : "v"}
              onClick={() => { openReleaseNotes(); loadVersion(true); }}
              aria-busy={versionChecking || undefined}
              /* No aria-pressed and no aria-expanded, for the reason the
                 usage-history button gives: what this opens is a modal
                 behind a scrim, so while it is open this button is out of
                 the tree entirely and a `true` no reader can reach is
                 worse than no state at all. aria-haspopup is the part
                 that says what kind of thing opens. */
              aria-haspopup="dialog"
              aria-label={versionChipLabel(copy)}
              title={versionChipTitle(copy)}
            >
              v{copy.running}
            </button>
          );
        })()
      )}
    </>
  );
}
