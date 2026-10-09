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
  cat-agent: "#f9a8d4"
  cat-task: "#86efac"
  cat-plan: "#c4b5fd"
  cat-mcp: "#5eead4"
  cat-other: "#94a3b8"
  usage-purple: "#c4b5fd"
  usage-blue: "#7dd3fc"
  usage-teal: "#5eead4"
  usage-lime: "#bef264"
  usage-pink: "#f9a8d4"
  usage-indigo: "#a5b4fc"
  usage-orange: "#fdba74"
  usage-zinc: "#94a3b8"
  usage-cyan: "#67e8f9"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "13px"
    lineHeight: 1.45
  data:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, \"Cascadia Mono\", Consolas, \"DejaVu Sans Mono\", \"Liberation Mono\", monospace"
    fontSize: "12px"
    lineHeight: 1.45
  label:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, \"Cascadia Mono\", Consolas, \"DejaVu Sans Mono\", \"Liberation Mono\", monospace"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.3
  micro:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, \"Cascadia Mono\", Consolas, \"DejaVu Sans Mono\", \"Liberation Mono\", monospace"
    fontSize: "9px"
    letterSpacing: "0.06em"
rounded:
  tag: "4px"
  ctl: "6px"
  panel: "8px"
  node: "10px"
  cluster: "16px"
  pill: "999px"
spacing:
  ctl-h: "30px"
  panel-inset: "14px"
  pad-x: "14px"
  flow-gutter: "15px"
  sl-card-gutter: "4px"
components:
  button:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.data}"
    rounded: "{rounded.ctl}"
    height: "{spacing.ctl-h}"
    padding: "0 12px"
  button-hover:
    backgroundColor: "rgba(216,218,224,0.07)"
    textColor: "{colors.text}"
  button-primary:
    backgroundColor: "{colors.accent-dim}"
    textColor: "{colors.text}"
    rounded: "{rounded.ctl}"
    height: "{spacing.ctl-h}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.err}"
    rounded: "{rounded.ctl}"
    height: "{spacing.ctl-h}"
  switch:
    backgroundColor: "rgba(216,218,224,0.07)"
    rounded: "{rounded.pill}"
    width: "30px"
    height: "18px"
  field:
    backgroundColor: "rgba(216,218,224,0.07)"
    textColor: "{colors.text}"
    rounded: "{rounded.ctl}"
    height: "{spacing.ctl-h}"
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "{spacing.panel-inset}"
  modal:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    width: "min(820px, 92vw)"
  canvas-chrome:
    backgroundColor: "#101217"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
  agent-node:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.node}"
  tag:
    backgroundColor: "rgba(216,218,224,0.07)"
    textColor: "{colors.muted}"
    typography: "{typography.micro}"
    rounded: "{rounded.tag}"
---

# ccdeck design system

Extracted from `src/web/styles.css` on 2026-09-26, revised 2026-09-27 after review.
The stylesheet is the single source of truth — `styles.css` and the parts it
imports from `src/web/styles/`, in cascade order, 15k lines, with its
reasoning written inline. **When this file and the stylesheet disagree, the
stylesheet is right and this file is stale.**

Because that sentence is load-bearing, this file states no rule the sheet
contradicts. Where the shipped code breaks a rule it otherwise follows, the
exception is named and linked to its issue rather than quietly asserted away.

## Overview

ccdeck is an instrument panel. Somebody glances at it because an agent stopped, or
leaves it open on a second monitor while work happens elsewhere. It is never the
thing being looked at on purpose for long.

Three consequences that decide everything else:

- **Calm by default, loud only for a real event.** Colour carries state, not
  decoration. A screen with nothing wrong on it is almost monochrome, and no
  resting colour may wear a state's hue — see *State hues are exclusive* below.
- **Dark is the default, light is a full peer.** `:root` is the dark ramp;
  `:root[data-theme="light"]` re-tunes every hue rather than inverting. Light is
  where contrast bugs live, because every terminal-adjacent colour assumes dark.
  Light and Dark are joined by optional Rider Black and VS Code Black palettes;
  the supported choices come from `themes/*.json`; `theme.ts` owns their cycle.
- **Density serves the glance.** The target is concrete so a screenshot can pass
  or fail it: **at 1440×900 with the detail rail open, eight sessions in the list
  and twenty nodes on the canvas fit without scrolling.** 13px base, 30px
  controls, 9–11px labels.

Contrast is enforced by tests, not by taste: `contrast-floors.test.ts`,
`control-edges.test.ts` and `usage-series-contrast.test.ts` measure the shipped
token values against the surfaces they land on, in both themes. A new colour that
fails them is a failing build, not a review comment.

**The floors those tests defend**, stated once so a new colour can be checked
before the build does it:

| What | Floor | WCAG |
|---|---|---|
| Text a reader reads | 4.5:1 | 1.4.3 |
| Control edges, strokes, series bands, meter fills | 3:1 | 1.4.11 |
| Decorative marks, and disabled or non-operable controls | exempt | 1.4.3 |

**An opacity is a contrast ratio too.** A token that passes can still fail once an
`opacity` is multiplied over it, so `contrast-floors.test.ts` composites the stale
dim over every readable tier and holds every rule that reads it to an element with
no children (#1289) — see `--dim-stale` under Shapes.

## Colors

**A missing `data-theme` means dark, by design.** The sheet's first selector is
`:root, :root[data-theme="dark"]`, so a light-theme user whose stored preference
arrives late sees a fully painted dark deck rather than an unstyled frame. The
attribute must therefore be written **before first paint**, which the bundle
cannot do — module scripts are deferred — so `index.html` carries a small inline
bootstrap that duplicates `resolveTheme`'s rule on purpose.
`theme-first-paint.test.ts` runs the inlined text against the real function so the
two copies cannot drift. Never move that logic into the bundle.

| Token | Dark | Light | Job |
|---|---|---|---|
| `--bg` | `#0b0c10` | `#eef1f6` | The canvas. |
| `--bg-soft` | `#0f1116` | `#ffffff` | One step off the canvas. In light it is **deliberately identical to `--panel`** — white is the ceiling, so a third surface tier would be noise at 1.09:1. |
| `--panel` | `#14161b` | `#ffffff` | Panels, cards, modals. |
| `--line` | `#1f2229` | `#c8cdd6` | Panel edges, rules, separators. |
| `--line-soft` | `#1a1c22` | `#dde1e8` | The quieter rule. |
| `--text` | `#d8dae0` | `#0d1117` | Primary foreground. |
| `--text-secondary` | `#9aa0ab` | `#303845` | **Prose somebody reads**, as opposed to metadata they glance at. 6.89:1 on `--panel` in dark, 11.82:1 in light. |
| `--muted` | `#7e828c` | `#4a5260` | Metadata. 4.70:1 on `--panel` in dark — two tenths above the AA floor, so it cannot be lowered. |
| `--text-dim` | `#7e828c` | `#5f6673` | Annotation. Shares `--muted` in dark because the dark ramp has no room for a third readable tier; light has the headroom and keeps a real step. |
| `--muted-dim` | `#50535b` | `#7c8493` | **Decorative tint only.** 2.35:1 on `--panel` in dark, 3.76:1 in light — never put words a reader needs in it. |
| `--accent` | `#7dd3fc` | `#0369a1` | Interactive, live, focused. |
| `--accent-dim` | `#38bdf850` | `rgba(3,105,161,0.22)` | The primary button's wash. |
| `--grid-line` | `#1a1d24` | `#d0d5dd` | The canvas dot grid. |
| `--ok` `--warn` `--err` | `#86efac` `#fcd34d` `#fca5a5` | `#157a3a` `#ad4e08` `#b91c1c` | Settled, attention, failed. |
| `--inflight` | `#f0abfc` | `#7e22ce` | A tool call in flight — the one hue that means *right now*. Nothing else in either palette comes within 16 ΔE of it (#1283). |

**Derived tiers, and why they are derived.** These are deliberately absent from the
frontmatter's `colors` map, because a primitive may not reference another primitive
and every one of them is mixed from a token. `--ctl-fill` and `--ctl-edge` are
mixed from `var(--text)`, not borrowed from a surface, and both themes declare them
identically. A tier derived from the foreground exists in both themes by
construction; one borrowed from `--bg-soft` collapses into the paper on white. Any
operable control identifies itself with these, and `--line` is deliberately not
used for it — lifting `--line` would redraw every panel edge in the app to solve a
problem that belongs to controls.

`--chrome-bg` / `--chrome-edge` are for the canvas's own instruments (the control
stack, the minimap): most of the way back toward the canvas, so they read as part
of it rather than as floating panels.

**Hashed hues.** Per-session and per-MCP colours are hashed in JS, which emits the
**hue only** (`--session-hue`, `--mcp-hue`); lightness comes from the cascade, one
tier per job:

| Tier | Dark | Light | Drawn as |
|---|---|---|---|
| `--session-label-l` | 78% | 26% | cluster label — text, 4.5:1 |
| `--session-accent-l` | 60% | 26% | the node's own `--accent` |
| `--session-rim-l` | 55% | 38% | cluster rims — decoration |
| `--session-edge-l` | 72% | 30% | live parent→child edge, 2px, 3:1 |
| `--session-edge-idle-l` | 55% | 36% | settled edge, 1.5px |
| `--mcp-dot-l` | 65% | 32% | unknown-server stripe, MCP chip edge |

Never hard-code a lightness in TypeScript — that is the mistake this split exists
to prevent, and it made eight colours the only ones in the app that could not
answer to `data-theme`.

### The eight tool categories and the eight usage series

Both sets are theme-tuned. These are the values people reach for when they add a
chart, so both ramps are here rather than dark alone:

| Token | Dark | Light | | Token | Dark | Light |
|---|---|---|---|---|---|---|
| `--cat-file` | `#7dd3fc` | `#0369a1` | | `--usage-purple` | `#c4b5fd` | `#4c1d95` |
| `--cat-shell` | `#fcd34d` | `#b45309` | | `--usage-blue` | `#7dd3fc` | `#0369a1` |
| `--cat-web` | `#67e8f9` | `#0e7490` | | `--usage-teal` | `#5eead4` | `#0f766e` |
| `--cat-agent` | `#f9a8d4` | `#a21caf` | | `--usage-lime` | `#bef264` | `#4d7c0f` |
| `--cat-task` | `#86efac` | `#15803d` | | `--usage-pink` | `#f9a8d4` | `#be185d` |
| `--cat-plan` | `#c4b5fd` | `#4c1d95` | | `--usage-indigo` | `#a5b4fc` | `#3730a3` |
| `--cat-mcp` | `#5eead4` | `#0f766e` | | `--usage-orange` | `#fdba74` | `#7c2d12` |
| `--cat-other` | `#94a3b8` | `#64748b` | | `--usage-zinc` | `#94a3b8` | `#4a5260` |
| | | | | `--usage-cyan` | `#67e8f9` | `#0e7490` |

The usage colours are a palette, and the cost bar and the projects bar draw from
it too. Which member a model family is drawn in is said once, by a `--model-*`
token in a theme-independent `:root` block (#1285): `--model-opus` (also Claude
Code's own band), `--model-sonnet`, `--model-haiku` (also Copilot's),
`--model-gpt5`, `--model-gpt`, `--model-gemini`, `--model-codex`, `--model-fable`
(also Mythos), and `--model-other` for anything `modelColor` does not recognise.
Anything that draws a model — the chart, the by-CLI strip, the model chip — reads the
family token and never a palette member.

**The palette never wears a state colour** (#1284). Every member stays 16 ΔE or more
from `--ok`, `--warn` and `--err` in both themes, and there is no red in it: a band
that is the error colour reads as a failure whatever its legend says. On white the
orange slot is a burnt orange, because that theme's `--warn` is an orange.

**A category is never identified by colour alone; the chip carries its name.**
That is already what `.cat-chip .cat-name` does, and it has to stay true: in dark,
`--cat-shell`, `--cat-web`, `--cat-mcp` and `--cat-task` sit within 1.01–1.03:1 of
each other, so only hue separates them, and in light `--cat-shell` `#b45309`
against `--cat-task` `#15803d` is 1.00:1 — orange against green, the pair
deuteranopes lose first. The hairline rule below covers bands that touch; a legend
swatch or a lone chip has no neighbour, so it needs the word.

**Eight series, three luminances.** Colours chained at 3:1 from each other need the
luminance range to span 3^(n−1); 3² = 9 fits inside the 21:1 sRGB allows and 3³ =
27 does not, so **at most three** colours can be mutually 3:1 apart — and there are
eight series. So the usage series and the tool categories buy their separation with
**geometry** — the hairline at `.uh-bar-seg` / `.uh-agent-seg` — and each colour
clears 3:1 against `--panel` so that hairline is visible against whichever two
bands it separates. Do not try to solve a new multi-series chart with colour alone.

### State hues are exclusive

A state colour means something only if nothing at rest wears it, so two sweeps hold
the palette off them, in both themes:

- **Nothing but `--inflight` comes within 16 ΔE of `--inflight`** —
  `contrast-floors.test.ts`. It used to be `--cat-agent` and the dark Opus chip byte
  for byte, and on white the Opus band and the plan category sat on it (#1283).
- **No usage palette member comes within 16 ΔE of `--ok`, `--warn` or `--err`** —
  `usage-series-contrast.test.ts` (#1284).

Pick a new category or series colour against both. Four surfaces still read
`--inflight` itself while nothing is running — the context meter's gradient, the
session summary's tool bars, the context donut between 70% and 90%, and the empty
canvas — tracked in #1649; do not add a fifth.

### Two palettes that are exempt from theming

`--pixel-metal-light`, `--pixel-metal-shadow`, `--pixel-metal-edge` and
`--pixel-character-body` are declared once, in `:root`, and never overridden in the
light block. They keep their material identity across UI themes. Do not "fix" them
by adding light values. Claude FM's props alias them (`--fm-prop-light` /
`--fm-prop-shadow` on `.fm-held[data-prop="scope"]`).

**Its ink is not exempt.** `--fm-ink` is `var(--bg)` on `.fm-sprite` and
`var(--text)` under `:root[data-theme="light"] .fm-sprite`, which also swaps the
sprite's `--accent` to `--pixel-character-body`. That light rule is deliberate —
without it the sprite's eyes and hat band go wrong in light. Keep it.

### The appearance picker's swatches are a hard copy

`.appearance-preview[data-swatch]` re-declares each theme's values as `--tp-*`
literals, because the preview draws the *other* theme while the app is in this one
and cannot read live tokens. `appearance-swatch.test.ts` fails the day a token
moves and its copy here does not — so moving any of `--bg`, `--panel`, `--line`,
`--muted-dim` or `--accent` means updating the swatch in the same commit.

## Typography

One sans stack and one mono stack. No webfonts, no font loading, ever — the deck
opens instantly and a FOUT on a dashboard is unacceptable.

- **Body / UI:** `13px/1.45` system sans, the base on `html, body, #root`.
- **Data:** `var(--font-mono)` — every number, id, path, token count, model name,
  duration and dollar figure. If it is a value rather than a sentence, it is
  monospaced. This is the single strongest carrier of the product's character, so
  the stack names a font on every peer platform (#1286): `ui-monospace,
  SFMono-Regular, Menlo` for macOS, first and unchanged; `"Cascadia Mono", Consolas`
  for Windows; `"DejaVu Sans Mono", "Liberation Mono"` for Linux; then the generic.
  Declared once — never write the stack out in a rule.
- **Every live number is `font-variant-numeric: tabular-nums`** — 72 declarations.
  On a panel whose numbers tick every second, proportional digits jitter. This is
  as much the character as the monospace is.

**Weights and case.** 400 is the default. Chips and stat values are 600. A waiting
duration is **700** — the heaviest thing on a resting card, because it is the
number that decides whether somebody gets up. 27 labels are
`text-transform: uppercase` with `letter-spacing: 0.05–0.06em`.

**The scale, by role.** Only the first five are general-purpose; the rest are
one-off hero sizes and using them as steps will look wrong:

| Size | Uses | Role |
|---|---|---|
| 9px | 13 | Micro-labels: chart axis labels, stat captions. Uppercase with tracking. Readable text — #1286 asked whether 9px holds up under ClearType at 100%; it stayed 9px when the stack was fixed, so check it on Windows before adding more. |
| 10px | 109 | Chips, tags, node metadata. |
| 11px | 166 | The workhorse label. |
| 12px | 101 | Control and button text, dense body. |
| 13px | 19 | Body prose. |
| 14px | 11 | Stat values, small headings. |
| 16 / 18 / 22 / 26 / 34px | 2 / 7 / 1 / 2 / 1 | **Hero only.** Headline numbers and modal titles. Not a scale to pick from. |

## Layout

A CSS grid shell, `.app`, with `:has()` deciding the columns rather than a body
class:

```
rows:     44px  topbar (--topbar-h)
          auto  banner
          1fr   body

columns:  1fr 360px                   default (canvas + detail rail)
          240px 1fr 360px             with the session list
          auto 1fr 360px              with the accounts panel
          1fr · 240px 1fr · auto 1fr  the same three with no detail open
```

Sessions and Accounts share the left slot and are mutually exclusive; accounts
takes `auto` because it has to fit bars and email addresses.

**The panel buttons live on the window's edges** (`edge-rails.css`): a stripe
`--edge-w` wide (one control height), with upright icon buttons on the left for the session list and the
accounts panel, and one on the right for Usage, the machine panel, Usage history
and Browser Watch; `.app` keeps their width free with its inline padding. They
are show/hide toggles, not tabs — several panels can be open at once and the
canvas never leaves — so an open one is a `--text` line on the stripe's inner
edge, never a tab joined to a page. The topbar keeps the identity, the stream's
state, the waiting count with the names of who is waiting, and Settings and
Feedback. Under 641px the stripes and those two become one dock along the
bottom, `--dock-h` tall. Desktop names and shortcuts appear in hints, including
when single-key shortcuts are disabled; mobile dock labels remain visible.

**The detail rail is the 360px column.** `--rail-r` is *not* its width — it is the
right offset the floating panels position against: `368px` (the rail plus an 8px
gap), or `8px` when no detail is open. Setting the rail to 368 would be wrong.

**Breakpoints,** and there are deliberately few: `520px`, `640px`, `1039/1040px`,
`1200px`, `1439/1440px`, plus `1139px` and `1632px` for the topbar ribbon's
sub-bands only. Below ~1100px the floating panels cover most of the canvas — a
known defect tracked in #847, not a pattern to copy. **The full three-column layout
wants 1040px or more**; 640 and 520 narrow the panels rather than offering a phone
layout.

**Node level of detail is not a viewport breakpoint.** It is `@container lod` on the
node's own box, and `@container bw` for Browser Watch. A node three columns deep
gets its compact face because *it* is small, not because the window is.

**Scrollbars** are 10px where `::-webkit-scrollbar` applies; Firefox gets
`scrollbar-width: thin` and the platform decides. The thumb is transparent until
the pointer or focus is inside the scroller, and the **track keeps its width
always**, so arriving with the pointer never reflows the panel underneath.
`:focus-within` sits beside `:hover` because a scroller can be driven from the
keyboard, and the keyboard's thumb is the louder one (#1290): `--ctl-edge`, 3:1 or
better on every surface in both themes, because a keyboard cannot hover the bar to
get a louder one. The pointer's reveal stays `--line`, a hint under a pointer that
is about to grab; the grabbed thumb is louder than both. Chromium and Firefox read
only `scrollbar-color` (Chromium ignores `::-webkit-scrollbar` once it is set, and
shades the grabbed thumb itself); Safari reads the webkit rules, whose grabbed thumb
is `--muted`. Keep the two halves in step. Under forced colours Chromium draws its
own system scrollbar in every state, so the forced-colours block has nothing to add.

## Elevation & Depth

**Elevation is three tokens and a contact line, and that is the rule:**

| Token | Dark | Light | Uses |
|---|---|---|---|
| `--shadow-1` | `0 6px 18px rgba(0,0,0,0.25)` | `0 4px 14px rgba(15,23,42,0.10)` | canvas objects at rest (node, recap note), the drag-trash zone |
| `--shadow-2` | `0 10px 24px rgba(0,0,0,0.32)` | `0 10px 28px rgba(15,23,42,0.16)` | modals, a hovered or selected node, the lift under a popover |
| `--shadow-3` | `0 1px 2px rgba(0,0,0,0.30), 0 14px 34px rgba(0,0,0,0.34)` | `0 1px 2px rgba(15,23,42,0.10), 0 14px 34px rgba(15,23,42,0.16)` | the topbar's menus |
| `--shadow-contact` | `0 1px 2px rgba(0,0,0,0.30)` | `0 1px 2px rgba(15,23,42,0.10)` | under `--shadow-2`, the anchored popovers |

A popover is `var(--shadow-contact), var(--shadow-2)`: the tight line is what reads
as sitting *on* something, the wide one is its height. Every theme retune lives in
the token, so no rule writes a light override for a shadow it reads (#1287).
Depth is otherwise carried by surface tier (`--bg` → `--bg-soft` → `--panel`, which
is only two tiers in light) and a 1px `--line` edge.

**Halos and rings are a different job and are allowed.** A state colour at zero
offset is a mark, not elevation: `0 0 8px var(--ok|warn|err|inflight)`,
`0 0 22px var(--accent)`, and `0 0 0 1px` identity rings. Reach for these to say
*this one*, never to lift something off the page.

**A gradient is a token when two rules share it or a theme retunes it** (#1287):
`--node-grad`, `--topbar-grad`, `--conn-wash` (the disconnected banner),
`--burst-live-wash` (a running tool bubble) and `--hero-core` (the empty-canvas orb)
in both theme blocks; `--meter-grad` (the context meter and the session summary's
tool bars) and `--wire-dashed` (a LAN wire that is down or cut) once, in a
theme-independent `:root`, because they are made of theme tokens already. A
gradient only one rule draws, from theme tokens, stays in its rule.
`elevation-tokens-1287.test.ts` fails a gradient written in two rules or retuned by
a light rule.

## Shapes

Two radius tiers, and the difference is deliberate: **chrome is tight, canvas
objects are rounder**, because a node reads as a physical thing and a panel reads as
a panel.

| Tier | Values | Used by |
|---|---|---|
| Chrome | `--r-tag: 4px` · `--r-ctl: 6px` · `--r-panel: 8px` | tags, controls, panels, modals |
| Canvas | `--r-node: 10px` · `--r-cluster: 16px` | `.agent-node` and `.recap-note`, `.cluster-card` — and nothing in the chrome |
| Sub-scale | `3px` ×15 · `2px` ×10 · `1px` ×7 | hairlines, stripes, meter fills |
| Round | `50%` ×41 · `999px` | dots, knobs, pills |

Both tiers are tokens in the geometry `:root` block (#1288), and
`radius-tiers-1288.test.ts` holds the canvas tier rounder than the chrome and
keeps chrome from reading it. **Do not bring the agent node down to 8px**; it is
10px on purpose. Many chrome rules still write `4px`, `6px` and `8px` as literals.
They were not bulk-converted, because the same number is not always the same
decision: 4px is also the focus ring's radius and a `kbd`'s, and 6px is also the
overview face's. Convert one when its role is a tag, a control or a panel.

Control height is `--ctl-h: 30px`. Panel padding is `--panel-inset: 14px`.

**Two opacity tiers, and they are not interchangeable:**

- **`--dim-off: 0.6`** — switched off or inactive. Safe everywhere it is used
  today, because every use is a disabled or non-operable control, which 1.4.3
  exempts.
- **`--dim-stale: 0.45`** — **marks and fills only.** Over text it drops below AA
  (3.55:1 on `--text` in dark, 2.15:1 on `--muted` in light), and no readable tier
  survives it on any surface in either theme. Stale *text* says so in words at full
  contrast: the history modal's subtitle reads `running ccusage…` while a re-run is
  out and only the chart's bars, segments and swatches dim; the usage panel's
  headline names the period its figures are from; an expired share says `expired`.
  `contrast-floors.test.ts` fails any rule that puts it on an element the markup
  gives children (#1289). The sheet had learned this once before: the comment above
  `.ap-account.active` explains why `.ap-account.disabled` stopped using `--dim-off`.

## Components

Documented in the order new work touches them: the primitives first, then the
canvas's own objects.

### Buttons

`button.btn` **rests transparent** with a `1px solid var(--ctl-edge)` border,
`min-height: var(--ctl-h)`, `0 12px`, 12px text, `--muted` label.

**Hover is neutral, not accent** — the edge goes to `--text` and the fill to
`--ctl-fill`. This is deliberate and people break it: an accent hover "made every
button the pointer crossed look selected". A press is `transform: scale(0.97)`,
never a 1px drop. Disabled is `opacity: var(--dim-off)`.

- `.btn.primary` — an `--accent-dim` wash with an `--accent` edge.
- `.btn.danger` — `--err` text with an `--err` 65% edge, and an `.armed` second
  step so a destructive action is never one click.
- `.btn.warn` was removed on purpose. Do not bring it back.
- `.rail-btn` is the chrome's control — a stripe button, a dock button, a topbar
  utility: edgeless at rest, `--ctl-fill` and `--text` under the pointer, a
  deeper fill and a `--text` line when its panel is open.
- **Edgeless at rest, in a dense column.** A few controls identified by their
  own word or name draw no boundary until they are pointed at or focused, and
  then take `--ctl-edge` and `--ctl-fill` — the verbs on a Local network row
  (`.ap-lan-who .ap-manage-btn`) and the Other accounts list's order and
  expand-all (`.ap-rest-sort select`, `.ap-rest-all`, #1579).
  `control-edges.test.ts` measures the edge they draw when they draw one.

### Switch, fields, modal

- **`.switch`** — 30×18, `999px`, `--ctl-fill` with a `--ctl-edge` border, a knob
  that slides. Unlike a button it **does** carry the resting fill, because a switch
  has no label of its own to be found by.
- **`.ap-field select` / `.ap-manage-input`** — `--ctl-fill`, `--ctl-edge`, 6px,
  `min-height: var(--ctl-h)`; hover lifts the border to `--text`.
- **`.modal`** — `min(820px, 92vw)`, `max-height: 82vh`, `--panel` on `--r-panel`,
  `--shadow-2` plus a faint accent ring. The backdrop is `rgba(5,6,9,0.55)` with
  **no blur**: the scrim is already opaque enough, and a blur over a canvas whose
  dashes never stop re-rasterises under the dialog for as long as it is open.

### Canvas objects

- **Agent node** — the canvas's primary object. `--node-grad` fill, `--r-node` radius,
  the session's hashed accent as its own `--accent`. State is carried by **both the
  border and the state pill** (`stateLabel()`: `live` / `done` / `err`), never the
  border alone — 1.4.1. It has **level-of-detail variants** via `@container lod`:
  `compact` and `overview` strip it down as the board zooms out, so anything added
  to a node must decide what it becomes at each LOD.
- **Model chip** — `data-family` per family (`opus`, `sonnet`, `haiku`, `fable`,
  `mythos`), each naming its `--model-*` token and nothing else, so a chip is always
  the colour of its band in the usage chart (#1285). A chip draws the hue as its
  word with a 40% edge and a 6% wash; on white, a 55% edge, a 14% wash and the word a
  fifth of the way to `--text`, which is what keeps 10px text at 4.5:1 on its own
  wash. `gpt` is left untinted: the chart splits GPT-5 from the GPTs before it. Add a
  family here rather than in a component.
- **Tool bubble / burst** — striped with its `--cat-*` category colour; the chip's
  edge is the same colour at 40%, and the chip always carries the category name.
- **Panel** (usage, machine, accounts) — `--panel` on `--r-panel`, 14px inset, 1px
  `--line`.
- **Canvas chrome** (control stack, minimap) — `--chrome-bg` / `--chrome-edge`, so
  it reads as part of the canvas.

### Blocked on you — the signature pattern

The product's sharpest job, and therefore the one pattern that must not be
reinvented. Three rules:

1. **`--warn` is reserved for it.** The topbar `.waiting-stat` chip is a transparent
   pill with an `--warn` 85% edge and `--warn` text; `.notify-said-blocked` is
   `--warn`. Nothing else competes at that colour — not even the names of who is
   waiting beside the count, which are neutral (`.wait-entry`).
2. **The pulse is the only ambient motion a resting card may have.** `.waiting-dot`
   is a 5px `currentColor` dot borrowing `.ap-pulse`'s motion, so the app keeps one
   idiom for *still asking* and one reduced-motion answer for it.
3. **Duration beats description.** On the node the waiting row truncates the
   sentence and never the duration, at weight 700 — it is the number that decides
   whether the user gets up.

### Focus ring

`2px solid var(--accent)`, `outline-offset: 2px` (`1px` on buttons),
`border-radius: 4px`, global on `:focus-visible`. Nineteen rules already override
it, and correctly: a component may move the **offset** (negative, to pull the ring
inside a scroller that clips) or the **radius**. It never changes the colour or the
width.

### Forced colours

`@media (forced-colors: active)` is a whole system, not a courtesy rule, and it has
a requirement for new work:

- A fill that carries state opts out with `forced-color-adjust: none` and redraws
  in a system colour — `CanvasText` when a word beside it already carries the
  state, `Highlight` when live or on, `GrayText` when resting.
- Identity marks matched to a legend keep their own colour.
- Every meter track gets a hairline.

**A new status dot, meter or fill has to be added to that block, or it disappears
under a Windows contrast theme.** Windows is a peer platform.

## States

On an instrument panel the states *are* the design, so they are listed in one place
rather than scattered through the sections above.

| State | Token | Mark | Words | Motion |
|---|---|---|---|---|
| Live | session accent | node border, state pill | `live` | in-flight edge animates |
| In flight | `--inflight` | tool-call edge, burst stripe | tool name | dash animation |
| **Blocked on you** | `--warn` | topbar chip, `.waiting-dot` | `waiting 6m · Bash` | the pulse, and only here |
| Done | `--ok` | node border, state pill | `done` | edge fades to settled |
| Error | `--err` | node border, state pill | `err` | none |
| Switched off / disabled | `--dim-off` | the whole control dims | — | none |
| Stale data | `--dim-stale` | marks and fills only | `running ccusage…`, the period's noun, `expired` — at full contrast | none |
| Disconnected | `--warn` | `.conn-banner` row | — | none |
| Provider incident | `--err` (outage and degraded), `--muted` (maintenance) | `.pi-dot`: a filled dot for an outage, an `--err` ring for degraded, a grey square for maintenance; a `--r-tag` chip, never the alarm's pill; dashed edge when stale | `Claude · partial outage`, `· as of 14:05` when stale | none |
| Update ready | `--accent` | `.ver-banner` row | — | none |
| Empty canvas | `--muted` | — | the tour offer | none |

A new state adds a row here, and it needs a **mark and a word** — never colour
alone.

## Motion

The house vocabulary, so nothing reaches for `300ms ease-in-out` and feels foreign
on a panel this dense:

- **120ms** (97 uses) and **140ms** (71 uses) for control feedback. 200ms is the
  longest ordinary transition.
- **`cubic-bezier(0.23, 1, 0.32, 1)`** is the ease-out — 59 uses, where the next
  most common custom curve has 11. Use this one.
- **`scale(0.97)`** on press, 36 uses. Not a translate, not a shadow change.
- **The pulse is the one ambient loop** (`--pulse-live: 1.2s ease-in-out`), reserved
  for *still asking*.
- **`prefers-reduced-motion: reduce` is honoured in 25 blocks**, and the motion
  tokens (`--edge-transition`, `--ctx-arc-transition`) are *redefined* inside them
  rather than deleted — so a reduced-motion user still gets the opacity change that
  carries meaning, without the movement.

Promoting these to `--ease-out` / `--dur-fast` tokens is a sensible follow-up; they
are literals today.

## Do's and Don'ts

**Do**

- Take colour from a token. If a value needs a new tier, add the tier to
  the matching `themes/*.json` palettes and let the contrast tests judge it.
- Monospace every value and give every live number `tabular-nums`; leave sentences
  in the sans stack.
- Give every state a mark **and** a word.
- Register a new status dot, meter or fill in the `forced-colors: active` block, or
  it vanishes under a Windows contrast theme.
- Honour `prefers-reduced-motion` by redefining the motion token, not by deleting
  the transition.
- Decide what a new canvas element looks like at `compact` and `overview` LOD.
- Let `:has()` do layout switching. No body classes.

**Don't**

- Don't hard-code a hex in a `.tsx`. The cascade knows the theme and JS does not;
  hand an inline style a `var()` string when a value must come from JS. A
  `<canvas>` cannot take `var()`: read the token with `getComputedStyle` at draw
  time and redraw on theme change, **with no literal fallback** — a fallback is a
  copy that drifts, and `WatchRadar`'s `#6e727c` is an old `--text-dim`.
- Don't put readable words in `--muted-dim`, and don't put `--dim-stale` over text.
- Don't lift `--muted` without re-running the contrast tests — it has two tenths of
  headroom.
- Don't introduce a webfont, a fourth elevation, or a third surface tier in light.
- Don't bring a canvas object down to the chrome radius; 10px and 16px are
  deliberate.
- Don't give a button an accent hover. Neutral hover is a decision, not an
  oversight.
- Don't solve a new multi-series chart with colour alone; at most three colours can
  be mutually 3:1 apart.
- Don't add a hue that only works in dark. Light is a peer, and it is where the bugs
  are.
- Don't use `--line` to identify a control. That is `--ctl-edge`'s job.

### Telemetry Radar

An inspection workspace with three tabs: Monitor, Configuration and File. A compact
settings summary and shared session selector sit above the split message list and
inspector. The Monitor is the initial view; JSON is a first-class inspection mode.
Configuration evidence, capture state and collector receipts use distinct language.
Enabled content flags use warning color; positive receipts alone use the success
color. Unknown attribution remains explicit. Detailed capture limits stay in the
footer, and Terminal activation expands only when action is needed. On mobile,
messages precede the inspector in one scrolling column. Views remain mounted so
changing tabs preserves the selected message and imported file.

### Rider Black

An optional theme inspired by the JetBrains dark UI palette: a charcoal
canvas (#1e1f22), separate gray tool surfaces (#2b2d30), flat nodes and blue focus
accents. Readable secondary text stays above 4.5:1; status and category colors
keep their meanings. Light and Dark retain their palettes. The choice persists
before first paint and keyboard theme switching cycles through all available themes.

Radar shows socket evidence independently of settings-file evidence. Missing
configuration never means telemetry is off, and stopped capture refers only to
Radar. Observed addresses can be selected explicitly without being labeled as
configured collectors or confirmed telemetry.

### VS Code Black

A separate theme based on VS Code Dark Modern: #1f1f1f working canvas, #181818
tool panels, #2b2b2b separators and #4daafc accents. Selection uses #264f78 with
white text. Both IDE palettes keep flat surfaces and ccdeck’s semantic color
mapping. Settings lays out four previews on desktop and two per row on phones.

### JSON theme definitions

`src/web/themes/*.json` owns each theme's ID, name, order, color scheme and
semantic tokens. The versioned format supports inheritance and selection colors.
`scripts/theme-compiler.mjs` validates and generates palettes, theme previews,
typed catalog metadata and the first-paint ID list. Vite regenerates on build and
reloads after JSON changes so CSS and the cached canvas palette stay in step.
Shared geometry, motion and model mappings remain in `styles/tokens.css`.
See `src/web/themes/README.md` for adding a palette and checking generated output.
