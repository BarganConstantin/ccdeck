# Automatic Radar monitoring

Radar is enabled by default. Capture starts in the server without opening Radar
or keeping a browser window open. Settings → Radar is the feature switch: Off
stops capture and discovery, hides the desktop rail and mobile menu entry, and
closes an open Radar view. The saved preference is honored after a reload or
restart. Turning it back on restores the entry and automatic capture.

## Runtime ownership

`traffic-radar-service.mjs` owns the enabled preference separately from capture
readiness. It wraps the existing packet capture, retries discovery/setup every
five seconds while enabled, and cancels stale setup work after disabling. The
existing `radar-monitor-<port>.json` preference stores the switch and remembered
collector destinations. Absence of a preference defaults to On; a saved Off is
preserved. Tokens and packet contents are never persisted by this service.

Configured IPv4 collector endpoints take precedence. With no configured address,
remembered collectors and active IPv4 OTLP/gRPC port 4317 connections provide
fallback targets. Arbitrary Claude API HTTPS connections are not selected. The
existing platform/tool/permission limits remain visible; On does not imply that
capture is ready or that a message was sent. When no collector is known, the
monitor waits and discovers it in the background.

The managed application no longer displays Start/Stop or a manual destination
picker in Monitor. Legacy manual helper APIs remain available for compatibility.
Clear history and Pause list keep their existing inspection-only behavior.

## Settings and browser state

The guarded, local-only `/api/system/traffic-radar/settings` GET/POST endpoint
returns and persists the feature switch. Only boolean writes are accepted. A
shared client store updates Settings and the toolbar together, rejects stale
polls after saves and retains the confirmed state when saving fails. Other open
windows refresh the server preference on their settings poll.

Local project/prompt display and JSON inspection are unchanged by this switch.
Claude telemetry flags and the external collector are not modified. In-memory
capture history retains its existing lifetime and is cleared by a server restart.

## Verification

- Service regressions cover default startup, late collectors, retries, durable
  disable/re-enable, stale discovery/setup cancellation and failed preference saves.
- Client regressions cover shared state, stale poll rejection and failed saves.
- Route tests cover local access, guarded reads and strict boolean validation.
- Settings and monitor regressions cover the Radar section and absence of manual
  capture controls, including initial loading and permission failures.
- `node scripts/verify-radar-platform.mjs --live --automatic` exercises native
  macOS packet capture with synthetic loopback OTLP, automatic startup, accepted
  collector responses, restart and persistence of Off, using disposable preferences.
- Isolated Chromium checks the Settings switch, toolbar disappearance, reload
  persistence and restored automatic capture. Desktop uses the actual local
  server and restores On afterward; mobile setting replies are isolated fixtures.

The implementation was reviewed directly in-thread using the existing Impeccable
Operate/refinement guidance, without an independent reviewer.
