import { resolveSrv } from "node:dns/promises";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const FALLBACK = ["de1.api.radio-browser.info", "nl1.api.radio-browser.info", "at1.api.radio-browser.info"];
const TTL = 10 * 60_000;

export function normalizeRadioStation(row) {
  if (!row || typeof row !== "object" || !UUID.test(row.stationuuid)) return null;
  let url;
  try { url = new URL(row.url_resolved || row.url); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || /\.(pls|m3u)$/i.test(url.pathname)) return null;
  const name = String(row.name ?? "").trim().slice(0, 80);
  if (!name) return null;
  const coordinate = (value, limit) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
  return {
    id: `radio-${row.stationuuid}`, name, url: url.href,
    country: String(row.country ?? "").slice(0, 80), countryCode: String(row.countrycode ?? "").slice(0, 2),
    region: String(row.state ?? "").slice(0, 80), tags: String(row.tags ?? "").slice(0, 180),
    language: String(row.language ?? "").slice(0, 80), codec: String(row.codec ?? "").slice(0, 12),
    bitrate: Math.max(0, Math.min(1000, Number(row.bitrate) || 0)),
    ...(row.hls === 1 ? { hls: true } : {}),
    lat: coordinate(row.geo_lat, 90), lon: coordinate(row.geo_long, 180),
  };
}

export function createRadioDirectory({ fetchImpl = fetch, discover = resolveSrv, now = Date.now, random = Math.random } = {}) {
  const cache = new Map();
  const pending = new Map();
  const clicks = new Set();
  let hosts;
  let hostTime = 0;
  async function servers() {
    if (hosts && now() - hostTime < TTL) return hosts;
    try {
      const rows = await Promise.race([
        discover("_api._tcp.radio-browser.info"),
        new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("dns_timeout")), 2000); timer.unref?.(); }),
      ]);
      hosts = rows.map(row => row.name.replace(/\.$/, "")).filter(host => /^[a-z0-9-]+\.api\.radio-browser\.info$/i.test(host));
    } catch { hosts = []; }
    hosts = [...new Set([...hosts, ...FALLBACK])];
    for (let i = hosts.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [hosts[i], hosts[j]] = [hosts[j], hosts[i]]; }
    hostTime = now();
    return hosts;
  }
  async function request(path) {
    for (const host of (await servers()).slice(0, 3)) {
      try {
        const response = await fetchImpl(`https://${host}${path}`, {
          headers: { "User-Agent": "ccdeck-radio/1.0 (+https://ccdeck.dev)", Accept: "application/json" },
          signal: AbortSignal.timeout(4500), redirect: "error",
        });
        if (!response.ok) throw new Error("directory_unavailable");
        const reader = response.body?.getReader();
        if (!reader) return await response.json();
        const chunks = []; let size = 0;
        try {
          for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 2_000_000) throw new Error("directory_too_large"); chunks.push(value); }
        } finally { await reader.cancel().catch(() => {}); }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { /* Try another directory mirror, never another stream. */ }
    }
    throw new Error("directory_unavailable");
  }
  async function search({ name = "", country = "", tag = "", language = "" } = {}) {
    const params = new URLSearchParams({ limit: "300", hidebroken: "true", order: "clickcount", reverse: "true", is_https: "true" });
    if (name) params.set("name", name.trim().slice(0, 80));
    if (country) params.set("countrycode", country.toUpperCase().slice(0, 2));
    if (tag) params.set("tag", tag.trim().slice(0, 40));
    if (language) params.set("language", language.trim().slice(0, 40));
    const key = params.toString();
    const cached = cache.get(key);
    if (cached && now() - cached.at < TTL) return cached.stations;
    if (pending.has(key)) return pending.get(key);
    const promise = request(`/json/stations/search?${key}`).then(rows => {
      if (!Array.isArray(rows)) throw new Error("directory_invalid");
      const seen = new Set();
      const stations = rows.slice(0, 300).map(normalizeRadioStation).filter(station => {
        if (!station || seen.has(station.id)) return false;
        seen.add(station.id); return true;
      });
      if (cache.size >= 64) cache.delete(cache.keys().next().value);
      cache.set(key, { at: now(), stations });
      return stations;
    }).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  }
  async function click(id) {
    const uuid = id.replace(/^radio-/, "");
    if (!UUID.test(uuid)) return false;
    if (clicks.has(uuid)) return true;
    if (clicks.size >= 1000) clicks.clear();
    clicks.add(uuid);
    try { await request(`/json/url/${uuid}`); return true; } catch { clicks.delete(uuid); return false; }
  }
  return { search, click };
}

export const radioDirectory = createRadioDirectory();
