// V4's kit icons: the 55 icons and 5 state glyphs drawn as V4's Figma exports
// them, and the chrome that draws them. 14px at a 1.5 stroke, the five 12px
// ones at 1.25, round caps and joins, currentColor.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { KIT_ICONS, KIT_STATE_GLYPHS, KitIcon, KitStateGlyph, type KitIconName } from "../components/kit-icons";
import { StateMark, AlertMark } from "../components/StateMark";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const TWELVE = ["chevron-down", "external", "folder", "lock", "pause"];

describe("the kit's icons", () => {
  const names = Object.keys(KIT_ICONS) as KitIconName[];

  it("has the 55 icons and the 5 state glyphs", () => {
    expect(names).toHaveLength(55);
    expect(Object.keys(KIT_STATE_GLYPHS).sort()).toEqual(["done", "error", "idle", "waiting", "working"]);
  });

  it.each(names)("%s renders at the kit's size, stroke and caps", name => {
    const html = renderToStaticMarkup(createElement(KitIcon, { name }));
    const size = TWELVE.includes(name) ? 12 : 14;
    expect(html).toContain(`width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"`);
    expect(html).toContain(`stroke-width="${size === 12 ? 1.25 : 1.5}"`);
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('stroke-linecap="round" stroke-linejoin="round"');
    expect(html).toContain('aria-hidden="true" focusable="false"');
    expect(html).toContain('fill="none"');
    // The only fill on any icon is info's dot.
    const fills = html.match(/fill="(?!none")[^"]*"/g) ?? [];
    expect(fills).toEqual(name === "info" ? ['fill="currentColor"'] : []);
  });

  it("draws unreachable in a 14 box and lets its strokes overflow", () => {
    const html = renderToStaticMarkup(createElement(KitIcon, { name: "unreachable" }));
    expect(html).toContain('viewBox="0 0 14 14"');
    expect(html).toContain('overflow="visible"');
  });
});

describe("the redrawn icons keep the export's geometry", () => {
  const dOf = (name: KitIconName) => (KIT_ICONS[name].els[0] as { d: string }).d;

  it("usage, settings, arrange, radar, clear, calendar, browser-watch", () => {
    expect(KIT_ICONS.arrange.els).toHaveLength(1);
    expect(dOf("arrange")).toBe("M3 2H5C5.55228 2 6 2.44772 6 3V5C6 5.55228 5.55228 6 5 6H3C2.44772 6 2 5.55228 2 5V3C2 2.44772 2.44772 2 3 2ZM9 2H11C11.5523 2 12 2.44772 12 3V5C12 5.55228 11.5523 6 11 6H9C8.44772 6 8 5.55228 8 5V3C8 2.44772 8.44772 2 9 2ZM3 8H5C5.55228 8 6 8.44772 6 9V11C6 11.5523 5.55228 12 5 12H3C2.44772 12 2 11.5523 2 11V9C2 8.44772 2.44772 8 3 8ZM9 8H11C11.5523 8 12 8.44772 12 9V11C12 11.5523 11.5523 12 11 12H9C8.44772 12 8 11.5523 8 11V9C8 8.44772 8.44772 8 9 8Z");
    expect(dOf("calendar")).toBe("M2 6H12M5 1.6V4.2M9 1.6V4.2M3.2 3H10.8C11.4627 3 12 3.53726 12 4.2V10.8C12 11.4627 11.4627 12 10.8 12H3.2C2.53726 12 2 11.4627 2 10.8V4.2C2 3.53726 2.53726 3 3.2 3Z");
    expect(dOf("browser-watch")).toBe("M1.4 7C1.4 7 3.4 3.2 7 3.2C10.6 3.2 12.6 7 12.6 7C12.6 7 10.6 10.8 7 10.8C3.4 10.8 1.4 7 1.4 7ZM1.4 7V7ZM7 5.6C6.5 5.6 6.04 5.87 5.79 6.3C5.54 6.73 5.54 7.27 5.79 7.7C6.04 8.13 6.5 8.4 7 8.4C7.77 8.4 8.4 7.77 8.4 7C8.4 6.23 7.77 5.6 7 5.6ZM7 5.6V5.6Z");
    expect(dOf("capacity")).toContain("M2.5 10.9C2.04231 10.1096");
    for (const n of ["usage", "settings", "radar", "clear"] as const) {
      expect(KIT_ICONS[n].size).toBe(14);
      expect(dOf(n).length).toBeGreaterThan(10);
    }
  });

  it("settings is a cog with a hub, not the eight rays that read as a sun", () => {
    const [cog, hub] = KIT_ICONS.settings.els as readonly [{ d: string }, { cx: number; cy: number; r: number }];
    expect(KIT_ICONS.settings.els).toHaveLength(2);
    expect(hub).toEqual({ cx: 7, cy: 7, r: 1.75 });
    // One closed outline, drawn from the top tooth's right shoulder.
    expect(cog.d.startsWith("M7.13 1.17L6.87 1.17C")).toBe(true);
    expect(cog.d.match(/M/g)).toHaveLength(1);
    expect(cog.d.endsWith("Z")).toBe(true);
    // Six teeth, 60 degrees apart: the outline's far points (past 5.4 from the
    // hub) fall in six directions and no others.
    const nums = cog.d.match(/[\d.]+/g)!.map(Number);
    const points = nums.flatMap((n, i) => i % 2 === 0 ? [[n - 7, nums[i + 1] - 7]] : []);
    // The teeth point up, down and to the four diagonals 60 apart: at 30
    // degrees plus a multiple of 60, measured from the right.
    const tips = points.filter(([x, y]) => Math.hypot(x, y) > 5.4).map(([x, y]) => ((Math.atan2(y, x) * 180) / Math.PI - 30) / 60);
    expect(new Set(tips.map(k => ((Math.round(k) % 6) + 6) % 6)).size).toBe(6);
    for (const k of tips) expect(Math.abs(k - Math.round(k)) * 60).toBeLessThan(15);
    // The ink stays inside the 14 box with the 1.5 stroke's half on every side.
    expect(Math.min(...nums)).toBeGreaterThanOrEqual(0.75);
    expect(Math.max(...nums)).toBeLessThanOrEqual(13.25);
    // The old drawing's rays are gone.
    expect(cog.d).not.toContain("M7 1.6V3.1");
    const html = renderToStaticMarkup(createElement(KitIcon, { name: "settings" }));
    expect(html).toContain('<circle cx="7" cy="7" r="1.75"></circle>');
  });

  it("the five state glyphs are the export's, with its opacities and weights", () => {
    expect(KIT_STATE_GLYPHS.waiting.els).toEqual([
      { cx: 7, cy: 7, r: 6, o: 0.35 },
      { d: "M7 3.75V7.5" },
      { d: "M7 10.25V10.26", w: 1.75 },
    ]);
    expect(KIT_STATE_GLYPHS.working.els).toEqual([
      { cx: 7, cy: 7, r: 5.5, o: 0.3 },
      { d: "M7 1.5C10.04 1.5 12.5 3.96 12.5 7" },
    ]);
    expect(KIT_STATE_GLYPHS.done.els).toEqual([{ d: "M3 7.4L5.6 10L11 4.4", w: 1.6 }]);
    expect(KIT_STATE_GLYPHS.error.els).toEqual([{ cx: 7, cy: 7, r: 5.5 }, { d: "M9 5L5 9M5 5L9 9" }]);
    expect(KIT_STATE_GLYPHS.idle.els).toEqual([{ cx: 7, cy: 7, r: 4.5 }]);
  });
});

describe("the state marks", () => {
  it("keep their class and kind, and draw the kit's glyph at 14", () => {
    const html = (kind: "live" | "done" | "idle" | "err") => renderToStaticMarkup(createElement(StateMark, { kind }));
    expect(html("live")).toMatch(/^<svg class="state-mark" data-kind="live" width="14" height="14" viewBox="0 0 14 14"/);
    expect(html("live")).toContain('stroke-opacity="0.3"');
    expect(html("done")).toContain('d="M3 7.4L5.6 10L11 4.4"');
    expect(html("err")).toContain('d="M9 5L5 9M5 5L9 9"');
    const alert = renderToStaticMarkup(createElement(AlertMark));
    expect(alert).toMatch(/^<svg class="alert-mark" width="14" height="14"/);
    expect(alert).toContain('stroke-opacity="0.35"');
    expect(renderToStaticMarkup(createElement(KitStateGlyph, { name: "idle" }))).toContain('r="4.5"');
  });

  it("take their colour from the existing tokens, not from the glyph", () => {
    const css = read("../styles/agent-node.css");
    expect(css).toContain('.state-mark[data-kind="live"] { color: var(--inflight); }');
    expect(css).toContain('.state-mark[data-kind="done"] { color: var(--ok); }');
    expect(css).toContain('.state-mark[data-kind="err"] { color: var(--err); }');
    expect(css).toContain(".alert-mark { flex: none; margin-left: auto; color: var(--warn); }");
  });
});

describe("the swapped call sites", () => {
  const swapped: Array<[string, string]> = [
    ["../components/rail-glyphs.tsx", "./kit-icons"],
    ["../components/CanvasControls.tsx", "./kit-icons"],
    ["../components/terminal/stage-icons.tsx", "../kit-icons"],
    ["../components/SettingsSectionGlyph.tsx", "./kit-icons"],
    ["../components/action-glyphs.tsx", "./kit-icons"],
    ["../components/chat/chat-icons.tsx", "../kit-icons"],
    ["../components/ViewSwitch.tsx", "./kit-icons"],
    ["../components/Inspector.tsx", "./kit-icons"],
    ["../components/InspectorTime.tsx", "./kit-icons"],
    ["../components/AccountsHeader.tsx", "./kit-icons"],
    ["../components/SettingsSearch.tsx", "./kit-icons"],
    ["../components/StateMark.tsx", "./kit-icons"],
  ];

  it.each(swapped)("%s draws from the kit", (file, from) => {
    const src = read(file);
    expect(src).toMatch(new RegExp(`from "${from.replace(/[./]/g, "\\$&")}"`));
    expect(src).toMatch(/<Kit(Icon|StateGlyph)/);
  });

  it("files that are all kit carry no stroke width of their own", () => {
    for (const f of ["CanvasControls.tsx", "action-glyphs.tsx", "chat/chat-icons.tsx", "ViewSwitch.tsx", "StateMark.tsx"]) {
      expect(read(`../components/${f}`)).not.toMatch(/strokeWidth/);
    }
  });

  it("the kit module uses only the kit's two weights on its svg", () => {
    const src = read("../components/kit-icons.tsx");
    expect(src).toContain("strokeWidth={def.size === 12 ? 1.25 : 1.5}");
    expect(src.match(/strokeWidth=/g)).toHaveLength(3); // the svg, then the two per-element overrides
  });
});
