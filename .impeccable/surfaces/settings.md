# Settings

Mode: Operate. Preserve the established ccdeck instrument panel.

Settings is one stable dialog with ten searchable subjects and an independently
scrolling content pane. Keep immediate preferences and the existing theme system.
The sidebar's selected section uses a quiet fill and text weight; pointer hover
and selection have no border. Preserve the keyboard-only focus ring. About
follows the other subjects rather than standing alone at the bottom.

Integrations stays one navigation entry. GitHub, GitLab, and Jira each present
provider identity, saved connection count, instance/account, historical
verification, and contextual actions. Connections are plain rows rather than
nested cards. Desktop actions use the right side of the same row; below 640px
they follow the account details. Long names and hosts wrap.

Connect/Add connection/Edit open a focused view inside the same Settings pane.
All integrations returns to the overview; completion/cancellation restores a
useful focus target and overview scroll position. Search can hide a draft
without losing it. Navigation, result selection and dismissal guard unsaved
changes with an inline choice, never a second modal. The shared modal mechanism
owns Escape: back from configuration, close from overview, keep editing from an
unsaved-change confirmation. Pending requests finish or reach the existing
timeout before navigation proceeds.

Saved counts describe configuration, not health. Last verified refers only to
backend-provided checkedAt evidence; no timestamp means no invented assertion.
Never populate saved secrets into forms or place them in connection objects.
Unavailable providers cannot gain Connect/Edit/Test actions, but saved stranded
connections retain Disconnect and its two-press guard.

General uses concise notes with complete technical explanations in native
Details disclosures. Keep essential warnings visible. Place the disclosure
outside the setting's label so label activation and keyboard behavior survive.
Content remains opaque at scroll boundaries, with stable gutters and padding.

Evidence:
- [Iteration 1](../review/settings-integrations/README.md)
- [Iteration 2](../review/settings-iteration-2/README.md)
