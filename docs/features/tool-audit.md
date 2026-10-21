# Tool activity

Issue [#2122](https://github.com/BarganConstantin/ccdeck/issues/2122).

Open **Tool activity** from the rail button below Usage history (on narrow screens,
**More → Tool activity**). It is a device-wide page across Claude and Codex, independent
of the sessions on the canvas. Collection starts with new events after this build
starts; old sessions are not imported.

## What the page shows

One page that answers four questions in order, in plain words:

1. **How much.** One sentence for the chosen period (24 hours, 7, 30 or 90 days)
   and agents (all, Claude, Codex): how many tool calls, how much time was spent
   running them, and how many failed.
2. **Worth a look.** Up to three findings, each a fact read straight off the
   rows and each opening that tool's details:
   - *takes the most time*: the tool with the largest total time, shown only
     when it holds at least 20% of all tool time and was timed at least twice;
   - *fails often*: the highest failure share among tools with at least five
     finished calls, two failures and a 10% failure share;
   - *is the slowest*: the highest typical time ("usually", the median) among
     tools timed at least three times and usually taking 10 s or more, other
     than the time finding's tool.
   With too few calls a finding is left out rather than made up.
3. **Tools and commands.** One list with four orders — Most used, Most time,
   Slowest, Failures — and a search over names and descriptions. Each row shows
   calls, total time, the usual time and failures with their share of finished
   calls; the sorted column is the bright one and draws the row's bar. Twelve
   rows first, then all. A row carries a short description when the tool is
   known (`src/web/operation-glossary.ts`: exact names, plus `<pm> run <script>`
   and `mcp__<server>__<tool>` read off the name); unknown tools get none rather
   than a guess.
4. **One tool.** Selecting a row or a finding opens its details beside the list
   (a sheet on phones): the four numbers, who used it, the longest call, calls
   per day, and its latest 30 or slowest 20 calls with time, agent, duration and
   result. From 960px the line between the list and the details can be dragged
   (or moved with the arrow keys once focused) to make the details wider or
   narrower; a double click or Enter restores the standard 380px, the width is
   remembered in this browser, and the list always keeps at least 420px.

"How this is counted", folded at the bottom, says in six lines what the numbers
mean and where they stop: times include waiting for approval; total time adds
overlapping calls; "usually" is the median; a compound command line counts once
per command and shares its time and result; Claude and Codex time tools
differently; nothing but grouped names is saved.

P95, custom dates and per-chart views from the first iterations were removed on
2026-10-15: they answered the same questions as the list in harder words.

## What is recorded

Operations such as `git status`, `git commit`, `git push`, `npm run build`, and
`dotnet test` have separate rows. Variable arguments, messages, paths, and output
are not retained. Non-shell tool names remain concrete, including MCP names.
Codex `exec` wrappers are tokenized without executing JavaScript: literal tool
calls/commands can be classified; dynamic commands remain unclassified.

Calls count observed containing tool calls. Compound commands and orchestration
wrappers can contain several operations, but do not prove every conditional
branch executed. Each identified operation is counted once per containing call;
its duration/outcome belongs to that call. "How this is counted" says so in plain
words. Repeated inner executions cannot be counted independently.

Completed success/failure calls contribute to total, median and maximum elapsed
intervals (the API also returns P95 from 20 valid samples; the page does not show
it). Error percentages use completed
observed outcomes. Claude uses hook receipt intervals; Codex passes rollout
source timestamps through the watcher to the collector without changing canvas
receipt-time semantics. Invalid, missing or negative intervals are unavailable,
not zero. Calls with no outcome stay unmatched rather than being settled by the
canvas's stale sweep. Parallel calls overlap, so total tool time is not elapsed
session time. Wrapper intervals include orchestration/delivery/approval waits.

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

## Checks

`tool-audit.test.ts` and `tool-audit-history.test.ts` cover the collector,
retention, report aggregation and daily history; `tool-audit-report.test.ts`
covers the list orders, the findings' thresholds, the summary sentence and
failure shares; `operation-glossary.test.ts` the descriptions. The style
guards (`text-tiers`, `control-edges`, `type-ladder`, `dead-css`) hold the
page to the shared tokens.
