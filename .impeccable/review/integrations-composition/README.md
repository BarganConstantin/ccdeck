# Integrations — composition and button regression correction

Baseline `7681e6de`. The prior overview is **not visually approved**. This change
fixes its composition while preserving the approved Settings architecture and
connection-management capabilities. It is a local candidate for human review.

Modified source: `IntegrationsSection.tsx`, `SettingsModal.tsx`, `integrations.css`;
three relevant test files and the browser verifier updated. No backend changes.

## Root cause and implemented composition

The previous change placed provider-level Add in a heading row and per-connection
Manage in another row below it. These were separate DOM/action rows, not a minor
spacing defect: three providers exposed five actions, increasing with accounts.
The correction removes overview Add and composes each provider as:
**glyph | provider/instance/metadata text stack | one contextual action**.

- Empty GitHub has one **Connect**, using the existing primary variant.
- Saved GitLab/Jira have one **Manage ›**, using the established neutral fill.
- A shared intrinsic grid action column gives controls equal widths without an
  arbitrary fixed width; content determines row height. Long values wrap.
- One connection opens its existing details directly. Multiple connections open
  a focused provider list with aliases, hosts, accounts and per-connection Manage.
  No account is silently selected. Back restores list or overview context/focus.
- **Add connection remains inside management**, available from the provider list
  and the selected connection toolbar. Creating returns to overview and focuses
  its provider Manage; cancelling returns to the originating toolbar.
- Saved count moves beside the Integrations heading, outside the security footer.
  Existing disclosure wording was checked against local store/response behavior;
  no security claim, credential persistence or API contract changed.

## Actual Impeccable work

Used installed **4.1.1** critique, layout, distill, polish and accessibility audit
playbooks, with two independent assessments. No reinstall, fictitious commands,
new context bootstrap, replacement design world or global style refactor.

Assessment A's baseline score was **27/40** (subjective Nielsen assessment).
Its priorities were competing actions (P1), connection-scaled overview (P1),
inconsistent reading path (P2), missing primary Connect emphasis (P2) and count
associated with security (P2). Source/layout scans returned `[]` and did not
catch this composition defect; actual rendered review drove the correction.

Layout established one shared reading/action path. Distill removed overview
creation commands and account-level rows. Polish reused real CCDeck controls;
audit checked the actual cascade and found an initially ineffective neutral-fill
rule. The corrective batch scopes that rule correctly, excludes primary and
verifies the computed controls and contrast. No whole-app clean-audit claim.

Native-browser navigation/injection timed out in this turn. The parent's created
isolated page was identified and closed; the remaining page list was checked.
Actual visual evidence comes from isolated Playwright Chromium against the
running application, with safe provider/preference fixtures, plus manual opening
and inspection of the screenshots. No mockups or real credential mutations.

## Existing button conventions and comparisons

| Convention | Existing source/pattern | Applied here |
| --- | --- | --- |
| Height | `--ctl-h: 30px`, shared `button.btn` | Same token, no fixed provider-row height |
| Radius/padding | `--r-ctl: 6px`, shared horizontal 12px padding | Preserved; no pill variant |
| Typography | Shared 12px + app text scaling; existing UI emphasis weight 500 | Same family/scale; provider contextual actions use 500 |
| Primary | Form Connect/Save `btn primary`, `--accent-dim` wash and `--accent` boundary | Overview Connect uses this existing variant |
| Neutral | Account management `--ctl-fill`, `--ctl-edge`, `--text` | Manage uses these tokens with shared desktop geometry |
| Hover/focus | Foreground edge, normal neutral hover, global visible focus ring | Preserved; scoped primary hover restores foreground edge feedback |
| Disabled/loading | Existing `--dim-off`, native disabled, busy/aria-disabled and handler guard | Preserved |

Compared actual rendered **General Settings Open controls** and the **GitHub
Connect form/footer**, not only CSS. The account panel supplies the existing
filled-neutral convention, not its smaller 24px/10px geometry. No gradients,
shadows, hardcoded palette, changed global radius or new button component.

[General Settings reference](references/general-buttons.png) ·
[Connect form reference](references/connect-form.png).

## Actual screenshots

Safe fixture screenshots of the real application. Before captures were locked
before editing. Stress states include multiple aliases and long host/account data.

| Required view | Evidence |
| --- | --- |
| Overview before/after | [Before](before/overview-dark.png), [After](after/overview-dark.png) |
| Connect hover | [Hover](after/connect-hover.png) |
| Manage hover and keyboard focus | [Hover](after/manage-hover.png), [Focus](after/manage-focus.png) |
| GitLab Manage with Add | [Manage](after/manage-gitlab.png) |
| Multiple connections | [Overview](after/multiple-overview.png), [Provider list](after/multiple-list.png) |
| Narrow viewport | [390px](after/overview-390.png), [320px](after/overview-320.png) |
| Light theme | [Overview](after/overview-light.png) |
| Available themes | [Theme gallery](themes/README.md) |

## Validation and boundaries

- **678 tests passed / 43 files**: integration behavior, persistence/security,
  Settings navigation/search, keyboard/modal focus and contrast/control coverage.
- **112 focused contrast tests passed** after the final scoped CSS fixes.
  The matrix includes neutral action fill and primary hover, across the existing
  theme palettes. These 112 are a recheck, not an additional unique-test count.
- Typecheck passed; production build passed. Existing >500kB chunk warning
  remains. Final whitespace check passed.
- Initial tests caught the legacy creation search anchor and old per-connection
  unavailable-provider assertions. The static anchor was restored; capability
  tests now verify the requested provider-level path. Creation/configuration
  remains restricted to offered kinds; saved unavailable providers stay removable.
- All **six functional cases passed**: 1440×1000 dark/light, 900×760,
  900×540, 390×844 and 320×740. One account opens directly; multiple accounts
  use explicit selection with contextual Add/Cancel/Back and deletion focus.
  Existing credential preservation, validation, failed Test/removal, delayed
  repeated-request guards, confirmation reading/cancellation and modal keyboard
  behavior passed.
- **110 axe reports: zero violations** in the exercised states, with WCAG 2 A/AA,
  2.1 AA and 2.2 AA tags. This is scoped automated coverage, not certification.
- Final desktop dark/light settled-style checks passed **14 samples**, with
  no running animations or API mutations. Final read-only evidence verifies
  resting fill, hover, keyboard focus and Connect→Manage transitions.
- Raw functional results retain the genuine pre-fix dark transparent-fill
  diagnostics. The earlier refresh also retains intermediate transition-frame
  color samples. They were not edited away: [final settled-style evidence](final-style-evidence.json)
  supersedes those style samples. The finite-animation wait prevents treating
  an interpolation frame as a final color. No product transitions were disabled.

[Functional run history](browser-results.json) · [Final settled styles](final-style-evidence.json) ·
[Accessibility reports](accessibility-results.json) · [Accessibility audit](audit.md).

No live authentication, manual VoiceOver/NVDA, Electron/OS/browser matrix or
profiling. The compact desktop target is preserved. Fixtures establish frontend
flows, not live service health. Connection persistence, tokens, provider-specific
forms, Test/Edit/Disconnect confirmation and request guards are retained.

Branch `work/2026-10-23-changes`; exact local commit is in the handoff.
Live: http://127.0.0.1:5186. No push, merge, release, tag, publish or deploy.
Stop for human design review.

Questions skipped: one provider row/one action and Add inside Manage are explicit.
