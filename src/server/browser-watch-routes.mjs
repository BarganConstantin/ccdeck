// The three routes Browser Watch answers on: the panel's read, the settings
// write, and the dismissal of one episode.
//
// These lived in src/server/index.mjs between the usage routes. They own no
// state of their own — the watch, its read cache and its log are
// browser-watch.mjs's, and the stored settings, archive and dismissals are
// browser-watch-store.mjs's — so what is here is the boundary: how a query or a
// body is judged before either module sees it, and which of the two a route is
// allowed to change. Both are still imported lazily and by the package-root URL
// PINNED_MODULES loads, because the readers underneath reach for node:sqlite
// and copy files, and none of that belongs on the way to a listening socket.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readBody, send } from "./http-io.mjs";

// Resolved the way pinned-build.mjs resolves it, from a file in the same
// directory, so every lazy import below is the URL the pin has already evaluated.
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * What a program drove in this machine's browsers while nobody was browsing.
 *
 * A GET, and deliberately not on the event stream. The answer costs a copy of a
 * History database that a browser holds locked, so it is pulled when the panel
 * is open and never on a timer — the same reasoning that keeps
 * /api/system/processes off the clock, for the same kind of cost.
 *
 * `refresh=1` drops the read cache. Without it a profile whose History has not
 * been written since the last look is answered from memory, which is the normal
 * case and the reason this route is cheap enough to poll while the panel is up.
 */
/**
 * Turning the watch on or off, and how it is tuned.
 *
 * A POST, unlike its GET twin, because it writes to disk and because switching
 * the watch ON starts the deck keeping its own copy of what it sees — a record
 * of pages the user visited, which is not something a page they have open gets
 * to arrange for them. The router's own gate is what enforces that: every
 * non-GET goes through isTrustedMutation and isAuthorizedMutation before it
 * reaches a handler, which is exactly the pair a GET deliberately skips.
 */
export async function handleBrowserWatchSettings(req, res) {
  const raw = await readBody(req, res).catch(() => null);
  let body = null;
  try { body = JSON.parse(raw ?? ""); } catch { /* handled below */ }
  if (!body || typeof body !== "object") return send(res, 400, { ok: false, reason: "bad_request" });

  const { readStore, updateStore, normalise } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/browser-watch-store.mjs")).href
  );
  const { invalidateBrowserWatchCache, noteWatchSetting } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/browser-watch.mjs")).href
  );
  const store = await readStore();
  // normalise() is the one place a value is judged, so a field this route has
  // never heard of cannot arrive through it and a bad one falls back rather
  // than reaching classify().
  const settings = normalise({ ...store.settings, ...body });
  // `dismissed` carried forward, and it has to be spelled: writeStore takes a
  // whole state and writes exactly what it is handed, so a caller that omits
  // this field ERASES it. Measured — changing the reaction wiped every
  // dismissal, so every episode the reader had reviewed came straight back on
  // the next poll, from a settings change that had nothing to do with them.
  // Only the settings are this route's to change. `updateStore` re-reads inside
  // the write queue, so a poll that landed between the read above and this line
  // cannot have its archive thrown away by a settings change — which is what
  // writing a whole state read seconds earlier used to do.
  await updateStore(cur => ({ ...cur, settings }));
  // The one line in the log that is somebody acting rather than the deck
  // reading, which is exactly why it is worth its own entry.
  if (settings.enabled !== store.settings.enabled) {
    noteWatchSetting(settings.enabled ? "watch on — keeping its own copy" : "watch off — reading live only");
  } else {
    noteWatchSetting(`settings: quiet ${settings.quietMinutes}m, gap ${settings.gapMinutes}m`);
  }
  invalidateBrowserWatchCache();
  return send(res, 200, { ok: true, settings });
}

/**
 * Mark one episode as reviewed, so it leaves the Findings list and stays gone.
 *
 * A DISMISSAL AND NOT A DELETION, and the difference is the whole design. The
 * panel rebuilds episodes from the browser's own history on every poll, so
 * removing the archived row would be undone within ten seconds by the next read
 * of the same visits. What is stored is that the reader has seen this one.
 *
 * The log file is untouched. It is the append-only record the panel promises —
 * "every address is written in full so you can check it yourself" — and a list
 * you can tidy is not the same thing as a record you can trust.
 */
export async function handleBrowserWatchDismiss(req, res) {
  // No gate of its own: the router runs isTrustedMutation and
  // isAuthorizedMutation on every non-GET before a handler sees it, which is
  // the pair its GET twin deliberately skips. A second check here would be a
  // second thing to keep correct.
  const raw = await readBody(req, res).catch(() => null);
  let body = null;
  try { body = JSON.parse(raw ?? ""); } catch { /* handled below */ }
  const host = typeof body?.host === "string" ? body.host : null;
  const startMs = typeof body?.startMs === "number" && Number.isFinite(body.startMs) ? body.startMs : null;
  if (host === null || startMs === null) return send(res, 400, { ok: false, reason: "bad_request" });

  const { readStore, updateStore, episodeKey } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/browser-watch-store.mjs")).href
  );
  const { invalidateBrowserWatchCache, noteWatchSetting } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/browser-watch.mjs")).href
  );
  // COMPUTED INSIDE THE JOB, like the settings route four lines up, whose
  // comment says why: "updateStore re-reads inside the write queue, so a poll
  // that landed between the read above and this line cannot have its archive
  // thrown away." This read the whole `dismissed` array before the queue, so
  // two Dismiss presses in one turn both read before either job ran and the
  // second wrote an array without the first key — both rows left the list,
  // both answered 200, and the first came back on the next ten-second poll.
  const key = episodeKey(host, startMs);
  await updateStore(cur => ({
    ...cur,
    dismissed: [...new Set([...(cur.dismissed ?? []), key])],
  }));
  // The reader acting on their own list, which is exactly the kind of line the
  // `act` level exists for.
  noteWatchSetting(`dismissed ${host}`);
  invalidateBrowserWatchCache();
  return send(res, 200, { ok: true });
}

export async function handleBrowserWatch(req, res) {
  const url = new URL(req.url, "http://localhost");
  const force = url.searchParams.get("refresh") === "1";
  // `live=0` is the badge's five-minute poll saying "the archive is enough".
  // With the watch OFF that is honoured and no browser is read at all — see
  // browserWatchSnapshot: the switch used to gate only what was KEPT, so a deck
  // nobody had switched on still copied every History database every five
  // minutes. A forced read overrides it, because that is the user pressing ↻.
  const readBrowsers = force || url.searchParams.get("live") !== "0";

  // Numbers from a query string are refused rather than coerced: NaN would
  // silently widen the quiet gate to "everything counts", which is the failure
  // mode that turns this panel into noise nobody reads.
  const minutes = name => {
    const raw = url.searchParams.get(name);
    if (raw === null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 && n <= 24 * 60 ? n * 60_000 : undefined;
  };

  // Lazily, like every other handler here, and it earns it twice: the four
  // readers underneath reach for node:sqlite and copy files, and none of that
  // belongs on the path between `npx ccdeck` and a listening socket.
  //
  // Through fetchBrowserWatch rather than the snapshot directly, because
  // `refresh=1` drops the mtime cache and copies every profile's History
  // database. That module carries the floor and the inflight slot which bound
  // what a page looping this GET can spend.
  const { deckOwnOrigins, fetchBrowserWatch, registeredDeckPorts } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/browser-watch.mjs")).href
  );
  // The registered ports as well as the documented range: a deck started with
  // an explicit `--port` outside 4317-4400 opens its own tab like any other,
  // and the panel used to report it to its owner as a program driving the
  // browser. Which it was — and the program was ccdeck.
  const ports = await registeredDeckPorts();
  return send(res, 200, await fetchBrowserWatch({
    force,
    readBrowsers,
    deckOrigins: deckOwnOrigins(undefined, ports),
    quietMs: minutes("quiet"),
    gapMs: minutes("gap"),
  }));
}
