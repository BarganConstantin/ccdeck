import type { CSSProperties } from "react";
import {
  DENSITIES,
  TEXT_SIZES,
  type Density,
  type TextSize,
} from "../reading-preferences";
import { SettingsGroup } from "./SettingsParts";

interface Props {
  textSize: TextSize;
  density: Density;
  onTextSize: (value: TextSize) => void;
  onDensity: (value: Density) => void;
}

/** Each choice with the body size it gives, so the scale reads as sizes. */
const SIZE_CHOICES = [
  ["smallest", "Smallest", "11 px"],
  ["smaller", "Smaller", "12 px"],
  ["default", "Default", "13 px"],
  ["larger", "Larger", "15 px"],
  ["largest", "Largest", "17 px"],
] as const;
/** Each choice with the share of the designed spacing it keeps. */
const DENSITY_CHOICES = [
  ["tightest", "Tightest", "30%"],
  ["tighter", "Tighter", "50%"],
  ["compact", "Compact", "70%"],
  ["default", "Default", "100%"],
  ["comfortable", "Comfortable", "140%"],
] as const;

function SelectedMark() {
  return (
    <svg
      className="reading-selected-mark"
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <path
        d="m2.5 6 2.2 2.2 4.8-4.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Reset to defaults, which Settings draws in the pane's head beside the
 *  section's name and the line under it (SettingsModal.tsx, #2176), where it is
 *  in view without scrolling past the preview. It sat beside an intro that
 *  said what the pane's head now says. Disabled when both are at Default. */
export function ReadingReset({ textSize, density, onTextSize, onDensity }: Props) {
  const changed = textSize !== "default" || density !== "default";
  return (
    <button
      type="button"
      className="btn"
      disabled={!changed}
      onClick={() => {
        onTextSize("default");
        onDensity("default");
      }}
    >
      Reset to defaults
    </button>
  );
}

export default function ReadingSection({
  textSize,
  density,
  onTextSize,
  onDensity,
}: Props) {
  return (
    <>
      <fieldset className="reading-group">
        <legend>Text size</legend>
        <p id="reading-size-help">
          Adjust interface text without changing your browser zoom.
        </p>
        <div
          className="reading-options reading-segmented"
          aria-describedby="reading-size-help"
          style={
            {
              "--reading-count": TEXT_SIZES.length,
              "--reading-selected": TEXT_SIZES.indexOf(textSize),
            } as CSSProperties
          }
        >
          {SIZE_CHOICES.map(([value, label, note]) => (
            <label key={value} className="reading-choice" data-size={value}>
              <input
                type="radio"
                name="text-size"
                aria-label={`${label} ${note}`}
                value={value}
                checked={textSize === value}
                onChange={() => onTextSize(value)}
              />
              <span className="reading-type-sample" aria-hidden="true">
                Aa
              </span>
              <span className="reading-label">
                <strong>{label}</strong>
                <small>{note}</small>
              </span>
              <SelectedMark />
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="reading-group">
        <legend>Density</legend>
        <p id="reading-density-help">
          Choose the spacing in lists, panels and controls. Text size stays the
          same.
        </p>
        <div
          className="reading-options reading-segmented"
          aria-describedby="reading-density-help"
          style={
            {
              "--reading-count": DENSITIES.length,
              "--reading-selected": DENSITIES.indexOf(density),
            } as CSSProperties
          }
        >
          {DENSITY_CHOICES.map(([value, label, note]) => (
            <label key={value} className="reading-choice">
              <input
                type="radio"
                name="density"
                aria-label={`${label} ${note} spacing`}
                value={value}
                checked={density === value}
                onChange={() => onDensity(value)}
              />
              <span
                className="reading-density-sample"
                data-density={value}
                aria-hidden="true"
              >
                <i />
                <i />
                <i />
              </span>
              <span className="reading-label">
                <strong>{label}</strong>
                <small>{note}</small>
              </span>
              <SelectedMark />
            </label>
          ))}
        </div>
      </fieldset>
      <SettingsGroup id="reading-preview-title" title="Preview">
        <div className="reading-preview-row">
          <div>
            <strong>Frontend session</strong>
            <span>Waiting for your review</span>
          </div>
          <span className="reading-preview-time">4m</span>
        </div>
        <div className="reading-preview-row">
          <div>
            <strong>API integration</strong>
            <span>Working · 3 tool calls</span>
          </div>
          <span className="reading-preview-time">12m</span>
        </div>
      </SettingsGroup>
      <p className="settings-foot">
        Preferences stay in this browser when storage is available. Default
        restores the existing ccdeck appearance.
      </p>
    </>
  );
}
