# Optional local engine host contract v1

`createProEngineClient` is an internal Node adapter, not a browser API. It does
not change the UI, and with no engine the HTTP routes and the terminal
WebSocket are served exactly as before and no engine module is loaded. A deck
is given an engine only through `startServer`'s `terminal.engine` option, set
to `engineTerminals(client)` where the client is created; the product passes
none, and no setting, environment variable or command-line flag reaches it.
While that engine is enabled, the terminal panel's routes are asked of it
first (Terminal routes, below), and the terminal WebSocket is relayed to it
for a ticket bound to an engine handle (Terminal streams, below).
Construction is disabled by default and performs no file lookup, installation,
network request or process launch. Only explicit owner configuration may enable
it. `request(method, params, { signal, timeoutMs })` permits terminal namespace
operations except `terminal.attach`, which only `attachTerminal(handle,
{ signal, timeoutMs })` sends; `close()` detaches the engine. Mutations are
never automatically replayed after failure. A subsequent request may retry
startup after bounded
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
and process-instance identity. No listener is created. Terminal streams (below)
carry each attached terminal panel on the same pipe.

No JSON on the wire, kind 0 or kind 3, carries a lone UTF-16 surrogate: the
engine's parser refuses one as malformed and ends the IPC. The host refuses a
request that has one in a key or a string with `invalid_request`, before
anything is written, and writes U+FFFD for one in a `shutdown`'s reason or text.

A compromised owner account can replace trusted configuration or interfere
between executable verification and exec. This boundary prevents untrusted
browser/other-user selection; it does not claim protection from the same OS
identity. Installation/update signing and key rotation require separate release
validation. The free package contains only this host interface, not Rust sources,
private build machinery, private fixtures or a bundled engine executable.

## Terminal routes

While the deck holds an enabled engine, each of the panel's six routes is
asked of it, after everything HTTP the deck keeps: the panel switch (404), the
request gates, and the body (at most 8 KiB, else 413; a JSON object, or null).

| Method | Route | `params` |
|---|---|---|
| `terminal.status` | `GET /api/terminal/status` | `{ "body": null }` |
| `terminal.target` | `GET /api/terminal/target` | `{ "body": { sessionId, provider, cwd } }`, from `session`, `provider` and `cwd` in the query, each `""` when absent |
| `terminal.claim` | `POST /api/terminal/claim` | `{ "body": B }` |
| `terminal.open` | `POST /api/terminal/open` | `{ "body": B }` |
| `terminal.adopt` | `POST /api/terminal/adopt` | `{ "body": B }` |
| `terminal.launch` | `POST /api/terminal/launch` | `{ "body": B }` |
| `terminal.forgetTmux` | not a route | `{ "body": null }`, to a running engine once a tmux the deck fetched has landed |

`B` is the request's body when it is a JSON object, else null. The engine
answers `{ status, body, handle?, log?, fixable? }`, and the deck sends
`status` and `body` as they are; JSON key order is not part of the contract.

- `handle`, 64 lowercase hex characters, stands where the body's `ticket` is
  null. The deck mints its ticket there, in the same store as every ticket (30
  s, single use, at most 32), bound to `{ handle, origin }` with the page's
  origin, and the upgrade relays that ticket to the engine (Terminal streams).
  The handle itself is never sent to the page.
- `log` goes to the deck's log, where the deck's own route logs, never to the
  page.
- `fixable` (status only): no usable tmux, and one the deck could fetch. The
  deck runs its own download branch on the engine's `body.tmux`.

Any other shape is the deck's own 500. The deck's own route answers instead,
as with no engine, when the engine was not asked or did not run the request:
it is not running and will not start, its hello advertised
`terminal.backend: "unavailable"`, it refused with `unavailable` or `busy`,
or the client refused the request with `invalid_request`. A read (status,
target) that failed any other way is answered by the deck too. `internal` is
the deck's 500. A mutation (claim, open, adopt, launch) that failed any other
way, with no answer in time or the engine gone, is the deck's 500 and is never
asked again, of the engine or of the deck's own route: it may already have
started an agent.

## Terminal streams

One stream is one attached terminal panel. `terminal-socket.mjs` keeps
everything the browser touches: the upgrade's gates in their order, the
shutdown 503, the ticket (30 s, single use) and its origin, `MAX_TERMINALS`
(an attach still waiting counts), and the WebSocket itself — frames, the 1 MiB
message cap, ping and the close handshake. The engine redeems the handle once
and runs the panel's protocol, the one `terminalBridge` speaks. The panel
cannot tell the two apart: every message, its bytes, its order, and every close
code and reason are what the JS bridge sends. One WebSocket message is one
message on the stream, both ways; a seed is one binary message, never split.

The host asks for an attach only while the engine's hello advertised a terminal
backend (`terminal.backend` other than `unavailable`); otherwise, or with the
engine not running, the upgrade is refused 503 without asking, and the engine
is never started for it.

### Frames

The header is the one above. **The sequence is one counter per direction across
every kind and every stream**, from 1, each frame exactly one more.

| Kind | Stream | Payload | Direction |
|---|---|---|---|
| 0 | 0 | a JSON request or response | both |
| 1 | ≥1 | a binary WebSocket message, or the last part of one | both |
| 2 | ≥1 | a text WebSocket message's UTF-8 bytes, verbatim | both |
| 3 | ≥1 | one stream control object (JSON, below), at most 4096 bytes | both |
| 4 | ≥1 | a part of a binary message that continues; not empty | engine → host |

Data (kinds 1, 2, 4) is the message bytes, never wrapped or escaped. A binary
message longer than one frame is sent as kind-4 parts, then one kind-1 frame
that ends it, with nothing else on that stream between them; the host joins
them into one WebSocket message. A text message is never split, and the host
never sends kind 4: a browser message is at most 1 MiB.

### Opening a stream

```
request:  {"id", "method": "terminal.attach", "auth", "params": {"handle": "<64 hex>", "stream": N}}
success:  {"id", "ok": true, "data": {"stream": N}}
```

The host picks `N`: per engine instance, strictly increasing from 1, at most
2³²−1, never reused whatever the answer; a restarted engine starts again at 1.
`params` is exactly `{handle, stream}`. The host registers `N` before it sends
the request, so frames for `N` that arrive before the 101 are held and sent to
the socket first, in order. The reply comes before any frame of the stream,
and the stream's first message is the `hello` text. An attach is answered at
once: it is not counted in the 32 pending requests, and the host never sends
`system.cancel` for it.

| Answer | Upgrade |
|---|---|
| success | 101, then the relay |
| `bad_params` (also a handle that is not 64 lowercase hex, refused by the host without asking) | 500 |
| `invalid_handle` (unknown, spent, or older than 35 s) | 401 |
| `busy`, `unavailable`, any other code, no answer in time, engine gone | 503 |

On no answer in time, or a socket destroyed before the answer, the host gives
the attach up and sends `close` on `N`. If the socket was destroyed or the deck
began shutting down by the time the answer arrives, the host sends `close` and
refuses the upgrade (503). The engine ends a stream whose `close` it receives,
whether the `close` reached it before or after its answer.

### Relaying

| From | Message | To |
|---|---|---|
| browser | binary message | kind 1, the bytes |
| browser | text message | kind 2, the bytes as received |
| browser socket | closed, by either side | kind 3 `{"t":"close"}` |
| engine | kind 1, with any kind-4 parts before it | one binary message |
| engine | kind 2 | one text message |
| engine | kind 3 `close` | `conn.close(code, reason)` |

The host parses nothing it relays.

### Stream control (kind 3)

One JSON object keyed by `t`, read as strict UTF-8. Unknown `t`, unknown,
missing or duplicate fields, or wrong types are violations. Numbers are JSON
integers, 0..2⁵³−1.

| Host → engine | Meaning |
|---|---|
| `{"t":"flow","relayed":R,"buffered":B}` | `R`: data bytes of this stream the host has taken off the pipe, cumulative, counted when a message is whole. `B`: the socket's `bufferedAmount` while it waits for `'drain'`, else 0. |
| `{"t":"close"}` | The socket went away, or the host gave the stream up. The session keeps running. |
| `{"t":"shutdown","reason":S,"text":T?}` | `closeOpenTerminals(reason, text)` for this stream: the panel is told `exit`, then the stream closes. `S` 1..123 bytes; `T` at most 1024 bytes. |

| Engine → host | Meaning |
|---|---|
| `{"t":"credit","bytes":C}` | Data bytes (kinds 1 and 2) of this stream the engine has taken, cumulative. |
| `{"t":"close","code":K,"reason":S}` | Close the socket with this code and reason, after every message before it. `K` is 1000, 1001 or 1011; `S` at most 123 bytes. |

### Flow control

The panel's `ack` texts and the 4 MiB output high-water mark work as in the JS
bridge; the engine measures `bufferedAmount` as the data it handed the stream
minus the host's latest `R`, plus `B`. The host sends `flow` once per stream
for each stdout chunk that carried that stream's data, and whenever the socket
emits `'drain'`.

**Input window.** Let `O` be the data bytes the host has sent on the stream
minus the last `credit`. A message of `L` bytes is sent only when `O == 0` or
`O + L ≤ streamWindowBytes` (from the hello). Otherwise the host keeps it, and
every later one, in order, and stops reading the socket until a `credit` makes
room. Input is never dropped, split or reordered.

### Lifecycle

Each side sends `close` at most once, nothing after its own, and none after
the peer's. Frames for a stream id that was named but is no longer live are
discarded.

| Event | Host |
|---|---|
| the engine closes the stream | relays its last messages, then the close |
| the browser closes, or the socket drops | sends `close` |
| switch-off in Settings, or deck shutdown | sends `shutdown` on each stream; ends the socket after the engine's close, or after 1.5 s. An attach still waiting is told as soon as it opens at a switch-off, and given up at shutdown |
| the engine exits or crashes | closes each relayed socket 1011 `the server could not handle a message`, with no `exit` before it, so the panel reconnects with a new ticket; waiting attaches are refused 503 |

Nothing here stops an agent: every path detaches the panel and leaves its
session running.

### Violations

The host treats each of these as a broken engine, ends the IPC and closes
every relayed socket as above: a kind other than 0–4; kind 0 on a stream, or a
stream kind on stream 0; a frame for a stream id never named in an attach; an
empty kind-4 part; a part sequence broken by another kind; a joined message
over 64 MiB; a kind-3 payload that is not exactly one of the engine's messages
above; a `close` code other than 1000, 1001 or 1011; a `credit` that goes
backwards or past what was sent. The engine ends the IPC (exit 64) for the
host's: kind 4 from the host, a frame for a stream id never named in an
attach, a data message over 1 MiB or past the input window, a `flow` that goes
backwards or past what it sent, or a kind-3 payload that is not exactly one of
the host's messages.

### Limits

| Limit | Value |
|---|---|
| live streams in the engine | 8 (the deck's own quota is `MAX_TERMINALS`, 4) |
| data message, host → engine | 1 MiB |
| input window per stream | `streamWindowBytes` |
| binary message, engine → host | 64 MiB |
| kind-3 payload | 4096 bytes |
| stream ids | 1..2³²−1, strictly increasing per engine instance |

### Never sent

No pid, pane, window, session or socket name, path or argv crosses, in either
direction: not in the reply, a control message or an error. The browser is
handed only what the JS bridge would send. Nothing in a stream is logged, by
either side.
