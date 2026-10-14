# History experience redesign

## Baseline findings

- Major: two graphs, repeated selectors and repeated explanatory copy require scrolling before a comparison is complete. Evidence: current 1280×900 capture fits only the first window. Job: compare accounts quickly.
- Major: long account legend dominates the top while contributing no readings. Account identity should be adjacent to the visualization, with a useful latest-observation value.
- Major: native SVG titles delay feedback and cannot establish which reading is under inspection. Use an immediate tooltip with account, actual observation time and remaining capacity.
- Minor: selection feels detached from the graph; the observation dropdown is the primary inspection mechanism. Keep it as a keyboard-accessible secondary inspector, with direct pointer inspection primary.
- Minor: technical explanations compete with navigation. Preserve honest uncertainty, but consolidate explanations into progressive disclosure.

## Composition alternatives

1. Comparative canvas: one large chart, a 5-hour/7-day window switch, adjacent account list with latest recorded remaining values, direct hover inspection. Fast comparison, less scrolling, established task and existing data model preserved.
2. Account-first inspector: select an account, see both windows as compact charts and a chronological reading table. Strong detail investigation, but defaults away from the owner's explicit all-account comparison workflow.
3. Small multiples: one sparkline per account with a global time scale. Separates overlapping curves, but makes account-to-account point comparison harder and multiplies charts/rows for twelve accounts.

Preferred: comparative canvas. Preserve the existing ccdeck identity and all-account comparison, do not add provider capabilities or infer current capacity from old observations. Latest list values must be labeled as recorded, not fresh. Existing collection, retention, errors and modal focus remain unchanged.
