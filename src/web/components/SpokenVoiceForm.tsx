// The sound menu's spoken voice (#1207): a line of text, a voice, a rate and a
// pitch, added to the custom sounds as something the browser reads aloud.
//
// Lifted out of CustomSoundsSection.tsx with the form's own state and the
// browser's voice list. The section keeps the library's ceiling and the error
// line, and passes them in under the names the form already used.
import { useEffect, useState } from "react";
import type { CustomSoundsProps } from "./CustomSoundsSection";

interface SpokenVoiceFormProps {
  /** The library is at its ceiling: the form stays shut and adds nothing. */
  full: boolean;
  /** What the controls that add carry while the library is full. */
  fullProps: { "aria-disabled"?: boolean; "aria-describedby"?: string };
  /** Clears the error line, runs the work, and says why it failed. */
  runCustom: (work: () => Promise<void>) => Promise<void>;
  onCreateVoice: CustomSoundsProps["onCreateVoice"];
}

export default function SpokenVoiceForm({ full, fullProps, runCustom, onCreateVoice }: SpokenVoiceFormProps) {
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

  // The browser's voices fill the dropdown and nothing else. The form starts on
  // "System default" and stays there until the person picks a voice (#1562):
  // it used to take the first voice listed, which is whatever the browser
  // happens to put first — a novelty voice on macOS, another language on a
  // machine with several — and not the voice the system speaks with.
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const refresh = () => {
      setVoices(window.speechSynthesis.getVoices());
    };
    refresh();
    window.speechSynthesis.addEventListener("voiceschanged", refresh);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", refresh);
  }, []);

  return (
    <details className="sm-voice">
      <summary
        {...fullProps}
        // Held shut while full, so nobody fills in a form that cannot be
        // saved. One already open can still be closed.
        onClick={e => {
          const details = e.currentTarget.parentElement as HTMLDetailsElement | null;
          if (full && details && !details.open) e.preventDefault();
        }}
      >
        <span>Spoken voice</span>
        <span>Create from text</span>
      </summary>
      <div className="sm-voice-fields">
        {/* The deck's text field, as the appearance menu's station fields
            are: `.sm-select` is a select's class, and these are not. */}
        <label>
          <span>Name</span>
          <input className="ap-manage-input" value={voiceName} maxLength={80} onChange={e => setVoiceName(e.target.value)} />
        </label>
        <label>
          <span>Text</span>
          <input className="ap-manage-input" value={voiceText} maxLength={180} onChange={e => setVoiceText(e.target.value)} />
        </label>
        <label>
          <span>Voice</span>
          <select className="sm-select" value={voiceURI} onChange={e => setVoiceURI(e.target.value)}>
            <option value="">System default</option>
            {voices.map(voice => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name}</option>)}
          </select>
        </label>
        <div className="sm-voice-pair">
          <label><span>Rate</span><input className="ap-manage-input" type="number" min="0.5" max="2" step="0.1" value={voiceRate} onChange={e => setVoiceRate(e.target.value)} /></label>
          <label><span>Pitch</span><input className="ap-manage-input" type="number" min="0.5" max="2" step="0.1" value={voicePitch} onChange={e => setVoicePitch(e.target.value)} /></label>
        </div>
        <button
          type="button"
          className="btn sm-custom-action"
          {...fullProps}
          onClick={() => {
            if (full) return;
            void runCustom(async () => {
              // parseFloat, so an empty field is NaN and createCustomVoice's
              // default rather than Number("")'s 0.
              await onCreateVoice({ name: voiceName, text: voiceText, voiceURI, rate: parseFloat(voiceRate), pitch: parseFloat(voicePitch) });
              setVoiceText("Your turn");
            });
          }}
        >
          Add spoken voice
        </button>
      </div>
    </details>
  );
}
