# product-ui-craft skill

Created 2026-10-13 on `feat/product-ui-craft`, independently of the capacity reliability audit. No merge or Impeccable modification.

## Package

`.agents/skills/product-ui-craft/` is the portable, repository-trackable package:

- `SKILL.md`: 60-line entrypoint, triggers, modes, scope, proportional workflow and stop gate.
- `agents/openai.yaml`: Codex display name, concise description and explicit invocation prompt; implicit invocation remains enabled by default.
- `references/workflow-modes.md`: new feature, redesign, polish and final gate; targeted-fix shortcut and representative cases.
- `references/ux-review-rubric.md`: thirteen dimensions, evidence/impact/verification and nonnumeric severity.
- `references/impeccable-integration.md`: version-aware discovery, problem-to-workflow routing and independent fallback.
- `references/visual-iteration.md`: real application capture, matched viewport/state comparison and bounded confirmation.
- `references/frontend-quality-gates.md`: proportionate engineering, accessibility and release verification.
- `references/design-anti-patterns.md`: practical guards against cosmetic loops, misleading states and ineffective density.
- `references/installation-and-validation.md`: portable/global installation and honest validation limits.
- `assets/design-review-template.md`: findings ledger, copied only when useful.
- `assets/final-report-template.md`: concise evidence-backed handoff scaffold, not mandatory formatting for tiny fixes.

A user-level link was installed in the discovered `~/.agents/skills/product-ui-craft` root. The link resolves to this checkout; retain the checkout or replace the link with a copy for independent distribution. New sessions may be needed to refresh skill discovery. Installation does not demonstrate automatic client routing.

## Relationship to Impeccable

Read the installed **4.1.1** instructions and supported command table. The package orchestrates product judgment and engineering evidence; it does not copy specialist implementation. It verifies the actual installed workflow/version each time integration context changes. `craft` is treated as deprecated in the observed installation, not as a guessed executable. Without Impeccable, the skill's own rubric and rendered/engineering gates remain usable.

Examples: `$product-ui-craft redesign this difficult inspector`; `$product-ui-craft polish this existing modal without changing structure`; `$product-ui-craft perform a final release gate`; `fix this button's changing width`. Backend-only audits are explicitly excluded.

## Validation executed

The current [official Agent Skills specification](https://agentskills.io/specification) was inspected. Its reference library was fetched through uv from official repository commit `69ef37e9424c0a7ea9dd2293b559e43ec8176379`, using `#subdirectory=skills-ref`. No project dependency was added.

- Skill creator: `uv run --with pyyaml python <installed-skill-creator>/scripts/quick_validate.py .agents/skills/product-ui-craft` — exit 0, “Skill is valid!”.
- Official: `uvx --from 'git+https://github.com/agentskills/agentskills.git#subdirectory=skills-ref' skills-ref validate .agents/skills/product-ui-craft` — exit 0, valid skill.
- Local Markdown path check: eight local references resolve; 60 entrypoint lines; no scaffold placeholders.
- User installation: linked entrypoint exists and resolves to the complete package.
- Independent read-only evaluator: monitoring and radio requests routed to redesign B; mature scheduling request to final gate D; jumping mute label to targeted C; backend race audit to no activation; optional Impeccable absence to standalone polish C. Six supplied cases passed the intended routing. These initial cases had answer cues in package examples, so they establish instruction-following rather than blind generalization.
- Transfer test: checkout contrast → targeted C; new approval admin tool → A; finished settings release review → D with zero edits allowed; Terraform timeout → no activation. Four novel cases demonstrated proportional scope and optional checks. The evaluator checked links independently.

The evaluator identified ambiguous targeted-mode/check scope and evidence-free simulation verdict wording. These were clarified before final validation. No UI, browser application or provider correctness was tested as part of these routing simulations, and no automatic client trigger behavior is claimed. This skill task does not warrant the application's TypeScript/build suite because it changes only the portable instruction package.

## Remaining limitations

Discovery/automatic activation should be checked in a refreshed target-agent session. Model-based forward-testing is not a guarantee for all agents or future Impeccable versions. Rendering tools and project checks remain environment-dependent. No skill can certify live data correctness from visual fixtures.
