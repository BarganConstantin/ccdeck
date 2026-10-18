// Settings › About: which ccdeck this is (#2176).
//
// The last section, standing at the foot of the nav the way About does in the
// desktop settings windows this dialog follows. The version is the bundle's
// own, the page in front of the reader.
import { SettingRow, SettingsGroup } from "./SettingsParts";

export default function AboutSection() {
  return (
    <SettingsGroup id="settings-about-caption" title="ccdeck">
      <SettingRow as="div" settingId="version" name="Version" control={<span className="settings-read">{__APP_VERSION__}</span>} />
    </SettingsGroup>
  );
}
