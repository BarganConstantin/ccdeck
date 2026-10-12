# Radio explorer

Radio is a canvas companion: open Radio on the right sidebar beside the character’s head to discover stations on a world map, filter by country, genre or language, save favorites, revisit recent listening, or choose a daily/random station.

## Reference and implementation

[Radio Island](https://radio-island.party/) inspired the map and compact listening workflow. Its public [release repository](https://github.com/gentilfp/RadioIsland-releases) distributes the native app; the native source was not available in the repository inspected. This feature uses ccdeck's own components, theme tokens and existing player rather than copying its native interface or brand assets.

Station discovery uses the [Radio Browser API](https://docs.radio-browser.info/). The ccdeck server discovers directory mirrors, restricts requests to their API hosts, tries up to three mirrors, and caches bounded search results for ten minutes. Each query returns at most 300 stations; filters discover stations beyond the initial popularity list. Only HTTPS audio streams are offered. A station selection reports its ID to Radio Browser's popularity endpoint, once per server session.

The map uses bundled [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/) public-domain country geometry. No map service or tiles are needed. Stations without coordinates remain available in the list. Directory positions are approximate, not verified broadcast locations. The count distinguishes mapped entries from all results; selected/current pins outside the results are disclosed separately. Camera regions never silently filter results. Drag, scroll, double-click or pinch to explore; arrow keys pan, +/− zoom and Home restores the world. Nearby and coincident positions form clusters with a compact station chooser. Selected and playing states remain visible on clusters.

The explorer opens in a centered modal with a lightly blurred backdrop, bounded by the viewport (maximum 1200×800px). Desktop uses an approximately 61/39 map/discovery split with one persistent player. Narrow windows switch between Map and Stations; short narrow windows scroll filters and results together. Selecting a marker or station row inspects it without starting audio; Play is explicit, and Locate moves the map only when requested. Mobile inspection stays in the current Map or Stations view and transfers focus to Play. Details use a reserved dock rather than covering the map; short windows use a single compact action strip. Expand reveals metadata and Locate. Dismiss keeps the selection and returns focus to the map or search, with a way to reopen details. Escape, the close button or a click on the backdrop dismisses it.

Desktop playback uses three balanced groups: station identity, centered Previous/Play/Next and Favorite, then volume/Mute/Surprise me. Previous and Next follow the current Discover/Favorites/Recent list and filters, wrap at either end, and start at the appropriate end if the current station is outside the results. Empty results and an already-current sole result disable navigation. Regions share one horizontally scrollable map toolbar. Country flags use platform emoji rendering, with a radio fallback for missing country codes. The daily station is one compact row and exposes the current Play/Pause/Retry action. Requested footer captions remain removed; directory/projection attribution is retained in this documentation.

## Playback and local state

One player serves the character and explorer. Hiding the character or closing Radio keeps music playing. Reload restores the selected station without autoplay. Native audio streams connect directly from the browser to the broadcaster; HLS uses the existing lazy-loaded player support. The directory’s explicit HLS flag is preserved locally and identifies extensionless streams; URL-based detection still supports manually added .m3u8 streams. Explicit directory playback refreshes cached format data while preserving personal station names, and resuming a changed current station makes a new playback request. Saving a favorite never triggers a stream refresh. Failed streams can be selected again to retry.

Favorites, recent station IDs and the last unfiltered catalogue are stored locally. Favorites retain station metadata through the existing custom station storage. Directory failure leaves the cached catalogue, saved stations and existing streams available. `AGENTS_DECK_NO_MUSIC=1` disables discovery and playback.

## Development and validation

Run the backend on an available port, for example `AGENT_DAG_PORT=4386 node src/server/index.mjs`, then `CCDECK_DEV_SERVER_PORT=4386 npm run dev:web -- --port 5186`. Open `http://localhost:5186/` and use Radio on the right sidebar beside the character’s head (More on a phone).

The radio directory and library suites cover mirror failover, bounded queries, safe station normalization, metadata restore, favorites/recent storage and daily/random selection. Existing player and modal suites cover compatibility with the canvas. Browser verification uses native audio fixtures to check switching, one active player, retry, pause/resume, volume/mute, persistence without autoplay, filtering, errors and responsive bounds. Map geometry tests cover camera bounds, anchored zoom, clusters, coincident points and missing coordinates. See [redesign audit and validation](radio-redesign-review.md) for captured screenshots, technical findings and limits of the checks.

Station passport, listening statistics, song recognition and richer collections are outside this first version.


### Interaction refinement

The search field keeps one clear action and returns focus to typing when cleared. Mute/Unmute reserves its width, including narrow windows, to keep volume and transport controls stationary. Hover feedback applies to precise pointers; selected, playing and muted states remain persistent. Keyboard camera and inspector actions respond immediately. Pointer press feedback uses short transform transitions and respects reduced motion. Discovery results retain their count above the list; the redundant limit footer is removed.
