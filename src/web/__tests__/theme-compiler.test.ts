import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileThemes, generateThemes } from "../../../scripts/theme-compiler.mjs";

const load = (name: string) => JSON.parse(readFileSync(new URL(`../themes/${name}.json`, import.meta.url), "utf8"));
const definitions = ["dark", "light", "rider-black", "vscode-black"].map(load);
const allowed = load("schema").properties.tokens.propertyNames.enum;
const change = (id: string, patch: object) => definitions.map(t => t.id === id ? { ...t, ...patch } : t);

describe("JSON theme compiler", () => {
  it("resolves inherited values and orders the shared catalog", () => {
    const result = compileThemes(definitions, allowed);
    expect(result.ids).toEqual(["light", "dark", "rider-black", "vscode-black"]);
    expect(result.themes.find(t => t.id === "rider-black").tokens["cat-file"]).toBe("#7dd3fc");
    expect(result.themes.find(t => t.id === "vscode-black").tokens.panel).toBe("#181818");
    expect(result.css).toMatch(/^:root,\n:root\[data-theme="dark"\]/);
  });
  it("adds a theme to CSS, previews, catalog and boot IDs from its definition alone", () => {
    const custom = { schemaVersion: 1, id: "custom-example", name: "Custom Example", colorScheme: "dark", order: 50, extends: "vscode-black", tokens: { accent: "#aabbcc" } };
    const result = compileThemes([...definitions, custom], allowed);
    expect(result.ids.at(-1)).toBe("custom-example");
    expect(result.catalog).toContain('"name": "Custom Example"');
    expect(result.css).toContain(':root[data-theme="custom-example"]');
    expect(result.css).toContain('.appearance-preview[data-swatch="custom-example"]');
    expect(result.themes.at(-1).selection).toEqual({ background: "#264f78", foreground: "#ffffff" });
  });
  it("resolves a preview's references against its own theme", () => {
    const result = compileThemes(change("rider-black", { tokens: { accent: "var(--text)" } }), allowed);
    const swatch = result.css.split('.appearance-preview[data-swatch="rider-black"]')[1].split("}")[0];
    expect(swatch).toContain("--tp-accent: #d8dae0;");
  });
  it("discovers new JSON files and detects stale generated artifacts without rewriting in check mode", () => {
    const root = mkdtempSync(join(tmpdir(), "ccdeck-theme-generator-"));
    const dir = join(root, "src/web/themes");
    try {
      mkdirSync(dir, { recursive: true }); mkdirSync(join(root, "src/web/styles"));
      writeFileSync(join(dir, "schema.json"), JSON.stringify(load("schema")));
      for (const definition of definitions) writeFileSync(join(dir, `${definition.id}.json`), JSON.stringify(definition));
      writeFileSync(join(root, "src/web/index.html"), 'var themes = /* theme-ids:start */ [] /* theme-ids:end */; var lightThemes = /* theme-light-ids:start */ [] /* theme-light-ids:end */;');
      generateThemes(root);
      expect(() => generateThemes(root, { check: true })).not.toThrow();
      const custom = { ...definitions[1], id: "extra-theme", name: "Extra Theme", order: 50 };
      writeFileSync(join(dir, "extra-theme.json"), JSON.stringify(custom));
      expect(() => generateThemes(root, { check: true })).toThrow("out of date");
      expect(readFileSync(join(dir, "catalog.generated.ts"), "utf8")).not.toContain("Extra Theme");
      generateThemes(root);
      expect(readFileSync(join(dir, "catalog.generated.ts"), "utf8")).toContain("Extra Theme");
      expect(readFileSync(join(root, "src/web/index.html"), "utf8")).toContain('/* theme-light-ids:start */ ["light","extra-theme"]');
      expect(() => generateThemes(root, { check: true })).not.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("rejects missing or cyclic inheritance", () => {
    expect(() => compileThemes(change("rider-black", { extends: "missing" }), allowed)).toThrow("unknown parent");
    const cyclic = change("rider-black", { extends: "vscode-black" }).map(t => t.id === "vscode-black" ? { ...t, extends: "rider-black" } : t);
    expect(() => compileThemes(cyclic, allowed)).toThrow("inheritance cycle");
  });
  it("rejects incomplete bases, unknown tokens and cyclic variable references", () => {
    expect(() => compileThemes(change("dark", { tokens: {} }), allowed)).toThrow("missing token");
    expect(() => compileThemes(change("rider-black", { tokens: { typo: "#ffffff" } }), allowed)).toThrow("unknown token");
    expect(() => compileThemes(change("rider-black", { tokens: { accent: "var(--missing)" } }), allowed)).toThrow("unknown token reference");
    expect(() => compileThemes(change("rider-black", { tokens: { accent: "var(--text)", text: "var(--accent)" } }), allowed)).toThrow("token reference cycle");
  });
  it("rejects malformed metadata and CSS rules in values", () => {
    expect(() => compileThemes([...definitions, definitions[0]], allowed)).toThrow("duplicate id");
    expect(() => compileThemes(change("rider-black", { schemaVersion: 2 }), allowed)).toThrow("schemaVersion");
    expect(() => compileThemes(change("rider-black", { id: 'bad"] {}' }), allowed)).toThrow("invalid id");
    for (const accent of ["not-a-color", "#fff; display:none", "url(https://example.com)", "var(--text"]) {
      expect(() => compileThemes(change("rider-black", { tokens: { accent } }), allowed)).toThrow();
    }
  });
});
