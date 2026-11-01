import type { CSSProperties } from "react";
import {
  DENSITIES,
  TEXT_SIZES,
  type Density,
  type TextSize,
} from "../reading-preferences";
import { SettingsGroup } from "./SettingsParts";
import { useT } from "../i18n";

interface Props {
  textSize: TextSize;
  density: Density;
  onTextSize: (value: TextSize) => void;
  onDensity: (value: Density) => void;
}

/** Each choice with the body size it gives, so the scale reads as sizes. */
const SIZE_CHOICES = [
  ["smallest", "settings.reading.size.smallest", "11 px"],
  ["smaller", "settings.reading.size.smaller", "12 px"],
  ["default", "settings.reading.size.default", "13 px"],
  ["larger", "settings.reading.size.larger", "15 px"],
  ["largest", "settings.reading.size.largest", "17 px"],
] as const;
/** Each choice with the share of the designed spacing it keeps. */
const DENSITY_CHOICES = [
  ["tightest", "settings.reading.density.tightest", "30%"],
  ["tighter", "settings.reading.density.tighter", "50%"],
  ["compact", "settings.reading.density.compact", "70%"],
  ["default", "settings.reading.density.default", "100%"],
  ["comfortable", "settings.reading.density.comfortable", "140%"],
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
  const t = useT();
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
      {t("settings.reading.reset")}
    </button>
  );
}

export default function ReadingSection({
  textSize,
  density,
  onTextSize,
  onDensity,
}: Props) {
  const t = useT();
  return (
    <>
      <fieldset className="reading-group">
        <legend>{t("settings.reading.sizeTitle")}</legend>
        <p id="reading-size-help">
          {t("settings.reading.sizeHelp")}
        </p>
        <div
          className="reading-options reading-segmented"
          aria-describedby="reading-size-help"
          data-setting="text-size"
          style={
            {
              "--reading-count": TEXT_SIZES.length,
              "--reading-selected": TEXT_SIZES.indexOf(textSize),
            } as CSSProperties
          }
        >
          {SIZE_CHOICES.map(([value, labelKey, note]) => {
            const label = t(labelKey);
            return (
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
            );
          })}
        </div>
      </fieldset>
      <fieldset className="reading-group">
        <legend>{t("settings.reading.densityTitle")}</legend>
        <p id="reading-density-help">
          {t("settings.reading.densityHelp")}
        </p>
        <div
          className="reading-options reading-segmented"
          aria-describedby="reading-density-help"
          data-setting="density"
          style={
            {
              "--reading-count": DENSITIES.length,
              "--reading-selected": DENSITIES.indexOf(density),
            } as CSSProperties
          }
        >
          {DENSITY_CHOICES.map(([value, labelKey, note]) => {
            const label = t(labelKey);
            return (
            <label key={value} className="reading-choice">
              <input
                type="radio"
                name="density"
                aria-label={t("settings.reading.spacing", { label, note })}
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
            );
          })}
        </div>
      </fieldset>
      <SettingsGroup id="reading-preview-title" title={t("settings.reading.preview")}>
        <div className="reading-preview-row">
          <div>
            <strong>{t("settings.reading.sample1")}</strong>
            <span>{t("settings.reading.sample1State")}</span>
          </div>
          <span className="reading-preview-time">4m</span>
        </div>
        <div className="reading-preview-row">
          <div>
            <strong>{t("settings.reading.sample2")}</strong>
            <span>{t("settings.reading.sample2State")}</span>
          </div>
          <span className="reading-preview-time">12m</span>
        </div>
      </SettingsGroup>
      <p className="settings-foot">
        {t("settings.reading.foot")}
      </p>
    </>
  );
}
