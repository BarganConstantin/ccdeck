// The deck's sound switch, as a control.
//
// Settings › Sounds holds it above everything the tones can be set to. It was
// drawn in the topbar speaker's quick popover as well, until the speaker left
// the bar (2026-10-07). One switch in the source and one door behind it —
// onToggleSound is use-sound-switch.ts's toggle, the one M reaches too.
import { useId } from "react";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";
import { SettingRow, SettingsGroup } from "./SettingsParts";

export const PLAY_SOUNDS_NOTE = "A tone when a turn finishes, and when Claude asks for something.";

interface Props {
  soundOn: boolean;
  onToggleSound: () => void;
}

export default function SoundSwitch({ soundOn, onToggleSound }: Props) {
  // Its own ids wherever it is drawn: an id that two mounts could share is a
  // name that could resolve to the wrong one.
  const labelId = useId();
  const singleKeys = useSingleKeyShortcuts();
  const noteId = useId();
  return (
    // A real switch, not a word in a box (#886), in the shared row
    // (SettingsParts.tsx, #2176): the row is a <label>, so a press on the name
    // reaches the switch once and there is one tab stop. Named for what it
    // does, "Play sounds", and not for the section: Settings heads the section
    // "Sounds" right above it, and the two would read as one word said twice.
    // Its group has no caption: it is the section's master switch, above the
    // groups it governs.
    <SettingsGroup>
      <SettingRow
        settingId="play-sounds"
        name="Play sounds"
        nameId={labelId}
        note={PLAY_SOUNDS_NOTE}
        noteId={noteId}
        control={
          <>
            {/* The key, drawn as a key, beside the switch it flips: M is the
                one-press route to silence from anywhere on the deck — while
                the single-key shortcuts are on, and only then is it shown. */}
            {singleKeys && <kbd className="settings-key" aria-hidden title="Press M anywhere to mute or unmute">M</kbd>}
            <button
              type="button"
              role="switch"
              aria-checked={soundOn}
              aria-labelledby={labelId}
              aria-describedby={noteId}
              aria-keyshortcuts={singleKeys ? "M" : undefined}
              className="switch"
              onClick={onToggleSound}
            >
              <span className="switch-knob" />
            </button>
          </>
        }
      />
    </SettingsGroup>
  );
}
