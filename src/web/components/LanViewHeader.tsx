// The Local network view's header: the way back, the title, this section's
// own acts and the panel's close.
//
// Lifted out of LanSyncSection.tsx unchanged. It is the panel's header shape —
// the accounts view's own header is the same row — and every press on it goes
// back to the section: the add dialog and the settings are the section's
// dialogs, the round is the section's write, and Back hands the column to the
// accounts. What is here is which acts are drawn when, and how.
import type { ReactNode } from "react";

import type { LanStatus } from "../lan-types";
import type { useLanSection } from "../use-lan-section";
import { MapGlyph } from "./LanNetworkMap";

type Section = ReturnType<typeof useLanSection>;

export default function LanViewHeader({
  on, status, paired, busy, pressProps, checkNow, setAddOpen, setSetupOpen, setMapOpen, onBack, closeButton,
}: {
  /** Whether this deck is on the network. Every act here is about a deck that is. */
  on: boolean;
  /** Read for what the add glyph's title promises under invite-only. */
  status: LanStatus | null;
  /** How many paired decks are on the list: none, and there is nobody to check. */
  paired: number;
  busy: Section["busy"];
  pressProps: Section["pressProps"];
  checkNow: Section["checkNow"];
  /** Open the add dialog, through the door this glyph is. */
  setAddOpen: (door: "add") => void;
  /** Open this deck's own settings. */
  setSetupOpen: (open: true) => void;
  /** Open the network map. */
  setMapOpen: (open: true) => void;
  /** Give the column back to the accounts. */
  onBack: () => void;
  /** The panel's close, drawn in this view's header as it is in the accounts'. */
  closeButton?: ReactNode;
}) {
  return (
    <div className="ap-header">
      <button type="button" id="ap-lan-back" className="glyph-btn ap-back" onClick={onBack}
        aria-label="Back to Claude accounts" title="Back to Claude accounts">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
          strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M8.4 3.4 4.8 7l3.6 3.6" />
        </svg>
      </button>
      <h2 id="ap-lan-title">Local network</h2>
      <div className="ap-header-right">
        {/* THE ROUND, BESIDE THE SWITCH. It was a full-width button at the foot
            of the section, under the list it refreshes and under a tooltip that
            covered it — and it is the panel's own idiom for exactly this act:
            the accounts header has carried a `↻` since it was written. A glyph
            up here is also the honest size for it, now that the line under the
            title says when the last one ran and most readers will never need to
            press it at all. */}
        {/* THREE ACTS AND A STATE, and the three are one icon family.
            They were `+`, `↻` and `⚙` — three Unicode codepoints out of three
            different blocks, drawn by whichever installed font happened to
            cover each one. Measured, that is 8.7x7.4, 9.8x9.9 and 7.2x7.2 of
            ink in a row of three 24px buttons: the round a third taller than
            the cog beside it, and two different font-sizes here trying to
            correct for it. An icon is drawn, not typed. These are authored at
            the app's own small-icon spec — 13px on a 14 viewBox, 1.3 stroke,
            round caps — which is what the topbar's five and the browser-watch
            modal's cog already are.

            The add was `+ add a deck` at the foot, in the panel's word-button
            costume, beside settings it has nothing to do with. It became a
            plus, and the check beside it a round: the accounts header's add and
            reload, a few rows up, meaning two other things (#838). So adding a
            deck is a link — pairing is what it starts — and checking the paired
            decks is a broadcast, one ask sent to all of them. */}
        {/* THE MAP, FIRST OF THE FOUR: it is the one act here that changes
            nothing, and it is about every deck on the list at once. */}
        {on && (
          <button type="button" className="glyph-btn ap-lan-mapbtn" onClick={() => setMapOpen(true)}
            aria-label="Show the network map"
            title="Network map — every deck this one knows, drawn around it">
            <MapGlyph />
          </button>
        )}
        {on && (
          <button type="button" className="glyph-btn ap-lan-plus"
            onClick={() => setAddOpen("add")}
            aria-label="Add a deck"
            title={status?.pairingMode === "invite"
              ? "Send an invite, or use one you were sent. This deck pairs only by invite."
              : "Reach a deck that has not turned up on its own — by address, or with an invite"}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
              strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6.1 7.9a2.6 2.6 0 0 0 3.7 0l1.9-1.9a2.6 2.6 0 0 0-3.7-3.7l-.9.9" />
              <path d="M7.9 6.1a2.6 2.6 0 0 0-3.7 0L2.3 8a2.6 2.6 0 0 0 3.7 3.7l.9-.9" />
            </svg>
          </button>
        )}
        {on && paired > 0 && (
          <button type="button" className="glyph-btn ap-lan-check" {...pressProps("check")}
            onClick={() => void checkNow()}
            aria-label={busy === "check" ? "Checking every paired deck" : "Check every paired deck now"}
            title="Ask every paired deck now for anything this deck's expired logins need, instead of waiting for the next round">
            {/* A broadcast: a point and two rings of arcs, one ask sent to every
                paired deck at once (#838). The round it replaced is the accounts
                header's reload, two sections up. */}
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
              strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="7" cy="7" r="1.1" fill="currentColor" stroke="none" />
              <path d="M4.6 4.6a3.4 3.4 0 0 0 0 4.8M9.4 4.6a3.4 3.4 0 0 1 0 4.8" />
              <path d="M2.6 2.6a6.2 6.2 0 0 0 0 8.8M11.4 2.6a6.2 6.2 0 0 1 0 8.8" />
            </svg>
          </button>
        )}
        {/* AND THE SETTINGS, on the same row as the three controls that are also
            about this deck rather than about the machines on the list. It was
            `name & sharing` at the foot — a phrase naming a dialog's two fields,
            which is a caption rather than a control, and the last thing left
            down there beside a timestamp. A cog is what every application on
            this machine uses for the same door. */}
        {on && (
          <button type="button" className="glyph-btn ap-lan-set" {...pressProps("setup")}
            onClick={() => setSetupOpen(true)}
            aria-label="This deck's name and shared logins"
            title="This deck's name on the network, and which of its logins it offers">
            {/* SLIDERS, NOT A COG, and the reason is what came back from the
                render. The browser-watch modal draws its settings as a circle
                with eight straight radial spokes, and at 13px that is the
                universal brightness glyph — a sun, in a row about a network.
                Reusing it would have been reuse of a drawing that says the
                wrong thing, next to a plus and a round where the wrong thing is
                readable. A gear with real teeth is mush at this size; two rails
                and two knobs is the shape that stays a setting all the way
                down. */}
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
              strokeWidth="1.3" strokeLinecap="round" aria-hidden>
              <path d="M1.8 4.7h10.4M1.8 9.3h10.4" />
              <circle cx="9.1" cy="4.7" r="1.6" fill="var(--panel)" />
              <circle cx="4.9" cy="9.3" r="1.6" fill="var(--panel)" />
            </svg>
          </button>
        )}
        {closeButton}
      </div>
    </div>
  );
}
