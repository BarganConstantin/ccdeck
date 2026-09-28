// Browser Watch's settings: the quiet gate, the reaction to a finding, and
// what the watch can and cannot read, behind the footer's gear.
//
// Lifted out of BrowserWatchModal.tsx unchanged. Both selects write through the
// dialog's `save`, and the quiet select shows the dialog's `quiet` — the value
// just picked while its save is out, the stored one otherwise. Whether "What
// Browser Watch can access" is expanded is the dialog's state too: this panel
// unmounts when the gear closes it, and the disclosure is still open the next
// time it does.
import type { Dispatch, SetStateAction } from "react";

import { logBytesLabel, type WatchSettings, type WatchSnapshot } from "../browser-watch-model";

export default function BrowserWatchSettings({
  snap,
  quiet,
  setQuiet,
  save,
  access,
  setAccess,
}: {
  snap: WatchSnapshot;
  quiet: number | null;
  setQuiet: (minutes: number | null) => void;
  save: (patch: Partial<WatchSettings>) => Promise<void>;
  access: boolean;
  setAccess: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <div className="bw-settings">
      <label title={
        "A program opening a page counts as a finding only if nobody had touched the browser "
        + "for this long. Shorter catches more and reports more of your own work; longer is quieter."
      }>
        <span>Nobody browsing for</span>
        <select value={quiet ?? snap.settings.quietMinutes} onChange={e => { setQuiet(Number(e.target.value)); void save({ quietMinutes: Number(e.target.value) }); }}>
          <option value={1}>1 min</option>
          <option value={5}>5 min</option>
          <option value={15}>15 min</option>
          <option value={30}>30 min</option>
          <option value={60}>60 min</option>
        </select>
      </label>

      <label>
        <span>When it finds one</span>
        <select
          value={snap.settings.reaction}
          onChange={e => void save({ reaction: e.target.value as WatchSettings["reaction"] })}
          disabled={!snap.settings.enabled}
          title={snap.settings.enabled
            ? "What to do besides writing it down."
            : "Turn watching on to arm a reaction."}
        >
          {(snap.reactions ?? ["notify"]).map(r => (
            <option key={r} value={r}>
              {r === "notify" ? "notify me"
                : r === "close-tab" ? "close the tab"
                : "quit the browser"}
            </option>
          ))}
        </select>
      </label>

      <div className="bw-settings-note">
        <p>
          Chrome marks a navigation that came from an extension or a command rather than from a
          click. These are the ones that happened while nobody had touched the browser for the
          time above. <strong>Usually that is your own agent doing what you asked.</strong>
        </p>
        <button className="bw-why" onClick={() => setAccess(a => !a)} aria-expanded={access}>
          <span className="bw-chev" aria-hidden>{access ? "▾" : "▸"}</span> What Browser Watch can access
        </button>
        {access && (
          <dl className="bw-access">
            <dt>Reads</dt>
            <dd>
              A copy of each browser&apos;s own history database — the live file is locked while
              the browser holds it. Only rows newer than the moment this deck started:{" "}
              {new Date(snap.coverage.startedMs).toLocaleString()}.
            </dd>
            <dt>Keeps</dt>
            <dd>
              Only while the switch is on, and only the episodes it flagged — never your ordinary
              browsing. In <code className="bw-path">{snap.coverage.logPath}</code>
              {typeof snap.coverage.logBytes === "number" ? ` (${logBytesLabel(snap.coverage.logBytes)})` : ""},
              with every address written in full so you can check it yourself.
            </dd>
            <dt>Sends</dt>
            <dd>
              Nothing. No part of this reads or writes over the network; the deck serves on
              127.0.0.1 and this panel talks only to it.
            </dd>
            <dt>Never reads</dt>
            <dd>
              Anything from before this deck started, cookies, saved passwords, page contents, or
              any browser profile with no history file.
            </dd>
          </dl>
        )}
      </div>
    </div>
  );
}
