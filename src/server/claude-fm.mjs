// Is Claude FM on air? That one question, and nothing else.
//
// The deck can play the Claude channel's live stream (src/web/claude-fm.ts
// builds the embed). What it must not do is offer a control that does nothing,
// so something has to answer "is there anything to play right now" BEFORE the
// canvas draws a play control at all. This is that something.
//
// ── why a channel and not a video ───────────────────────────────────────────
//
// The obvious build hardcodes the video id of the stream. That id is a
// stranger's object: the broadcast ends and restarts under a new one, the
// upload is struck and reappears, the uploader turns embedding off. Any of
// those leaves a control on the canvas that presses and plays nothing until
// somebody ships a release.
//
// A CHANNEL id never changes — not when the handle changes, not when a stream
// ends and another begins. `/channel/<id>/live` resolves to whatever that
// channel is broadcasting at this instant, and the embed that plays it
// (`/embed/live_stream?channel=<id>`) resolves the same way, so neither half
// holds a video id at all.
//
// ── how "on air" is read ────────────────────────────────────────────────────
//
// Two marks together, because either alone is a guess:
//
//   - the page's `<link rel="canonical">` is a `watch?v=` URL. When the channel
//     is live, `/live` IS the watch page for the broadcast; when it is not,
//     YouTube answers with the channel page, whose canonical is the channel.
//   - `"isLive":true` appears in the page's own player payload. On its own this
//     is weak — a recommendation rail can carry it about somebody else's
//     stream — which is exactly why it is only ever read alongside the first.
//
// Both, or this reports `live: false` and the canvas draws nothing. HTML
// scraping is a fragile way to learn anything and this one is deliberately
// shallow: it looks for two marks, never parses, and treats every surprise as
// "not live". The failure it can have is a control that fails to appear, which
// is the failure a music toy is allowed to have.
//
// ── what this never does ────────────────────────────────────────────────────
//
// No request leaves this machine until a page asks. There is no boot probe and
// no timer: a headless deck, a deck on a plane, a deck nobody has opened, all
// of them call youtube.com exactly zero times. The first canvas to mount asks
// once and every deck in the house is answered from the cache below for the
// next ten minutes.

/** The Claude channel. Not a video id — see the header. */
export const CLAUDE_FM_CHANNEL = "UCV03SRZXJEz-hchIAogeJOg";

/** Where the deck looks. Always the channel's `/live`, never a watch URL. */
export const liveUrl = (channel = CLAUDE_FM_CHANNEL) =>
  `https://www.youtube.com/channel/${encodeURIComponent(channel)}/live`;

/** A channel id is `UC` and 22 more of YouTube's base64url alphabet. Checked
 *  because this value can come from prefs.json, and a value from a file is an
 *  argument to a URL this module then fetches. Nothing malformed gets that far. */
export const isChannelId = (v) => typeof v === "string" && /^UC[A-Za-z0-9_-]{22}$/.test(v);

/** Ten minutes. A live stream does not start and stop often enough for a
 *  tighter number to buy anything, and every deck on this machine shares the
 *  one answer. */
export const CACHE_MS = 600_000;

/** A failed look is cached too, and for much less time: the usual cause is a
 *  network that is not there yet, and a laptop that has just joined a network
 *  should not wait out the full window to notice. */
export const MISS_CACHE_MS = 60_000;

/** A backstop, not a budget.
 *
 *  The first build of this stopped reading at a fixed 600,000 bytes on the
 *  reasoning that a `<link rel="canonical">` lives in `<head>` and `<head>` is
 *  at the top of a document. It is not, here: YouTube inlines its player
 *  payload ahead of the link, and on the day this was written the canonical sat
 *  at byte 711,238 and `"isLive":true` at 752,415 of a 1.15MB page. The cap cut
 *  both off and the probe reported a live channel as silent.
 *
 *  So the read below stops on CONTENT — the moment both marks are in hand —
 *  and this number only exists to end a page that will never carry them. Any
 *  fixed guess at where YouTube puts its own markup is a guess that expires. */
export const READ_LIMIT = 2_000_000;

/** Long enough for a slow link, short enough that a canvas is never waiting on
 *  it — the client draws nothing while this is in flight and the control simply
 *  appears when it lands. */
export const TIMEOUT_MS = 6_000;

/** YouTube answers anything that does not look like a browser with a consent
 *  interstitial, and an interstitial carries no player payload to read. */
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const CANONICAL = /<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/;
const IS_LIVE = /"isLive"\s*:\s*true/;

/**
 * The read, over a body that stops at READ_LIMIT.
 *
 * Exported so the test can drive it with a fixture instead of the network, and
 * so the regexes above have exactly one caller.
 */
export function readLiveMarks(html) {
  const canonical = CANONICAL.exec(html ?? "");
  // Both marks or nothing. `video` is reported for the record — the embed does
  // not use it and must not: the id is what goes stale.
  if (!canonical || !IS_LIVE.test(html)) return { live: false, video: null };
  return { live: true, video: canonical[1] };
}

/**
 * The floor under `?refresh=1`, in the spelling five other modules already use.
 *
 * The cache above bounds what this deck costs YouTube on its own; it bounds
 * nothing at all against a page that asks to skip it. `?refresh=1` is a GET, so
 * any page the user has open can send one in a loop, and without this each one
 * would be another request to a third party — #580's shape, which is why
 * codex-usage-forced-read-guard.test.ts counts the routes that accept a forced
 * read and makes each one answer for what it spends.
 *
 * Pure and exported, like `maySelfPoll` and `mayAskNpm`, so the rule can be
 * driven without driving the request it guards.
 */
export const FORCE_POLL_MS = 60_000;

export function mayAskYouTube(force, lastAt, now = Date.now()) {
  if (!force) return false;
  return !(lastAt > 0) || now - lastAt >= FORCE_POLL_MS;
}

let _cache = null;
let _cacheAt = 0;
let _inflight = null;

/** Drops the cache. For tests, and for the `refresh=1` a reopened page sends. */
export function forgetClaudeFm() { _cache = null; _cacheAt = 0; _inflight = null; }

/**
 * @param {{ force?: boolean, channel?: string, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<{ok: boolean, live: boolean, channel: string, video: string|null, why?: string}>}
 */
export async function fetchClaudeFm({ force = false, channel, fetchImpl } = {}) {
  const id = isChannelId(channel) ? channel : CLAUDE_FM_CHANNEL;
  const now = Date.now();
  const window = _cache?.live ? CACHE_MS : MISS_CACHE_MS;
  // A forced read only skips the cache if the floor allows it; otherwise it is
  // an ordinary read and gets the cached answer.
  const forcing = mayAskYouTube(force, _cacheAt, now);
  if (!forcing && _cache && _cache.channel === id && now - _cacheAt < window) return _cache;
  // One look at a time. Three panels mounting at once is three callers and one
  // request, which is the same rule /api/quota keeps for the same reason.
  if (_inflight) return _inflight;

  const get = fetchImpl ?? fetch;
  _inflight = (async () => {
    try {
      const res = await get(liveUrl(id), {
        // A browser User-Agent, because the answer to anything else is a
        // consent interstitial with no player payload in it at all.
        headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
      if (!res.ok) return settle({ ok: false, live: false, channel: id, video: null, why: `youtube answered ${res.status}` });
      const html = await readUntilMarks(res, READ_LIMIT);
      const marks = readLiveMarks(html);
      return settle({ ok: true, live: marks.live, channel: id, video: marks.video });
    } catch (err) {
      // Offline, DNS, a timeout, a blocked host — one answer for all of them,
      // because the canvas does the same thing with every one: draws nothing.
      return settle({ ok: false, live: false, channel: id, video: null, why: String(err?.message ?? err) });
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

function settle(answer) {
  _cache = answer;
  _cacheAt = Date.now();
  return answer;
}

/**
 * Reads a response body until both marks are in hand, then stops the transfer.
 *
 * `res.text()` pulls every byte of a 1.15MB page to answer a yes/no, and a
 * fixed byte cap was worse than that — see READ_LIMIT for the day it reported a
 * live channel as silent. This reads chunk by chunk and leaves as soon as the
 * accumulated text carries both anchors, which on a live page is around 760KB
 * and on a page that is not live is the whole thing (there is no second mark to
 * wait for, so the backstop is what ends it).
 *
 * Cancelling the reader is what actually stops the download; returning early
 * without it would leave the rest of the transfer running behind a promise
 * nobody holds. `indexOf` on the accumulated string rather than a per-chunk
 * test, because an anchor that straddles a chunk boundary is invisible to the
 * second and the strings here are small enough that the repeated scan costs
 * less than the bug would.
 */
export async function readUntilMarks(res, limit = READ_LIMIT) {
  if (!res.body?.getReader) return (await res.text()).slice(0, limit);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.includes('rel="canonical"') && out.includes('"isLive":true')) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* the socket is gone; nothing to stop */ }
  }
  // The loop checks the cap before pulling, so the chunk that crosses it is
  // already in hand. Returning it whole would make `limit` advisory, and a
  // caller that passed one asked for a bound, not a suggestion.
  return out.length > limit ? out.slice(0, limit) : out;
}
