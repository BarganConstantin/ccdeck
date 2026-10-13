# Tool activity audit

Issue [#2122](https://github.com/BarganConstantin/ccdeck/issues/2122).

Open **Tool activity** from the rail button next to Radio (on narrow screens,
**More → Tool activity**). This is a device-wide report
across Claude and Codex, independent of retained sessions on the canvas.
Collection starts with new events after this build starts; no old session import.

## What the report measures

Operations such as `git status`, `git commit`, `git push`, `npm run build`, and
`dotnet test` have separate rows. Variable arguments, messages, paths, and output
are not retained. Non-shell tool names remain concrete, including MCP names.
Codex `exec` wrappers are tokenized without executing JavaScript: literal tool
calls/commands can be classified; dynamic commands remain unclassified.

Calls count observed containing tool calls. Compound commands and orchestration
wrappers can contain several operations, but do not prove every conditional
branch executed. Each identified operation is counted once per containing call;
its duration/outcome belongs to that call. The shared-timing label and measurement
notes disclose this. Repeated inner executions cannot be counted independently.

Completed success/failure calls contribute to total, median, maximum and P95
elapsed intervals; P95 requires 20 valid samples. Error percentages use completed
observed outcomes. Claude uses hook receipt intervals; Codex passes rollout
source timestamps through the watcher to the collector without changing canvas
receipt-time semantics. Invalid, missing or negative intervals are unavailable,
not zero. Calls with no outcome stay unmatched rather than being settled by the
canvas's stale sweep. Parallel calls overlap, so total tool time is not elapsed
session time. Wrapper intervals include orchestration/delivery/approval waits.

Provider/period/custom UTC date filters, separate metric ranking and operation
search are in one visual explorer. Frequency, cumulative interval time and P95
are distinct primary questions. Median, maximum and reported failure rate are
also available; rate ranking uses at least20 completed outcomes, a descriptive
sample floor rather than a confidence guarantee. Exact values accompany bars.
Search filters operation rows, while overview totals remain provider/period-wide.
A contextual inspector preserves selection across ranking/search/refresh while
the operation still exists. On desktop it stays beside late rows with a bounded
independent scroller; on narrow screens it is inline after the selected row.
Requested period, earliest/latest observed starts and retained recording boundary
are distinct. Period filtering uses call starts; an entire completed interval is
included even when its outcome arrives after the range. The overview cumulative
interval sums each measured call once, not operation totals; it still overlaps
parallel/nested calls and is not wall-clock execution time. Selecting an operation reads its 20 slowest measured calls or latest 30
recorded calls. No full arguments/output drill-down is stored. Each request is a
fresh snapshot; details may include calls captured since the main table loaded.

## Local storage and boundaries

`deckDataDir()/tool-audit/` honors `CCDECK_HOME` and contains atomic settings plus
append-only daily JSONL metadata journals. Settings include a stable random
device identity, clear-generation identity, retention and collection start.
Call IDs hash device/generation/provider/session/call identity; raw session IDs
are not stored. This gives future synchronization a namespace without enabling
sync, uploading these records or aggregating other devices now.

General Settings shows actual journal/settings bytes, retention 30/60/90 days
(default90), size refresh and a separate clear action. Shorter retention and
clear require inline confirmation. Clear preserves device identity/retention,
changes generation and resets the collection start. Retention is by UTC journal
day; older files are physically removed on startup, active collection and reads.
Only tool-history files are affected; the canvas/event log/quota history remain
independent.

The ingest path queues small sanitized records and batches disk writes. At most
25,000 pending events are buffered; failed/dropped records are disclosed for the
running process. A report flushes queued observations, captures file sizes and
runs streaming aggregation in a bounded worker. Graceful launcher shutdown
drains pending tool records with a three-second deadline; an abrupt kill can
lose the last not-yet-written batch. Workers use the already-loaded
report function, so an on-disk self-update cannot mix report implementations.
Closing/changing a report cancels its worker. There is one report worker per
process; UI briefly retries a busy response during cancellation.

Report limits: 64MiB per daily journal, 500,000 distinct retained calls, 256MiB
worker heap, 60-second deadline. Exceeding these fails the report rather than
silently returning partial totals. Raw journal records are validated; skipped
corrupt rows and unmatched outcomes are disclosed. Retention reduction can
reduce the retained workload. Collection failure cannot stop the event stream.

Current implementation is intended for one writer per deck data directory.
Concurrent ccdeck processes using that same directory share files, but settings
and clears are not coordinated across those processes. Use separate
`CCDECK_HOME` directories for separate preview instances. Durable dropped-write
accounting and coordinated multi-process clear are future work before remote
sync.

## Interaction and verification

Radio's `radioOpen`200ms entry is reused; keyboard entry and reduced motion are
instant. While actual aggregation runs, an indeterminate indicator and skeleton
show work without invented percentages. The report updates on open/filter/change
or Refresh, not a background polling loop. Escape restores focus to its rail entry (or More on narrow screens).

Preview: `http://127.0.0.1:4545/`, backend4546,
`CCDECK_HOME=/tmp/ccdeck-tool-audit-preview`. Owner's installed deck is untouched.
Browser QA uses isolated contexts and intercepted fixtures; those fixture records
are never saved to the live preview. Unit tests cover normalization, paired
outcomes, zero/missing timing, duplicates, restarts, replay exclusion, retention,
clear, corruption and validation. A real watcher integration asserts the4500ms
rollout interval for call/output records consumed in one batch. Existing modal,
settings, guarded-read, self-update and Codex translation checks also pass.
Brave covers all nine themes at1280/390/320px, table/details, ranking/search,
loading/empty/error/storage states, keyboard/reduced-motion, refresh dedup and
retention/clear confirmations. Typecheck and production build are required.


Browser execution was on macOS Brave; Windows/Linux native execution is not
claimed. SVG icons inherit theme colors without depending on emoji rendering.
Two independent design assessments informed the redesign. The finish reviewer
requested three fixes (upfront incomplete-history notice, persisted layout and
direction contract), then scored all three resolved with a ship disposition at
that fix scope. This is not a fresh whole-surface accessibility certification.


The redesigned explorer's measurement audit, three-concept evaluation and
selected information architecture are recorded in `tool-explorer-design.md`.
217 relevant checks passed, including17 audit tests plus real Codex watcher,
modal/portal/rail-shortcut and contrast regressions. Brave fixture QA covers
all nine themes at1280x950 and320x780, plus1024x768,390x844 and1280x540;
ranking, search, selected refresh, keyboard inspection/focus return, dense210
operation types/late row selection, missing timing, empty/error/incomplete/no
failure/loading and reduced-motion states. Computed readable text contrast was
sampled across the rendered modal in all themes; this is not accessibility
certification. Real live Codex UI was exercised (664 calls/79 operations at the
verification snapshot). Typecheck and production build pass. Native Windows/Linux
execution and a real Claude hook stream are not independently verified.

Manual browser runners: `scripts/qa-tool-explorer.cjs` uses intercepted,
deterministic fixtures; `scripts/qa-tool-explorer-a11y.cjs` reads the live preview.
Both require Playwright in the test environment and accept `CCDECK_QA_URL` and
optional `CCDECK_QA_BROWSER`. No browser test dependency is added to production.
The live runner requires recorded `git status` calls. After the last local CSS
corrections, placeholder contrast exceeds 4.5:1 and ranking fill/track contrast
exceeds 3:1 in every theme. Resize preserves the selected inspector.
The final production build passed after those corrections; the existing large
bundle warning remains. Screenshots are local review artifacts, not collected
telemetry or repository fixtures.
