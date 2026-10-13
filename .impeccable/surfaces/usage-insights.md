# Usage insights — issue #2121

Mode: Operate. Shipped behavior after final reviewer disposition: ship
(2026-10-13). Extends the incumbent Usage/session reports; inherits DESIGN.md
and the session-usage surface contract.

## Surface and visual contract

Usage exposes Quota history for configured Claude/Codex providers alongside
the existing Cost history action. By session opens the existing whole-session
inspector for Claude/Codex rows; Cached input reuse sits in Token breakdown,
before the composition bar and labeled counters.

Both reports compose the shared modal-head/body shell and portal to document.body.
Close receives initial focus, Tab stays inside, Escape dismisses and focus returns
to the opener when it survives. The body scrolls at short heights; Close remains
available in loading, error and empty states.

Reuse existing theme surface/text/control tokens, global focus ring and shell
depth/motion. Titles are 14px, body/data 12px, annotations 11px and headline
measurements 22px, with tabular numerals. No new visual world, token palette,
motion or typography primitives.

Quota width is min(640px, 94vw); session width is min(560px, 92vw). At widths
up to 420px, quota controls stack, the window selector fits the available width,
session token counters become aligned rows and the pricing selector fills its
row. Quota percentage/time labels are HTML outside the responsive SVG, retaining
11px text as the plot shrinks. Session headline totals retain two columns.

## Quota history

- Provider buttons expose selection with aria-pressed; Window names the quota
  window and reset timestamp. Account identity must come from a current quota
  reading. Unknown identity shows its own empty explanation; providers, accounts
  and reset episodes remain separate.
- The headline shows observed remaining quota and the original capture age,
  including “window ended” when applicable. Observations end at the last capture;
  gaps longer than ten minutes stay unconnected. The accent curve and dashed
  even-use guide have separate legends. The visible caveat and chart accessible
  name identify the guide as a reference, not a forecast.
- “Recorded readings” discloses timestamps and remaining percentages, newest
  first, capped at the latest 50 with an explicit caption. “Recorded” describes
  captured observations without promising disk persistence. Storage failure
  explicitly says history is available for this run but could not be saved to disk.
- Opening and Refresh read the local snapshot, without provider requests, OAuth
  refresh or quota CLI work. While open, visible-page reads recur every minute;
  hidden pages skip those reads. Close/provider/account changes cancel stale
  requests. Load failure offers Refresh and names last loaded history if retained.
- Quota Refresh stays focusable and exposes aria-busy. A synchronous ref guard
  rejects repeat activation before React renders, allowing only one pending read;
  do not replace it with a state-only or disabling guard.

## Cached input reuse

Reuse is `cacheReadTokens / (inputTokens + cacheReadTokens + cacheCreationTokens)`
as a percentage of measured input, using ccusage's normalized non-cached input.
Output/reasoning are excluded; raw Codex input_tokens includes cached input and
cannot replace this normalized counter. All three counters must be present,
finite and nonnegative for a measurement.

Keep coverage visible: “N of M usage records measured” for Claude, “N of M model
groups measured” for Codex. Measured zero reuse displays 0%; missing measurements
display “—” and “No cache measurements available”. Measured zero input displays
“—” with coverage and “no input tokens”. Partial coverage is not a whole-session
measurement. The four-counter composition bar remains a separate calculation;
reasoning stays included in output.

The whole-session scope and estimate caveat remain visible; pricing assumptions
and Session ID remain disclosures. Session reads are manual; loading disables
its Refresh/pricing selector, and pricing changes clear prior results and cancel
stale requests. Preserve the existing scenario-versus-billing distinction.

## Evidence and handoff

Ground truth: src/web/components/QuotaHistoryModal.tsx, UsagePanel.tsx,
SessionUsageModal.tsx and src/web/styles/quota-history.css, session-usage.css.
Feature mechanics, persistence limits and verification are recorded in
[usage-insights.md](../../docs/features/usage-insights.md); existing session
guidance is in [session-usage.md](session-usage.md).

Accepted implementation verification (not rerun for this documentation handoff):
266 targeted tests across 22 files, TypeScript and production build passed;
browser checks covered nine themes at 1280/390/320px plus states/interactions.
Ten synchronous quota Refresh activations produced one request and retained focus.
Review images: [quota desktop](../review/usage-insights/quota-1280-dark.png),
[quota narrow](../review/usage-insights/quota-320-light.png),
[session narrow](../review/usage-insights/session-390-normal.png).

Predictive exhaustion alerts and latency/throughput are outside this surface.
