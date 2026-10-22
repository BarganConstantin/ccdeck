# Automatic Radar monitoring

Automatic monitoring is opt-in and off by default. Nothing is captured,
discovered or retried until the person turns it on in Settings → Radar
("Monitor automatically"). A fresh install and a deck upgraded from 3.43.4,
which never saved this switch, both start with it off.

While it is off, Radar behaves as 3.43.4 did: it stays in the toolbar with its
Monitor, Configuration and File views, and the Monitor view keeps its
destination picker and Start/Stop. A monitor the person starts there keeps its
own `radar-monitor-<port>.json` opt-in and resumes after a restart until they
stop it, exactly as before.

While it is on, capture starts in the server without opening Radar or keeping
a browser window open, and the Monitor view hides the manual controls. Turning
it off stops capture and discovery. The choice survives a reload and a restart.

## Runtime ownership

`traffic-radar-service.mjs` owns the automatic-monitoring switch separately
from capture readiness and from the monitor's own opt-in. The switch and the
collector destinations it remembers live in `radar-settings-<port>.json`,
beside `radar-monitor-<port>.json`; it is on only where that file says
`automatic: true`, so a missing file, an unreadable one or one written by any
other build is off. Off, the service hands `resume`, `prepare` and `stop` to the
capture unchanged. On, it retries discovery and setup every five seconds,
cancels stale setup work after the switch goes off, and stops the monitor with
its own opt-in saved off. Tokens and packet contents are never persisted.

Configured IPv4 collector endpoints take precedence. With no configured address,
remembered collectors (including a monitor started by hand before the switch was
turned on) and active IPv4 OTLP/gRPC port 4317 connections provide fallback
targets. Arbitrary Claude API HTTPS connections are not selected. The existing
platform/tool/permission limits remain visible; On does not imply that capture
is ready or that a message was sent. When no collector is known, the monitor
waits and discovers it in the background.

## Settings and browser state

The guarded, local-only `/api/system/traffic-radar/settings` GET/POST endpoint
returns and persists the switch (`enabled` in its body is automatic
monitoring). A POST must be a JSON object holding exactly one boolean
`enabled`; anything else is refused whole with 400. The GET is a guarded read
and the POST a guarded mutation, as for the other Radar routes. Settings → Radar
reads it while its pane is open; no other page polls it.

Local project/prompt display and JSON inspection are unchanged by this switch.
Claude telemetry flags and the external collector are not modified. In-memory
capture history retains its existing lifetime and is cleared by a server restart.

## Verification

- `radar-monitoring-default.test.ts`: the deck's own capture, real preference
  files in a scratch home: off on a fresh deck, off after an upgrade (a 3.43.4
  monitor that was started resumes, nothing else), no discovery or retry while
  off, on/off persisting across restarts.
- `radar-service.test.ts`: the same rules on the service alone, plus the
  automatic behaviour once on (late collectors, retries, stale discovery/setup
  cancellation, failed preference saves).
- `telemetry-capture-routes.test.ts`: local access, guarded reads, and strict
  validation of the switch's body.
- `telemetry-capture-ui.test.tsx`: the manual Monitor controls while the switch
  is off, unknown or loading; none while it is on.
- `radar-released-guard.test.tsx` and `traffic-radar-interaction.test.tsx`: the
  File view and Radar's toolbar entry as 3.43.4 released them.
- `node scripts/verify-radar-platform.mjs --live --automatic` exercises native
  packet capture with synthetic loopback OTLP: the switch starts off, is turned
  on, survives a restart, and Off persists — using disposable preferences.
