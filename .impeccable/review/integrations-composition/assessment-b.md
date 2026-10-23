Assessment B — independent detector/browser evidence only

Repository: /Users/constantin/Desktop/ccdeck-work
Branch: work/2026-10-23-changes
HEAD: 7681e6deeab6b4154edee367d478548b92f97e22
Source remained read-only. No prior assessment/critique consumed. No bootstrap rerun, installs, builds, commits, pushes, merges, credential entry or connection mutations.

Deterministic scans (both exit 0):
node <installed-impeccable>/scripts/detect.mjs --json src/web/components/IntegrationsSection.tsx src/web/components/IntegrationConnectionDetails.tsx
node <installed-impeccable>/scripts/detect.mjs --json --scope layout src/web/components/IntegrationsSection.tsx src/web/components/IntegrationConnectionDetails.tsx
Outputs: detector-before.json and layout-before.json, each [] (0 findings). No rule IDs or file locations reported; no detector false positives to adjudicate. These source scans do not verify the requested provider/action composition or rendered browser rules.

Native browser attempt:
Browser runtime failed because its referenced browser-service.mjs is missing. Chrome DevTools new_page with a new named isolated context timed out after 60 seconds; no tab ID returned. list_pages for cleanup also timed out after 60 seconds. No existing tab was selected or navigated. Native mutable preflight, injection, detector console and Settings-scoped overlay findings could not be obtained. No helper was started, as mutable preflight was unavailable. Cannot confirm whether the timed-out native creation produced a tab or close an unidentified tab safely. Details: native-browser-status.json.

Fresh fixture screenshots:
Used only the setup prefix of scripts/verify-settings-integrations.mjs, followed by view navigation/capture; did NOT run the verifier suite. Existing external Playwright and Chromium, no installation. Exact provider/connection/prefs fixture base and API interception from the verifier. Captured at 1440x1000 rider-black and 390x844 light. Scoped screenshot target .settings-modal. Integration mutation counters 0 and pageerrors [] for both; isolated contexts and Chromium closed. A second bounded capture corrected the multiple-connection screenshot after discovering the app cached the fixture list across tab changes: reloading retrieves the updated fixture. General was scrolled to show actual Open buttons.

Artifacts under before/:
- before-overview-{viewport}-{theme}.png
- before-general-{viewport}-{theme}.png
- before-general-buttons-{viewport}-{theme}.png (Open buttons actually in viewport)
- before-github-{viewport}-{theme}.png (actual Connect GitHub form)
- before-manage-gitlab-{viewport}-{theme}.png
- before-overview-multiple-{viewport}-{theme}.png (two GitLab connections)
- buttons-{view}-{width}-{theme}.json, readviews-results.json
Capture script: before-readviews.mjs (temporary only).

Mechanical observations against the owner's explicit requirements:
1. GitHub overview Connect currently has class btn ig-manage and transparent neutral styling, not primary. The rendered GitHub form Connect is btn primary, with accent background/border. Source: IntegrationsSection.tsx:341.
2. GitLab and Jira overview currently show Add connection above Manage. One saved connection each yields five overview actions total (GitHub Connect, two Add, two Manage). Add exists in Manage already. Source: IntegrationsSection.tsx:334 and :311.
3. Two GitLab connections produce two per-connection Manage buttons plus provider Add on overview; connection names distinguish them. Selection currently happens in overview; there is no connection selector inside Manage. Source: IntegrationsSection.tsx:257, :306, :343. A single connection opens directly in one click, with no selection step.
4. Rendered General Open, overview Connect/Add/Manage, form Cancel and Manage Test/Edit share height 30px, radius 6px, horizontal padding 12px, font 12px/400 and 1px neutral border; these are the existing neutral button baseline. GitHub form Connect shares that geometry and uses the existing primary accent. Shared rules: src/web/styles/topbar-controls.css:447 and :484; radius token src/web/styles/tokens.css:83. Widths vary with text; overview Connect is 80px versus form Connect 73.734px.
5. Manage directly renders Test, Edit and Disconnect plus Add in its navigation. No mutation actions clicked during this assessment. Existing dirty-form, busy, focus-return and disconnect confirmation handling was only read, not behaviorally retested; no preservation claim based on this baseline capture.

Questions skipped: delegated evidence-only assessment; parent owns synthesis and implementation.
