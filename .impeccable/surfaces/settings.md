# Settings

Mode: Operate. Preserve the established ccdeck instrument panel.

Settings is one stable dialog with a section navigation, a search field, and an
independently scrolling content pane. Keep the existing shared SettingsGroup and
SettingRow shapes, immediate preferences, theme tokens, and keyboard shortcuts.

Integrations remains one navigation entry. GitHub, GitLab, and Jira are compact
provider sections inside it, each showing its saved connections and a contextual
Connect/Add connection action. Connect forms expand in place. Long token setup
instructions use a native disclosure, and existing host-specific fields remain.
Providers that the server cannot offer must not gain working Connect actions or
search destinations; stranded saved connections retain Disconnect.

Saved connection counts describe configuration, not continuous health. Keep
account/host facts and backend verification timestamps honest. Never populate a
saved credential into a form or place it in a client-side connection object.

A single request owns the section while pending. Competing controls and editable
fields reflect that state, the active action remains focusable, and the handler
also guards repeat requests. Cancellation and completion restore keyboard focus
to a useful action. Disconnect keeps the existing two-press confirmation guard.

The navigation becomes horizontal at 640px; its ARIA orientation follows its
rendering. Preserve search jumps, the modal's focus trap, Escape, and focus return.

Evidence and verification for the first iteration:
[Settings review](../review/settings-integrations/README.md).
