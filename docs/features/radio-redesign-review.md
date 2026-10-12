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
| Constraints | At most 300 HTTPS directory results per query; nullable/unverified coordinates; many shared points; no tile detail, globe or exact location accuracy; external stations may fail or change format. At the initial redesign HLS was inferred from URL extensions; the final refinement below preserves the explicit directory flag and handles extensionless streams. No song recognition, seeking or fabricated live progress. |

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


## Final focused quality pass

Scope: preserve desktop architecture, identity, persistent player and the map/discovery split. Applied Impeccable critique and polish; context had already run in this session. Independent assessments: A `01a12f69-c88a-7ad1-b929-0e47e65fb0a3` (supplied rendered captures plus source), B `01a12f69-c941-7b50-897e-809812302a97` (detector and source). B reported zero detector findings. Native browser fallback remains the isolated Chromium session described above; no visible detector overlay is claimed. No unrelated design-system changes.

Four high-impact improvements were selected:

1. **Inspection and context:** the mobile dock reserves space rather than covering markers. List inspection stays in Stations, including stations without coordinates. Details expand on demand; dismissal retains selection and offers reopening. Desktop details are compact by default. Focus moves to Play on inspection, to Collapse on short-screen expansion, and back to the name on collapse; dismiss returns to map/search.
2. **Map/result meaning:** “Map view,” coordinate coverage (“129 of 300 have locations”), result labels and the view/filter hint distinguish the camera from the station catalogue. Country controls explicitly label their filtering role. Regions continue to leave results unchanged.
3. **Keyboard/touch access:** visible markers and clusters are keyboard stops with Enter/Space activation. Offscreen markers remain out of Tab order. Focus states, 44px mobile controls and 44px marker hit areas are paired with matching touch clustering. Station rows preserve dense layout, full accessible names and name tooltips. Inspector Play/Save controls describe the inspected station rather than implying the player changed.
4. **HLS reliability:** the official directory `hls: 1` flag is normalized, stored and used with URL-based detection. Fresh catalogue metadata takes precedence over stale saved metadata while retaining personal station names. Only explicit directory playback refreshes existing saved format data. A review caught a restored-current-station race: resuming changed media now sends a new playback request, while pausing an active station does not refresh its media.

Official format flag reference: [Radio Browser station fields](https://docs.radio-browser.info/), `hls` = 0/1. No broadcaster format is invented or inferred from a station name/genre.

### Two bounded iterations

**Iteration 1:** before and first-batch captures at `/tmp/ccdeck-radio-review/polish-before/` and `/tmp/ccdeck-radio-review/polish-pass-1/`. Implemented reserved mobile dock, compact desktop inspector, explicit scope copy, touch/keyboard controls and HLS flag propagation. Independent visual review found the prior obstruction and ambiguity resolved, with one remaining concern: short-window map compression.

**Iteration 2:** a real 320×568 test measured only 21px of map after reserving details. Fixed with a compact strip, a 96px minimum interactive map and one geography scroll area for expanded short-screen details; camera dimensions now preserve the actual aspect ratio even for very wide short maps. Expansion scrolls focused controls into view. Final captures at `/tmp/ccdeck-radio-review/polish-after/` confirm the 320px/390px layouts and 800×500 window. The independent visual reviewer returned **SHIP** for the known findings, explicitly accepting short-screen geography scrolling. No further visual redesign was pursued.

### Final workflow evidence

- A: Europe, cluster selection, inspection, explicit play; cluster Enter activation also tested.
- B: audio continues through close/reopen; current identity and playing state retained.
- C: inspection does not start another stream; explicit play switches with one active native audio element.
- D: mobile inspection retains its current view; dismissal keeps the selected row/marker; Map/Stations and reopening details retain station identity; camera pan/zoom and focus return tested.
- E: search, country/genre/language filters, favorites, Recent, stream failure/retry, directory failure/retry and empty results verified with genuine captured catalogue metadata and controlled media URLs.
- F: modal bounds/no horizontal overflow checked at 1440×960, 1024×768, 900×600, 390×844, 320×568 and 800×500; collapsed and expanded short-screen map dimensions checked. Reduced motion, Escape, keyboard controls and inspector labels verified.
- Extensionless HLS: real lazy-loaded hls.js, native Audio/MediaSource and generated AAC transport-stream segments played successfully. Fixture starts from a previously saved favorite with no HLS flag, restores it as the current paused station without autoplay, then resumes it with fresh metadata. Close/reopen and pause/resume also pass. This is an actual controlled media test, not a broadcaster certification.

Final macOS and Windows checks passed: TypeScript, production build and **266 tests across 11 relevant suites**; theme consistency checked all 9 JSON themes, and `git diff --check` passed. No dedicated lint script exists. Windows used the isolated test folder with final source archive SHA-256 `c143f68866b8baa15f9155449b9b57e834007e733f4fc5fc8908cbd96cf94aa8` (base `6f4b6fc0`, branch `feat/radio-explorer`), command exit 0. The final native audio script additionally checked that pausing/resuming the player leaves a different inspected station selected; HLS recovery was verified separately from the player and Favorites. Physical touch/pinch, hardware sound output, Electron packaging and every external broadcaster remain unverified in this pass. Stale entries outside the fresh catalogue cannot learn a missing HLS flag while offline; cross-origin permissions, server availability and incorrect upstream flags remain external constraints. The production build retains its existing large-chunk warning.

### Targeted map focus correction — October 12

Browser inspection reproduced a native `outline: auto 5px` on the focused SVG even when `:focus-visible` was false. A pointer click on an already keyboard-focused SVG also retained the authored keyboard ring. The fix suppresses only the map's non-visible/pointer outline, records pointer gestures only while the map owns focus, and clears that override on keyboard input or blur. Tab order, marker focus and programmatic restoration stay intact. The shared 2px accent keyboard ring now sits 2px inside the map boundary to avoid clipping.

Chromium verification passed across World, Europe, Americas, Asia, Africa and Oceania: click, drag, wheel, double-click, genuine Tab entry, keyboard pan/zoom/Home, mouse after keyboard, wheel before Tab, cluster activation/dismissal, and station dismissal using both pointer and keyboard. Emulated touch tap and two-finger gestures passed at 390×844, 320×568 and 390×500. Rendered desktop keyboard/pointer and mobile captures are in `/tmp/ccdeck-radio-review/focus-after/`. Physical touch hardware and other browser engines were not tested.

Integrated `origin/development` at `3478e584`, preserving its companion selection and relocated character settings while retaining Radio's single playback owner. After integration, macOS TypeScript, production build, 266 Radio/FM/modal tests and 14 companion/runtime tests passed (280 total). The existing large-chunk build warning remains.
