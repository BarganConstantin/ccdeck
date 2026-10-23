# Settings

Mode: Operate. Preserve the established ccdeck instrument panel.

Settings is one stable dialog with ten searchable subjects and an independently
scrolling content pane. Keep immediate preferences and the existing theme system.
The sidebar's selected section uses a quiet fill and text weight; pointer hover
and selection have no border. Preserve the keyboard-only focus ring. About
follows the other subjects rather than standing alone at the bottom.

Integrations stays one navigation entry with one compact row per registered
provider. The text stack reads provider → host or saved count → account and
historical metadata. One contextual action only: empty providers Connect with
the shared primary treatment; saved providers Manage with the existing neutral
control fill. Never put Add above or beside Manage on overview. Shared intrinsic
grid columns align all action widths; rows grow naturally with wrapped content.
Saved totals belong beside the Integrations heading. The access/token disclosure
is secondary below the complete list, separate from provider and count metadata.

Manage opens a focused connection detail view in the existing pane. The generic
Integrations introduction is hidden only here; the selected name or instance URL
is its h2. Keep full endpoint (scheme and path), account, known provider/server
metadata, historical verification and saved-token state. Facts remain two columns
on desktop with labels above values, one column on narrow screens.

Add connection exists only inside provider management. One saved connection
opens details directly. Multiple saved connections open a focused labelled list
of aliases, hosts and accounts with an explicit per-connection Manage action;
never silently select the first account. Back from details returns to that list
and its trigger; Back from the list returns to the overview provider action.
The list and detail toolbar retain a provider-named Add shortcut. Shared 30px,
6px-corner buttons retain normal hover, keyboard focus and disabled/busy states.

Remove connection is final and uses the existing outlined danger control. Keep
the two-press 400ms guard. An engaged confirmation has no reading deadline;
leaving its focus group, changing window/task or pressing Cancel disarms it.
Explicit Cancel restores focus; a four-second timer is only an unfocused safety
fallback. Test/Edit/Add clear an armed decision. Deletion errors belong beside
removal. Removing from a multi-connection list focuses the remaining account;
removing its last connection returns to overview Connect or the section tab.

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

- [Composition regression correction](../review/integrations-composition/README.md)
