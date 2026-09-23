const LOFI_GIRL_URL = "https://www.youtube.com/@LofiGirl";
const CACHE_MS = 600_000;
const MISS_CACHE_MS = 60_000;
const READ_LIMIT = 2_000_000;
const TIMEOUT_MS = 6_000;
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export const LOFI_STATIONS = {
  relax: { label: "Lofi Girl — relax/study" , terms: ["relax/study"] },
  game: { label: "Lofi Girl — chill/game", terms: ["chill/game"] },
  vibe: { label: "Lofi Girl — vibe/chill", terms: ["vibe/chill"] },
  sleep: { label: "Lofi Girl — sleep/chill", terms: ["sleep/chill"] },
};

let cache = null;
let cacheAt = 0;
let cacheTtl = 0;
let inflight = null;

function stationVideo(html, terms) {
  for (const term of terms) {
    const index = html.toLowerCase().indexOf(term);
    if (index < 0) continue;
    const start = Math.max(0, index - 4_000);
    const window = html.slice(start, index + 4_000);
    const ids = [...window.matchAll(/"videoId":"([\w-]{11})"/g)];
    if (ids.length) {
      ids.sort((a, b) => Math.abs(start + a.index - index) - Math.abs(start + b.index - index));
      return ids[0][1];
    }
  }
  return null;
}

export async function fetchLofiStations({ fetchImpl } = {}) {
  const now = Date.now();
  if (cache && now - cacheAt < cacheTtl) return cache;
  if (inflight) return inflight;
  const get = fetchImpl ?? fetch;
  inflight = (async () => {
    try {
      const response = await get(LOFI_GIRL_URL, {
        headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      });
      if (!response.ok) return settle({});
      const html = (await response.text()).slice(0, READ_LIMIT);
      const stations = Object.fromEntries(
        Object.entries(LOFI_STATIONS)
          .map(([id, station]) => [id, { id, label: station.label, video: stationVideo(html, station.terms) }])
          .filter(([, station]) => station.video),
      );
      return settle(stations);
    } catch {
      return settle({});
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function settle(value) {
  cache = value;
  cacheAt = Date.now();
  cacheTtl = Object.keys(value).length ? CACHE_MS : MISS_CACHE_MS;
  return value;
}

export function forgetLofiStations() {
  cache = null;
  cacheAt = 0;
  cacheTtl = 0;
  inflight = null;
}
