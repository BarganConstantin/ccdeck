# Independent Assessment A — Integrations subpage hierarchy

Method: isolated Assessment A design review for parent synthesis. No Assessment B, detector output, or prior assessment/critique was consumed. Read installed Impeccable critique, audit, and harden playbooks; bootstrap was already completed and was not rerun.

Repository: /Users/constantin/Desktop/ccdeck-work
Branch: work/2026-10-23-changes
HEAD: 3d5bf378
Source status: clean before and after inspection. No repository edits, build, installation, commits, publishing, backend changes, or API requests/mutations performed.

## Verdict

The proposed tiny hierarchy correction is justified. Keep the generic Integrations heading, description, and global saved-connection count on the overview only. Connect and Edit should use the same navigation → primary identity → content hierarchy already established by Manage and provider collections. Promote the form title to h2 and supply the incumbent provider glyph and a concise provider identity line. Preserve existing field order, task wording, buttons, overview rows, and Manage details.

This is a coherent developer-tool settings surface. Its specificity comes from local credential language, provider deployment choices, saved-connection identity, and the compact IDE-like shell. No visual-world replacement or styling exploration is needed.

## Evidence and limits

Native browser control was not exposed in this assessment. Used the owner's explicitly allowed fallback: inspected actual-app screenshots and checked them against current source. No browser or tab was opened, so no owned tab requires closing. Runtime at http://127.0.0.1:5186 was not navigated; parent owns runtime and functional QA.

Rendered evidence inspected:

- .impeccable/review/integrations-composition/references/connect-form.png — GitHub Connect.
- .impeccable/review/settings-iteration-5/after/gitlab-connect.png — GitLab Connect, self-managed.
- .impeccable/review/settings-iteration-5/after/jira-connect.png — Jira Connect, Cloud.
- .impeccable/review/settings-iteration-5/after/edit-light.png — Edit Work projects.
- .impeccable/review/integrations-composition/after/overview-dark.png — current approved overview structure.
- .impeccable/review/integrations-composition/after/manage-gitlab.png — approved Manage structure.
- Earlier iteration overview/Manage screenshots were also inspected as historical comparison, not treated as current overview authority.

The form images predate the latest overview composition. They establish the actual rendered duplicated introduction and missing identity treatment; current source independently confirms those structures remain. They do not establish present runtime behavior, narrow-form layout, focus restoration, error recovery, or numerical contrast. No claim of completed functional QA or WCAG conformance is made.

## Prioritized verified findings

### P2 — Connect/Edit uses an extra overview heading that Manage already removes

Evidence: all four rendered form examples start with Integrations + “Manage connections to your developer tools,” followed by Back, then Connect/Edit. Manage begins directly with navigation and its connection identity. Current integrations.css:361 hides .settings-pane-head for data-view=connection/provider only; IntegrationsSection.tsx:326 sets data-view=form during editing. SettingsModal.tsx:306–308 constructs the global saved count, and :405–413 renders it within the generic pane head.

Impact: entering Edit from Manage reintroduces a broad section introduction above the actual task, shifting the navigation and task identity downward. The global count describes the overview rather than the active form. This costs vertical room and makes sibling subpages feel structurally different, especially in the taller Jira flow. It does not block completion.

Small fix: make the entire generic pane head, including description and count, visible only on the Integrations overview. Keep the existing Back labels and callbacks. Maintain the tabpanel's existing accessible label; removing the visible generic head does not require removing the Integrations navigation context.

Suggested command if implementation is authorized: /impeccable polish, tightly scoped to subpage hierarchy.

### P2 — Form title and identity lag behind the established subpage convention

Evidence: IntegrationConnectionForm.tsx:112–113 labels the form using a bare h3 (“Connect GitHub/GitLab/Jira” or “Edit Work projects”). It has no provider identity header. IntegrationConnectionDetails.tsx:44–51 uses the provider glyph, an h2 connection title, and “GitLab · Saved connection.” IntegrationsSection.tsx:356 also uses h2 for the provider collection. Current CSS at :395 gives the form title roughly the same visual size as the Manage title despite the different heading level.

Impact: Connect names its provider in text, so provider recognition is already adequate there. Edit titles use a user-defined connection name and lack the explicit provider context that Manage provides; the provider must be inferred from fields. Once the generic introduction is removed, retaining h3 would also leave the task below its intended semantic level.

Small fix: use h2 for the existing task title, preserve its id and the form's aria-labelledby, and wrap it in the existing style of provider identity header (decorative def.Glyph with aria-hidden, identity text, concise provider label). Retain “Edit <connection name>”; the connection title is useful context. Avoid redundant generic descriptions or extra state badges. Use wrapping behavior consistent with .ig-managed-identity/.ig-managed-title for long names.

This is a consistency and recognition improvement, not evidence of a present WCAG failure: h3 currently follows a visible h2. A semantic promotion alone will not resolve the visible identity mismatch.

Suggested command if implementation is authorized: /impeccable polish, retaining existing identity tokens and geometry.

No P0/P1 issue was established by this bounded design assessment. Exactly two priority findings; no additional cosmetic backlog is warranted.

## Nielsen heuristic scores

Scale: 0 poor/absent → 4 excellent. Scores describe this limited design evidence; n/a means not assessed here, not inapplicable to the product. No full-app health score is implied.

| # | Heuristic | Score / 4 | Evidence / limitation |
|---|---|---|---|
| 1 | Visibility of system status | n/a | Async/loading/success feedback was not exercised. |
| 2 | Match between system and real world | 3 | Provider names, deployment choices, host/account facts, and credential wording are concrete and understandable to the intended developer audience. |
| 3 | User control and freedom | n/a | Back and Cancel are visible; their behavior and unsaved-change exits were not exercised. |
| 4 | Consistency and standards | 2 | Manage/collection establishes the focused subpage convention; Connect/Edit retains overview chrome and a different identity structure. |
| 5 | Error prevention | n/a | Token retention hint is visible in Edit; prevention behavior was not exercised. |
| 6 | Recognition rather than recall | 3 | Explicit labels and provider mode choices help recognition; Edit requires more inference about provider than Manage. |
| 7 | Flexibility and efficiency | n/a | Keyboard, focus, shortcut, and repeat-use behavior were not exercised. |
| 8 | Aesthetic and minimalist design | 3 | Calm, aligned, task-focused controls; duplicate generic introduction is the remaining avoidable hierarchy cost. |
| 9 | Help users recognize, diagnose, and recover from errors | n/a | Error and retry flows were not exercised. |
| 10 | Help and documentation | 3 | Provider-specific token-help disclosure and GitLab/Jira URL hints are visible. Link destinations and guidance completeness were not verified. |
| | Scored subset | 14/20 | Five heuristics scored; five unassessed. Not comparable with a full /40 critique. |

## Strengths to preserve

1. Manage already provides the right hierarchy: contextual Back/Add navigation, provider/connection identity, readable facts, then routine and destructive actions. It supplies the reference pattern without redesign.
2. The approved overview uses one clear provider entry and one contextual action per row; its section heading and global count make sense at that level.
3. Forms already reveal relevant deployment fields and keep token guidance collapsible. Edit explicitly explains that a blank token retains the saved secret. These details reduce uncertainty without adding permanent clutter.

## Cognitive load, emotional journey, and persona observations

Cognitive load is low overall. The duplicated introduction is one clear hierarchy failure on the eight-item checklist. No task decision with more than four visible choices was established: GitLab/Jira deployment switches each have two alternatives, and persistent Settings navigation is not a single task decision. Jira's additional email/URL fields reflect real provider requirements; removing them or splitting the flow is unsupported.

For a first-time connector, provider labels and token help provide reassurance; the extra Integrations introduction postpones the task identity. For someone editing several similarly named connections, the missing explicit provider identity is the meaningful recall burden. For a heading-navigation user, parity between form and Manage titles will make sibling task pages easier to understand after the generic head is removed. Actual screen-reader output remains untested.

The likely emotional valley is credential entry. Existing local-storage wording and retained-token hint help. The tiny fix should improve orientation without introducing new decisions. Success, failure, and cancellation endpoints need the parent's runtime QA before an end-to-end journey judgment.

## Scope-appropriate handoff and functional checks

Accept the proposed tiny change, with these verification targets for the parent after any implementation:

- Overview keeps the approved heading, description, count, row geometry, and buttons.
- Connect GitHub/GitLab/Jira and Edit show navigation followed by one h2 task identity and provider context; provider collection and Manage remain visually consistent.
- Form aria-labelledby continues to resolve to the task title. Decorative glyphs do not duplicate the accessible name.
- Back/Cancel, unsaved-change guards, deployment selection, retained-secret edits, error focus, and submit/busy behavior remain correct using the safe fixtures in scripts/verify-settings-integrations.mjs.
- Check long Edit names, GitLab self-managed, Jira Cloud/Server, 390/320px, short height, large text, and representative dark/light themes. The new header must wrap without crowding navigation or pushing fields outside the scrollable pane.
- Ensure generic-header suppression remains correct for a provider/connection that disappears while a form is open, so its existing fallback status/exit remains discoverable.

These are required validation targets, not reported test passes. No button changes, Manage restyling, new components beyond the needed identity markup, detector run, or broader polish is recommended.

Questions skipped: two priority issues; scope and proposed direction are already explicit. This is an independent assessment handoff to the parent.
