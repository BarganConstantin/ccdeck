disposition: ship

Independent assessments: design/layout (Mencius), mechanical/accessibility
(Helmholtz). Final design P1 was scored resolved by independent recapture review;
focused browser follow-up found no blockers. No external publishing or merge.

## persistence

Pass. Source remains on feat/radio-built-in-stations, served from its built UI on
port5205. Map/player/modal design and audio provider lifetime remain unchanged.
Only shared-popover portal placement adds an opt-in modal accessibility container;
other callers retain their default body portal.

## fidelity

| Promise | Result |
| --- | --- |
| Coherent discovery composition | Match: restrained segmented tabs, broad search, unified Filters and visible criteria |
| Directory immediately accessible | Match: radio-first rows; compact streams disclosure fixed below the one results scrollbar |
| Source access under filters | Match: disclosure remains available with matching count, explanation and explicit recovery |
| Predictable filtering/persistence | Match: retained criteria across tabs, separate resets, no automatic clearing on source disclosure |
| Current playback discoverable | Match: player preserved; stream reveal targets current row; collapse restores directory position |
| TYPE/MATERIAL | Match: incumbent type roles, monospaced live counts, tokenized surfaces, consistent SVG icons |
| Scope | Match: no new source tabs, map layout or player redesign |

## ceiling

Reached for the Operate surface. Two batched rendered critique/fix rounds covered
1440×1000, 1100×800, 390×844, 320×568 and 1100×540, normal and filtered states,
light theme and a synthetic 300-station catalogue. First fixes improved short-window
row access, mapping copy and current-row reveal. Second fixes clarified selected
filter values, clear-action focus and contextual Global results. Independent final
review caught disappearing source access under metadata filters; its recaptures
show persistent 0/Filtered access and explicit recovery with criteria intact.
Combined country/genre/language at320×568 was also checked: a single horizontal
criterion strip leaves at least70px for vertically scrollable results. Final confirmation caught
an intrinsic grid-width overflow; zero-minimum tracks and a bounded criterion
strip now keep Filters and Clear inside the panel. Browser assertions check
the toolbar itself and both control bounds, rather than only the clipped modal.

Artifacts inspected directly: /tmp/composition-catalogue-{width}-{height}.png,
/tmp/composition-filtered-{width}-{height}.png, /tmp/composition-filter-overview.png,
/tmp/composition-filter-country.png, /tmp/composition-streams-filtered-open.png,
/tmp/composition-combined-short.png and /tmp/composition-light.png.

## material_fixes

None remaining. Final TypeScript and production build passed;185 relevant tests
passed in13 suites (discovery/source state, aliases/favorites, theme and control
contrast/census, shortcut gating and shared popover behavior).

Browser checks passed: both-source search; clear search; combined filters including
Japanese language metadata; filter removal/all reset retaining query; Global with
no directory request and no invented pins; Favorites/Recent and Arrow/Home/End;
source expansion/collapse and filter-exclusion recovery; current workspace favorite;
empty/error states; long names; desktop/narrow/short/light layouts; popover bounds;
modal-descendant popup; Escape/focus restoration; popup reset→Done; pointer search
without keyboard ring and resumed keyboard focus; no page errors.

The same real browser audio instance advanced without another play call across
search, filters, tab switches and empty states, using a synthetic silent WAV.
Good Life source selection/favorites were exercised; captures observed Playing live.
Directory fixtures and the300-station catalogue are synthetic, not claims that
external directory streams were individually validated.

Independent focused checks at320×568 verified Tab containment, field Back,
outside dismissal/resize focus, current-row keyboard reveal, and450px directory
scroll restoration. Detector findings are nine advisory legacy font-size declarations
outside the changed discovery scale. Build retains its existing chunk-size warning.
Manual VoiceOver/NVDA testing was not performed. Browser DOM/focus checks verify
the corrected modal boundary, not complete assistive-technology certification.

## keep

Keep truthful source/metadata/count provenance, shared audio and persistence,
explicit recovery, one vertical results scrollbar, and accessible focus/contrast.


## Final targeted refinement — 2026-10-13

Applied Impeccable's polish procedure without replacing the composition.
First critique: Today's station forced its name, editorial label, country and
play action onto one crowded line; the directory description did not quantify
which results could be mapped; a failed active workspace source still said Paused.
Map markers retained native SVG tooltips and selectable cluster numerals.

First fix batch: two-line-capable featured name with metadata below and a stable
play control; dynamic coordinate coverage; explicit failed-source retry copy;
nonselectable map markers, no native SVG title, retained aria labels and circular
keyboard focus indication. Second critique/fix: failed-state Retry now takes
priority over armed Pause, including Today's station, whose current/pressed
semantics match its actual action. Settled captures replaced a transient initial
capture and distinguish pointer hover from keyboard focus.

Final verification: TypeScript and production build passed; 90 tests in seven
suites passed, including missing-coordinate copy and failures in both sources.
Real Chromium checks passed for search, combined country/genre/language, clears,
Global scope, Favorites/Recent, source disclosure, outside click and Escape,
focus return, pointer versus keyboard focus, popup bounds, and overflow at
1440x1000, 1100x800, 390x844, 320x568 and 1100x540. A synthetic 300-result catalogue
with 127 coordinate-bearing entries and multilingual long names verified counts.
The same silent-WAV media instance continued advancing across search, filtering,
tabs, empty results and source collapse. Waiting/playing events exercised buffering;
row clicks exercised pause/resume; a mocked failed workspace probe exercised Retry.
Persisted favorite IDs were checked in localStorage. Native assistive-technology
and real external stream availability were not manually validated.

Opened and reviewed actual captures: /tmp/radio-final-catalogue-catalogue-{1440-1000,1100-800,390-844,320-568,1100-540}.png,
/tmp/radio-final-catalogue-filter-overview.png, /tmp/radio-final-catalogue-filter-country.png,
/tmp/radio-final-combined-short.png, /tmp/radio-final-empty.png,
/tmp/radio-final-favorites.png, /tmp/radio-final-recent.png,
/tmp/radio-final-workspace.png, /tmp/radio-final-playing.png,
/tmp/radio-final-paused.png, /tmp/radio-final-buffering.png,
/tmp/radio-final-workspace-failed.png, /tmp/radio-final-map-hover.png and
/tmp/radio-final-map-focus.png. These temporary local captures contain synthetic
station fixtures. This final pass was in-thread; the earlier independent verdict
above applies to the previous composition revision, not to these new refinements.
Existing production chunk-size warning remains. No new dependency or player
lifecycle change was introduced.


# Radio Explorer — focused craftsmanship, 2026-10-13

Independent Impeccable assessments: A/Halley (visual, code, live browser) and
B/James (detector/browser evidence), baseline b281b058, without shared conversation
or cross-assessment findings. Read DESIGN.md and polish/critique/craft-floor.
No prior matching stored critique existed. Four selected fixes:

1. Responsive focus restoration: resizing from desktop to phone hid the original
Radio launcher and Escape left BODY focused. Opt-in fallback now restores visible
Radio or dock More; ordinary restoration and other modal callers keep their behavior.
2. Map header overflow:622px content in606px on smaller desktop;591px in254px on
320px. Only region choices now scroll; title/coverage remain readable, with regions
on their own narrow-layout row.
3. Hover and selected tabs computed identical backgrounds. Selected surface stays;
hover uses foreground feedback without suggesting a second selected collection.
4. Desktop coordinate counts repeated. Map owns coverage on desktop, while results
retain it on narrow layouts where the map is hidden.

Map framing is unchanged: aspect-preserving world fit explains vertical space.
Zooming to fill it would crop geography. Player alignment, typography, rows,
source disclosure and audio lifecycle did not justify churn or a fifth change.
A heuristic scores (0–4): status3, real-world4, freedom3, consistency3, prevention3,
recognition3, efficiency3, minimalism3, recovery3, help3. Detector ran once: eight
legacy font-ramp advisories, not demonstrated readability defects. B measured
representative text contrast: Rider Black5.78–8.28:1; White Contrast9.43–15.13:1.
This is measured evidence, not blanket WCAG certification.

Final main-thread verification: TypeScript/build passed;152 tests in nine suites
passed (radio geometry/source semantics, control contrast/edges, overflow, popover
placement, modal dismiss/focus trap). Browser checks passed for region reachability,
cluster hover/focus, zoom/Home and full-world viewBox; header/count bounds;
selected versus hover; no opening search autofocus; Filters/Escape/focus;
search/combined filters/clear; shared favorites/recent persistence; source disclosure,
empty/error states, buffering/pause/resume/workspace Retry. A real silent-WAV media
instance advanced without another play call through search/filter/tab/empty states
and source collapse. Directory fixtures and failed probes were synthetic.

Layout checked at1440x1000,1100x800,390x844,320x568,1100x540 atDPR2, including
300 entries with127 coordinates and multilingual long names. Before captures:
/tmp/radio-craft-before-{desktop,smaller,mobile,narrow,short}.png. After captures:
/tmp/radio-craft-map-{width}-{height}.png and
/tmp/radio-craft-catalogue-catalogue-{width}-{height}.png, plus tab-hover/filter
captures. Main thread opened representative desktop, smaller,390 and320 captures,
compared composition, and recaptured settled map reset after asserting world
viewBox width>=360,height>=170. Responsive focus passed at390 and320 for
desktop→More, More→More and More→desktop; search never autofocused.

Limits: external station availability and VoiceOver/NVDA not manually verified.
B checked200% zoom using equivalent720x500 reflow; actual browser zoom was not
exercised. Existing build chunk-size warning remains. Final resolution checks were
in-thread, not an independent whole-surface ship verdict. Questions skipped:
owner authorized autonomous work and preserved direction; no missing input.
