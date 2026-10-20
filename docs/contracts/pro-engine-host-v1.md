# Optional local engine host contract v1

`createProEngineClient` is an internal Node adapter, not a browser API. This
foundation does not change HTTP/WebSocket routes, UI, or the active backend.
Construction is disabled by default and performs no file lookup, installation,
network request or process launch. Only explicit owner configuration may enable
it. `request(method, params, { signal, timeoutMs })` permits terminal namespace
operations; `close()` detaches the engine. Mutations are never automatically
replayed after failure. A subsequent request may retry startup after bounded
backoff. `disconnected` reports a sanitized code; stderr is drained privately.

An installation is an owner-only directory containing an executable named
`ccdeck-pro-engine` (optionally a version suffix) and `manifest.json`. A trusted
Ed25519 public key must be provided by host configuration, never an HTTP request.
The manifest envelope is `{payload, signature}`: canonical base64 strings for
exact signed JSON bytes and the Ed25519 signature over those bytes. Signed JSON
fields: `file`, `protocol` (1), `target` (Rust triple), `sha256`, `size`, `version`.
Only flat filenames, matching platform, non-symlink regular files, verified
ownership, safe Unix permissions, and matching hash/size may launch. Writable
non-sticky ancestor directories are refused. No user-facing download is added.
Windows installation ACL validation remains disabled pending native validation.

One persistent child uses inherited stdio. Wire frame: u32 big-endian body
length, u8 kind, u32 stream, u64 increasing sequence, payload. Body maximum
2 MiB, header 13 bytes. Kind 0 uses stream 0 and JSON request/response objects.
The host starts with `system.hello`, protocol 1, actual parent PID, host version
and a new 32-byte random nonce encoded as hex. Later requests include that
nonce in `auth`. No authentication material is put in argv or logs. The engine
must report matching protocol, executable digest, version and target before
requests are released. Session capabilities comprise backend
`unavailable|tmux|conpty` and booleans `launch`, `resume`, `attachOwned`,
`attachExternalTmux`, `attachExternalConsole`, `surviveEngineRestart`.

Up to 32 requests, a 4 MiB outbound queue and one bounded inbound frame are
allowed. Abort/deadline sends `system.cancel`; periodic `system.ping` detects a
hung child. Child exit rejects every pending call; restart creates fresh auth
and process-instance identity. No listener is created. Stream registration and
byte acknowledgement are supplied by the later terminal bridge milestone.

A compromised owner account can replace trusted configuration or interfere
between executable verification and exec. This boundary prevents untrusted
browser/other-user selection; it does not claim protection from the same OS
identity. Installation/update signing and key rotation require separate release
validation. The free package contains only this host interface, not Rust sources,
private build machinery, private fixtures or a bundled engine executable.
