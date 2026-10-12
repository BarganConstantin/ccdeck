# Radio explorer

Radio is a canvas companion: open Radio on the right sidebar beside the character’s head to discover stations on a world map, filter by country, genre or language, save favorites, revisit recent listening, or choose a daily/random station.

## Reference and implementation

[Radio Island](https://radio-island.party/) inspired the map and compact listening workflow. Its public [release repository](https://github.com/gentilfp/RadioIsland-releases) distributes the native app; the native source was not available in the repository inspected. This feature uses ccdeck's own components, theme tokens and existing player rather than copying its native interface or brand assets.

Station discovery uses the [Radio Browser API](https://docs.radio-browser.info/). The ccdeck server discovers directory mirrors, restricts requests to their API hosts, tries up to three mirrors, and caches bounded search results for ten minutes. Each query returns at most 300 stations; filters discover stations beyond the initial popularity list. Only HTTPS audio streams are offered. A station selection reports its ID to Radio Browser's popularity endpoint, once per server session.

The map uses bundled [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/) public-domain country geometry. No map service or tiles are needed. Stations without coordinates remain available in the list. A selected station zooms the map to its location; region and zoom controls restore wider views.

The explorer opens in a centered modal with a lightly blurred backdrop. Escape, the close button or a click on the backdrop dismisses it.

## Playback and local state

One player serves the character and explorer. Hiding the character or closing Radio keeps music playing. Reload restores the selected station without autoplay. Native audio streams connect directly from the browser to the broadcaster; HLS uses the existing lazy-loaded player support. Failed streams can be selected again to retry.

Favorites, recent station IDs and the last unfiltered catalogue are stored locally. Favorites retain station metadata through the existing custom station storage. Directory failure leaves the cached catalogue, saved stations and existing streams available. `AGENTS_DECK_NO_MUSIC=1` disables discovery and playback.

## Development and validation

Run the backend on an available port, for example `AGENT_DAG_PORT=4386 node src/server/index.mjs`, then `CCDECK_DEV_SERVER_PORT=4386 npm run dev:web -- --port 5186`. Open `http://localhost:5186/` and use Radio on the right sidebar beside the character’s head (More on a phone).

The radio directory and library suites cover mirror failover, bounded queries, safe station normalization, metadata restore, favorites/recent storage and daily/random selection. Existing player and modal suites cover compatibility with the canvas. Browser verification uses native audio fixtures to check switching, one active player, volume/mute, persistence without autoplay, filtering, errors, music-off behavior and mobile bounds.

Station passport, listening statistics, song recognition and richer collections are outside this first version.
