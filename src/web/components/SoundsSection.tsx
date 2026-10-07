// Settings › Sounds: the switch, the two tones and everything each can be set
// to, and the custom sounds either can play.
//
// The sound popover's bottom half until Settings existed (#711), and the whole
// of it since the popover left the topbar with its speaker (2026-10-07): the
// gear opens it, and V opens Settings straight at this section.
import { CHIME_ORDER, type TonePrefs } from "../sound";
import { sameCustomSelection } from "../notification-audio";
import CustomSoundsSection, { type CustomSoundsProps } from "./CustomSoundsSection";
import SoundSwitch from "./SoundSwitch";
import ToneSection, { type SharedToneProps } from "./ToneSection";

/** Said at the top of the section on a machine with no Claude Code. True to what the
 *  deck does rather than to what the section's names suggest: a Codex rollout
 *  ends its turn with a Stop like Claude Code's, so the finish tone plays for
 *  it, and Codex has no Notification, so the asking tone never does. */
export const CODEX_ONLY_SOUNDS_NOTE =
  "Claude Code isn't on this machine, so only Turn finished plays here — for Codex turns.";

export interface SoundsProps extends CustomSoundsProps, SharedToneProps {
  /** The switch this section carries, and the same one M flips. */
  soundOn: boolean;
  onToggleSound: () => void;
  prefs: TonePrefs;
  /** False on a machine whose only CLI is Codex. */
  claudeHere: boolean;
}

export default function SoundsSection({
  soundOn, onToggleSound, prefs, claudeHere, onLevel, onFigure, onPreview,
  customAssets, customSelections, onBuiltInSelected, onCustomSelected, onImportCustom,
  onCreateVoice, onRenameCustom, onPreviewCustom, onDeleteCustom,
}: SoundsProps) {
  const sharedCustomId = sameCustomSelection(customSelections);
  const sharedCustomName = customAssets.find(asset => asset.id === sharedCustomId)?.name ?? "the same custom sound";
  const sharedNote = sharedCustomId ? `Both tones use “${sharedCustomName}”. They may be harder to tell apart.` : "";

  return (
    <div className="sm-sounds">
      <SoundSwitch soundOn={soundOn} onToggleSound={onToggleSound} />
      {!claudeHere && <p className="sm-note">{CODEX_ONLY_SOUNDS_NOTE}</p>}

      {!soundOn && (
        /* One node for both preview buttons, and only while both of them carry
           the description — an aria-describedby pointing at an id that is not
           in the document is a dangling reference, which is the rule #800 put
           on the four topbar toggles. */
        <span id="sm-preview-note" className="vis-hidden">
          Plays even when Sounds is off, so you can set a tone before turning sounds back on.
        </span>
      )}

      {/* One rule before the event groups: above it, whether the deck sounds
          at all; below, what each sound is. */}
      <div className="sm-tones">
      {CHIME_ORDER.map(chime => (
        <ToneSection
          key={chime}
          chime={chime}
          tone={prefs[chime]}
          soundOn={soundOn}
          customAssets={customAssets}
          customSelections={customSelections}
          onLevel={onLevel}
          onFigure={onFigure}
          onPreview={onPreview}
          onBuiltInSelected={onBuiltInSelected}
          onCustomSelected={onCustomSelected}
        />
      ))}
      </div>

      {/* The note is seen here while both tones share a custom sound, and
          heard from the region under it, which is mounted always (#1763): a
          status paragraph mounted together with its own text is routinely
          never announced. */}
      {sharedNote && <p className="sm-note" aria-hidden>{sharedNote}</p>}
      <p className="vis-hidden" role="status">{sharedNote}</p>

      <CustomSoundsSection
        customAssets={customAssets}
        onImportCustom={onImportCustom}
        onCreateVoice={onCreateVoice}
        onRenameCustom={onRenameCustom}
        onPreviewCustom={onPreviewCustom}
        onDeleteCustom={onDeleteCustom}
      />
    </div>
  );
}
