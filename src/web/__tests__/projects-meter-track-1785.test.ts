// #1785. The Projects report's per-project meters drew no track. Each row's
// coloured fill is that project's share of the account's spend, and the rail
// it should sit in was not there, so a 40% fill read as a bar of arbitrary
// length. Every other meter in the deck draws its fill over a --line track.
//
// Both the row's track and the share bar above the list painted
// `var(--panel-inset)`, which is the 14px every panel prints its rows at, not
// a colour. A length where a colour belongs is invalid at computed-value time,
// so the background fell back to transparent in both themes.
//
// The modal is rendered, the way projects-day-chart-group-1774 renders it, to
// find the elements the fills and the segments actually sit in; their
// backgrounds are then read out of the sheet and resolved through the theme
// blocks, the way a browser resolves a custom property.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Counters } from "../account-projects-reconcile";
import { sheetText } from "./sheet-source";

const seed = vi.hoisted(() => ({ load: { gen: 0, report: null as unknown, error: null, early: null } }));
vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));
vi.mock("../account-projects-load", async (orig) => ({ ...(await orig<typeof import("../account-projects-load")>()), INITIAL_LOAD: seed.load }));

const { default: AccountProjectsModal } = await import("../components/AccountProjectsModal");

const MODEL = "claude-opus-4-5-20251101";
const c = (i: number, o: number): Counters => ({ i, o, cr: 0, cc: 0, c1h: 0, c5m: 0 });

beforeAll(() => { vi.stubGlobal("document", { body: null }); });
afterAll(() => { vi.unstubAllGlobals(); });

function render(): string {
  const projects = [
    { path: "/u/alpha", models: { [MODEL]: c(3_000, 30_000) } },
    { path: "/u/beta", models: { [MODEL]: c(1_000, 10_000) } },
  ];
  const data = { trackedSince: null, days: 7, projects: [], unattributed: null, daily: [{ day: "2026-09-22", projects, unattributed: null }] };
  seed.load.report = { gen: 0, days: 7, data, cost: { phase: "failed" } };
  return renderToStaticMarkup(createElement(AccountProjectsModal, { num: 1, name: "a@x.io", onClose: () => {} }));
}

/** The class of the element each `child` sits directly in. */
function parentsOf(html: string, child: string): Set<string> {
  const re = new RegExp(`<\\w+ class="([^"]+)"[^>]*>(?:<span class="${child}")`, "g");
  return new Set([...html.matchAll(re)].map(m => m[1]));
}

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

/** Top-level rules only: a @media body is a different cascade. */
function topLevel(s: string): Array<{ sels: string[]; body: string }> {
  const out: Array<{ sels: string[]; body: string }> = [];
  let depth = 0, from = 0, open = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{") { if (depth++ === 0) open = i; }
    else if (s[i] === "}" && --depth === 0) {
      const prelude = s.slice(from, open).trim();
      if (!prelude.startsWith("@")) {
        out.push({ sels: prelude.split(",").map(x => x.replace(/\s+/g, " ").trim()), body: s.slice(open + 1, i) });
      }
      from = i + 1;
    }
  }
  return out;
}
const RULES = topLevel(css);

function tokens(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of RULES.filter(r => r.sels.length === 1 && r.sels[0] === selector)) {
    for (const [, name, value] of r.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  }
  return out;
}
const SHARED = tokens(":root");
const DARK = RULES.find(r => r.sels.join() === ':root,:root[data-theme="dark"]');
const THEMES = {
  dark: { ...SHARED, ...Object.fromEntries([...(DARK?.body ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()])) },
  light: { ...SHARED, ...tokens(':root[data-theme="light"]') },
};

/** The last `background` a top-level rule gives `selector`, var() resolved. */
function background(selector: string, theme: keyof typeof THEMES): string | null {
  const bodies = RULES.filter(r => r.sels.includes(selector)).map(r => r.body).join(";");
  const all = [...bodies.matchAll(/(?:^|[;{\s])background(?:-color)?\s*:\s*([^;]+)/g)];
  let value = all.length ? all[all.length - 1][1].trim() : null;
  for (let hops = 0; value && hops < 8; hops++) {
    const v = /^var\((--[\w-]+)\)$/.exec(value);
    if (!v) break;
    value = THEMES[theme][v[1]] ?? null;
  }
  return value;
}

const COLOUR = /^(#[0-9a-f]{3,8}|(?:rgba?|hsla?|color-mix)\(.*\))$/i;

describe("the Projects report's meters draw the track they measure against (#1785)", () => {
  let rails = new Set<string>();
  beforeAll(() => {
    const html = render();
    rails = new Set([...parentsOf(html, "ap-proj-fill"), ...parentsOf(html, "ap-proj-seg")]);
  });

  it("finds the rail each row's fill sits in, and the share bar's", () => {
    expect([...rails].sort()).toEqual(["ap-proj-bar", "ap-proj-track"]);
  });

  it("paints each rail a colour, in both themes", () => {
    for (const rail of rails) {
      for (const theme of ["dark", "light"] as const) {
        const value = background(`.${rail}`, theme);
        expect(value, `.${rail} in ${theme}`).toMatch(COLOUR);
      }
    }
  });

  it("paints it off the dialog's own surface, so the empty part of the rail shows", () => {
    for (const rail of rails) {
      for (const theme of ["dark", "light"] as const) {
        expect(background(`.${rail}`, theme), `.${rail} in ${theme}`).not.toBe(background(".modal", theme));
      }
    }
  });
});
