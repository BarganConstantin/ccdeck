# Radar decoding investigation

Investigated on macOS on 2026-10-19, against ccdeck 3.42.0 (`18842c68`).

## Confirmed defect

The passive TCP decoder discarded every connection after 60 seconds without
packets. An HTTP/2 connection can remain open while no telemetry is exported.
Its next export does not repeat the connection preface or reset the HPACK table.
Radar therefore reported `joined_midstream` and stopped decoding that connection,
even when monitoring had originally captured its beginning.

The regression reproduces this with a decoded export, a quiet interval and a
second export on the same TCP connection. Before the fix, the 60,001 ms case
produced one export instead of two. After the fix, the 60,000, 60,001 and
300,000 ms cases all decode both exports.

Keep connection state until TCP closure, a new SYN, capture shutdown or eviction
at the existing 16-connection limit. Evict the least recently used connection
when this limit is reached. Packet, stream and payload bounds remain in effect.

## Runtime evidence and limits

The native managed macOS smoke test captured synthetic loopback OTLP packets,
decoded their payload, observed collector acceptance, resumed after capture
restart and respected Stop. Run it with Node 22:

```sh
node scripts/verify-radar-platform.mjs --live --managed
```

A separate 25-second passive observation of the owner's configured destination
received approximately 1.2 MB and reported six `joined_midstream` connections,
with zero decoded exports. Only counts and connection reasons were retained;
packet contents were not written to disk.

This newly started observer joined existing connections. Its output does not
prove that idle expiry caused the installed app's observations, or that the fix
already captures the owner's real Claude exports. Connections whose beginning
was missed still require a fresh connection while the fixed monitor is listening.
The initial investigation did not replace the running app or change Claude settings.

## Local replacement and real Claude verification

The owner subsequently authorized replacing the local runtime for testing. The
old server on port 4317 was stopped using the port-scoped CLI command. The fixed
worktree now serves the same URL, with monitoring automatically resumed from the
existing preference. The packaged Electron application was not rebuilt.

A fresh Claude CLI process sent a short test prompt with tools, MCP servers and
hooks disabled. Telemetry was directed to the already configured collector with
temporary environment variables for that process; no telemetry settings file was
edited. Radar decoded four actual Claude exports (two logs, one traces and one
metrics), all acknowledged as `accepted`. The event detail API returned decoded
JSON and protobuf for each export. These are actual Claude test exports, distinct
from the earlier synthetic loopback smoke test.

Previously open connections still appear as `joined_midstream` until they
reconnect. This verification proves fresh Claude traffic is captured by the
replacement runtime; the timed regression covers preservation across idle gaps.

Regression coverage is in `src/web/__tests__/telemetry-capture.test.ts`, including
connection retention, continued decoding and bounded least-recently-used eviction.
