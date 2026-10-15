// Status labels must pass on their actual CSS fill, not just on the root
// palette. The old live label passed on --panel but failed on its pink wash.
import { describe, expect, it } from "vitest";
import { cascade, el, selects } from "./sheet-cascade";
import { sheetText } from "./sheet-source";

type Rgba = [number, number, number, number];
const palette = sheetText().split(':root[data-theme="gruvbox-material"] {')[1].split("}")[0];
const tokens = Object.fromEntries([...palette.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const root = el("html", [], { attrs: { "data-theme": "gruvbox-material", "data-color-scheme": "dark" }, states: ["root"] });

function color(value: string): Rgba {
  const resolved = value.replace(/var\(--([\w-]+)\)/g, (_, name) =>
    tokens[name] ?? cascade(selector => selects(selector, [root]), `--${name}`, 1920));
  if (resolved !== value) return color(resolved);
  if (value === "transparent") return [0, 0, 0, 0];
  if (/^#[\da-f]{6}$/i.test(value)) return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)).concat(1) as Rgba;
  const rgb = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgb) {
    const parts = rgb[1].split(",").map(Number);
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  const mix = /^color-mix\(in srgb, (.+) ([\d.]+)%, (.+)\)$/.exec(value);
  if (mix) {
    const a = color(mix[1]), b = color(mix[3]), weight = Number(mix[2]) / 100;
    const alpha = a[3] * weight + b[3] * (1 - weight);
    return [0, 1, 2].map(i => alpha ? (a[i] * a[3] * weight + b[i] * b[3] * (1 - weight)) / alpha : 0).concat(alpha) as Rgba;
  }
  throw new Error(`Unsupported status colour: ${value}`);
}
function over(ink: Rgba, bed: Rgba): Rgba {
  return [0, 1, 2].map(i => ink[i] * ink[3] + bed[i] * (1 - ink[3])).concat(1) as Rgba;
}
function luminance(c: Rgba): number {
  const linear = c.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}
function contrast(a: Rgba, b: Rgba): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

describe("Material status text on its painted background", () => {
  const cases = [
    ...["active", "done", "err"].map(state => ({
      name: `card ${state}`,
      chain: [root, el("div", ["react-flow__node"]), el("div", ["agent-node", `state-${state}`]), el("span", ["state-pill", `state-${state}`])],
    })),
    ...["live", "paused", "dead"].map(state => ({
      name: `connection ${state}`,
      chain: [root, el("header", ["topbar"]), el("div", ["status"]), el("span", ["pill", state])],
    })),
    ...["opus", "sonnet", "haiku", "fable", "mythos"].map(family => ({
      name: `model ${family}`,
      chain: [root, el("span", ["model-chip"], { attrs: { "data-family": family } })],
    })),
  ];
  for (const { name, chain } of cases) {
    for (const surface of ["bg", "bg-soft", "panel"]) {
      it(`${name} clears 4.5:1 on ${surface}, including its own fill`, () => {
        const match = (selector: string) => selects(selector, chain);
        // --chip-hue is a component-local alias, resolved through the same
        // cascade rather than duplicating the model family's palette mapping.
        const foreground = cascade(match, "color", 1920)?.replace(/var\(--chip-hue\)/g, cascade(match, "--chip-hue", 1920) ?? "");
        const background = cascade(match, "background", 1920);
        expect(foreground).not.toBeNull();
        expect(background).not.toBeNull();
        const fill = background!.replace(/var\(--chip-hue\)/g, cascade(match, "--chip-hue", 1920) ?? "");
        const bed = over(color(fill), color(tokens[surface]));
        expect(contrast(over(color(foreground!), bed), bed)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  it("keeps the inferred waiting tool readable on the session list", () => {
    const chain = [root, el("aside", ["session-list"]), el("span", ["sl-waiting-tool"])];
    const foreground = cascade(selector => selects(selector, chain), "color", 1920);
    expect(foreground).not.toBeNull();
    expect(contrast(color(foreground!), color(tokens.panel))).toBeGreaterThanOrEqual(4.5);
  });
});
