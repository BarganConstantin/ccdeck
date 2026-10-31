# Translating ccdeck

ccdeck's interface is translated by a small layer in `src/web/i18n/`. English is
the source of truth; any text a language does not have yet shows in English, so
a translation can be partial and still ship.

## Layout: one folder per UI area

```
src/web/i18n/areas/<area>/en.ts      the English text of that area
src/web/i18n/areas/<area>/de.ts      its German, and so on: zh-TW.ts, zh-CN.ts, ja.ts
```

An area is a part of the interface (`usage`, `settings`, `accounts`, `lan`, ...)
and owns a set of components and helpers. Files are found by folder (`import.meta.glob`), so nobody edits a shared
list, and two people on two areas never touch the same file. **Every key starts
with its area's name** (`usage.quota.pace.over`), which keeps areas from
colliding; the test fails on a key outside its area or in two areas.

Each file is `const catalog: Catalog = { "area.key": "text", ... }; export default catalog;`.

Areas: `common` (words shared by all, lead only), `usage`, `settings`,
`accounts`, `insights`, `integrations`, `radar`, `lan`, `shell`, `board`,
`forge`, `radio`. A new area is a new folder with the five language files.

## Convert a component (three lines of work per string)

1. Add the key and its English to `areas/<area>/en.ts`.
2. Use it: `const t = useT();` then `{t("area.key")}` or `t("area.key", { n })`.
3. Add the same key to each language file of the area (`zh-TW`, `zh-CN`, `de`, `ja`), keeping every `{placeholder}`.

Then `npm run i18n:missing -- src/web/components/Foo.tsx --list` shows the
English text still left in a file, and `npm run i18n:missing -- --logic <path>`
does the same for the `.ts` files that build sentences. The heuristic is for
your to-do list and never fails a build.

## Add a language

1. In every `areas/<area>/` folder add `<code>.ts` (copy `de.ts`, translate the values, keep the keys).
2. Add one line to `LANGUAGES` in `src/web/i18n/registry.ts`: the code, the language's name in that language, `dir`, and `beta: true` until a native speaker has reviewed it.
3. Run `npx vitest run src/web/__tests__/i18n.test.ts`. It fails on unknown keys, changed `{placeholders}` and empty values, and lists what is still missing.

Languages already agreed but not shipped (`ko`, `fr`, `es`, `pt-BR`, `it`, `pl`,
`vi`, `ro`, `id`, `th`, `cs`) are listed with their native names under
`PLANNED_LANGUAGES` in the registry. Move the line into `LANGUAGES`; browser
detection already finds them from then on.

## Rules for a catalog

- Keys are ids (`usage.quota.pace.over`), not sentences. Never rename a key to follow an English edit.
- `{name}` is filled in at run time. Keep every placeholder, spelled the same, and move it where your grammar wants it. Numbers with decimals and durations are formatted in code (`i18n/format.ts`): pass the formatted string, never `toFixed`.
- Do not translate product names (ccdeck, Claude Code, Codex, Claude, Sonnet, Opus), model names, commands, file names or the shape of times and units.
- Plurals: add `<key>.one` and `<key>.other` (and `few`, `many`, ... if your language needs them) and call `t(key, { count })`. The form is chosen with `Intl.PluralRules`.
- Write the way the language's own software speaks (Traditional Chinese: Taiwan usage, not Hong Kong; German: informal "du"). Keep it about as short as English: the panels are narrow, and layouts are checked at 320 px.
- `dir` in the registry is `"ltr"` for every language today. `"rtl"` is reserved for Arabic, Persian and Hebrew; it sets `<html dir>` only, and the layouts do not mirror yet.
- Strings shared by many areas (Close, Cancel, durations) belong to `common` and are added by the lead, not by an area.
- A string built in a `.ts` helper (`export const X_LABEL = "..."`) should become a function that takes `t`, or a key the component passes through, rather than a literal.

## The language and the document

The language is chosen in Settings › General › Language, kept in this browser
(`agent-dag.language`), and until chosen follows the browser's language list.
`<html lang>` and `<html dir>` follow it.

## What a language is checked against

`src/web/__tests__/i18n.test.ts` runs across every area file: unknown keys,
keys outside their area, a key in two areas, placeholder mismatches and empty
values fail; keys a language lacks only warn, because English fills them in.
It also checks that every `t("literal")` in the app names a key English has.
