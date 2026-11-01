// Every deck folded into one row of the list, in that row's dialog.
//
// Lifted out of LanPeerModal.tsx unchanged. The dialog hands it the decks at
// the machine's address, the one the dialog is about first, and the dialog's
// own busy tag, press state and unpair for each; the arming is the dialog's,
// in use-peer-unpair.ts.
import { useT } from "../i18n";
import { seenOrJustNow } from "../lan-round";
import type { DeckRow, RowSource } from "../lan-roster";

/**
 * ONE MACHINE, MORE THAN ONE DECK. The list draws a machine once —
 * two rows with one name, and no address to tell them apart, are
 * one machine to anybody reading them — and this is where every
 * deck folded into that row is still accounted for: its port, its
 * fingerprint, what it runs, and a way to let go of the one that
 * should not be there. A key the machine held before and dropped
 * is one of these too: paired, no address, never calling again.
 * Everything above is about the first.
 */
export default function LanPeerTwins({ instances, now, busy, press, armedTwin, pressTwin, onUnpair }: {
  /** Every deck at this address, the one the dialog is about first. */
  instances: Array<{ row: DeckRow; peer: RowSource["peer"] | null }>;
  now: number;
  /** The section's one busy tag — see pressState. */
  busy: string | null;
  /** The dialog's press state for a control, by busy tag. */
  press: (tag: string) => { disabled: boolean; "aria-busy": boolean };
  /** Which folded deck's unpair is armed, by fingerprint. */
  armedTwin: string | null;
  pressTwin: (fp: string) => void;
  /** Unpair one of the folded decks. None, and there is no button to press. */
  onUnpair?: (fp: string) => Promise<string | null>;
}) {
  const t = useT();
  return (
    <div className="modal-section">
      <h3 className="lan-h">{t("lan.twins.h", { count: instances.length })}</h3>
      <ul className="lan-twins" role="list">
        {instances.map((inst, i) => {
          const at = inst.peer?.addr ? `${inst.peer.addr}:${inst.peer.port}` : inst.row.addr;
          const named = at || inst.row.fp;
          const since = inst.peer?.pairedAt ? seenOrJustNow(inst.peer.pairedAt, now) : null;
          const meta = [
            inst.peer?.about?.version ? t("lan.twins.runs", { version: inst.peer.about.version }) : null,
            since ? t("lan.twins.paired", { when: since }) : null,
            inst.row.state,
          ].filter(Boolean).join(" · ");
          const fpT = inst.row.fp;
          return (
            <li key={fpT} role="listitem" className="lan-twin" data-tone={inst.row.tone}>
              <i className={inst.row.here ? "ap-pulse" : "ap-dot"} aria-hidden />
              {at
                ? <code className="ap-lan-code lan-twin-at">{at}</code>
                : <span className="lan-twin-at lan-twin-none">{t("lan.twins.noAddr")}</span>}
              <code className="ap-lan-code lan-twin-fp">{fpT}</code>
              {/* Before the second line in the markup, so the grid
                  places it beside the identity and lets it span both
                  lines; after it, auto-placement dropped it onto the
                  second line, a row below the address it acts on. */}
              {i > 0 && onUnpair && (
                <button type="button"
                  className={`ap-manage-btn danger lan-twin-do${armedTwin === fpT ? " armed" : ""}`}
                  {...press(`unpair:${fpT}`)}
                  onKeyDown={e => { if (e.repeat) e.preventDefault(); }}
                  onClick={() => pressTwin(fpT)}
                  aria-label={t(armedTwin === fpT ? "lan.unpair.confirmAria" : "lan.unpair.aria", { name: named })}
                  title={armedTwin === fpT
                    ? t("lan.unpair.confirmTitle")
                    : t("lan.twins.title")}>
                  {busy === `unpair:${fpT}` ? t("lan.twins.unpairing") : armedTwin === fpT ? t("lan.list.confirm") : t("lan.list.unpair")}
                </button>
              )}
              <span className="lan-twin-meta">{i === 0 ? t("lan.twins.shownAbove", { meta }) : meta}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
