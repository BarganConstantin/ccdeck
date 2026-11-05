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
