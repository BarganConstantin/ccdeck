---
version: 1
slug: "text-size-density"
primary_target: "src/web/components/ReadingSection.tsx"
related_targets: ["src/web/components/SettingsModal.tsx", "src/web/reading-preferences.ts", "src/web/styles/reading.css", "src/web/styles/accounts-panel.css", "src/web/use-appearance.ts", "src/web/index.html", "src/web/use-node-measurements.ts"]
---

# Text size and density

Mode: Operate. Settings → Text & density lets the single operator make the deck easier
to scan, see the result immediately, and restore the familiar appearance.

Direction: extend the existing settings language and PRODUCT.md/DESIGN.md
identity. Preserve system typography, monospaced values, theme and semantic
colors, control edges, radii and focus tokens. No new visual identity, gradients,
brand artwork or dependencies. Default keeps the established type and spacing.

Task: choose independently between Smallest (−2 px), Smaller (−1 px), Default, Larger (+2 px)
and Largest (+4 px) text, and Compact, Default and Comfortable density. Native radios in labeled
fieldsets retain platform keyboard behavior. Changes apply immediately; the
two illustrative session rows preview text and spacing. Reset to defaults
restores both choices and is disabled when both are already Default.

Layout and interaction: three choices per row become one column at 640px and
below; mobile choice labels stay on one line without shrinking or breaking words.
Keep help, preview and reset reachable in narrow and short windows at
Largest/Comfortable. Selection uses the existing accent border and neutral
fill; keyboard focus has a visible outline. Enlarged text raises control height
floors; compact spacing must not reduce interactive rows below 24px. Density
changes spacing independently of text size, including account-row padding;
zero row increment preserves the original Default spacing.

Persistence: preferences belong to this browser/origin, not an account or paired
machine. Guarded storage reads fall back to Default; failed writes leave the
current interface usable without promising reload persistence. The inline
index.html bootstrap applies validated choices before first paint; React starts
from the same values. Storage events synchronize same-origin tabs, with missing,
invalid or cleared values resolving to Default. The footer states “Preferences
stay in this browser when storage is available,” qualifying persistence for a
blocked store.

Canvas constraint: canvas zoom and browser zoom remain untouched. Zoomed-out LOD
summaries explicitly use zero text offset to preserve fixed screen-space line
budgets and container cutoffs. Expanded cards and detail panels enlarge normally;
React Flow measurement and its DOM fallback supply updated card dimensions to
layout rather than changing the camera scale.

Verification: 32 focused test files / 668 tests passed before the last narrow-label
and account-row adjustments. The final four-file check after those changes passed
73 tests; final typecheck and production build passed. Actual-app browser checks
passed keyboard radios, reload, cross-tab updates, denied storage, reset, Escape
and focus return, unchanged React Flow viewport scale, narrow/short windows and
light-theme rendering. Top and bottom Settings screenshots were inspected.
The independent finish reviewer scored the material conditional-save-copy fix and
optional whole-word-label follow-up resolved. SHIP at this bounded review scope;
not a full-repository or cross-platform accessibility certification. SVG/canvas
chart typography remains under each chart's existing renderer; no cloud or
cross-origin preference migration is implemented. No new detector was run after
the single clean initial detector pass.

Owner follow-up (2026-10-14): added both smaller choices. Five text choices retain
the three-column desktop grid and single-column mobile layout; Default is unchanged.
The follow-up passed 16 preference tests, browser interaction/reload checks,
typecheck and production build. Earlier independent review covered the original
three-choice version, not this additional pair.
