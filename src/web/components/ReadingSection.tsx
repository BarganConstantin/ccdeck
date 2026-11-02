import {
  DEFAULT_DENSITY,
  DENSITIES,
  TEXT_SIZES,
  type Density,
  type TextSize,
} from "../reading-preferences";
import { SettingRow, SettingsGroup } from "./SettingsParts";
import SelectShell from "./SelectShell";
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

/** Reset to defaults, which Settings draws in the pane's head beside the
 *  section's name and the line under it (SettingsModal.tsx, #2176), where it is
 *  in view without scrolling past the preview. It sat beside an intro that
 *  said what the pane's head now says. Disabled when the text size is at
 *  Default and the density at Compact, the density V4 draws by default. */
export function ReadingReset({ textSize, density, onTextSize, onDensity }: Props) {
  const t = useT();
  const changed = textSize !== "default" || density !== DEFAULT_DENSITY;
  return (
    <button
      type="button"
      className="btn"
      disabled={!changed}
      onClick={() => {
        onTextSize("default");
        onDensity(DEFAULT_DENSITY);
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
      {/* V4 draws each scale as a group of one row with a Select, in place of
          the five framed previews: the same five steps, the same stored
          value, in the kit's closed list. */}
      <SettingsGroup id="reading-size-title" title={t("settings.reading.sizeTitle")}>
        <SettingRow
          settingId="text-size"
          name={t("settings.reading.sizeTitle")}
          nameId="reading-size-label"
          note={t("settings.reading.sizeHelp")}
          noteId="reading-size-help"
          control={
            <SelectShell>
              <select
                className="sm-select"
                name="text-size"
                aria-labelledby="reading-size-label"
                aria-describedby="reading-size-help"
                value={textSize}
                onChange={event => onTextSize(TEXT_SIZES.find(size => size === event.target.value) ?? "default")}
              >
                {SIZE_CHOICES.map(([value, labelKey, note]) => (
                  <option key={value} value={value}>{t(labelKey)} {note}</option>
                ))}
              </select>
            </SelectShell>
          }
        />
      </SettingsGroup>
      <SettingsGroup id="reading-density-title" title={t("settings.reading.densityTitle")}>
        <SettingRow
          settingId="density"
          name={t("settings.reading.densityTitle")}
          nameId="reading-density-label"
          note={t("settings.reading.densityHelp")}
          noteId="reading-density-help"
          control={
            <SelectShell>
              <select
                className="sm-select"
                name="density"
                aria-labelledby="reading-density-label"
                aria-describedby="reading-density-help"
                value={density}
                onChange={event => onDensity(DENSITIES.find(step => step === event.target.value) ?? DEFAULT_DENSITY)}
              >
                {DENSITY_CHOICES.map(([value, labelKey, note]) => (
                  <option key={value} value={value}>{t(labelKey)} {note}</option>
                ))}
              </select>
            </SelectShell>
          }
        />
      </SettingsGroup>
      <SettingsGroup id="reading-preview-title" title={t("settings.reading.preview")} list={false}>
        <div className="reading-preview">
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
        </div>
      </SettingsGroup>
      <p className="settings-foot">
        {t("settings.reading.foot")}
      </p>
    </>
  );
}
