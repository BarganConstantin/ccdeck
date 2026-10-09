import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const own = (value, key) => Object.hasOwn(value, key);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const fields = new Set(["$schema", "schemaVersion", "id", "name", "colorScheme", "order", "extends", "tokens", "selection"]);
const fail = message => { throw new Error(`Theme: ${message}`); };

function cssValue(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[;{}<>\\\r\n]/.test(value) || /url\s*\(|expression\s*\(|\/\*/i.test(value)) fail(`${label} must be a CSS value, not a rule or URL`);
  let depth = 0;
  for (const char of value) {
    if (char === "(") depth++;
    if (char === ")" && --depth < 0) fail(`${label} has unbalanced parentheses`);
  }
  if (depth) fail(`${label} has unbalanced parentheses`);
  if (!/^(?:#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8}|(?:rgba?|hsla?|var|color-mix|linear-gradient|radial-gradient)\(.+\)|\d+(?:\.\d+)?%|0\s[\d\s.,pxrgba()]+)$/i.test(value)) fail(`${label} has an unsupported CSS value`);
}

/** Validate and resolve inheritance before emitting any files. No browser or
 *  Vite dependency: the same format can later back a custom-theme importer. */
export function compileThemes(definitions, allowedTokens) {
  const allowed = new Set(allowedTokens);
  const byId = new Map();
  for (const theme of definitions) {
    if (!object(theme)) fail("definition must be an object");
    for (const key of Object.keys(theme)) if (!fields.has(key)) fail(`${theme.id ?? "definition"}: unknown field ${key}`);
    if (theme.schemaVersion !== 1) fail(`${theme.id}: unsupported schemaVersion`);
    if (typeof theme.id !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(theme.id) || theme.id.length > 64) fail("invalid id");
    if (byId.has(theme.id)) fail(`duplicate id ${theme.id}`);
    if (typeof theme.name !== "string" || !theme.name.trim() || theme.name.length > 64) fail(`${theme.id}: invalid name`);
    if (!["dark", "light"].includes(theme.colorScheme)) fail(`${theme.id}: colorScheme must be dark or light`);
    if (!Number.isInteger(theme.order) || theme.order < 0 || theme.order > 10000) fail(`${theme.id}: invalid order`);
    if (theme.extends !== undefined && typeof theme.extends !== "string") fail(`${theme.id}: invalid extends`);
    if (!object(theme.tokens)) fail(`${theme.id}: tokens must be an object`);
    for (const [key, value] of Object.entries(theme.tokens)) {
      if (!allowed.has(key)) fail(`${theme.id}: unknown token ${key}`);
      cssValue(value, `${theme.id}.${key}`);
    }
    if (theme.selection !== undefined) {
      if (!object(theme.selection) || Object.keys(theme.selection).sort().join(",") !== "background,foreground") fail(`${theme.id}: selection needs background and foreground`);
      for (const [key, value] of Object.entries(theme.selection)) cssValue(value, `${theme.id}.selection.${key}`);
    }
    byId.set(theme.id, theme);
  }
  for (const id of ["dark", "light"]) if (!byId.has(id)) fail(`missing required ${id} theme`);
  if (byId.get("dark").extends !== undefined || byId.get("dark").colorScheme !== "dark" || byId.get("light").colorScheme !== "light") fail("dark and light defaults must preserve their color schemes; dark must be a complete base");
  const resolved = new Map();
  const visiting = new Set();
  function resolve(id) {
    if (resolved.has(id)) return resolved.get(id);
    if (!byId.has(id)) fail(`unknown parent ${id}`);
    if (visiting.has(id)) fail(`inheritance cycle at ${id}`);
    visiting.add(id);
    const definition = byId.get(id);
    const parent = definition.extends === undefined ? null : resolve(definition.extends);
    const theme = { ...definition, tokens: { ...parent?.tokens, ...definition.tokens }, selection: definition.selection ?? parent?.selection };
    for (const key of allowed) if (!own(theme.tokens, key)) fail(`${id}: missing token ${key}`);
    // References must resolve within this palette, and cannot form a cycle.
    const active = new Set();
    const checked = new Set();
    function reference(key) {
      if (!own(theme.tokens, key)) fail(`${id}: unknown token reference ${key}`);
      if (active.has(key)) fail(`${id}: token reference cycle at ${key}`);
      if (checked.has(key)) return;
      active.add(key);
      for (const match of theme.tokens[key].matchAll(/var\(\s*--([\w-]+)/g)) reference(match[1]);
      active.delete(key); checked.add(key);
    }
    for (const key of allowed) reference(key);
    for (const value of Object.values(theme.selection ?? {})) for (const match of value.matchAll(/var\(\s*--([\w-]+)/g)) reference(match[1]);
    visiting.delete(id); resolved.set(id, theme);
    return theme;
  }
  const themes = definitions.map(t => resolve(t.id)).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const css = [resolved.get("dark"), ...themes.filter(t => t.id !== "dark")].map(theme => {
    const selector = theme.id === "dark" ? ':root,\n:root[data-theme="dark"]' : `:root[data-theme="${theme.id}"]`;
    const declarations = Object.entries(theme.tokens).map(([key, value]) => `  --${key}: ${value};`).join("\n");
    return `${selector} {\n${theme.id === "dark" ? "  /* Generated from themes/*.json. Run npm run themes:generate; do not edit. */\n" : ""}${declarations}\n  color-scheme: ${theme.colorScheme};\n}\n`;
  }).join("\n") + themes.map(theme => {
    const pairs = { canvas: "bg", surface: "panel", rule: "line", mark: "muted-dim", accent: "accent" };
    return `\n.appearance-preview[data-swatch="${theme.id}"] {\n${Object.entries(pairs).map(([key, token]) => `  --tp-${key}: ${theme.tokens[token]};`).join("\n")}\n}\n` + (theme.selection ? `:root[data-theme="${theme.id}"] ::selection {\n  background: ${theme.selection.background};\n  color: ${theme.selection.foreground};\n}\n` : "");
  }).join("");
  const metadata = Object.fromEntries(themes.map(({ id, name, colorScheme }) => [id, { name, colorScheme }]));
  const catalog = `// Generated from themes/*.json. Run npm run themes:generate; do not edit.\nexport const THEME_DEFINITIONS = ${JSON.stringify(metadata, null, 2)} as const;\nexport type Theme = keyof typeof THEME_DEFINITIONS;\n`;
  return { themes, css, catalog, ids: themes.map(t => t.id) };
}

export function generateThemes(root, { check = false } = {}) {
  const dir = join(root, "src/web/themes");
  const schema = JSON.parse(readFileSync(join(dir, "schema.json"), "utf8"));
  const definitions = readdirSync(dir).filter(name => name.endsWith(".json") && name !== "schema.json").sort().map(name => {
    const theme = JSON.parse(readFileSync(join(dir, name), "utf8"));
    if (name !== `${theme.id}.json`) fail(`${name}: filename must match theme id`);
    return theme;
  });
  const compiled = compileThemes(definitions, schema.properties.tokens.propertyNames.enum);
  const htmlPath = join(root, "src/web/index.html");
  const html = readFileSync(htmlPath, "utf8");
  const marker = /\/\* theme-ids:start \*\/[\s\S]*?\/\* theme-ids:end \*\//g;
  if ([...html.matchAll(marker)].length !== 1) fail("index.html needs exactly one theme-ids marker");
  const outputs = new Map([
    [join(root, "src/web/styles/themes.css"), compiled.css],
    [join(dir, "catalog.generated.ts"), compiled.catalog],
    [htmlPath, html.replace(marker, `/* theme-ids:start */ ${JSON.stringify(compiled.ids)} /* theme-ids:end */`)],
  ]);
  const changed = [...outputs].filter(([path, text]) => {
    try { return readFileSync(path, "utf8") !== text; } catch (error) { if (error.code === "ENOENT") return true; throw error; }
  });
  if (check && changed.length) fail("generated themes are out of date; run npm run themes:generate");
  if (!check) for (const [path, text] of changed) writeFileSync(path, text);
  return compiled;
}
