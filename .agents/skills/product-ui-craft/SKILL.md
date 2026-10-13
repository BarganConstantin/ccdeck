---
name: product-ui-craft
description: Design, redesign, polish, and release-review real product interfaces. Use for improving UI/UX, modal usability, visual hierarchy, screenshots, frontend craftsmanship, or responsive behavior. Select a proportional workflow and verify implementation in the rendered app. Not for backend-only debugging, business-logic audits, migrations, or infrastructure work.
metadata:
  version: "1.0.0"
---

# Product UI Craft

Turn a UI request into a justified product decision, working implementation, and evidence-based handoff. Specialized design skills are collaborators, not the process itself. The current user's scope and approval always govern; loading this skill does not authorize publishing, external messages, account changes, or merging.

## Route the work

Read [workflow modes](references/workflow-modes.md) and choose one mode. State the mode and preserved constraints briefly; do not produce a lengthy plan for a small defect.

- **A — New feature:** the interaction and structure need definition.
- **B — Redesign:** evidence shows the current structure prevents user jobs.
- **C — Polish:** useful structure exists; refine its visual and interaction quality.
- **D — Final gate:** verify shipping readiness, fix meaningful defects, then stop.
- **Targeted fix:** an execution shortcut within C/D; diagnose the single cause, fix and verify. Do not run a full redesign cycle.

For targeted fixes, choose C unless the request is explicitly a release review (D). Read-only critiques and workflow simulations report findings and verification limits; they do not invent a shipping verdict without product evidence.

A backend-only request is outside scope. If a UI task uncovers incorrect data, report and reproduce it at the relevant engineering boundary; visual approval never certifies the data pipeline.

## Shared working sequence

1. Inspect the real component, state/data owners, existing behavior and tests. Read project instructions and available product/design docs; inspect at least one actual shared component and its tokens. Filenames such as AGENTS.md, PRODUCT.md and DESIGN.md are possible sources, not prerequisites. Preserve the project's own identity, framework and conventions.
2. Name the primary user job, the next useful action, relevant uncertainty, and the tested states. Establish what is implemented versus proposed. A screenshot alone does not establish functionality.
3. Use [the review rubric](references/ux-review-rubric.md) to produce a bounded backlog, normally at most five high-impact findings. Separate verified defects, risks and taste preferences. For redesign/new work compare credible compositions; for polish/final gate justify every structural change.
4. When Impeccable is installed, discover its actual version and read the owning workflow using [the integration guide](references/impeccable-integration.md). Execute only workflows tied to a finding. With no Impeccable, the rubric, rendered review and engineering gates remain fully usable.
5. Implement the smallest coherent solution to the chosen direction. Reuse suitable controls and tokens, semantic HTML and current state ownership. Keep real actions discoverable and retain honest unknown/stale/estimated states. Ordinary spacing, icon and type decisions are autonomous; ask only about unresolved material product behavior, destructive actions, or privacy/security implications outside existing authorization.
6. Use [rendered iteration](references/visual-iteration.md): record the baseline, render working changes, compare identical viewports, and test interactions and edge cases in a batch. Fix observed regressions before confirmation. If a browser is unavailable, record that limitation and never claim screenshots or visual verification.
7. Run [frontend quality gates](references/frontend-quality-gates.md), review the final evidence, and stop. Use the [report template](assets/final-report-template.md) only to the level the work warrants; small fixes need a short paragraph, not a dossier.

## Judgment rules

- The three-second check asks whether purpose, state and next action are apparent. Test it against the rendered composition; it is a heuristic, not a measured usability-study result.
- Density follows user tasks and content. Inspect computed row/grid heights and scroll ownership before reducing padding or expanding a modal.
- Contrast, hierarchy and optical alignment can create character without extra widgets. Premium means useful precision, not decoration or sterile removal of everything.
- Pointer focus and keyboard focus are different. Keep clear focus-visible treatment; never remove outlines globally. Test programmatic restoration, reduced motion, hidden/expanded states and changing data.
- Never invent a provider capability, location, schedule, progress value, freshness guarantee or success state to improve a screenshot.
- Before further changes, consult [failure patterns](references/design-anti-patterns.md) if iteration is repeating or solving one defect creates another.

## Budget and stop gate

Scale work to the request: targeted defect = one cause/fix/verification; polish = critique plus one rendered batch and, when justified, a fix/confirmation; redesign = discovery/alternatives/full implementation plus bounded rendered refinement; final gate = audit, fix proven issues, validate, stop. Respect a delegated workflow's stricter budget. A failed check or newly demonstrated defect can justify another bounded round; subjective preference does not.

Stop when primary jobs are clear, hierarchy coherent, tested interactions/responsive states usable, accessibility checks pass at their stated scope, and no significant known regression remains. Explain each unverified area and, for implementation/release work with product evidence, give **SHIP**, **SHIP WITH FOLLOW-UPS**, or **NOT READY**. Read-only simulations report routing and limits instead. Do not substitute arbitrary scores or limited automated checks for evidence. Keep backend correctness and live-integration confidence separate from UI sign-off.

## Examples and reuse

- “Design the account-switching interface” → A.
- “The map is too small to explore” → B, with map and existing playback state preserved.
- “Polish typography and focus states” → C.
- “This already works; is it ready to release?” → D.
- “The mute label changes button width” → targeted fix.
- “Audit cache races and API parsing” → engineering work outside this skill.

Read [installation and validation](references/installation-and-validation.md) to install across projects or forward-test routing. Do not overwrite another skill or edit Impeccable.
