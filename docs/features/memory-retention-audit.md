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
