// Which registered language a browser's preference list asks for.
//
// Walks navigator.languages in order and returns the first one the registry can
// serve, so ["fr-CH", "de"] finds de when fr is not shipped yet. Per entry:
//   1. an exact match (case-insensitive), "zh-TW" -> zh-TW;
//   2. Chinese is told apart by script and region: Hant, TW, HK, MO -> zh-TW;
//      Hans, CN, SG and a bare "zh" -> zh-CN;
//   3. the same base language, "de-AT" -> de, "pt-PT" -> pt-BR when that is
//      the Portuguese the registry holds.
// Nothing found: English.
import { DEFAULT_LANGUAGE, LANGUAGES, type Language } from "./registry";

function chineseTarget(tag: string): "zh-TW" | "zh-CN" {
  return /(^|-)(hant|tw|hk|mo)(-|$)/.test(tag) ? "zh-TW" : "zh-CN";
}

export function detectLanguage(
  preferred: readonly string[] | undefined | null,
  registry: ReadonlyArray<Pick<Language, "code">> = LANGUAGES,
): string {
  const byLower = new Map(registry.map(l => [l.code.toLowerCase(), l.code]));
  for (const raw of preferred ?? []) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().replace(/_/g, "-").toLowerCase();
    if (!tag) continue;
    const exact = byLower.get(tag);
    if (exact) return exact;
    const base = tag.split("-")[0];
    if (base === "zh") {
      const zh = byLower.get(chineseTarget(tag).toLowerCase());
      if (zh) return zh;
      continue;
    }
    const sameBase = registry.find(l => l.code.toLowerCase().split("-")[0] === base);
    if (sameBase) return sameBase.code;
  }
  return DEFAULT_LANGUAGE;
}

/** A stored code, if the registry still serves it. Codes are matched
 *  case-insensitively so a hand-edited value still works. */
export function knownLanguage(code: string | null | undefined, registry: ReadonlyArray<Pick<Language, "code">> = LANGUAGES): string | null {
  if (!code) return null;
  return registry.find(l => l.code.toLowerCase() === code.toLowerCase())?.code ?? null;
}
