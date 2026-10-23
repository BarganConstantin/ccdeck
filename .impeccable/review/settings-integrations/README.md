⚠️ DEGRADED: single-context critique (no sub-agent tool is exposed in this session).

# Settings and Integrations — first iteration

Branch: `work/2026-10-23-changes`. Baseline: released `main`, `eda20e52` (3.46.0).
Ready for a separate senior frontend and UX review after the validation below.
No push, pull request, merge, release, or deployment was performed.

## Audit and rationale

The existing Settings shell is worth preserving: ten distinct sections, a stable
modal height, independent content scrolling, shared setting rows, search with
keyboard result selection and focus jumps, immediate preference changes, and
Escape/Tab focus handling. Appearance, text density, keyboard controls,
notifications, sounds, data, Radar, and About already use a coherent system.
Adding another navigation hierarchy or wider promotional cards would add work
for the user without fixing a demonstrated problem.

The design assessment was recorded before running the Impeccable detector.
The detector completed without findings for SettingsModal. The audit also
inspected rendered baseline views, dependency code, existing integration and
modal tests, tokens/styles, DESIGN.md, and the Jira integration surface brief.

| Priority | Finding | Decision |
| --- | --- | --- |
| P1 | Providers were hidden behind Add integration and a second picker; saved connections lived in a separate list. | Show GitHub, GitLab, and Jira directly inside the existing Integrations section. Each provider owns its saved connections and Connect/Add connection action. |
| P2 | Search indexed Jira terminology but had no direct GitHub or GitLab destination. | Add provider anchors and aliases for repositories, pull/merge requests, Actions, pipelines, boards, and sprints. Filter provider destinations by what this backend offers. |
| P2 | GitHub's token-only add form had no initial field focus. Canceling an edit did not restore focus to its Edit action. | Focus the first usable field, return focus on cancellation/save, and return deletion focus to the same provider after busy state clears. |
| P2 | The request guard silently ignored other actions while their buttons still appeared available. A form could be dismissed or changed during its request. | Disable competing controls and fields while busy, keep the active action focusable with busy semantics, and preserve the existing handler guard. |
| P2 | Full token instructions competed with configuration fields and pushed actions farther down the pane. | Keep the existing provider instructions in native keyboard-accessible disclosures. Scroll expanded forms into view. |
| P2 | The mobile navigation rendered horizontally while declaring a vertical tablist. | Follow the existing 640px breakpoint in ARIA, preserving the supported arrow keys, Home/End, and shortcuts. |
| P2 | A failed connection-list read offered no immediate retry. | Add Retry using the existing deduplicated refresh function. |
| P3 | Several section introductions used indirect descriptions. | Clarify General, Keyboard, Sounds, and Integrations without changing their organization or controls. |

The layout uses existing fonts, neutral separators, glyphs, control heights,
semantic colors, and theme tokens. Provider descriptions name the work they
contain. “Not connected” and saved-connection counts describe configuration;
they do not imply continuous connection health. Existing account, host,
verification timestamp, warnings, and missing-token information remain visible.

## Implementation

- `IntegrationsSection.tsx`: provider groups, inline forms, grouped multiple
  connections, retry, request state, focus recovery, and an announced disconnect
  confirmation. Keeps unavailable-provider connections removable.
- `IntegrationConnectionForm.tsx`: initial focus fallback, form scrolling,
  token-help disclosures, required-field semantics, and pending-request controls.
  Saved secrets still start empty; blank edit values keep the saved secret.
- `settings.ts`, `settings-search.ts`, `integrations/registry.ts`: concise
  descriptions, provider search destinations, and capability-aware filtering.
  The registry's global order is preserved; provider order changes only here.
- `SettingsModal.tsx`, `use-media-query.ts`: responsive tablist semantics and a
  safe initial media-query read during server rendering.
- `styles/integrations.css`: provider spacing, shared connection actions,
  responsive wrapping, and disclosure styling.
- Four test files updated, `integrations-settings.test.ts` added, and
  `scripts/verify-settings-integrations.mjs` added for repeatable browser checks.

SettingsParts and the ten-section navigation structure are retained. The server,
API contracts, persistence, credential handling, dependency list, licensing,
packaging, and release workflow are unchanged.

## Visual evidence

All linked images capture the actual rendered Settings dialog. Baseline captures
come from an unmodified archive of the baseline commit. Connection responses
are browser-intercepted fixtures with fictitious names and addresses; screenshots
contain no real account data or access tokens. These are visual/interaction
fixtures, not proof of authentication with an external provider.

| View | Before | After |
| --- | --- | --- |
| General and navigation | [Dark](before-general-1440-rider-black.png) | [Dark](after-general-1440-rider-black.png) |
| Disconnected overview | [Dark](before-disconnected-1440-rider-black.png), [Light](before-disconnected-1440-light.png) | [Dark](after-disconnected-1440-rider-black.png), [Light](after-disconnected-1440-light.png) |
| Multiple saved connections | [Light](before-connected-1440-light.png) | [Light](after-connected-1440-light.png) |
| GitHub form | [Dark](before-form-github-1440-rider-black.png) | [Dark](after-form-github-1440-rider-black.png) |
| GitLab form | [Light](before-form-gitlab-1440-light.png) | [Light, self-managed](after-form-gitlab-1440-light.png) |
| Jira form | [Dark, Server](before-form-jira-1440-rider-black.png) | [Dark, Cloud](after-form-jira-1440-rider-black.png) |
| Narrow layout | [390px Light](before-disconnected-390-light.png), [320px Dark](before-disconnected-320-rider-black.png) | [390px Light](after-disconnected-390-light.png), [320px Dark](after-disconnected-320-rider-black.png) |
| Error/recovery | — | [Field error](after-field-error-1440-light.png), [Connection error](after-connection-error-1440-rider-black.png) |
| Narrow configuration | — | [Jira Cloud at 320px](after-form-jira-320-rider-black.png) |

## Validation

Node 22.14.0:

- **657 tests passed across 42 files**: integrations, Settings, modal dismissal,
  focus trap, dialog roles, shortcut gating, contrast floors, and control edges.
- The final disconnect-focus change was followed by **29 passing focused tests**
  in the integration Settings and unavailable-provider suites.
- `npm run typecheck`: passed.
- `npm run build`: passed. Vite reports chunks larger than 500 kB; this iteration
  does not restructure application bundles.
- `git diff --check`: passed.

Chromium with Playwright, isolated contexts:

- 1440px Rider Black, 1440px Light, 390px Light, and 320px Rider Black.
- All ten sections, stable frame height, one selected tab, content overflow,
  search destinations, provider forms, GitLab self-managed and Jira Cloud fields.
- Common connection management: create, multiple connections, rename with blank
  saved token, success feedback, test refusal/recovery, and confirmed deletion.
- Initial/token-error focus, Cancel/save/delete focus recovery, Home/End/arrows,
  Ctrl+F, search Escape, Tab containment, and return to the Settings opener.
- axe WCAG 2 A/AA and 2.1 AA: no violations in tested integration overviews,
  configuration forms, or field-error views.
- Overview accessibility and overflow smoke checks in **all 12 catalog themes**.
- No browser page errors in the four complete interaction runs.

[Machine-readable browser results](browser-results.json).
The committed browser script uses an existing Playwright installation through
`PLAYWRIGHT_MODULE`, optionally `PLAYWRIGHT_EXECUTABLE` and `AXE_SCRIPT`, and
accepts the running preview URL as its first argument. `SETTINGS_ARTIFACTS`
controls its output directory. It intercepts integration requests and never
changes real connections.

## Limits and review boundary

Real external credentials were not added, rotated, or deleted. GitHub exercises
the shared connection lifecycle in the browser; GitLab and Jira exercise their
configuration variants. Existing integration suites exercise API and persistence
contracts with local fake providers. This pass does not establish successful
real GitHub/GitLab/Jira authentication, continuous health, or live provider data.

No manual VoiceOver/NVDA session or native Electron/platform matrix was run.
Automated accessibility and keyboard testing support this iteration; they are
not an accessibility certification. Full project suites were not rerun: checks
were limited to the affected surfaces and shared modal/contrast dependencies.
Long forms and multiple connections intentionally scroll inside the existing
pane; navigation and dismissal remain available.

Questions skipped: the owner supplied the scope and authorized implementation.
