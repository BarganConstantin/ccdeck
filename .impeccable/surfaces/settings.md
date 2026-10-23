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

Manage opens a focused connection detail view in the existing pane. The generic
Integrations introduction is hidden only here; the selected name or instance URL
is its h2. Keep full endpoint (scheme and path), account, known provider/server
metadata, historical verification and saved-token state. Facts remain two columns
on desktop with labels above values, one column on narrow screens.

Provider-level Add connection is direct in the overview provider heading. A
provider-named shortcut beside All integrations preserves the one-click path from
Manage, outside the selected identity. Focus enters the selected heading, then
Test/Edit, using shared 30px / --r-ctl controls rather than a local pill variant.
Remove connection is final and uses the existing outlined danger control. Keep
the two-press 400ms guard. An engaged confirmation has no reading deadline;
leaving its focus group, changing window/task or pressing Cancel disarms it.
Explicit Cancel restores focus; a four-second timer is only an unfocused safety
fallback. Test/Edit/Add clear an armed decision.
Deletion errors belong beside removal, not above ordinary management actions.
Per-connection Manage avoids a separate account picker; multiple saved accounts
remain individually named and directly reachable.

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

- [Iteration 5](../review/settings-iteration-5/README.md)
