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

Task: choose independently between Smallest (−2 px), Smaller (−1 px), Default, Larger (+2 px)
and Largest (+4 px) text, and Compact, Default and Comfortable density. Native radios in labeled
fieldsets retain platform keyboard behavior. Changes apply immediately; the
two illustrative session rows preview text and spacing. Reset to defaults
restores both choices and is disabled when both are already Default.

Layout and interaction: five text choices form one horizontal scale with Default
at the center. “Aa” illustrations use 17/18/19/21/23px to show the exact relative
offsets; choice labels retain readable size floors. Native radios overlay each
text choice, inheriting its cursor, with a selected checkmark and visible focus
on the parent label.
At 640px and below the scale becomes vertical with whole-word text labels.
Density keeps visible native radios and three-stroke illustrations with
2/4/8px gaps for Compact/Default/Comfortable, using a stable sample class and
data-density attribute. Mobile text layout targets only
the last text span, preserving the illustrations' vertical strokes. Keep help,
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

Verification limits: latest supplied evidence reports 150 passing tests across
four files, a passing typecheck and a passing production build (5.06s). Earlier
32-file/668-test evidence predates subsequent adjustments. Actual-app browser
checks passed keyboard focus outlines, rapid-selection settlement, reduced-motion
0s versus normal 180ms backplate timing, and density strokes at all checked
viewports, alongside the previous reload, cross-tab, denied-storage, reset,
Escape/focus-return, unchanged canvas-scale, narrow/short and light-theme flows.
A forced-colors screenshot was captured. The fresh reviewer found a mobile
generic-span layout bug; the text-only last-span selector fixes it, with new
confirming screenshots reported. The earlier conditional-save-copy finding is
resolved; the bounded visual review verdict is SHIP. The complete Node 26 suite
hit an unrelated event-serialization baseline failure also reproduced on
unchanged development; that baseline passes under Node 22. The full Node 22
suite is currently running, with no result claimed. Earlier focused passes
do not establish a full-suite pass after these integration corrections.
Evidence is scoped to the reported checks, not full certification or measured
frame-rate performance. This
documentation pass rechecked source without rerunning tests, browser checks or
builds. No new detector was run. Write scope is this brief only; source, git,
DESIGN.md, other docs and private external records remain outside scope.
