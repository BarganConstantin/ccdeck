// The two marks a provider incident gets (#1311): a chip in the topbar's
// readout, and a line under the provider's heading in the usage panel.
//
// Both draw only while a status page reports an incident — provider-status.ts
// decides what counts — so an operational provider, and one whose page could
// not be reached, add nothing to the screen. Both are links, and the link is
// the status page: the deck can say THAT something is wrong upstream, and the
// page is where the provider says what and for how long.
//
// Links rather than buttons, because that is what they do: a new tab on
// another site, which the ↗ says before the press. `noopener noreferrer`, so
// the page opened learns nothing about the deck, not even its port.
import type { Incident } from "../provider-status";

/**
 * The chips, one per provider in an incident, for the topbar's readout.
 *
 * NAMED BY WHAT THEY SHOW. There is no aria-label: the chip carries its words
 * in three lengths and the sheet shows one of them — the full state, one word
 * when the bar is short of room, and the "as of" of a stale answer — and a
 * fixed label could not contain whichever is on screen (2.5.3). The words the
 * sheet hides with `display: none` leave the name with them, so the name is
 * always what is visible, plus the vis-hidden tail that says where it goes.
 */
export function IncidentChips({ incidents }: { incidents: Incident[] }) {
  return (
    <>
      {incidents.map(i => (
        <a
          key={i.provider}
          // Written out, so unstyled-class.test.ts can hold both to a rule.
          className={i.stale ? "provider-incident provider-incident-stale" : "provider-incident"}
          data-state={i.state}
          href={i.href}
          target="_blank"
          rel="noopener noreferrer"
          title={i.detail}
        >
          <span className="pi-dot" aria-hidden />
          <span className="pi-name">{i.name}</span>
          <span className="pi-words">· {i.chipWords}</span>
          <span className="pi-short">· {i.shortWords}</span>
          {i.asOf && <span className="pi-asof">· as of {i.asOf}</span>}
          <span className="pi-go" aria-hidden>↗</span>
          <span className="vis-hidden">, on {i.host}, opens in a new tab</span>
        </a>
      ))}
    </>
  );
}

/** The line under a quota section's heading, or nothing without an incident. */
export function QuotaIncident({ incident }: { incident: Incident | null | undefined }) {
  if (!incident) return null;
  return (
    <a
      className={incident.stale ? "up-incident up-incident-stale" : "up-incident"}
      data-state={incident.state}
      href={incident.href}
      target="_blank"
      rel="noopener noreferrer"
      title={incident.detail}
    >
      <span className="pi-dot" aria-hidden />
      {/* The provider is the section's heading to the eye; a links list read
          out of context has no heading, so it is said here. */}
      <span className="up-incident-words">
        <span className="vis-hidden">{incident.name}: </span>
        {/* "Partial outage": it opens the line, where the chip's words follow a name. */}
        {incident.words[0].toUpperCase() + incident.words.slice(1)}{incident.asOf ? ` · as of ${incident.asOf}` : ""}
      </span>
      <span className="up-incident-go" aria-hidden>↗</span>
      {/* Its own row, under the state: the panel is a 280px column, and on one
          line with the state and the page's host the title was cut to four
          letters. The host is said to a screen reader and in the title. */}
      {incident.what && <span className="up-incident-what">{incident.what}</span>}
      <span className="vis-hidden">, on {incident.host}, opens in a new tab</span>
    </a>
  );
}
