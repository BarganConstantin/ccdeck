# Sessions already working when ccdeck starts

Startup recovery is enabled by default. Settings → General has separate
“Restore unfinished sessions” switches for Codex and Claude; changes apply at
the next server start. Recovery obeys the deck's provider and workspace scope.
It restores a snapshot, never a new SessionStart or historical tool calls.
Existing tool statistics and reports do not count old calls again.

## Codex

The watcher reads up to 128 recent rollout tails (8 MiB per file, modified within
24 hours, at most 32 MiB of recovery tails per scan), including a bounded selection from older day directories. An explicit
task_started with no later matching task_complete or turn_aborted restores a
partial session, its current prompt and available model, effort, context and
cumulative usage. Explicit parent relationships also restore the family graph.
A recorded ending reconciles an existing session left active in ccdeck's history;
it does not create a card for an otherwise unknown finished session.

A missing ending is not proof that the process is alive: the card says
“restored” until live traffic arrives. Incomplete or changing snapshots are
retried after the file changes. Complete records before the captured cursor
are not replayed as tools. A thread with unexamined resumed rollouts is skipped
rather than classified using an older unfinished rollout. Files and turns
outside the limits are left to normal live capture. No approval state is guessed.

## Claude

Claude's local sessions registry can identify a session already busy before
ccdeck starts. Discovery examines at most 128 registry files, limited to 64 KiB
each, and requires matching PID, platform and process-start fingerprint. It
restores busy sessions only, using up to 256 KiB of transcript tail for the
current prompt and model. Existing transcript enrichers and output watching
supply usage and subsequent output, without replaying tool calls. The registry
is rechecked after reading the transcript. A busy-to-idle transition reconciles
the recovered card, and a newer live event takes precedence over a snapshot.

Process-start verification currently supports macOS and Linux. Other platforms,
older Claude versions without this registry, unsupported status/identity formats,
and unverified processes continue through normal live hooks. A verified process exit closes a recovered session; a failed registry read or
process probe is not an ending. The process start time is not presented as a recovered turn start time.
Claude's existing subagent graph and session accounting stay in use.
