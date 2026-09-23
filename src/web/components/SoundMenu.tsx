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
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import {
  CHIME_ORDER, FIGURE_SETS, LEVEL_MAX, LEVEL_MIN, LEVEL_STEP,
  type Chime, type TonePrefs,
} from "../sound";
import { useModalDismiss } from "./use-modal-dismiss";
import { browserChannel, notifyNote, NOTIFY_VETO_NOTE, type NotifyPermission } from "../notify-reach";
import { inDesktopApp } from "../in-app";
import {
  sameCustomSelection,
  type CustomAssetSummary,
  type CustomSelections,
} from "../notification-audio";

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
  customAssets: CustomAssetSummary[];
  customSelections: CustomSelections;
  onBuiltInSelected: (chime: Chime) => void;
  onCustomSelected: (chime: Chime, id: string) => void;
  onImportCustom: (file: File) => Promise<void>;
  onCreateVoice: (input: { name: string; text: string; voiceURI: string; rate: number; pitch: number }) => Promise<void>;
  onRenameCustom: (id: string, name: string) => Promise<void>;
  onPreviewCustom: (id: string) => void;
  onDeleteCustom: (id: string) => Promise<void>;
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
  customAssets, customSelections, onBuiltInSelected, onCustomSelected, onImportCustom,
  onCreateVoice, onRenameCustom, onPreviewCustom, onDeleteCustom,
  notifyOn, onToggleNotify, notifyVetoed, notifyPermission, onAskNotify,
}: Props) {
  /* The channel, and whether it is worth drawing at all. A veto silences both
     notifiers, so there is no channel to report on; the switch's own note says
     what happened instead. */
  const channel = browserChannel(notifyPermission);
  // Not inside the desktop app: its notifications are its own, and the
  // browser's permission that this section reports is never asked there.
  const inApp = inDesktopApp();
  const showChannel = notifyOn && !notifyVetoed && !inApp;
  const [customError, setCustomError] = useState("");
  const [voiceName, setVoiceName] = useState("Custom voice");
  const [voiceText, setVoiceText] = useState("Your turn");
  const [voiceURI, setVoiceURI] = useState("");
  // Kept as the text in the field, not a number. A controlled number input
  // bound to Number(value) turns a cleared field into 0 on the spot, so the
  // person could never empty it to type a new value — and 0 would then have
  // been saved as the slowest rate rather than read as "not set".
  const [voiceRate, setVoiceRate] = useState("1");
  const [voicePitch, setVoicePitch] = useState("1");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sharedCustomId = sameCustomSelection(customSelections);
  const sharedCustomName = customAssets.find(asset => asset.id === sharedCustomId)?.name ?? "the same custom sound";

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const refresh = () => {
      const next = window.speechSynthesis.getVoices();
      setVoices(next);
      setVoiceURI(current => current || next[0]?.voiceURI || "");
    };
    refresh();
    window.speechSynthesis.addEventListener("voiceschanged", refresh);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", refresh);
  }, []);

  const runCustom = async (work: () => Promise<void>) => {
    setCustomError("");
    try { await work(); }
    catch (error) { setCustomError(error instanceof Error ? error.message : "Custom audio could not be saved."); }
  };

  const stopRecording = () => {
    if (recordingTimerRef.current !== null) clearTimeout(recordingTimerRef.current);
    recordingTimerRef.current = null;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  };

  const startRecording = async () => {
    setCustomError("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setCustomError("Microphone recording is unavailable in this browser.");
      return;
    }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { setCustomError("Microphone access was denied or unavailable."); return; }
    if (recorderRef.current) { stream.getTracks().forEach(track => track.stop()); return; }
    try {
      const format = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]
        .find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, format ? { mimeType: format } : undefined);
      const chunks: Blob[] = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => setCustomError("Recording failed. Please try again.");
      recorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        if (recordingTimerRef.current !== null) clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
        const shouldSave = recorderRef.current === recorder;
        if (shouldSave) recorderRef.current = null;
        setRecording(false);
        if (!shouldSave || !chunks.length) return;
        const mime = recorder.mimeType.split(";")[0];
        const extension = mime === "audio/mp4" ? "m4a" : mime === "audio/ogg" ? "ogg" : "webm";
        const file = new File(chunks, `Recorded voice.${extension}`, { type: mime });
        void runCustom(() => onImportCustom(file));
      };
      recorder.start(200);
      setRecording(true);
      // Stop just before the five-second limit to allow encoder/container overhead.
      recordingTimerRef.current = setTimeout(stopRecording, 4400);
    } catch {
      recorderRef.current = null;
      stream.getTracks().forEach(track => track.stop());
      setCustomError("This browser cannot record a supported audio format.");
    }
  };

  useEffect(() => () => {
    if (recordingTimerRef.current !== null) clearTimeout(recordingTimerRef.current);
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder?.state === "recording") recorder.stop();
  }, []);

  // A popover, so the canvas letters stay live under it — V and M included,
  // which are this menu's own keys (see dialogDepth in modal-dismiss.ts).
  const dialogRef = useModalDismiss<HTMLDivElement>(onClose, { popover: true });

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
          the shared `.switch` (#886) — first borrowed from Browser Watch rather than
          respelled. */}
      <div className="sm-switches">
        <label className="sm-switch">
          <span className="sm-switch-label" id="sm-sound-label">Sounds</span>
          <button
            type="button"
            role="switch"
            aria-checked={soundOn}
            aria-labelledby="sm-sound-label"
            className="switch"
            onClick={onToggleSound}
            title="A tone when a turn finishes, and when Claude asks for something"
          >
            <span className="switch-knob" />
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
            <span className="sm-switch-label" id="sm-notify-label">Notifications while closed</span>
            <button
              type="button"
              role="switch"
              aria-checked={notifyOn}
              aria-labelledby="sm-notify-label"
              className="switch"
              onClick={onToggleNotify}
              title="With no deck tab open, a notification wherever a sound would play"
            >
              <span className="switch-knob" />
            </button>
          </label>
          <p className="sm-note">{notifyVetoed ? NOTIFY_VETO_NOTE : notifyNote(inApp)}</p>
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
                /* The filled half, as a number the sheet can read. Chrome 152
                   has no `::slider-fill`, so a thinner track means painting one
                   — and painting one means knowing where the value is. This is
                   NOT a listener: `tone.level` already drives `value` on this
                   element and React already re-renders on every change, so the
                   property rides a render that was happening anyway. Nothing
                   new runs on drag.
                   The sheet only uses it inside `@supports`; where the custom
                   track is not taken up, the native widget and `accent-color`
                   still paint the fill and this attribute is inert. */
                style={{ "--sm-level": `${((tone.level - LEVEL_MIN) / (LEVEL_MAX - LEVEL_MIN)) * 100}%` } as CSSProperties}
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
                value={customSelections[chime] ? `custom:${customSelections[chime]}` : tone.figure}
                onChange={e => {
                  const value = e.target.value;
                  if (value.startsWith("custom:")) onCustomSelected(chime, value.slice(7));
                  else { onBuiltInSelected(chime); onFigure(chime, value); }
                }}
              >
                {FIGURE_SETS[chime].map(f => (
                  <option key={f.id} value={f.id}>{f.label}</option>
                ))}
                {customAssets.length > 0 && (
                  <optgroup label="Custom">
                    {customAssets.map(asset => (
                      <option key={asset.id} value={`custom:${asset.id}`}>{asset.name}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>

            <p className="sm-note">{TONE_NOTE[chime]}</p>
          </section>
        );
      })}
      </div>

      {sharedCustomId && (
        <p className="sm-note" role="status">
          Both tones use “{sharedCustomName}”. They may be harder to tell apart.
        </p>
      )}

      <section className="sm-custom" aria-labelledby="sm-custom-title">
        <div className="sm-custom-head">
          <h3 className="sm-tone-name" id="sm-custom-title">Custom sounds</h3>
          <span>Kept on this machine</span>
        </div>
        <label className="sm-file">
          <span>Import WAV, MP3 or OGG</span>
          <input
            type="file"
            accept="audio/wav,audio/x-wav,audio/mpeg,audio/mp3,audio/ogg,.wav,.mp3,.ogg"
            onChange={e => {
              const file = e.target.files?.[0];
              e.currentTarget.value = "";
              if (file) void runCustom(() => onImportCustom(file));
            }}
          />
        </label>

        <div className="sm-record">
          <span>Record a voice (up to 5 seconds)</span>
          {recording ? (
            <button type="button" className="btn sm-custom-action" onClick={stopRecording}>Stop &amp; save</button>
          ) : (
            <button type="button" className="btn sm-custom-action" onClick={() => void startRecording()}>Record with microphone</button>
          )}
        </div>

        <details className="sm-voice">
          <summary>Add spoken voice</summary>
          <div className="sm-voice-fields">
            <label>Name<input className="sm-select" value={voiceName} maxLength={80} onChange={e => setVoiceName(e.target.value)} /></label>
            <label>Text<input className="sm-select" value={voiceText} maxLength={180} onChange={e => setVoiceText(e.target.value)} /></label>
            <label>Voice
              <select className="sm-select" value={voiceURI} onChange={e => setVoiceURI(e.target.value)}>
                <option value="">System default</option>
                {voices.map(voice => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name}</option>)}
              </select>
            </label>
            <div className="sm-voice-pair">
              <label>Rate<input className="sm-select" type="number" min="0.5" max="2" step="0.1" value={voiceRate} onChange={e => setVoiceRate(e.target.value)} /></label>
              <label>Pitch<input className="sm-select" type="number" min="0.5" max="2" step="0.1" value={voicePitch} onChange={e => setVoicePitch(e.target.value)} /></label>
            </div>
            <button
              type="button"
              className="btn sm-custom-action"
              onClick={() => void runCustom(async () => {
                // parseFloat, so an empty field is NaN and createCustomVoice's
                // default rather than Number("")'s 0.
                await onCreateVoice({ name: voiceName, text: voiceText, voiceURI, rate: parseFloat(voiceRate), pitch: parseFloat(voicePitch) });
                setVoiceText("Your turn");
              })}
            >
              Add voice
            </button>
          </div>
        </details>

        {customAssets.length > 0 && (
          <div className="sm-custom-list">
            {customAssets.map(asset => (
              <div className="sm-custom-item" key={asset.id}>
                <input
                  className="sm-select"
                  aria-label={`Rename ${asset.name}`}
                  defaultValue={asset.name}
                  maxLength={80}
                  onBlur={e => {
                    // A name cannot be blank, so a cleared field goes back to
                    // the one it had rather than showing a name nothing saved.
                    if (!e.target.value.trim()) { e.target.value = asset.name; return; }
                    void runCustom(() => onRenameCustom(asset.id, e.target.value));
                  }}
                  onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
                />
                <span>{asset.kind === "audio" ? `${asset.duration.toFixed(1)}s` : "Voice"}</span>
                {/* Named for the sound, not only the verb: a list of eight
                    rows read aloud as "Play, Delete, Play, Delete" says
                    nothing about which one a press would act on. */}
                <button type="button" className="btn sm-custom-icon" aria-label={`Play ${asset.name}`} onClick={() => onPreviewCustom(asset.id)}>Play</button>
                <button type="button" className="btn sm-custom-icon" aria-label={`Delete ${asset.name}`} onClick={() => void runCustom(() => onDeleteCustom(asset.id))}>Delete</button>
              </div>
            ))}
          </div>
        )}
        {customError && <p className="sm-custom-error" role="alert">{customError}</p>}
      </section>

      {/* The key, drawn as a key. It was a sentence about a letter, which is
          the one shape a reader does not scan for when they are looking for a
          shortcut. Same cap the shortcuts sheet uses. */}
      <p className="sm-foot"><kbd>M</kbd>Mute or unmute sounds anywhere.</p>
    </div>
  );
}
