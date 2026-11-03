// For a suite that boots a deck to test something else (the event ring, the log
// writer, the election): the Command Panel is on by default now, and a deck with
// it on records its own "held" notice in the ring and the log, which is a line
// those suites count. They store the person's switch off, as Settings does, so
// they keep measuring what they were written to measure. Call it after the
// suite's sandbox HOME / config variables are set and BEFORE the first import
// of the server, which reads the settings file when it loads.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { prefsPath } from "../../server/prefs-path.mjs";

export function seedPanelOff(): void {
  mkdirSync(dirname(prefsPath()), { recursive: true });
  writeFileSync(prefsPath(), JSON.stringify({ terminal: false }));
}
