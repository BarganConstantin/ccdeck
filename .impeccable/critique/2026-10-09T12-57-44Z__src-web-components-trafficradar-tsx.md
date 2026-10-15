---
target: Telemetry Radar final refinement
total_score: 28
max_score: 40
na_heuristics: ""
p0_count: 0
p1_count: 2
timestamp: 2026-10-09T12-57-44Z
slug: src-web-components-trafficradar-tsx
---
# Telemetry Radar refinement critique

Target: current inspector, evaluated before this polish pass. Independent UX assessment and browser assessment were combined; the detector ran once with zero findings. This remains ccdeck’s existing visual world, not a new dashboard.

## Heuristics

| Heuristic | Score / 4 |
|---|---:|
| Visibility of system status | 3 |
| Match with developer expectations | 3 |
| User control | 3 |
| Consistency | 3 |
| Error prevention | 2 |
| Recognition over recall | 3 |
| Efficiency | 3 |
| Minimal presentation | 2 |
| Recovery guidance | 3 |
| Help | 3 |

Total: 28/40 for the starting implementation, not a measured post-fix score.

## Priority findings

1. Activity rows spend four lines repeating unreadable-content labels, making history slow to scan. Compact rows and distinguish decoded exports from socket observations.
2. Continuous monitoring and unavailable-content explanations repeat across toolbar, list and inspector. Retain one short diagnosis plus disclosed protocol details.
3. Destination copy feedback survives switching observations. Reset it on selection and expire success feedback.
4. Clear messages actually removes observations too. Name it Clear history and require a deliberate confirmation with the existing armed-press convention.
5. Browser verification found Tab escaping from Monitoring limits and reverse wrapping to an invisible scroll stop. Exclude hidden overflow regions from modal focus stops.
6. Independent finish review found mobile arrow selection activates the inspector focus transfer. Select directly during arrow navigation; reserve inspector reveal for explicit activation.

## Craft and persona observations

The topology is useful and recognizably ccdeck. Oversized rows, browser-default selects, competing action borders and inconsistent insets leave the surface feeling unfinished. Developer trust depends on keeping listener readiness, observed traffic, decoded exports and collector receipts separate. No real decoded Claude payload was observed during verification; JSON fixtures must remain labeled as fixtures.

## Minor refinements

Use native selects with authored geometry/chevrons, neutral utility actions, subdued Beta, aligned destination facts, larger copy/close/disclosure targets and reduced-motion feedback. Preserve meaningful metadata and bounded history rendering.

Questions skipped: the user explicitly authorized scoped refinement and instructed us not to ask about minor styling or component decisions. Those instructions take precedence over critique’s interview step.

## Resolution

All listed issues implemented. Independent finish-review scoring and exact checks are recorded in the Radar surface brief. This document records the baseline critique; it does not invent a final heuristic score.
