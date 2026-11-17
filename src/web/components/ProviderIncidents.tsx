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
import { useEffect, useState } from "react";
import type { Incident } from "../provider-status";
import { useT } from "../i18n";
import { ExternalLinkGlyph } from "./action-glyphs";
import ChipPresence from "./ChipPresence";

const ORDER: Incident["provider"][] = ["claude", "codex"];

/**
 * One chip, for the topbar's readout.
 *
 * NAMED BY WHAT THEY SHOW. There is no aria-label: the chip carries its words
 * in three lengths and the sheet shows one of them — the full state, one word
 * when the bar is short of room, and the "as of" of a stale answer — and a
 * fixed label could not contain whichever is on screen (2.5.3). The words the
 * sheet hides with `display: none` leave the name with them, so the name is
 * always what is visible, plus the vis-hidden tail that says where it goes.
 */
function IncidentChip({ i }: { i: Incident }) {
  const t = useT();
  return (
    <a
      // Written out, so unstyled-class.test.ts can hold both to a rule.
      className={i.stale ? "provider-incident provider-incident-stale" : "provider-incident"}
      data-state={i.state}
      href={i.href}
      target="_blank"
      rel="noopener noreferrer"
      title={i.detail}
    >
      {/* V4's Figma: a 14px icon (the state's shape in its centre) and one
          line, "Claude · partial outage · as of HH:MM" — the time the
          status page last answered (Incident.readAt). The ↗ left the chip
          with the frame; the title and the hidden tail still say it opens
          the provider's page in a new tab. */}
      <span className="pi-icon" aria-hidden><span className="pi-dot" /></span>
      <span className="pi-text">
        <span className="pi-name">{i.name}</span>
        {" "}<span className="pi-words">· {i.chipWords}</span>
        {" "}<span className="pi-short">· {i.shortWords}</span>
        {" "}<span className="pi-asof">· {t("shell.incident.asOf", { time: i.readAt })}</span>
      </span>
      <span className="vis-hidden">, {t("shell.incident.opens", { host: i.host })}</span>
    </a>
  );
}

/** The chips, one per provider in an incident, for the topbar's readout. */
export function IncidentChips({ incidents }: { incidents: Incident[] }) {
  // A provider whose incident ended stays in its slot until the exit has run
  // out (ChipPresence), drawn from the last thing it was given.
  const [leaving, setLeaving] = useState<Incident["provider"][]>([]);
  const present = new Map(incidents.map(i => [i.provider, i] as const));
  useEffect(() => {
    setLeaving(prev => {
      const next = ORDER.filter(p => present.has(p) || prev.includes(p));
      return next.length === prev.length && next.every((p, n) => p === prev[n]) ? prev : next;
    });
  });
  const providers = ORDER.filter(p => present.has(p) || leaving.includes(p));
  return (
    <>
      {providers.map(p => {
        const i = present.get(p);
        return (
          <ChipPresence
            key={p}
            show={i !== undefined}
            onExited={() => setLeaving(prev => (present.has(p) ? prev : prev.filter(x => x !== p)))}
          >
            {i ? <IncidentChip i={i} /> : null}
          </ChipPresence>
        );
      })}
    </>
  );
}

/** The line under a quota section's heading, or nothing without an incident. */
export function QuotaIncident({ incident }: { incident: Incident | null | undefined }) {
  const t = useT();
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
        {incident.words[0].toUpperCase() + incident.words.slice(1)}{incident.asOf ? ` · ${t("shell.incident.asOf", { time: incident.asOf })}` : ""}
      </span>
      <span className="up-incident-go" aria-hidden><ExternalLinkGlyph /></span>
      {/* Its own row, under the state: the panel is a 280px column, and on one
          line with the state and the page's host the title was cut to four
          letters. The host is said to a screen reader and in the title. */}
      {incident.what && <span className="up-incident-what">{incident.what}</span>}
      <span className="vis-hidden">, {t("shell.incident.opens", { host: incident.host })}</span>
    </a>
  );
}
