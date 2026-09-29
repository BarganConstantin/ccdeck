// What the desktop app remembers between launches, in desktop-state.json:
// which first-run questions it has asked, and which update's ready notice it
// has already shown (#1182, #1187).
//
// One small file with three writers — the first-run question, the offer to
// replace the npm deck's login item, and the update notice — each of which
// read it, spread its own key in and wrote the whole thing back by hand. They
// go through here now.
//
// Knows nothing about Electron: main.mjs hands it the path, as a function so
// that nothing asks Electron where userData is before the app is ready.
import { readFileSync, writeFileSync } from "node:fs";

/** @param {() => string} path */
export function createDesktopState(path) {
  /** What the file says, or {} when there is none or it is not JSON. */
  function read() {
    try { return JSON.parse(readFileSync(path(), "utf8")); } catch { return {}; }
  }

  /** Replace the file with `state`. Throws when it cannot be written; each
   *  caller decides what that costs. */
  function write(state) {
    writeFileSync(path(), JSON.stringify(state, null, 2));
  }

  /** Set `patch`'s keys and keep every other key the file holds now. */
  function merge(patch) {
    write({ ...read(), ...patch });
  }

  return { read, write, merge };
}
