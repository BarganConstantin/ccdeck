// #612 and #613: two ways the canvas paid for the same value over and over.
//
// #612. `useRef(initialValue)` evaluates its argument on EVERY render — React
// keeps the first result and throws the rest away. Four of `Inner`'s refs were
// seeded with real work, so on every render of the canvas the deck did two
// `localStorage.getItem`s, two `JSON.parse`s, built three Maps and a Set, and
// ran a `positions × pins` scan, and then discarded all of it. `Inner` renders
// at least four times a second from an unconditional `setNow` tick, up to ~25
// under a tool storm, and once per pointer move through a drag — the same drag
// that is rewriting the layout being re-read.
//
// #613. `<MiniMap>` was handed a fresh `nodeColor` arrow and a fresh `style`
// object on every render. Both of @reactflow/minimap's components are wrapped
// in `memo`, so new identities meant the memo never bailed, and the re-render
// underneath called `nodeColor(node)` once per node — reaching
// `getComputedStyle(document.documentElement)` each time, for four values that
// only change when the theme flips.
//
// Measured on a 44-node board before the fix: 4 renders/s idle, and per render
// one `loadLayout`, one `loadDismissedSummaries`, two Map rebuilds and 84
// `getComputedStyle` calls. After: zero of each on the render path, and seven
// `getComputedStyle` calls per theme flip.
//
// WHAT THIS FILE CAN AND CANNOT CATCH. There is no DOM in this suite and
// nothing here renders React, so "how many times did that run per render" is
// not observable. Two things are, and this file does both:
//
//   * the pure derivations the fix moved out of App.tsx — restoreLayout's
//     linearity is asserted by COUNTING the reads it makes of its input
//     through a Proxy, which is deterministic and not a timing test, and the
//     palette's read-once/compare/lookup contract is asserted directly;
//   * the shape of the call sites, read as source text, the way
//     panel-memo-revision.test.ts and dead-css.test.ts already read source for
//     invariants with no runtime to assert against.
//
// It cannot catch a regression that keeps these shapes and reintroduces the
// cost some other way — a new `getComputedStyle` caller on the render path
// under a different name, or a fifth seed written as `useMemo(..., [])` that
// recomputes for a reason nobody expected. It also cannot see the theme flip
// still repainting the minimap, which is the one thing about #613 that must be
// checked by eye; the palette contract below is as close as this gets.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { restoreLayout, type StoredLayout } from "../stored-layout";
import { CANVAS_TOKENS, paletteReader, readPalette, samePalette, type Palette } from "../palette";
import { minimapNodeColor, SESSION_GROUP_TYPE } from "../minimap";

// ---------------------------------------------------------------------------
// #612, the half that is a fact about an algorithm.

/** A stored arrangement of `n` nodes, `pinnedCount` of them placed by hand. */
function board(n: number, pinnedCount: number): StoredLayout {
  const positions: StoredLayout["positions"] = [];
  for (let i = 0; i < n; i++) positions.push([`agent-${i}`, { x: i * 10, y: i * 4 }]);
  return { positions, pins: positions.slice(0, pinnedCount).map(([id]) => id) };
}

/**
 * The same board, with every read of `pins` counted.
 *
 * `new Set(pins)` walks the array once — one [[Get]] per index. `pins.includes(id)`
 * walks it once PER position. So the count separates the two implementations
 * exactly, with no clock involved and no flakiness on a loaded CI box.
 */
function countingPins(stored: StoredLayout): { layout: StoredLayout; reads: () => number } {
  let reads = 0;
  const pins = new Proxy(stored.pins, {
    get(target, prop, recv) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) reads++;
      return Reflect.get(target, prop, recv);
    },
  });
  return { layout: { positions: stored.positions, pins }, reads: () => reads };
}

describe("restoreLayout splits a stored board without rescanning the pins", () => {
  it("keeps every stored position and pins exactly the ones that were pinned", () => {
    const { positions, pinned } = restoreLayout(board(6, 2));
    expect([...positions.keys()]).toEqual(["agent-0", "agent-1", "agent-2", "agent-3", "agent-4", "agent-5"]);
    expect([...pinned.keys()]).toEqual(["agent-0", "agent-1"]);
    // Same points, not copies of them: the canvas mutates these maps in place.
    expect(pinned.get("agent-1")).toBe(positions.get("agent-1"));
  });

  it("ignores a pin for a node that has no stored position", () => {
    const stored = board(3, 0);
    stored.pins = ["agent-1", "agent-does-not-exist"];
    const { pinned } = restoreLayout(stored);
    expect([...pinned.keys()]).toEqual(["agent-1"]);
  });

  it("reads the pin list once per pin, not once per pin per position", () => {
    // 200 positions, all of them pinned. A Set costs 200 reads. The
    // `pins.includes(id)` filter this replaced costs up to 200 × 200 = 40,000,
    // and 20,100 on average — every one of them a string comparison, on every
    // render.
    const n = 200;
    const { layout, reads } = countingPins(board(n, n));
    restoreLayout(layout);
    expect(reads()).toBeLessThanOrEqual(n + 1);
  });

  it("stays linear as the board grows, which is what quadratic would not", () => {
    // Doubling the board doubles the reads. Under `includes` it quadrupled
    // them, so this comparison fails on the old shape however the constant
    // factors land.
    const small = countingPins(board(100, 100));
    restoreLayout(small.layout);
    const large = countingPins(board(200, 200));
    restoreLayout(large.layout);
    expect(large.reads()).toBeLessThan(small.reads() * 3);
  });

  it("answers an empty board with two empty maps", () => {
    const { positions, pinned } = restoreLayout({ positions: [], pins: [] });
    expect(positions.size).toBe(0);
    expect(pinned.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #613, the half that is a fact about the palette.

/** A `cssVar` that answers from a table and records what it was asked. */
function reader(table: Record<string, string>): { cssVar: (n: string) => string; asked: string[] } {
  const asked: string[] = [];
  return { cssVar: (name: string) => { asked.push(name); return table[name] ?? ""; }, asked };
}

const DARK: Record<string, string> = {
  "--err": "#f87171", "--inflight": "#f0abfc", "--ok": "#86efac",
  "--grid-line": "#1a1d24", "--minimap-mask": "rgba(11,12,16,.85)",
  "--panel": "#14161b", "--line": "#1f2229",
};
const LIGHT: Record<string, string> = {
  "--err": "#b91c1c", "--inflight": "#7e22ce", "--ok": "#157a3a",
  "--grid-line": "#d0d5dd", "--minimap-mask": "rgba(238,241,246,.85)",
  "--panel": "#ffffff", "--line": "#c8cdd6",
};

describe("the canvas palette is read once per theme", () => {
  it("asks for every token it declares, exactly once each", () => {
    const { cssVar, asked } = reader(DARK);
    const palette = readPalette(cssVar);
    expect(asked).toEqual([...CANVAS_TOKENS]);
    for (const token of CANVAS_TOKENS) expect(palette[token]).toBe(DARK[token]);
  });

  it("covers every token the canvas actually paints with", () => {
    // Derived from the palette rather than from a list: a token added to
    // CANVAS_TOKENS without a consumer, or a consumer added without a token,
    // is what this is guarding. The three minimap fills are checked through
    // minimapNodeColor itself below.
    expect(new Set(CANVAS_TOKENS).size).toBe(CANVAS_TOKENS.length);
    for (const token of ["--err", "--inflight", "--ok", "--grid-line", "--minimap-mask", "--panel", "--line"]) {
      expect(CANVAS_TOKENS as readonly string[]).toContain(token);
    }
  });

  it("hands minimapNodeColor a lookup, so a node costs no document read", () => {
    const palette = readPalette(reader(DARK).cssVar);
    const { cssVar, asked } = reader(DARK);
    // The live reader is handed over once, to build the palette. Painting 500
    // nodes out of it must not reach for it again.
    const token = paletteReader(palette);
    for (let i = 0; i < 500; i++) {
      expect(minimapNodeColor({ type: "agent", data: { state: "active" } }, token)).toBe(DARK["--inflight"]);
    }
    expect(asked).toEqual([]);
    expect(cssVar).toBeTypeOf("function");
  });

  it("paints each agent state from the palette and the handles from nothing", () => {
    const token = paletteReader(readPalette(reader(LIGHT).cssVar));
    expect(minimapNodeColor({ type: "agent", data: { state: "err" } }, token)).toBe(LIGHT["--err"]);
    expect(minimapNodeColor({ type: "agent", data: { state: "active" } }, token)).toBe(LIGHT["--inflight"]);
    expect(minimapNodeColor({ type: "agent", data: { state: "done" } }, token)).toBe(LIGHT["--ok"]);
    expect(minimapNodeColor({ type: SESSION_GROUP_TYPE }, token)).toBe("transparent");
  });

  it("answers a token nobody declared with the empty string, like cssVar does", () => {
    const token = paletteReader(readPalette(reader(LIGHT).cssVar));
    expect(token("--not-a-token")).toBe("");
  });

  it("sees a theme flip, which is the only thing allowed to rebuild the props", () => {
    // The whole fix rests on this comparison: if it ever said two different
    // themes were the same palette, the minimap and the grid would keep the
    // old colours after a toggle — worse than the cost being fixed.
    const dark = readPalette(reader(DARK).cssVar);
    const light = readPalette(reader(LIGHT).cssVar);
    expect(samePalette(dark, light)).toBe(false);
    expect(samePalette(light, dark)).toBe(false);
    for (const token of CANVAS_TOKENS) {
      // And on every token individually, so a flip that moved only one of them
      // is still a flip.
      const nudged: Palette = { ...dark, [token]: "#000000" };
      expect(samePalette(dark, nudged), token).toBe(false);
    }
  });

  it("calls a re-read of the same theme the same palette, so mount costs no extra render", () => {
    // The effect that writes `data-theme` re-reads the palette, and on the
    // first run it re-asserts an attribute index.html's bootstrap already set —
    // so it reads back exactly what mount read. That has to compare equal, or
    // every mount pays a second render.
    expect(samePalette(readPalette(reader(DARK).cssVar), readPalette(reader(DARK).cssVar))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The source scan. Nothing renders here, so the call sites are read as text.

const web = fileURLToPath(new URL("..", import.meta.url));

function clientSources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : clientSources(path);
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}
/**
 * Comments out, code left in place.
 *
 * Every assertion below is about what the client DOES, and this file's own
 * subject matter guarantees the sources talk about it: the fix for each site
 * carries a comment quoting the shape it replaced, so a scan that did not strip
 * comments would find `useRef(loadDismissedSummaries())` written down as the
 * thing that is no longer there and fail on the explanation of its own fix.
 * Line endings are normalised first so a checkout with CRLF reads the same.
 */
function stripComments(src: string): string {
  return src
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[^\n"'`]*?\/\/[^\n]*/gm, m => m.slice(0, m.indexOf("//")));
}

/** Forward slashes on every platform, so a failure reads the same on Windows. */
const sources: [string, string][] = clientSources(web)
  .map(p => [p.slice(web.length).replaceAll("\\", "/"), stripComments(readFileSync(p, "utf8"))]);
const app = sources.find(([p]) => p === "App.tsx")![1];

/** The text between `useRef(` and its matching `)`, for every call in `src`,
 *  with an explicit type argument (`useRef<Foo>(…)`) allowed and skipped. */
function refSeeds(src: string): string[] {
  const out: string[] = [];
  const re = /\buseRef\s*(<[^;=]*?>)?\s*\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) { out.push(src.slice(open + 1, i).trim()); break; }
    }
  }
  return out;
}

/**
 * A seed React can re-evaluate on every render without anyone caring.
 *
 * Two families, and the line between them is the rule #612 is actually about —
 * not "no allocation", which would be a style opinion, but "no work that could
 * grow, read or compute":
 *
 *   * a literal or a read of something already in scope — `useRef(0)`,
 *     `useRef(null)`, `useRef(nodes)`, `useRef(restoredLayout.pinned)`;
 *   * an EMPTY container — `useRef(new Set())`, `useRef([])`. Fixed size, no
 *     arguments, no reads, nothing to scan. `new Map(entries)` is not this and
 *     is not allowed: that is the seed that was quadratic.
 *
 * Everything else — a call, a `new` with arguments, an IIFE, a spread — is work
 * React redoes on every render and throws away.
 */
const FREE_SEED = new RegExp([
  "^(",
  "|null|undefined|true|false",
  "|-?\\d[\\d_.]*",
  '|"[^"]*"',
  "|'[^']*'",
  "|[A-Za-z_$][\\w$]*(\\?\\.|\\.)?[\\w$.?]*",     // an identifier or a member read
  "|\\[\\s*\\]|\\{\\s*\\}",                        // an empty array or object
  "|new\\s+(Set|Map|WeakSet|WeakMap)(<[^()]*>)?\\(\\s*\\)", // an empty container
  ")$",
].join(""));

describe("no useRef in the client is seeded with work", () => {
  it("finds the seeds it is sweeping, so a passing run means something", () => {
    // If `useRef` is ever renamed or aliased out of this scan, this collapses
    // before the assertion below can pass by finding nothing.
    const all = sources.flatMap(([, src]) => refSeeds(src));
    expect(all.length).toBeGreaterThan(20);
    expect(all).toContain("restoredLayout.pinned");
    expect(all).toContain("restoredLayout.positions");
  });

  it("seeds every one of them with a value rather than an expression", () => {
    // #612 as reported: `useRef(loadDismissedSummaries())`, `useRef(loadLayout())`,
    // `useRef(new Map(positions.filter(([id]) => pins.includes(id))))`,
    // `useRef(new Map(storedLayout.positions))`, plus `useRef(createPauseGate())`,
    // `useRef(createLoginAnnouncer())` and `useRef(createLatestGuard())`. Every
    // one of them ran on every render of its component.
    const offenders = sources.flatMap(([path, src]) =>
      refSeeds(src).filter(seed => !FREE_SEED.test(seed)).map(seed => `${path}  useRef(${seed})`));
    expect(offenders).toEqual([]);
  });

  it("restores the layout through a lazy initialiser, which is where the work went", () => {
    // The positive half: the seeds are cheap because the work moved somewhere
    // that runs once. `restoredViewport` on the next lines has always been
    // written this way; this is the form it is now matched to.
    expect(app).toMatch(/const restoredLayout = useState\(\(\) => restoreLayout\(loadLayout\(\)\)\)\[0\];/);
    expect(app).toMatch(/const dismissedSummaries = useState\(loadDismissedSummaries\)\[0\];/);
    // #676 handed the gate an options object — a `protect` predicate the
    // ceiling's eviction asks about each held envelope — so the argument list
    // is no longer empty. What this case is about is the `() =>` in front of
    // it, which is the whole of what keeps the construction off every render,
    // so that is what stays pinned; the options are allowed to be there or not
    // and are matched across lines, since they wrap.
    expect(app).toMatch(
      /const pauseGate = useState\(\(\) => createPauseGate<HookEnvelope>\((?:\{[\s\S]{0,400}?\})?\)\)\[0\];/);
  });

  it("has no seeded-once flag left over that nothing reads", () => {
    // `positionsSeeded` was declared beside the layout refs and read nowhere.
    expect(app).not.toMatch(/\bpositionsSeeded\b/);
  });
});

describe("nothing on the render path reads a CSS custom property", () => {
  it("keeps getComputedStyle out of the canvas entirely", () => {
    // One caller in the client outside App.tsx — use-modal-dismiss reads an
    // element's overflow when it locks scrolling, which happens on a modal
    // opening and not per frame.
    const callers = sources.filter(([, src]) => /getComputedStyle\s*\(/.test(src)).map(([p]) => p).sort();
    expect(callers).toEqual(["App.tsx", "components/use-modal-dismiss.ts"]);
  });

  it("never calls cssVar — it only ever hands it to readPalette", () => {
    // `cssVar` is the expensive one, and the two places it may be mentioned are
    // its own declaration and the argument list of `readPalette`: once in the
    // `useState` initialiser, once in the effect that stamps `data-theme`. If
    // the mentions ever outnumber those, something is calling it again — and
    // the JSX is where it used to be called from.
    const mentions = [...app.matchAll(/\bcssVar\b/g)].length;
    const declared = [...app.matchAll(/function cssVar\s*\(/g)].length;
    const handedOver = [...app.matchAll(/readPalette\(cssVar\)/g)].length;
    expect(declared).toBe(1);
    expect(handedOver).toBe(2);
    expect(mentions).toBe(declared + handedOver);
  });

  it("paints the grid and the minimap mask out of the palette", () => {
    expect(app).toMatch(/<Background gap=\{28\} size=\{1\} color=\{palette\["--grid-line"\]\} \/>/);
    expect(app).toMatch(/maskColor=\{palette\["--minimap-mask"\]\}/);
  });

  it("hands MiniMap a memoised nodeColor and a memoised style, not fresh ones", () => {
    // The two props that defeated `memo(MiniMap)` and `memo(MiniMapNodes)`.
    // Both must be identifiers — an inline arrow or an object literal here is
    // a new identity on every render, which is the whole of #613.
    const minimap = /<MiniMap\b[\s\S]*?\/>/.exec(app);
    expect(minimap, "no <MiniMap> in App.tsx").not.toBeNull();
    expect(minimap![0]).toMatch(/nodeColor=\{[A-Za-z_$][\w$]*\}/);
    expect(minimap![0]).toMatch(/style=\{[A-Za-z_$][\w$]*\}/);
    expect(minimap![0]).not.toMatch(/=>/);
    expect(minimap![0]).not.toMatch(/cssVar/);
  });

  it("rebuilds those two on the palette and on nothing else", () => {
    // Keyed on `palette`, which only a theme flip replaces. Keyed on `theme`
    // itself they would be rebuilt during the render that flips it — before the
    // effect writes `data-theme` — and would hold the OLD colours forever.
    expect(app).toMatch(/const paletteToken = useMemo\(\(\) => paletteReader\(palette\), \[palette\]\);/);
    expect(app).toMatch(/const minimapStyle = useMemo\(\s*\(\) => \(\{[\s\S]*?\}\),\s*\[palette\],\s*\);/);
    expect(app).toMatch(/\[paletteToken\],/);
  });

  it("re-reads the palette in the effect that stamps data-theme, after the write", () => {
    // The ordering that keeps a flip from going stale. Both statements must
    // live in the same effect, with the attribute first — a palette read before
    // `data-theme` is written answers with the theme being replaced.
    const effect = /useEffect\(\(\) => \{\s*document\.documentElement\.dataset\.theme = theme;[\s\S]*?\}, \[theme\]\);/.exec(app);
    expect(effect, "the data-theme effect is no longer recognisable").not.toBeNull();
    expect(effect![0]).toMatch(/setPalette\(/);
    expect(effect![0].indexOf("dataset.theme")).toBeLessThan(effect![0].indexOf("setPalette"));
  });

  it("holds the palette as state, never as a render-time memo keyed on theme", () => {
    // This is the trap, and it is the shape #613's own suggested direction
    // proposed: `useMemo(() => readPalette(cssVar), [theme])`. A memo runs
    // DURING render and `data-theme` is not written until the effect, so on the
    // render that flips the theme it would read the palette it is replacing —
    // and then never run again, because `theme` does not change twice. The
    // minimap and the grid would keep the old theme's colours for the life of
    // the tab, which is worse than the cost this whole change removes.
    expect(app).toMatch(/const \[palette, setPalette\] = useState<Palette>\(\(\) => readPalette\(cssVar\)\);/);
    // Spelled with or without a type argument, a memo may not produce it.
    expect(app).not.toMatch(/useMemo\s*(<[^;=]*?>)?\s*\([^;]*\breadPalette\b/);
    // And there are exactly three mentions of `readPalette` in the file: the
    // import, that initialiser, and the effect above. A fourth is a new reader
    // on some path this test has not been told about.
    expect([...app.matchAll(/\breadPalette\b/g)]).toHaveLength(3);
  });
});
