const CAFE_MUSIC_URL = "https://www.youtube.com/channel/UCJhjE7wbdYAae1G25m0tHAA";
const CACHE_MS = 600_000;
const MISS_CACHE_MS = 60_000;
const READ_LIMIT = 2_000_000;
const TIMEOUT_MS = 6_000;
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

let cache = null;
let cacheAt = 0;
let cacheTtl = 0;
let inflight = null;

function currentLiveVideo(html) {
  const marker = '"liveBadgeText":"LIVE"';
  const live = html.indexOf(marker);
  if (live < 0) return null;
  const start = Math.max(0, live - 2_000);
  const window = html.slice(start, live + 2_000);
  let best = null;
  for (const match of window.matchAll(/"videoId":"([\w-]{11})"/g)) {
    const distance = Math.abs(start + match.index - live);
    if (!best || distance < best.distance) best = { id: match[1], distance };
  }
  return best?.id ?? null;
}

export async function fetchCafeMusicBgm({ fetchImpl } = {}) {
  const now = Date.now();
  if (cache && now - cacheAt < cacheTtl) return cache;
  if (inflight) return inflight;
  const get = fetchImpl ?? fetch;
  inflight = (async () => {
    try {
      const response = await get(CAFE_MUSIC_URL, {
        headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
      if (!response.ok) return settle(null);
      const video = currentLiveVideo((await response.text()).slice(0, READ_LIMIT));
      return settle(video ? { id: "cafe-music-bgm", label: "Cafe Music BGM — Live", video } : null);
    } catch {
      return settle(null);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function settle(value) {
  cache = value;
  cacheAt = Date.now();
  cacheTtl = value ? CACHE_MS : MISS_CACHE_MS;
  return value;
}

export function forgetCafeMusicBgm() {
  cache = null;
  cacheAt = 0;
  cacheTtl = 0;
  inflight = null;
}
