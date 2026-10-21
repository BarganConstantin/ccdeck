# Installation and validation

This folder is the portable skill package. It follows [Agent Skills](https://agentskills.io/specification) and adds optional Codex UI metadata under agents/openai.yaml. It has no mandatory dependency on Impeccable, a framework or product-specific files.

For repository use, place the folder under the agent's discovered project skill directory (Codex commonly uses .agents/skills). For cross-project use, inspect the current agent's supported user skill roots first. Codex's skill-creator supports ${CODEX_HOME:-$HOME/.codex}/skills; this environment also discovers ~/.agents/skills. Copy the whole folder into one supported root, or link it to a stable checkout. Do not install duplicate copies or overwrite an existing skill. A link requires that checkout to remain available; a copy needs deliberate updates. Reload the agent/session if discovery is cached.

Example, after confirming the destination is supported and unused:

```sh
skill_source=.agents/skills/product-ui-craft
skill_destination="${CODEX_HOME:-$HOME/.codex}/skills/product-ui-craft"
test ! -e "$skill_destination" && test ! -L "$skill_destination" && cp -R "$skill_source" "$skill_destination"
```

Invoke explicitly with `$product-ui-craft`, or use the natural-language requests listed in SKILL.md. Invocation availability should be checked in the refreshed catalog; a valid folder alone does not prove automatic routing.

Validate with installed skill-creator's quick_validate.py and official `skills-ref validate <skill-folder>` where available. These check packaging, not design judgment. Check every local Markdown reference resolves, metadata names match the directory, templates contain no private data and no scaffold instructions remain.

Forward-test realistic requests in a read-only isolated workspace: monitoring inspector, constrained radio map, mature scheduling release review, one jumping control label and backend-only cache work. Ask an independent evaluator to choose mode, first steps, evidence, stop conditions and whether to activate, without giving expected answers. Compare its decisions with workflow-modes.md; record actual results and limitations. Also test the same UI request with Impeccable unavailable. Model-based routing tests are not proof of automatic activation by every client; retain that distinction.
