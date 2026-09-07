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
import { browserChannel, NOTIFY_NOTE, NOTIFY_VETO_NOTE, type NotifyPermission } from "../notify-reach";

/** What each tone is called where a user is choosing between the two. Not
 *  "done" and "needs-input" — those are event names. */
const TONE_LABEL: Record<Chime, string> = {
  done: "Turn finished",
  "needs-input": "Claude is asking",
};

/** The one line that says what fires the tone, because "Turn finished" alone
 *  does not tell a Codex user which of their turns are covered. */
const TONE_NOTE: Record<Chime, string> = {
  done: "Plays when Claude or Codex finishes a turn.",
  // "Codex has no such event" was the true reason and the wrong sentence: why
  // the other CLI cannot do this is ours to know, and a user reading a settings
  // menu needs the boundary, not the cause.
  "needs-input": "Available in Claude Code only.",
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
  /** The deck's OTHER way of interrupting you, and the reason it is in this
   *  menu rather than a settings panel of its own: this popover is already
   *  "how loudly does this deck interrupt me", and notifications were the only
   *  channel with no off switch anywhere in the app. */
  notifyOn: boolean;
  onToggleNotify: () => void;
  /** True when the deck was launched with AGENTS_DECK_NO_NOTIFY=1. A different
   *  question from `notifyOn` being false, and the menu says a different
   *  sentence for each — "off" is the user's own press, "off — set at launch"
   *  is somebody else's decision that this press cannot undo until the next
   *  start. The switch stays operable either way: the preference is still the
   *  user's to record. */
  notifyVetoed: boolean;
  /** What the BROWSER says, which is a third question again (#801). The switch
   *  read "on" while the in-page notifier was permanently silent, because that
   *  notifier begins `if (Notification.permission !== "granted") return;` and
   *  nothing in this menu had ever mentioned a permission. A user turned a
   *  switch on, saw "on", and got silence from the tab. */
  notifyPermission: NotifyPermission;
  /** Raise the browser's permission prompt. Only offered while the permission
   *  is still askable — a refusal cannot be re-asked by any page, which is why
   *  the row says where the switch is instead. */
  onAskNotify: () => void;
  /** The button that opened this, so the outside-press rule can leave it alone
   *  — its own onClick is what closes the menu on a second press. */
  openerRef: RefObject<HTMLElement | null>;
}

export default function SoundMenu({
  onClose, soundOn, onToggleSound, prefs, onLevel, onFigure, onPreview, openerRef,
  notifyOn, onToggleNotify, notifyVetoed, notifyPermission, onAskNotify,
}: Props) {
  /* The channel, and whether it is worth drawing at all. A veto silences both
     notifiers, so there is no channel to report on; the switch's own note says
     what happened instead. */
  const channel = browserChannel(notifyPermission);
  const showChannel = notifyOn && !notifyVetoed;

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
      {/* TWO SWITCHES, AND THEN A CHANNEL — WHICH IS NOT A THIRD SWITCH.
          The defect this menu kept reproducing was one control contradicting
          itself: "Notifications  on" with a line under it saying the browser
          had never been asked. Every rewrite that treated it as a copy problem
          reproduced it, because it is a naming problem. "Notifications" is the
          feature and "Browser notifications" is one of the two channels it
          reaches you through — two named things, so "on" and "not allowed yet"
          stop arguing and start describing different objects.

          The channel is therefore a SECTION, drawn with the same heading and
          the same right-hand control that TURN FINISHED and CLAUDE IS ASKING
          below it already use. Not a new block: the menu had a shape for "a
          named group with one control beside its name", and a second spelling
          of it here would be the drift this sheet's comments spend their length
          preventing.

          Real switches, too. `on` in the right-hand column sat in the slot, the
          size and the accent this deck gives figures it REPORTS, so the two
          controls at the top of the menu read as two more status lines. A track
          and a knob say "yours to move" before a word is read. It is
          `.bw-toggle`'s shape, borrowed from Browser Watch rather than
          respelled. */}
      <div className="sm-switches">
        <label className="sm-switch">
          <span className="sm-switch-label" id="sm-sound-label">Sounds</span>
          <button
            type="button"
            role="switch"
            aria-checked={soundOn}
            aria-labelledby="sm-sound-label"
            className="sm-toggle"
            onClick={onToggleSound}
            title="A tone when a turn finishes, and when Claude asks for something"
          >
            <span className="sm-toggle-knob" />
          </button>
        </label>

        {/* The deck's OTHER way of interrupting you, and the reason it is in
            this menu rather than a settings panel of its own: this popover is
            already "how loudly does this deck interrupt me", and notifications
            were the only channel with no off switch anywhere in the app.
            It governs BOTH notifiers, which is why it is held server-side
            rather than in localStorage — the one that runs when no page exists
            could not read a browser's storage at the moment it runs. And it
            stays operable when the machine has overruled it, because the
            preference is still the user's to record for the next launch.
            The note under it is not decoration: without it, Sound and
            Notifications are two identically-shaped switches whose difference —
            sound fires on every finished turn, this fires only when something
            has stopped and needs a person — is nowhere on screen. */}
        <div className="sm-setting">
          <label className="sm-switch">
            <span className="sm-switch-label" id="sm-notify-label">Notifications</span>
            <button
              type="button"
              role="switch"
              aria-checked={notifyOn}
              aria-labelledby="sm-notify-label"
              className="sm-toggle"
              onClick={onToggleNotify}
              title="A system notification when a session blocks on you"
            >
              <span className="sm-toggle-knob" />
            </button>
          </label>
          <p className="sm-note">{notifyVetoed ? NOTIFY_VETO_NOTE : NOTIFY_NOTE}</p>
        </div>
      </div>

      {/* Hidden outright when the switch is off, because telling somebody to
          allow a channel for a feature they have just turned off is asking them
          to work for nothing. Hidden under a veto for the same reason: the
          channel cannot deliver either way, and the note above already says so.
          Turning the switch on raises the prompt itself (App.tsx), so `ask` is
          the way back from a prompt that was dismissed rather than the main
          road to it. */}
      {showChannel && (
        <section className="sm-channel" aria-labelledby="sm-channel-name">
          <div className="sm-channel-head">
            {/* Sentence case, and quieter than the two switches. ALL CAPS in
                this menu belongs to the event groups below — those are what
                structure it, and a third one here would claim the same rank for
                what is only a capability report. */}
            <h3 className="sm-channel-name" id="sm-channel-name">Browser notifications</h3>
            {channel.ask ? (
              <button type="button" className="btn sm-channel-action" onClick={onAskNotify}>
                Enable
              </button>
            ) : (
              /* A word, not a control, and it keeps the button's slot so the
                 press that grants the permission changes one label rather than
                 relaying the section under the pointer that caused it. */
              <span className="sm-channel-state" data-ok={channel.ok || undefined}>
                {channel.ok && (
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor"
                       strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M1.5 5.2 3.9 7.6 8.5 2.4" />
                  </svg>
                )}
                {channel.status}
              </span>
            )}
          </div>
          <p className="sm-note">{channel.note}</p>
        </section>
      )}

      {/* One rule before the event groups. Everything above it is "does this
          deck interrupt me, and can it"; everything below is "what does each
          interruption sound like". Two subjects, and the caps headings alone
          were not enough of a break between them. */}
      {!soundOn && (
        /* One node for both buttons, and only while both of them carry the
           description — an aria-describedby pointing at an id that is not in
           the document is a dangling reference, which is the rule #800 put on
           the four topbar toggles. */
        <span id="sm-preview-note" className="vis-hidden">
          Plays even when Sounds is off, so you can set a tone before turning sounds back on.
        </span>
      )}

      <div className="sm-tones">
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
                /* Nothing below is dimmed or disabled while Sounds is off, and
                   that is the decision rather than an oversight: the person
                   most likely to open this menu is somebody who silenced the
                   deck because it was too loud, and turning the volume down is
                   the road they came for. Disabling it closes that road, and
                   dimming without disabling is worse — a control that looks
                   dead and works.
                   What that costs is one surprise: a press that makes a noise
                   from a deck the user believes is muted reads as a bug. So the
                   press says so first, in a tooltip and — because a tooltip is
                   not on the accessibility tree — in a description a reader
                   gets too. Only while it can surprise: with the sound on, the
                   sentence is noise.
                   The two say different lengths on purpose. A tooltip appears
                   over the thing it describes and is read in the half-second
                   before a press, so it states the EXCEPTION and stops. The
                   description is read in sequence by somebody who cannot see
                   the switch above, and carries why the exception is useful. */
                title={soundOn
                  ? "Play this tone now, at what it is set to"
                  : "Plays even when Sounds is off"}
                aria-describedby={soundOn ? undefined : "sm-preview-note"}
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
              <label htmlFor={figureId}>Tone</label>
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
      </div>

      {/* The key, drawn as a key. It was a sentence about a letter, which is
          the one shape a reader does not scan for when they are looking for a
          shortcut. Same cap the shortcuts sheet uses. */}
      <p className="sm-foot"><kbd>M</kbd>Mute or unmute sounds anywhere.</p>
    </div>
  );
}
