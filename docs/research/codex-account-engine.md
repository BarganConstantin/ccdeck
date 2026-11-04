# Codex account continuation engine

Research baseline: ccdeck 3.53.1, Codex CLI 0.166.0 (2026-11-02).

## Scope and boundary

The engine supervises local `codex exec --json` and interactive native Codex TUI
sessions launched through ccdeck's existing terminal integration. Both resume an
exact saved conversation on another configured account after a terminal quota
failure. The interactive adapter owns an app-server process and keeps the TUI
connected to an authenticated, single-client loopback bridge during the handoff.
Claude stays on its existing cswap path. A separate shared-daemon adapter now
covers supported already-open native application/IDE conversations; see below.

## Initial account synchronization (2026-11-04)

Codex sends `account/updated` to a newly initialized connection after saved
workspace routing is ready. This is an initial snapshot, including when the
account has not changed. Its asynchronous delivery can follow `account/read`.
See the [upstream routing notification implementation](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/app-server/src/request_processors/account_processor/workspace_routing.rs).

The live controller consumes one initial snapshot while establishing its account
baseline. When `account/read` supplies workspace routing, it waits up to 30
seconds for that snapshot before claiming control or attempting a login. A late
snapshot is followed by another account read. Missing confirmation fails without
changing authentication or interrupting work. Additional updates and unsolicited
login completions still invalidate control; restart and reconnect still require
matching native account IDs.

Verification included 20 read-only comparisons against a running native daemon:
the published controller falsely paused on all 20 initializations, while the
corrected controller accepted all 20. These comparisons did not change accounts
or generate inference. Regression tests separately cover manual reconnection,
delayed or missing snapshots, outside changes and identity mismatches.

An activity change between the handoff snapshot and the final quiet check is
also an observation race. Before any login or durable interrupt/checkpoint has
been sent, the controller retains the current request as waiting and checks
again through the normal handoff path. Tools must still finish first, and an
outside login cancels the pending request. Once any interrupt or authentication
may have been sent, the existing recovery rules apply; this retry does not
replay uncertain work. Regression tests cover new activity, tools staying busy,
outside login cancellation and an unreconciled interrupt.

## Research

- [yunkai93/codex-switch-account](https://github.com/yunkai93/codex-switch-account),
  revision `218dde4287194d798f88a23c1a1f78411f1a3d17`: Bash/Python terminal
  supervisor confirms quota, then switches and invokes `codex resume <id>`.
  It shares a home and copies authentication snapshots. Do not port that storage
  model into ccdeck's isolated homes.
- [JIMyungSik/codexswitch](https://github.com/JIMyungSik/codexswitch), revision
  `861b4b65cfa8c782f9de9b5d0976add828de529b`: JavaScript exec supervisor and
  experimental HTTP proxy. Exec rotation uses `resume --last`, unsuitable for
  concurrent ccdeck sessions. The proxy chooses WebSocket auth at handshake;
  its raw-byte tunnel cannot rotate an already-open connection. Its smoke suite
  passed locally with a fake CLI and a local upstream; that is not live-account
  acceptance.
- [Gaebabi/codex-switch](https://github.com/Gaebabi/codex-switch), revision
  `88a6ba432eb491080278ddeca97f688639408bdd`: desktop restart/reopen/Continue
  coordinator, with checkpoints and explicit handling of ambiguous sends.
- [Official non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
  documents `thread.started`, `turn.failed`, `turn.completed` and exact-ID exec
  resume. Local CLI help confirms `codex exec [options] resume <id> <prompt>`.

All three community projects declare MIT. This implementation is written for
ccdeck, without copied source; those projects inform the architecture only.

## Design

`account-engine.mjs` owns selection and bounded continuation. The adapter owns
processes, provider events and transcript transfer. Only a terminal quota error
may trigger continuation; text in assistant/tool output, transient 429s, network
errors, user cancellation and unknown results must not trigger it. Never use
`--last`. Never retry an account already attempted in this run. Fresh usable
quota is required; empty/stale readings do not mean available capacity.

A handoff transfers the exact rollout after the old process exits. It does not
copy or refresh login credentials and does not change the global default. An
existing destination transcript is a conflict, not permission to overwrite it.
Only the local terminal integration that opted into ccdeck selection participates.

## Acceptance

Automated tests use fictional credentials and fake processes. Real authenticated
cross-account continuation, OS-specific native process behavior and model/plan
compatibility must be reported separately from those tests. A generic engine
interface is not evidence that unsupported clients have been integrated.

## Verification on the implementation branch

- Initial exec adapter on Node 22: 63 Codex and engine test files passed (772 tests), including
  terminal installation, Auto-switch, account discovery, live watcher and recovery.
- `npm run typecheck` and `npm run build`.
- `node scripts/verify-codex-engine.mjs /absolute/path/to/codex` runs the actual
  installed CLI against a loopback mock Responses provider. With Codex 0.166.0,
  one request failed with a terminal quota error; after transfer to a second
  temporary home, exact-ID resume completed on the next request. No real login
  or authenticated inference was used.
- Upstream Codex's `codex-rs/rollout/src/policy.rs` excludes `EventMsg::Error`
  from durable rollouts. Tailing rollout files alone therefore cannot reliably
  supervise interactive quota failures. The TUI needs a supervised PTY or an
  app-server integration, with independent conversation identification; it is
  not claimed by the exec adapter; the interactive adapter uses app-server RPC.

The terminal installer copies the engine's local module closure into its durable
folder. Updating an existing integration is explicit through the existing install
command; no production shell profile is modified by this branch's verification.
Source/destination user configuration must match, and conflicting transcripts or
conversation leases stop continuation rather than rewriting or duplicating work.

Transferred files are published atomically with an exclusive link and a private
sidecar recording the copied prefix. The live Codex watcher skips that prefix,
so old prompts and tool calls are not re-emitted as new activity after a handoff.
Exec continuation keeps the original rollout in its source home. Interactive handoff moves it to an owner-only source backup, including its prefix receipt, so later round trips can publish a fresh active rollout without collisions.

An unrelated profile quoting test used the real registry when its explicit
environment omitted a data directory. The failure reproduced on unmodified
3.53.1. Its quoting assertions now run against a temporary registry.

## Interactive adapter

`codex-interactive-engine.mjs` connects the same generic account engine to the
native TUI's `--remote` transport. A pinned MIT `ws` dependency implements framing;
it is bundled with the package and copied with its licence into the durable
terminal helper. The bridge requires a random bearer token, accepts one local
client, rejects browser origins and never puts authentication or prompts in logs.
The token is passed in a child environment variable, not in the URL.

The old server must exit cleanly after a terminal `turn/completed` failure whose
`codexErrorInfo` is exactly `usageLimitExceeded`. Other turns, observed tools,
processes and outstanding approvals prevent a handoff. The replacement server
initializes with the TUI's original capabilities, resumes the exact thread with
its saved overrides, and submits one follow-up with a unique client message id.
Per-turn approval, sandbox, model and effort fields are retained. Native approval
requests and human responses pass through the bridge. The backend has its own
POSIX process group so a terminal Ctrl+C reaches the TUI without killing it.

The native TUI also runs auxiliary requests on other threads. Those requests
must not be mistaken for a same-thread user interruption during the handoff.
One unsent same-thread follow-up can be held and forwarded once in place of the
engine's Continue. An explicit interrupt cancels that submission. Closed-thread
notifications caused by shutting down the old backend are suppressed during
migration so the TUI does not race the engine with its own resume.

Failure to select a target restores the current thread idle without submitting
another prompt. The automatic attempt loop then stops; a later manual selection can rearm it without relaunching the TUI, and manual retries stay usable. Unknown/ambiguous submission outcomes are
never replayed. A TUI that changes conversation ownership can likewise require
a fresh managed launch. This is not a desktop-app integration or a promise that
arbitrary externally launched sessions can be taken over.

### Interactive verification

- Fake-process tests exercise one connection across two backends, exact-thread
  continuation, approvals, no-capacity recovery, non-quota failures, queued
  follow-up/interrupt races and local transport authentication.
- `node scripts/verify-codex-interactive-engine.mjs /path/to/codex` exercises
  actual Codex app-server 0.166.0 against a local fake Responses provider: one
  request hits the limit, the second completes on the same resumed thread.
- The same probe with `--tui` ran the actual native terminal on macOS in a PTY:
  accept trust only for its temporary workspace, submit a prompt, observe
  `INTERACTIVE_RESUMED_OK`, submit another prompt on the new backend, then quit.
  The same TUI remained open. Real logins, external inference and production
  shell configuration were not used.
- Windows/Linux native TUI acceptance is not established by the macOS probes.
  Authenticated macOS acceptance was subsequently performed as recorded below.

Final interactive branch checks on Node 22: 68 relevant test files / 820 tests,
typecheck, production build, and package dry-run. The package contains `ws` and
its original licence; the copied terminal helper imports the interactive adapter
without depending on the source checkout. The runtime dependency audit reports
zero advisories. The desktop licence check now verifies the actual MIT text for
`ws`, alongside the existing Apache licence assertions for native lock packages.
A dedicated signal test confirms that terminal Ctrl+C does not kill the owned
backend, and a timeout test confirms that internal submissions are not retried or
leaked into the TUI as late responses.

## Manual switching and authenticated acceptance — 2026-11-02

A manual Accounts selection atomically records a separate running-session intent
in the local registry. Managed interactive engines poll its revision, including
with Auto-switch disabled. Automatic changes of the launch default do not create
that intent. The engine waits for owned tools, other active turns, outstanding
requests and approvals, then interrupts the foreground turn by its exact ID.
A confirmed interrupted turn receives one Continue after the backend changes;
a completed or idle turn receives no extra prompt. Ephemeral title-generation
threads never replace foreground ownership. Metadata requests arriving during
the handoff are held once rather than turned into native TUI warnings.

The configuration snapshot comes from native raw config layers, merged in native
priority order. The effective display view is not a round-trip format: its null
policy fields can become invalid override values. Settings remain in memory and
are sent through native RPC, never process argv or rewritten account files. Empty
or project-trust-only login homes inherit the original CLI settings at launch.
A destination with unrelated runtime settings is refused. A separate lease is
held for every transferred foreground thread.

Real Codex CLI 0.166.0 on macOS was exercised with two existing authenticated
ChatGPT accounts, including the installed durable terminal helper with automatic
rotation off. Native /status showed different account/workspace identities with
the same conversation ID and retained model and permissions. A marker established
on the first account was recalled on the second. Switching while a shell command
was active waited for it to finish, interrupted the response, and completed the
remaining task on the other account. The command's artifact contained exactly
one START and one DONE. Starting directly on the isolated second account and
switching back was also verified. Credentials were handled by the native CLI;
no authentication files were copied. Production shell integration and the
installed dashboard were not replaced by these checks.

The real plugin catalog also exposed a transport limit: native responses can
exceed 16 MiB. Frames now have a 64 MiB bound and are accumulated without repeated
scanning of earlier chunks. A large-frame regression and native TUI startup
verify this path. Internal resumes request metadata only with excludeTurns,
avoiding deprecated full-history hydration.

### Follow-up host recheck

The owner's launcher failed after the package audit because its npm pack report
was saved as an ancestor `package.json`. Renaming the report restored startup.
The installed helper now also owns a private ESM package scope; its module import
regression runs beneath an invalid ancestor manifest and fails on the prior
implementation. The focused terminal/interactive/config suite passed 26 tests,
plus TypeScript and the production build.

A fresh native child and a visible Terminal demo confirmed both account
identities through `/status`, retained the same thread and permissions, and
recalled a marker after switching. A status request during the handoff can render
the previous account; an automated check five seconds after Switch passed. The
visible demo remains separate from the independently launched Codex application.

## Existing native app conversations — 2026-11-02

`codex-live-engine.mjs` connects to an already-running Unix app-server rather
than replacing that process or moving its threads. Controlled handoffs may
briefly attach to its live state through native resume; see the update below. Discovery uses
`codex app-server daemon version`; the control socket, parent ownership and
socket generation are checked before authentication. A per-home lease prevents
two ccdeck processes from driving the same daemon.

The [official app-server protocol](https://learn.chatgpt.com/docs/app-server)
describes WebSocket transport over Unix and experimental `chatgptAuthTokens`
login, followed by host-owned renewal via `account/chatgptAuthTokens/refresh`.
The credential reader asks its own native stdio process to inspect/renew a known
profile, stops only that reader, then checks a private regular file and identity.
Only access tokens enter shared-server memory; neither login files nor refresh
tokens are copied. Login and renewal are serialized, near-expiry tokens renew
before submission, and public errors omit provider payloads. Unknown account
changes pause ownership. Native login timeout is not replayed automatically, including across restart:
a newer unconfirmed request is adopted only when the native identity already
matches. Otherwise the surviving saved account keeps renewal ownership and
changing to the requested account requires a fresh manual selection.

Upstream source at `rust-v0.166.0`, commit
`6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`, informs these boundaries:

- `app-server/src/account_processor.rs` installs external auth in the shared
  auth manager used by loaded threads.
- `core/src/client.rs` invalidates connection/routing state on auth revision
  change; the next request sends full context. An already-submitted stream is
  not moved retroactively.
- `core/tests/suite/client_websockets.rs`,
  `responses_websocket_reconnects_after_account_switch`, covers replacement
  within the same client session and a subsequent turn.
- External-token renewal is broadcast to initialized clients and the first
  response/error wins. Other hosts can race that callback. Proactive renewal
  reduces callback dependence but this experimental native behavior remains
  an interoperability limit; ccdeck cannot repair the daemon's own races.

Acceptance with the actual CLI and two authenticated ChatGPT profiles used an
isolated Unix daemon. A model response completed on each account in one thread,
and the second recalled the first turn's marker. Both source auth files stayed
byte-identical, no auth file appeared in the isolated daemon home, and closing
ccdeck's control connection left that daemon/thread alive.

The existing application daemon was then switched through the running dashboard
API. `account/read` confirmed the selected second account and `thread/read`
confirmed the original application conversation ID, without a daemon restart.
Before controlled handoffs were added, the app stopped its active task with
`application network permission was revoked`;
the owner's subsequent Continue resumed that same conversation on the new account.
This established the need for the controlled handoff described below.
Windows/Linux native acceptance remains outstanding. The adapter requires
Codex 0.166.0 or newer and file-backed ChatGPT authentication.

## Controlled native handoff — 2026-11-02

The exact revocation was reproduced with the real CLI in an isolated Unix
app-server: changing accounts during a streamed response failed that turn with
`application network permission was revoked`. The upstream
[`http-client/src/network_policy.rs`](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/http-client/src/network_policy.rs)
explicitly invalidates old account-bound permits. Disabling those checks is not
part of this fix.

`codex-live-handoff.mjs` instead inspects all loaded threads before login. It
waits for observed tools, user-input/approval flags and active child agents.
Legacy turn pages merge the live listener snapshot. Paginated stored pages omit
transient tool starts, so those active threads require a native live attachment:
`thread/resume` with no configuration overrides, `excludeTurns: true` and a
single full `initialTurnsPage`, immediately followed by unsubscribe. Pending
requests replayed to that connection are ignored; the original frontend keeps
handling its own tools and approvals.

The adapter interrupts only the exact observed turn, verifies that its terminal
state is interrupted, rechecks daemon quiescence and account/control identity,
then changes authentication. An interrupt can acknowledge natural completion;
that case must remain idle. One Continue is submitted only for an interrupted
thread whose ID and terminal turn still match. It carries no sandbox, approval,
model or tool override. New input, uncertain identity, lost control and a changed
turn stop automatic continuation. Unknown item lifecycle blocks interruption.

All interrupted entries and each continuation send phase are journaled privately
before sending. Token values, prompt text, paths and tool content are absent.
An uncertain Continue is not retried; startup reports the unfinished journal
independently of whether authentication ownership can be restored. Deferred
automatic moves recheck Auto-switch before acting.

Real acceptance covered both a pure response and a native shell command. The
command slept while a manual switch was requested: the engine returned waiting,
then switched and automatically continued the same conversation. The test
artifact contained one START and one DONE, the remaining task finished on the
second account, no revocation occurred, and both source auth files stayed
byte-identical. The native server was not replaced. The owner's current task
was not used for a second disruptive switch during this acceptance.

### Active subagent families — 2026-11-03

The installed native protocol reports `canAcceptDirectInput` on loaded threads.
Codex 0.166.0 explicitly rejects direct input to internal multi-agent v2 children
in `request_processors/thread_input.rs`; no public agent-control RPC bypasses
that restriction. Their active work still keeps a handoff waiting. V1 children
that explicitly accept direct input can now pause and continue in place.

The coordinator retains the loaded ancestry, rejects missing/cyclic ancestry,
and pauses parent turns before child turns. An in-progress `collabAgentToolCall`
is interruptible only when it is a `wait` sent by that parent for known
descendants; spawn, input, close and all other active tool calls still block the
whole handoff. Continuation reverses the order, verifies the child's unchanged
parent and input capability, and preserves each turn's root attribution. The
private journal records the child-parent IDs alongside the existing send phases.
Finished turns and new client input still win over automatic continuation.

Real shared-daemon acceptance switched a native V1 child and this parent in both
directions while the child wrote a long report. A second round trip observed
the parent's actual native wait before switching. Each handoff retained the
same child ID, parent link and root-turn attribution and resumed both threads
automatically on the confirmed target account. Separate isolated native tests
exposed V2 children that reject direct input; those stayed running while the
coordinator returned waiting, without applying the account change.
The V1 child then completed its report and delivered its normal completion
notification to the same parent. Native stored turns confirmed the final
marker, no new network-revocation error and byte-identical source authentication
files. The selected original account was restored after both round trips.

### Web research and cooperative V2 continuation — 2026-11-03

The inspected alternatives do not provide a drop-in native control endpoint for
parent-owned V2 children. [Codex's ownership change](https://github.com/openai/codex/pull/40464)
deliberately keeps direct input with the parent while allowing interruption.
[The direct-input issue](https://github.com/openai/codex/issues/33885) describes
a fork that changes Codex itself. [codex-switch](https://github.com/joshp123/codex-switch)
routes inference through a local proxy and pins each task to an account;
[cxswap](https://github.com/PavloPopravkin/codex-swap) documents selection for
new processes. Neither approach was installed or ported. The selected path uses
the installed Codex and its [native parent follow-up tool](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/src/tools/handlers/multi_agents_v2/followup_task.rs).

A direct interrupt prototype established that the same V2 child can resume
through its parent. Review then found a reason not to ship interruption as the
V2 preparation mechanism: native send/followup operations do not publish every
tool-start item. An empty V2 snapshot does not establish model-only execution.

The final implementation instead queues an expected-turn parent steer with a
durable client message ID. The parent asks its existing agents to finish current
tools and end with a unique checkpoint marker, retaining unfinished work in
their conversations. Authentication waits for terminal checkpoint replies and
global quiescence. It revalidates cached checkpoint turns and owner input before
acting. Known V2 parents with only idle children wait rather than being natively
interrupted. Unexpected new work keeps the handoff waiting or requires recovery.

After the account changes, the same parent calls native `followup_task` for the
checkpointed agents. A completed temporary checkpoint is explicitly distinguished
from a finished assignment. Child identity, parent link and root attribution are
checked from live snapshots; stored paginated history can still show the previous
terminal turn. The row remains pending until those new child turns are observed.

An uncertain send is never retried. Checkpoint preparation has a two-minute
deadline and child resumption a one-minute deadline. Expired delegation remains
tracked, and unresolved journals survive restart and block replacement by later
handoffs. Manual selection takes priority over deferred credential renewal.
Observed new owner work can reconcile recovery without sending more input.

Real final acceptance used two native V2 children and a parent in an isolated
authenticated daemon. Each child completed a 35-second command once, checkpointed
its remaining second stage, resumed on the second account and finished its guide.
Both children and the parent completed. No V2 native interrupt or direct child
input was sent, no network revocation occurred, the daemon was not restarted,
source authentication files stayed byte-identical, and no auth file appeared in
the test home. Earlier prototypes and regressions are not the final acceptance.

Protocol boundaries remain: there is no atomic model-only interrupt or
expected-idle precondition on `turn/start`, and concurrent independent clients
can race between checks. Native completion does not identify who requested Stop.
Strict preservation of simultaneous frontend cancellation needs frontend
cooperation. The adapter checks observed changes and never claims exactly-once
execution for unacknowledged requests. Initial snapshots may not establish every
older background process; no process is killed or restarted by this adapter.

### Shared daemon acceptance with an empty native conversation

A later real-app test found a case absent from the isolated initial acceptance:
an opened, idle conversation with no first message makes `thread/turns/list`
reject with the native not-materialized error. The RPC adapter recognizes only
that exact error on that read method. The coordinator rechecks that thread's
idle state before ignoring the missing history; other errors and concurrent
activity still block switching. A regression captured the original failure.

Existing follow-up messages no longer make a working turn permanently unsafe.
The coordinator retains their IDs and checks that the same inputs remain at
handoff boundaries, including immediately before Continue. It does not copy
message content into its journal. The continuation honors the latest recorded
instructions and does not ask to repeat completed actions.

Acceptance on the owner's actual shared daemon then switched the current
application conversation and automatically began its continuation on the
requested second account. Native reads confirmed the same thread, an interrupted
prior turn, no new network-revocation error and unchanged source auth files.
The empty native conversation stayed idle. The test preview was detached from
the conversation's command lifecycle, since a permanently running preview
command otherwise correctly prevents a tool-safe handoff.

### Ephemeral jobs and completed web searches — 2026-11-03

The reverse real-app switch uncovered idle ephemeral native jobs alongside
ordinary conversations. Codex rejects stored turn-history reads for those jobs.
The coordinator now recognizes the ephemeral metadata, confirms idle twice,
and leaves that job alone. An active or uncertain ephemeral job keeps the
handoff waiting. It does not require unsupported history calls or issue an
interrupt against the ephemeral job.

Native `webSearch` items can report completion solely through `completedAtMs`,
without a status field. A positive finite completion timestamp now counts as
finished unless the item explicitly remains `inProgress`. Missing timestamps,
unknown lifecycles and contradictory activity still block the handoff.

Acceptance used an actual shared-daemon root conversation searching for ten
recent Moldova news items. Seven completed search operations preceded the
account changes; the same conversation switched second account → first account
→ second account while writing its report. Each switch had a verified native
account, an interrupted prior turn and an automatically started continuation.
The completed report contained about 2,500 words and the requested completion
marker. No search was repeated after the handoffs, and the stored turns had no
network-permission revocation error. The running monitor timed out before the
long report finished; a later native-history read established its completed
state without rerunning the task. Existing original-profile auth files had
modification times predating the test thread.


## Windows transport and portable accounts — 2026-11-03

The Windows adapter uses the official Codex 0.166 `app-server proxy --sock`
byte relay for WebSocket framing over AF_UNIX. It does not use named pipes
or expose a local TCP listener. Endpoint paths and generation are checked
through Win32 reparse metadata: Node 22 `lstat` returns EACCES for an actual
Windows AF_UNIX rendezvous. The fixed helper accepts only the AF_UNIX tag,
requires a protected current-user DACL and pins the parent during setup.
Private file guards also protect credential reads. Closing the connection
stops only its proxy, never the shared daemon.

Sources: official `openai/codex` tag `rust-v0.166.0` (`6ff1e1ca`),
`codex-rs/cli/src/main.rs`, `stdio-to-uds/src/lib.rs` and
`uds/src/windows_socket_validation.rs`. This adapter is original ccdeck code.

Windows QA used a private packaged 0.166 CLI and a detached source worktree on
Node 22.23.3. The existing global Codex 0.149.1 and ccdeck 3.53.0 were preserved.
An SSH token is elevated on that host; native QA therefore used a temporary
interactive task with a normal user token. A separate foreground native server
was used because Task Scheduler's job prevents managed-daemon breakaway.
Initial connection, account inspection, model listing, controller leases and
account changes worked, but inference initially returned a usage-limit error.
After the natural quota reset, real Windows inference and continuation passed.
A parent and two native V2 children finished an account switch with unfinished
work: each child completed its 90-second command, checkpointed, then resumed
its second command and guide in a new turn on the other account. The same
conversation IDs and parent links were preserved, each command ran once, and
no network-permission revocation, authentication-file change or native server
restart occurred. No free reset grant was redeemed by the agent.

Keep cooperative handoff subscriptions until child continuation is confirmed.
Transient observation reads otherwise unsubscribe and can leave checkpoint
conversations unloaded while the family waits. Retention is limited to the
participating family and released on completion, failure or shutdown; existing
closed-agent and changed-input guards remain intact. This follows the official
[app-server subscription lifecycle](https://learn.chatgpt.com/docs/app-server).

Windows QA tasks must use normal scheduling priority as well as a normal user
token. Task Scheduler's default priority 7 gave the test helpers reduced CPU,
I/O and memory priority; explicit priority 4 corrected the test environment.
The five completed Windows reports passed 92 tests with six POSIX-only skips;
the final subscription change passed 114 engine/handoff/checkpoint cases on
Windows. Mac verification passed 1,094 Codex/account tests, typecheck and build.
All temporary share blobs, imported credential homes and native QA processes
were removed. Native Windows/Linux TUI interface acceptance remains separate
from the verified shared-server engine.

Manual Share/Import transfers file-backed ChatGPT grants as an explicitly
selected code. Imports create private, separate homes and deduplicate exact
credentials without overwriting a login or changing the selected default.
The code contains the live login, including its renewal token: it is not
encrypted, has no automatic expiry and has no ccdeck revocation. Account
renewal on one machine can invalidate the other copy. Codex 0.166's optional
`oauth_provenance` and `login_owner_id` travel with their grant; non-OpenAI
renewal authorities, API keys and arbitrary configuration are rejected.
Both real account grants were exported Mac → Windows and Windows → Mac,
recognized through native account reads, and reimported without duplicates.
The original authentication files remained byte-identical. No reset credit
was redeemed.

## Saved reset inventory with native quotas — 2026-11-03

`account/rateLimits/read` omits the saved rate-limit-reset grants. Switching
the selected-profile quota source to native RPC had consequently hidden their
existing count/nearest-expiry row. The native quota now supplements its bars
with a read-only GET to `/wham/rate-limit-reset-credits`, using a validated,
unexpired file-backed credential for the same registered profile. The native
reader still owns renewal. Missing/system-store credentials or an optional
endpoint error leave ordinary limits usable. Credentials, config, native
identity and selection are revalidated; cached inventories remain scoped to
those bindings.

[CodexBar's provider documentation](https://github.com/steipete/CodexBar/blob/main/docs/codex.md)
confirms the same optional account-scoped inventory endpoint. No CodexBar
implementation was copied. Live reads returned one available reset for each
local profile, with a nearest expiry. Browser QA rendered the real count and
expiry in the existing Usage card at 1280, 390 and 320px.
