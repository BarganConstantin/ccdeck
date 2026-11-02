# Codex account continuation engine

Research baseline: ccdeck 3.53.1, Codex CLI 0.166.0 (2026-11-02).

## Scope and boundary

The engine supervises local `codex exec --json` and interactive native Codex TUI
sessions launched through ccdeck's existing terminal integration. Both resume an
exact saved conversation on another configured account after a terminal quota
failure. The interactive adapter owns an app-server process and keeps the TUI
connected to an authenticated, single-client loopback bridge during the handoff.
Claude stays on its existing cswap path. Desktop/IDE and externally started
sessions are outside this implementation.

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
The original rollout stays available in its source home.

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
another prompt. The bounded engine then stops monitoring until the next managed
launch; manual retries stay usable. Unknown/ambiguous submission outcomes are
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
- Windows/Linux native TUI and authenticated two-account acceptance are not
  established by fake-process tests or the macOS loopback probe.

Final interactive branch checks on Node 22: 68 relevant test files / 820 tests,
typecheck, production build, and package dry-run. The package contains `ws` and
its original licence; the copied terminal helper imports the interactive adapter
without depending on the source checkout. The runtime dependency audit reports
zero advisories. The desktop licence check now verifies the actual MIT text for
`ws`, alongside the existing Apache licence assertions for native lock packages.
A dedicated signal test confirms that terminal Ctrl+C does not kill the owned
backend, and a timeout test confirms that internal submissions are not retried or
leaked into the TUI as late responses.
