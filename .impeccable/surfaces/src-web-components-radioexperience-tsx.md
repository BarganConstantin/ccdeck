---
version: 1
slug: "src-web-components-radioexperience-tsx"
primary_target: "src/web/components/RadioExperience.tsx"
related_targets: ["src/web/components/RadioPanel.tsx","src/web/components/RadioMap.tsx","src/web/styles/radio.css"]
---

# Radio explorer

Mode: Operate. Canvas companion for people who want background music while managing agent sessions.

Primary task: open Radio, find a station by place or sound, and listen without leaving the canvas. A world map, country/genre/language filters, favorites, recent listening, a daily pick and Surprise me support discovery.

Direction: extend ccdeck's existing panel and theme language. The viewport-bounded explorer is at most 1080×800px, with an approximately 61/39 map/discovery composition and a persistent player above it. Narrow windows use Map/Stations views; short narrow windows scroll controls and results together. A right-sidebar button at the character’s head height owns entry; a responsive centered modal uses a lightly blurred scrim to focus on listening. Natural Earth geometry is local and the station directory loads on demand. Do not copy Radio Island branding or introduce gradients.

Behavior: one shared player powers the character and explorer. Hiding the character or closing Radio preserves playback; reload restores selection without autoplay. Favorites and history remain local. HTTPS streams only; music-off configuration prevents discovery and playback.

Interaction: inspection is separate from playback. Locate explicitly moves the camera; regions only change the camera, while discovery filters affect results and markers. Pan, wheel, double-click, pinch and keyboard camera controls share bounded geometry. Screen-distance clusters retain a chooser for coincident positions, including selected/current stations; active markers or clusters have distinct selection/playing states. Coordinates come unchanged from the directory and are labeled approximate. Counts disclose coordinate coverage and pins outside filtered results. No fabricated live progress or song metadata.

Craft: reuse ccdeck theme, typography/radius tokens, buttons, VolumeRow, rail glyphs and modal focus/dismissal helpers. Restrained 180ms camera/entry transitions respect reduced motion. Mobile inspection hands focus to Play; closing details returns it to the map.

Proof: unit coverage for directory failover, normalization, persistence and station selection; browser checks for native audio, switching, stop, volume/mute, restore, filters, failures and mobile bounds.

Scope: first radio exploration version; station passport and richer collections remain future product work.
