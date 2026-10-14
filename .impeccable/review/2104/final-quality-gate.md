# Account History — final product-ui-craft quality gate

14 October 2026. Branch: `feat/2104-account-usage-history`. Preview: http://127.0.0.1:4570/.

## Scope and decision

**SHIP WITH FOLLOW-UPS**, at the tested Chromium scope. Review used the explicitly supplied repository version of `product-ui-craft`, mode D, its evidence rubric and frontend quality gates. Impeccable 4.1.1 audit guidance informed diagnostics; focused hardening addressed reproduced issues. No new redesign, dependency, provider operation, merge or publication.

The primary job is comparing recorded account usage, then inspecting an account or reading. One large plot, window switching and a recorded-value account rail support that job. Values consistently mean used capacity: 0% unused, 100% exhausted. Latest recorded values do not assert current availability or freshness. Unknown windows remain unknown; reset markers do not assert renewal. The underlying account collection and persistence were not modified.

## Confirmed findings

| Severity | Observation and evidence | User impact | Implemented fix | Verification |
|---|---|---|---|---|
| Major | Tooltip placement subtracted a fixed 90px without measuring content. At 320×568, a long synthetic identifier produced a 246.89px tooltip outside the 320px plot; the added browser assertion failed before the fix. | Reading details covered controls or could be clipped on narrow screens. | Measure actual tooltip dimensions and clamp placement before paint. | Browser geometry assertion passed; `long-tooltip-before.png` and `long-tooltip.png` show the same scenario. |
| Major | The mobile breakpoint hid the usage metric label. In All accounts mode, the header displayed account count rather than a percentage, leaving the axis semantics unclear. | Users could mistake usage for remaining capacity. | Keep “Capacity used” visible below window navigation on narrow screens. | Narrow All accounts assertion passed; `narrow.png` and `mobile.png` inspected. |

Independent review scored both listed fixes **PASS / resolved**. That verdict covers those fixes, not formal accessibility certification. The parent separately ran and inspected the confirmation evidence.

## Rendered and interaction coverage

Real React components with controlled mocked APIs and synthetic accounts: default comparison, selected account, 5-hour/7-day switching, direct wheel zoom, pan, double-click reset, keyboard chart controls, keyboard selected-point tracking, native Chrome CDP touch zoom/pan/reset, 12 accounts, long identifiers, missing windows, empty/error/retry, retention and clear confirmation, Escape/focus restoration, reduced-motion context, light/dark, 320px/390px widths and a 500px short viewport. Top/bottom captures show the single workspace scroller. No rectangular focus frame; keyboard focus remains visible on the window heading. Primary controls remain reachable.

The observation inspector provides a keyboard alternative to hover. Sidebar labels show observation timestamps and removed-account status. Clipped names remain available through the full account option, native title and observation details. Existing theme tokens and measurement typography are retained. No unsupported optimization or cosmetic change was introduced.

## Executed validation

- `npm run test -- src/web/__tests__/account-history-axis.test.ts src/web/__tests__/account-snapshot-history.test.ts src/web/__tests__/account-snapshot-passive.test.ts src/web/__tests__/settings-surface.test.ts src/web/__tests__/contrast-floors.test.ts src/web/__tests__/control-edges.test.ts src/web/__tests__/usage-series-contrast.test.ts` — exit 0, **227 tests / 7 files**.
- `npm run test -- src/web/__tests__/account-capacity-reliability.test.ts src/web/__tests__/account-reset-calendar-2105.test.ts` — exit 0, **42 tests / 2 files**.
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0; log `/tmp/ccdeck-account-history-build.log`. Existing bundle-size warning remains outside scope.
- `CCDECK_REVIEW_ORIGIN=http://127.0.0.1:4570 CCDECK_BROWSER_MODULE=<existing-playwright-module> PLAYWRIGHT_EXECUTABLE_PATH=<existing-chromium> node scripts/verify-account-history.mjs` — initial long-tooltip regression reproduced with exit 1; final confirmation **exit 0**, no page errors. No test dependency added.
- `git diff --check` — exit 0.

Contrast checks cover the existing token, control-edge and usage-series suites; they are not an exhaustive WCAG audit of every rendered state. No axe or full assistive-technology audit was run. No full repository suite or cross-platform build was claimed.

## Limits and stop gate

Safari/Firefox, physical touch hardware, and full screen-reader sessions remain unverified. Native CDP touch evidence is browser emulation. Live provider correctness, cache lifecycle and business logic require their own engineering evidence; these fixture runs do not certify them. Historical readings may be stale by nature and are explicitly described as recorded values. Both reset windows remain available, with one visible at a time and a shared time viewport.

No significant unresolved defect was established in the reviewed browser states. Further arbitrary visual changes would not improve the quality gate. Keep the remaining platform/accessibility verification as follow-ups and stop this pass.
