# Optional local engine host contract v1

`createProEngineClient` is an internal Node adapter, not a browser API. The
Command Panel's routes and its WebSocket are served only through an engine;
there is no other terminal behind them. With no engine, or one switched off,
every route answers that the engine is not installed (Terminal routes, below)
and the WebSocket is refused 503.

The deck makes its own engine in one place, `command-panel-engine.mjs`, and
only while the Command Panel's switch in Settings is on (off by default), on
Linux or macOS, once a route asks. It looks in `<deck data folder>/engine` (the
`CCDECK_HOME` folder when set) and nowhere else: not on `PATH`, never
downloaded or installed. It trusts only the Ed25519 keys shipped with the deck,
a frozen list that is empty in this release, so a missing folder answers
`not-installed` and a present one `not-verified`, and the executable is never
read. Off Linux and macOS (on Windows) every route answers `unsupported`
without looking; on both, a route reaches the engine only when its hello
advertises a terminal backend, and answers `no-terminal` otherwise. The client
it makes is the only one constructed with `terminal: true` (Terminal opt-in,
below). The engine is stopped 1.5 s after the switch goes off, once its panels have been
told, and at deck shutdown without being waited for; a later question starts
a new one. An engine still being made for a question asked while on is stopped
the same way. A question asked while on that the engine is still answering when
the 1.5 s are out is answered first, within the client's own deadline, and the
stop follows: the engine is never stopped under a launch it is running.
Switched back on before the stop has begun, the stop is called off and the
engine kept. A question asked while an engine is stopping waits for its
process to exit (`close()` answers once it has) before the next is started,
at most 5 s, and is answered `restarting` after that: two never run at once.
A route whose request was still arriving when the switch went
off is answered as one sent after it, the no-route 404, and nothing is asked of
the engine. A route the engine answered after the switch went off mints no
ticket: a launch or adopt it ran, and an open or claim that went through, is
answered 409 `{ "ok": false, "error": E, "code": "turned-off" }`, `E` saying
the session runs and the panel is off; anything else is the no-route 404.
With the switch off nothing here runs: no file is looked at, no
client is made, no process is started and nothing touches the network.

A caller of `startServer` may hand a deck another engine as `terminal.engine`,
set to `engineTerminals(client)` where the client is created; no setting,
environment variable or command-line flag reaches that option. While the
deck's engine is enabled, the panel's routes are asked of it (Terminal routes,
below), and the WebSocket is relayed to it for a ticket bound to an engine
handle (Terminal streams, below).
Construction is disabled by default and performs no file lookup, installation,
network request or process launch. Only the Command Panel's switch, or a
caller of `startServer`, may enable it. `request(method, params, { signal, timeoutMs })` permits terminal namespace
operations except `terminal.attach`, which only `attachTerminal(handle,
{ signal, timeoutMs })` sends; `close()` detaches the engine and answers once
its process has exited. Mutations are
never automatically replayed after failure. A subsequent request may retry
startup after bounded
backoff. `disconnected` reports a sanitized code; stderr is drained privately.

An installation is an owner-only directory containing an executable named
`ccdeck-pro-engine` (optionally a version suffix) and `manifest.json`. Trusted
Ed25519 public keys must be provided by the host, never an HTTP request: one,
or a list any of which may have signed the manifest. An empty list trusts
nothing and is refused before anything is read.
The manifest envelope is `{payload, signature}`: canonical base64 strings for
exact signed JSON bytes and the Ed25519 signature over those bytes. Signed JSON
fields: `file`, `protocol` (1), `target` (Rust triple), `sha256`, `size`, `version`.
Only flat filenames, matching platform, non-symlink regular files, verified
ownership, safe Unix permissions, and matching hash/size may launch. Writable
non-sticky ancestor directories are refused. No user-facing download is added.
Windows installation ACL validation remains disabled pending native validation.

The Windows preview is a test-only exception for one Windows VM, never a
production feature. On Windows the deck offers the Command Panel's switch
(`terminalSupported` in `/api/prefs`) only when `startServer` is given
`terminal.windowsPreview: true` together with an explicit `terminal.engine`,
and only when it can load `preview/command-panel-windows.mjs`
(`src/server/command-panel-platform.mjs` decides, once, at start). That module
sits outside `package.json` `files` and the desktop app's resources, so a
published package or an installed app refuses the option and says so once in
its log. Only a private QA preload passes the option; no production entry,
setting, environment variable, flag, file or request does. The module's client
is the deck's own client with one change: it verifies the installation with
the module's Windows check, against the key its caller passes as `publicKey`
(the preview's fresh test key, never a key of the deck's, whose list stays
empty): the same signed manifest fields with a Windows target
(`x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc`), a `ccdeck-pro-engine*.exe`
file name, non-link regular files and a matching hash and size. It checks
neither ACLs nor owners, nor whether the account is an administrator. The
hello checks, the per-run nonce and everything after them are the deck's.
Off Windows the option is ignored and the module never loaded.

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

## Terminal opt-in

An engine serves `terminal.*`, `terminal.attach` included, only on Linux and
macOS, and only when its environment at start holds `CCDECK_ENGINE_TERMINAL` set to
exactly `1`: a second, engine-side switch behind the deck's own. The deck sets
it only for the engine it starts for the Command Panel, a client constructed
with `terminal: true`, after the person has switched the panel on in Settings
(off by default). Every engine the deck starts, that one included, first has
any value the deck inherited removed, so a shell's variable reaches no engine
and turns nothing on. Nothing else sets it: no request, other setting or
command-line flag.

It is not authentication material (the nonce stays in the hello only) and
carries nothing secret. It fixes the hello's `terminal` for the engine's life:

- on: `launch`, `resume`, `attachOwned`, `attachExternalTmux` and
  `surviveEngineRestart` true, `attachExternalConsole` false,
  `backend: "tmux"`;
- off (absent, any other value such as `0`, `true`, ` 1` or `1\n`, or any
  platform but Linux and macOS whatever it says): every flag false,
  `backend: "unavailable"`, and every `terminal.*` call answers `unavailable`.

An engine that does not know the variable advertises `unavailable` the same
way, and the deck answers its routes `no-terminal` (Refusals, below) without
asking it. No method, frame or protocol version changes: the protocol stays 1,
and a host that never sets the variable gets the engine as before. The
routes' environment drops it, so tmux, Claude and Codex never see it.

## Terminal routes

While the deck holds an enabled engine, each of the panel's six routes is
asked of it, after everything HTTP the deck keeps: the panel switch (404), the
request gates, and the body (at most 8 KiB, else 413; a JSON object, or null).
The engine is the only answer: what it cannot take is refused (Refusals,
below), never answered some other way.

| Method | Route | `params` |
|---|---|---|
| `terminal.status` | `GET /api/terminal/status` | `{ "body": null }` |
| `terminal.target` | `GET /api/terminal/target` | `{ "body": { sessionId, provider, cwd } }`, from `session`, `provider` and `cwd` in the query, each `""` when absent |
| `terminal.claim` | `POST /api/terminal/claim` | `{ "body": B }` |
| `terminal.open` | `POST /api/terminal/open` | `{ "body": B }` |
| `terminal.adopt` | `POST /api/terminal/adopt` | `{ "body": B }` |
| `terminal.launch` | `POST /api/terminal/launch` | `{ "body": B }` |

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
- `fixable` (status only, from an earlier engine): accepted with a `body.tmux`
  and ignored. The deck fetches no tmux and sends `terminal.forgetTmux` no
  more; with no usable tmux the panel shows the engine's answer, the
  install line included.

Any other shape is the deck's own 500.

### Refusals

When the engine cannot take a question, the route answers
`{ "ok": false, "error": E, "code": C }`, `E` one short sentence for the page:

| `code` | Status | When |
|---|---|---|
| `not-installed` | 409 | no engine, or one switched off; nothing is asked |
| `not-verified` | 409 | the installation did not verify, so nothing was started |
| `failed` | 409 | the engine would not start (it exited, or its hello did not match) |
| `no-terminal` | 409 | its hello advertised `terminal.backend: "unavailable"` (nothing is asked), or it refused with `unavailable` |
| `unsupported` | 409 | the platform has no Command Panel yet |
| `restarting` | 503 | its restart is waiting out the backoff, it is closing, or a read lost it |
| `busy` | 503 | it, or the client, refused with `busy` |
| `no-answer` | 503 | it did not start, or answer a read, in time |
| `bad-request` | 400 | it, or the client, refused with `bad_params` or `invalid_request` |

409 is a state of the machine the panel shows and stops at, checking again
only when the person asks. 503 is a moment: the panel waits it out, asking
again, where asking starts nothing (an open, or a reconnect under a live
pane); a launch or adopt refused 503 was not run, and is asked again only on
the person's press, a launch by the same key. `internal` is the deck's 500, for a read too. A
mutation (claim, open, adopt, launch) that failed any other way, with no answer
in time or the engine gone, is the deck's 500 and is never asked again: it may
already have started an agent. One the engine did, answered after the switch
went off, is 409 `turned-off` in the same shape, with no ticket: the session
runs, and the panel opens it once the switch is on again (a launch by the
same key finds it).

The engine's own answer to a route reaches the page as it is. One the page
reads by its code: `host-generations` (409), a launch refused while sessions
still run on older session hosts. The panel says the engine's sentence with
Try again and Not now, and does not ask about tmux; any other 409 without a
code the page knows may still be tmux missing, and is asked as before.

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
The one message the JS bridge has no counterpart for is `replies`, for a
session it cannot open (Query answers, below).

The host asks for an attach only while the engine's hello advertised a terminal
backend (`terminal.backend` other than `unavailable`); otherwise, or with the
engine not running, the upgrade is refused 503 without asking, and the engine
is never started for it. A ticket is relayed only while the deck holds an
enabled engine; any other ticket is refused 503 before the 101, since nothing
else is behind the socket.

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

### Query answers (`replies`)

A session with no tmux server (a console session) never says `{"t":"tmux"}`.
In its place the engine may say, as one text message, which queries the
panel's own terminal answers:

```
{"t": "replies", "v": 1, "view": ["decrqm-dec", "osc10", "osc11"]}
```

- **Meaning:** for this session the panel's terminal answers exactly these
  query kinds and leaves every other query alone. A kind missing or unknown
  stays silent, so a newer panel's kind never answers against an older engine.
- **Kinds** (`VIEW_KINDS`, `src/web/terminal-protocol.ts`): `da` (DA1, DA2),
  `dsr`, `decdsr`, `decrqm-ansi`, `decrqm-dec`, `decrqss`, `osc4`, `osc10`,
  `osc11`, `osc12` (an OSC colour's `?` form only; a set still sets). The
  engine says known kinds only, each once, in that order, never an empty list.
- **Order:** at most once per stream, after `hello` and before the first
  `reset`, never again on a reseed. A stream whose session has a tmux version
  is told `tmux` and never `replies`.
- **`v`:** the panel ignores a frame whose `v` is not the number 1, or whose
  `view` is not a list of strings; of a list it keeps the kinds it knows, once
  each. A different meaning gets a new `v`.
- **The panel** (`src/web/terminal-replies.ts`): while a list is set, a query
  is answered by its terminal only if its kind is listed, whatever the tmux
  version. A `tmux` frame or a new connection clears it; an empty list is no
  list.
- **Compatibility:** an older panel ignores a message whose `t` it does not
  know, and behaves as before; an older engine never says it, and a panel that
  is not told behaves as before. The host relays it verbatim, like any text,
  and the deck's own JS bridge never says it. Today no engine names a kind, so
  the frame is not sent.

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
handed only what the JS bridge would send, and `replies` (Query answers). Nothing in a stream is logged, by
either side.
