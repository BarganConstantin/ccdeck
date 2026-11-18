// Every machine this deck knows of, one row each, with the sentence that says
// what is happening to it and the one verb that changes it.
//
// Lifted out of LanSyncSection.tsx unchanged. The rows are deckRows', in the
// order the section hands them, and every press on one goes back to the
// section: its verbs for the requests, its dialogs for the row's door and for
// an invite, and its arming for unpair. The arming stays the section's state so
// that an armed row outlives this list the way it always has. What is here is
// how a row is drawn.
import { useT } from "../i18n";
import type { DeckRow } from "../lan-roster";
import type { LanStatus } from "../lan-types";
import type { useLanSection } from "../use-lan-section";

type Section = ReturnType<typeof useLanSection>;

export default function LanDeckList({
  rows, pairingMode, armed, pressProps, answer, dropAddress, onUnpair, onOpenPeer, onInvite,
}: {
  /** What to draw, in the order to draw it. */
  rows: DeckRow[];
  /** Read for which verb a nearby or declined row offers. */
  pairingMode: LanStatus["pairingMode"];
  /** The paired row whose unpair is waiting for its second press. */
  armed: string | null;
  pressProps: Section["pressProps"];
  answer: Section["answer"];
  dropAddress: Section["dropAddress"];
  /** A press on a paired row's unpair; the section decides what it means. */
  onUnpair: (row: DeckRow) => void;
  /** The row's door: open that deck's own dialog. */
  onOpenPeer: (fp: string) => void;
  /** An invite-only deck's one way to pair a nearby machine. */
  onInvite: () => void;
}) {
  const t = useT();
  return (
    <ul className="ap-lan-here">
      {rows.map((p, i) => (
        // NO TOOLTIP. The long sentence it carried — the address, the
        // raw error, why a one-way deck cannot be repaired from — is in
        // the deck's own dialog now: one press away and read to a screen
        // reader, instead of a second late and over the rows below.
        <li key={`${p.kind}:${p.fp}`} className="ap-lan-who" data-tone={p.tone}>
          {/* THE MACHINE, in V4's 14px glyph, and the traffic light on its
              corner: the glyph says what the row is, the mark says whether it
              is up, down or wrong — three colours, two shapes, as before. */}
          <svg className="ap-lan-glyph" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor"
            strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="1.8" y="2.3" width="10.4" height="7.2" rx="1.2" />
            <path d="M5 11.9h4M7 9.5v2.4" />
          </svg>
          <i className={p.here ? "ap-pulse" : "ap-dot"} aria-hidden />
          {/* THE NAME OWNS THE ROW'S WIDTH, and it did not. The state
              was the flex item that grew and the name the one that
              shrank, so a machine's identity — the thing a reader is
              looking for — collapsed to `192.168.1….` while a sentence
              that changes every minute took the space and wrapped
              anyway. They are two lines now, and the second one is
              allowed to be long.

              AND THE ROW IS THE DOOR. The button is laid over the whole
              row, under the verb, so a press anywhere on it opens that
              machine's dialog and the keyboard's ring goes round the
              row. The name drawn here is the same words the button
              says, so a screen reader is told them once, by the
              button. */}
          <span className="ap-lan-who-name" aria-hidden>
            {p.name}
            {/* Which route, only when it is the unusual one: a row
                reached over the tailnet says so beside its name. */}
            {p.via === "tailscale" && <span className="ap-lan-via"> · {t("lan.list.via")}</span>}
          </span>
          {/* Described by the row's own sentence, which sits outside the
              button: a row reached with Tab is announced with what is
              happening to that machine, not with its name alone. */}
          <button type="button" className="ap-lan-who-open" aria-haspopup="dialog"
            aria-describedby={`lan-who-state-${i}`}
            onClick={() => onOpenPeer(p.fp)}>
            <span className="vis-hidden">{t(p.via === "tailscale" ? "lan.list.detailsTs" : "lan.list.details", { name: p.name })}</span>
          </button>
          {/* THE SECOND LINE IS EVERY ROW'S, as V4's Figma draws it: whether
              the machine is there, how its logins are and when it was last
              heard — `online · all logins fine · 2m ago`. A row with nothing
              to report used to spend no line on it; the list is rows of two
              lines now, 44 high, and the sentence is the thing a glance
              reads. */}
          <span id={`lan-who-state-${i}`} className="ap-lan-who-when">{p.state}</span>
          {p.kind === "nearby" && pairingMode !== "invite" && (
            <button type="button" className="ap-manage-btn ap-lan-do" {...pressProps(`accept:${p.fp}`)}
              onClick={() => void answer("accept", p.fp, "reach that deck")}
              aria-label={t("lan.list.askAria", { name: p.name })}
              title={t("lan.list.askTitle", { name: p.name, fp: p.fp })}>
              {t("lan.list.ask")}
            </button>
          )}
          {/* INVITE-ONLY TAKES THE ASK AWAY, AND THIS IS WHAT IT
              LEAVES: the one way this machine can still be paired,
              on its own row, where the reader is already looking.
              Opens the add dialog with the invite made — a
              dialog, said the way the row's own door says it. */}
          {(p.kind === "nearby" || p.kind === "declined") && pairingMode === "invite" && (
            <button type="button" className="ap-manage-btn ap-lan-do" aria-haspopup="dialog"
              onClick={onInvite}
              aria-label={t("lan.list.inviteAria", { name: p.name })}
              title={t("lan.list.inviteTitle", { name: p.name })}>
              {t("lan.list.invite")}
            </button>
          )}
          {p.kind === "paired" && (
            // ARMED, like the account row's own remove. Unpairing is
            // the one thing in this section that cannot be undone from
            // this section — the other deck has to ask again and
            // somebody has to answer — and it sat one stray click away,
            // once per row, in the loudest ink on the surface.
            <button type="button"
              className={`ap-manage-btn ap-lan-do danger${armed === p.fp ? " armed" : ""}`}
              {...pressProps(`unpair:${p.fp}`)}
              onClick={() => onUnpair(p)}
              aria-label={t(armed === p.fp ? "lan.unpair.confirmAria" : "lan.unpair.aria", { name: p.name })}
              title={armed === p.fp
                ? t("lan.unpair.confirmTitle")
                : t("lan.unpair.title")}>
              {/* The word the account row's armed remove says (#839):
                  one arm-then-confirm idiom for every in-panel act that
                  cannot be undone here; only Clear, which destroys the
                  most, asks in a dialog. */}
              {armed === p.fp ? t("lan.list.confirm") : t("lan.list.unpair")}
            </button>
          )}
          {p.kind === "dialling" && (
            <button type="button" className="ap-manage-btn ap-lan-do" {...pressProps(`drop:${p.fp}`)}
              onClick={() => void dropAddress(p.fp)}
              aria-label={t("lan.list.stopAria", { name: p.name })}
              title={t("lan.foot.dropTitle")}>
              {t("lan.list.stop")}
            </button>
          )}
          {p.kind === "declined" && pairingMode !== "invite" && (
            <button type="button" className="ap-manage-btn ap-lan-do" {...pressProps(`allow:${p.fp}`)}
              onClick={() => void answer("allow", p.fp, "let that deck ask again")}
              aria-label={t("lan.list.allowAria", { name: p.name })}
              title={t("lan.list.allowTitle")}>
              {t("lan.list.allow")}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
