// The sound popover (#711): the quick things, one press from the speaker.
//
// It used to hold every sound and notification setting the deck had — a
// switch, two volumes, two sound choices, two previews, the custom sounds and
// the notifications — and it grew past what a popover is for. Those live in
// Settings now (SettingsModal.tsx), each in its own section. What stays here is
// what is reached for most and should stay one click away, the way familiar
// apps keep their frequent toggles outside their settings: the switch, and how
// loud each of the two tones is. "All sound settings…" is the way to the rest.
//
// ── what this is, in ARIA terms ─────────────────────────────────────────────
//
// A non-modal dialog on a disclosure button. The button says aria-expanded and
// aria-haspopup="dialog"; this says role="dialog" with a name, and deliberately
// NOT aria-modal="true" — nothing is inert behind it, there is no scrim, and
// claiming otherwise is the lie #518 spent a whole issue removing from the
// modals that did have one.
//
// The button lost aria-pressed when its click started opening this, and the
// on/off state moved inside, onto a real switch — and M still flips it from
// anywhere, which is the half that must not disappear into a menu.
//
// ── dismissal ───────────────────────────────────────────────────────────────
//
// Escape, the Tab trap and the focus hand-back are useModalDismiss's, unchanged
// and unforked: what that hook owns is "an overlay that answers Escape, holds
// Tab, and gives focus back", which is exactly this.
//
// Click-outside is the one rule a popover needs that a modal does not, because
// a modal has a backdrop to catch the click and this has nothing. It is
// use-outside-press.ts's, shared with AnchoredPopover, which says why it is
// `pointerdown`, why it listens on window in the capture phase, and why the
// opener is excluded from it.
import { type RefObject } from "react";
import { CHIME_ORDER, type Chime, type TonePrefs } from "../sound";
import { useModalDismiss } from "./use-modal-dismiss";
import { useOutsidePress } from "./use-outside-press";
import SoundSwitch from "./SoundSwitch";
import { TONE_LABEL } from "./ToneSection";
import VolumeRow from "./VolumeRow";

interface Props {
  onClose: () => void;
  /** The switch this popover carries, and the same one M flips. */
  soundOn: boolean;
  onToggleSound: () => void;
  prefs: TonePrefs;
  /** A tone's level moved: the same door Settings › Sounds uses, which also
   *  plays the tone back once the slider settles. */
  onLevel: (chime: Chime, level: number) => void;
  /** Close this and open Settings at Sounds, where everything else is. */
  onAllSettings: () => void;
  /** The button that opened this, so the outside-press rule can leave it alone
   *  — its own onClick is what closes the popover on a second press. */
  openerRef: RefObject<HTMLElement | null>;
}

export default function SoundMenu({ onClose, soundOn, onToggleSound, prefs, onLevel, onAllSettings, openerRef }: Props) {
  // A popover, so the canvas letters stay live under it — V and M included,
  // which are this popover's own keys (see dialogDepth in modal-dismiss.ts).
  const dialogRef = useModalDismiss<HTMLDivElement>(onClose, { popover: true });

  // The one dismissal rule a popover owns that the hook above does not: a
  // press outside it and outside the button that opened it.
  useOutsidePress(dialogRef, () => openerRef.current, onClose);

  return (
    <div
      ref={dialogRef}
      id="sound-menu"
      className="sound-menu"
      role="dialog"
      aria-label="Sound settings"
    >
      <SoundSwitch soundOn={soundOn} onToggleSound={onToggleSound} />

      {/* Each tone's volume, named for its tone: there is no heading over
          these to say which is which, the way a tone's group in Settings has.
          Nothing here is dimmed or disabled while Sounds is off — turning the
          volume down before turning the sound back on is the road somebody
          who silenced a loud deck came for. */}
      <div className="sm-levels">
        {CHIME_ORDER.map(chime => (
          <VolumeRow
            key={chime}
            id={`sm-quick-level-${chime}`}
            label={TONE_LABEL[chime]}
            value={prefs[chime].level}
            onLevel={level => onLevel(chime, level)}
          />
        ))}
      </div>

      {/* The way to everything else, and it says so: the tones' sounds, the
          custom sounds and the spoken voice are in Settings › Sounds. The
          ellipsis is the convention for a control that opens more before
          anything changes. */}
      <button type="button" className="btn sm-all-settings" onClick={onAllSettings}>
        All sound settings…
      </button>
    </div>
  );
}
