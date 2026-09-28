// The name the server prints, in one place — the console half of what
// src/web/brand.ts holds for the browser and src/server/wordmark.mjs draws as
// the banner wordmark. Every `PRODUCT:` prefix below is a line a user reads when
// something has already gone wrong, which is the worst moment to introduce
// yourself by a name that appears nowhere else they have seen.
//
// Display name only. The package published to npm is a separate fact, even
// though it has been spelled `ccdeck` too since the old names were retired:
// install-layout.mjs's PUBLISHED_NAME is what the registry is queried for and
// what `npm i -g` installs, and an install that names the product instead of
// the package installs nothing once the two differ again. Same for the
// marker files under ~/.agents-deck, the event log under ~/.claude/agent-dag,
// the AGENTS_DECK_* variables and the `user-agent` headers: identifiers outlive
// a rename, and moving one orphans a running deck from its own state.

/** The prefix on every line the deck writes to a console or a log. */
export const PRODUCT = "ccdeck";
