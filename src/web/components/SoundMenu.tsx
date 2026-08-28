// The sound menu (#711): the deck's first popover, and the argument for why it
// is one.
//
// The first build of #711 put a single volume slider in the shortcuts sheet and
// argued — correctly, for what it was — that one rarely-touched number does not
// earn a floating menu on the most-pressed control in the topbar. The feature
// then grew. What this holds is a switch, two volumes, two sound choices and
// two preview buttons: seven controls about one subject, which is a small panel
// rather than a setting, and a small panel belongs behind the control it
// configures. The reasoning did not change; the thing being reasoned about did.
//
// ── what this is, in ARIA terms ─────────────────────────────────────────────
//
// A non-modal dialog on a disclosure button. The button says aria-expanded and
// aria-haspopup="dialog"; this says role="dialog" with a name, and deliberately
// NOT aria-modal="true" — nothing is inert behind it, there is no scrim, and
// claiming otherwise is the lie #518 spent a whole issue removing from the
// modals that did have one.
//
// The button lost aria-pressed and that is a change worth stating rather than
// slipping through. It used to be the one genuine setting-toggle in the topbar;
// its click now OPENS something, so "pressed" would describe an action the
// button no longer performs. The on/off state moved inside, onto a real switch
// that says aria-pressed itself — and M still flips it from anywhere, which is
// the half that must not disappear into a menu.
//
// ── dismissal ───────────────────────────────────────────────────────────────
//
// Escape, the Tab trap and the focus hand-back are useModalDismiss's, unchanged
// and unforked. That hook is named for the six modals it was written for, but
// what it actually owns is "an overlay that answers Escape, holds Tab, and
// gives focus back", which is exactly this — and writing a second spelling of
// it here is the thing its own header warns against.
//
// Click-outside is the one rule a popover needs that a modal does not, because
// a modal has a backdrop to catch the click and this has nothing. It is
// `pointerdown` rather than `click`: a press that starts outside should dismiss
// even if the pointer travels back in before release, and `click` on a control
// elsewhere in the topbar would otherwise fire against a menu that is still up.
// The opener is excluded from it — its own onClick already toggles, and letting
// both run would close the menu and immediately reopen it.
import { useEffect, useRef, type RefObject } from "react";
import {
  CHIME_ORDER, FIGURE_SETS, LEVEL_MAX, LEVEL_MIN, LEVEL_STEP,
  type Chime, type TonePrefs,
} from "../sound";
import { useModalDismiss } from "./use-modal-dismiss";

/** What each tone is called where a user is choosing between the two. Not
 *  "done" and "needs-input" — those are event names. */
const TONE_LABEL: Record<Chime, string> = {
  done: "Turn finished",
  "needs-input": "Claude is asking",
};

/** The one line that says what fires the tone, because "Turn finished" alone
 *  does not tell a Codex user which of their turns are covered. */
const TONE_NOTE: Record<Chime, string> = {
  done: "Every finished turn, on both CLIs.",
  "needs-input": "Claude Code only — Codex has no such event.",
};

interface Props {
  onClose: () => void;
  /** The switch this menu carries, and the same one M flips. */
  soundOn: boolean;
  onToggleSound: () => void;
  prefs: TonePrefs;
  onLevel: (chime: Chime, level: number) => void;
  onFigure: (chime: Chime, id: string) => void;
  /** Play this tone now, at what it is currently set to. */
  onPreview: (chime: Chime) => void;
  /** The button that opened this, so the outside-press rule can leave it alone
   *  — its own onClick is what closes the menu on a second press. */
  openerRef: RefObject<HTMLElement | null>;
}

export default function SoundMenu({
  onClose, soundOn, onToggleSound, prefs, onLevel, onFigure, onPreview, openerRef,
}: Props) {
  const dialogRef = useModalDismiss<HTMLDivElement>(onClose);

  // The one dismissal rule a popover owns that the hook does not. On window and
  // in the capture phase, so a press on a control that stops propagation still
  // closes the menu first.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (dialogRef.current?.contains(target)) return;
      if (openerRef.current?.contains(target)) return;
      closeRef.current();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [dialogRef, openerRef]);

  return (
    <div
      ref={dialogRef}
      id="sound-menu"
      className="sound-menu"
      role="dialog"
      aria-label="Sound settings"
    >
      {/* The switch, first, because it is the one control here that can make
          every other one moot. A real aria-pressed toggle rather than a
          checkbox: it is the same setting the topbar button used to carry and
          the same one M flips, and "pressed" is what a setting that stays on
          means. It never disables anything — least of all itself (#620). */}
      <button
        type="button"
        className="btn sm-switch"
        onClick={onToggleSound}
        aria-pressed={soundOn}
      >
        <span className="sm-switch-label">Sound</span>
        <span className="sm-switch-state">{soundOn ? "on" : "off"}</span>
      </button>

      {CHIME_ORDER.map(chime => {
        const tone = prefs[chime];
        const levelId = `sm-level-${chime}`;
        const figureId = `sm-figure-${chime}`;
        return (
          <section className="sm-tone" key={chime} aria-labelledby={`sm-name-${chime}`}>
            <div className="sm-tone-head">
              <h3 className="sm-tone-name" id={`sm-name-${chime}`}>{TONE_LABEL[chime]}</h3>
              {/* The point of the menu, not decoration: choosing a sound you
                  cannot hear and setting a level in silence are both guessing.
                  It plays THIS tone at what it is currently set to, and it
                  plays whether the switch is on or off — the press is the
                  request, and the person most likely to be here is somebody
                  who turned the sound off because it was too loud. */}
              <button
                type="button"
                className="btn sm-hear"
                onClick={() => onPreview(chime)}
                aria-label={`Hear the ${TONE_LABEL[chime].toLowerCase()} tone`}
              >
                <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
                  <path d="M3 1.6v8.8l7-4.4z" />
                </svg>
                Hear it
              </button>
            </div>

            <div className="sm-row">
              <label htmlFor={levelId}>Volume</label>
              {/* Native, and left native on purpose. A custom track and thumb
                  would have to re-earn the arrow keys, Home and End, the drag,
                  the announced percentage and the focus ring — all of which the
                  browser gives for nothing, and #620 is what this deck's record
                  on dropped focus is worth. */}
              <input
                id={levelId}
                type="range"
                min={LEVEL_MIN}
                max={LEVEL_MAX}
                step={LEVEL_STEP}
                value={tone.level}
                onChange={e => onLevel(chime, Number(e.target.value))}
              />
              <span className="sm-read">{tone.level}%</span>
            </div>

            <div className="sm-row">
              <label htmlFor={figureId}>Sound</label>
              {/* A native select for the same reason the range is native: it
                  arrives with the keyboard, the platform's own popup and a
                  reader that already knows how to announce a list of options.
                  Three of them, so the alternative — a radio group — would cost
                  three tab stops per tone and six rows of markup to be worse. */}
              <select
                id={figureId}
                className="sm-select"
                value={tone.figure}
                onChange={e => onFigure(chime, e.target.value)}
              >
                {FIGURE_SETS[chime].map(f => (
                  <option key={f.id} value={f.id}>{f.label}</option>
                ))}
              </select>
            </div>

            <p className="sm-note">{TONE_NOTE[chime]}</p>
          </section>
        );
      })}

      <p className="sm-foot">M turns the sound on and off from anywhere.</p>
    </div>
  );
}
