// The deck's sound switch, as a control.
//
// Settings › Sounds holds it above everything the tones can be set to. It was
// drawn in the topbar speaker's quick popover as well, until the speaker left
// the bar (2026-10-07). One switch in the source and one door behind it —
// onToggleSound is use-sound-switch.ts's toggle, the one M reaches too.
import { useId } from "react";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";

interface Props {
  soundOn: boolean;
  onToggleSound: () => void;
}

export default function SoundSwitch({ soundOn, onToggleSound }: Props) {
  // Its own ids wherever it is drawn: an id that two mounts could share is a
  // name that could resolve to the wrong one.
  const labelId = useId();
  const singleKeys = useSingleKeyShortcuts();
  return (
    <div className="sm-setting">
      {/* A real switch, not a word in a box (#886): the row is a <label>, so a
          press on the name reaches the switch once and there is one tab stop. */}
      <label className="sm-switch">
        <span className="sm-switch-label" id={labelId}>Sounds</span>
        <button
          type="button"
          role="switch"
          aria-checked={soundOn}
          aria-labelledby={labelId}
          className="switch"
          onClick={onToggleSound}
          title="A tone when a turn finishes, and when Claude asks for something"
        >
          <span className="switch-knob" />
        </button>
      </label>
      {/* The key, drawn as a key, under the switch it flips: M is the
          one-press route to silence from anywhere on the deck — while the
          single-key shortcuts are on, and only then is it said. */}
      {singleKeys && <p className="sm-note sm-key-note"><kbd>M</kbd>Mute or unmute sounds anywhere.</p>}
    </div>
  );
}
