// #1025: two shadow rules that won by accident, and in each case the loser was
// a state the design leans on.
//
// Both were invisible to review because nothing about either rule looks wrong
// on its own. `:root[data-theme="light"] .tool-burst` is (0,3,0) and quietly
// outranks `.tool-burst.status-err` (0,2,0), so redoing only `border-color` in
// the light block left a FAILED tool bubble wearing the same neutral slate
// shadow as the four successes beside it. And `.agent-node.state-active`
// restated the base card's `var(--shadow-1)` byte for byte — changing nothing
// at rest, and outranking `.agent-node:hover`, which is (0,2,0) and earlier.
//
// MEASURED, rather than argued from the specificity numbers: the real
// stylesheet was loaded into Firefox with `data-theme` set to each theme, and
// `getComputedStyle().boxShadow` read off. `:hover` was reached by serving a
// clone of the sheet with `:hover` rewritten to `.HV` — a class, so (0,1,0),
// the same weight a pseudo-class carries, in the same source position — and
// putting `HV` on the element. Before:
//
//   light, resting  .tool-burst.status-err  rgba(15,23,42,0.1) 0 2px 8px, rgba(15,23,42,0.04) 0 0 0 1px
//   light, resting  .tool-burst.status-done  ... the same two layers, to the byte
//   light, hovered  .tool-burst.clickable    ... still the same two layers
//   dark,  hovered  .agent-node.state-active rgba(0,0,0,0.25) 0 6px 18px   (--shadow-1: the RESTING value)
//   dark,  hovered  .agent-node.state-done   rgba(0,0,0,0.32) 0 10px 24px  (--shadow-2: the lift)
//
// After: the failed bubble is red again in both themes, every clickable bubble
// lifts in both themes, and the running card lifts exactly like the finished
// ones beside it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const raw = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
const LIGHT = ':root[data-theme="light"] ';

/**
 * Every rule in the sheet, by brace depth rather than by regex.
 *
 * A flat `\{([^}]*)\}` scan desyncs on the first `@keyframes` — its nested
 * blocks are read as top-level rules and everything after them lands under the
 * wrong selector. That is not a hypothetical: the first draft of this sweep
 * reported `.agent-node:hover` as absent from the sheet, which is how the trap
 * announced itself.
 */
function scan(): { sel: string; body: string; order: number }[] {
  const out: { sel: string; body: string; order: number }[] = [];
  const stack: string[] = [];
  let buf = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") { stack.push(buf.trim()); buf = ""; }
    else if (c === "}") {
      const sel = stack.pop();
      if (sel && !sel.startsWith("@")) {
        for (const one of sel.split(",").map(s => s.trim()).filter(Boolean)) {
          out.push({ sel: one, body: buf, order: out.length });
        }
      }
      buf = "";
    } else buf += c;
  }
  return out;
}
const RULES = scan();
const shadowOf = (body: string) => {
  const m = /(?:^|[;\s])box-shadow\s*:\s*([^;]+)/.exec(body);
  return m ? m[1].trim() : null;
};
/** The winning box-shadow written for exactly this selector, or null. */
const shadow = (sel: string) => {
  const hits = RULES.filter(r => r.sel === sel).map(r => shadowOf(r.body)).filter(Boolean) as string[];
  return hits.length ? hits[hits.length - 1] : null;
};
const orderOf = (sel: string) => RULES.find(r => r.sel === sel && shadowOf(r.body))?.order ?? -1;
/**
 * Split a box-shadow into its layers at top-level commas only.
 *
 * By paren DEPTH, not by lookahead: a layer can read
 * `var(--cat-accent, rgba(15,23,42,0.14))`, whose commas are two levels down,
 * and the one-level lookahead popover-shadows-876 uses cuts that in half.
 */
const layers = (v: string) => {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const c of v) {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
const geometry = (v: string) => layers(v).map(l => l.replace(/rgba?\([^)]*\)|var\([^)]*\)|currentColor/gi, "").trim());
const alphaOf = (v: string) => { const m = /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(v); return m ? +m[1] : 1; };
const BLACK = /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/;
const lightToken = (name: string) => {
  const block = /:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(css)!;
  return new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(block[1])![1].trim();
};

describe("the failed tool bubble is red on the light theme too (#1025)", () => {
  const dark = shadow(".tool-burst.status-err")!;
  const light = shadow(`${LIGHT}.tool-burst.status-err`);

  it("has a shadow at all, rather than only a border", () => {
    // The whole of the bug: the light rule redid `border-color` and nothing
    // else, so the base rule's neutral slate won on specificity.
    expect(light, "no light shadow, so a failure wears the success's elevation").not.toBeNull();
  });

  it("keeps the dark rule's geometry — a 1px ring and a 12px glow", () => {
    expect(light, "no light shadow to compare").not.toBeNull();
    expect(layers(light!)).toHaveLength(2);
    expect(geometry(light!)).toEqual(geometry(dark));
  });

  it("is drawn in red, not in slate and not in black", () => {
    expect(light, "no light shadow to colour").not.toBeNull();
    // `--err` in this theme is the deep red the light border already uses;
    // a slate shadow here would be the bug with extra steps.
    expect(light).not.toMatch(BLACK);
    for (const layer of layers(light!)) expect(layer, layer).toMatch(/rgba\(185,\s*28,\s*28,/);
  });

  it("outranks the base rule that beat it, and is written after it", () => {
    // (0,4,0) against (0,3,0) — but the order is asserted too, because the
    // base and the hover were EQUAL on specificity and order was the whole
    // difference between them.
    expect(orderOf(`${LIGHT}.tool-burst.status-err`)).toBeGreaterThan(orderOf(`${LIGHT}.tool-burst`));
  });
});

describe("a clickable bubble lifts on the light theme too (#1025)", () => {
  const dark = shadow(".tool-burst.clickable:hover")!;
  const light = shadow(`${LIGHT}.tool-burst.clickable:hover`);

  it("has a light rule, so `transition: box-shadow` animates something", () => {
    expect(light, "hover resolved to the resting shadow, so the transition was a no-op").not.toBeNull();
  });

  it("keeps the dark lift's geometry, in slate no heavier than --shadow-2", () => {
    expect(light, "no light hover shadow to compare").not.toBeNull();
    expect(geometry(light!)).toEqual(geometry(dark));
    expect(light).not.toMatch(BLACK);
    const ceiling = alphaOf(lightToken("--shadow-2"));
    for (const layer of layers(light!)) expect(alphaOf(layer), layer).toBeLessThanOrEqual(ceiling);
  });

  it("still beats the failed bubble's own colour, the way the dark pair does", () => {
    // Hover is a thing the user is doing NOW and outranks what the bubble is:
    // (0,5,0) against (0,4,0) here, (0,3,0) against (0,2,0) in the dark sheet.
    expect(orderOf(`${LIGHT}.tool-burst.clickable:hover`))
      .toBeGreaterThan(orderOf(`${LIGHT}.tool-burst`));
  });
});

describe("the cluster label keeps its hover ring on the light theme (#1025)", () => {
  it("draws the currentColor outline the dark hover draws", () => {
    // Same shape as the bubble: `:root[data-theme="light"] .cluster-label` is
    // (0,3,0) against the hover's (0,2,0), so the light hover kept the RESTING
    // 1px/4px shadow — measured as `rgba(15,23,42,0.08) 0 1px 4px` under the
    // pointer. The light hover rule existed; it only said `filter`.
    const light = shadow(`${LIGHT}.cluster-label:hover`);
    expect(light, "the light hover rule declares no shadow").not.toBeNull();
    expect(light).toMatch(/currentColor/);
    expect(light).not.toMatch(BLACK);
    expect(geometry(light!)).toEqual(geometry(shadow(".cluster-label:hover")!));
  });
});

describe("the running card lifts like every other card (#1025)", () => {
  it("declares no box-shadow of its own, in either theme", () => {
    // Both declarations were byte-identical to the rule they sat under, so
    // neither changed the resting card. Their only effect was to outrank the
    // hover — (0,2,0) later than `.agent-node:hover`'s (0,2,0) in the dark
    // sheet, and (0,4,0) against it in the light one, which wins whatever the
    // order. Deleting them restores the lift in both themes and changes
    // nothing else, because the base rule supplies --shadow-1 already.
    expect(shadow(".agent-node.state-active")).toBeNull();
    expect(shadow(`${LIGHT}.agent-node.state-active`)).toBeNull();
  });

  it("leaves the base and the hover as the only two elevations a card has", () => {
    expect(shadow(".agent-node")).toBe("var(--shadow-1)");
    expect(shadow(".agent-node:hover")).toBe("var(--shadow-2)");
    // And the state rules still say what they are there to say.
    expect(RULES.some(r => r.sel === ".agent-node.state-active" && /border-color/.test(r.body))).toBe(true);
  });
});

describe("no state variant is left behind when its base gets a light shadow (#1025)", () => {
  it("answers the light theme for every variant of a base the light theme re-shadows", () => {
    // THE RULE THAT WAS BROKEN, stated so it cannot break again. When the light
    // block re-declares a shadow for a bare base selector, that rule outranks
    // every one-class state variant of the same element — so each variant that
    // draws its OWN shadow in the dark sheet needs a light answer, or it
    // silently inherits the neutral one. `.status-inflight` had one and
    // `.status-err` did not, which is the entire bug, and nothing in the suite
    // could see the difference.
    //
    // Two exemptions, both principled:
    //   - `box-shadow: none` is a removal; the light base removing less than
    //     nothing is not a state that exists.
    //   - a variant whose shadow is byte-identical to the base's is restating
    //     it for legibility (`.tool-burst.status-done` does this deliberately,
    //     and its comment says why), so the light base is already its answer.
    // Descendants are not variants: `.tool-burst .tb-spin` is a different
    // element inside the bubble and inherits nothing from this rule.
    const missing: string[] = [];
    for (const base of RULES.filter(r => r.sel.startsWith(LIGHT) && shadowOf(r.body))) {
      const bare = base.sel.slice(LIGHT.length);
      if (!/^[.\w-]+$/.test(bare)) continue;
      const baseDark = shadow(bare);
      for (const v of RULES) {
        if (v.sel === bare || v.sel.startsWith(LIGHT) || !v.sel.startsWith(bare)) continue;
        if (v.sel.length === bare.length || /\s/.test(v.sel)) continue;
        const own = shadowOf(v.body);
        if (!own || own === "none" || own === baseDark) continue;
        if (shadow(LIGHT + v.sel) === null) missing.push(`${v.sel} (under ${base.sel})`);
      }
    }
    expect(missing, `no light answer for: ${missing.join(", ")}`).toEqual([]);
  });
});
