// #1026: the right rail is two panels, and below 640px it was one.
//
// Both rail panels are `position: fixed; top: 60px; z-index: 20`. The narrow
// -width block changed only the horizontal box — `left: 8px; right: 8px; width:
// auto` on each — so with both open they occupied the IDENTICAL rectangle and
// the later one in DOM order painted over the whole of the other.
//
// MEASURED in Firefox against the real sheet, both panels open:
//
//   500px viewport, before   usage  left 8   right 492  top 57  bottom 257
//                            machine left 8  right 492  top 57  bottom 257   96,800px² of overlap
//   500px viewport, after    usage  left 8   right 492  top 52  bottom 252
//                            machine left 8  right 492  top 498 bottom 698   0
//   1200px, unchanged        usage  left 552 right 832 | machine left 252 right 532
//
// and with both panels overflowing, the caps leave exactly 8px between them:
// usage bottom 371, machine top 379.
//
// The second half is the variable that exists to stop the pair drifting. With
// the detail panel widened to 400px and --rail-r moved to 408 — the edit its own
// comment invites — the two panels measured 60px apart instead of the designed
// 20px, because only one of them read the variable:
//
//   before   usage left 552 right 832 | machine left 212 right 492   gap 60
//   after    usage left 512 right 792 | machine left 212 right 492   gap 20
//
// and usage's right edge at 832 was 32px underneath a detail panel starting at
// 800.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const at = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const raw = at("../styles.css");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
const machinePanel = at("../components/MachinePanel.tsx");
const soundMenu = at("../components/SoundMenu.tsx");
const processList = at("../components/ProcessListModal.tsx");

/**
 * Everything the 640px breakpoint declares, from every block that opens it.
 *
 * All of them, concatenated: the sheet writes this query more than once — the
 * topbar has its own, above the rail's — and reading the first one found is how
 * a check on the rail panels comes to be run against the topbar's padding.
 */
const narrow = (() => {
  let out = "";
  for (const m of css.matchAll(/@media \(max-width: 640px\)\s*\{/g)) {
    let depth = 0;
    for (let k = m.index! + m[0].length - 1; k < css.length; k++) {
      if (css[k] === "{") { depth++; if (depth === 1) continue; }
      else if (css[k] === "}") { depth--; if (!depth) break; }
      out += css[k];
    }
  }
  expect(out, "the 640px breakpoint is gone").not.toBe("");
  return out;
})();
/**
 * The winning value of `prop` for this exact selector.
 *
 * Every rule that LISTS the selector, not the first rule that mentions it: the
 * narrow-width block opens with `.app .usage-panel, .app .sysdetail { … }` and
 * a first-match read of `.app .sysdetail` returns that grouped body, which
 * carries the horizontal box and nothing else. Last declaration wins, as the
 * cascade has it between rules of equal weight.
 */
function decl(selector: string, prop: string, body = css): string | null {
  let out: string | null = null;
  for (const m of body.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!m[1].split(",").map(x => x.trim()).includes(selector)) continue;
    const d = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(m[2]);
    if (d) out = d[1].trim();
  }
  return out;
}

describe("below 640px the two rail panels stack rather than share a rectangle (#1026)", () => {
  it("gives the machine panel the bottom of the window, not the same top", () => {
    // `top: auto` is the load-bearing half: without it, `bottom` joins `top:
    // 60px` and the panel stretches over the other one rather than moving.
    expect(decl(".app .sysdetail", "top", narrow)).toBe("auto");
    expect(decl(".app .sysdetail", "bottom", narrow)).toBe("8px");
  });

  it("caps both so they cannot grow into each other, whatever they contain", () => {
    // Half the viewport each, less the chrome at either end — measured at 8px
    // of daylight with both panels overflowing.
    const cap = decl(".app .usage-panel", "max-height", narrow);
    expect(cap, "the usage panel keeps the full-height cap and can reach the other").not.toBeNull();
    expect(cap).toBe(decl(".app .sysdetail", "max-height", narrow));
    expect(cap).toMatch(/50vh/);
  });

  it("leaves the desktop layout alone, which is the one the owner chose (#847)", () => {
    // The stacking turned down for #847 was one column on a DESKTOP, where the
    // pair fits side by side. Nothing here escapes the media block.
    expect(decl(".usage-panel", "top")).toBe("60px");
    expect(decl(".sysdetail", "top")).toBe("60px");
    expect(decl(".sysdetail", "bottom")).toBeNull();
    expect(decl(".sysdetail.shifted", "right")).toBe("calc(var(--rail-r) + 280px + 20px)");
  });
});

describe("--rail-r is read by both panels it was introduced to hold together (#1026)", () => {
  it("is where the usage panel's right edge comes from", () => {
    expect(decl(".usage-panel", "right")).toBe("var(--rail-r)");
  });

  it("is written in exactly one place, which was the point of it", () => {
    // The literal was in two rules and the variable in one, so widening the
    // detail panel moved one panel of the pair. Every 368 in the sheet has to
    // be the definition itself.
    const defs = [...css.matchAll(/--rail-r\s*:\s*([^;]+);/g)].map(m => m[1].trim());
    expect(defs).toEqual(["368px", "8px"]);
    expect(css).not.toMatch(/\.usage-panel\s*\{[^}]*right:\s*368px/);
    // And the duplicate override is gone with it.
    expect(css).not.toMatch(/:not\(:has\(\.detail\)\)\s+\.usage-panel/);
  });

  it("no longer has a comment pointing at a rule that was deleted", () => {
    // The definition's own comment named `.app:not(:has(.detail)) .usage-panel`
    // as living "further down this sheet". It does not.
    expect(raw).not.toMatch(/`\.app:not\(:has\(\.detail\)\) \.usage-panel`, further down/);
  });
});

describe("the per-core strip keeps a column wide enough to be a bar (#1026)", () => {
  it("wraps with a floor instead of dividing a fixed row by the core count", () => {
    // `repeat(var(--n), 1fr)` measured 19px at 12 threads, 1.93px at 64 and
    // 0px at 128 — where the 2px gaps consume the whole 250px content box and
    // the strip renders blank. After: 19px, 3.03px over two rows, 3.03px over
    // three. A 64-core workstation is inside this deck's audience.
    expect(decl(".sd-cores", "display")).toBe("flex");
    expect(decl(".sd-cores", "flex-wrap")).toBe("wrap");
    expect(decl(".sd-cores .sd-core", "min-width")).toBe("3px");
    expect(decl(".sd-cores .sd-core", "height")).toBe("26px");
  });

  it("stops counting its own columns through a custom property", () => {
    // --n was `os.cpus().length` with no cap anywhere in the chain, which is
    // how the strip came to have a column count it could not fit.
    expect(css).not.toMatch(/var\(--n\)/);
    expect(machinePanel).not.toMatch(/"--n"/);
  });
});

describe("the sound menu's reading is described once (#1026)", () => {
  it("has one rule, so what ships is what the comment beside it says", () => {
    // Two rules seven lines apart made opposite arguments about the same span:
    // `.sound-menu .sm-read` (0,2,0) dim at 10px, and a bare `.sm-read` (0,1,0)
    // restating --text at 11px, which lost both and never drew anything.
    expect(decl(".sm-read", "color")).toBeNull();
    expect(decl(".sound-menu .sm-read", "color")).toBe("var(--muted)");
    expect(decl(".sound-menu .sm-read", "font-size")).toBe("10px");
    // The geometry the dead rule also carried has to survive the merge.
    expect(decl(".sound-menu .sm-read", "min-width")).toBe("34px");
    expect(decl(".sound-menu .sm-read", "text-align")).toBe("right");
  });

  it("is rendered only where that descendant selector reaches", () => {
    // The merge is only safe because the span has exactly one render site, and
    // it is inside `.sound-menu`.
    expect(soundMenu).toMatch(/className="sm-read"/);
    expect(soundMenu).toMatch(/className="sound-menu"/);
    const others = ["../App.tsx", "../components/MachinePanel.tsx", "../components/ProcessListModal.tsx"];
    for (const f of others) expect(at(f), f).not.toMatch(/className="[^"]*\bsm-read\b/);
  });
});

describe("the process table's column geometry does not rest on source order (#1026)", () => {
  it("has no !important that cannot apply", () => {
    // pid is the sixth column, so `.pl-body .pl-table th:nth-child(6)`'s
    // `padding-right: 18px !important` at (0,3,1) settled it — two !importants
    // are resolved by specificity like anything else, and this one read as the
    // pid column's padding while never being it.
    const rule = /\.pl-pid-h\s*\{([^}]*)\}/.exec(css)![1];
    expect(rule).not.toMatch(/padding-right/);
    // Still only the two that do something, and no more than that.
    expect(css.match(/!important/g)!.length).toBe(2);
  });

  it("pins the pid column at the index its neighbours' rules assume", () => {
    // Every column rule in this table is an `nth-child`, so adding a column
    // before `user` shifts the widest gap onto the wrong boundary — the exact
    // defect the comment above those rules says it measured and fixed. The
    // order is asserted here rather than in a comment.
    const heads = [...processList.matchAll(/(?:<SortHead\s+col="(\w+)"|className="(pl-pid-h)")/g)]
      .map(m => m[1] ?? "pid");
    expect(heads.slice(0, 7)).toEqual(["cpu", "rss", "threads", "uptime", "user", "pid", "name"]);
  });

  it("wins the width of the memory column on specificity, not on order", () => {
    // `:is()` takes the specificity of its most specific argument, so the
    // panel's `:is(.sysdetail, .pl-body) .sd-procs th:nth-child(2) {40px}` and
    // this table's override were both (0,3,1) and the modal won because it is
    // written later. Sorting this sheet into sections would have dropped the
    // modal's memory column to a width measured for a 280px panel.
    expect(decl(".pl-body .pl-table.sd-procs th:nth-child(2)", "width")).toBe("66px");
    expect(css).toMatch(/\.pl-table\.sd-procs th:nth-child\(2\)/);
    // And the table really does carry both classes, or the override is a
    // selector that matches nothing.
    expect(processList).toMatch(/className="sd-procs pl-table"/);
  });
});
