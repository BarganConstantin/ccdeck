# Settings

Mode: Operate. Preserve the established ccdeck instrument panel.

Settings is one stable dialog with ten searchable subjects and an independently
scrolling content pane. Keep immediate preferences and the existing theme system.
The sidebar's selected section uses a quiet fill and text weight; pointer hover
and selection have no border. Preserve the keyboard-only focus ring. About
follows the other subjects rather than standing alone at the bottom.

Integrations stays one navigation entry with a compact provider list. An
unconfigured provider offers Connect; each saved connection offers Manage.
Show host/account and concise historical metadata, with no live-health badge.
Aliases distinguish multiple connections. The common access/token disclosure
belongs in a separate footer below the complete provider list, never inside a
provider entry. Counts describe saved connections.

Manage opens a focused connection detail view in the existing pane. Keep full
name, host, account, server information, last verification and saved-token state.
The connection name (or instance URL) heads Manage, with provider and Saved
connection secondary. Test/Edit are neutral rounded controls. Manage facts use two columns on desktop
with labels above values, one column on narrow screens. Add connection sits
discreetly in the identity header. Remove connection is the final area, with a
neutral outlined control that becomes destructive when armed, preserving the
two-press safety guard. Per-connection Manage avoids a separate account picker.
Additional connections deliberately cost Manage → Add connection.

Connect saves back to the overview; Edit saves/cancels back to its selected
connection. Back/Escape go up one level before closing Settings. Search, dirty
confirmation and modal focus still use the shared mechanisms. Restore focus
only after the target view and request state have committed, not merely after
an animation frame. Overview scroll position is retained on return.

Saved counts describe configuration, not health. Verification uses only valid
backend checkedAt evidence; absent time stays explicitly unknown. Never populate
saved secrets into forms or connection objects. Unavailable providers remain
manageable for Disconnect but offer no unusable Test/Edit/Add actions.

General uses concise notes with complete technical explanations in native
Details disclosures. Keep essential warnings visible. Place the disclosure
outside the setting's label so label activation and keyboard behavior survive.
Content remains opaque at scroll boundaries, with stable gutters and padding.

Evidence:
- [Iteration 1](../review/settings-integrations/README.md)
- [Iteration 2](../review/settings-iteration-2/README.md)

- [Iteration 3](../review/settings-iteration-3/README.md)

- [Iteration 4](../review/settings-iteration-4/README.md)
