# Memory retention checks

Measured on macOS with Node 22 and a Chromium browser, 2026-10-29.
The figures below describe controlled workloads, not a guaranteed reduction in
whole-app RSS. No session history or feature retention limits were reduced.

## Confirmed and fixed

- Static compression cache: old build paths accumulated indefinitely. An 8 MiB
  LRU byte budget and a 1,024-entry backstop now bound it.
- Small compressed assets: zlib's small results retained a 16 KiB backing
  allocation each. Exactly-sized cached buffers reduced a 128-file synthetic
  workload from about 2 MiB to 19 KiB. Compressing all 274 text assets in the
  measured build retained about 5,171 KiB before and 1,457 KiB afterward.
- Radar wire parser: empty slices retained consumed packet allocations while
  HTTP/2 connections remained idle. Sixteen completed synthetic exports retained
  about 799 KiB before and 8 KiB afterward, with all exports and receipts decoded.

Regression coverage lives in `serve-lighter-883.test.ts` and
`telemetry-capture.test.ts`, including decoding, chunking and connection reuse.

## Settings lifecycle

`verify-ui-memory.mjs` launches an isolated browser profile and intercepts every
API call. The account roster is empty, auto-switch is disabled and other API
features answer unavailable. It warms Settings with five opens, then measures
heap, DOM nodes, listeners and documents after two batches of thirty opens.
Garbage collection runs before each measurement.

| Measurement | Warm | After 30 | After 60 |
|---|---:|---:|---:|
| JS heap, MiB | 6.8 | 7.3 | 7.5 |
| DOM nodes | 471 | 471 | 471 |
| JS event listeners | 375 | 376 | 375 |
| Documents | 4 | 4 | 4 |

No persistent DOM or listener growth was observed in this scenario. Small heap
changes alone do not establish a leak. This does not cover every Settings tab,
populated trackers, real telemetry, long sessions or Electron's native memory.
The script reports measurements rather than enforcing a machine-dependent heap
threshold; unexpected render errors fail the run.

Run against a locally built server:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
PLAYWRIGHT_EXECUTABLE=/path/to/chromium \
node scripts/verify-ui-memory.mjs http://127.0.0.1:4317
```

The browser and its temporary profile close when the script finishes. Static
files are read from the server; synthetic API requests do not reach it.

## Tool preview strings

Confirmed a retained-string problem in `shortPreview`: truncating a serialized
input and appending an ellipsis left V8 holding the complete serialized string.
That preview survives when the tool history releases the original input blob.
The preview now materializes its short characters in an independent string.

A synthetic reducer workload applied 80 completed Write calls, each with a
1 MiB input. Both Node 22 and an isolated Chromium context measured:

| Measurement | Before | After |
|---|---:|---:|
| Retained JS heap, MiB | 105.1 | 25.1 |
| Retained tool calls | 80 | 80 |
| Recent complete inputs | 25 | 25 |

Measurements were taken after explicit garbage collection. The 80 MiB saving
is specific to this large-input workload, not a prediction for every running
deck. Displayed preview text, Unicode, tool counts and the full-input retention
window are unchanged. `tool-preview-memory.test.ts` covers both the preview
function and the reducer workload, alongside the existing tool-history tests.

## Session churn and canvas dimensions

A reducer workload with 100 completed sessions and 2,000 Write calls (16 KiB
inputs) retained about 32.4 MiB before pruning and 0.2 MiB afterward. Both the
agent map and in-flight tool index were empty after pruning. No heavy-payload
retention was demonstrated at that boundary.

A separate hook-level test found stale canvas measurements: replacing 200
sessions left 200 size records. The measurement pass now removes entries only
when neither the graph nor React Flow holds the node. Hidden live sessions and
their recap notes retain their dimensions. This bounds a small per-session
retention; no whole-app MiB saving is claimed for it.

The built UI was also exercised in isolated Chromium with three synthetic live
sessions and 60 Settings cycles: 685 DOM nodes stayed constant, listeners were
557 initially and 558 at the end, and JS heap went from 8.5 to 9.4 MiB. No render
errors occurred. This checks the changed hook in the app, alongside tests for
measurement feedback, dragging, node removal and hidden-session retention.

## Tracker request lifetimes

Confirmed two cancellation gaps in tracker hooks:

- GitLab/GitHub Load more requests had no AbortSignal or cleanup on project
  changes, refresh or unmount. They now abort at those boundaries and ignore
  late completions, including transports that do not honor cancellation.
- Completed first-page forge reads and Jira issue reads could still populate
  caches after cancellation. They now check ownership before storing results.
  A delayed Jira detail previously replaced the newer issue's hook state.

Regression tests cover unmount, changing projects, late detail completion and
normal page append/cache behavior. An isolated Chromium harness using the real
forge hook switched projects 40 times with a page pending: all 40 requests were
aborted, the visible list remained correct and there were no render errors.
This prevents unwanted work and retention; no whole-app MiB reduction was
measured or claimed for this change. Cache capacities and completed pages that
still belong to the open project are preserved.
