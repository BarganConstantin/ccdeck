// Custom Claude FM stations that live on YouTube (#1208).
//
// A station somebody adds by link is played by the browser, never by this
// process: a direct stream goes into an <audio> element and a YouTube one into
// the same embed Claude FM uses. The only thing the deck itself does is the
// lookup below, which turns a `/@handle/live` or `watch?v=` link into the
// channel and the video the embed needs, because YouTube only says which video
// a handle is broadcasting in the page it serves.
//
// THAT MAKES THIS THE ONE ROUTE WHERE A CALLER NAMES WHAT THE DECK FETCHES, so
// the link is never fetched as given. It is parsed down to one of three shapes
// and the request is rebuilt from the parts: https, www.youtube.com, no port,
// no login, a path this file wrote and an id that matched a strict pattern.
// A link with a port or a login is refused rather than cleaned, because nobody
// copies one of those out of a YouTube tab and both change where the request
// would really go. index.mjs puts the route behind the guarded-read gate too,
// so a page on another site cannot use it to make the deck call anything.
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HANDLE = /^[A-Za-z0-9._-]{1,64}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

export const FM_STATION_READ_LIMIT = 2_000_000;
export const FM_STATION_TIMEOUT_MS = 6_000;
/** How long an answer stands. A station that resolved stays resolved for as
 *  long as claude-fm.mjs trusts its own live check; one that did not is asked
 *  again sooner, since "not live" is the answer most likely to change. */
export const FM_STATION_CACHE_MS = 10 * 60_000;
export const FM_STATION_MISS_CACHE_MS = 60_000;
/** Answers kept at once. A deck has a handful of stations; the cap only has to
 *  stop a caller walking the map up with invented handles. */
const CACHE_MAX = 32;

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CANONICAL_VIDEO = /<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/;
const EXTERNAL_CHANNEL = /"externalChannelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/;
const CHANNEL_URL = /https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/;

export function parseYouTubeStationUrl(value) {
  let url;
  try { url = new URL(String(value ?? "").trim()); } catch { return null; }
  if (url.protocol !== "https:") return null;
  if (url.port || url.username || url.password) return null;
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;

  const channel = /^\/channel\/([^/]+)(?:\/live)?\/?$/.exec(url.pathname)?.[1];
  if (channel && CHANNEL_ID.test(channel)) {
    return { kind: "channel", url: `https://www.youtube.com/channel/${channel}/live`, channel };
  }

  const handle = /^\/@([^/]+)\/live\/?$/.exec(url.pathname)?.[1];
  if (handle && HANDLE.test(handle)) {
    return { kind: "handle", url: `https://www.youtube.com/@${handle}/live`, handle };
  }

  if (url.pathname === "/watch") {
    const video = url.searchParams.get("v") ?? "";
    if (VIDEO_ID.test(video)) return { kind: "video", url: `https://www.youtube.com/watch?v=${video}`, video };
  }
  return null;
}

export function readYouTubeStationPage(html) {
  const page = typeof html === "string" ? html : "";
  const detailsAt = page.indexOf('"videoDetails"');
  const details = detailsAt < 0 ? "" : page.slice(detailsAt, detailsAt + 24_000);
  const live = /"isLiveContent"\s*:\s*true/.test(details) || /"isLive"\s*:\s*true/.test(details);
  const channel = /"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/.exec(details)?.[1]
    ?? EXTERNAL_CHANNEL.exec(page)?.[1]
    ?? CHANNEL_URL.exec(page)?.[1]
    ?? null;
  const video = CANONICAL_VIDEO.exec(page)?.[1] ?? null;
  return { live, channel, video };
}

const _cache = new Map();
const _inflight = new Map();

/** For tests: every answer this process remembers, forgotten. */
export function forgetFmStations() {
  _cache.clear();
  _inflight.clear();
}

/**
 * The channel and video a YouTube station link plays, or why it cannot.
 *
 * CACHED AND SHARED, the way fetchClaudeFm is. Every canvas that mounts with a
 * custom station selected asks this, and four open tabs were four page loads
 * of up to 2MB each from YouTube on every reload; one lookup per link now
 * answers all of them, and a second caller that arrives while the first is
 * still reading waits for that same read.
 */
export async function resolveYouTubeStation(value, { fetchImpl, now = Date.now } = {}) {
  const parsed = parseYouTubeStationUrl(value);
  if (!parsed) return { ok: false, error: "unsupported_url" };
  if (parsed.kind === "channel") return { ok: true, channel: parsed.channel, video: null };

  const key = parsed.url;
  const hit = _cache.get(key);
  if (hit && now() - hit.at < (hit.answer.ok ? FM_STATION_CACHE_MS : FM_STATION_MISS_CACHE_MS)) return hit.answer;
  const pending = _inflight.get(key);
  if (pending) return pending;

  const lookup = lookUp(parsed, fetchImpl ?? fetch)
    .then(answer => {
      _cache.delete(key);
      _cache.set(key, { at: now(), answer });
      // A Map iterates in insertion order, so the first key is the oldest.
      while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
      return answer;
    })
    .finally(() => { _inflight.delete(key); });
  _inflight.set(key, lookup);
  return lookup;
}

async function lookUp(parsed, get) {
  try {
    const response = await get(parsed.url, {
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(FM_STATION_TIMEOUT_MS),
      redirect: "follow",
    });
    // Where the redirects ended. YouTube sends some regions to a consent page
    // on its own domain first, which is fine to read and simply carries no
    // player; anywhere else is not a page this parser should be believing.
    if (response.url && !isYouTubeHost(response.url)) {
      try { await response.body?.cancel(); } catch { /* already closed */ }
      return { ok: false, error: "unresolved" };
    }
    if (!response.ok) return { ok: false, error: `youtube_${response.status}` };
    const marks = readYouTubeStationPage(await readBounded(response));
    if (parsed.kind === "video" && !marks.live) return { ok: false, error: "not_live" };
    if (parsed.kind === "handle" && !marks.live && !marks.video) return { ok: false, error: "not_live" };
    if (marks.channel) return { ok: true, channel: marks.channel, video: marks.video };
    if (marks.video) return { ok: true, channel: null, video: marks.video };
    if (parsed.kind === "video") return { ok: true, channel: null, video: parsed.video };
    return { ok: false, error: "unresolved" };
  } catch {
    // Offline, DNS, a timeout: one answer, because the canvas does the same
    // thing with all of them, and the error text is the operator's, not the
    // page's — see the note above index.mjs's `guard`.
    return { ok: false, error: "unreachable" };
  }
}

function isYouTubeHost(href) {
  try {
    const host = new URL(href).hostname.toLowerCase();
    return host === "youtube.com" || host.endsWith(".youtube.com");
  } catch { return false; }
}

async function readBounded(response, limit = FM_STATION_READ_LIMIT) {
  if (!response.body?.getReader) return (await response.text()).slice(0, limit);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.includes('"isLive":true') && out.includes('rel="canonical"') && out.includes('"channelId"')) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* connection already closed */ }
  }
  return out.slice(0, limit);
}
