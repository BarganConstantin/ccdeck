// Somebody dialled this deck without an invite and is waiting: every request
// still unanswered, each with the fingerprint to check and the two answers.
//
// Lifted out of LanSyncSection.tsx unchanged. The section places it first in
// its view and says why; both answers go back through the section's own
// `answer`, under the busy tags the section's request slot hands out.
import type { DeckRow } from "../lan-roster";
import type { useLanSection } from "../use-lan-section";

type Section = ReturnType<typeof useLanSection>;

export default function LanAsks({ asks, pressProps, answer }: {
  /** The rows that are asking, in the order deckRows gives them. */
  asks: DeckRow[];
  pressProps: Section["pressProps"];
  answer: Section["answer"];
}) {
  return (
    <div className="ap-lan-asks" role="alert">
      {asks.map(p => (
        <div key={p.fp} className="ap-lan-ask">
          <span className="ap-lan-ask-what">
            <strong className="ap-lan-peer-name">{p.name}</strong>
            {" at "}<code className="ap-lan-code">{p.addr}</code>
            {" wants to pair"}
          </span>
          {/* PRINTED, NOT HOVERED. The one security decision in this
              feature is whether the machine asking is the one you think
              it is, and the only value that cannot be chosen by whoever
              is asking is this. It lived in `title=` — a mouse-only,
              one-second-delayed, screen-reader-silent place — so on the
              surface that answers most requests it could not be checked
              at all. The dialog that opens over the deck has printed it
              since it was written; this is the same fact on the row
              that does the same job. */}
          <span className="ap-lan-ask-fp" id={`lan-ask-fp-${p.fp}`}>
            fingerprint <code className="ap-lan-code">{p.fp}</code>
          </span>
          {/* Named for the deck each one answers, as the deck list names its
              verbs (#1745): tabbing from button to button reads no row, so a
              bare "accept" did not say which machine it would pair. Both are
              described by the fingerprint printed above them. */}
          <span className="ap-lan-ask-acts">
            <button type="button" className="ap-manage-btn" {...pressProps(`accept:${p.fp}`)}
              aria-label={`Accept ${p.name}`} aria-describedby={`lan-ask-fp-${p.fp}`}
              onClick={() => void answer("accept", p.fp, "accept that deck")}
              title={`Talk to this deck from now on. Its fingerprint is ${p.fp} — check it matches the one on their screen before you accept.`}>
              accept
            </button>
            <button type="button" className="ap-manage-btn" {...pressProps(`dismiss:${p.fp}`)}
              aria-label={`Decline ${p.name}`} aria-describedby={`lan-ask-fp-${p.fp}`}
              onClick={() => void answer("dismiss", p.fp, "decline that request")}
              title="Say no. Nothing is shared, and that deck is told rather than left waiting.">
              decline
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
