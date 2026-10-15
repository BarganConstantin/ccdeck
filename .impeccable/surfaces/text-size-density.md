---
version: 1
slug: "text-size-density"
primary_target: "src/web/components/ReadingSection.tsx"
related_targets: ["src/web/components/SettingsModal.tsx", "src/web/reading-preferences.ts", "src/web/styles/reading.css", "src/web/styles/accounts-panel.css", "src/web/styles/touch-and-forced-colours.css", "src/web/use-appearance.ts", "src/web/index.html", "src/web/use-node-measurements.ts"]
---

# Text size and density

Mode: Operate. Settings → Text & density lets the single operator make the deck easier
to scan, see the result immediately, and restore the familiar appearance.

Direction: extend the existing settings language and PRODUCT.md/DESIGN.md
identity. Preserve system typography, monospaced values, theme and semantic
colors, control edges, radii and focus tokens. No new visual identity, gradients,
brand artwork or dependencies. Default keeps the established type and spacing.

Task: choose independently between Smallest (11 px body), Smaller (12 px), Default (13 px),
Larger (15 px) and Largest (17 px) text, and Compact, Default and Comfortable density. Native radios in labeled
fieldsets retain platform keyboard behavior. Changes apply immediately; the
two illustrative session rows preview text and spacing. Reset to defaults
restores both choices and is disabled when both are already Default.

Layout and interaction: five text choices form one horizontal scale with Default
at the center. “Aa” illustrations use 17/18/19/21/23px to show the exact relative
offsets; choice labels retain readable size floors. Native radios overlay each
text choice, inheriting its cursor, with a selected checkmark and visible focus
on the parent label.
At 640px and below the scale becomes vertical with whole-word text labels.
Density uses the same ordered control as text size (2026-10-15), with
three-stroke illustrations at 2/4/8px gaps for Compact/Default/Comfortable,
using a stable sample class and data-density attribute. On a phone both scales
are vertical lists. Reset to defaults sits beside the intro.
Panels widen with text: --ui-panel-increase is 24px at Larger and 48px at
Largest (0 on phones), and Smaller/Smallest stop 9px and 10px text at 9px. Keep help,
preview and reset reachable in narrow and short windows at Largest/Comfortable.
Selection uses neutral fill and existing control/focus tokens. Enlarged text raises control height
floors; compact spacing must not reduce interactive rows below 24px. Density
changes spacing independently of text size, including account-row padding;
zero row increment preserves the original Default spacing.
Forced-colors treatments live in the canonical touch-and-forced-colours.css
block: system Highlight selection edges, Canvas surfaces and CanvasText strokes.

Motion: after the owner's explicit impeccable animate request, the selection
backplate moves horizontally or vertically through an interruptible CSS
transform transition (180ms, cubic-bezier(0.23, 1, 0.32, 1)). Rapid selections
retarget from the current position. The checkmark scales in over 140ms with
120ms opacity feedback. Reduced motion makes the backplate instant and removes
check scaling, retaining only an 80ms opacity transition. Choices also provide
explicit press feedback at scale(0.97) with a 140ms transform transition;
reduced motion removes the press transform and choice transitions. No animation
loops or new dependencies; motion communicates selection and press feedback.

Persistence: preferences belong to this browser/origin, not an account or paired
machine. Guarded storage reads fall back to Default; failed writes leave the
current interface usable without promising reload persistence. The inline
index.html bootstrap applies validated choices before first paint; React starts
from the same values. Storage events use guarded localStore() to check the storage
area and synchronize same-origin tabs, with missing,
invalid or cleared values resolving to Default. The footer states “Preferences
stay in this browser when storage is available,” qualifying persistence for a
blocked store.

Canvas constraint: canvas zoom and browser zoom remain untouched. Zoomed-out LOD
summaries explicitly use zero text offset to preserve fixed screen-space line
budgets and container cutoffs. Expanded cards and detail panels enlarge normally;
React Flow measurement and its DOM fallback supply updated card dimensions to
layout rather than changing the camera scale.

Verification limits: the branch integrated development 87137340 while preserving
theme transitions. Final typecheck and production build passed (14.25s); both
actual-app browser scripts passed after integration, covering keyboard/focus,
rapid selection, normal/reduced motion, density strokes, persistence, denied
storage, reset/dismissal, unchanged canvas scale and responsive layouts. Separate
Largest/Comfortable checks passed for Gruvbox Dark, Light and Material. Two latest
development source invariants were reproduced on the baseline and fixed; the
control-edge inventory's exact selector was also updated. Three targeted
integration and contrast files passed 57 tests. Conditional-save copy and mobile
density-sample findings are resolved; the bounded visual/source review verdict
is SHIP. Node 26's unrelated event-serialization failure also reproduced on
unchanged development; those baseline tests pass under Node 22. The final full
Node 22 suite passed exclusively, without concurrent build/source mutation:
1,068 files and 13,343 tests passed in 218.35s, exit 0, confirmed in
`/tmp/ccdeck-reading-complete-tests.log`. Final readiness is SHIP WITH FOLLOW-UPS
at the scoped runtime/platform coverage. The rewritten
`.impeccable/review/text-density/verification.md` records checks and limits.
Earlier focused passes do not replace that final result. Evidence does not
establish full accessibility/platform certification, live-provider correctness
or measured frame-rate performance. This documentation pass ran no builds,
tests, browser checks or detector. Write scope is this paragraph only; source,
git, other docs and private external records remain outside scope.
