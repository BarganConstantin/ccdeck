// Which tree this deck captures and which CLIs it watches — the two facts
// startServer is told at boot, and that the browser can learn only from
// /api/health.
//
// These lived in src/server/index.mjs as `_workspace` and `_providers`, set by
// startServer and read by it, by the boot replay it starts and by the health
// route. They are private here: set once through setDeckScope, read through
// deckWorkspace and deckProviders. The values are unchanged.

// The tree this deck was told to capture, "" when it captures the whole
// machine. Set by startServer and never changed afterwards.
//
// The browser had no way to learn it: the launcher prints the scope on stdout
// and the hook reads it out of the discovery file, but nothing put it in an
// HTTP response — so the deck's own empty state guessed, and guessed wrong for
// everyone who passed --workspace or --scope. Health is where it belongs: it
// already answers "which deck am I talking to", and it is the one route the UI
// can read before a single event has arrived.
let _workspace = "";

// Which CLIs this deck is actually watching. Decided in bin/deck.js — from
// whether each one is on the machine, and from --claude/--no-claude and
// --codex/--no-codex — and passed in here, because the browser had no way to
// learn it and so drew both sides of the UI on every machine.
//
// That is the whole of #402 and its mirror. A Codex-only machine got the
// accounts panel open on first run, telling it to sign into a CLI it does not
// have; a Claude-only machine permanently carried "Quota unavailable. / Run
// codex login to authenticate." Same missing fact, two directions.
//
// Defaults are both true, which is what an older deck effectively reported by
// saying nothing — and the browser reads a missing field as "could not say" and
// shows both, so the two agree.
let _providers = { claude: true, codex: true };

/** Both facts, set once at boot by startServer, normalised on the way in. */
export function setDeckScope({ workspace, claude, codex }) {
  _workspace = typeof workspace === "string" ? workspace : "";
  // `!== false` rather than a cast: a caller that omits the field means "yes",
  // which is how every embedder that predates this option keeps working.
  _providers = { claude: claude !== false, codex: codex !== false };
}

/** The tree this deck captures, "" when it captures the whole machine. */
export function deckWorkspace() {
  return _workspace;
}

/** Which CLIs this deck watches, as `{ claude, codex }`. */
export function deckProviders() {
  return _providers;
}
