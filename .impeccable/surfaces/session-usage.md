# Session usage

Mode: Operate. Expands the existing Usage panel without replacing its visual language.

The reader opens Usage → By session, then selects a Claude or Codex row. A visible
chevron and hover fill mark these rows as controls. Historical rows work without
a live canvas node. Other providers keep their existing display-only rows.

The focused report composes the shared modal shell and portals to document.body,
so the panel's scrolling and entrance transform cannot clip it. Close receives
focus; Tab stays inside; Escape restores the opener when it still exists.

First viewport: session identity and whole-session scope, Codex's pricing selector
when applicable, estimated cost and total tokens, token composition, then models
and dates. Use two columns for the headline and token counters on desktop; at
narrow widths counters become aligned rows with count and percentage. A single
stacked bar uses the existing usage-series tokens and is accompanied by labeled
values: colour alone carries no information. Its denominator is the sum of the
four reported counters, with reasoning already included in output. Dates use
named months, with exact local timestamps on hover. Long IDs wrap; the body
scrolls within the shared shell at short heights.

Use existing panel/text/control tokens, 14px dialog title as in Usage history,
12px body/data, 11px table annotations and 22px headline measurements. No new
palette or shadows: the modal shell owns depth and entrance motion, and the
global focus ring owns focus. Source: SessionUsageModal.tsx and session-usage.css.

Keep the short estimate/scope caveat visible. Put the full pricing explanation
under “Estimate details”, alongside the existing Session ID disclosure, so the
reader sees the measurements before the methodology. This uses progressive
disclosure as described by https://www.nngroup.com/articles/progressive-disclosure/.
Chart selection was checked against https://www.carbondesignsystem.com/building-blocks/data-visualization/overview.
No chart dependency is needed for four proportional segments.

Cost is an estimate from ccusage. Auto may use current config when recorded Codex
tiers are absent; explicit Standard/Fast/Flex selections are scenarios and do
not change settings or billing. Keep that distinction visible. Whole-session
figures can differ from the selected period. Missing per-model dollars are not
reconstructed from standard rates. Zero reported cost with nonzero tokens says
“No cost reported”; known missing model pricing marks the estimate as partial.

Loading, error, empty and retry states retain Close. Loading disables Refresh and
the pricing selector. Changing mode clears old results, cancelling stale browser
requests. Reads are manual, share the bounded history queue/cache and send neither
prompts nor tool contents to the inspector.


## Loading refinement — 2026-10-19

The occasional session read shows a compact transcript illustration with one
6px reading stroke, 1400ms indeterminate cadence, no fabricated token or cost
values. It pauses while the document is hidden and becomes static under Reduce
Motion. Report content has one 120ms opacity arrival (.7→1), without moving
numbers or token proportions. Existing refresh, failure, pricing mode, footer,
focus and request cancellation behavior is preserved. There is no forced wait
or new dependency. This is item 2 in docs/features/animation-opportunities.md.
