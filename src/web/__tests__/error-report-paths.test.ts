// What an error report keeps of a path.
//
// The README promises that no path and no project name leaves the machine, and
// the scrub used to keep that only for the home folder: it swapped the home for
// `~` and sent everything after it. A transcript the deck could not open named
// the project twice — in the folder Claude Code encodes it as
// (`-home-alice-Desktop-acme-secret`) and, when the error came from anywhere
// else, in the path itself (`/mnt/work/acme/…`, `D:\clients\acme\…`).
//
// The rule now: a path inside the deck's own package keeps its place in that
// package (`ccdeck/src/server/tail.mjs:42:7`), so a stack still says where the
// bug is and reads the same on every machine; every other path becomes
// `<path>`, with `~` and the name of the CLI's folder (`~/.claude`) kept in
// front when it had them; and a project folder in Claude's encoding becomes
// `<project>`. Both scrubs hold to it — the server's, which runs on every error
// that leaves, and the page's, which runs on the crash text a person reads
// before sending feedback.
import { describe, it, expect } from "vitest";
import { normalise } from "../../server/deck-prefs.mjs";
import {
  createReporter, scrub, PATH_PATTERN as SERVER_PATH, PROJECT_PATTERN as SERVER_PROJECT,
  // @ts-expect-error — plain JS module, no types
} from "../../server/reports.mjs";
import { PATH_PATTERN, PROJECT_PATTERN, scrubReport } from "../report-errors";

const HOME = "/home/alice";
const NPX_ROOT = "/home/alice/.npm/_npx/1a2b3c/node_modules/ccdeck";

/** Paths outside the deck, each shape an error can carry one in, on all three systems. */
const OUTSIDE: [string, string][] = [
  [
    "ENOENT: no such file or directory, open '/home/alice/.claude/projects/-home-alice-Desktop-acme-secret/0f8f.jsonl'",
    "ENOENT: no such file or directory, open '~/.claude/<path>'",
  ],
  ["hook failed in /mnt/work/acme/src", "hook failed in <path>"],
  ["spawn /opt/acme-tools/bin/claude ENOENT", "spawn <path> ENOENT"],
  ["EPERM: operation not permitted, open 'D:\\clients\\acme\\notes.md'", "EPERM: operation not permitted, open '<path>'"],
  ["cwd C:/work/acme gone", "cwd <path> gone"],
  ["EACCES \\\\fileserver\\clients\\acme\\x.json", "EACCES <path>"],
  ["    at load (file:///mnt/work/acme/plugin.mjs:3:1)", "    at load (<path>:3:1)"],
  ["    at load (file:///D:/clients/acme/plugin.mjs:3:1)", "    at load (<path>:3:1)"],
  ["open '/Volumes/Work Drive/Acme Corp/plan.md' failed", "open '<path>' failed"],
  ["    at run (/srv/Acme Corp/app.js:1:2)", "    at run (<path>:1:2)"],
  ["EBUSY 'C:\\Users\\Bob Smith\\Desktop\\Acme Corp\\x.jsonl'", "EBUSY '~\\<path>'"],
  ["read ~/.codex/sessions/2026/10/04/rollout-1.jsonl", "read ~/.codex/<path>"],
  ["no transcript for -home-alice-Desktop-acme-secret", "no transcript for <project>"],
  ["no transcript for -Users-bob-work-acme", "no transcript for <project>"],
  ["no transcript for C--Users-Bob-acme", "no transcript for <project>"],
  ["projects/-mnt-work-acme/0f8f.jsonl is empty", "projects/<project>/0f8f.jsonl is empty"],
];

/** What must come through untouched: the page's own frames, addresses, Node's internals, plain words. */
const KEPT: string[] = [
  "    at Inner (http://127.0.0.1:4317/assets/index-B3x9.js:12:345)",
  "    at Inner (http://[::1]:4317/assets/index-B3x9.js:12:345)",
  "POST https://api.ccdeck.dev/v1/app/errors failed",
  "    at async open (node:internal/fs/promises:638:11)",
  "    at new Promise (<anonymous>)",
  "Cannot read properties of undefined (reading 'agents')",
  "Unexpected token } in JSON at position 42, 3 / 4 done",
  "run claude --output-format json -p in 2026-10-04T10:00:00-05:00",
  "session 0f8fad5b-d9cb-469f-a165-70867728950e ended",
];

describe("the server's scrub keeps no path outside the deck", () => {
  it.each(OUTSIDE)("%s", (input, output) => {
    expect(scrub(input, HOME, NPX_ROOT)).toBe(output);
  });

  it.each(KEPT)("leaves %s as it was", text => {
    expect(scrub(text, HOME, NPX_ROOT)).toBe(text);
  });

  it("keeps a frame inside the deck's package as a path in that package", () => {
    for (const frame of [
      `    at readTranscript (${NPX_ROOT}/src/server/tail.mjs:42:7)`,
      `    at readTranscript (file://${NPX_ROOT}/src/server/tail.mjs:42:7)`,
    ]) {
      expect(scrub(frame, HOME, NPX_ROOT)).toBe("    at readTranscript (ccdeck/src/server/tail.mjs:42:7)");
    }
    // The same deck run out of a source checkout, and out of the desktop app.
    const checkout = "/home/alice/Desktop/acme-secret/ccdeck";
    expect(scrub(`    at f (file://${checkout}/src/server/tail.mjs:42:7)`, HOME, checkout))
      .toBe("    at f (ccdeck/src/server/tail.mjs:42:7)");
    const desktop = "/Applications/ccdeck.app/Contents/Resources/deck";
    expect(scrub(`    at f (file://${desktop}/src/server/tail.mjs:42:7)`, "/Users/bob", desktop))
      .toBe("    at f (ccdeck/src/server/tail.mjs:42:7)");
  });

  it("keeps a frame of the deck's own Windows install, in either spelling", () => {
    const root = "C:\\Users\\Bob Smith\\AppData\\Local\\Programs\\ccdeck\\resources\\deck";
    const home = "C:\\Users\\Bob Smith";
    expect(scrub(`    at f (file:///C:/Users/Bob%20Smith/AppData/Local/Programs/ccdeck/resources/deck/src/server/tail.mjs:42:7)`, home, root))
      .toBe("    at f (ccdeck/src/server/tail.mjs:42:7)");
    expect(scrub(`EPERM '${root}\\src\\server\\tail.mjs'`, home, root)).toBe("EPERM 'ccdeck\\src\\server\\tail.mjs'");
  });

  it("keeps a dependency npx put beside the deck as a path in node_modules", () => {
    expect(scrub("    at send (/home/alice/.npm/_npx/1a2b3c/node_modules/ws/lib/websocket.js:12:3)", HOME, NPX_ROOT))
      .toBe("    at send (node_modules/ws/lib/websocket.js:12:3)");
  });

  it("does not take a folder that only starts like the deck's for the deck", () => {
    const checkout = "/home/alice/src/ccdeck";
    expect(scrub(`open '${checkout}-acme/x.js'`, HOME, checkout)).toBe("open '~/<path>'");
    expect(scrub(`open 'file://${checkout}-acme/x.js'`, HOME, checkout)).toBe("open '<path>'");
  });

  it("does not leave half a name when the home is the start of a longer one", () => {
    expect(scrub("open /home/alicex/acme/x.js", "/home/alice", NPX_ROOT)).toBe("open ~/<path>");
  });

  it("still takes out addresses and keys", () => {
    expect(scrub("mail bob@example.org with sk-ant-api03-abcdefghijklmnop", HOME, NPX_ROOT)).toBe("mail <email> with <secret>");
  });
});

describe("an error the deck sends", () => {
  it("carries no project and no folder, and its own frames still say where", async () => {
    let prefs = normalise({});
    const sent: Record<string, unknown>[] = [];
    const reporter = createReporter({
      fetchImpl: async (_url: string, init: { body?: string }) => {
        if (init.body) sent.push(JSON.parse(init.body));
        return { ok: true, status: 202 };
      },
      now: () => new Date("2026-10-04T10:00:00Z"),
      prefs: { current: () => prefs, update: async (mutate: (p: typeof prefs) => object) => (prefs = normalise({ ...prefs, ...mutate(prefs) })) },
      env: {},
      facts: { version: "3.36.0", os: "linux", arch: "x64", channel: "npm", runtime: "node-22.18.0" },
      home: HOME,
      root: NPX_ROOT,
      firstRun: () => true,
    });
    await reporter.checkIn();
    const error = new Error("ENOENT: no such file or directory, open '/home/alice/.claude/projects/-home-alice-Desktop-acme-secret/0f8f.jsonl'");
    error.stack = [
      error.message,
      `    at readTranscript (file://${NPX_ROOT}/src/server/tail.mjs:42:7)`,
      "    at hook (/mnt/work/acme/.claude/hooks/x.js:3:1)",
    ].join("\n");

    expect(await reporter.reportError("server", error)).toBe(true);

    const body = sent.at(-1)!;
    const text = JSON.stringify(body);
    for (const word of ["acme", "alice", "Desktop", "mnt"]) expect(text).not.toContain(word);
    expect(body.message).toBe("ENOENT: no such file or directory, open '~/.claude/<path>'");
    expect(String(body.stack)).toContain("at readTranscript (ccdeck/src/server/tail.mjs:42:7)");
    expect(String(body.stack)).toContain("at hook (<path>:3:1)");
  });
});

describe("the page's scrub keeps no path either", () => {
  // The page cannot know where the deck is installed — its own frames are
  // addresses, which it keeps — so every path in what it shows goes.
  it.each(OUTSIDE)("%s", (input, output) => {
    expect(scrubReport(input)).toBe(output);
  });

  it.each(KEPT)("leaves %s as it was", text => {
    expect(scrubReport(text)).toBe(text);
  });

  it("finds paths and project folders with the server's very patterns", () => {
    // Two copies, because the page cannot import the server's module: a pass
    // added to one and not the other is how a path reaches the feedback box.
    expect(PATH_PATTERN).toBe(SERVER_PATH);
    expect(PROJECT_PATTERN).toBe(SERVER_PROJECT);
  });
});
