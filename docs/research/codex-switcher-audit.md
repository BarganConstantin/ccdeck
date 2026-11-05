# Codex account switcher audit — 2026-11-05

## Scope

The audit starts at development commit `69dc0d29`. The live controller, RPC
transport and handoff sources match v3.81.4; development additionally contains
the previously tested credential-read timeout fix. The three repairs below
are separate commits, ending at `b62b74ed`.

The review covers native control ownership, reconnects, manual and automatic
switches, interrupted turns, child-agent checkpoints, credential reads, local
selection, endpoint trust and the Windows byte relay. Existing tests also
exercise the terminal account engine and its continuation adapter.

## Reproduced defects and repairs

### Failed reconnection prevented further recovery

An initial or final account read could time out after the control connection
had been assigned. The next poll saw a non-null connection and never retried
reconnection, leaving the controller disconnected.

`4b372a2c` discards that incomplete control connection and releases its lease.
A later poll must attest the native account ID before restoring control; it
never replays authentication. Regression tests cover both read failures, an
outside workspace change, late notifications from a discarded connection and
renewal after successful recovery.

### Disabling Auto-switch did not cancel an in-flight switch

Auto-switch was checked only before reading credentials. Turning it off during
a slow read could still interrupt a turn and log into the target account.

`cf327b07` rechecks the setting after the credential read, before interruption
and immediately before authentication. If interruption already happened, the
existing continuation mechanism resumes the original account's work once.
Unconfirmed continuation retains its durable recovery protection and requires
manual attention; it is never silently replayed.

### Windows proxy handshake could wait indefinitely

The stdio transport does not behave like a connecting TCP socket. The HTTP
socket timeout did not bound a proxy that returned no handshake bytes. A
controlled test remained pending after 30 seconds before the repair.

`b62b74ed` adds an explicit setup deadline: 30 seconds for the Windows relay and
5 seconds for POSIX. Failure closes only the owned control connection/proxy
and releases the setup guard. A separate real byte-relay test accepts a
six-second Windows startup and verifies initialization is sent once.

## Verification

The baseline passed 353 tests with 9 platform skips on both macOS and Linux.
The new regression tests reproduced the failures before their repairs.

The final source tree passed all 19 selected files on each platform:

| Platform | Node | Passed | Platform skips | Failed |
| --- | --- | ---: | ---: | ---: |
| macOS | 22.14.0 | 361 | 9 | 0 |
| Linux, non-root | 22.23.4 | 361 | 9 | 0 |
| Windows | 22.23.3 | 341 | 29 | 0 |

`npm run typecheck` and `npm run build` passed on macOS. The build reported its
existing large-chunk advisory. The Linux test container lacks a process-table
utility, so the suite's stray-server guard reported itself unavailable; the
container had no owner homes or external network access.

The same 19 files are selected with:

```sh
node node_modules/vitest/vitest.mjs run \
  src/web/__tests__/account-engine.test.ts \
  src/web/__tests__/codex-auto.test.ts \
  src/web/__tests__/codex-selection.test.ts \
  src/web/__tests__/codex-interactive-engine.test.ts \
  src/web/__tests__/codex-engine- \
  src/web/__tests__/codex-live- \
  src/web/__tests__/codex-windows- \
  --maxWorkers=2 --minWorkers=1
```

## Limits

These are isolated controller, filesystem, process and transport tests, not
live-provider account switching against authenticated conversations. The
Windows byte-relay fixture simulates its ACL boundary; the separate Windows
private-path tests exercise real token ACLs and pinned handles. The Linux run
uses a non-root process in an isolated VM/container, without owner homes or
external network access. The nonresponsive-handshake deadline uses a fake
clock; the delayed-start case uses a real child process and WebSocket relay.

The audit does not establish that every possible provider failure is fixed.
Full release CI, supported-Node coverage and authenticated end-to-end switching
remain separate release checks. No UI behavior or real account selection was
changed during verification.

## Follow-up: manual switch during connection recovery

A second pass reproduced the same incomplete-bootstrap problem through a
manual switch after a disconnection, while the controller still retained its
previous login. The reconnect-specific cleanup did not cover this caller.

Bootstrap account-read failures now discard the control connection inside the
shared initialization path as well. The next observation reattests the previous
account without replaying either login. Three additional cases cover both
bootstrap reads and an outside workspace change. The controller and ownership
suites passed all 86 cases locally after this repair. The complete focused
set then passed 364 cases with 9 platform skips on macOS; full cross-platform
CI is required before development integration.

## Third pass: restart timeouts and removed switch targets

Starting from development `0c9fc801`, five new failing cases reproduced two
additional defects. An account-read timeout during startup cleared the restore
intent permanently, so a later healthy daemon did not restore renewal ownership.
Separately, deleting or making a target profile unavailable while credentials
were being read still allowed its cached login to be applied.

`6e109cf4` retains the read-only restore intent for account-read and initial
routing-snapshot timeouts, using the existing retry delay. The next attempt
must still attest the native account ID; it never replays login. Tests also
cover a changed workspace during the gap and verify the retry interval.

`d0c38a5f` rechecks target availability after credential reading, before
interruption and before authentication. Cancellation after an interruption
uses the existing continuation mechanism on the original account. An uncertain
continuation retains durable recovery protection. An unrelated rename or
registry revision change does not cancel a still-available target.

The unchanged rapid-selection regression still submits only the latest unsent
selection. Ten additional cases in this pass cover the two defects and their
adjacent recovery behavior. The 19-file focused set passed 374 tests with 9
platform skips on both macOS (Node 22.14.0) and Linux (Node 22.23.4,
non-root). Windows (Node 22.23.3) passed 354 cases with 29 platform skips;
its POSIX RPC file is explicitly skipped, while real Windows ACL cases run.
No platform reported a failure. Typecheck and build passed on macOS; the
build retained its existing large-chunk advisory. Linux's isolated container
could not run the process-table stray-server guard. These tests do not switch
authenticated provider accounts or mutate the owner's running sessions.


## Fourth pass: renewal after losing the control lease

A native credential-renewal callback did not validate the control lease before
returning refreshed tokens. Two failing cases reproduced successful renewal
after lease loss before the credential read or during the subsequent account
read. The callback now verifies the lease before reading credentials and again
before returning them, and pauses ownership if it has lost control. It returns
only a fixed diagnostic error on the old request, never credentials or private
provider text.

Four additional cases cover lease loss at both boundaries, replacement during
credential reading, and a late credential failure after an outside account
change. The latter must not send an obsolete reply or overwrite the observed
external-change state. The controller and ownership suites passed 100 cases
locally; full integration CI validates the combined candidate before merge.

## Fifth pass: renewal after profile removal

Starting from development `c5df895a`, two failing cases reproduced renewal
using cached tokens after the active profile had been removed or marked
unavailable during the native account read. The credential reader had already
completed its filesystem and registry checks, so those checks could not cover
the later asynchronous gap before the control server's response.

`0d583db7` rechecks the active profile's availability immediately before returning
the renewal result. A missing/unavailable profile receives a fixed error and
pauses control; subsequent callbacks cannot return tokens until a new manual
selection. The change does not interrupt or restart turns and does not replay
login. A third case verifies that an unrelated registry revision or rename
still allows renewal for an available profile.

The 23-file macOS and Linux sets passed 406 cases with 9 platform skips
each after the final lease-order regression was added; typecheck and build
passed on macOS. The verification set includes native ownership, checkpoints,
continuation, credentials, platform transport, account routes, authentication
refresh and profile removal. As in earlier passes, these are synthetic account
and endpoint tests, not authenticated live-provider switching.

Review of the repair added a fourth case: lease replacement during the final
profile lookup must still block renewal. `46f251a3` keeps the final control
lease check after that asynchronous lookup.

The expanded Windows run initially reported three failures in the pre-existing
quota refresh fixture, while 382 cases passed and 29 were skipped. The same
three failures reproduced on unchanged development `c5df895a`. That fixture
set HOME, USERPROFILE and CODEX_HOME but omitted CCDECK_HOME; on a Windows
machine with an existing registry under LocalAppData, quota reads could select
that registry instead of the synthetic Codex home. `4b75e4b9` gives the fixture
its own registry directory and restores the previous override afterward.
After the isolation repair, all 117 cases in the final controller, ownership
and quota-refresh files passed on Windows, including the three baseline
failures. Other Windows files were not rerun after the final lease-order and
test-only edits. The Linux
run predates this test-only isolation edit; its production source matches the
final candidate. The Linux process-table stray-server guard was unavailable
inside the isolated container.
