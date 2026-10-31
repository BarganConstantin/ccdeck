# Translating ccdeck

ccdeck's interface is translated by a small layer in `src/web/i18n/`. English is
the source of truth; any text a language does not have yet shows in English, so
a translation can be partial and still ship.

## Add a language

1. Copy `src/web/i18n/de.ts` to `src/web/i18n/<code>.ts` and translate the values. Keep the keys.
2. Add one line to `LANGUAGES` in `src/web/i18n/registry.ts`: the code, the language's name in that language, and `beta: true` until a native speaker has reviewed it.
3. Run `npx vitest run src/web/__tests__/i18n.test.ts`. It fails on unknown keys and on changed `{placeholders}`, and lists what is still missing.

Languages already agreed but not shipped (`ko`, `fr`, `es`, `pt-BR`, `it`, `pl`,
`vi`, `ro`, `id`, `th`, `cs`) are listed with their native names under
`PLANNED_LANGUAGES` in the registry. Move the line into `LANGUAGES`; browser
detection already finds them from then on.

## Rules for a catalog

- Keys are ids (`quota.pace.over`), not sentences. Never rename a key to follow an English edit.
- `{name}` is filled in at run time. Keep every placeholder, spelled the same, and move it where your grammar wants it. `{n}%` stays a number and a percent sign.
- Do not translate product names (ccdeck, Claude Code, Codex, Claude, Sonnet, Opus), model names, commands, file names or the shape of times and units (`2d 4h`).
- Plurals: add `<key>.one` and `<key>.other` (and `few`, `many`, ... if your language needs them) and call `t(key, { count })`. The form is chosen with `Intl.PluralRules`.
- Write the way the language's own software speaks (for Traditional Chinese, Taiwan usage rather than Hong Kong). Keep it as short as English: the panels are narrow, and the layouts are checked at 320 px.
- `dir` in the registry is `"ltr"` for every language today. `"rtl"` is reserved for Arabic, Persian and Hebrew; it sets `<html dir>` only, and the layouts do not mirror yet.

## Use it in code

```tsx
import { useT } from "../i18n";

const t = useT();            // re-renders when the language changes
<span>{t("quota.resetsIn", { time: "2d 4h" })}</span>
```

Add the English text to `en.ts` first; the key is then type-checked everywhere.
The language is chosen in Settings › General › Language, kept in this browser
(`agent-dag.language`), and until chosen follows the browser's language list.
`<html lang>` and `<html dir>` follow it.

## What is translated so far

Settings (its frame, section names and the Language row) and the Usage panel
with its quota bars. Everything else is still English.
