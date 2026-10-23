# Explore integrations

Explore is a compact, read-only catalog of project tools. It extends ccdeck's
existing interface; Settings owns connections and the existing provider panels
own browsing work.

## Entry and actions

- Desktop: the permanent plug action, **Explore integrations**, forms the bottom
  group of the left rail, after the existing controls and connected providers.
  It remains available with no connections. It participates in the same roving
  toolbar: one Tab stop, Up/Down, Home and End.
- At the existing 640px mobile boundary, **Explore integrations** is a named
  entry in the existing **More** menu, alongside its other actions.
- Rows follow registry order: Jira, GitHub, GitLab, filtered by what the deck
  reports or has saved. Each has its existing glyph, a capability sentence,
  connection status and **Read only** label.

| State/action | Result |
| --- | --- |
| Offered, no saved connection: Connect | Close Explore; open Settings → Integrations directly on that provider's existing add form. |
| Offered, saved connection: Open | Close Explore; open the existing provider panel. |
| Saved connection: Manage | Close Explore; open Settings → Integrations with the first saved connection of that kind in its existing edit form. |
| Manage in Settings (footer) | Close Explore; open Settings → Integrations without targeting a connection. |

The summary counts connected **provider kinds**, not accounts. “Connected” means
the deck offers the kind and holds at least one saved connection; it does not
prove that a token currently works. Each such kind has one automatic rail
shortcut, regardless of account count. Removing the last connection removes
that shortcut; Explore remains available.

## State and ownership

`src/web/components/ExploreIntegrationsModal.tsx` renders the catalog from the
`IntegrationsState` passed by `src/web/App.tsx`. Provider names, order and glyphs
come from `src/web/integrations/registry.ts`; availability and connections use
`kindOffered`, `kindOpenable` and `connectionsOf` in
`src/web/integrations/client.ts`. Settings mutations update that shared snapshot.
Explore adds no duplicate connection store or polling; the client's existing
refresh and retry lifecycle remains responsible for freshness.

Connect uses `requestIntegrationAdd` / `takeIntegrationAdd`, a one-shot,
in-memory navigation intent consumed by `IntegrationsSection.tsx` on mount.
It selects the original `IntegrationConnectionForm` without another provider
picker. It is mutually exclusive with the existing connection-focus intent
used by Manage and Reconnect. Settings retains validation, token help, Test,
Edit and Disconnect. Explore adds no credentials, backend behavior, pinning or
visibility preferences.

Until the first list arrives, show **Reading integrations…**. A failed first
read shows an alert and **Connection status is unavailable**. A later failure
keeps the last snapshot, warns it may be out of date and points to Settings.
An unoffered provider reported by the deck stays visibly unavailable, without
Connect or Open; a saved connection still offers Manage. Providers neither
reported nor saved are omitted. An empty catalog says no integrations are
available on this deck. The footer remains available in these states.

## Layout and focus

`src/web/styles/explore-integrations.css` caps the shared modal at
`min(610px, 94vw)` wide and `min(700px, 100dvh - 24px)` high. It inherits theme
surfaces, system type, control corners, buttons and focus treatment. At 640px
and below, controls have 44px minimum heights; below 370px, row actions wrap
under the description. Normally the body scrolls between the header and
footer. At heights of 480px or less, the whole dialog scrolls, keeping every
row and the footer reachable.

The dialog portals to `document.body`, has a named modal role and description,
and uses `useModalDismiss` for initial focus, Tab/Shift+Tab containment, Escape
and opener restoration. `useScrimDismiss` closes only on a press begun and
completed on the backdrop. Mobile More focuses its own button before opening
the dialog. Explore supplies a visible Explore/More fallback if responsive
layout replacement leaves focus on the body; handoffs close Explore before
opening the destination, whose shared modal mechanics then own focus.

`EdgeRails.tsx` keys each nonempty rail group by its first item's ID rather than
its array position. Explore therefore keeps its launcher DOM identity when the
first connected-provider group appears or the last disappears. Closing Settings
after the first Connect can restore focus to the surviving Explore button.

## Verification boundary

Focused coverage lives in `explore-integrations.test.ts`,
`integrations-add-navigation.test.ts` and `explore-rail-identity.test.ts` under
`src/web/__tests__/`, alongside shared rail, availability and modal-focus tests.
Catalog tests mock dismissal
hooks; their assertions alone do not verify browser focus behavior.

Supplied implementation QA records focused tests, typecheck and production
build, plus browser navigation, shared-state
updates and keyboard checks. Reviewed captures cover connected and zero-state
desktop, light theme, 390px/320px phones and short-height scrolling. Connected
states use synthetic fixtures; no live provider authentication was verified.
The launcher-identity regression covers provider-group insertion and removal.
A full-app browser check confirms that closing Settings after the first Connect
returns focus to Explore.
