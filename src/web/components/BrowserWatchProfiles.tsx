// Browser Watch's "Watched profiles": each browser the watch reads, whether it
// is running and whether it holds a connection to Anthropic's relay, and the
// browsers it does not read, behind a disclosure.
//
// Lifted out of BrowserWatchModal.tsx unchanged. The dialog splits its browsers
// into the two lists this takes, side by side, so the split is written once.
import { useState } from "react";

import type { WatchBrowser } from "../browser-watch-model";

export default function BrowserWatchProfiles({
  watching,
  rest,
}: {
  /** The dialog's one list of watched browsers, the one the radar draws. */
  watching: WatchBrowser[];
  /** Everything else: not installed, or installed and never opened. */
  rest: WatchBrowser[];
}) {
  const [showProfKey, setProfKey] = useState(false);
  const [restOpen, setRestOpen] = useState(false);

  return (
    <section className="bw-sec">
      <h4 className="bw-sec-head">
        Watched profiles
        {/* The relay note's caveat lives here rather than in a
            `title` on the note itself. A tooltip on a span nothing
            can focus is mouse-only, and this qualification is
            load-bearing — without it the note overclaims, because
            the probe cannot tell an agent channel from an open
            claude.ai tab. A span with `tabIndex` is not a control
            and `aria-label` on a generic role is invalid, so the
            note is plain status text and the caveat is a real
            disclosure, in the pattern this panel already uses. */}
        <button
          className="bw-help"
          onClick={() => setProfKey(k => !k)}
          aria-expanded={showProfKey}
          aria-label="What running, idle and connected to Anthropic mean"
        >?</button>
      </h4>
      {showProfKey && (
        <dl className="bw-key">
          <dt>Running</dt><dd>the browser has a process on this machine right now</dd>
          <dt>Connected</dt><dd>
            an open connection to an address Anthropic&apos;s relay uses — which it shares
            with claude.ai, so an open tab looks the same as an agent channel
          </dd>
        </dl>
      )}
      <ul className="bw-profiles">
        {watching.map(b => (
          <li key={b.key}>
            <span className={`bw-prof-dot${b.running ? " on" : ""}`} aria-hidden />
            <span className="bw-prof-name">{b.name}</span>
            <span className="bw-prof-state">{b.running ? "running" : "idle"}</span>
            {b.running && b.relay.state === "live" && (
              /* NEUTRAL, NOT AMBER. This was one of the strongest
                 accents on the panel, for a fact the probe cannot
                 actually establish: the relay shares an address
                 with claude.ai, so an open tab is indistinguishable
                 from an agent channel. What a tool cannot
                 distinguish must not be the loudest thing on its
                 screen. It states what was seen and keeps the
                 qualification on its title. */
              <span className="bw-relay">connected to Anthropic</span>
            )}
          </li>
        ))}
      </ul>
      {rest.length > 0 && (
        <>
          <button className="bw-why bw-rest-head" onClick={() => setRestOpen(v => !v)} aria-expanded={restOpen}>
            <span className="bw-chev" aria-hidden>{restOpen ? "▾" : "▸"}</span>{" "}
            {rest.length} not watched
          </button>
          {restOpen && (
            <p className="bw-rest">
              {rest.map(b => b.name).join(", ")} — not installed, or installed and never
              opened, so there is no history to read.
            </p>
          )}
        </>
      )}
    </section>
  );
}
