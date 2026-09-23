// Whether this deck may be installed as an application, and why it usually may.
//
// WHAT THE MANIFEST BUYS. With `dist/web/manifest.webmanifest` served, Chrome
// and Edge put their own install control in the address bar and the deck gets a
// real icon: a Dock tile on macOS, a taskbar and Start entry on Windows, a
// `.desktop` file in the application launcher on Linux — which is the one that
// matters most, because a launcher entry works on Hyprland and Sway, where a
// system tray, the other way people ask for this, does not exist at all.
// Safari's File ▸ Add to Dock needs no manifest but honours the name and icons
// in one. None of that is UI this deck has to draw, nag about, or maintain.
//
// WHY IT IS NOT ALWAYS OFFERED, which is the whole of this file. An installed
// app is pinned to an ORIGIN, and an origin includes the port. So the icon is a
// promise about a number, and there is exactly one case where this deck cannot
// keep it: the random fallback.
//
// bin/deck.js asks for a port — 4317, or whatever `--port` said — and on a
// refused bind takes a RANDOM one out of 4318–4400 instead. That fallback is
// right and stays: 4317 is also the standard OTLP collector port, and Windows
// reserves contiguous TCP blocks for Hyper-V, WSL2 and Docker, so a deck that
// comes up on 4322 beats a deck that refuses to come up. But it draws a new
// number on every start. An app installed against one of those would be a
// broken shortcut by the next boot, and — because Chrome keys an installed app
// by origin — a SECOND icon would appear beside it, then a third. Somebody on a
// machine where 4317 is permanently taken would collect one dead tile per
// launch, and every one of them would look like the deck's fault.
//
// So the rule is not "is this 4317". It is "is this the port that was ASKED
// for", which is true for the default, true for an explicit `--port 4500` that
// bound, and false only when a bind was refused and a number was invented. A
// user who pins a port keeps their icon; a user who cannot have one never gets
// offered a shortcut that will not work tomorrow.
//
// The deck says nothing about any of this. An install control that is simply
// absent reads as a browser that has nothing to offer; a control that appeared
// and then explained itself would be a paragraph about port allocation in a
// place nobody asked a question.

/** The one path this is all about. Served out of dist/web like any other file. */
export const MANIFEST_PATH = "/manifest.webmanifest";

/**
 * May this deck be installed as an application?
 *
 * @param {object} [o]
 * @param {number|null} [o.asked]  The port the launcher wanted.
 * @param {number|null} [o.bound]  The port it actually got.
 * @returns {boolean} False when the port was invented rather than chosen.
 */
export function offerManifest({ asked = null, bound = null } = {}) {
  // Not yet listening, or a caller that never said — neither is a port anybody
  // chose, and a manifest is the wrong thing to guess about.
  if (!Number.isInteger(asked) || !Number.isInteger(bound)) return false;
  return asked === bound;
}
