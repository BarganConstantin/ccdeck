// The names the Settings pages print for things that come from a table: a
// theme, a character. A name a person would not translate (Rider Black, Gruvbox
// Dark, Omarchy) is printed as the table has it; the plain ones (Light, Dark,
// the two contrasts) follow the language.
import { t as tNow, type TFunction } from "./i18n";
import { THEME_DEFINITIONS, type Theme } from "./theme";

const THEME_KEYS: Partial<Record<Theme, string>> = {
  light: "settings.theme.name.light",
  dark: "settings.theme.name.dark",
  "black-contrast": "settings.theme.name.blackContrast",
  "white-contrast": "settings.theme.name.whiteContrast",
};

export function themeName(theme: Theme, t: TFunction = tNow): string {
  const key = THEME_KEYS[theme];
  return key ? t(key) : THEME_DEFINITIONS[theme].name;
}
