// A volume, as a slider with its reading: the row each tone's section in
// Settings › Sounds draws, the two the quick sound popover draws, and the one
// Settings › Music & character borrows for Claude FM.
//
// Lifted out of ToneSection.tsx. The Appearance menu had copied the row whole —
// `.sm-row`, the native range, the `--sm-level` fill arithmetic and the
// `.sm-read` percentage — so the sheet's one shape for "a level with a reading"
// was written twice, and a change to how the fill is painted would have had to
// find both. The two callers differ only in the id, what the level is and
// whether a description rides along.
import { type CSSProperties } from "react";
import { LEVEL_MAX, LEVEL_MIN, LEVEL_STEP } from "../sound";

interface Props {
  /** The range's id, which the label points at. */
  id: string;
  /** The words the label says. "Volume" wherever the row sits under the name
   *  of the thing it is the volume of; the quick sound popover's two rows have
   *  no such heading, so each says which tone it sets. */
  label?: string;
  /** The level, LEVEL_MIN to LEVEL_MAX in steps of LEVEL_STEP. */
  value: number;
  onLevel: (level: number) => void;
  /** A description a reader gets with the slider, by id — passed through to
   *  the range as the attribute of the same name. */
  "aria-describedby"?: string;
}

export default function VolumeRow({ id, label = "Volume", value, onLevel, "aria-describedby": describedBy }: Props) {
  return (
    <div className="sm-row">
      <label htmlFor={id}>{label}</label>
      {/* Native, and left native on purpose. A custom track and thumb
          would have to re-earn the arrow keys, Home and End, the drag,
          the announced percentage and the focus ring — all of which the
          browser gives for nothing, and #620 is what this deck's record
          on dropped focus is worth. */}
      <input
        id={id}
        type="range"
        min={LEVEL_MIN}
        max={LEVEL_MAX}
        step={LEVEL_STEP}
        value={value}
        aria-describedby={describedBy}
        onChange={e => onLevel(Number(e.target.value))}
        /* The filled half, as a number the sheet can read. Chrome 152
           has no `::slider-fill`, so a thinner track means painting one
           — and painting one means knowing where the value is. This is
           NOT a listener: `value` already drives the range on this
           element and React already re-renders on every change, so the
           property rides a render that was happening anyway. Nothing
           new runs on drag.
           The sheet only uses it inside `@supports`; where the custom
           track is not taken up, the native widget and `accent-color`
           still paint the fill and this attribute is inert. */
        style={{ "--sm-level": `${((value - LEVEL_MIN) / (LEVEL_MAX - LEVEL_MIN)) * 100}%` } as CSSProperties}
      />
      <span className="sm-read">{value}%</span>
    </div>
  );
}
