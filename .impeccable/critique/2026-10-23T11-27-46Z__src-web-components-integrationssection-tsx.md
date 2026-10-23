---
target: Settings Integrations iteration 5
total_score: 28
max_score: 40
p0_count: 0
p1_count: 0
timestamp: 2026-10-23T11-27-46Z
slug: src-web-components-integrationssection-tsx
---
Method: dual-agent (A: 01a1687e-e0c7-7601-84c8-c277073c26a0 · B: 01a1687e-e143-7943-af4d-85540d14db42)

# Iteration 5 critique — baseline eb43c426

Design-specificity: coherent CCDeck Operate interface, not a replacement visual
world. Preserve the compact overview, focused views and two-column metadata.

Nielsen /4: status 3; real-world language 3; control/freedom 3; consistency 3;
error prevention 2; recognition 3; efficiency 2; minimalism 3; recovery 3; help 3.
Total 28/40. This is subjective design assessment, not approval/certification.

## Priorities and decisions

P2: generic pane title/subtitle competes with selected connection identity.
Hide the overview introduction only while Manage is visible, make its selected
identity the h2; keep sidebar, Back, overview and forms familiar.

P2: Add is attached to a selected account. Put provider creation in the overview
provider heading, and retain a provider-named shortcut in Manage's Back toolbar.
This keeps direct collection access and the existing one-click shortcut without
letting creation lead the selected connection's keyboard workflow.

P2: confirmed interaction defect: Disconnect remains armed after Edit→Cancel
within four seconds. Independently reproduced with safe fixtures (zero API
mutations). Disarm on task changes; provide explicit cancellation; retain the
400ms anti-double-click guard. The existing four-second reading window was
initially retained; final audit classified it P1 and the corrective batch makes
an engaged confirmation untimed, cancelling on explicit Cancel, focus/task/window
change. Four seconds remains only an unfocused safety fallback. No blanket WCAG
conformance is claimed.

P2: GitLab's actual serverVersion is omitted by a Jira-only formatter. Render
provider-aware known server metadata; never invent unknown values.

P2: common 'Read-only access' can imply read-only token permissions, while GitLab
accepts broader api tokens. Clarify CCDeck's behavior, preserving local-token
storage and non-sharing facts. Stored locally is accurate; no encryption or
keychain claim is supported by the implementation.

P3: blanket 999px radius differs from shared --r-ctl controls. This is measurable
system drift, not evidence that rounded buttons are intrinsically unusable.
Remove this override and reuse existing button geometry/hover/focus.

## Strengths, layout and personas

Direct per-connection Manage is clear. Historical verification does not claim
continuous health. Native fields and explicit local removal consequences are
useful. Desktop density, two-column facts and narrow wrapping are sound. Reading
order currently context→Back→identity→facts→actions→removal is predictable but
context is overemphasized. Twenty-pixel groups and sixteen-pixel fact padding
remain; no cards or new navigation. Cognitive load is low for the three providers;
Manage's five commands are grouped, but Add receives the first forward Tab.
Expert persona needs Test before collection creation; newcomer needs saved versus
verified and local removal versus service revocation; keyboard/low-vision persona
needs persistent focus and a clear, cancellable confirmation.

## Independent mechanical evidence

CLI source scan and layout scan: [] for both target components. Baseline fixture
script passed all five viewport/theme runs (84 axe reports, no violations, 75
screenshots). Agent B's native tool could not initialize; this was not treated as
a pass. Parent native browser preflight and injected scan succeeded afterward;
overview flagged the established shared modal border/shadow heuristic. Final
native findings and actual accessibility results are in the handoff report.

Questions skipped: implementation and the stage sequence were explicitly
requested, so routine approval is unnecessary.
