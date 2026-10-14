# Text size and density verification

2026-10-14. Feature branch: `feat/text-size-density`, from development `da2ec5b2`.

## Implementation

Settings → Text & density. Independent text Default/Larger/Largest (0/+2/+4px)
and density Compact/Default/Comfortable; native keyboard-operable radios,
immediate preview, reset, pre-paint restore and same-origin storage events.
Default retains the existing type scale and spacing. Persistence is browser-local
when browser storage permits it. No canvas/browser zoom setting is changed.
Density adjusts shared panel/control geometry and agent/session/account rows.
Zoomed-out LOD summaries retain their fixed screen-space typography budgets.

## Executed checks

- `npm run typecheck`: passed.
- `npm run build`: passed after the final narrow label/account row follow-up
  (13.09 seconds). Existing large-chunk warning.
- Combined focused type/geometry/settings suite: **32 files, 668 tests passed**.
  Legacy source-level geometry checks explicitly resolve only the two known
  zero-default reading increments; actual browser tests check the rendered cascade.
- After the account-row spacing and narrow-label follow-up:
  `npm run test -- src/web/__tests__/reading-preferences.test.ts src/web/__tests__/panel-rhythm.test.ts src/web/__tests__/accounts-small-text-857.test.ts src/web/__tests__/control-edges.test.ts`:
  **4 files, 73 tests passed**.
- `PLAYWRIGHT_MODULE=<existing Playwright module> PLAYWRIGHT_EXECUTABLE=<installed Chromium executable> node scripts/verify-reading-preferences.mjs`:
  passed after final UI corrections. Actual app at the isolated local preview,
  no new test dependency. Default computed text/padding, independent controls,
  native radio keyboard change, reload, cross-tab updates, denied storage,
  reset, Escape/focus return and unchanged React Flow viewport scale verified.
- Screenshots: 1280×900, 320×640, 390×844 and 1024×500; dark and White Contrast;
  largest text with compact/comfortable spacing. Top and scrolled-bottom crops
  show only Settings, without connected-account identifiers.
- Impeccable mechanical detector on the new component/styles: `[]`, run once.
- Independent finish review: one material misleading-save-copy finding, corrected
  to conditional browser-storage wording and verified in the denied-storage test.
  Optional narrow label word-split corrected and independently scored resolved.
  Both final typecheck and build passed: SHIP at this bounded review scope.

## Limitations

This is not the entire repository regression suite or a WCAG certification.
No Safari/Firefox, screen-reader, native Windows or Linux runtime check was run.
SVG/canvas chart text retains its existing chart-specific rendering; this setting
targets CSS interface typography. Offline/cloud sync and cross-origin desktop
preference migration are separate work. The settings preview uses illustrative
session rows; runtime browser checks use the actual application and isolated
synthetic session events, without executing agents or altering provider accounts.
