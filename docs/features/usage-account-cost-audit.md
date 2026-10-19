# Usage account and Auto-review cost audit

The change fixes two independently reproduced errors: independent Claude
transcript roots inherited one global account timeline, and confirmed ChatGPT
Auto-review tokens were incorrectly described as having unknown prices.

## Required behavior

- Scope new Claude swap/start/stop records to the canonical projects directory
  controlled by that process. Deduplicate aliases of the same physical root.
- Attribute messages only against the timeline for their root. Preserve every
  token whose account cannot be proven in the existing unattributed bucket.
- Rebuild version 7 and earlier rollups, preserving downtime fences. Changing
  configured roots invalidates cached cursors/tallies, without moving history
  onto the new primary root. Folder recovery is isolated by root too.
- Old swap records contain no directory identity. Their historical usage must
  become unattributed on rebuild; do not guess their directory from the current
  process environment. New scoped anchors resume attribution going forward.
- Recognize only `codex-auto-review` with nonempty `creator_account_id` and
  eligible timestamps as no-charge. Keep tokens, and keep uncertain models,
  authentication and historical intervals unpriced. Mixed free/unknown usage
  must still disclose the unknown portion on cards and board model rows.
- Never zero the model globally or change ccusage's reported historical costs.

## Pricing evidence and limits

[OpenAI's plan documentation](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
says Auto-review safety checks are free when signed in with ChatGPT. Native
[Codex SessionMeta](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)
defines `creator_account_id` as the ChatGPT account at thread creation. This is
local evidence of creation authentication, not an invoice or proof of a later
login change. Older/missing metadata is not inferred from the current login.

The October 6 announcement does not establish an exact historical billing
cutover. The conservative boundary is October 7, 2026 at 00:00 UTC; October 6
remains unknown. A cumulative snapshot spanning the boundary is not retroactively
made free. Only subsequent observed increments with eligible interval evidence
receive the no-charge share. The policy is shared by scanner and client pricing;
normal model and speed prices are unchanged.

## Validation

Regression coverage exercises independent roots, root order changes, scoped
switches, legacy cache rebuilds, root aliases, missing authentication, the
historical boundary, and mixed free/unknown model rows. Existing incremental,
streaming/replay, pricing and card suites remain required, with typecheck/build.
