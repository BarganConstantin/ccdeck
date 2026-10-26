# Automatic Radar monitoring

Radar monitors by itself, always. There is no switch in Settings → Radar and
no Start, Stop or destination picker in the Monitor view: the owner asked for
monitoring that is simply on (2026-10-23), reversing v3.44.0's opt-in, after
users opened Radar and found it stopped behind a capture error.

Capture starts in the server without opening Radar or keeping a browser window
open, on a fresh install and on a deck upgraded from any earlier release,
whatever its saved files say. It continues while ccdeck runs and starts again
with it. `AGENTS_DECK_NO_RADAR=1` keeps a deck from starting it at all: the test
suite sets it (`no-lan.ts`), so a deck booted by a test never samples or
captures the developer's own Claude sessions.

## Runtime ownership

`traffic-radar-service.mjs` keeps capture on Claude Code's collector.
Configured IPv4 collector endpoints come first, and an endpoint named by host
(`otel.example.com:4317`) is looked up to its IPv4 address, bounded to two
seconds; with none configured, the collectors it found before (including a
monitor started by hand in an earlier release) and active IPv4 OTLP/gRPC port
4317 connections are the fallback. Arbitrary Claude API HTTPS connections are
not selected. When no collector is known, it waits and keeps looking.

Discovery samples Claude's processes (`ps` and `lsof`, `/proc`, or PowerShell),
and every deck now pays for it, so it runs every five seconds only while Radar
is open, which the page shows by reading the capture, and every sixty seconds
otherwise. Opening Radar looks at once. The collectors found live in
`radar-settings-<port>.json`, beside the monitor's own
`radar-monitor-<port>.json`, so a restart goes back to them before discovery
runs. Tokens and packet contents are never persisted.

## Capture permission, once

Packet capture needs an administrator on macOS and Linux. When the capture tool
is missing or refused, Monitor shows **Allow packet capture once**: what Radar
reads and why the system asks, what Allow capture changes, and one button that
opens the system's own password prompt (`traffic-radar-permission.mjs`,
`POST /api/system/traffic-radar/capture/permission`, a guarded mutation). The
prompt opens only on that press, never by itself: a password prompt nobody
asked for is what #1755 removed from the updater.

- macOS: `osascript … with administrator privileges` installs ccdeck's own
  LaunchDaemon, `dev.ccdeck.chmodbpf`, which at every startup creates the BPF
  devices and lets the `access_bpf` group read and write them, as Wireshark's
  ChmodBPF does. The user joins `access_bpf`; this boot's devices are also
  chowned to them, because a new group reaches running processes only after a
  new login. The app is not signed, so SMAppService is not an option.
- Linux: `pkexec /bin/sh -c …` installs `tcpdump` (apt, dnf, zypper or pacman)
  when missing, and `setcap` when missing, then sets `tcpdump` to the user's own
  group, mode 0750, with `cap_net_raw,cap_net_admin`. The user's own group is
  one they already have, so it applies without a new login. A `tcpdump` update
  drops the capabilities; the card comes back. With no `DISPLAY` or
  `WAYLAND_DISPLAY`, or no polkit agent, no prompt is attempted.
- Windows: no setup step. Npcap's free edition may not be installed by another
  program; the card links to Wireshark's download instead.

A dismissed prompt changes nothing. Where no prompt can open, or the script
stopped, the script is written to `~/.agents-deck/radar-capture-setup.sh` and
the card shows `sudo sh '<that file>'`. Granted, the service restarts capture
on the current collectors at once instead of waiting for the monitor's retry. A
monitor whose capture is refused retries every thirty seconds rather than every
three, since monitoring no longer stops.

On Linux, `captureTool` also tries `/usr/sbin/tcpdump`, `/usr/bin/tcpdump` and
`/sbin/tcpdump`: some distributions keep it in sbin, which a user's or a desktop
app's `PATH` may leave out. The `.deb` recommends `tcpdump`.

## Verification

- `radar-service.test.ts`: always on with nothing or anything saved, the five
  and sixty second cadence, named collectors, retries, `retry()` after a grant,
  and stale setup after shutdown.
- `radar-monitoring-default.test.ts`: the deck's own capture with real
  preference files in a scratch home, on a fresh and an upgraded deck, across a
  restart.
- `traffic-radar-permission.test.ts`: both root scripts and every outcome of
  the prompt, with the commands replaced.
- `telemetry-capture-routes.test.ts`: the permission route's guard and its
  retry on a grant; the removed switch, Start and Stop routes answer 404.
- `telemetry-capture-ui.test.tsx`: no Start, Stop or picker in any state, and
  the setup card on each platform and outcome.
- `node scripts/verify-radar-platform.mjs --live --automatic` exercises native
  packet capture with synthetic loopback OTLP: the service finds the collector
  by itself and resumes it after a restart, using disposable preferences.
