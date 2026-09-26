---
name: ccdeck
description: A live dashboard for Claude Code and Codex — dark-first, monospaced, instrument-panel calm.
colors:
  bg: "#0b0c10"
  bg-soft: "#0f1116"
  panel: "#14161b"
  line: "#1f2229"
  line-soft: "#1a1c22"
  text: "#d8dae0"
  text-secondary: "#9aa0ab"
  muted: "#7e828c"
  text-dim: "#7e828c"
  muted-dim: "#50535b"
  accent: "#7dd3fc"
  accent-dim: "#38bdf850"
  ok: "#86efac"
  warn: "#fcd34d"
  err: "#fca5a5"
  inflight: "#f0abfc"
  grid-line: "#1a1d24"
  cat-file: "#7dd3fc"
  cat-shell: "#fcd34d"
  cat-web: "#67e8f9"
  cat-agent: "#f0abfc"
  cat-task: "#86efac"
  cat-plan: "#c4b5fd"
  cat-mcp: "#5eead4"
  cat-other: "#94a3b8"
  usage-purple: "#c4b5fd"
  usage-blue: "#7dd3fc"
  usage-green: "#86efac"
  usage-amber: "#fcd34d"
  usage-red: "#fca5a5"
  usage-indigo: "#a5b4fc"
  usage-orange: "#fdba74"
  usage-zinc: "#94a3b8"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "13px"
    lineHeight: 1.45
  data:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    lineHeight: 1.45
  label:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "10px"
    lineHeight: 1.3
rounded:
  tag: "4px"
  ctl: "6px"
  panel: "8px"
  pill: "999px"
spacing:
  ctl-h: "30px"
  panel-inset: "14px"
  pad-x: "14px"
  flow-gutter: "15px"
  sl-card-gutter: "4px"
opacity:
  dim-off: 0.6
  dim-stale: 0.45
components:
  control:
    height: "{spacing.ctl-h}"
    backgroundColor: "color-mix(in srgb, var(--text) 7%, transparent)"
    textColor: "{colors.text}"
    rounded: "{rounded.ctl}"
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "14px"
  canvas-chrome:
    backgroundColor: "color-mix(in srgb, var(--panel) 60%, var(--bg))"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
  tag:
    backgroundColor: "color-mix(in srgb, var(--text) 7%, transparent)"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.tag}"
---

# ccdeck design system

Extracted from `src/web/styles.css` on 2026-09-26. The stylesheet is the single
source of truth — one file, 14.8k lines, with its reasoning written inline. **When
this file and the stylesheet disagree, the stylesheet is right and this file is
stale.**

## Overview

ccdeck is an instrument panel. Somebody glances at it because an agent stopped, or
leaves it open on a second monitor while work happens elsewhere. It is never the
thing being looked at on purpose for long.

Three consequences that decide everything else:

- **Calm by default, loud only for a real event.** Colour carries state, not
  decoration. A screen with nothing wrong on it is almost monochrome.
- **Dark is the default, light is a full peer.** `:root` is the dark ramp;
  `:root[data-theme="light"]` re-tunes every hue rather than inverting. Light is
  where contrast bugs live, because every terminal-adjacent colour assumes dark.
  There are exactly two themes — `Theme = "dark" | "light"` in `theme.ts` — and no
  third is planned.
- **Density over comfort.** 13px base, 30px controls, 10–12px labels. Eight
  sessions and forty nodes have to fit without scrolling.

Contrast is enforced by tests, not by taste: `contrast-floors.test.ts`,
`control-edges.test.ts` and `usage-series-contrast.test.ts` measure the shipped
token values against the surfaces they land on, in both themes. A new colour that
fails them is a failing build, not a review comment.

## Colors

**A missing `data-theme` means dark, by design.** The sheet's first selector is
`:root, :root[data-theme="dark"]`, so a light-theme user whose stored preference
arrives late sees a fully painted dark deck rather than an unstyled frame. The
attribute must therefore be written **before first paint**, which the bundle
cannot do — module scripts are deferred — so `index.html` carries a small inline
bootstrap that duplicates `resolveTheme`'s rule on purpose. `theme-first-paint.test.ts`
runs the inlined text against the real function so the two copies cannot drift.
Never move that logic into the bundle.

The frontmatter carries the **dark** ramp because `:root` is dark. The light ramp
below is equally normative for `[data-theme="light"]`.

| Token | Dark | Light | Job |
|---|---|---|---|
| `--bg` | `#0b0c10` | `#eef1f6` | The canvas. |
| `--bg-soft` | `#0f1116` | `#ffffff` | One step off the canvas. In light it is **deliberately identical to `--panel`** — white is the ceiling, so a third surface tier would be noise at 1.09:1. |
| `--panel` | `#14161b` | `#ffffff` | Panels, cards, modals. |
| `--line` | `#1f2229` | `#c8cdd6` | Panel edges, rules, separators. |
| `--line-soft` | `#1a1c22` | `#dde1e8` | The quieter rule. |
| `--text` | `#d8dae0` | `#0d1117` | Primary foreground. |
| `--text-secondary` | `#9aa0ab` | `#303845` | **Prose somebody reads**, as opposed to metadata they glance at. 6.89:1 on `--panel`. |
| `--muted` | `#7e828c` | `#4a5260` | Metadata. 4.70:1 on `--panel` in dark — two tenths above the AA floor, so it cannot be lowered. |
| `--text-dim` | `#7e828c` | `#5f6673` | Annotation. Shares `--muted` in dark because the dark ramp has no room for a third readable tier; light has the headroom and keeps a real step. |
| `--muted-dim` | `#50535b` | `#7c8493` | **Decorative tint only.** 2.35:1 — never put words a reader needs in it. |
| `--accent` | `#7dd3fc` | `#0369a1` | Interactive, live, focused. |
| `--ok` `--warn` `--err` | `#86efac` `#fcd34d` `#fca5a5` | `#157a3a` `#ad4e08` `#b91c1c` | Settled, attention, failed. |
| `--inflight` | `#f0abfc` | `#7e22ce` | A tool call in flight. The one hue that means *right now*. |

**Derived tiers, and why they are derived.** These are deliberately absent from
the frontmatter's `colors` map, because a primitive may not reference another
primitive and every one of them is mixed from a token. `--ctl-fill` and `--ctl-edge` are
mixed from `var(--text)`, not borrowed from a surface, and both themes declare
them identically. A tier derived from the foreground exists in both themes by
construction; one borrowed from `--bg-soft` collapses into the paper on white. Any
operable control identifies itself with these, and `--line` is deliberately not
used for it — lifting `--line` would redraw every panel edge in the app to solve a
problem that belongs to controls.

`--chrome-bg` / `--chrome-edge` are for the canvas's own instruments (the control
stack, the minimap): most of the way back toward the canvas, so they read as part
of it rather than as floating panels.

**Hashed hues.** Per-session and per-MCP colours are hashed in JS, which emits the
**hue only** (`--session-hue`, `--mcp-hue`); lightness comes from the cascade, one
tier per job (`--session-label-l` 78% dark / 26% light, `--session-accent-l`,
`--session-rim-l`, `--session-edge-l`, `--session-edge-idle-l`, `--mcp-dot-l`).
Never hard-code a lightness in TypeScript — that is the mistake this split exists
to prevent, and it made eight colours the only ones in the app that could not
answer to `data-theme`.

**The eight-series ceiling.** Eight mutually distinguishable luminances do not
exist in sRGB — a chain of *n* colours each 3:1 from the next needs the range to
span 3^(n−1), and 3³ = 27 already exceeds the 21 sRGB allows. So the usage series
and the tool categories buy their separation with **geometry** (a hairline between
bands) and each colour clears 3:1 against `--panel` so that hairline is visible.
Do not try to solve a new multi-series chart with colour alone.

**Two palettes are exempt from theming, on purpose.** The pixel-art material
(`--pixel-metal-light`, `--pixel-metal-shadow`, `--pixel-metal-edge`,
`--pixel-character-body`) and Claude FM's own tokens (`--fm-ink`,
`--fm-prop-light`, `--fm-prop-shadow`) are declared once, in the dark block only,
and appear nowhere in the light block. They keep their material identity across
UI themes. Do not "fix" them by adding light values.

**The appearance picker's swatches are a hard copy.** `.appearance-preview[data-swatch]`
re-declares each theme's values as `--tp-*` literals, because the preview draws
the *other* theme while the app is in this one and cannot read live tokens.
`appearance-swatch.test.ts` fails the day a token moves and its copy here does
not — so moving any of `--bg`, `--panel`, `--line`, `--muted-dim` or `--accent`
means updating the swatch in the same commit.

## Typography

One sans stack and one mono stack. No webfonts, no font loading, ever — the deck
opens instantly and a FOUT on a dashboard is unacceptable.

- **Body / UI:** `13px/1.45` system sans. This is the base on `html, body, #root`.
- **Data:** `ui-monospace, SFMono-Regular, Menlo, monospace` — every number, id,
  path, token count, model name, duration and dollar figure. If it is a value
  rather than a sentence, it is monospaced. This is the single strongest carrier
  of the product's character.
- **Scale in use:** 9, 10, 11, 12, 13, 14, 16, 18, 22, 26, 34 px. 9–11 are labels
  and chips, 12–13 is body, 14+ is a heading or a headline number. Do not invent a
  step between them.

## Layout

A CSS grid shell, `.app`, with `:has()` deciding the columns rather than a body
class:

```
rows:     52px  topbar
          auto  banner
          1fr   body
columns:  1fr 360px                 default (canvas + detail rail)
          240px 1fr 360px           with a left sidebar (sessions or accounts)
```

Sessions and Accounts share the left slot and are mutually exclusive. The right
rail is `--rail-r: 368px`, collapsing to `8px` when there is no detail.

**Breakpoints,** and there are deliberately few: `520px`, `640px`, `1039/1040px`,
`1200px`, `1440px`. Below ~1100px the floating panels already cover most of the
canvas — a known defect, not a pattern to copy.

**Scrollbars** are 10px, theme-aware, and the thumb is transparent until the
pointer or focus is inside the scroller. The **track keeps its width always**, so
arriving with the pointer never reflows the panel underneath. `:focus-within` sits
beside `:hover` because a scroller can be driven from the keyboard.

## Elevation & Depth

Two shadows and no more:

| Token | Dark | Light |
|---|---|---|
| `--shadow-1` | `0 6px 18px rgba(0,0,0,0.25)` | `0 4px 14px rgba(15,23,42,0.10)` |
| `--shadow-2` | `0 10px 24px rgba(0,0,0,0.32)` | `0 10px 28px rgba(15,23,42,0.16)` |

Depth is otherwise carried by surface tier (`--bg` → `--bg-soft` → `--panel`) and
by a 1px `--line` edge, not by stacking shadows. Two gradients exist and are
tokens rather than ad-hoc: `--node-grad` and `--topbar-grad`.

## Shapes

`--r-tag: 4px` · `--r-ctl: 6px` · `--r-panel: 8px` · `999px` for pills and the
scrollbar thumb. Nothing else. The form language is rectangular and tight; a
radius above 8px does not belong on this surface.

Control height is `--ctl-h: 30px`. Panel padding is `--panel-inset: 14px`.

**Two opacity tiers, used 22 times between them:** `--dim-off: 0.6` for something
switched off or inactive, `--dim-stale: 0.45` for something whose data is old.
Reach for these rather than a fresh opacity value.

## Components

- **Agent node** — the canvas's primary object. `--node-grad` fill, state on the
  border (`active` / `done` / `err`), the session's hashed accent as its own
  `--accent`. It has **level-of-detail variants**: `data-lod="compact"` and
  `"overview"` strip it down as the board zooms out. Anything added to a node must
  decide what it becomes at each LOD.
- **Model chip** — `data-family` per model family (`opus`, `sonnet`, `haiku`,
  `fable`, `mythos`), re-tuned per theme. Add a family here, not in a component.
- **Tool bubble / burst** — striped with its `--cat-*` category colour; the chip's
  edge is the same colour at 40%.
- **Panel** (usage, machine, accounts) — `--panel` on `--r-panel`, 14px inset,
  1px `--line`.
- **Canvas chrome** (control stack, minimap) — `--chrome-bg` / `--chrome-edge`, so
  it reads as part of the canvas.
- **Focus ring** — `2px solid var(--accent)`, `outline-offset: 2px` (`1px` on
  buttons), `border-radius: 4px`. Global on `:focus-visible`; do not override it
  per component.

## Do's and Don'ts

**Do**

- Take colour from a token. If a value needs a new tier, add the tier to
  `styles.css` in both theme blocks and let the contrast tests judge it.
- Monospace every value; leave sentences in the sans stack.
- Honour `prefers-reduced-motion` — there are 25 such blocks already, and motion
  tokens (`--edge-transition`, `--ctx-arc-transition`) are redefined rather than
  removed inside them.
- Respect `forced-colors: active`; a rule for it already exists.
- Decide what a new canvas element looks like at `compact` and `overview` LOD.
- Let `:has()` do layout switching. No body classes.

**Don't**

- Don't hard-code a hex in a `.tsx`. The cascade knows the theme and JS does not;
  hand an inline style a `var()` string when a value must come from JS.
- Don't put readable words in `--muted-dim`, or lift `--muted` without re-running
  the contrast tests — it has two tenths of headroom.
- Don't introduce a webfont, a third shadow, a radius above 8px, or a fourth
  surface tier in light.
- Don't solve a new multi-series chart with colour alone; eight distinguishable
  luminances do not exist.
- Don't add a hue that only works in dark. Light is a peer, and it is where the
  bugs are.
- Don't use `--line` to identify a control. That is `--ctl-edge`'s job.
