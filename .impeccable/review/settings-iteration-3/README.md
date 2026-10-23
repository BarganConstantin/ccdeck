⚠️ DEGRADED: single-context critique (no independent sub-agent tool is exposed).

# Integrations — iteration 3

Chosen direction: **Compact Native Settings**. Baseline: `5aefd0bc` on
`work/2026-10-23-changes`. Implementation is ready for human review, not approved
for merge. This iteration leaves General and the Settings shell unchanged.

## UX findings and decisions

The previous overview exposed maintenance commands alongside every account,
repeated metadata, and left common security information below Jira. The new
reading order is provider → instance → concise account/verification metadata →
Manage. Existing glyphs, typography, tokens and separators are retained; no
provider cards, nested modal, additional sidebar or top-level provider tabs.

- An unconfigured provider offers **Connect**. Every saved connection offers
  **Manage**, including when several connections share a provider or host.
- Manage opens connection details directly in the existing content pane. It
  shows the full connection name, host, signed-in account, server details,
  last successful verification when known, and whether a token is saved.
- **Edit connection**, **Test connection**, and **Add connection** live in
  Manage. **Disconnect** remains discoverable in a secondary area, with its
  original two-press timing and explicit saved-token consequence.
- Adding a connection returns to the overview and focuses its Manage action.
  Edit saves/cancels back to the selected connection. Escape goes back one level;
  the existing modal mechanism, search and unsaved-change protection remain.
- After deleting a connection, focus goes to a remaining connection of that
  provider, its Connect action, or the Integrations tab. Focus waits for the
  committed view and completed request rather than relying on animation-frame
  timing while an ancestor may still be hidden.
- Additional connections require Manage → Add connection. That extra click is
  the deliberate cost of a quieter overview. There is no extra account picker:
  each connection has a direct, unambiguously named Manage action.
- Multiple connections show their aliases/accounts to distinguish them. A
  single connection uses host and account, with server information or historical
  verification in the summary. Manage always provides complete metadata.
- No green status check or continuous health claim was added. Missing/invalid
  verification metadata is explicitly unknown in Manage.
- Common access/token information now sits in a subdued native disclosure
  above the list, next to the total connection count; it cannot be mistaken
  for Jira-specific copy. Empty space below a short list is intentional.

## Research applied

| Primary reference | Applied pattern | Trade-off/reuse |
| --- | --- | --- |
| [Raycast preferences](https://manual.raycast.com/settings) | Searchable settings with focused configuration access. | Retains CCDeck search/sidebar rather than adding navigation. |
| [VS Code Settings](https://code.visualstudio.com/docs/configure/settings) | Stable groups and direct destinations. | Provider search still lands on Connect or Manage; maintenance is one step deeper. |
| [Primer progressive disclosure](https://primer.github.io/design/ui-patterns/progressive-disclosure/) | Separate overview/navigation from detailed maintenance. | Manage hides the list while preserving its return target and scroll. |
| [macOS Internet Accounts](https://support.apple.com/en-gb/guide/mac-help/mh35565/26/mac/26) | Select an account to manage details, with removal in its context. | One detail view per connection; no second modal or copied OS appearance. |

## Impeccable usage

Used installed **4.1.1** instructions and the actual critique, audit, layout,
clarify/distill and polish playbooks. They are agent workflows, not invented
executable slash commands. The session's product/design context and current
surface brief were reused, as required by the once-per-session bootstrap rule.

Critique identified action competition and ambiguous security-copy grouping
before the mechanical scan. The saved baseline assessment is 30/40, a subjective
heuristic assessment rather than approval. Layout set a predictable list/action
alignment; distill removed the exposed maintenance controls and redundant
single-connection labels; clarify separated stored configuration from historical
verification; polish used actual rendered states, long content and focus paths.

CLI detector and layout scans returned `[]` before and after. The native browser
detector was also injected and executed on Integrations, Manage and Connect.
It flagged the existing shared modal's thin border/wide shadow. This intentional
application-level elevation was retained under the requirement to preserve the
shell. Two line-length findings were on hidden retained token instructions
(`checkVisibility() === false`), not visible overview metadata. No global
ignore, theme rewrite or automatic acceptance of findings was introduced.

## Security verification

The retained common copy is supported by existing code:

- `src/server/integrations/store.mjs`: separate metadata/secret files, restricted
  local permissions, and no secret serialization into connection responses.
- `src/server/integrations/routes.mjs`: redaction and safe client responses;
  `checkedAt` is recorded after successful validation.
- Integration storage is excluded from the explicit LAN exchange allowlist.
- Existing integration secret, transport and persistence suites still pass.

No keychain/encryption claim is made. No token-handling, API, persistence,
provider capability or read-only behavior was changed. Real credentials were
not added, replaced, deleted, logged or included in the evidence.

## Changed files

- `IntegrationsSection.tsx`: compact overview, per-connection Manage,
  focused-view navigation and committed-view focus restoration.
- `IntegrationConnectionDetails.tsx` (new): explicit safe facts and contextual
  actions; shared historical verification/server formatting.
- `integrations.css`: compact list and detail layout using existing tokens.
- `settings.ts`: Integrations introduction only.
- `verify-settings-integrations.mjs`: actual browser flows for Manage,
  multiple connections, focused forms, errors, dirty state, search and focus.
- Three existing integration test files updated; a focused connection-details
  suite added for metadata, unavailable capabilities and deletion semantics.
- Surface brief and review evidence updated.

## Actual rendered evidence

Before screenshots are iteration 2's rendered UI. After screenshots are the
running iteration 3 application. All account/connection responses are safe,
fictitious browser fixtures; these are not mockups or proof of live authentication.

| State | Before | After |
| --- | --- | --- |
| GitHub disconnected, GitLab/Jira configured | [Dark](before-overview-1440-rider-black.png), [Light](before-overview-1440-light.png) | [Dark](after-overview-1440-rider-black.png), [Light](after-overview-1440-light.png) |
| Several connections | [390px](before-multiple-390-light.png) | [Desktop](after-multiple-1440-rider-black.png), [390px](after-multiple-390-light.png) |
| GitHub Connect | [Before](before-github-1440-rider-black.png) | [After](after-github-1440-rider-black.png) |
| GitLab Manage | — | [Dark](after-manage-gitlab-1440-rider-black.png), [Light](after-manage-gitlab-1440-light.png) |
| Jira Manage | — | [Light](after-manage-jira-1440-light.png) |
| Edit | — | [Existing connection](after-edit-1440-light.png) |
| Provider forms | — | [GitLab self-managed](after-gitlab-1440-light.png), [Jira Cloud](after-jira-1440-light.png) |
| Errors | — | [Validation](after-field-error-1440-light.png), [Failed test](after-connection-error-1440-rider-black.png) |
| Narrow layouts | — | [900px](after-overview-900-rider-black.png), [390px](after-overview-390-light.png), [320px](after-overview-320-rider-black.png) |
| Extremes | — | [Largest text](after-large-text-320-rider-black.png), [Unavailable provider](after-unavailable-1440-rider-black.png) |

## Validation

- **662 tests passed across 43 files**: integrations, Settings navigation,
  modal focus/dismissal/shortcuts, contrast and control boundaries.
- **Typecheck passed** on Node 22.14.0.
- **Production build passed**. Vite reports chunks over 500kB; unrelated bundle
  restructuring remains outside scope.
- **git diff --check passed.**
- **Browser:** complete interaction runs at 1440×1000 dark/light, 900×760 dark,
  390×844 light and 320×740 dark. No horizontal overflow or page errors.
- Connect/validation, per-connection Manage, adding another account, edit with
  blank saved token, test failure/recovery, guarded delete, Add/Edit cancellation,
  Back/Escape, dirty navigation/discard, search from Manage, modal Tab containment,
  list-read retry and unavailable-provider cleanup all passed.
- **axe WCAG 2 A/AA and 2.1 AA:** no violations in tested overview, Manage,
  form, error and confirmation states. Overview checked in all **12 themes**.
- Long hostnames/aliases and the application's largest text setting passed.

[Machine-readable browser results](browser-results.json).
The committed browser script uses external Playwright through `PLAYWRIGHT_MODULE`,
optional `PLAYWRIGHT_EXECUTABLE`/`AXE_SCRIPT`, and `SETTINGS_ARTIFACTS`. It intercepts
integration and preference changes so it cannot alter real saved connections.

## Limits and review boundary

No live provider authentication, manual VoiceOver/NVDA session, Electron/platform
matrix or profiling was performed. Existing local fake-provider tests validate
API behavior; the UI evidence establishes frontend behavior with fixtures.
No continuous health monitoring or unsupported request cancellation was added.
Long lists/forms intentionally scroll; pending requests retain the existing
completion/timeout rule. The full unrelated project suite was not rerun.

Branch: `work/2026-10-23-changes`. Exact commit SHA is supplied in the handoff.
The implementation is local and ready for human review. No push, merge, tag,
release, publish or deployment was performed.

Questions skipped: Variant 1 and implementation were explicitly authorized.
