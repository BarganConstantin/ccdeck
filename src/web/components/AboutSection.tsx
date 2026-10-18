// Settings › About: which ccdeck this is, what is waiting to replace it, the
// doors to what it says about itself, and the licence it is offered under
// (#2176).
//
// The last section, standing at the foot of the nav the way About does in the
// desktop settings windows this dialog follows. It invents nothing: every row
// is a second way to something the deck already has. The version is the one
// the topbar's chip wears; an update is offered with the chip's own action;
// What's new, the tour and Send feedback are the doors the chip, the shortcuts
// sheet and the topbar's Feedback button open. A door closes Settings before
// it opens what it names (settings.ts, doorOut), so one dialog is up at a time.
//
// THE VERSION IS THE SERVER'S, NOT THE PAGE'S. The bundle knows its own
// number (__APP_VERSION__), and the two can differ: an upgrade replaces dist/
// under a tab that keeps running the bundle it loaded, so a page can be older
// than the deck it is talking to. The chip settled this long ago — it names
// the version the process booted with — and the row says the same number, with
// a line under it when the page in front of the reader is the older of the
// two, in the words the deck already uses for that tab (LazyDialog.tsx).
import { readyButtonCopy, updateRestartFailureText, type UpdateRestartFailure } from "../desktop-update";
import { PRODUCT } from "../brand";
import { compareVersions, isVersion } from "../release-notes";
import type { SettingsDoors } from "../settings";
import type { VersionInfo, VersionNotice } from "../use-version-check";
// The tour's line in What's new, where the same door has stood since #712:
// the same pictures, so the same sentence.
import { TOUR_WHY } from "./ReleaseActions";
import { SettingRow, SettingsGroup } from "./SettingsParts";

/** The licence the project offers ccdeck under — package.json's `license`,
 *  LICENSING.md's first line. settings-about-2176.test.ts holds the two to
 *  each other, so a change to one cannot leave this row saying the other. */
export const LICENCE = "AGPL-3.0-only";
export const LICENCE_NOTE = "GNU Affero General Public License, version 3 only.";
/** Where the source is: package.json's `repository`, as a page a browser can
 *  open rather than the git URL npm keeps. Held to package.json by the same
 *  test. The AGPL is a licence about source, so the row that names it is the
 *  row that says where to get it. */
export const SOURCE_URL = "https://github.com/BarganConstantin/ccdeck";

export const WHATS_NEW_NOTE = "What changed in each release, newest first.";
export const FEEDBACK_NOTE = "Tell the people who make ccdeck what works and what does not.";

/** The sentence under the version when this page is older than the deck — the
 *  one the deck says when a dialog fails to load for the same reason
 *  (LazyDialog.tsx): hedged, because a reload that serves the same bundle (a
 *  checkout whose build is behind its version) does not pick anything up. */
export function pageBehindNote(bundle: string): string {
  return `This page is from v${bundle}. The deck has most likely been updated since this tab opened, and a reload picks up the new version.`;
}

/** Whether the page in front of the reader is older than the deck it talks to.
 *  Only older: a page NEWER than the deck is the other drift — an install
 *  landed under a process still running the old code — and that one is the
 *  restart notice's to say, in the update row below the version. */
export function pageBehind(bundle: string, running: string | null | undefined): boolean {
  return isVersion(bundle) && isVersion(running) && compareVersions(bundle, running) < 0;
}

/** What the update row says and does, or null when nothing is waiting — the
 *  three things the version chip can be lit for (VersionChip.tsx), in its
 *  order: an update the desktop app has downloaded and verified, then a
 *  version on disk the process has not restarted into, then one on npm. */
export type UpdateOffer =
  | { kind: "ready"; to: string; name: string; note: string }
  | { kind: "notice"; name: string; note: string };

export function updateOffer(ready: { version: string } | null, notice: VersionNotice | null): UpdateOffer | null {
  // The ready update's line in What's new (ReleaseNotesModal.tsx), so the two
  // places that offer the press say the same thing about it.
  if (ready) return { kind: "ready", to: ready.version, name: "Update ready", note: `${PRODUCT} v${ready.version} is downloaded and verified.` };
  if (!notice) return null;
  // The banner's own first sentence for each kind (VersionBanner.tsx).
  return notice.kind === "restart"
    ? { kind: "notice", name: "Update installed", note: `v${notice.to} is installed — this deck still runs v${notice.from}.` }
    : { kind: "notice", name: "Update available", note: `${PRODUCT} v${notice.to} is out — you are on v${notice.from}.` };
}

export interface AboutProps {
  /** /api/version's answer, or null until the first one lands. */
  version: VersionInfo | null;
  notice: VersionNotice | null;
  /** The desktop app's verified update, and its press: the topbar's Restart to
   *  update (use-desktop-update.ts). Outside the app the first is always null. */
  readyAppUpdate: { version: string } | null;
  updateRestarting: boolean;
  updateFailure: { failure: UpdateRestartFailure; version: string } | null;
  onUpdateRestart: (version: string) => void;
  doors: Pick<SettingsDoors, "whatsNew" | "update" | "tour" | "feedback">;
  /** The page's own version; a parameter so a test can be a page older than
   *  its deck. */
  bundle?: string;
}

export default function AboutSection({
  version, notice, readyAppUpdate, updateRestarting, updateFailure, onUpdateRestart, doors, bundle = __APP_VERSION__,
}: AboutProps) {
  // The chip's number, defaulted the way the chip defaults it
  // (use-welcome-and-notes.ts, chipVersion): the server's while it has
  // answered, the bundle's until then.
  const running = version?.running ?? bundle;
  const offer = updateOffer(readyAppUpdate, notice);
  return (
    <>
      <SettingsGroup id="settings-about-caption" title={PRODUCT}>
        <SettingRow
          as="div"
          settingId="version"
          name="Version"
          note={pageBehind(bundle, version?.running) ? pageBehindNote(bundle) : undefined}
          control={<span className="settings-read">{running}</span>}
        />
        {offer && <UpdateRow offer={offer} restarting={updateRestarting} failure={updateFailure} onRestart={onUpdateRestart} onUpdate={doors.update} />}
        <SettingRow
          as="div"
          settingId="whats-new"
          name="What's new"
          note={WHATS_NEW_NOTE}
          control={<button type="button" className="btn" aria-haspopup="dialog" aria-label="Open What's new" onClick={doors.whatsNew}>Open</button>}
        />
        <SettingRow
          as="div"
          settingId="licence"
          name="Licence"
          note={LICENCE_NOTE}
          control={
            <>
              <span className="settings-read">{LICENCE}</span>
              {/* A link, because it is one: it leaves the deck for a page
                  anybody can read, in a new tab — or, in the desktop app,
                  the browser (desktop/main.mjs hands it over). noreferrer,
                  so the page is not told which deck sent the reader. */}
              <a className="settings-link" href={SOURCE_URL} target="_blank" rel="noreferrer">
                Source<span className="vis-hidden">: the source code, opens in your browser</span>
              </a>
            </>
          }
        />
      </SettingsGroup>
      <SettingsGroup id="settings-about-help-caption" title="Tour and feedback">
        <SettingRow
          as="div"
          settingId="tour"
          name="Take the tour"
          note={TOUR_WHY}
          control={<button type="button" className="btn" aria-haspopup="dialog" aria-label="Start the tour" onClick={doors.tour}>Start</button>}
        />
        <SettingRow
          as="div"
          settingId="feedback"
          name="Send feedback"
          note={FEEDBACK_NOTE}
          control={<button type="button" className="btn" aria-haspopup="dialog" aria-label="Open the feedback dialog" onClick={doors.feedback}>Open</button>}
        />
      </SettingsGroup>
    </>
  );
}

/** The row an update stands in, with the version chip's own action for it.
 *
 *  A READY UPDATE IS PRESSED HERE. The chip draws Restart to update beside
 *  itself (VersionChip.tsx, readyButtonCopy), and this is the same button on
 *  the same press — askDesktopUpdateRestart, which refuses a second one — so
 *  it does not close Settings: when it works the app restarts, and when it
 *  does not, the reason is said under it, in the words What's new uses.
 *
 *  A NOTICE IS A DOOR. The chip, lit for a version on disk or on npm, opens
 *  What's new and puts the banner back (showNotice); both hold the install's
 *  own way forward — Restart, Update now, Update & restart or the command —
 *  and this hands the reader to them rather than growing a second update path
 *  of its own. The ellipsis says the press opens something to finish in. */
function UpdateRow({ offer, restarting, failure, onRestart, onUpdate }: {
  offer: UpdateOffer;
  restarting: boolean;
  failure: AboutProps["updateFailure"];
  onRestart: (version: string) => void;
  onUpdate: () => void;
}) {
  if (offer.kind === "notice") {
    return (
      <SettingRow
        as="div"
        settingId="update"
        name={offer.name}
        note={offer.note}
        control={<button type="button" className="btn" aria-haspopup="dialog" onClick={onUpdate}>Update…</button>}
      />
    );
  }
  const press = readyButtonCopy(offer.to, restarting);
  // Said until the next press, and only about the update on offer — the rule
  // DeckDialogs.tsx gives What's new's own line.
  const said = failure && failure.version === offer.to ? updateRestartFailureText(failure.failure, failure.version) : "";
  return (
    <SettingRow
      as="div"
      settingId="update"
      name={offer.name}
      note={offer.note}
      control={
        // Busy, never disabled, while its request is out (#620).
        <button type="button" className="btn" onClick={() => onRestart(offer.to)}
          aria-busy={restarting || undefined} aria-label={press.label} title={press.title}>
          {press.text}
        </button>
      }
    >
      {/* Mounted with the row rather than with its first sentence: text that
          arrives in the same tick as its live region is the announcement a
          screen reader most often drops. Empty, it takes no room. */}
      <span className="settings-row-said" role="status">{said}</span>
    </SettingRow>
  );
}
