# Codex account continuation engine

Research baseline: ccdeck 3.53.1, Codex CLI 0.166.0 (2026-11-02).

## Scope and boundary

The first adapter supervises local `codex exec --json` sessions launched through
ccdeck's existing terminal integration. It resumes an exact saved conversation
on a different configured account after a terminal usage-limit failure. Claude
continues through its existing cswap implementation; it is not routed into this
engine. Interactive TUI and desktop processes are not silently terminated or
rewired. The engine boundary is reusable, but those clients need their own
supervised transport and acceptance tests.

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

- Node 22: all 63 Codex and engine test files passed (772 tests), including
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
  not claimed by the exec adapter.

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
