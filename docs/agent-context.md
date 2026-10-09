# Owner's ccdeck work — continuation context

Updated: 2026-10-09. This is a handoff, not a claim that processes or remote
branches still have the same state. Verify them at the start of a new session.

## Checkout and running app

- Original checkout: `/Users/constantin/Desktop/agents-deck`, with separate
  unfinished Git View work. Preserve that checkout and its changes.
- Current Radar worktree: `/Users/constantin/.cache/ccdeck-wt/radar-cross-platform`.
  Earlier UI worktree: `/Users/constantin/.cache/ccdeck-wt/finish-left-column`.
- Working branch: `feat/radar-cross-platform`; delivery branch: `origin/development`.
  Completed commits have been delivered with `git push origin HEAD:development`.
  Fetch and inspect divergence before pushing; integrate remote work rather than
  force-pushing. Other worktrees also exist, so inspect `git worktree list`.
- The owner's local app has been served at `http://127.0.0.1:4317` from the Radar
  worktree, using `/Users/constantin/.nvm/versions/node/v22.14.0/bin/node`.
  Inspect the actual listener and process before assuming this is still true.
- Launch the built UI with `node bin/agent-dag.js --port 4317 --no-open` from the
  intended checkout. Consult `--help` before changing server lifecycle behavior.
- `main` and `development` were synchronized for the published 3.39.1 release.
  Radar platform support and the Electron update button subsequently went to
  `development` only. Package version is still 3.39.1; these later changes need
  a future release to reach installed desktop apps.

## UI decisions

The owner wants a polished development-tool experience. Icon rails replace
awkward rotated labels; Accounts and Sessions should feel consistent. Keep
controls discoverable with labels/tooltips and keyboard access.

Themes are versioned JSON with generated CSS/catalog output. The existing set
includes Light, Dark, Rider Black, VS Code Black, Omarchy, Matrix, Black Contrast,
White Contrast and Catppuccin Mocha. Rider Black is the fresh-install preference;
Dark is the CSS fallback. Shared light-theme behavior follows `data-color-scheme`
rather than matching just one theme ID. The theme README owns the format and
generation instructions. A custom-theme importer/editor is a future possibility,
not an implemented feature.

The minimap drawing was reduced from 200 × 150 to 140 × 105 (about 30% smaller;
142 × 107 including borders). Character ledge travel must use the measured map
and sprite widths, not the previous 148px travel range. Walk planning, runtime
clamping and cleanup must agree. Intentional floor walks, falls and climbing
remain part of the animation; distinguish these from accidental floating beyond
the map's ledge. The regression test is `fm-ledge-bounds.test.ts`.

The bottom Auto-fit / Resume chip and temporary Layout re-arranged / Undo notice
share a horizontal `.canvas-notices` row. Keep them side by side at narrow widths,
with readable controls, and use the whole row for character obstacle detection.

## Telemetry Radar product intent

The owner needs three understandable views, already represented by the modal:

1. Configuration: whether Claude telemetry is enabled, relevant settings / env
   values, and the actual configured collector destinations, with clear colors.
2. Monitor: traffic to those destinations, a readable message list, contents and
   full decoded JSON where capture supports it, like a focused packet inspector.
3. File: the rows and contents of a telemetry file.

Keep a session filter alongside an all-sessions view. Settings can apply to
multiple Claude processes; do not imply that each export belongs to one session
unless the observed data establishes that association. Explain unattributed
messages honestly.

The owner wants monitoring to remain active, and questioned an empty monitor
despite believing Claude sends telemetry. Treat this as a requirement to verify,
not proof of continuous capture. Configuration, observed connections and decoded
messages are different evidence. Check the live API/helper status and capture
coverage before reporting "not sending" or "working". Preserve Claude settings
during passive inspection. Avoid filling the modal with setup jargon; show a
clear next action when capture needs assistance.

## Radar platform support and desktop updates

- `src/server/traffic-radar-platform.mjs` owns native inspection and capture-tool
  setup. macOS uses ps/lsof and route/tcpdump. Linux uses ps plus owned `/proc`
  sockets and tcpdump `any`, including loopback. Windows uses PowerShell native
  process/connection APIs and Wireshark dumpcap with Npcap. Windows cwd may be
  unknown; do not infer a workspace or session from an address.
- Capture now runs directly in ccdeck with one supervised child per destination,
  using binary pcap stdout (`-F pcap` for dumpcap). Failed children retry, with a
  fresh interface and decoder. `traffic-radar-monitor.mjs` owns this supervision
  and per-port opt-in preferences. App startup resumes enabled destinations;
  Stop disables the saved preference. Tokens and packet contents are not saved.
  The older helper command remains for CLI smoke tests and compatibility.
- Capture dependencies and privileges are explicit. No drivers are installed
  automatically. On 2026-10-09 the owner explicitly approved installing all
  dependencies on `rdp`. Wireshark 4.6.9 and Npcap 1.89 were installed from
  official, signed packages; the Npcap driver runs without a reboot. The free
  Npcap installer was completed through its GUI, not an OEM silent switch.
- `scripts/verify-radar-platform.mjs` is an OS smoke probe. `--live --managed` creates only
  synthetic loopback traffic and verifies real packet capture, decoded JSON and
  collector acceptance. It requires capture privileges and dev dependencies.
  The live Linux check passed in an isolated Docker container. The live Windows
  check passed on `rdp`, executing managed capture and capturing
  real Npcap loopback packets: decoded JSON matched the synthetic export, its
  session ID was recovered, and the collector response was `accepted`. This
  verifies the capture path; it does not prove Claude sent that test payload.
- Monitoring has no ten-minute expiry. It continues while ccdeck runs and resumes
  after a restart on the same port, until explicitly stopped. Retention remains
  bounded to 2,000 exports / 24 hours / 32 MiB encoded payloads. History survives
  Stop/Start within the process; it is cleared by restart or Clear messages. The
  UI reports capacity evictions and renders history in batches of 100. Permission failures remain visible.
- On 2026-10-09 Wireshark's signed, notarized ChmodBPF package was installed on
  the owner's Mac through the system administrator prompt. This grants packet
  capture access; ccdeck itself remains unprivileged. Real managed capture and
  restart/Stop persistence were verified on macOS, Windows and Linux with synthetic
  OTLP traffic. Do not claim that a synthetic fixture came from Claude.
- What's new now has a Check for updates button inside Electron. It asks the
  existing updater through the authenticated tray stream; it does not use npm
  to update a bundled app. Modern desktop reports include `canCheck: true` so a
  request to an older desktop app is refused instead of claiming a check ran.
  The full click-to-native-check flow was verified in an isolated Electron app.

## Verification lessons

- A still screenshot missed the character's old movement bounds after shrinking
  the map. Exercise animation over time and inspect the sprite against the map.
- Validate both bottom notices while visible together, then test Undo and Resume.
  Manual zoom disables auto-fit only after the initial fit suppression window;
  wait for initial layout to settle before reproducing this state in browser QA.
- Node 22 passed the relevant tests. A streaming-test RangeError on Node 26 was
  reproduced on an unchanged baseline; use the verified runtime for comparison.
- Use current tool availability for browser QA. A previous in-app browser skill
  bootstrap failed because its service was absent; the owner explicitly
  authorized Brave / Chrome DevTools. Do not rely on temporary QA scripts or
  hardcoded browser page IDs surviving into another session.

Keep this handoff concise: update decisions and unresolved requirements, and use
source files and Git history for implementation details rather than recording
the entire conversation.

- Continuous-monitor QA also exercised the actual local daemon restart from Brave,
  real synthetic JSON and collector acceptance, modal close/reopen, and Stop in
  Rider Black / White Contrast at 1280, 390 and 320px. A pcap header alone is
  readiness, not traffic; verify the status again after the first real export.
- Restart QA exposed canvas measurement feedback. Keep Flow's previous sizes
  separate from DOM measurements in `use-node-measurements.ts`; compare each
  source with itself. Commit moving chrome measurements on the next frame in
  `SessionClusters.tsx`, rather than recursively updating layout state.

- The owner rejected the orbital empty-canvas illustration as overly decorative.
  Keep this surface minimal: a terminal outline without a tile, rings or glow. The owner later requested
  subtle motion: only its cursor blinks while connected and visible, with a
  steady cursor under reduced motion. Preserve readable text rather than lowering
  text opacity; the helper details and tour remain available.
