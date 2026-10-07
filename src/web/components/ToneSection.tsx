// One tone's group in Settings › Sounds (#711): its name and preview, its
// volume, and which sound it plays — a built-in figure or one of the custom
// sounds.
//
// Lifted out of SoundMenu.tsx, where it was the body of the loop over the two
// tones, and drawn by SoundsSection.tsx since Settings. The section hands each
// group its tone, what the tone is set to and the callbacks that change it; the
// group owns the two lines of copy that say which tone it is. Its volume is
// VolumeRow.tsx, which the quick sound popover and Claude FM draw too.
import { FIGURE_SETS, type Chime, type ToneSettings } from "../sound";
import { type CustomAssetSummary, type CustomSelections } from "../notification-audio";
import { customIdOf, customOptionValue } from "../tone-option";
import VolumeRow from "./VolumeRow";

/** What each tone is called where a user is choosing between the two. Not
 *  "done" and "needs-input" — those are event names. */
export const TONE_LABEL: Record<Chime, string> = {
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

/** What the menu passes every tone row unchanged, and so takes itself. */
export interface SharedToneProps {
  onLevel: (chime: Chime, level: number) => void;
  onFigure: (chime: Chime, id: string) => void;
  /** Play this tone now, at what it is currently set to. */
  onPreview: (chime: Chime) => void;
  customSelections: CustomSelections;
  onBuiltInSelected: (chime: Chime) => void;
  onCustomSelected: (chime: Chime, id: string) => void;
}

interface ToneSectionProps extends SharedToneProps {
  chime: Chime;
  /** What this tone is set to. */
  tone: ToneSettings;
  /** Only what the preview says changes with it: nothing here is disabled
   *  while Sounds is off. */
  soundOn: boolean;
  customAssets: CustomAssetSummary[];
}

export default function ToneSection({
  chime, tone, soundOn, customAssets, customSelections,
  onLevel, onFigure, onPreview, onBuiltInSelected, onCustomSelected,
}: ToneSectionProps) {
  const levelId = `sm-level-${chime}`;
  const figureId = `sm-figure-${chime}`;
  const customId = customSelections[chime];
  return (
    <section className="sm-tone" aria-labelledby={`sm-name-${chime}`}>
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

      <VolumeRow id={levelId} value={tone.level} onLevel={level => onLevel(chime, level)} />

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
          value={customId ? customOptionValue(customId) : tone.figure}
          onChange={e => {
            const value = e.target.value;
            const chosen = customIdOf(value);
            if (chosen !== null) onCustomSelected(chime, chosen);
            else { onBuiltInSelected(chime); onFigure(chime, value); }
          }}
        >
          {FIGURE_SETS[chime].map(f => (
            <option key={f.id} value={f.id}>{f.label}</option>
          ))}
          {customAssets.length > 0 && (
            <optgroup label="Custom">
              {customAssets.map(asset => (
                <option key={asset.id} value={customOptionValue(asset.id)}>{asset.name}</option>
              ))}
            </optgroup>
          )}
        </select>
      </div>

      <p className="sm-note">{TONE_NOTE[chime]}</p>
    </section>
  );
}
