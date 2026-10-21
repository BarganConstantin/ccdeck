import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import RadioCountryFlag from "../components/RadioCountryFlag";

const draw = (code?: string) => renderToStaticMarkup(createElement(RadioCountryFlag, { code }));

describe("radio country artwork", () => {
  it("renders local images for countries independently of the OS emoji font", () => {
    for (const code of ["FR", "MD", "US", "DE", "JP", "GB", "XK"]) {
      const html = draw(code);
      expect(html).toContain('<img');
      expect(html).toContain(`/radio-flags/${code.toLowerCase()}.svg`);
      expect(html).toContain('width="24" height="18"');
      expect(html).toContain('alt="" aria-hidden="true"');
      expect(html).toContain('draggable="false"');
      expect(html).not.toMatch(/src="https?:/);
    }
  });

  it("accepts lowercase country codes but rejects missing, unknown and malformed codes", () => {
    expect(draw(" fr ")).toContain("/radio-flags/fr.svg");
    for (const code of [undefined, "", "ZZ", "France", "../fr", "🇫🇷"]) {
      expect(draw(code)).toContain("<svg");
      expect(draw(code)).not.toContain("<img");
    }
  });

  it("ships self-contained SVGs for every country in the map", () => {
    const directory = new URL("../assets/radio-flags/", import.meta.url);
    const assets = readdirSync(directory).filter(name => name.endsWith(".svg"));
    const world = JSON.parse(readFileSync(new URL("../assets/radio-world.json", import.meta.url), "utf8"));
    for (const country of world) {
      if (/^[A-Z]{2}$/.test(country.code)) expect(assets, country.code).toContain(`${country.code.toLowerCase()}.svg`);
    }
    for (const name of assets) {
      const svg = readFileSync(new URL(name, directory), "utf8");
      expect(svg, name).toContain("<svg");
      expect(svg, name).not.toMatch(/<(?:script|image)\b|(?:href|src)="https?:/);
    }
  });
});
