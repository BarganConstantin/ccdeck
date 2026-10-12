import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CHARACTER_KEY, resolveCharacter, storedCharacter } from "../character";
import { writeStored } from "../storage";
import { FOX } from "../fox-sprite";
import { spriteRects, SPRITE_H, SPRITE_W } from "../claude-fm-sprite";
import CharacterPicker from "../components/CharacterPicker";
import CharacterSprite from "../components/CharacterSprite";
import type { Act } from "../claude-fm";

afterEach(() => vi.unstubAllGlobals());

describe("character selection", () => {
  it("keeps the existing companion for missing or obsolete preferences", () => {
    for (const value of [null, undefined, "", "removed-character", "FOX"]) {
      expect(resolveCharacter(value)).toBe("deck");
    }
    expect(resolveCharacter("fox")).toBe("fox");
  });

  it("restores the saved choice, with blocked storage falling back safely", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    } });
    writeStored(CHARACTER_KEY, "fox");
    expect(storedCharacter()).toBe("fox");
    vi.stubGlobal("window", { get localStorage() { throw new Error("blocked"); } });
    expect(storedCharacter()).toBe("deck");
  });

  it("names both choices and gives only the selected radio a tab stop", () => {
    for (const character of ["deck", "fox"] as const) {
      const html = renderToStaticMarkup(createElement(CharacterPicker, { character, onCharacter: () => {} }));
      expect(html).toContain('role="radiogroup" aria-label="Choose character"');
      expect(html.match(/role="radio"/g)).toHaveLength(2);
      expect(html.match(/aria-checked="true" tabindex="0"/g)).toHaveLength(1);
      expect(html).toContain("Deck companion");
      expect(html).toContain("Fox");
    }
  });

  it("fits the existing scene footprint with a complete color vocabulary", () => {
    expect(FOX).toHaveLength(SPRITE_H);
    expect(FOX.every(row => row.length === SPRITE_W)).toBe(true);
    expect(FOX.every(row => /^[.ofsewn]+$/.test(row))).toBe(true);
    for (const rect of spriteRects(FOX)) {
      expect(rect.x + rect.w).toBeLessThanOrEqual(SPRITE_W);
      expect(rect.y).toBeLessThan(SPRITE_H);
    }
  });

  it("renders the fox's special poses and the original companion", () => {
    const poses: [Act, string][] = [
      ["climb", "fm-grip"], ["rope-throw", "fm-grip"], ["rope-catch", "fm-grip"], ["pull-up", "fm-grip"],
      ["land", "fm-crouch-legs"], ["dismount", "fm-crouch-legs"],
      ["sit", "fm-seated-legs"], ["cast", "fm-seated-legs"], ["fish", "fm-seated-legs"],
      ["reel", "fm-seated-legs"], ["stow", "fm-seated-legs"],
    ];
    for (const [act, group] of poses) for (const facing of ["left", "right"] as const) {
      const html = renderToStaticMarkup(createElement(CharacterSprite, { character: "fox", act, facing }));
      expect(html).toContain('viewBox="0 0 18 14"');
      expect(html).toContain(`class="${group}"`);
      expect(html).toContain('data-side="left"');
      expect(html).toContain('data-side="right"');
      expect(html).not.toContain("undefined");
    }
    expect(renderToStaticMarkup(createElement(CharacterSprite, { character: "deck", act: null, facing: "right" })))
      .not.toContain('data-character="fox"');
  });
});
