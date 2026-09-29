// Every deck folded into one row of the list, in that row's dialog.
//
// Lifted out of LanPeerModal.tsx unchanged. The dialog hands it the decks at
// the machine's address, the one the dialog is about first, and the dialog's
// own busy tag, press state and unpair for each; the arming is the dialog's,
// in use-peer-unpair.ts.
import { seenLabel } from "../lan-round";
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
  return (
    <div className="modal-section">
      <h3 className="lan-h">{instances.length} decks on this machine</h3>
      <ul className="lan-twins" role="list">
        {instances.map((t, i) => {
          const at = t.peer?.addr ? `${t.peer.addr}:${t.peer.port}` : t.row.addr;
          const named = at || t.row.fp;
          const since = t.peer?.pairedAt ? seenLabel(t.peer.pairedAt, now) : null;
          const meta = [
            t.peer?.about?.version ? `runs ${t.peer.about.version}` : null,
            since ? `paired ${since === "now" ? "just now" : since}` : null,
            t.row.state,
          ].filter(Boolean).join(" · ");
          const fpT = t.row.fp;
          return (
            <li key={fpT} role="listitem" className="lan-twin" data-tone={t.row.tone}>
              <i className={t.row.here ? "ap-pulse" : "ap-dot"} aria-hidden />
              {at
                ? <code className="ap-lan-code lan-twin-at">{at}</code>
                : <span className="lan-twin-at lan-twin-none">no address here</span>}
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
                  aria-label={armedTwin === fpT ? `Confirm unpairing ${named}` : `Unpair ${named}`}
                  title={armedTwin === fpT
                    ? "Press again to stop talking to this deck. Logins it already has stay with it."
                    : "Stop talking to this one of the machine's decks"}>
                  {busy === `unpair:${fpT}` ? "unpairing…" : armedTwin === fpT ? "confirm" : "unpair"}
                </button>
              )}
              <span className="lan-twin-meta">{i === 0 ? `${meta} · shown above` : meta}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
