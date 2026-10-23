# Integrations — final consistency and UX QA

Review branch: `work/2026-10-23-changes`. Baseline commit: `3d5bf3785166a517b4c07cad2b171253da80d407`. This report and its implementation are committed together; use `git log -1` for the review commit. Local preview: http://127.0.0.1:5186. No merge, push, deployment, tag or release.

## Exact corrections

- The generic Integrations heading, description and saved total now appear **only on the overview**. A single existing CSS selector covers all focused views, including forms.
- Connect/Edit reuse the existing Manage provider header: decorative provider glyph, contextual h2 and, for Edit, provider identification beneath the selected connection name. Form accessible naming is unchanged.
- Keyboard Enter previously left focus on BODY when the submitted input disabled. Before submission focus now moves to the surviving Checking action, which remains visible and announces busy state. Initial field focus and error recovery are unchanged.

Overview rows, button styles, Manage details, sidebar, provider fields, API contracts and secret persistence were preserved. Only two runtime files changed: `src/web/components/IntegrationConnectionForm.tsx` and `src/web/styles/integrations.css`. QA changes: `src/web/__tests__/integrations-settings.test.ts`, `scripts/verify-settings-integrations.mjs`, new `scripts/verify-integration-form-variants.mjs`; design context and this evidence were updated.

## Impeccable actually applied

Installed version 4.1.1, `.agents/skills/impeccable/SKILL.md` and its critique/audit/harden references were read. Codex followed those workflows directly; no invented slash-command execution. The session context helper was run once, and existing Settings context and craft-floor guidance were used. Independent critique assessments were reviewed before synthesis: [A](evidence/critique-a.md), [B](evidence/assessment-b.md). The synthesized critique is persisted under `.impeccable/critique/` through the installed storage helper.

Top findings were P2 duplicated overview hierarchy, P2 missing explicit Edit provider identity and P2 reproduced keyboard-submit focus loss. No broad redesign was warranted. Assessment A scored only five heuristics, 14/20; five were unassessed, so this is not a full /40 score. Detector [before](evidence/detector-before.json) and [after](evidence/detector-after.json) returned zero findings; visual/interaction evidence found the actual issues. Hardening used slow/failing fixture responses, repeated requests, long values, deployment switches, narrow/short panes and deletion recovery. [Final audit](evidence/assessment-b-final.md).

## Actual rendered evidence

Fresh before captures come from the same baseline branch. All after images show the running application with safe fixture accounts, never mockups. Historical `before-*` copies inside the main verifier were not substituted for these fresh form baselines.

| View | Before | After |
|---|---|---|
| GitHub Connect, dark | [Before](before/connect-github-1440x1000-rider-black.png) | [After](after/github-dark.png) |
| GitLab Edit, dark | [Before](before/edit-gitlab-1440x1000-rider-black.png) | [After](after/edit-dark.png) |
| GitHub Connect, narrow light | [Before](before/connect-github-390x844-light.png) | [After](after/github-390x844-light.png) |
| GitLab Edit, narrow light | [Before](before/edit-gitlab-390x844-light.png) | [After](after/edit-390x844-light.png) |

Final required states: [Overview](after/overview-rest-dark.png), [Manage GitLab](after/manage-gitlab-dark.png), [Manage Jira](after/manage-jira-dark.png), [GitHub Connect](after/github-dark.png), [GitLab Connect](after/gitlab-dark.png), [Jira Connect](after/jira-dark.png), [Edit](after/edit-dark.png), [Multiple overview](after/multiple-overview-dark.png), [Connection selection](after/multiple-collection-dark.png), [Failed test](after/connection-error-dark.png), [Disconnect confirmation](after/disconnect-confirm-dark.png).

Additional evidence: [GitLab.com](after/gitlab-cloud-1440x1000-rider-black-connect.png), [GitLab self-managed](after/gitlab-self-1440x1000-rider-black-connect.png), [Jira Cloud](after/jira-cloud-1440x1000-rider-black-connect.png), [Jira Server/Data Center](after/jira-server-1440x1000-rider-black-connect.png), [Long identity](after/long-manage-dark.png), [200% document zoom](after/zoom-200-long-manage-dark.png), [320px form](after/github-320x740-rider-black.png), [Short window](after/github-900x540-rider-black.png), [Light overview](after/overview-rest-1440x1000-light.png).

Parent visually inspected before/after GitHub, Edit, Manage, overview and narrow light Jira; both assessments supplied further rendered inspection. The approved row composition and button geometry remain intact.

## Functional and accessibility results

[Main browser results](evidence/management-results.json): **6/6 cases passed**, 78 contextual-form checks. Cases: 1440x1000 dark/light, 900x760 and 900x540 dark, 390x844 light, 320x740 dark. Includes overview/Manage, multiple account selection, Add/Connect, Edit with blank saved token, successful and failed tests, confirmation guard, reading time, Cancel/focus restoration, mouse/keyboard removal, repeated requests, 503 deletion recovery, last-connection removal, Back/Escape, unsaved drafts, search, unavailable providers and long names/hosts. No browser page errors or content overflow. Overview/Manage were additionally axe-checked across the existing theme catalog; Connect was visually sampled in dark/light.

[Variant results](evidence/variant-results.json): **9/9 passed** across GitHub, GitLab Cloud/self-hosted, Jira Cloud/Server/Data Center, narrow/light/short samples. Missing/invalid credentials, field alerts and error focus, cleared passwords with retained nonsecret drafts, Jira email requirement, payload deployment, two-second loading, duplicate Enter protection, blank-token edit and deployment changes covered. All writes were intercepted fixtures; unrelated mutations were blocked. This verifies UI and payload behavior, not external authentication or disk persistence.

[Before keyboard focus](evidence/repro-keyboard-before.json): BODY while Checking. [After](evidence/repro-keyboard-after.json): focused Checking button, one request. No credential text is included in feedback evidence. Password fields remain masked/blank, saved tokens are never populated into forms, and existing local-only storage implementation was unchanged.

Keyboard checks include initial field focus, visible submit focus, error-field focus, Back/Cancel restoration, Escape one-level navigation, modal dismissal/trap and destructive confirmation. Form h2/aria-labelledby and decorative glyph semantics are covered for all three providers in unit tests. Status/alert roles were checked in browser; actual screen-reader speech was not tested.

Main axe run: **110 records, zero violations; 81 records contain unresolved color-contrast checks**. Original rule targets are retained in [axe evidence](evidence/axe/). Variant run: ten original scans, zero violations, with contrast incompletes and computed-color follow-up in [accessibility audit](evidence/accessibility-audit.json). Follow-up text/surface ratios were above AA thresholds for sampled subtitle/help/hints/choices, but partially clipped horizontal navigation edges remain unverified. Zero automated violations does not establish WCAG conformance.

## Quality gates and execution details

- **684 tests / 43 files passed**: integrations, settings, modal focus/dismiss/roles/shortcuts, contrast floors and control edges. [Log](evidence/tests.log).
- `npm run typecheck`: passed. [Log](evidence/typecheck.log).
- `npm run build`: passed, 37.83s; existing Vite large-chunk warning remains. [Log](evidence/build.log).
- Both browser scripts passed `node --check`; `git diff --check` passed.
- Project checks used Node22.14.0. Main browser run retained two completed desktop cases from Node26.5.0; remaining four passed on Node22.14.0. The external Chromium engine was the same.
- Initial browser harness attempts stopped on aria-disabled/native-disabled assertion semantics, failure-call accounting, screenshot stability, then direct fixture cache refresh. These were verifier corrections, not hidden product failures. Two completed desktop cases were retained; a bounded resumed run finished the other four. [Initial log](evidence/full-six-case.log), [resumed log](evidence/remaining-four-case-node22.log).

## Limits / review status

Native browser control was unavailable, so isolated external Playwright Chromium captured the live web UI. Electron/native window behavior, Safari input zoom, real provider credentials/network health, real persistence writes, full performance profiling and VoiceOver/NVDA were not exercised. Document zoom is not equivalent to OS or browser text-only zoom. Existing small desktop input typography and approved shell styling were retained. No present-service-health claim was added from historical verification.

Ready for human design and interaction review; not approved for merge or release. No further redesign is included.
