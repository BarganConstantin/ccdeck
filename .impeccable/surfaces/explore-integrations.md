# Explore integrations

Mode: Operate. Ordinary extension of ccdeck's established interface, inheriting
DESIGN.md. The task is to discover a tool, understand its connection state and
reach its existing form or panel in one action.

- Keep the permanent plug launcher in the left rail's separated bottom group,
  inside its existing roving toolbar. Preserve preceding controls and one
  automatic shortcut per connected provider kind. Mobile uses the named entry
  in the existing More menu at 640px and below.
- Keep the compact catalog: title and purpose, registry-ordered provider rows,
  then read-only/local-token reassurance and Manage in Settings. Existing
  glyphs, theme tokens, system type and native controls own its appearance.
- Use the shared connection snapshot. Connect opens the existing provider form
  directly through one-shot navigation; Open uses the existing panel; Manage
  targets the first saved connection's edit form. Close Explore before handoff.
  Settings owns authentication and connection changes.
- Preserve textual loading, unavailable, empty and stale/error states. Never
  offer Connect/Open for an unoffered kind; retain Manage for saved connections.
  Connected counts kinds with saved connections, not successful live auth.
- Width is capped at 610px/94vw. At phone widths, preserve 44px control heights;
  below 370px, actions wrap below the description. At heights up to 480px,
  scroll the whole dialog so the footer remains reachable.
- Reuse shared modal dismissal, focus containment and restoration, with a
  visible Explore/More fallback after responsive replacement. Do not add a
  separate focus trap, connection store, polling or pinning preferences.
- Preserve stable rail-group keys based on their first item's ID. Explore's
  launcher must survive the connected-provider group appearing/disappearing so
  Settings can restore focus after the first Connect. The identity regression
  covers both changes; a full-app browser check confirms first-Connect return.

Feature behavior, source ownership and QA limits:
[Explore integrations](../../docs/features/explore-integrations.md).
Connected QA was synthetic, without live auth.
