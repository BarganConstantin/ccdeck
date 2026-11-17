// A banner's message is one run of sentences (V4's Figma), and each language
// joins two sentences its own way: a space in most, nothing at all in Japanese
// and Chinese, whose full stop already carries the break. The joiner is the
// catalog's, so no banner spells that rule itself.
import { t } from "./i18n";

/** The sentences given, in order, joined as the language on show joins them;
 *  an empty or missing one is left out. */
export function sentences(...parts: Array<string | null | undefined | false>): string {
  const said = parts.filter((p): p is string => typeof p === "string" && p.length > 0);
  if (said.length === 0) return "";
  return said.reduce((first, second) => t("board.stage.twoSentences", { first, second }));
}
