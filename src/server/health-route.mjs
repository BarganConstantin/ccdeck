// GET /api/health: which deck this is, what it has accepted, who is watching
// it, what it captures, and whether what it draws is being kept.
//
// This lived in src/server/index.mjs, after Clear. It reads the newest seq
// through event-ring.mjs, the pages and the desktop app's trays through
// sse-clients.mjs, the deck's scope through deck-scope.mjs and the log's state
// through event-log.mjs and log-writer.mjs. The body is unchanged but for the
// two scope fields, which it now reads through their getters.
import { send } from "./http-io.mjs";
import { lastSeq } from "./event-ring.mjs";
import { pageCount, trayClients } from "./sse-clients.mjs";
import { deckProviders, deckWorkspace } from "./deck-scope.mjs";
import { eventLogPath, logWritableNow } from "./event-log.mjs";
import { appendFailureStats } from "./log-writer.mjs";

export function handleHealth(_req, res) {
  send(res, 200, {
    ok: true,
    name: "agent-dag",
    seq: lastSeq(),
    clients: pageCount(),
    // The desktop app's tray connections, which are not pages (#1160).
    trays: trayClients.size,
    uptimeMs: Math.round(process.uptime() * 1000),
    workspace: deckWorkspace(),
    providers: deckProviders(),
    // WHETHER THE EVENTS BEING DRAWN ARE BEING KEPT. `seq` above counts what
    // the deck accepted, and it counted a deck whose every append was failing
    // exactly the same as one whose every append landed. `log` is the other
    // half of that sentence: `writable` is the newest evidence about the log —
    // the boot probe's answer until a line lands after it and the appender's
    // from then on, the same answer the Restart gate reads (#1130) — `failing`
    // says the appender is inside a failure episode right now, and
    // `failedLines` / `failedChars` are what has been attempted and lost since
    // this deck started.
    //
    // No path. The health probe is a deliberately open route and this is the
    // smallest set of facts that answers the question; the path is already in
    // the banner for anyone standing at the terminal.
    log: eventLogPath() ? { writable: logWritableNow(), ...appendFailureStats(eventLogPath()) } : null,
  });
}
