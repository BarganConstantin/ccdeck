# ccdeck themes

Each theme is a versioned JSON file. These files own palette values, names,
display order, color scheme and optional text-selection colors.

`schema.json` provides editor hints and lists supported semantic tokens. The
compiler validates definitions and inheritance before writing any output.
Geometry, typography, model-to-color mappings and motion stay in
`styles/tokens.css`; they are shared interface rules rather than palette values.

## Add or edit a theme

Create a JSON file in this directory whose filename matches its `id`:

```json
{
  "$schema": "./schema.json",
  "schemaVersion": 1,
  "id": "my-theme",
  "name": "My Theme",
  "colorScheme": "dark",
  "order": 50,
  "extends": "vscode-black",
  "tokens": {
    "accent": "#aabbcc",
    "panel": "#202020"
  }
}
```

Use `extends` to inherit a complete palette, then override the tokens you want.
Light themes should normally extend `light`. Token names omit the CSS `--`
prefix. Hex colors, existing color expressions, shadows and lightness percentages
are supported; rule declarations and external URLs are rejected. References must
resolve to existing palette tokens without cycles.

Run `npm run themes:generate` to update the generated files. `npm run build`
also generates them automatically. During `npm run dev:web`, adding, changing or
removing a JSON definition regenerates the catalog and reloads the page so the
canvas reads the updated palette too.

The generator updates:

- `styles/themes.css`: palettes, preview colors and optional selection rules;
- `themes/catalog.generated.ts`: typed IDs, names and color schemes;
- the marked ID list in `index.html`: stored preference resolution before paint.

Commit generated output with its JSON definitions. `npm run themes:check` verifies
that output is current without rewriting it. Existing theme IDs and the storage
key stay stable so upgrades preserve preferences. Dark remains the default CSS
palette; Light and Dark remain the fallback choices when no preference is stored.

This is a build-time catalog. A Settings importer or visual theme editor can use
the versioned format later; adding those controls is a separate feature.
