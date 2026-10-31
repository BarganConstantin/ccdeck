// The picture in a deck's own dialog.
//
// Lifted out of LanPeerModal.tsx unchanged, with the two drawings only it
// uses. Everything it says is peerView's, in lan-peer.ts; the dialog hands
// that over with the row and this deck's status, whether a check is out and
// how many have come back, and its door to this deck's own settings, which is
// the one control the picture carries.
import type { CSSProperties } from "react";

import type { peerView } from "../lan-peer";
import { laneSaid } from "../lan-peer";
import { useT } from "../i18n";
import { isSeenNow, justNowTail } from "../lan-round";
import { Fill } from "./LanAsks";
import { roundWhy } from "../lan-round";
import type { DeckRow } from "../lan-roster";
import type { LanStatus } from "../lan-types";

/** A machine, at the same stroke: a screen and the desk under it. The network
 *  map draws every deck on it with the same one. */
export function Machine() {
  return (
    <svg className="lan-machine" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.5" y="3" width="11" height="7.5" rx="1.2" />
      <path d="M1 13h14" />
    </svg>
  );
}

/** Which way a copy travels, drawn at the end it arrives at. */
function Chevron({ dir }: { dir: "in" | "out" }) {
  return (
    <svg className="lan-chev" data-dir={dir} width="8" height="8" viewBox="0 0 8 8"
      fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={dir === "out" ? "M2.8 1L6 4 2.8 7" : "M5.2 1L2 4l3.2 3"} />
    </svg>
  );
}

export default function LanPeerMap({ view, row, status, asking, drawn, onSettings }: {
  /** What the dialog says about the machine — see peerView. */
  view: ReturnType<typeof peerView>;
  row: DeckRow;
  status: LanStatus;
  /** A check is out to that deck, which the network's line shows. */
  asking: boolean;
  /** Bumped when a check comes back, so the lanes draw themselves again. */
  drawn: number;
  /** Close the dialog and open what this deck offers. */
  onSettings: () => void;
}) {
  const t = useT();
  const {
    peer, paired, where, about, unsaid, hereRuns, thereRuns, order, line, silence, raw, echoed, showRound,
    how, link, hiddenThere, otherThere, lanes, spent, taking, giving, givenTo, told, unplaced, unknown, stale,
  } = view;
  return (
    // THE PICTURE: this deck on the left, that one on the right, the
    // network across the top and one lane per login under it. The two
    // rails down from the machines are where every lane's ends dock,
    // so a mark's side says whose copy it is without a word.
    <div className="lan-map" data-link={link} data-asking={asking || undefined}
      data-bus={lanes.length > 0 || undefined}>
      <div className="lan-ends">
        <p className="lan-end">
          <span className="lan-end-name">{t("lan.thisDeck")}</span>
          {hereRuns && <span className="lan-end-runs">{hereRuns}</span>}
          {/* This deck's own switch, said where its owner looks: the
              decks it is paired with are reading this line about it. */}
          {paired && status.shareActive === false && (
            <span className="lan-end-note">{t("lan.currentHidden")}</span>
          )}
        </p>
        <p className="lan-end" data-side="there">
          <span className="lan-end-name">{row.name}</span>
          {row.kind !== "dialling" && (
            <span className="lan-end-runs">
              {thereRuns ?? (about ? t("lan.pm.notSaid") : unsaid)}
              {order ? ` · ${order < 0 ? t("lan.pm.older") : t("lan.pm.newer")}` : null}
            </span>
          )}
          {/* Working, and its owner chose not to say on which account —
              said, rather than drawn as nothing, so that is what it reads as. */}
          {hiddenThere && <span className="lan-end-note">{t("lan.currentHidden")}</span>}
          {/* Working on an account it does not share: said, never named. */}
          {otherThere && <span className="lan-end-note">{t("lan.pm.otherAccount")}</span>}
        </p>
      </div>

      <div className="lan-link">
        <Machine />
        <span className="lan-span">
          <span className="lan-wire" aria-hidden>
            <i className="lan-glint" data-dir="out" />
            <i className="lan-glint" data-dir="in" />
          </span>
          <span className="lan-link-label">
            {where ? <code className="ap-lan-code">{where}</code> : t("lan.pm.noAddr")}
          </span>
        </span>
        <Machine />
        {((where && how) || showRound) && (
          <p className="lan-link-sub">
            {where && how}
            {where && how && showRound && " · "}
            {showRound && (
              !line ? t("lan.pm.notAsked")
                : echoed ? <code className="ap-lan-code">{raw}</code>
                // `now` is a column's word; after a clause it reads as an order.
                : <span className="lan-round" data-tone={line.tone}>{justNowTail(line.text)}</span>
            )}
            {showRound && raw && !echoed && <code className="lan-fact-raw">{raw}</code>}
          </p>
        )}
        {unplaced.length > 0 && (
          <ul className="lan-done">
            {unplaced.map(d => {
              const why = roundWhy(d);
              return (
                <li key={`${d.email}:${d.action}`} data-ok={d.ok && !why}>
                  {d.email} <span className="lan-done-what">{d.ok ? t("lan.pm.arrived") : t("lan.pm.notArrived")}{why && ` — ${why.long}`}</span>
                </li>
              );
            })}
          </ul>
        )}
        {/* Why the silence, when this deck holds evidence the socket did
            not — a beacon from the same machine. See silenceNote. */}
        {silence && <p className="lan-note lan-link-note">{silence}</p>}
        {/* The one-way case in full — the sentence the row's tooltip used
            to carry, which is the only place it is ever explained. */}
        {peer?.waiting && <p className="lan-note lan-link-note">{row.hint}</p>}
        {line?.hint && <p className="lan-note lan-link-note">{line.hint}</p>}
      </div>

      {lanes.length > 0 && (
        <ul key={drawn} className="lan-lanes" role="list" aria-label={t("lan.pm.lanesAria", { name: row.name })}>
          {lanes.map((l, i) => {
            const d = told.get(l.email);
            // An arrival with a problem is not drawn as a clean one.
            const why = d ? roundWhy(d) : null;
            const flows = l.out === "live" || (l.in != null && l.in !== "cut");
            return (
              <li key={l.key} role="listitem" className="lan-lane" data-tone={l.tone}
                data-draw={l.in && l.out ? "both" : l.in ? "in" : "out"}
                data-used-there={l.usedThere || undefined}
                style={{ "--i": i } as CSSProperties}>
                <i className="lan-pip" data-end="here" data-state={l.here} aria-hidden />
                <span className="lan-track">
                  <span className="lan-wire" data-flow={flows ? "live" : "cut"} aria-hidden>
                    {(l.in === "live" || l.in === "wait") && <i className="lan-glint" data-dir="in" data-tone={l.in} />}
                    {l.out === "live" && <i className="lan-glint" data-dir="out" />}
                  </span>
                  {l.in && l.in !== "cut" && <Chevron dir="in" />}
                  {l.out === "live" && <Chevron dir="out" />}
                  <span className="lan-lane-email">{l.email}</span>
                </span>
                <i className="lan-pip" data-end="there" data-state={l.there} aria-hidden />
                <span className="vis-hidden">{laneSaid(l)}</span>
                {(l.caption || d) && (
                  <span className="lan-lane-note">
                    {l.caption}
                    {l.caption && d && " · "}
                    {d && (
                      <span className="lan-lane-done" data-ok={d.ok && !why}>
                        {d.ok ? t("lan.pm.arrivedLast") : t("lan.pm.notArrivedLast")}{why && ` — ${why.long}`}
                      </span>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {paired && (
        <>
          {/* ONCE, for all of them. The fix is the same sign-in every
              time, so it is said where the lanes end. */}
          {spent.length > 0 && (
            <p className="lan-spent">
              {spent.length === 1 ? t("lan.pm.spentOne", { email: spent[0].email }) : t("lan.pm.spentMany")}
            </p>
          )}
          {unknown && <p className="lan-empty">{unknown}</p>}
          {/* The lanes are a fossil and say so under themselves — in the
              muted ink, because the warning is already under the name. */}
          {stale && <p className="lan-stale">{t("lan.pm.asOf", { when: isSeenNow(stale) ? t("lan.seen.justNow") : stale })}</p>}
          {/* THE KEY TO THE ARROWS, and the scope of this deck's half:
              a dialog about one deck is the one place somebody could
              take this deck's list to be that deck's alone. Who else
              is handed it is peerView's givenTo. */}
          <div className="lan-legend">
            {taking && (
              <span className="lan-key">
                <span className="lan-key-wire" data-dir="in" aria-hidden><Chevron dir="in" /></span>
                {t("lan.pm.from", { name: row.name })}
              </span>
            )}
            {giving ? (
              <span className="lan-key">
                <span className="lan-key-wire" data-dir="out" aria-hidden><Chevron dir="out" /></span>
                {t("lan.pm.fromHere", { to: givenTo })}
              </span>
            ) : (
              <span className="lan-key">{t("lan.pm.offersNothing")}</span>
            )}
            {/* The door to this deck's half, on the key that names it. */}
            <button type="button" className="ap-lan-word lan-legend-act" onClick={onSettings}
              aria-label={t("lan.pm.changeAria")}>
              {t("lan.pm.change")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
