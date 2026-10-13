# Tool activity audit

Issue [#2122](https://github.com/BarganConstantin/ccdeck/issues/2122).

Open **Tool activity** from the rail button below Usage history (on narrow screens,
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
its duration/outcome belongs to that call. The shared-interval marker and measurement
notes disclose this. Repeated inner executions cannot be counted independently.

Completed success/failure calls contribute to total, median, maximum and P95
elapsed intervals; P95 requires 20 valid samples. Error percentages use completed
observed outcomes. Claude uses hook receipt intervals; Codex passes rollout
source timestamps through the watcher to the collector without changing canvas
receipt-time semantics. Invalid, missing or negative intervals are unavailable,
not zero. Calls with no outcome stay unmatched rather than being settled by the
canvas's stale sweep. Parallel calls overlap, so total tool time is not elapsed
session time. Wrapper intervals include orchestration/delivery/approval waits.

The current full-page Direction A report is documented in
[tool-activity-report.md](tool-activity-report.md). Provider/period/custom UTC date
filters and search scope the report. Four simultaneous sections compare
frequency, cumulative associated intervals, eligible median/P95 endpoints, and
reported failed-call counts with completed denominators. Failure rates use at
least20 completed outcomes, a descriptive sample floor rather than a confidence
guarantee. No operation percentages imply additive time shares.
Search filters charts and the complete sortable operations table; overview totals
remain provider/period-wide. Selecting any operation opens the same focus-protected
side drawer without changing report scroll. Selection survives search, sorting
and refresh while the operation exists. The table exposes all operations in
50-row increments; narrow layouts retain exact values and detail access.
Requested period, earliest/latest observed starts and retained recording boundary
are distinct. Period filtering uses call starts; an entire completed interval is
included even when its outcome arrives after the range. The overview cumulative
interval sums each measured call once, not operation totals; it still overlaps
parallel/nested calls and is not wall-clock execution time. Selecting an operation reads its 20 slowest measured calls or latest 30
recorded calls. Activity/outcomes and measured intervals are separate detail
groups; definitions and source/coverage qualifications are progressively disclosed.
No full arguments/output drill-down is stored. Each request is a fresh snapshot;
details may include calls captured since the main ranking loaded.

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
The second-iteration finish reviewer inspected14 required captures and returned
`disposition: ship`, with no material fixes. It confirmed nine complete desktop
ranking rows versus six before, despite a smaller modal. This covers the scoped
interface, not accessibility certification or permission to merge.


The verified measurement audit is recorded in `tool-explorer-design.md`.
Earlier visual iterations are historical; the selected full report and premium
refinement, current screenshot evidence and actual validation are recorded in
`tool-activity-report.md`. Current checks:229 tests across eight suites,
TypeScript and production build, six requested Brave viewport sizes and all
nine themes. Separate live Codex integration was exercised; live Claude,
native Windows/Linux, Safari/Firefox and screen-reader certification remain
unverified. No new visualization dependency or collector change was introduced.

Manual browser runners: `scripts/qa-tool-explorer.cjs` uses intercepted,
deterministic fixtures; `scripts/qa-tool-explorer-a11y.cjs` reads the live preview.
Both require Playwright in the test environment and accept `CCDECK_QA_URL` and
optional `CCDECK_QA_BROWSER`. Set `CCDECK_QA_OUTPUT` to preserve a separate
screenshot directory for each review; `QA_PASS` names the capture batch.
No browser test dependency is added to production.
The live runner requires recorded `git status` calls. After the last local CSS
corrections, placeholder contrast exceeds 4.5:1 and ranking fill/track contrast
exceeds 3:1 in every theme. Resize preserves the selected inspector.
The final production build passed after those corrections; the existing large
bundle warning remains. Screenshots are local review artifacts, not collected
telemetry or repository fixtures.
