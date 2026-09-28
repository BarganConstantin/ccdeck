// What Browser Watch has been doing, as the lines the panel's feed shows.
//
// The snapshot writes a line when it finds something, when a profile cannot be
// read, when a reaction ran or failed; the settings and dismiss routes write
// one when the reader acts. Every line goes in through `note`, the buffer's one
// writer, and comes back out through `watchLog` as a copy — the buffer itself
// is private, so nothing else can reorder it, grow it past its bound, or keep
// hold of it while it changes.
//
// browser-watch.mjs re-exports noteWatchSetting, which is the name the routes
// import, so browser-watch-routes.mjs is unchanged.

/**
 * What the watch has been doing, newest first.
 *
 * The shell tool this descends from printed a running commentary — armed,
 * standing down, still watching, nothing found — and that commentary was most
 * of what made it trustworthy: you could see it working rather than take its
 * silence on faith. A panel that only ever shows a list has no way to say "I
 * looked, and there was nothing", which reads identically to "I am not looking".
 *
 * In memory and bounded. It is a record of what this process did since it
 * started, not an audit trail — the archive on disk is the thing that must
 * survive, and it already does.
 */
const LOG_MAX = 200;
const logLines = [];

/**
 * One line of what the watch did.
 *
 * FIVE LEVELS, AND THEY ARE NOT SEVERITIES. `find` is the only one that means
 * something was found; `act` is the reader themselves, changing a setting or
 * the switch — the only lines in the file a person put there, and the ones they
 * scan for when asking "what did I change and when"; `ok` is the deck working,
 * `info` is the deck deciding not to work, and `warn` is the deck unable to.
 *
 * A log where every line is the same weight is a log nobody scans — and the one
 * line worth catching here is a program having driven the browser, which is not
 * an error and must not be dressed as one.
 *
 * @param {"find"|"act"|"ok"|"info"|"warn"} level
 */
export function note(level, text, atMs = Date.now(), parts = null) {
  // `parts` is the same line said as columns, for the one shape that HAS
  // columns: a profile read. The panel aligns those into a grid, where the
  // count lands in the same place on every row instead of at the end of a
  // sentence whose length depends on the browser's name. Composed here rather
  // than parsed back out of `text` in the client — a program that has to
  // reverse its own formatting has two spellings of one fact and will
  // eventually disagree with itself.
  //
  // Null for every other line, and that is not a gap: "still watching 2
  // profiles" and "closed the tab" are the deck talking, not events with a
  // browser and a number, and the panel renders them as a different kind of
  // row on purpose.
  logLines.unshift(parts ? { atMs, level, text, parts } : { atMs, level, text });
  if (logLines.length > LOG_MAX) logLines.length = LOG_MAX;
}

export function watchLog() {
  return logLines.slice();
}

/** Called by the settings route, which is the one moment worth a line of its
 *  own: everything else here is the deck reading, and this is the user acting. */
export function noteWatchSetting(text) {
  note("act", text);
}
