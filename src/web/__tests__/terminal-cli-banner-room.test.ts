// The out-of-date terminal's row, in the canvas's column, had its command and
// its × under the usage panel at 1024px, and on a phone the usage panel covered
// the whole row: both rail panels are open by default and fixed over the
// strip's right end. It takes the rating question's shape instead (see
// rating-banner-room.test.ts): the row spans the window, everything docked
// starts under it, and it says how tall it is so the fixed rail can follow.
//
// The layout is measured in a browser; what a plain-node run can hold is the
// sheet's rules and the height the row hands the page.
import { afterEach, describe, expect, it, vi } from "vitest";

import { mount } from "./fake-react";
import { sheetText } from "./sheet-source";

vi.mock("react", async () => (await import("./fake-react")).react);

const { default: TerminalCliBanner } = await import("../components/TerminalCliBanner");

interface Rule { selector: string; within: string[]; body: string }

function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const stack: string[] = [];
  let buf = "";
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (ch === "{") { stack.push(buf.trim()); buf = ""; continue; }
    if (ch === "}") {
      const prelude = stack.pop() ?? "";
      if (!prelude.startsWith("@")) out.push({ selector: prelude, within: stack.filter(s => s.startsWith("@")), body: buf });
      buf = "";
      continue;
    }
    buf += ch;
  }
  return out;
}

const all = rules(sheetText());
const decl = (r: Rule, prop: string) => r.body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))?.[1].trim() ?? null;
const top = (sel: RegExp) => all.filter(r => r.within.length === 0 && sel.test(r.selector));
const phone = (sel: RegExp) => all.filter(r => r.within.some(w => /max-width:\s*640px/.test(w)) && sel.test(r.selector));

describe("the out-of-date terminal's row", () => {
  it("spans the window under the topbar, after the rule that puts a banner in the canvas's column", () => {
    const own = top(/\.ver-banner\.cli-banner\b/).find(r => decl(r, "grid-column") != null);
    expect(own && decl(own, "grid-column")).toBe("1 / -1");
    const sheet = sheetText();
    const column = top(/\.ver-banner\b/).filter(r => decl(r, "grid-column") === "1");
    expect(column.length).toBeGreaterThan(0);
    for (const r of column) expect(sheet.indexOf(r.selector + " {"), r.selector).toBeLessThan(sheet.indexOf(own!.selector + " {"));
  });

  it("starts the left panel, the detail panel and the rail under it, by the height it reports", () => {
    const docked = top(/\.app:has\(\.cli-banner\)/).filter(r => decl(r, "grid-row") === "3 / -1").map(r => r.selector).join(" ");
    for (const panel of [".left-column", ".detail"]) expect(docked).toContain(panel);
    const rail = top(/\.app:has\(\.cli-banner\)/).filter(r => /\.usage-panel/.test(r.selector) && /\.sysdetail/.test(r.selector));
    expect(rail).toHaveLength(1);
    const own = (prop: string) => /^calc\((.*)\)$/.exec(top(/^\.usage-panel$/).map(r => decl(r, prop)).find(Boolean)!)![1];
    expect(decl(rail[0], "top")).toBe(`calc(${own("top")} + var(--cli-banner-h, 0px))`);
    expect(decl(rail[0], "max-height")).toBe(`calc(${own("max-height")} - var(--cli-banner-h, 0px))`);
  });

  it("on a phone, keeps the stacked rail clear of the dock and starts the detail sheet under it", () => {
    const at = (sel: RegExp, prop: string) => phone(sel).map(r => decl(r, prop)).filter(Boolean);
    expect(at(/\.app:has\(\.cli-banner\) \.usage-panel\b/, "max-height"))
      .toContain("calc(50vh - 38px - var(--dock-h) / 2 - var(--cli-banner-h, 0px))");
    expect(at(/\.app:has\(\.cli-banner\) \.sysdetail\b/, "top")).toContain("auto");
    expect(at(/\.app:has\(\.cli-banner\) \.detail\b/, "top")).toContain("calc(var(--topbar-h) + var(--cli-banner-h, 0px))");
  });
});

describe("the height it hands the page", () => {
  let observed: Array<() => void> = [];
  afterEach(() => { observed = []; vi.unstubAllGlobals(); });

  it("is written as --cli-banner-h while the row is up, follows it as it wraps, and is taken away with it", () => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(private cb: () => void) {}
      observe() { observed.push(this.cb); }
      disconnect() { observed = observed.filter(cb => cb !== this.cb); }
    });
    const style = new Map<string, string>();
    const page = { style: { setProperty: (k: string, v: string) => style.set(k, v), removeProperty: (k: string) => style.delete(k) } };
    let height = 40.5;
    const row = { getBoundingClientRect: () => ({ height }), closest: (sel: string) => (sel === ".app" ? page : null) };
    const props = {
      cli: { version: "3.42.0", command: "npm i -g ccdeck@latest" },
      notice: { dismissTerminalCli: () => {}, copyTerminalCli: () => {}, terminalCliCopied: false },
    };
    const view = mount(TerminalCliBanner, props, {
      commit: tree => {
        const ref = (tree as { ref?: { current: unknown } } | null)?.ref;
        if (ref && typeof ref === "object") ref.current = row;
      },
    });
    expect(style.get("--cli-banner-h")).toBe("41px");
    height = 64;
    for (const cb of observed) cb();
    expect(style.get("--cli-banner-h")).toBe("64px");
    view.unmount();
    expect(style.has("--cli-banner-h")).toBe(false);
  });
});
