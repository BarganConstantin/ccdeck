# Missing-node drag callbacks

2026-10-14 · `fix/node-drag-missing-node` · base development `ff5b1846`.

Two private Windows desktop reports on 3.41.1 showed the same TypeError,
`Cannot read properties of undefined (reading 'type')`, in `onNodeDrag`
and `onNodeDragStop`. Attachments remain private.

## Confirmed cause and correction

React Flow core 11.11.4 resolves the dragged node against the current controlled
node collection. Its `getEventHandlerParams` uses `find`, so a node removed
during the gesture produces an undefined callback argument even though
`NodeDragHandler` declares a Node.

The application accessed `n.type` unconditionally in both callbacks. A failed
stop also left measurement suppression, the drag patch and the trash zone active.

Missing start/move arguments are now ignored. Stop always lowers the trash,
clears drag state and its patch, discards any group snapshot, and persists the
last valid positions before returning when the node is missing. Normal card
movement, group movement and intentional trash removal retain their behavior.

## Executed checks

- Before the correction, four regression cases failed with the reported TypeError;
  normal card movement and trash removal already passed.
- Real React Flow plus the actual drag/trash hooks in Chrome: remove the dragged
  controlled node between pointer movement and release. The original code raised
  both errors and retained drag/patch/trash state. The corrected code raised no
  errors, cleared all three, and allowed a subsequent drag.
- Browser resizing at 1280, 390 and 320 pixels produced no additional errors.
- TypeScript and production build passed.
- 114 tests in seven files passed, including seven direct callback regressions,
  removal, stored layout and adaptive/recolumn layout checks.

Browser evidence is local: `/tmp/node-drag-browser.log` and
`/tmp/node-drag-red.log`. Browser tests used synthetic nodes on macOS Chrome;
no native Windows desktop reproduction or reporter interaction history was available.
