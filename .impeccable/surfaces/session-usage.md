# Session usage

Mode: Operate. Expands the existing Usage panel without replacing its visual language.

The reader opens Usage → By session, then selects a Claude or Codex row. A visible
chevron and hover fill mark these rows as controls. Historical rows work without
a live canvas node. Other providers keep their existing display-only rows.

The focused report composes the shared modal shell and portals to document.body,
so the panel's scrolling and entrance transform cannot clip it. Close receives
focus; Tab stays inside; Escape restores the opener when it still exists.

First viewport: session identity and whole-session scope, Codex's pricing selector
when applicable, estimated cost and total tokens, four token counters, then models
and dates. Use two columns for the headline and token counters; pricing controls
and dates wrap at narrow widths. Long model IDs and session IDs wrap. The body
scrolls within the shared shell at short heights.

Use existing panel/text/control tokens, 14px dialog title as in Usage history,
12px body/data, 11px table annotations and 22px headline measurements. No new
palette, shadows or animation: the modal shell owns depth and motion, and the
global focus ring owns focus. Source: SessionUsageModal.tsx and session-usage.css.

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
