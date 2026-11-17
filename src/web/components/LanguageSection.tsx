// Settings › General › Language: the language of the deck's interface.
//
// One row and one select, in the shape Board's "Hide finished sessions after"
// already has. Each language is named in its own language, so a reader who
// cannot read the current one can still find theirs; a language whose catalog
// is still a draft carries "(beta)". The choice is the browser's own
// (i18n/index.ts), and the whole page follows it at once.
//
// NO CAPTION AND NO NOTE (V4 top-10 #10): a group captioned "Language" over one
// row named "Language" said the word twice, and the line under it said what the
// name already does. The row is the group's only content, at the top of General.
import { LANGUAGES, languageLabel, setLanguage, useLanguage, useT } from "../i18n";
import { SettingRow, SettingsGroup } from "./SettingsParts";
import SelectShell from "./SelectShell";

export default function LanguageSection() {
  const t = useT();
  const language = useLanguage();
  return (
    <SettingsGroup>
      <SettingRow
        settingId="language"
        name={t("settings.language.name")}
        nameId="settings-language-label"
        control={
          <SelectShell>
            <select
              className="sm-select"
              value={language}
              aria-labelledby="settings-language-label"
              onChange={event => setLanguage(event.target.value)}
            >
              {LANGUAGES.map(choice => (
                // The language's own tag, so the browser picks the right font
                // for each name (a Japanese name is not drawn with a Chinese face).
                <option key={choice.code} value={choice.code} lang={choice.code} dir={choice.dir}>{languageLabel(choice)}</option>
              ))}
            </select>
          </SelectShell>
        }
      />
    </SettingsGroup>
  );
}
