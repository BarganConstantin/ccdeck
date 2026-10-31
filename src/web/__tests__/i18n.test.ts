// The translation layer: every catalog measured against English, the browser-
// language detection, and the lookup's fallbacks.
//
// FAILS on: a key a catalog has that English does not (a typo or a stale key),
// a {placeholder} set that differs from English's, or a registry entry that is
// malformed. Only WARNS on a key a catalog lacks, because English fills it in.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { en } from "../i18n/en";
import { AREA_FILES, AREAS } from "../i18n/catalogs";
import { detectLanguage, knownLanguage } from "../i18n/detect";
import { LANGUAGES, PLANNED_LANGUAGES, languageLabel } from "../i18n/registry";
import { fill, translate } from "../i18n/translate";
import { durationLabel, formatNumber } from "../i18n/format";
import { windowLabel } from "../components/QuotaSections";

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
const enKeys = Object.keys(en);

describe("registry", () => {
  it("starts with English, with unique, well-formed entries", () => {
    expect(LANGUAGES[0].code).toBe("en");
    expect(new Set(LANGUAGES.map(l => l.code.toLowerCase())).size).toBe(LANGUAGES.length);
    for (const l of LANGUAGES) {
      expect(l.name.trim(), l.code).not.toBe("");
      expect(["ltr", "rtl"], l.code).toContain(l.dir);
      expect(l.catalog, l.code).toBeTypeOf("object");
    }
  });

  it("marks drafts as beta and English as final", () => {
    expect(languageLabel({ name: "Deutsch", beta: true })).toBe("Deutsch (beta)");
    expect(languageLabel(LANGUAGES[0])).toBe("English");
  });

  it("keeps planned languages out of the shipped list, with a direction each", () => {
    const shipped = new Set(LANGUAGES.map(l => l.code));
    for (const p of PLANNED_LANGUAGES) {
      expect(shipped.has(p.code), p.code).toBe(false);
      expect(p.dir).toBe("ltr");
    }
  });
});

describe("area files", () => {
  it("has an en.ts in every area, and a stub file per shipped language", () => {
    for (const area of AREAS) {
      const codes = AREA_FILES.filter(f => f.area === area).map(f => f.code);
      expect(codes, area).toContain("en");
      for (const l of LANGUAGES) expect(codes, `${area} needs ${l.code}.ts`).toContain(l.code);
    }
  });

  it("keeps every key inside its own area's namespace", () => {
    const outside = AREA_FILES.flatMap(f => Object.keys(f.catalog).filter(k => !k.startsWith(`${f.area}.`)).map(k => `${f.path}: ${k}`));
    expect(outside).toEqual([]);
  });

  it("defines no key in two areas", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const f of AREA_FILES.filter(f => f.code === "en")) {
      for (const k of Object.keys(f.catalog)) {
        if (seen.has(k)) dupes.push(`${k} (${seen.get(k)} and ${f.area})`);
        seen.set(k, f.area);
      }
    }
    expect(dupes).toEqual([]);
  });

  it("has a catalog file only for a registered language", () => {
    const known = new Set(LANGUAGES.map(l => l.code));
    expect(AREA_FILES.filter(f => !known.has(f.code)).map(f => f.path)).toEqual([]);
  });

  it("asks only for keys English has", () => {
    // Every t("literal") in the app. A key built at run time (t(`a.${b}`)) is not seen here.
    const root = join(__dirname, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "__tests__" || name === "i18n" || name === "node_modules") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(root);
    const missing: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\bt\(\s*"([a-z][\w.]*)"/g)) if (!(m[1] in en) && !(`${m[1]}.other` in en)) missing.push(`${file.slice(root.length + 1)}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });
});

describe.each(LANGUAGES.filter(l => l.code !== "en"))("catalog $code", ({ code, catalog }) => {
  const keys = Object.keys(catalog);

  it("has no key English does not have", () => {
    expect(keys.filter(k => !(k in en))).toEqual([]);
  });

  it("uses the same {placeholders} as English", () => {
    const bad = keys.filter(k => k in en).filter(k =>
      placeholders(catalog[k]).join() !== placeholders((en as Record<string, string>)[k]).join());
    expect(bad).toEqual([]);
  });

  it("has no empty values", () => {
    expect(keys.filter(k => catalog[k].trim() === "")).toEqual([]);
  });

  it("reports what is missing (a warning, English fills it in)", () => {
    const missing = enKeys.filter(k => !(k in catalog));
    const byArea = new Map<string, number>();
    for (const k of missing) byArea.set(k.split(".")[0], (byArea.get(k.split(".")[0]) ?? 0) + 1);
    if (missing.length) console.warn(`[i18n] ${code}: ${missing.length} of ${enKeys.length} keys missing, falling back to English (${[...byArea].map(([a, n]) => `${a} ${n}`).join(", ")}):\n  ${missing.join("\n  ")}`);
    expect(missing.length).toBeLessThanOrEqual(enKeys.length);
  });
});

describe("detectLanguage", () => {
  it("maps Traditional Chinese tags to zh-TW", () => {
    for (const tag of ["zh-TW", "zh-tw", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-TW", "zh_TW"]) {
      expect(detectLanguage([tag]), tag).toBe("zh-TW");
    }
  });

  it("maps Simplified Chinese tags and a bare zh to zh-CN", () => {
    for (const tag of ["zh-CN", "zh-SG", "zh-Hans", "zh-Hans-CN", "zh"]) {
      expect(detectLanguage([tag]), tag).toBe("zh-CN");
    }
  });

  it("falls to the base language when it is supported", () => {
    expect(detectLanguage(["de-AT"])).toBe("de");
    expect(detectLanguage(["ja-JP"])).toBe("ja");
    expect(detectLanguage(["en-GB"])).toBe("en");
  });

  it("takes the first preference the registry can serve, else English", () => {
    expect(detectLanguage(["fr-CH", "de"])).toBe("de");
    expect(detectLanguage(["xx", "yy-ZZ"])).toBe("en");
    expect(detectLanguage([])).toBe("en");
    expect(detectLanguage(undefined)).toBe("en");
    expect(detectLanguage(["", "  "])).toBe("en");
  });

  it("does not hand a Chinese reader a different language when no Chinese is shipped", () => {
    expect(detectLanguage(["zh-TW", "ja"], [{ code: "en" }, { code: "ja" }])).toBe("ja");
  });

  it("would find every planned language once it is registered", () => {
    const registry = [{ code: "en" }, ...PLANNED_LANGUAGES];
    const regional: Record<string, string> = { ko: "ko-KR", fr: "fr-FR", es: "es-MX", "pt-BR": "pt-PT", it: "it-IT", pl: "pl-PL", vi: "vi-VN", ro: "ro-RO", id: "id-ID", th: "th-TH", cs: "cs-CZ" };
    for (const p of PLANNED_LANGUAGES) {
      expect(detectLanguage([p.code], registry), p.code).toBe(p.code);
      expect(detectLanguage([regional[p.code]], registry), regional[p.code]).toBe(p.code);
    }
  });

  it("knows a stored code only while the registry serves it", () => {
    expect(knownLanguage("zh-tw")).toBe("zh-TW");
    expect(knownLanguage("klingon")).toBeNull();
    expect(knownLanguage(null)).toBeNull();
  });
});

describe("translate", () => {
  const de = LANGUAGES.find(l => l.code === "de")!.catalog;

  it("uses the chosen language, then English, then the key", () => {
    expect(translate("de", de, "usage.title")).toBe(de["usage.title"]);
    expect(translate("de", { }, "usage.title")).toBe(en["usage.title"]);
    expect(translate("de", undefined, "usage.title")).toBe(en["usage.title"]);
    expect(translate("de", { }, "no.such.key" as never)).toBe("no.such.key");
  });

  it("falls back to English for a single missing key", () => {
    const partial = { "usage.title": "Nutzung" };
    expect(translate("de", partial, "usage.title")).toBe("Nutzung");
    expect(translate("de", partial, "usage.close")).toBe(en["usage.close"]);
  });

  it("fills {placeholders} and leaves unknown ones", () => {
    expect(fill("{n}% over pace", { n: 12 })).toBe("12% over pace");
    expect(fill("a {x} b {y}", { x: "1" })).toBe("a 1 b {y}");
    expect(translate("en", en, "usage.quota.pace.over", { n: 5 })).toBe("5% over pace");
  });

  it("picks plural forms by count, then .other, then the plain key", () => {
    const cat = { "k.one": "{count} file", "k.other": "{count} files", "j.other": "{count} items", j: "items" };
    expect(translate("en", cat, "k" as never, { count: 1 })).toBe("1 file");
    expect(translate("en", cat, "k" as never, { count: 3 })).toBe("3 files");
    expect(translate("en", cat, "j" as never, { count: 1 })).toBe("1 items");
    expect(translate("en", { j: "items" }, "j" as never, { count: 2 })).toBe("items");
  });
});

describe("numbers, durations and window names in the language on show", () => {
  const tFor = (code: string) => {
    const catalog = LANGUAGES.find(l => l.code === code)!.catalog;
    return (key: never, vars?: Record<string, string | number>) => translate(code, catalog, key, vars);
  };

  it("writes a decimal with the language's own separator", () => {
    expect(formatNumber(2.9, 1, "en")).toBe("2.9");
    expect(formatNumber(2.9, 1, "de")).toBe("2,9");
    expect(formatNumber(3, 1, "de")).toBe("3");
  });

  it("words a duration per language from the same two largest units", () => {
    const sec = (d: number, h: number, m: number) => d * 86400 + h * 3600 + m * 60;
    expect(durationLabel(tFor("en"), sec(2, 4, 9))).toBe("2d 4h");
    expect(durationLabel(tFor("en"), sec(0, 1, 5))).toBe("1h 5m");
    expect(durationLabel(tFor("en"), 30)).toBe("0m");
    expect(durationLabel(tFor("de"), sec(2, 4, 0))).toBe("2 T 4 Std.");
    expect(durationLabel(tFor("ja"), sec(0, 1, 5))).toBe("1時間5分");
    expect(durationLabel(tFor("zh-TW"), sec(0, 0, 12))).toBe("12 分鐘");
  });

  it("names the server's windows, and passes an unknown label through", () => {
    const t = tFor("de");
    expect(windowLabel(t, "5-hour window")).toBe("5-Stunden-Fenster");
    expect(windowLabel(t, "30-day window")).toBe("30-Tage-Fenster");
    expect(windowLabel(t, "Rate limit")).toBe("Ratenlimit");
    expect(windowLabel(t, "Spark · 7-day window")).toBe("Spark · 7-Tage-Fenster");
    expect(windowLabel(t, "Something new")).toBe("Something new");
  });
});
