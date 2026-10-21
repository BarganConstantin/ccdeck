# Radio discovery composition

Mode: Operate. Scope: right discovery column. Keep CCDeck's incumbent tokens,
shared controls and typography; preserve map, player and modal design.

## Audit and spatial thesis

Five priorities: workspace rows hid radio results; Country competed with search;
filter access changed by panel width; counts/grouping duplicated explanation; and
short windows needed a dependable results scrollbar plus source access.

Independent design and mechanical/accessibility assessments used Impeccable
critique/layout. No product context reinitialization or identity replacement.
Questions skipped: the owner supplied scope, goals, constraints and autonomy.

Compared A, search-first + unified Filters, with B, full-width search + directly
visible country/genre/language. B reduces one disclosure click but permanently
consumes a form row and compresses mobile results. Choose A consistently at all
widths: one stable search row and one filter entry, searchable in-place field
selection in a shared popover, criteria/removal and clear action outside it.

## Composition and source hierarchy

Compact Discover/Favorites/Recent segmented navigation, growing search plus
Filters, applied criteria, radio-first scrollable results, persistent Workspace
streams footer disclosure. No extra source navigation mode or competing vertical
scroll areas. Opening streams reveals the collection/current row in that same
list; closing returns to the prior directory scroll position. Daily remains on
normal screens and is omitted in short windows; its station remains in results.

Workspace expansion is remembered per collection. Search/Global/stream-only
results reveal streams contextually, without overwriting the ordinary preference.
Filtering can exclude streams but never removes their disclosure. It reports the
matching count, shows Filtered when appropriate, and explains exclusions when
opened. Only an explicit Show all streams clears search and metadata. An empty
Favorites/Recent collection offers explicit Browse workspace streams to Discover.

## Truth and interaction contract

Search includes both sources. Directory uses the existing API name query and
local matching; stream names/source text match locally. Country/genre/language
use real directory metadata. Streams lack geographic/genre/language data; only
Global matches their country scope. Global is local, never sent as GL to the API.
Missing metadata never satisfies a nonempty filter. Favorites/Recent share
persisted IDs; dynamic counts exclude unresolved IDs and daily duplication.
Only directory entries with real coordinates appear on the existing map.

Tabs retain criteria and use roving focus plus Arrow/Home/End. Clear filters
retains search; Clear search is separate. Selected filter values and full labels
remain readable; default values do not pretend to be selections. Popovers remain
inside Radio's aria-modal accessibility boundary, Escape returns to Filters,
and clearing inside the popover focuses Done. Pointer interaction keeps restrained
focus treatment; keyboard rings remain explicit. Narrow/coarse controls are 44px.
At short mobile sizes criteria use one horizontal strip with accessible Clear,
leaving one vertical results scrollbar. Preserve shared scrollbar focus contrast.

Saved station aliases apply consistently to Discover, Favorites/Recent and the
daily pick. Playback lifecycle/persistence never depends on result visibility.
No new dependencies, gradients, colored side stripes or decorative animation.
