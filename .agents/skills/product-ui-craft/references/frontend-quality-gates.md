# Implementation and release gates

Inspect framework, state owners, data contract, shared components, token roles and relevant tests before editing. Keep business logic and selection ownership stable unless a verified defect requires a focused change. Avoid duplicate derived state, unnecessary timers/dependencies and unrelated refactors.

Verify loading, empty, error, partial and uncertain data without healthy-looking defaults. Reported, predicted and confirmed are different. A visual choice must not redefine usage, freshness, availability or monitoring status. Hand material correctness concerns to regression-backed engineering verification.

Use semantic controls, accessible names and appropriate selected/expanded semantics. Check keyboard sequence, Escape, focus restoration, disclosures, hover versus focus-visible, disabled/loading behavior, touch targets, contrast and reduced motion. Never globally disable focus outlines. Tooltips cannot be the only way to access critical information.

Verify the actual supported themes and viewport classes relevant to the change. Keep one predictable scroller where practical, but do not impose it on layouts whose workflows need separate regions. Test content growth, localized labels and long identifiers. Preserve critical actions across breakpoints.

For implementation or release review, run the checks warranted by the changed surface. A tiny CSS-only fix normally needs measured browser confirmation and the project-required build/checks; do not invent a unit test that mirrors styling or run unrelated integration suites. State why optional checks were omitted. TypeScript/state changes require typecheck and relevant behavior tests; shipping gates require production build. Run available typecheck, production build and relevant unit/integration/browser tests at that proportional scope. Add tests for meaningful behavior and reproduced regressions, not copies of CSS implementation. Record commands, exit codes and failures. Investigate baseline/runtime failures rather than silently widening tests or claiming success.

**SHIP:** no significant known defect, relevant checks passed, evidence supports readiness.
**SHIP WITH FOLLOW-UPS:** only explicit nonblocking improvements or bounded verification gaps remain.
**NOT READY:** a primary task, semantic correctness or essential accessible behavior has a verified blocker, or necessary verification is unavailable at a risk level that prevents responsible sign-off.

A limited contrast sample, synthetic browser run or accessibility scanner is not certification. Separate tested behavior, live integrations and unverified platforms. Shipping a UI is not authorization to merge, publish or deploy.
