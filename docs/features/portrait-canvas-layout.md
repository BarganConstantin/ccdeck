# Portrait canvas layout — verified fix

Date: 2026-10-13. Branch: `fix/portrait-canvas-layout`, based on development
`92344535`. Implementation: `998765c3`.

## Reproduction and causes

The incremental arrival layout treated every settled card's x coordinate as
a session column. A child agent extending to the right therefore created a
phantom column: a later, narrower session could appear above that child instead
of continuing below the existing sessions. With five sessions, a right-hand
child, and a 700 × 2500 layout frame, the regression test produced
`{ x: 420, y: 0 }` rather than `{ x: 0, y: 1330 }` before the fix.

Separately, `fitLeft` always centered the board vertically. The existing camera
test's 712 × 1876 canvas produced a y target of approximately 813px. On a tall
canvas this put a width-constrained board in the middle of a mostly empty area.

Both problems were also reproduced in the actual React application using
synthetic hook events, including a new session without a prompt note. The
1080 × 1920 baseline placed the new root at layout x=1220, y=0 above the child.
The corrected application places it below the existing session blocks.

## Changes and preserved behavior

- Arrival candidates use each session block's left edge. Child cards remain
  collision obstacles, but do not independently establish session columns.
- Automatic framing and explicit recentering start at the top margin when the
  uncovered canvas is taller than it is wide. Landscape and square canvases
  retain vertical centering; right-side panel coverage remains accounted for.
- The trailing camera correction also detects an incorrect vertical position
  after an interrupted animation.
- No forced one-column mode, zoom-policy changes, or manual-camera resets were
  introduced. Existing multiple-column scoring, dragged/pinned layout behavior,
  and Auto-fit / Resume controls remain in place. Existing manual views need
  an explicit recenter/resume to adopt the new automatic framing.

## Verification

Node 22.14.0; all listed commands exited 0:

- `npm run typecheck`.
- `npm run build` (existing large-chunk advisory remains).
- `node node_modules/vitest/vitest.mjs run` with these 16 focused suites:
  `board-spread`, `layout-overlap`, `rearrange-camera-target`,
  `frame-recolumn-995`, `frame-resize-camera`, `viewport-motion-671`,
  `recap-note-first-column-1767`, `column-gap`, `camera-immediate-intent`,
  `left-column-motion`, `left-column-grid-1326`, `left-column-824`,
  `relayout-stored-1331`, `stored-layout-format`, `tool-bursts-camera`, and
  `session-box-camera` — **150 tests passed**.
- `git diff --check`.

New assertions cover the phantom column, portrait top anchoring, unchanged
landscape/square centering, and correction when only viewport y is wrong.

An isolated Chromium/Playwright harness runs the real Vite application with all
API requests intercepted and EventSource replaced by synthetic hook events.
It checks arrival placement, portrait framing, no page errors, and that a
verified manual pan survives a subsequent arrival. It captures matching
1080 × 1920 before/after screenshots and additional 1407 × 2535 portrait,
1920 × 1080 landscape, 390 × 900, 320 × 900 and light-theme 1200 × 1800 states.
Screenshots and the harness are kept in the local companion report folder.
The reporter's private screenshots and real account/session data are excluded.

## Limits

The in-app Browser plugin could not bootstrap because its configured runtime
module was missing; browser evidence comes from an isolated Chromium instance.
The original reporter's exact persisted positions were not available. This
reproduction demonstrates the two defects with controlled application state.
Very narrow windows can still require panning to reach a wide subagent tree
because the existing minimum zoom is preserved. This is not a mobile canvas
redesign. No live Windows desktop run or complete repository test run was
performed for this platform-independent frontend fix. This branch has not been
merged into development.
