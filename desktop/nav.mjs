// Where a link clicked in the app's window goes (#1160, #1176).
//
// The window shows the deck and nothing else: it has no address bar, and it
// wears ccdeck's name, so any other site loaded into it would look like ccdeck.
// A page on the deck's own origin stays; any other web page opens in the
// person's own browser; anything that is not a web page at all — file:, smb:,
// javascript:, an OS handler's scheme — goes nowhere, because handing it to
// the OS is how a link turns into something run.
//
// By ORIGIN, not by string prefix. `http://127.0.0.1:4317@evil.example/` starts
// with `http://127.0.0.1:4317` and is a page on evil.example, and
// `http://127.0.0.1:43170/` is another program's port.

/** `stay` in the window, open in the browser (`external`), or `block`. */
export function navigationFor(url, origin) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "block";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "block";
  return parsed.origin === origin ? "stay" : "external";
}

/** The deck's origin, for the window and for the checks against it. */
export function deckOrigin(port) {
  return `http://127.0.0.1:${port}`;
}

/**
 * Where an open window showing `windowOrigin` has to go once the app has
 * attached to `deck`: the new deck's origin when it is on another port, or
 * null to stay. A deck replaced on another port — `ccdeck --port 4500` from a
 * terminal, or each restart on a machine where 4317 is taken — left the window
 * retrying the old port for as long as it stayed open. A deck back on the same
 * port is one the page reconnects to by itself, and no deck at all is one it
 * waits for.
 */
export function originToFollow(windowOrigin, deck) {
  if (!windowOrigin || !deck) return null;
  const next = deckOrigin(deck.port);
  return next === windowOrigin ? null : next;
}
