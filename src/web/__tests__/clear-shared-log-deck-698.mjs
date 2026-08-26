// One real deck, in a process of its own, registered the way bin/deck.js
// registers it. Two decks cannot share a process — the server module keeps the
// ring, the log path and the workspace in module state — and #698 is a bug
// about what one deck's Clear does to another deck's file, so the second deck
// has to be a second process.
//
// Not a test file: it is spawned by clear-shared-log-698.test.ts, which is why
// it is named without `.test` and never collected by vitest.
//
// THE SERVER IS IMPORTED THROUGH A URL, NOT A PATH, and that is the whole of
// what this file has to get right. `import()` takes an ES module SPECIFIER, and
// an absolute POSIX path is a usable one only by accident — it begins with a
// slash, so it reads as a relative-to-root URL. An absolute Windows path is
// not: `D:\a\b\index.mjs` parses as a URL whose scheme is `d:`, and Node
// answers ERR_UNSUPPORTED_ESM_URL_SCHEME before anything in this file runs.
// GitHub's Windows runners put the checkout on D: and TEMP on C:, so there is
// no shared root to lean on either. Resolving against `import.meta.url` keeps
// the specifier a URL from end to end and needs no path handed in at all —
// this file lives in the repo beside the module it loads, which is a fact that
// does not vary by platform. The same rule as the generated re-export modules
// in boot-listen-before-report.test.ts, which are written out as `new
// URL(...).href` for exactly this reason.
//
// Every path this deck WRITES to comes from the environment the parent hands
// it — CLAUDE_CONFIG_DIR for the discovery directory, DECK_PERSIST for the log
// — and the parent points all of them inside a temp sandbox before spawning.
// Those stay paths: they are handed to fs, which takes paths on every platform.
const { startServer, hookToken } = await import(new URL("../../server/index.mjs", import.meta.url).href);
const { writeDiscovery } = await import(new URL("../../server/installer.mjs", import.meta.url).href);

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
