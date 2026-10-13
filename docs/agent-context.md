# Owner's ccdeck work — continuation context

Updated: 2026-10-13. This is a handoff, not a claim that processes or remote
branches still have the same state. Verify them at the start of a new session.

## Tool activity audit preview on Mac — 2026-10-13

- Issue #2122, branch `feat/2122-tool-audit`, worktree
  `/Users/constantin/Desktop/ccdeck-tool-audit`, based on development `d2ca5ba6`.
- Frontend `http://127.0.0.1:4545/`, backend 4546, isolated data
  `CCDECK_HOME=/tmp/ccdeck-tool-audit-preview`. Installed app is untouched.
- Tool activity rail button below Usage history opens the device-wide operation explorer
  (More on phone); the Usage header entry was removed. General
  Settings has retention/actual size/clear. New calls only; no historical import.
- Concrete shell operations are grouped without arguments. Shared wrapper and
  compound timing describes the containing call, not independent inner work.
- Implementation and verification: `docs/features/tool-audit.md`.
  Current visual direction: `docs/features/tool-activity-report.md`.
  Full-page Direction A report with simultaneous usage/time comparisons,
  median-to-P95 endpoints and failed-call count/denominator/rate context.
  One report scroll, on-demand focus-protected evidence drawer, sortable
  operations table (50-row increments), no scatter plot or new dependency.
  Collector semantics unchanged; search scopes charts/table, not call summary.
  226 tests across eight suites, typecheck/build, six-size/nine-theme Brave
  regression checks passed. Read-only live Codex data was checked separately.
  Premium independent finish verdict: ship, no material fixes; evidence and limits in
  `.impeccable/review/tool-activity-premium/`.
  PR #2125 remains draft; owner preview review pending, no merge/deployment.

## Usage insights preview on Mac — 2026-10-13

- Issue #2121: quota history and session cached input reuse.
- Worktree: `/Users/constantin/Desktop/ccdeck-usage-insights`, branch
  `feat/2121-usage-insights`, based on development `a467d552`.
- Vite serves `http://127.0.0.1:4525/`, with `CCDECK_DEV_SERVER_PORT=4526`.
  The direct Node backend listens on 4526 with
  `CCDECK_HOME=/tmp/ccdeck-usage-insights-preview` and reports/install disabled.
- Preview quota history is actual observed Claude/Codex data, isolated from the
  installed app on 4317. Browser fixtures used for QA were not persisted.
- Usage history opens from the header chart icon; bars remain display-only.
  Header spend/minute and the Codex 7-day token/session summary were removed.
- Owner approved delivery to development on 2026-10-13. The feature is integrated
  with the current development baseline, including the account reset calendar.
  Details and verification: `docs/features/usage-insights.md`.

## Current Linux preview — 2026-10-12

- Primary checkout: `/home/constantin/Desktop/personal/ccdeck`, on `development`.
- Published `main` and `development` are synchronized at 3.40.2.
- Country-flag fix preview: `/home/constantin/Desktop/personal/ccdeck-wt/radio-svg-flags`,
  branch `fix/radio-svg-flags`, targeting `development` by PR.
- Vite runs at `http://localhost:5174/`, proxying this worktree's backend on 4318
  (`CCDECK_DEV_SERVER_PORT=4318`, `AGENT_DAG_PORT=4318`). Keep the installed
  desktop app on 4317 separate. Inspect processes before restarting anything.
- The paths and release state below describe earlier work on the Mac.

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

## Radar UI finish handoff — 2026-10-09

- Finish-review disposition: ship after both scored fixes. Partial readiness uses
  amber, a listening count and per-address readiness; decoded type labels are
  neutral metadata. The code-led inspector stays within the existing theme system;
  backend and capture protocol are unchanged.
- Help is disclosed and settings evidence moved to Configuration. Monitor combines
  decoded exports and observations chronologically, with separate counts, pinned
  initial/explicit selection and Pause list arrivals. Filters reset inspection.
  `JsonInspector.tsx` uses lazy details branches, batches of 50 and a 200,000-character
  raw highlighting budget; raw JSON stays complete. `radar-monitor-state.ts` is
  the pure state helper. Radar geometry is scoped in `traffic-radar.css`.
- Supplied QA passed: 216 tests / 11 files, TypeScript and final build; Brave in
  White Contrast / Rider Black at 1280, 1235, 900, 390 and 320px covered monitoring,
  pause/selection, filters/sessions, JSONL, JSON tree/raw/copy, keyboard navigation,
  2,000 events rendered as 100 then 200, and destination/permission/error/read-retry
  states. Documentation pass inspected source and the five `radar-redesign-*.png`
  screenshots in `/private/tmp/ccdeck-rail-qa/`; it did not rerun runtime QA.
- Real local snapshot: one listening address `192.168.88.16:4317`, **0 decoded
  messages / 2 observations**. Genuine Claude JSON capture remains unverified;
  decoded browser fixtures are separate evidence. Recheck live status next session.
  See `DESIGN.md` and `.impeccable/surfaces/telemetry-radar.md` for the UI contract.

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

## Radar flag controls — Linux handoff, 2026-10-12

- Radar implementation worktree: `/home/constantin/Desktop/personal/ccdeck-wt/radar-setting-toggles`,
  branch `feat/radar-setting-toggles`. The separate `electron-polish` worktree
  remains on `codex/release-3.39.3-live`.
- Preview: `http://127.0.0.1:4329`, started with
  `CLAUDE_CONFIG_DIR=/tmp/ccdeck-radar-toggles-qa node scripts/preview-traffic-radar.mjs`.
  It uses disposable settings, not the owner's Claude configuration.
- Flags use the shared switch and press rules. The working control stays enabled
  and busy, sibling flags are disabled, and the handler rejects repeated presses.
  Unreadable sources are Unavailable; organization policy remains Managed.
  Unknown values offer explicit Enable/Disable actions.
- Configuration has one scroll area; navigation stays reachable at 320/390px.
  Saving updates the server cache and rejects older client polls, so an in-flight
  read cannot undo a confirmed save.
- The complete suite passed (1,036 files / 13,069 tests), typecheck and production
  build passed. A subsequently added BOM regression also passed. Chrome DevTools
  checked light/dark desktop and 320/390px layouts, saving, failure/retry, focus,
  duplicate presses, unknown values, policy rejection and file-view retention.
- The installed `/home/constantin/Applications/ccdeck-linux-x86_64.AppImage`
  has not been replaced with this branch. These preview checks do not prove
  capture of a real external Claude telemetry stream.

## Radar Monitor simplification — 2026-10-12

The owner requested a simpler Monitor screen. With no history it now shows one
empty workspace, the destination and Start monitoring. The inspector appears
when retained activity exists; filters, Pause/Resume and Clear history sit in
a closed native Filters and history disclosure. Session filtering appears only
when sessions or captured exports make it relevant. Capture limits remain
available in the footer. Capture APIs and settings behavior are unchanged.

Validated by typecheck, production build and the full suite (1,036 files,
13,071 tests), plus Chrome DevTools at 1280px, 390px and 320px with light/dark
themes. Synthetic browser activity verified the populated inspector, disclosed
filters, Pause/Resume and clear confirmation. Preview remains port 4329 with
disposable settings; this does not establish real Claude traffic capture.

## Next-session starting point — 2026-10-12

The Radar flag controls and simplified Monitor are integrated into local
`development` in `/home/constantin/Desktop/personal/ccdeck`.
Continue modal work from that checkout (or create a new branch/worktree from
`development`). The feature worktree remains available. Port 4329 now serves the
merged development checkout with the same disposable Radar settings. Rebuild `dist/web` in the checkout being served after
frontend edits. The installed AppImage has not been replaced.

Merge validation: all 1,050 test files / 13,158 tests passed, along with
typecheck and production build. Browser smoke checks on port 4329 confirmed
the merged v3.40.2 UI has the simplified Monitor and individual Configuration
switches. The only merge conflict was the switch-count regression test:
development removed the Music switch, so the combined source contains 17.
