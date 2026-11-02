// V4's motion rules: one set of numbers, so a change is made once. Every
// `transition` and `animation` declaration in src/web/**/*.css names its
// durations, delays and curves by token (tokens.css: --dur-*, --delay-*,
// --ease, --ease-stage), and the sheet that defines them is the only one that
// spells `cubic-bezier(`. What lives apart (the Radar, the Local network map,
// Claude FM, the guides' art, confetti, the loops, the Board's own rules until
// its PR) is named in ALLOWLIST below with the reason, and nowhere else: a new
// literal that is not in this list fails here, and an entry whose declaration
// is gone fails here too, so the list cannot rot.
//
// The rules the scan enforces:
//   - no ms / s literal in a duration or delay (0 is fine), except on an
//     `infinite` animation, whose period is its own (loops are not tokens);
//   - no `cubic-bezier(` anywhere but tokens.css;
//   - `ease`, `ease-in`, `ease-out` are --ease now;
//   - `ease-in-out` only on an `infinite` animation;
//   - `linear` only where the allowlist says (a spinner, a progress drain, a
//     sweep); `steps()` is free.
// And the catch-all that makes a surface opened by a key instant exists, in
// its `:not(:root)` form (input-modality.ts sets the flag on the root for any
// key, and the root flag must not freeze the deck).
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB = fileURLToPath(new URL("..", import.meta.url));

/** `needle` is a short substring of "prop: value" (whitespace collapsed);
 *  "*" allows the whole file. */
interface Allowed { file: string; needle: string; why: string }
const ALLOWLIST: Allowed[] = [
  // ---- things that live apart (V4's motion rules) ----
  { file: "styles/claude-fm.css", needle: "*", why: "Claude FM companion scene: characters, walk, ball, rope. Own numbers and curves" },
  { file: "styles/lan-network-map.css", needle: "*", why: "Local network map motion lives apart" },
  { file: "styles/guides.css", needle: "ga-", why: "guide art loops and the figure's own choreography" },
  { file: "styles/guides.css", needle: "animation-delay: 1.2s", why: "guide art loop stagger (ga-ping)" },
  { file: "styles/lan-setup.css", needle: "lan-draw-", why: "the Local network setup diagram draws itself in: art, lives with the network map" },
  { file: "styles/terminal-stage.css", needle: "ts-scan", why: "terminal scan sweep lives apart" },
  { file: "styles/terminal-stage.css", needle: "opacity 70ms linear", why: "terminal stage host fade: 150 in / 70 out live apart" },
  { file: "styles/terminal-stage.css", needle: "ts-body-in 150ms", why: "terminal stage host fade-in 150 lives apart" },
  { file: "styles/terminal-stage.css", needle: "transition: opacity 150ms", why: "terminal stage host fade-in 150 lives apart" },
  { file: "styles/terminal-stage.css", needle: "var(--dur-fast) 300ms", why: "the scan appears after a 300ms hold-off, with the scan it belongs to" },
  { file: "styles/add-account.css", needle: "aa-burst", why: "confetti lives apart: 1100, mirrored by Confetti.tsx LIFETIME_MS" },
  { file: "styles/add-account.css", needle: "aa-orbit-spin 760ms linear", why: "sign-in orbit spinner: linear by rule, own period" },
  { file: "styles/add-account.css", needle: "animation-duration: 2400ms", why: "the orbit while the deck waits on the browser: a slower loop" },
  { file: "styles/menus.css", needle: "settings-jumped", why: "settings-jumped is a Land and lives apart, 1500 (use-settings-jump.ts JUMP_MARK_MS)" },
  { file: "styles/browser-watch.css", needle: "bw-find-in 900ms", why: "a finding's wash-out is a Land (one authored moment) like settings-jumped" },
  { file: "styles/tool-audit.css", needle: "tt-sweep 640ms", why: "the donut draws itself once when the report mounts: a Land" },
  { file: "styles/radio.css", needle: "radioSignalOut", why: "radio signal loop lives apart" },
  { file: "styles/radio.css", needle: "animation-delay: 180ms", why: "radio signal loop stagger" },
  { file: "styles/radio.css", needle: "animation-delay: 360ms", why: "radio signal loop stagger" },
  { file: "styles/usage-history.css", needle: "animation-delay: 350ms", why: "reading-transfer loop stagger" },
  { file: "styles/usage-history.css", needle: "animation-delay: 700ms", why: "reading-transfer loop stagger" },
  { file: "styles/read-activity.css", needle: "animation-duration: 1200ms", why: "processes reading loop: its own period" },
  // ---- spinners, progress and sweeps: linear by rule ----
  { file: "styles/accounts-panel.css", needle: "spin 900ms linear", why: "the refresh arrow: 900, linear" },
  { file: "styles/dialogs.css", needle: "spin 900ms linear", why: "the refresh arrow: 900, linear" },
  { file: "styles/lan-setup.css", needle: "spin 900ms linear", why: "the refresh arrow: 900, linear" },
  { file: "styles/panel-glyph.css", needle: "spin 900ms linear", why: "the refresh arrow: 900, linear" },
  { file: "styles/integrations.css", needle: "ta-spin 900ms linear", why: "the refresh arrow: 900, linear" },
  { file: "styles/tool-audit.css", needle: "ta-spin 900ms linear", why: "the refresh arrow: 900, linear" },
  { file: "styles/accounts-details.css", needle: "ap-disarm 4000ms linear", why: "arm-to-confirm countdown: a progress drain, linear, as long as the arm window" },
  { file: "styles/accounts-manage.css", needle: "ap-disarm 4000ms linear", why: "arm-to-confirm countdown: a progress drain" },
  { file: "styles/dialogs.css", needle: "ap-disarm 4000ms linear", why: "arm-to-confirm countdown: a progress drain" },
  { file: "styles/board-navigator.css", needle: "dashflow", why: "Board PR: wire flow (dashflow, linear)" },
  { file: "styles/react-flow.css", needle: "dashflow", why: "Board PR: wire flow (dashflow, linear)" },
  { file: "styles/search-and-banners.css", needle: "dashflow", why: "Board PR: wire flow (dashflow, linear)" },
  { file: "styles/tool-bursts.css", needle: "dashflow", why: "Board PR: wire flow (dashflow, linear)" },
  { file: "styles/loader.css", needle: "loader-in var(--dur-fast) linear", why: "the Loader's own fade-in (v4-loader.test.ts pins it)" },
  // ---- the spec'd reduced-motion crossfades of 140 ----
  { file: "styles/canvas-motion.css", needle: "fadeIn 140ms ease both", why: "reduced motion: the stage board's fade on open, 140 (spec'd)" },
  { file: "styles/accounts-details.css", needle: "fadeIn 140ms ease-out", why: "reduced motion: the modal's crossfade, 140 (reduced-motion-reach.test.ts)" },
  { file: "styles/left-column.css", needle: "opacity 140ms ease", why: "reduced motion: the side panels' crossfade, 140 (spec'd)" },
  { file: "styles/left-column.css", needle: "var(--side-exit) linear", why: "a side panel's exit crossfade: linear opacity beside the --ease-stage travel; --side-exit is set per panel in JS" },
  { file: "styles/workspace.css", needle: "view-fade var(--dur-fast) linear", why: "Workspace reduced crossfade (v4-workspace-layout.test.ts pins it)" },
  // ---- Board PR (rules and the timers that mirror them) ----
  { file: "styles/search-and-banners.css", needle: "nodeExit", why: "Board PR: node exit, 600 (EXIT_ANIM_MS mirrors it)" },
  { file: "styles/search-and-banners.css", needle: "edgeExit", why: "Board PR: edge exit, 600 (EXIT_ANIM_MS mirrors it)" },
  { file: "styles/canvas-motion.css", needle: "canvas-fade-out", why: "Board PR: board node fade-out, 600" },
  { file: "styles/canvas-motion.css", needle: "transform 420ms", why: "Board PR: the push every node gets, 420 = BUBBLE_MS (push-handle-865.test.ts)" },
  { file: "styles/react-flow.css", needle: "transform 320ms", why: "Board PR: a node's move, 320, held equal to the session box's (session-clusters.css)" },
  { file: "styles/session-clusters.css", needle: "transform 320ms", why: "Board PR: the session box moves with its nodes, 320 (box-translate-864.test.ts)" },
  { file: "styles/react-flow.css", needle: "nodeSpawn", why: "Board PR: node spawn (nodeSpawn)" },
  { file: "styles/tool-bursts.css", needle: "bubble-", why: "Board PR: bubble-* (BUBBLE_MS mirrors them)" },
  { file: "styles/tool-bursts.css", needle: "mark-pop", why: "Board PR: tool mark pop" },
  { file: "styles/tool-bursts.css", needle: "emoji-wobble", why: "Board PR: emoji-wobble loop" },
  { file: "styles/canvas.css", needle: "rearrangeUndo", why: "Board PR: re-arrange undo strip (REARRANGE_UNDO_EXIT_MS mirrors it)" },
  { file: "styles/canvas.css", needle: "dragTrash", why: "Board PR: drag-to-trash target" },
  // ---- other holds ----
  { file: "styles/machine-panel.css", needle: "rail-out", why: "rail-out belongs to the Usage panel / Workspace PR" },
  { file: "styles/integrations.css", needle: "var(--ease) 300ms", why: "the skeleton's hold-off: 300ms before it shows, so a quick read never flashes (integrations-skeleton.test.ts)" },
];

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "__tests__") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) cssFiles(p, out);
    else if (p.endsWith(".css")) out.push(p);
  }
  return out.sort();
}

interface Decl { file: string; prop: string; value: string; text: string }
const decls: Decl[] = [];
const sources = new Map<string, string>();
for (const path of cssFiles(WEB)) {
  const file = relative(WEB, path).split("\\").join("/");
  const src = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  sources.set(file, src);
  const re = /(?:^|[\s;{])((?:transition|animation)(?:-[a-z-]+)?)\s*:\s*([^;}]*)/g;
  for (let m: RegExpExecArray | null; (m = re.exec(src)); ) {
    const value = m[2].replace(/\s+/g, " ").trim();
    decls.push({ file, prop: m[1], value, text: `${m[1]}: ${value}` });
  }
}

const allowed = (d: Decl): number =>
  ALLOWLIST.findIndex(a => a.file === d.file && (a.needle === "*" || d.text.includes(a.needle)));

/** What a declaration spells outside var(): the literals the rules forbid. */
function literals(d: Decl): string[] {
  const v = d.value.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, "VAR");
  const infinite = /\binfinite\b/.test(v);
  const found: string[] = [];
  for (const m of v.matchAll(/(?<![\w.-])(\d*\.?\d+)(ms|s)\b/g)) {
    if (parseFloat(m[1]) === 0) continue;
    if (!infinite) found.push(m[0]);
  }
  if (/cubic-bezier\(/.test(v)) found.push("cubic-bezier");
  for (const m of v.matchAll(/(?<![\w-])(ease-in-out|ease-in|ease-out|ease|linear)(?![\w-])/g)) {
    if (m[1] === "ease-in-out") { if (!infinite) found.push("ease-in-out on a one-shot"); }
    else found.push(m[1]);
  }
  return found;
}

describe("V4's motion rules: durations, delays and curves are tokens", () => {
  it("reads the sheets", () => {
    expect(decls.length).toBeGreaterThan(400);
  });

  it("no transition or animation spells a literal that the allowlist does not name", () => {
    const bad = decls.filter(d => allowed(d) < 0).map(d => ({ d, found: literals(d) })).filter(x => x.found.length);
    expect(bad.map(x => `${x.d.file}: ${x.d.text}  <= ${x.found.join(", ")}`)).toEqual([]);
  });

  it("every transition names its curve: one left out is the browser's `ease`, not --ease", () => {
    const curve = /(?<![\w-])(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)(?![\w-])|cubic-bezier\(|steps\(|var\(--ease/;
    const items = (v: string) => {
      const out: string[] = [];
      let depth = 0, start = 0;
      for (let i = 0; i < v.length; i++) {
        if (v[i] === "(") depth++;
        else if (v[i] === ")") depth--;
        else if (v[i] === "," && depth === 0) { out.push(v.slice(start, i)); start = i + 1; }
      }
      return [...out, v.slice(start)].map(s => s.trim());
    };
    const bare = decls
      .filter(d => d.prop === "transition" && !/^(none|inherit|initial|unset|var\(--[\w-]+\))$/.test(d.value))
      .flatMap(d => items(d.value).filter(i => i && !curve.test(i)).map(i => `${d.file}: ${i}`));
    expect(bare).toEqual([]);
  });

  it("every allowlist entry still matches a declaration that needs it", () => {
    const stale = ALLOWLIST.filter(a => !decls.some(d => d.file === a.file && (a.needle === "*" || d.text.includes(a.needle))));
    expect(stale.map(a => `${a.file}: ${a.needle}`)).toEqual([]);
  });

  it("every entry says why", () => {
    for (const a of ALLOWLIST) expect(a.why.length, `${a.file} ${a.needle}`).toBeGreaterThan(10);
  });

  it("cubic-bezier( is spelled in tokens.css and nowhere else, but where the allowlist names it", () => {
    const offenders: string[] = [];
    for (const [file, src] of sources) {
      if (file === "styles/tokens.css") continue;
      for (const d of decls.filter(x => x.file === file && /cubic-bezier\(/.test(x.value))) {
        if (allowed(d) < 0) offenders.push(`${file}: ${d.text}`);
      }
      // a curve outside any transition/animation declaration (a custom property, a rule)
      const all = (src.match(/cubic-bezier\(/g) ?? []).length;
      const inDecls = decls.filter(x => x.file === file).reduce((n, x) => n + (x.value.match(/cubic-bezier\(/g) ?? []).length, 0);
      if (all > inDecls) offenders.push(`${file}: ${all - inDecls} cubic-bezier( outside a transition/animation declaration`);
    }
    expect(offenders).toEqual([]);
  });

  it("tokens.css still defines the two curves and the seven durations", () => {
    const tokens = sources.get("styles/tokens.css")!;
    expect(tokens).toMatch(/--ease:\s*cubic-bezier\(0\.23, 1, 0\.32, 1\);/);
    expect(tokens).toMatch(/--ease-stage:\s*cubic-bezier\(0\.32, 0\.72, 0, 1\);/);
    for (const [name, ms] of [["fast", 120], ["exit", 150], ["base", 200], ["move", 240], ["stage-in", 280], ["stage-out", 200], ["slow", 400]] as const) {
      expect(tokens, name).toMatch(new RegExp(`--dur-${name}:\\s*${ms}ms;`));
    }
  });

  it("a surface that carries data-motion=instant itself stops animating, the root flag does not", () => {
    const tokens = sources.get("styles/tokens.css")!;
    expect(tokens).toMatch(/\[data-motion="instant"\]:not\(:root\),\s*\[data-motion="instant"\]:not\(:root\) \*:not\([^)]*\.loader[^)]*\)\s*\{\s*transition-duration:\s*0ms !important;\s*animation:\s*none !important;\s*\}/);
    // The loader and the --pulse-live marks are exempt: they show a wait.
    expect(tokens).toMatch(/\.loader, \.loader \*, \.state-mark, \.tb-spin/);
    // .sl-land clears itself on animationend, so cutting its animation would leave it lit for good.
    expect(tokens).toMatch(/\.loader, \.loader \*, \.state-mark, \.tb-spin, \.sl-land\)/);
    // No bare form anywhere: it would match the root flag input-modality.ts sets.
    for (const [file, src] of sources) {
      for (const m of src.matchAll(/^\s*\[data-motion="instant"\](?!:not\(:root\))[^{]*\{[^}]*!important/gm)) {
        throw new Error(`${file}: a catch-all on the bare data-motion flag would freeze the deck: ${m[0].trim()}`);
      }
    }
  });

  it("Quick open never animates", () => {
    const qo = sources.get("styles/quick-open.css")!;
    expect(qo).not.toMatch(/@keyframes qo-/);
    expect(decls.filter(d => d.file === "styles/quick-open.css" && d.prop === "animation").map(d => d.value).filter(v => v !== "none")).toEqual([]);
    expect(qo).not.toMatch(/\.closing/);
    // No motion at all: the esc chip neither eases nor presses.
    expect(decls.filter(d => d.file === "styles/quick-open.css" && d.prop === "transition").map(d => d.value).filter(v => v !== "none")).toEqual([]);
    expect(qo).not.toMatch(/\.qo-esc[^{]*:active/);
    expect(qo).not.toMatch(/transform\s*:\s*scale/);
  });

  it("a reduced-motion @starting-style answer comes after the @starting-style rule it answers", () => {
    const bad: string[] = [];
    for (const [file, src] of sources) {
      const blocks: { pos: number; reduced: boolean; selectors: string[] }[] = [];
      for (const m of src.matchAll(/@starting-style\s*\{/g)) {
        let depth = 1, i = m.index! + m[0].length;
        while (depth && i < src.length) { if (src[i] === "{") depth++; else if (src[i] === "}") depth--; i++; }
        const body = src.slice(m.index! + m[0].length, i - 1);
        const selectors = [...body.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap(r => r[1].split(",").map(s => s.replace(/\s+/g, " ").trim()));
        // enclosing @media: walk back to the unmatched `{` and read its head
        let reduced = false, d = 0;
        for (let j = m.index! - 1; j >= 0; j--) {
          if (src[j] === "}") d++;
          else if (src[j] === "{") {
            if (d === 0) {
              const head = src.slice(Math.max(src.lastIndexOf("}", j), src.lastIndexOf(";", j), 0), j);
              if (/prefers-reduced-motion/.test(head)) { reduced = true; break; }
            } else d--;
          }
        }
        blocks.push({ pos: m.index!, reduced, selectors });
      }
      for (const rm of blocks.filter(b => b.reduced)) {
        for (const later of blocks.filter(b => !b.reduced && b.pos > rm.pos)) {
          const shared = later.selectors.filter(s => rm.selectors.includes(s));
          if (shared.length) bad.push(`${file}: ${shared.join(" | ")} is answered above the rule it answers`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
