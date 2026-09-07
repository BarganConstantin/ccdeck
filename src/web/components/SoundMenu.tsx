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
  notifyPermission: "default" | "granted" | "denied" | "unsupported";
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
  /* Whether the two lines below have anything to say. The switch on and the
     machine not overruling it is exactly when "where does this reach me" is a
     live question; off, it is noise. */
  const reaches = notifyOn && !notifyVetoed;
  /* The one state with a gesture attached: reachable, and the browser has
     neither granted nor refused. Named once because two things read it — the
     tab line below, which becomes a button, and nothing else. */
  const asking = reaches && notifyPermission === "default";
  /* What the tab line says when there is nothing to press. Not "on"/"off":
     these two lines are not settings, they are whether a route can carry a
     notification at all, so they answer in a different vocabulary than the
     switch above them. */
  const tabState = notifyPermission === "granted" ? "ready"
    : notifyPermission === "denied" ? "blocked" : "unavailable";

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

      {/* The second channel, and the first time it has had an off switch.
          A notification could be turned ON with one press — the "notify me"
          button beside the blocked count — and turned off only from the
          browser's own site settings, or by quitting the deck and re-running it
          with AGENTS_DECK_NO_NOTIFY=1. Asymmetric in the worst direction: the
          person who wants quiet is the one being asked to work for it.
          It governs BOTH notifiers, which is why it is not a browser
          preference. The page raises one when the tab is behind something; the
          server raises one when no page exists at all, and a switch in
          localStorage could not reach that second one at the moment it runs.
          It stays pressable when the machine has overruled it, because the
          preference is still the user's to record for the next launch. */}
      {/* THE SWITCH AND THE TWO ROUTES IT GOVERNS, AS ONE UNIT.
          A switch on its own could not answer the question a reader actually
          has, which is not "is this on" but "will it reach me when I have
          walked away". There are two notifiers and they cover different halves:
          the page raises one while the deck is open and hidden behind
          something, and the server raises one when no page exists at all
          (src/web/notify.ts and src/server/block-notify.mjs both open on this).
          They are exclusive by construction — the server checks sseClients.size
          — so "both are on" is not a duplicate, it is full cover.

          That used to be said in a tooltip, a code comment and one line of grey
          prose that reported a deficiency ("Needs this browser's permission")
          without naming which half it applied to. It is a map now: two lines,
          each a route and whether it can carry. Nothing is prose, so nothing
          has to be read — the column of states is scannable at a glance, which
          is the only reading this menu gets while a build runs.

          Geometry does the grouping: no gap inside the unit, so the shared
          edges make one object out of three lines, and the menu's own 12px is
          then the only gap in the group and therefore means something. The two
          route lines are 11px against the switch's 12px/600 and dim rather than
          --text, so subordinate is legible without a legend. */}
      <div className="sm-notify">
        <button
          type="button"
          className={`btn sm-switch${reaches ? " sm-switch-joined" : ""}`}
          onClick={onToggleNotify}
          aria-pressed={notifyOn}
          title={notifyVetoed
            ? "Recorded for next time: this deck was started with AGENTS_DECK_NO_NOTIFY=1, which overrules the switch"
            : "A system notification when a session blocks on you"}
        >
          <span className="sm-switch-label">Notifications</span>
          <span className="sm-switch-state">
            {notifyVetoed ? "off — set at launch" : notifyOn ? "on" : "off"}
          </span>
        </button>

        {/* Route one: this page. It needs a permission and the permission needs
            a gesture, so while the browser has not answered, this line IS the
            gesture — the other route to it, the button beside the blocked
            count, exists only while a session is stuck, so on a machine whose
            sessions rarely block the feature could not be switched on at all.
            "allow" is the browser's own word: the next thing on screen is
            Chrome's prompt with an Allow button on it, so the label predicts
            the screen it opens rather than describing our side of the wiring.
            Refused, it is a word and not a button: no page may re-raise a
            refused prompt, and a control that silently does nothing is the
            failure browser-react.mjs refuses to ship for its own reactions. */}
        {reaches && (asking ? (
          <button
            type="button"
            className="btn sm-reach-ask"
            onClick={onAskNotify}
            title="Raises this browser's permission prompt. Nothing is requested until you press it."
          >
            <span className="sm-reach-where">This tab, when hidden</span>
            <span className="sm-reach-state sm-reach-act">allow</span>
          </button>
        ) : (
          <div className="sm-reach-row">
            <span className="sm-reach-where">This tab, when hidden</span>
            <span className="sm-reach-state">{tabState}</span>
          </div>
        ))}

        {/* Route two: the deck itself, with no browser in it at all. It needs
            no permission and cannot be blocked by one, which is the fact the
            old copy buried — a reader who saw "Needs this browser's permission"
            had every reason to think a refusal meant silence. */}
        {reaches && (
          <div className="sm-reach-row sm-reach-end">
            <span className="sm-reach-where">The deck, when no tab is open</span>
            <span className="sm-reach-state">ready</span>
          </div>
        )}

        {/* The one dead end worth a sentence, because the remedy is somewhere
            this deck cannot draw. "unavailable" needs none: the line above
            already says the deck still reaches you. */}
        {reaches && notifyPermission === "denied" && (
          <p className="sm-note sm-reach-note">
            Only your browser&rsquo;s site settings for this address can undo that.
          </p>
        )}
      </div>

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
