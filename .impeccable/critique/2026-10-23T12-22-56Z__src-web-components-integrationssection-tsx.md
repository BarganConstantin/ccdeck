---
target: Integrations composition regression
total_score: 27
max_score: 40
p0_count: 0
p1_count: 2
timestamp: 2026-10-23T12-22-56Z
slug: src-web-components-integrationssection-tsx
---
Method: dual-agent (A: 01a168a2-1747-74d1-b6a6-3275a8333f69 · B: 01a168a2-17cd-7313-86b4-26fec5a8d7ac)

# Integrations overview composition regression

Baseline 7681e6de. Mode Operate. The latest user brief supersedes the previous
surface instruction allowing Add in overview. This is a composition correction,
not a replacement design language.

Independent A inspected real native-browser views, source and same-HEAD fixture
screenshots. Nielsen /4: status 3, real-world match 3, control/freedom 3,
consistency 2, error prevention 3, recognition 3, efficiency 2, minimalism 2,
recovery 3, help 3 = 27/40. A closed its owned page. B's static general/layout
scans returned []; its native tools failed before injection. Fresh isolated
Chromium fixtures captured before overview, multi, Manage, General and Connect;
zero connection mutations/page errors. Parent's native retry also timed out;
its identified owned page was subsequently closed and the remaining tab list
checked. No native overlay or clean whole-application detector result is claimed.

P1: provider-level Add and per-connection Manage form two independently composed
right-hand action rows. This creates five actions for three providers, with Add
first, and is a direct violation of the owner's final brief. Remove overview Add.
P1: mapping connection rows in overview scales actions/content by accounts,
not providers. Keep one provider summary/action. One saved connection opens its
existing details directly; multiple connections open a focused labelled list
with alias, instance and account, without silently selecting the first.
P2: empty and saved providers follow different reading paths. Use glyph | text
stack | one vertically centred action and one shared intrinsic action column.
P2: Connect has neutral styling despite existing primary form convention.
Use existing .btn.primary; Manage remains neutral with existing account-control
fill, shared height/radius/padding, clear hover/focus and no new palette.
P2: saved total appears to belong to security disclosure. Move it into the
Integrations heading action slot; keep the secondary disclosure alone below.

Preserve native shell/sidebar, provider glyphs, facts, historical verification,
focused forms, secret preservation, capability checks and safe removal. The extra
selection step is only for multi-connection providers and makes account choice
explicit. Add lives in provider management, not on overview. Existing unknown
provider cleanup remains supported. No backend, API, dependencies or releases.

Layout thesis: provider identity first, instance/count second, account and
historical metadata third, one contextual action at the right. Shared action
column aligns widths without fixing row heights; wrapping controls content height.
Three choices remain clear for expert, newcomer and keyboard personas. Existing
Back, cancellation and readable removal consequences preserve reassurance.

Mechanical scans did not detect the action-scope regression. Visual review and
source-to-task reasoning drive the fix, not an automated aesthetic score.
A later source audit caught CSS specificity preventing the intended neutral fill;
the corrective batch fixes the scoped rule and verifies actual computed controls.

Questions skipped: the owner explicitly chose one action per provider and
creation inside management. Routine approval is unnecessary.
