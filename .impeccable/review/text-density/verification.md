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
