# Assessment B — mechanical baseline

Repository: /Users/constantin/Desktop/ccdeck-work
Branch: work/2026-10-23-changes
HEAD: 3d5bf3785166a517b4c07cad2b171253da80d407
Read-only source assessment; worktree clean before and after. No bootstrap, installs, build, commits, push, backend edits, or real API mutations. No other assessment consumed.

## Detector

Command: node /Users/constantin/.claude/skills/impeccable/scripts/detect.mjs --json src/web/components/IntegrationsSection.tsx src/web/components/IntegrationConnectionForm.tsx src/web/components/IntegrationConnectionDetails.tsx

Result: [] (0 findings, 0 rule locations). Saved as detector-before.json. TSX inputs only; no CSS/markup scan or URL detector. This is not an accessibility certification.

## Fresh rendered baseline

Native browser tool unavailable in this tool set; no native preflight or injection attempted, and no native success claimed. Isolated external Playwright Chromium used against http://127.0.0.1:5186, navigation/action timeouts 5 seconds. Existing verifier connection/provider factories reused; full verifier not run.

Four screenshots in before/: Connect GitHub and Edit GitLab at 1440x1000 Rider Black and 390x844 light. Screenshots are Settings-modal crops; names describe viewport dimensions. baseline-browser.json records measurements and checks.

All 4 scans: 0 axe WCAG A/AA violations; 0 measured pane/form overflow; 0 page errors. Initial focus reaches Personal access token, with visible 2px accent outline. Edit Cancel returns focus to Edit connection in both viewports. No form submitted. Browser and owned contexts closed; no personal tabs touched.

Contrast incomplete results remain: desktop Connect 1 node, desktop Edit 1, mobile Connect 5, mobile Edit 6. Zero violations does not mean all contrast passed. Full results identify incompletes by rule; resolving their individual selectors requires a targeted follow-up rather than claiming AA compliance.

All non-GET/HEAD network calls were intercepted locally. Incidental /api/feature, /api/presence and /api/forget POSTs were blocked. Integration reads and preference reads were fulfilled with fixtures. No integration writes requested; real server persistence intentionally untested.

## Mechanical findings and risks

Confirmed issue count: P0 0; P1 0; P2 1; P3 0. No confirmed blocking accessibility or persistence failure.

[P2] Mobile input text is 12px (both fresh 390px forms). IntegrationConnectionForm.tsx:139,159 inherits .ap-manage-input font sizing from src/web/styles/accounts-manage.css:293. iOS Safari commonly zooms focused fields below 16px; this is a platform risk, not reproduced on Safari. Consider a narrow input-only mobile adjustment in a separate authorized pass; preserve approved buttons/rows. Suggested playbook: impeccable harden/adapt.

Measured controls are 30px high and token-help summary 26px. These are below the skill's 44px ergonomic target, but above the 24px WCAG 2.2 AA size floor; do not call them an automatic AA failure. Radio inputs measure 1x1 because their labels are the visible interactive targets (dialogs.css); do not report raw input geometry as a target-size failure.

## Source evidence to preserve

- IntegrationConnectionForm.tsx:111-119: form name associated to H3; labels and hints tied to generated IDs; field errors set aria-invalid, descriptions and alert roles. Focus handling at :92-102. Choice fieldset errors have no aria-describedby, but general alert fallback still renders; no current failure reproduced.
- tokens.css:372 and accounts-manage.css:297: explicit accent focus rings; dialogs.css:300 covers radio-label focus.
- integrations.css:389-406: min-width:0, wrapping titles and facts, responsive fact columns and semantic token colors. No static detector scan run on these styles.
- IntegrationsSection.tsx:103-109: synchronous busyRef prevents duplicate mutations. :233-251 protects unsaved changes and restores focus; :189-197 restores after state commits.
- IntegrationConnectionForm.tsx:66-75: submission trims values and clears only secrets immediately, while retaining nonsecret fields; loss of a typed token on refusal is intentional secret handling, not evidence of broken persistence. Busy fields disabled and error focus restored.
- src/server/integrations/routes.mjs:187-194: blank edit token keeps existing secret. :425-446 validates changed credentials before update. Source inspection only; disk persistence/provider success not exercised.

## Hierarchy baseline (mechanical only)

Both forms currently expose H2 Integrations then H3 Connect/Edit; the shared pane introduction and count stay visible in form mode. Manage/provider modes suppress that pane header via integrations.css:360. This is a measurable state difference, not a semantic heading skip or an axe failure. Leave design judgment to Assessment A and the owner's narrow consistency fix.

No performance score or overall /20 supplied: bundle/runtime profiling, 320px, Safari, full keyboard traversal, forced error/disconnect flows and real persistence are outside this deliberately small baseline. Follow the tiny fix with focused fixture QA; preserve approved overview rows/buttons and Manage details.
