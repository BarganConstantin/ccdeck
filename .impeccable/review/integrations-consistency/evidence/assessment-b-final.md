# Assessment B — final mechanical audit / harden

Owned changes: src/web/__tests__/integrations-settings.test.ts and NEW scripts/verify-integration-form-variants.mjs only. Parent owns the form/CSS patch; Assessment A owns the full management verifier. No commits, installs, real API mutations or backend edits.

## Validation

- Owned unit command: npm test -- src/web/__tests__/integrations-settings.test.ts — 15/15 passed (six new semantic cases, three Connect + three Edit). Checks heading level/name and aria-labelledby, decorative glyph, Edit provider identity, and empty saved password semantics; no source CSS checks.
- node --check scripts/verify-integration-form-variants.mjs and git diff --check for the owned unit file passed.
- New verifier: 9/9 cases passed. Full five provider/deployment variants at desktop dark; GitHub desktop light; Jira Cloud 390x844 light; GitLab self-managed 320x740 dark; Jira Server/Data Center 900x540 dark. Targeted Jira Edit covers saved-token retention flag and switching deployment with new credentials.
- Each Connect variant checks missing/invalid credential 400 field alerts, aria-invalid/describedby, focus to refused field, cleared credentials, retained URL/name, matching POST provider/deployment payload, two-second Checking focus and visibility, and one request despite repeated Enter. Jira Cloud additionally checks missing email. Email stays type=email with username autocomplete from existing registry; tokens stay password inputs.
- Blank Jira edit sends empty token with existing deployment and retains tokenSaved in the fixture. Changing deployment marks token/email required, clears saved-token placeholder, receives a missing-token refusal, then accepts fresh fixture credentials. This proves UI/payload behavior against fixtures, not real provider authentication or on-disk persistence.
- 32 simulated integration requests; all unrelated non-GET requests blocked locally. No raw credentials, payloads, HTML, or response bodies written to reports. Screenshots contain masked/empty token fields.
- Script initially needed two harness corrections: use native disabled property rather than Playwright isDisabled (which treats aria-disabled as disabled), and click visible radio labels rather than hidden inputs. GitHub/GitLab.com passing cases were retained on resume; no product issue attributed to those harness failures.

## Final read-only findings

- Source diff reviewed: overview-only generic heading/count; one provider-specific H2 with same aria ID and decorative glyph; Edit subtitle only; focus submit before onSubmit. Secret clearing, field types, registry definitions and server APIs remain unchanged.
- Detector BEFORE [] / AFTER [] across IntegrationsSection.tsx, IntegrationConnectionForm.tsx and IntegrationConnectionDetails.tsx. Final detector ran once; no CSS/markup detector scan. No detector rule locations because count is zero.
- Confirmed new P0/P1/P2/P3 issues: 0/0/0/0 within this bounded scope. Existing 12px desktop-tool input scale remains intentional; Safari automatic zoom is unverified, not a reproduced defect and no global font change is proposed.
- Axe: 10 main scans, zero violations. Incomplete rule is color-contrast, with per-state targets/counts in audit-final.json. Four additional read-only renders collect detailed failureSummary and computed colors; those exact raw follow-up results are preserved separately, rather than replacing original scan counts.

## Contrast interpretation

The engine reports overlapping elements for subtitle/help/hints/radio text and partially obscured elements for horizontal navigation labels. Those are incomplete checks, not confirmed violations. Existing computed foreground/surface evidence:

| Target | Theme | Calculated ratio |
|---|---|---|
| Edit provider subtitle | Rider Black | 6.94:1 |
| Token-help summary | Rider Black / light | 6.10:1 / 5.93:1 |
| URL hint | Rider Black / light | 5.28:1 / 7.87:1 |
| Jira choice text | Light (composited control fill) | 10.21:1 |
| Clipped Notifications/Radar labels | Light (base surface) | 7.87:1 |

These text/surface pairs support readability without restyling. They do not resolve the pixels at partially clipped navigation edges. Keep those selectors recorded as incomplete/manual-review context; no AA certification is claimed. The follow-up can return slightly different incomplete counts as layout/scroll context changes (e.g. radio text); original and follow-up evidence are both retained.

## Artifacts / limits

- variants/results.json: original 9-case functional run and 19 screenshots (Connect/error for each sample plus Jira Edit).
- variants/contrast/results.json: IDs, targets, counts, safe failureSummary strings, rendered foreground/background evidence; four read-only follow-up screenshots, zero fixture writes.
- variants/audit-final.json: consolidated counts, original selectors, full contrast follow-up, calculated ratios and limitations.
- detector-before.json and detector-after.json: both [].
- Native browser unavailable; existing external Playwright Chromium used in isolated contexts, navigation capped at five seconds. Owned browser contexts closed; user pages preserved.
- No Safari, real provider auth, disk persistence, performance profiling, full-management/disconnect rerun or complete screen-reader certification. Parent handles full suite/build/typecheck; Assessment A handles six main flows.
