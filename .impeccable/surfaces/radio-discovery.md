# Radio discovery

Mode: Operate. Scope: RadioPanel discovery column and RadioFilter. Preserve
player/map/modal geometry, source playback, persistence, row actions, theme
system and the owner's removal of Cafe Music BGM and Best of Nostalgia.

## Audit and direction — 2026-10-13

Method: single-context; this harness exposes no subagent/spawn tool. Impeccable
critique and finish review use the documented fallback. Questions skipped:
the owner supplied the flows, visual constraints and permission to implement.

Five priorities: fragmented toolbar; misleading Sound terminology (directory
`tag`); no individual filter removal; mixed result totals presented as stations;
unknown workspace metadata hidden without explanation. Additional correctness
finding: GLOBAL was sent as GL (Greenland) by the server's country-code truncation.

Alternatives: (A) search and one Filters action maximizes list space but adds a
step to every country change; (B) all three filters always visible is efficient
but repeats a generic form row and reduces narrow-window list space. Selected
hybrid: integrated collection tabs, search and Filters, Country directly visible
in wider discovery panels, optional full filter row, persistent removable filter
indicators. Genre names directory genre/topic tags; arbitrary tags/languages
remain supported through the shared searchable filter popover.

## Source contract

Search includes directory stations and workspace stream names. Directory search
uses the existing Radio Browser `name` query. Country, genre/tag and language
use actual directory metadata. Workspace streams have no geographic country,
genre or language metadata; they match no metadata filters except the existing
Global streams pseudo-country. Global is local-only and never sent to the API.
Favorites and Recent share IDs across both kinds. Counts are derived from visible
unique entries, not the 300-entry API cap or the featured daily row. Removed or
unresolved IDs do not inflate collection badges. The map gets only filtered
directory stations; its existing current-station pin is retained. Workspace
streams never acquire coordinates. Source headings explain mapping and unknown
metadata instead of adding per-row badges.

## Composition and behavior

Compact tabs with semantic tab roles, roving focus and Arrow/Home/End navigation.
Search remains available with clear action; collection changes retain search and
filters. Clear filters retains the search; clear search is separate. Filter chips
remove one metadata criterion and expose its full value through accessible text.
Country is quick-access on wider panels; narrower panels use Filters to reveal
all fields. Touch targets are at least 44px in the discovery toolbar. One results
scroll area; short windows retain the existing whole-discovery scroll behavior.
Workspace streams are a collapsible first section, radio results a second section
with the daily pick inside it. Summary distinguishes stream and radio counts.
No colored side stripes, gradients, decorative motion or new dependencies.
