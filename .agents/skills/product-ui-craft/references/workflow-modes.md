# Workflow modes

| Mode | Question that drives decisions | Deliverable and guardrail |
|---|---|---|
| A New feature | What interaction lets the user complete this job? | State/data inventory, credible information architecture alternatives where complexity warrants, chosen direction, implementation and rendered verification. Do not invent capabilities. |
| B Redesign | Which existing structure creates measurable friction? | Baseline, prioritized defects, alternatives with scanning/interaction/responsiveness tradeoffs, strongest implemented composition. Preserve working behavior, replace weak layout when evidence supports it. |
| C Polish | What prevents the useful structure from feeling clear and coherent? | Focused type, contrast, spacing, surfaces, geometry and states. Preserve architecture; structural adjustments require a concrete problem. |
| D Final gate | Which verified defects prevent shipping? | Read-only first, bounded fixes, regression and rendered confirmation, explicit verdict. Do not manufacture work to demonstrate activity. |

A targeted fix uses C/D without the alternative-concept exercise: reproduce the exact pointer/keyboard/layout defect, identify its real cause and verify that fix. Discovery should be sufficient to avoid breaking adjacent behavior, not a whole-product audit.

For A/B, compare at least two credible compositions when the information architecture is genuinely open. Evaluate hierarchy, scanning cost, interaction count, data density, responsiveness and implementation risk. Choose one; do not ship competing modes without a demonstrated need. If the user pins a structure, work within it unless evidence exposes a concrete failure.

For C/D, compare proposed change against the incumbent. Ask: what problem, which users, what evidence, added complexity, how verified? Negligible benefit means no edit.

## Scenario routing checks

Use these as review cases, not new implementation tasks:

- Technical monitoring inspector: unclear statuses and repetitive content → B; trace status semantics and distinguish active capture from configuration before reorganizing.
- Radio map squeezed above results: poor geographic selection and crowded player → B; map dimensions/hit targets plus selected-versus-playing state, background playback, failure and narrow windows.
- Mature scheduling modal: compact layout already works → D (or C when explicitly polish); verify day/category filtering, reported-time uncertainty, focus and scrolling. Do not replace its architecture.
- Single control jumps when its label changes → targeted C/D; reproduce measured width, maintain accessible labeling and both states.
- Database/cache correctness audit without UI implications → no activation; use the engineering workflow, even if the code happens to feed a dashboard.
