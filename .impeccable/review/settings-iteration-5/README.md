# Settings → Integrations, iteration 5

Baseline `eb43c426`. Compact Native Settings is preserved: same modal/sidebar,
provider list, focused forms and two-column Manage facts. The selected connection
now leads its own view; provider collection actions and deletion intent are clear.
Local candidate for human review, not approval to merge or release.

## Critique and decisions

Method: dual-agent critique, independent design assessment A and detector/browser
assessment B. The [saved baseline critique](../../critique/2026-10-23T11-27-46Z__src-web-components-integrationssection-tsx.md) scored **28/40** on Nielsen heuristics;
this is subjective assessment, not an approval or accessibility certification.

| Priority | Meaningful baseline problem | Implemented response |
| --- | --- | --- |
| P2 | Generic introduction competes with selected identity; Add looks account-specific. | Selected identity is the h2 in Manage. Hide only its generic introduction. Direct provider Add in overview; named provider shortcut in Back toolbar, outside selected identity. |
| P1/P2 | Fixed four-second reading deadline; armed intent survives Edit→Cancel. | Untimed engaged confirmation, explicit Cancel, immediate disarming on focus/task/window change. Keep deliberate two presses, 400ms gap and repeat-click guards. |
| P2 | Useful endpoint and GitLab server data omitted. | Full configured URL, including scheme/path, and actual GitLab version when supplied. Alias, host and account stay distinct. |
| P2 | “Read-only access” may describe the token's permissions too strongly. | “ccdeck only reads from connected services” describes application behavior; local storage/non-sharing facts remain. |
| P3 | Local pill geometry differs from native CCDeck controls. | Remove local radius/height overrides and use the shared button, --ctl-h and --r-ctl. The shape itself is a preference; system consistency is the rationale. |

Already good: direct per-connection Manage, coherent provider identities, compact
metadata, historical verification, explicit local-removal consequence, capability
checks, focused forms, dirty protection and modal focus mechanisms. No new cards,
navigation tabs, second modal, decoration, animation or dependencies.

The stale confirmation defect was reproduced before fixing it: arming Disconnect,
entering Edit and cancelling left Confirm armed; zero API mutations were issued.
The final audit separately identified the four-second reading window as P1. The
corrective batch resolves that deadline without simply extending a stale timer.

## Actual Impeccable execution

Used the installed **4.1.1 Codex skill workflows**, in the requested sequence.
These are agent playbooks with real analysis/actions, not installed shell
subcommands. No installation/replacement or repeated context bootstrap.

| Stage | Work actually performed |
| --- | --- |
| A critique | Independent source/rendered design review and detector/browser assessment; combined prioritized findings saved through critique-storage.mjs. |
| B layout | Independent layout assessment plus --scope layout scan; identity → facts → Test/Edit → removal, collection creation outside selected identity. Same compact spacing and responsive columns. |
| C distill | Removed redundant Manage introduction, identity-level Add, duplicate visible URL tooltip and local pill/height styling; preserved every capability. |
| D clarify | Accurate application read behavior, saved vs historical-test information, explicit connection-test outcome, provider-named creation and local removal/Cancel consequence. |
| E polish | Existing shared control geometry, neutral Test/Edit, established destructive control, scoped grouping and normal hover/focus/busy states. Actual dark/light/short/narrow screenshots inspected. |
| F harden | Long URL/alias/account, unavailable provider, expired/refused token, slow/repeated requests, two-step deletion, focused reading without deadline, context cancellation and failure/retry. |
| G audit | Independent technical review, static detector/layout checks, focused test suite, actual browser tasks/axe/focus geometry. One P1 found in first audit was fixed in the single corrective batch and rechecked. |

Real helpers: `critique-storage.mjs slug/write`, `detect.mjs --json`,
`detect.mjs --json --scope layout`, `live-server.mjs --background/stop` and the
injected browser `impeccableScan`. Source/layout scans returned `[]` before and
after. Agent B's native browser initialization failed; the parent retried with
an owned isolated page and successfully injected/scanned overview, Manage and
empty Connect. Shared-shell shadow and closed-help line-length findings were
reviewed, not globally ignored. [Native evidence](native-parent.json).

## Interaction model and trade-offs

Overview Add is now one step, while a provider-named shortcut preserves one-step
creation from Manage. Every saved connection still has its own named Manage;
there is no account picker. Focus enters the selected h2; the next forward Tab
reaches Test rather than collection creation. Back restores the specific Manage
control and scroll. Edit saves/cancels to that connection; direct overview Add
cancels to overview, while toolbar Add cancels to the originating Manage.

An armed Disconnect explicitly focuses its action. Confirm and Cancel form one
focus group, with no reading deadline. Leaving the group, changing task/window,
hiding the document or choosing Cancel disarms it. Explicit Cancel restores
Disconnect focus. The four-second timer now only clears an unfocused fallback
state; it never expires an engaged confirmation. Two deliberate presses and the
400ms minimum gap remain; repeated keydown/clicks cannot duplicate requests.
The change is to cancellation/timing, not token persistence or removal APIs.

Deletion errors are announced beside Remove; test/save feedback stays beside
ordinary actions. Full URLs may wrap more than hostname-only text, but retain
transport and self-hosted instance-path information. Missing verification stays
unknown. “Stored locally” makes no encryption/keychain claim: the existing store
uses separate metadata/secret files with restricted local file permissions and
excludes secrets from public connection responses and paired-deck exchange.
No real credential or connection writes were made during validation.

## Actual rendered evidence

Before and after images come from the running application, with intercepted
safe fixtures. The after stress fixtures additionally exercise known GitLab
server versions and long display names. They are not mockups or evidence of
live provider authentication. Long pages intentionally scroll.

| View | Before | After |
| --- | --- | --- |
| Overview dark | [Before](before/overview-dark.png) | [After](after/overview-dark.png) |
| Overview light | [Before](before/overview-light.png) | [After](after/overview-light.png) |
| GitLab Manage | [Before](before/manage-gitlab-dark.png) | [Dark](after/manage-gitlab-dark.png), [Light](after/manage-gitlab-light.png) |
| Jira Manage | [Before](before/manage-jira-light.png) | [After](after/manage-jira-light.png) |
| Multiple saved connections | [Before](before/multiple-dark.png) | [Overview](after/multiple-dark.png), [Selected connection](after/long-manage-dark.png) |
| Connect | [Before](before/github-connect.png) | [GitHub](after/github-connect.png), [GitLab](after/gitlab-connect.png), [Jira](after/jira-connect.png) |
| Edit | [Before](before/edit-light.png) | [After](after/edit-light.png) |
| Disconnect confirmation | [Before](before/disconnect-confirm.png) | [After](after/disconnect-confirm.png) |
| Failed connection test | [Before](before/test-error.png) | [After](after/test-error.png) |
| Narrow overview | [Before](before/overview-320.png) | [320px](after/overview-320.png), [390px](after/overview-390.png) |
| Long hostname/account | [Before](before/long-manage-390.png) | [390px](after/long-manage-390.png) |
| Failed removal | — | [Error and retained focus](after/disconnect-error.png) |
| Short desktop window | — | [900×540](after/short-keyboard.png) |
| 200% reflow equivalent | — | [Halved CSS viewport](after/zoom-reflow.png) |

## Task and technical validation

Final independent audit: **17/20**, with no open P0/P1/P2 findings in scope.
This score is a heuristic, not approval. Final machine-readable results and
independent audit are linked below. Applicable
checks: `npm run typecheck`, `npm run build`, and `npm test --` filtered to
integration/provider/security tests, Settings navigation/search, modal
focus/dismissal/roles/shortcut gating, contrast floors and control boundaries.
The browser script uses external Playwright/axe installations through
`PLAYWRIGHT_MODULE`, `PLAYWRIGHT_EXECUTABLE`, `AXE_SCRIPT`, `SETTINGS_ARTIFACTS`;
no project dependency was added.

- **677 tests passed in 43 files** on Node 22.14.0; typecheck and production
  build passed. Vite retains the existing >500kB chunk-size warning.
- **Tasks A–G:** identify saved providers, inspect selected host/account/test
  time, successful/failed Test, token-preserving and credential-replacing Edit,
  add a second GitLab account, guarded removal and contextual Back all exercised.
- Desktop 1440×1000 dark/light, 900×760 dark, **900×540 short**, 390×844 light,
  320×740 dark. No page errors or horizontal overflow in completed runs.
- Mouse double-click cannot remove; Enter/Space first arm; reading beyond four
  seconds preserves confirmation; focus/window/task cancellation, explicit
  Cancel, delayed single-request Test/Delete, failed removal and retry are
  covered. Busy action retains focus; successful deletion focuses the remaining
  connection. Unavailable providers retain only usable cleanup actions.
- **104 axe reports had zero violations**. Axe-core 4.13.0 checks WCAG 2 A/AA, 2.1 AA and **2.2 AA** in tested states.
  Overview and Manage cover all **12 themes**. Short/narrow keyboard checks
  measure targets ≥24px, visible focus ring and unobscured activation point.
- Largest application text size checked. A halved CSS viewport exercises
  **200% browser-zoom reflow equivalence**; actual browser zoom/physical text
  magnification was not measured. This is not a full WCAG certification.
- Final `git diff --check` passed. No backend/API/security contract changes.

[Browser results](browser-results.json) · [104 accessibility reports](accessibility-results.json) · [Independent technical audit](audit.md) ·
[CLI detector](detector-after.json) · [Layout scan](layout-after.json).

The accessibility assessment uses [WCAG 2.2 minimum target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html),
[focus not obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)
and [timing adjustable](https://www.w3.org/WAI/WCAG22/Understanding/timing-adjustable.html).
The fixed reading deadline was corrected rather than counted as a successful
accessibility result. Shared 30px desktop controls exceed the 24px AA minimum;
they intentionally do not adopt enhanced 44px touch geometry everywhere.

## Remaining limits and Git boundary

No live provider authentication, manual VoiceOver/NVDA, Electron/OS/browser
matrix or profiling. The full unrelated suite was not rerun. Screenshot fixtures
validate frontend interactions, not present service health. The settings shell
and all unrelated sections remain intact; only the generic introduction yields
to the selected connection in Manage.

Branch `work/2026-10-23-changes`; exact local commit SHA is in the handoff.
Live preview: http://127.0.0.1:5186. No push, merge, release, tag, deployment or
publication. Stop for human review.

Questions skipped: this refinement and its workflows were explicitly authorized.
