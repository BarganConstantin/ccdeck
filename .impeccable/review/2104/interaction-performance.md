# History interaction performance and visual smoothing

Owner reported freezing and a visually rigid chart. Impeccable optimize guidance was applied to measured bottlenecks, not to unrelated bundles or hypothetical optimizations.

## Controlled measurements

Existing Playwright/Chromium, Vite development build, React Profiler around the real modal, identical synthetic 12-account fixture and viewport. These are React render durations, not end-to-end input latency or production-device guarantees.

| Interaction | Samples | Before p95 render | Final p95 render | Before total render | Final total render |
|---|---:|---:|---:|---:|---:|
| Hover along one series | 60 pointer moves | 66.4 ms | 1.1 ms | 2438 ms | 56 ms |
| Diagonal pan after zoom | 30 pointer moves | 119.5 ms | 8.2 ms | 1744 ms | 211 ms |

Pan baseline was measured after the first hover fix; before formatter reuse and deferred hidden content. Intermediate formatter-only pan p95 was 41.8 ms, so further work was justified by the remaining measured frame-budget failure. Final rendering fits a nominal 16.7 ms frame budget in this fixture; this does not certify frame rate or paint time on all devices.

## Fixes

- Memoize series geometry, visible observation transformations and option elements, retaining them across hover changes.
- Build one locale/timezone-aware formatter per chart/parent render instead of rebuilding it for each observation. No global timezone cache was added. Existing Chisinau DST checks passed.
- Defer geometry for the inactive plot and option construction for closed inspectors. Both chart states and selected observations remain mounted; activation/opening restores content.
- Replace sharp polylines with shape-preserving cubic guides. They pass through recorded readings and do not overshoot adjacent values. Gap/reset segmentation remains unchanged; tooltip values are actual observations.
- Show segment endpoints and the tracked reading instead of permanently marking every intermediate point. Inspection targets remain available.

## Evidence

- Four curve tests cover endpoints, plateaus, steep irregular observations, no overshoot, singleton/empty input and duplicate timestamps. Together with axis and snapshot tests: **39 tests / 3 files passed**.
- TypeScript passed. Production build passed. Browser workflow and profiling run passed, including window switching, selected readings, both-axis navigation, native CDP touch, narrow/short/light states, long tooltips, errors and settings.
- Independent scoped review found no material curve/memo/formatting issue; deferred rendering review is recorded separately in the handoff.
- `before-smoothing.png` is the prior committed fixture at 1280×900. Updated `many-accounts.png`, `default-weekly.png` and `hover.png` are real component renders with synthetic data.

Profiling is opt-in: set `CCDECK_HISTORY_PROFILE=1` alongside the existing review origin, Playwright module and Chromium executable when running `scripts/verify-account-history.mjs`. No runtime profiler or dependency was added to the shipped application.

Limitations: development-build timing and one controlled workstation/browser; no low-end physical-device, Safari/Firefox, full screen-reader or live-provider correctness certification. Raw readings and business logic are unchanged.
