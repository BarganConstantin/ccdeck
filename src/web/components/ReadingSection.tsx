import type { CSSProperties } from "react";
import {
  TEXT_SIZES,
  type Density,
  type TextSize,
} from "../reading-preferences";

interface Props {
  textSize: TextSize;
  density: Density;
  onTextSize: (value: TextSize) => void;
  onDensity: (value: Density) => void;
}

export default function ReadingSection({
  textSize,
  density,
  onTextSize,
  onDensity,
}: Props) {
  const changed = textSize !== "default" || density !== "default";
  return (
    <>
      <p className="reading-intro">
        Make the deck comfortable to read. Changes apply immediately and stay
        separate from canvas zoom.
      </p>
      <fieldset className="reading-group">
        <legend>Text size</legend>
        <p id="reading-size-help">
          Adjust interface text without changing your browser zoom.
        </p>
        <div
          className="reading-options reading-size-options"
          aria-describedby="reading-size-help"
          style={
            {
              "--reading-selected": TEXT_SIZES.indexOf(textSize),
            } as CSSProperties
          }
        >
          {(
            [
              ["smallest", "Smallest", "−2 px"],
              ["smaller", "Smaller", "−1 px"],
              ["default", "Default", "Original size"],
              ["larger", "Larger", "+2 px"],
              ["largest", "Largest", "+4 px"],
            ] as const
          ).map(([value, label, note]) => (
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
              <span className="reading-size-label">
                <strong>{label}</strong>
                <small>{note}</small>
              </span>
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
          className="reading-options reading-density-options"
          aria-describedby="reading-density-help"
        >
          {(
            [
              ["compact", "Compact", "Less spacing"],
              ["default", "Default", "Original spacing"],
              ["comfortable", "Comfortable", "More spacing"],
            ] as const
          ).map(([value, label, note]) => (
            <label key={value} className="reading-choice">
              <input
                type="radio"
                name="density"
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
              <span>
                <strong>{label}</strong>
                <small>{note}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <section
        className="reading-preview"
        aria-labelledby="reading-preview-title"
      >
        <h3 id="reading-preview-title">Preview</h3>
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
      </section>
      <div className="reading-footer">
        <p>
          Preferences stay in this browser when storage is available. Default
          restores the existing ccdeck appearance.
        </p>
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
      </div>
    </>
  );
}
