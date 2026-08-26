// One real deck, in a process of its own, registered the way bin/deck.js
// registers it. Two decks cannot share a process — the server module keeps the
// ring, the log path and the workspace in module state — and #698 is a bug
// about what one deck's Clear does to another deck's file, so the second deck
// has to be a second process.
//
// Not a test file: it is spawned by clear-shared-log-698.test.ts, which is why
// it is named without `.test` and never collected by vitest.
//
// Every path it touches comes from the environment the parent hands it —
// CLAUDE_CONFIG_DIR for the discovery directory, DECK_PERSIST for the log — and
// the parent points all of them inside a temp sandbox before spawning.
const root = process.env.DECK_ROOT;
const { startServer, hookToken } = await import(`${root}/src/server/index.mjs`);
const { writeDiscovery } = await import(`${root}/src/server/installer.mjs`);

const port = Number(process.env.DECK_PORT);
const persist = process.env.DECK_PERSIST || null;
const workspace = process.env.DECK_WORKSPACE || "";
// The exact port or nothing: the writer election is decided by the lowest port,
// so a deck that quietly moved to a random one would make the test assert
// against a hierarchy it did not set up.
const server = await startServer({ port, persist, workspace, codex: false, portRange: [port, port] });
const realPort = server.address().port;
await writeDiscovery({ port: realPort, workspace, token: hookToken(), persist, codex: false });
process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, port: realPort, token: hookToken() }) + "\n");
