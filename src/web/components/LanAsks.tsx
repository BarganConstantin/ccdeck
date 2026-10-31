// Somebody dialled this deck without an invite and is waiting: every request
// still unanswered, each with the fingerprint to check and the two answers.
//
// Lifted out of LanSyncSection.tsx unchanged. The section places it first in
// its view and says why; both answers go back through the section's own
// `answer`, under the busy tags the section's request slot hands out.
import { Fragment, type ReactNode } from "react";
import { useT } from "../i18n";
import type { DeckRow } from "../lan-roster";
import type { useLanSection } from "../use-lan-section";

type Section = ReturnType<typeof useLanSection>;

/** A catalog sentence with elements where its {placeholders} are, so a
 *  language can put the name and the address wherever its grammar wants them. */
export function Fill({ text, parts }: { text: string; parts: Record<string, ReactNode> }) {
  return (
    <>
      {text.split(/(\{\w+\})/).map((piece, i) => {
        const name = /^\{(\w+)\}$/.exec(piece)?.[1];
        return <Fragment key={i}>{name && name in parts ? parts[name] : piece}</Fragment>;
      })}
    </>
  );
}

export default function LanAsks({ asks, pressProps, answer }: {
  /** The rows that are asking, in the order deckRows gives them. */
  asks: DeckRow[];
  pressProps: Section["pressProps"];
  answer: Section["answer"];
}) {
  const t = useT();
  return (
    <div className="ap-lan-asks" role="alert">
      {asks.map(p => (
        <div key={p.fp} className="ap-lan-ask">
          <span className="ap-lan-ask-what">
            <Fill text={t("lan.asks.what")} parts={{
              name: <strong className="ap-lan-peer-name">{p.name}</strong>,
              addr: <code className="ap-lan-code">{p.addr}</code>,
            }} />
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
            <Fill text={t("lan.asks.fp")} parts={{ fp: <code className="ap-lan-code">{p.fp}</code> }} />
          </span>
          {/* Named for the deck each one answers, as the deck list names its
              verbs (#1745): tabbing from button to button reads no row, so a
              bare "accept" did not say which machine it would pair. Both are
              described by the fingerprint printed above them. */}
          <span className="ap-lan-ask-acts">
            <button type="button" className="ap-manage-btn" {...pressProps(`accept:${p.fp}`)}
              aria-label={t("lan.asks.acceptAria", { name: p.name })} aria-describedby={`lan-ask-fp-${p.fp}`}
              onClick={() => void answer("accept", p.fp, "accept that deck")}
              title={t("lan.asks.acceptTitle", { fp: p.fp })}>
              {t("lan.asks.accept")}
            </button>
            <button type="button" className="ap-manage-btn" {...pressProps(`dismiss:${p.fp}`)}
              aria-label={t("lan.asks.declineAria", { name: p.name })} aria-describedby={`lan-ask-fp-${p.fp}`}
              onClick={() => void answer("dismiss", p.fp, "decline that request")}
              title={t("lan.asks.declineTitle")}>
              {t("lan.asks.decline")}
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
