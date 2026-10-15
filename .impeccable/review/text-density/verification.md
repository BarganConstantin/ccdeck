# Text & density — final verification

2026-10-14. Branch `feat/text-size-density`; initially based on development
`da2ec5b2`, then integrated development `87137340` (Gruvbox themes and theme
transitions). PR target is `development`; this branch has not been merged there.

## Result and scope

Settings → Text & density provides five independent text choices:
Smallest (−2px), Smaller (−1px), Default, Larger (+2px), Largest (+4px), and
Compact / Default / Comfortable spacing. Default preserves the established
computed typography and spacing. Immediate preview, reset, pre-paint restore,
same-origin tab synchronization and guarded browser-local persistence are
implemented. Storage denial leaves the interface usable without promising that
preferences will persist.

The final control composition uses an ordered text scale with Default centered,
relative-size Aa illustrations, selected checkmarks, and density illustrations
with 2/4/8px stroke gaps. Native radios retain keyboard interaction. The selection
plate moves through an interruptible 180ms transform; press feedback is 140ms.
Reduced motion removes spatial transitions. No new dependencies or brand assets.

Density changes shared panel/control geometry and agent/session/account rows.
CSS interface typography scales independently of browser and canvas zoom.
Zoomed-out LOD summaries keep their fixed screen-space type budgets; expanded
cards and details use the requested size. SVG/canvas chart-specific text retains
its existing renderer sizes.

## Executed checks

| Check | Final result |
| --- | --- |
| `npm run typecheck` | Passed, exit 0, after development integration and final corrections |
| `npm run build` | Passed, exit 0; Vite 14.25s, existing large-chunk warning |
| Full regression suite on CI's Node 22 | 1,068 files / 13,343 tests passed, exit 0; 218.35s |
| Three integration/contrast regression files | 57 tests passed, exit 0 |
| `git diff --check` | Passed |
| Lint | No lint script configured |

Full regression command:

```sh
# Node 22 on PATH, matching the repository's publish CI runtime.
node node_modules/vitest/vitest.mjs run --maxWorkers=4 --minWorkers=1
```

Earlier focused runs passed 668 tests across 32 files, followed by more focused
checks after subsequent changes. Those earlier results are not substituted for
the final full-suite result above. Source-level default-geometry tests resolve
only the known zero-default text/row increments; non-default behavior is checked
in the rendered application.

Actual-application browser commands, using an existing Playwright installation
and installed Chromium, without adding a project dependency:

```sh
PLAYWRIGHT_MODULE=<existing-module-path> \
PLAYWRIGHT_EXECUTABLE=<installed-Chromium-path> \
node scripts/verify-reading-preferences.mjs

PLAYWRIGHT_MODULE=<existing-module-path> \
PLAYWRIGHT_EXECUTABLE=<installed-Chromium-path> \
node scripts/verify-reading-panels.mjs
```

Both passed after integrating development, exit 0. Explicit assertions cover:

- Default body size/padding; all five text choices; independent density; larger
  control height floors; unchanged browser CSS zoom and manually held Flow scale.
- Native radio arrow-key selection, visible keyboard focus, reset, Escape and
  focus return after dismissal.
- Reload persistence, same-origin cross-tab updates, and storage denial recovery.
- Selection settlement after rapid changes; normal 180ms versus reduced-motion
  instant backplate; density stroke widths and gaps across desktop/mobile.
- Narrow/short layouts at 320×640, 390×844, 1024×500 and desktop 1280×900;
  top and scrolled-bottom content remains reachable.
- Four synthetic agent sessions in the actual App, Default/Largest typography,
  Comfortable density, and no card vertical clipping; synthetic account panel.
- No browser page errors in these flows.

A separate browser check also passed for newly integrated Gruvbox Dark, Light
and Material at Largest/Comfortable: correct theme attributes, 17px body text,
no page errors. These temporary theme captures were inspected alongside the
tracked dark/White Contrast and forced-colors captures.

## Rendered evidence and review

The 15 tracked PNGs in this folder show the final controls, safe synthetic data,
and different viewport/scroll states:

- `default-desktop.png`, `largest-comfortable-desktop.png`: Default and configured
  desktop states at the same viewport.
- `narrow.png`, `mobile.png`, `short.png`, `light-largest.png`: responsive and
  alternate-theme states.
- `desktop-bottom.png`, `narrow-bottom.png`, `mobile-bottom.png`, `short-bottom.png`:
  preview, explanatory copy and reset at the bottom of the scroll region.
- `forced-colors.png`: system colors, opaque modal, selection edges and readable
  density strokes.
- `canvas-default.png`, `canvas-largest.png`, `accounts-default.png`,
  `accounts-largest.png`: synthetic core-panel comparisons.

Impeccable 4.1.1 craft/polish/animate guidance was applied to implementation and
rendered iteration. Its mechanical detector ran once on the new component/style
and returned `[]` at that point; this is not claimed as a later whole-codebase
scan. Independent finish review found and closed conditional-save wording and a
mobile density-sample layout defect. Final integration review confirmed both
reading preferences and development's theme transition behavior were retained;
bounded visual/source verdict: **SHIP**.

## Regression findings handled

- Existing source inventories now include the new section and control states;
  tests retain their Default geometry and accessibility assertions.
- Forced-colors changes live in the canonical shared block, preserving the
  repository's single-block cascade contract. The modal remains opaque.
- Latest development independently failed two source invariants under Node 22:
  a Gruvbox predicate referenced a dragging state the cluster label never has,
  and secondary-text inventory omitted two theme overrides. Removed that dead
  predicate and explicitly inventoried the existing selectors, including the
  corresponding control-edge inventory; all three targeted tests pass.
- An earlier packaging test overlapped a build and read a disappearing hashed
  asset. The isolated packaging rerun passed 10 tests. Final full-suite runs are
  performed without concurrent build/source mutation.

## Genuine limits and follow-ups

**SHIP WITH FOLLOW-UPS** at the tested UI/runtime scope; the final full suite
passed. This is not WCAG certification or proof of every platform/provider.

Node 26.5.0's full suite encountered a deep-JSON serialization stack overflow in
`api-events-streaming.test.ts`. The same failure was reproduced on unchanged
original development; its seven tests pass under Node 22. It is a pre-existing
runtime compatibility follow-up, not a reading-preferences regression. No
unrelated API behavior was rewritten to conceal it.

No Safari/Firefox, screen-reader, native Windows/Linux runtime or frame-rate
benchmark was run. Browser checks use controlled sessions/accounts and suppress
provider usage reads; they do not establish live-provider correctness or change
external account state. Browser/origin-local settings do not add cloud sync or
cross-origin desktop preference migration. Extremely small legacy metadata can
become smaller with the explicit Smallest choice; choice labels retain readable
floors. Default and larger modes preserve their tested hierarchy/contrast rules.

## Follow-up pass — 2026-10-15

Reviewed in the running deck (Vite on :5174 over a 3.41.3 deck) at every text
size and density. Three defects found and fixed:

- **Panels did not widen with their text.** At Larger/Largest the 288px and
  280px panels kept their width, so "Claude accounts" and "This machine" broke
  onto two lines, the accounts row cut "Fable" to "Fa…" and "resets in 1d 23h"
  wrapped. The session list, Accounts, Usage and This machine now widen by
  `--ui-panel-increase` (24px at Larger, 48px at Largest, 0 otherwise and on
  phones), the left column with them, and the accounts row's fixed columns take
  their share. The detail panel was checked at Largest and left at 360px.
- **Smallest took 9px and 10px text to 7px and 8px.** Those 132 sizes now stop
  at 9px, the ladder's lowest step: `calc(10px + max(-1px, …))` and
  `calc(9px + max(0px, …))`.
- **The pane.** Density is the same ordered control as text size, so "Original
  spacing" no longer wraps in a third-width card; each size names its body size
  (11–17 px) instead of an offset; Reset to defaults moved beside the intro, in
  view without scrolling past the preview.

Checks: `npm run typecheck`, `npm run build`, full suite on Node 24 — 1,068
files / 13,343 tests passed; both browser scripts passed (the preferences script
updated for the moved Reset and the new radio names); an overflow audit of the
four panels found no visible truncated text at Smallest, Default, Larger or
Largest. The tracked PNGs were regenerated by those two scripts.
`defaultReadingSheetText` also resolves the panel increase and the floored small
sizes, so the Default geometry tests still read the shipped values.

### Density, second pass — 2026-10-15

The owner found Compact barely different from Default: it took 2px off the
padding of four kinds of row. Density is now a factor, `--ui-space`, on the
vertical rhythm people scan — session-list rows and gaps, account rows and
lanes, Usage and This machine sections, detail rows, agent cards, the preview —
written `calc(Npx * var(--ui-space, 1))`, so Default computes to the designed
values. Five steps, two more towards compact as asked: Tightest 0.3, Tighter
0.5, Compact 0.7, Default 1, Comfortable 1.4, with `--panel-inset` 8/10/12/14/18px
and `--ctl-h` 24/26/28/30/36px (never under the 24px floor). At Tightest the
session list holds every row of a nine-session deck in about half its height.
The live "now" note keeps its two reserved lines at every density, on purpose:
that is what stops rows jumping while a turn runs. `--ui-row-increase` is gone.
Full suite 1,068 files / 13,345 tests and both browser scripts passed again;
captures regenerated.
