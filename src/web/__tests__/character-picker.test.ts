import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CHARACTER_KEY, CHARACTERS, resolveCharacter, storedCharacter } from "../character";
import { writeStored } from "../storage";
import { FOX } from "../fox-sprite";
import { PENGUIN } from "../penguin-sprite";
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
    expect(resolveCharacter("penguin")).toBe("penguin");
  });

  it("restores the saved choice, with blocked storage falling back safely", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    } });
    for (const { id } of CHARACTERS) {
      writeStored(CHARACTER_KEY, id);
      expect(storedCharacter()).toBe(id);
    }
    vi.stubGlobal("window", { get localStorage() { throw new Error("blocked"); } });
    expect(storedCharacter()).toBe("deck");
  });

  it("names every choice and gives only the selected radio a tab stop", () => {
    for (const { id: character } of CHARACTERS) {
      const html = renderToStaticMarkup(createElement(CharacterPicker, { character, onCharacter: () => {} }));
      expect(html).toContain('role="radiogroup" aria-label="Choose character"');
      expect(html.match(/role="radio"/g)).toHaveLength(3);
      expect(html.match(/aria-checked="true" tabindex="0"/g)).toHaveLength(1);
      expect(html).toContain("Deck companion");
      expect(html).toContain("Fox");
      expect(html).toContain("Penguin");
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
    expect(PENGUIN).toHaveLength(SPRITE_H);
    expect(PENGUIN.every(row => row.length === SPRITE_W && /^[.dhweb]+$/.test(row))).toBe(true);
  });

  it("renders both animals' special poses and the original companion", () => {
    const poses: [Act, string][] = [
      ["climb", "fm-grip"], ["rope-throw", "fm-grip"], ["rope-catch", "fm-grip"], ["pull-up", "fm-grip"],
      ["land", "fm-crouch-legs"], ["dismount", "fm-crouch-legs"],
      ["sit", "fm-seated-legs"], ["cast", "fm-seated-legs"], ["fish", "fm-seated-legs"],
      ["reel", "fm-seated-legs"], ["stow", "fm-seated-legs"],
    ];
    for (const character of ["fox", "penguin"] as const)
      for (const [act, group] of poses) for (const facing of ["left", "right"] as const) {
      const html = renderToStaticMarkup(createElement(CharacterSprite, { character, act, facing }));
      expect(html).toContain(`data-character="${character}"`);
      expect(html).toContain('viewBox="0 0 18 14"');
      expect(html).toContain(`class="${group}"`);
      expect(html).toContain('data-side="left"');
      expect(html).toContain('data-side="right"');
      expect(html).not.toContain("undefined");
    }
    expect(renderToStaticMarkup(createElement(CharacterSprite, { character: "deck", act: null, facing: "right" })))
      .not.toContain('data-character="fox"');
  });

  it("keeps the tail out of the stepping legs, including runs across the boundary", () => {
    const html = renderToStaticMarkup(createElement(CharacterSprite, { character: "fox", act: "walk", facing: "right" }));
    const tail = html.match(/<g class="fm-body" data-part="tail">(.*?)<\/g>/)?.[1];
    expect(tail).toContain('x="12" y="11" width="2"');
    const legs = [...html.matchAll(/<g class="fm-leg" data-side="(?:left|right)">(.*?)<\/g>/g)];
    expect(legs).toHaveLength(2);
    for (const leg of legs) for (const rect of leg[1].matchAll(/x="(\d+)" y="\d+" width="(\d+)"/g)) {
      expect(Number(rect[1]) + Number(rect[2])).toBeLessThanOrEqual(12);
    }
    // The hips connect to the tail above the animated feet.
    expect(FOX[10].slice(10, 14)).not.toContain(".");
  });
});
