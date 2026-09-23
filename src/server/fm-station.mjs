const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HANDLE = /^[A-Za-z0-9._-]{1,64}$/;

export const FM_STATION_READ_LIMIT = 2_000_000;
export const FM_STATION_TIMEOUT_MS = 6_000;

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CANONICAL_VIDEO = /<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/;
const EXTERNAL_CHANNEL = /"externalChannelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/;
const CHANNEL_URL = /https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/;

export function parseYouTubeStationUrl(value) {
  let url;
  try { url = new URL(String(value ?? "").trim()); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) return null;

  const channel = /^\/channel\/([^/]+)(?:\/live)?\/?$/.exec(url.pathname)?.[1];
  if (channel && CHANNEL_ID.test(channel)) return { kind: "channel", url: url.toString(), channel };

  const handle = /^\/@([^/]+)\/live\/?$/.exec(url.pathname)?.[1];
  if (handle && HANDLE.test(handle)) return { kind: "handle", url: url.toString() };

  if (url.pathname === "/watch") {
    const video = url.searchParams.get("v") ?? "";
    if (VIDEO_ID.test(video)) return { kind: "video", url: url.toString(), video };
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

export async function resolveYouTubeStation(value, { fetchImpl } = {}) {
  const parsed = parseYouTubeStationUrl(value);
  if (!parsed) return { ok: false, error: "unsupported_url" };
  if (parsed.kind === "channel") return { ok: true, channel: parsed.channel, video: null };

  const get = fetchImpl ?? fetch;
  try {
    const response = await get(parsed.url, {
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(FM_STATION_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!response.ok) return { ok: false, error: `youtube_${response.status}` };
    const marks = readYouTubeStationPage(await readBounded(response));
    if (parsed.kind === "video" && !marks.live) return { ok: false, error: "not_live" };
    if (parsed.kind === "handle" && !marks.live && !marks.video) return { ok: false, error: "not_live" };
    if (marks.channel) return { ok: true, channel: marks.channel, video: marks.video };
    if (marks.video) return { ok: true, channel: null, video: marks.video };
    if (parsed.kind === "video") return { ok: true, channel: null, video: parsed.video };
    return { ok: false, error: "unresolved" };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
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
