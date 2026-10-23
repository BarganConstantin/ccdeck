---
score: 14
maxScore: 20
p0: 0
p1: 0
p2: 3
unassessed: 5
timestamp: 2026-10-23T13-03-15Z
slug: src-web-components-integrationconnectionform-tsx
---
# Integrations consistency — synthesized critique

Scope: narrow consistency repair; preserve the approved provider overview, buttons and Manage details. Two independent assessments were read separately before synthesis: Pascal (01a168c8-80bf-7252-8937-dc1f153f7133) and Arendt (01a168c8-8193-7c30-aad6-f93cac8cf159). See review/integrations-consistency/evidence for complete independent evidence.

1. P2, consistency: generic Integrations introduction and global count return on Connect/Edit, although Manage already suppresses them. Restrict that introduction to overview.
2. P2, recognition: bare h3 form heading omits the provider identity on Edit. Reuse existing glyph/header structure with one contextual h2 and provider subtitle for Edit.
3. P2, keyboard status: Enter from an input that becomes disabled loses focus to BODY while Checking. Reproduced against delayed safe fixtures; focus the surviving submit action before submitting. After correction one request and focused Checking are retained.

No P0/P1 confirmed. Assessment A scored only five heuristics,14/20; five were unassessed. This is not a full /40 score or an after-score. Both before/after detectors returned zero; detector silence does not cover these UX defects.

Keep existing deployment fields, local credential handling, token preservation, Back/Cancel semantics and approved visual language. All three fixes verified with actual browser captures, functional fixtures and semantic tests. Final audit retains contrast incompletes and native/screen-reader/provider-auth limitations; no WCAG certification.
