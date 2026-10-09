import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compileThemes } from "../../../scripts/theme-compiler.mjs";

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
