# Rendered iteration

Before editing, identify the actual served checkout/build and available browser tooling. Prefer the project's existing browser automation and isolated contexts. Do not reuse personal tabs, alter accounts or add a large dependency just to capture a screenshot.

Capture the incumbent state at known viewport dimensions with privacy-safe content. Implement the coherent change, then capture the same state at the same size. Synthetic fixtures must be labeled; they test rendering and transitions, not live-provider truth. Wait for finite transitions to settle before geometry/contrast comparisons.

Batch relevant states: default/success, empty/loading/error/partial, selected/hover/keyboard focus, expanded details, long content and many records, narrow and short viewports. Inspect top/middle/bottom when scrolling matters. Test actual actions, selection persistence, errors, data updates, focus restoration and reduced motion; screenshots alone cannot establish them.

Inspect computed sizing, clipping, hit targets, text contrast, scroll ownership and the actual pointer/keyboard distinction. Do not assume tall rows are caused by padding: check stretching, grid tracks, flex growth and distributed space. Do not enlarge a dialog without demonstrating more useful workspace.

Review the batch, fix justified defects together and capture a confirmation batch. Further rounds require failed checks or new evidence, not a new aesthetic preference. Respect the scope and any specialist workflow's stricter review ceiling.

Keep artifact locations, viewport/state names and evidence of tests. If rendering cannot run, record what was attempted, verify source/tests where possible and explicitly mark visual verification incomplete. Do not manufacture before/after images or treat a generated mockup as the application.
