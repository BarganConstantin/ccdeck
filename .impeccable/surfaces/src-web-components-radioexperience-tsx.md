---
version: 1
slug: "src-web-components-radioexperience-tsx"
primary_target: "src/web/components/RadioExperience.tsx"
related_targets: ["src/web/components/RadioPanel.tsx","src/web/components/RadioMap.tsx","src/web/styles/radio.css"]
---

# Radio explorer

Mode: Operate. Canvas companion for people who want background music while managing agent sessions.

Primary task: open Radio, find a station by place or sound, and listen without leaving the canvas. A world map, country/genre/language filters, favorites, recent listening, a daily pick and Surprise me support discovery.

Direction: extend ccdeck's existing panel and theme language. A right-sidebar button at the character’s head height owns entry; a responsive centered modal uses a lightly blurred scrim to focus on listening. Natural Earth geometry is local and the station directory loads on demand. Do not copy Radio Island branding or introduce gradients.

Behavior: one shared player powers the character and explorer. Hiding the character or closing Radio preserves playback; reload restores selection without autoplay. Favorites and history remain local. HTTPS streams only; music-off configuration prevents discovery and playback.

Proof: unit coverage for directory failover, normalization, persistence and station selection; browser checks for native audio, switching, stop, volume/mute, restore, filters, failures and mobile bounds.

Scope: first radio exploration version; station passport and richer collections remain future product work.
