# Radio Explorer — implementation and design review

## Audit method

Impeccable was applied through its new-work, critique, craft-floor and Operate workflows. Product and design authority are `PRODUCT.md`, `DESIGN.md`, the theme tokens, shared rail controls, `VolumeRow` and the existing modal dismissal/focus system. The context script had already run earlier in this session and was not repeated.

Initial critique used independent assessments: A `01a12f29-e1dd-72d0-992a-68637fe4b23e`, B `01a12f29-e2fe-7821-b9a8-b9c20123d46a`. A identified a secondary 185px map, compressed controls, high decision density and weak mobile hierarchy. B ran the bundled detector on RadioPanel and RadioMap: **zero findings**, and independently identified small map targets, overlap and keyboard limitations. These manual issues were acted on even though the detector was clean. Initial heuristic severity (0–4): status1, real-world2, freedom1, consistency1, error prevention1, recognition2, efficiency2, minimalism3, recovery1, discoverability2.

The shipped finish-reviewer agent type was unavailable in this harness. An isolated general reviewer used the shipped fallback review instructions instead. The bounded documentation subagent failed to apply its patch and was stopped; the parent updated only the Radio surface brief and feature documentation. A later reviewer scoring attempt disconnected; the parent inspected final recaptures directly. Native browser integration was unavailable earlier in this session because its service path was broken; rendered inspection uses an isolated Playwright headless browser, never a personal profile.

Questions skipped: the user supplied the product direction and authorized implementation without interruption for minor choices.

## Verified technical findings

| Question | Finding |
| --- | --- |
| Map renderer | Local SVG with bundled Natural Earth geometry; equirectangular longitude/latitude projection. No Leaflet, map SDK, tiles, or map dependency. Custom camera and markers permit pan, zoom, region presets and screen-distance clustering. |
| Coordinate source and accuracy | `geo_lat` / `geo_long` from Radio Browser, range checked and passed through unchanged. No country-centroid fallback or derived station coordinates. The API describes stream location but exposes no precision or confidence guarantee. We conservatively describe directory positions as approximate, rather than exact broadcast sites. |
| Different counts | Only entries with both valid coordinates are mapped. The captured real unfiltered catalogue contained 300 stations, 129 with coordinates and 171 list-only stations. Counts change with results; selected/current stations may remain pinned separately. |
| Audio ownership | `RadioExperience` stays mounted in BoardFlow and owns `useFmPlayer`; closing only unmounts the discovery modal. The character, iframe and explorer share one player. Direct audio is released before switching; reload does not autoplay. |
| Persistence | Local storage: favorites (100 IDs), recent (50 IDs), catalogue cache (300 entries). Station metadata and URLs use existing custom station storage. No remote favorites or account is introduced. |
| Regions and filters | Regions change the camera only. Search/country/genre/language filter discovery results and their markers; Favorites/Recent use local filtering. Map navigation never silently changes the result list. Selected/current markers remain visible if filtering excludes them. |
| Original marker behavior | Individually drawn markers were clickable and started playback directly. They had no clustering and were excluded from the Tab sequence. The redesign separates inspection from playback, gives the map keyboard controls and retains the station-list alternative. |
| Larger dialogs | Existing overlays support viewport-bounded panels and a shared modal shell/focus trap. No general draggable dialog-resize system was found. Radio responds to viewport dimensions instead of adding an unrelated resizer. |
| Shared system | Existing theme colors, spacing/radius/font tokens, `btn` / primary controls, VolumeRow, rail glyph system, modal stack, shared Escape/focus return and scrim dismissal. No gradients, brand redraw or new font. |
| Constraints | At most 300 HTTPS directory results per query; nullable/unverified coordinates; many shared points; no tile detail, globe or exact location accuracy; external stations may fail or change format. HLS is currently inferred from URL extensions, so extensionless HLS metadata needs special care. No song recognition, seeking or fabricated live progress. |

Source: [Radio Browser API reference](https://docs.radio-browser.info/), station schema and search parameters. Counts above come from the real directory response captured during this review, not synthetic station metadata.

## Composition and interaction decisions

- A viewport-bounded modal, max 1080px wide, max 800px tall. Desktop map/list split is approximately 61/39; actual measured map after the initial build: 623×444px at a 1440×960 viewport, versus the old 540px-wide dialog's 185px-high map.
- One persistent player sits above both columns. Inspection changes the map/list selection; Play explicitly switches audio. Player identity and station detail identity remain separate.
- Map coordinates are not fabricated. Clusters group points by rendered distance and disclose a compact station chooser; even coincident points remain discoverable at maximum zoom. Selected and current stations retain distinct marker or cluster states; overlapping protected pins stay in a reachable chooser instead of covering other stations.
- Region transitions are restrained (180ms); drag and scroll react immediately. Keyboard arrows pan, +/− zoom, Home resets. Pointer pan, double-click zoom, wheel zoom and touch pinch use the same bounded camera. Browser Ctrl/Cmd wheel zoom remains available.
- Favorites and Recent preserve their storage behavior. Today's station is a small editorial row; existing streams are a disclosure instead of another permanently expanded list.
- Narrow windows offer Map/Stations views, with the player always visible. Search/filter controls and the results list have one scroll container. The map observes its own resized dimensions.
- Background audio, reduced motion/transparency, modal focus trapping and Escape/scrim dismissal are preserved.

## Rendered critique and refinement

Screenshots and browser evidence: `/tmp/ccdeck-radio-review/`.

### Pass 1

Captured loading, world, Europe, selection, connecting, playing, buffering, Favorites, Recent, search, country filters, failed stream, no results, directory failure, laptop, small desktop and mobile views. Native HTML audio fixtures used real captured station metadata; playback screenshots are controlled media tests rather than evidence that every broadcaster works.

Findings and fixes: bring transport beside the station identity; increase station-name/metadata readability; avoid an alarming idle failure message before any playback request; remove contradictory Paused labels on failed stations; make mobile inspection reveal its details; make Locate fit the compact inspector without a third control row; express the count as “129 of 300 on map.”

### Pass 2

Rendered review found that very short narrow windows left only 17–35px for results. The second batch gives these windows a single discovery scroll area, lets filters scroll with the results, and compacts the player into one row when width allows. Reinspection at 320×568 and 800×500 confirmed that station rows can be reached while the player remains visible.

Additional fixes: mobile inspection transfers focus to its Play action; clearing inspection and closing the cluster chooser return focus to the map. The selected-station card gives way to the cluster chooser so overlapping popovers cannot conceal its station choices. Map counts explicitly disclose selected/current pins outside filtered results. Muting has a visible pressed state. A further overlap check found that individual selected/current pins could cover a coincident cluster; overlapping pins now remain in its chooser, including at maximum zoom, with selection/playing styling applied to that cluster.

The independent reviewer initially could not view images through its viewer; attaching the actual desktop/mobile images resolved that limitation. It returned **SHIP** for the visual review (desktop 8.5/10, mobile 8/10), with no confirmed visual blocker. The compact inspector necessarily covers some map area on mobile; it can be dismissed and never starts audio merely by inspection. Functional checks are recorded separately below, rather than inferred from screenshots.

## Validation

- macOS: TypeScript and production build passed; 263 tests across 11 relevant suites passed. Theme consistency checked all 9 JSON themes. No dedicated lint script exists; `git diff --check` passed and the Impeccable detector reported zero findings for both main components.
- Isolated Chromium: native audio start, pause/resume, stream retry, switching with one active stream, volume/mute, buffering signal handling, Surprise me, daily selection, close without stopping audio, favorites/recent, persistence without autoplay, search/country/genre/language filtering, empty states and directory/stream failures passed.
- Map: browser checks passed for keyboard pan/zoom/reset, wheel, dragging, double-click, cluster inspection, explicit Locate, mobile focus handover/return, reduced motion and Escape dismissal. Responsive bounds checked 1440×960, 1024×768, 900×600, 390×844, 320×568 and 800×500. No horizontal document overflow at checked sizes.
- Screenshots: `/tmp/ccdeck-radio-review/final/`; native HTMLAudioElement fixtures use genuine captured station metadata with controlled media URLs. Waiting/playing events for the buffering screenshot are controlled events, not an external network-loss test. These checks do not certify all broadcasters, hardware audio output, touch-device behavior, or YouTube/HLS delivery.
- Windows: final overlap-fix snapshot TypeScript, the same 263 tests across 11 suites, and production build passed (command exit 0). Snapshot source branch `feat/radio-explorer`, base `0dc2a27a`, archive SHA-256 `6dc99072846d0cbd889bcc9b3ac2948cd5bb5eb449aa1d12d072dba2adedde61`, isolated folder `C:\Users\cbargan\Desktop\ccdeck-radio-test`.
- Build reports the existing large JavaScript chunk warning; the radio panel and HLS support remain separately lazy loaded.
