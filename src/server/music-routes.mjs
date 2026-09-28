// The canvas's music: whether Claude FM and the other stations are live, and
// which channel and video a custom station's link resolves to.
//
// These lived in src/server/index.mjs in two places — the four radio stations
// near the top, beside the ring's accounting, and Claude FM, custom stations
// and Lofi Girl among the usage routes — and they are one feature behind one
// switch. Every handler answers AGENTS_DECK_NO_MUSIC=1 before it imports
// anything, which is how a deck told so never contacts YouTube, and every
// station module is imported lazily by the package-root URL PINNED_MODULES
// loads, so nothing leaves the machine until a page asks.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { send } from "./http-io.mjs";

// Resolved the way index.mjs resolves it, from a file in the same directory, so
// every lazy import below is the URL the pin has already evaluated.
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Whether Claude FM is broadcasting — the one question the canvas's music
 * control needs answered before it draws itself.
 *
 * NO REQUEST LEAVES THIS MACHINE UNTIL A PAGE ASKS FOR IT. There is no boot
 * probe and no timer behind this route: a deck nobody has opened calls
 * youtube.com zero times, and the first canvas to mount answers every other one
 * for the next ten minutes out of claude-fm.mjs's cache.
 *
 * Two environment variables, in the shape the notification and LAN switches
 * already use (deck-prefs.mjs names both):
 *
 *   AGENTS_DECK_NO_MUSIC=1        this deck never contacts YouTube at all. The
 *                                 answer is a plain no and the canvas draws
 *                                 nothing, which is the same thing it does when
 *                                 the channel is off air — so the off switch
 *                                 needs no second code path to test.
 *   AGENTS_DECK_FM_CHANNEL=UC...  play a different channel's live stream. The
 *                                 built-in one is a channel id rather than a
 *                                 video id precisely so it does not go stale,
 *                                 but a channel can be renamed, retired or
 *                                 handed over, and a deck that can be pointed
 *                                 elsewhere in one line does not need a release
 *                                 to keep working. Anything that is not a
 *                                 well-formed channel id is ignored rather than
 *                                 fetched.
 */
export async function handleClaudeFm(req, res) {
  if (process.env.AGENTS_DECK_NO_MUSIC === "1") {
    return send(res, 200, { ok: true, live: false, off: true });
  }
  const { fetchClaudeFm } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/claude-fm.mjs")).href
  );
  const url = new URL(req.url, "http://localhost");
  const answer = await fetchClaudeFm({
    force: url.searchParams.get("refresh") === "1",
    channel: process.env.AGENTS_DECK_FM_CHANNEL,
  });
  send(res, 200, answer);
}

/**
 * A custom station's YouTube link, resolved to the channel and video the
 * embed plays (#1208). fm-station.mjs rebuilds the request from the parsed
 * link rather than fetching it as given, and caches the answer.
 *
 * AGENTS_DECK_NO_MUSIC is the promise that this deck never contacts YouTube,
 * and a station somebody added is not an exception to it: the answer is the
 * same plain no /api/claude-fm gives, and the canvas draws nothing for it.
 */
export async function handleFmStation(req, res) {
  if (process.env.AGENTS_DECK_NO_MUSIC === "1") {
    return send(res, 200, { ok: false, off: true });
  }
  const url = new URL(req.url, "http://localhost");
  const stationUrl = url.searchParams.get("url") ?? "";
  const { parseYouTubeStationUrl, resolveYouTubeStation } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/fm-station.mjs")).href
  );
  if (!parseYouTubeStationUrl(stationUrl)) {
    return send(res, 400, { ok: false, error: "unsupported_url" });
  }
  const answer = await resolveYouTubeStation(stationUrl);
  send(res, answer.ok ? 200 : 404, answer);
}

export async function handleLofiGirl(req, res) {
  if (process.env.AGENTS_DECK_NO_MUSIC === "1") {
    return send(res, 200, { ok: true, live: false, off: true });
  }
  const url = new URL(req.url, "http://localhost");
  const station = url.searchParams.get("station");
  if (!["relax", "game", "vibe", "sleep"].includes(station)) {
    return send(res, 400, { ok: false, error: "unknown Lofi Girl station" });
  }
  const { fetchLofiStations } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/lofi-girl.mjs")).href
  );
  const stations = await fetchLofiStations();
  const answer = stations[station];
  send(res, answer ? 200 : 404, answer ?? { ok: false, error: "station is not live" });
}

export async function handleLiveRadioMix(req, res) {
  if (process.env.AGENTS_DECK_NO_MUSIC === "1") {
    return send(res, 200, { ok: true, live: false, off: true });
  }

  const { fetchLiveRadioMix } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/live-radio-mix.mjs")).href
  );
  const answer = await fetchLiveRadioMix();
  send(res, answer ? 200 : 404, answer ?? { ok: false, error: "Radio Mix is not live" });
}

export async function handleBestOfNostalgia(req, res) {
  if (process.env.AGENTS_DECK_NO_MUSIC === "1") return send(res, 200, { ok: true, live: false, off: true });
  const { fetchBestOfNostalgia } = await import(pathToFileURL(join(PKG_ROOT, "src/server/best-of-nostalgia.mjs")).href);
  const answer = await fetchBestOfNostalgia();
  send(res, answer ? 200 : 404, answer ?? { ok: false, error: "Best of Nostalgia is not live" });
}

export async function handleGoodLifeRadio(req, res) {
  if (process.env.AGENTS_DECK_NO_MUSIC === "1") return send(res, 200, { ok: true, live: false, off: true });
  const { fetchGoodLifeRadio } = await import(pathToFileURL(join(PKG_ROOT, "src/server/good-life-radio.mjs")).href);
  const answer = await fetchGoodLifeRadio();
  send(res, answer ? 200 : 404, answer ?? { ok: false, error: "The Good Life Radio is not live" });
}

export async function handleCafeMusicBgm(req, res) {
  if (process.env.AGENTS_DECK_NO_MUSIC === "1") return send(res, 200, { ok: true, live: false, off: true });
  const { fetchCafeMusicBgm } = await import(pathToFileURL(join(PKG_ROOT, "src/server/cafe-music-bgm.mjs")).href);
  const answer = await fetchCafeMusicBgm();
  send(res, answer ? 200 : 404, answer ?? { ok: false, error: "Cafe Music BGM is not live" });
}
