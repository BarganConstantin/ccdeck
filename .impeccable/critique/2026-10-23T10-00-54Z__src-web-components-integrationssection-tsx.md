---
target: Integrations iteration 3
total_score: 30
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 0
timestamp: 2026-10-23T10-00-54Z
slug: src-web-components-integrationssection-tsx
---
⚠️ DEGRADED: single-context (no sub-agent tool exposed).

# Integrations, iteration 3: compact native settings

Baseline: 5aefd0bc. Mode: Operate. Preserve the existing Settings shell.

The overview has a coherent visual language and focused forms, but Test, Edit,
Disconnect and Add connection compete with the host/account information. A
connection list should answer what is configured before presenting maintenance
commands. The security paragraph below Jira appears attached to that provider.

Strengths: searchable provider groups; no nested cards or extra sidebar;
shared credential forms and capability filtering; explicit historical verification;
modal focus/dirty guards and deliberate two-press deletion.

Heuristic assessment, 0–4 (subjective design judgment):

| Heuristic | Score |
| --- | --- |
| Status visibility | 3 |
| Real-world language | 3 |
| User control | 3 |
| Consistency | 3 |
| Error prevention | 3 |
| Recognition | 3 |
| Efficiency | 3 |
| Minimalism | 3 |
| Error recovery | 3 |
| Help | 3 |
| Total | 30/40 |

P2 priorities: replace maintenance commands with per-connection Manage; condense
provider metadata without fabricating health; group common access/token help
above the provider list. Apply layout, distill/clarify and polish inside Integrations.

Expert persona: wants fewer competing commands while scanning instances.
First-time persona: must distinguish saved configuration from historical proof.
Keyboard persona: needs predictable Back/Escape and return focus at every level.

The chosen trade-off is one additional click for maintenance/additional accounts,
with no connection picker for the common single-account case. Each saved
connection has its own Manage action, named with provider, connection and account.

Source detector and layout scan returned [] before implementation. The final
browser audit confirmed one intentional shared-modal shadow finding and two
line-length findings on hidden, retained token-help content. Neither was treated
as a reason to change the approved shell or delete security instructions.

Questions skipped: the owner explicitly selected Variant 1 and authorized implementation.
