// Browser Watch's remote-control section: whether somebody else's Claude Code
// can drive this machine's browsers, and the command that stops it (#799).
//
// Lifted out of BrowserWatchModal.tsx unchanged. The dialog renders it only
// when the snapshot carries a relay report, so everything here can assume one.
import { Fragment, useCallback, useState } from "react";

import type { RelayGuard } from "../browser-watch-model";
import { copyText } from "../copy-text";

/**
 * "Can somebody else's Claude Code drive this browser?" — the panel half of
 * relay-guard.mjs (#799).
 *
 * The module was written, tested and never plugged into anything: its header
 * promised a grant report and a killswitch command, and every export but
 * `RELAY_HOST` reached no surface. This is that promise kept, and it belongs on
 * THIS panel rather than a new one — Browser Watch is already the place that
 * answers "what is happening in my browser without me", and remote control is
 * the sharpest form of that question.
 *
 * WHY THE VERDICT IS THREE WORDS AND NOT TWO. `verdict`'s own doc: "protected"
 * and "nothing-exposed" both mean no action is needed today, and collapsing
 * them would tell a user with no extension installed that a block they never
 * installed is working. Reassurance that is not about anything stops meaning
 * anything.
 *
 * WHY THE COMMAND IS TEXT. Nothing here runs it and nothing here can — the
 * module imports node:path and nothing else, and index.mjs's `isTrustedMutation`
 * deliberately lets an Origin-less request through, so a route that could raise
 * a password dialog would hand every local process a phishing primitive wearing
 * ccdeck's name. The whole feature is: read two files, say what they mean, and
 * hand over the command.
 */
export default function RemoteControl({ relay }: { relay: RelayGuard }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Offer the one that matches the state: a machine already blocked is offered
  // the way back, not the way in again.
  const which = relay.killswitch.blocked ? "unblock" : "block";
  const cmd = relay.command[which];

  const copy = useCallback(async () => {
    if (!(await copyText(cmd.command))) return; // still on screen and selectable
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }, [cmd.command]);

  const granted = relay.profiles.filter(p => p.report?.present);
  const unreadable = relay.profiles.filter(p => p.report === null);

  return (
    <section className="bw-sec">
      <h4 className="bw-sec-head">Remote control</h4>
      <p className={`bw-rc-verdict ${relay.verdict}`} role="status">
        {relay.verdict === "exposed"
          ? "Claude in Chrome is live here, so any Claude Code session signed in to your Anthropic account can drive this browser — from any machine, with no prompt on this one."
          : relay.verdict === "protected"
            ? `The relay is black-holed in ${relay.hostsPath}, so no new connection to it can be made from this machine.`
            : "Claude in Chrome is not installed and enabled in any profile here, so there is nothing for the relay to drive."}
      </p>

      {relay.killswitch.foreign.length > 0 && (
        /* NOT OURS AND NEVER DELETED. A hosts file resolves on the first match,
           so one line pointing the relay somewhere reachable defeats a block
           while leaving our own line sitting in the file — which is why
           `blocked` is not `ours.length > 0`, and why the line to go and look
           at is named here. */
        <p className="bw-rc-foreign">
          Another entry for this host is already in {relay.hostsPath}, and ccdeck will not touch it:
          {relay.killswitch.foreign.map(l => <code key={l} className="bw-path">{l}</code>)}
        </p>
      )}

      <button className="bw-why" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <span className="bw-chev" aria-hidden>{open ? "▾" : "▸"}</span>{" "}
        {relay.verdict === "protected" ? "How to undo the block" : "What it can reach, and how to stop it"}
      </button>

      {open && (
        <div className="bw-rc-body">
          {granted.length > 0 && (
            <dl className="bw-key">
              {granted.map(p => (
                <Fragment key={`${p.browser}/${p.profile}`}>
                  <dt>{p.name}{p.profile === "Default" ? "" : ` · ${p.profile}`}</dt>
                  <dd>
                    {p.report!.enabled ? "enabled" : "installed but switched off"}
                    {p.report!.allUrls ? ", can act on every site" : ", limited to the sites it was granted"}
                    {p.report!.sensitiveApis.length > 0 && <> — {p.report!.sensitiveApis.join(", ")}</>}
                  </dd>
                </Fragment>
              ))}
            </dl>
          )}
          {unreadable.length > 0 && (
            /* "Could not read" and "nothing granted" are the same shape and not
               the same fact, and this is the one screen where saying the
               reassuring one by mistake matters. */
            <p className="bw-rc-note">
              {unreadable.map(p => p.name).join(", ")} — its settings file could not be read, so
              nothing is claimed about it either way.
            </p>
          )}
          {!relay.hostsRead && (
            <p className="bw-rc-note">
              {relay.hostsPath} could not be read, so whether the relay is already blocked is unknown.
            </p>
          )}
          {granted.some(p => p.report!.allUrls) && (
            <p className="bw-rc-note">
              Narrowing the sites in <code className="bw-path">chrome://extensions</code> does not
              change this: the grant is held at the browser level and the per-site list is enforced
              inside the extension, by the extension.
            </p>
          )}
          <div className="bw-rc-cmd">
            <code>{cmd.command}</code>
            <button className="btn bw-rc-copy" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <p className="bw-rc-note">{cmd.note}</p>
        </div>
      )}
    </section>
  );
}
