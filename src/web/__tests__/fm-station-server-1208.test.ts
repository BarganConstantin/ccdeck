import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FM_STATION_CACHE_MS, FM_STATION_MISS_CACHE_MS,
  forgetFmStations, parseYouTubeStationUrl, readYouTubeStationPage, resolveYouTubeStation,
} from "../../server/fm-station.mjs";

const CHANNEL = "UCV03SRZXJEz-hchIAogeJOg";
const OTHER_CHANNEL = "UCAAAAAAAAAAAAAAAAAAAAAA";
const VIDEO = "jfKfPfyJRdk";

function page({ live = true, channel = CHANNEL, canonical = VIDEO } = {}) {
  return [
    canonical ? `<link rel="canonical" href="https://www.youtube.com/watch?v=${canonical}">` : "",
    `{"videoDetails":{"videoId":"${VIDEO}","channelId":"${channel}","isLiveContent":${live}}}`,
  ].join("");
}

function response(html: string, url = "") {
  return { ok: true, status: 200, url, body: null, text: async () => html } as unknown as Response;
}

// The resolver keeps one answer per link for every caller in the process, so
// every case starts from an empty cache rather than inheriting the last one's.
beforeEach(() => forgetFmStations());

describe("custom FM YouTube resolver (#1208)", () => {
  it("accepts only HTTPS YouTube station shapes", () => {
    expect(parseYouTubeStationUrl(`https://www.youtube.com/channel/${CHANNEL}`)).toMatchObject({ kind: "channel", channel: CHANNEL });
    expect(parseYouTubeStationUrl("https://youtube.com/@lofigirl/live")).toMatchObject({ kind: "handle" });
    expect(parseYouTubeStationUrl(`https://m.youtube.com/watch?v=${VIDEO}`)).toMatchObject({ kind: "video", video: VIDEO });

    for (const unsafe of [
      `http://youtube.com/watch?v=${VIDEO}`,
      `https://youtube.com.evil.example/watch?v=${VIDEO}`,
      `https://127.0.0.1/watch?v=${VIDEO}`,
      "https://youtube.com/@lofigirl",
      // A port or a login changes where the request goes, and neither is in
      // any link copied out of YouTube.
      `https://www.youtube.com:8443/watch?v=${VIDEO}`,
      "https://user:pass@www.youtube.com/@lofigirl/live",
    ]) expect(parseYouTubeStationUrl(unsafe), unsafe).toBeNull();
  });

  it("fetches a link it rebuilt, never the one it was given", async () => {
    // The caller chooses the link, so what reaches `fetch` is assembled from
    // the parsed id alone: fixed scheme and host, no port, no stray query.
    const fetchImpl = vi.fn(async () => response(page()));
    await resolveYouTubeStation(`https://m.youtube.com/watch?v=${VIDEO}&list=x&redirect=https://evil.example`, { fetchImpl });
    await resolveYouTubeStation("https://youtube.com/@lofigirl/live?si=tracking", { fetchImpl });
    expect(fetchImpl.mock.calls.map(call => (call as unknown[])[0])).toEqual([
      `https://www.youtube.com/watch?v=${VIDEO}`,
      "https://www.youtube.com/@lofigirl/live",
    ]);
  });

  it("returns a stable /channel URL without making a network request", async () => {
    const fetchImpl = vi.fn();
    await expect(resolveYouTubeStation(`https://youtube.com/channel/${CHANNEL}`, { fetchImpl }))
      .resolves.toEqual({ ok: true, channel: CHANNEL, video: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resolves /@handle/live to the current channel and canonical video", async () => {
    const fetchImpl = vi.fn(async () => response(page()));
    await expect(resolveYouTubeStation("https://youtube.com/@lofigirl/live", { fetchImpl }))
      .resolves.toEqual({ ok: true, channel: CHANNEL, video: VIDEO });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("requires watch?v= to describe the current video as live", async () => {
    const liveFetch = vi.fn(async () => response(page()));
    await expect(resolveYouTubeStation(`https://youtube.com/watch?v=${VIDEO}`, { fetchImpl: liveFetch }))
      .resolves.toEqual({ ok: true, channel: CHANNEL, video: VIDEO });

    forgetFmStations();
    const recordedFetch = vi.fn(async () => response(page({ live: false })));
    await expect(resolveYouTubeStation(`https://youtube.com/watch?v=${VIDEO}`, { fetchImpl: recordedFetch }))
      .resolves.toEqual({ ok: false, error: "not_live" });
  });

  it("does not take a recommended channelId ahead of the current video metadata", () => {
    const html = `{"channelId":"${OTHER_CHANNEL}"}${page()}`;
    expect(readYouTubeStationPage(html)).toEqual({ live: true, channel: CHANNEL, video: VIDEO });
  });

  it("does not believe a page a redirect took off YouTube", async () => {
    const fetchImpl = vi.fn(async () => response(page(), "https://evil.example/landing"));
    await expect(resolveYouTubeStation("https://youtube.com/@lofigirl/live", { fetchImpl }))
      .resolves.toEqual({ ok: false, error: "unresolved" });
  });

  it("blocks an off-site redirect before requesting its destination", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 302, ok: false, url: "https://www.youtube.com/@lofigirl/live",
      headers: new Headers({ location: "https://127.0.0.1/internal" }), body: null,
    }) as Response);
    await expect(resolveYouTubeStation("https://youtube.com/@lofigirl/live", { fetchImpl }))
      .resolves.toEqual({ ok: false, error: "unresolved" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("follows allowed YouTube redirects and resolves the live station", async () => {
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/live")
      ? ({ status: 302, ok: false, url, headers: new Headers({ location: `/watch?v=${VIDEO}` }), body: null } as Response)
      : response(page(), url));
    await expect(resolveYouTubeStation("https://youtube.com/@lofigirl/live", { fetchImpl }))
      .resolves.toEqual({ ok: true, channel: CHANNEL, video: VIDEO });
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([
      "https://www.youtube.com/@lofigirl/live", `https://www.youtube.com/watch?v=${VIDEO}`,
    ]);
  });

  it("rejects unsafe redirect schemes, credentials, ports and malformed destinations", async () => {
    for (const location of [
      "http://www.youtube.com/watch?v=jfKfPfyJRdk",
      "https://user@www.youtube.com/watch?v=jfKfPfyJRdk",
      "https://www.youtube.com:8443/watch?v=jfKfPfyJRdk",
      "https://youtube.com.evil.example/watch?v=jfKfPfyJRdk",
      "https://[invalid",
      "",
    ]) {
      forgetFmStations();
      const fetchImpl = vi.fn(async () => ({
        status: 302, ok: false, headers: new Headers({ location }), body: null,
      }) as Response);
      await expect(resolveYouTubeStation("https://youtube.com/@lofigirl/live", { fetchImpl }))
        .resolves.toEqual({ ok: false, error: "unresolved" });
      expect(fetchImpl, location).toHaveBeenCalledOnce();
    }
  });

  it("stops after five allowed redirects and cancels every redirect body", async () => {
    const cancels: ReturnType<typeof vi.fn>[] = [];
    const fetchImpl = vi.fn(async () => {
      const cancel = vi.fn(async () => {});
      cancels.push(cancel);
      return {
        status: 302, ok: false,
        headers: new Headers({ location: `/watch?v=${VIDEO}` }),
        body: { cancel },
      } as unknown as Response;
    });
    await expect(resolveYouTubeStation("https://youtube.com/@lofigirl/live", { fetchImpl }))
      .resolves.toEqual({ ok: false, error: "unresolved" });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(cancels).toHaveLength(6);
    for (const cancel of cancels) expect(cancel).toHaveBeenCalledOnce();
  });

  it("tells the page that the lookup failed, not how", async () => {
    // The error text is the operator's: a DNS message names the resolver and a
    // proxy's names the proxy, and neither is the page's business.
    const fetchImpl = vi.fn(async () => { throw new Error("getaddrinfo ENOTFOUND proxy.corp.internal"); });
    await expect(resolveYouTubeStation("https://youtube.com/@lofigirl/live", { fetchImpl }))
      .resolves.toEqual({ ok: false, error: "unreachable" });
  });
});

describe("one lookup per link, shared by every canvas (#1208)", () => {
  it("answers callers that arrive together with one request", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = vi.fn(async () => { await gate; return response(page()); });
    const both = Promise.all([
      resolveYouTubeStation("https://youtube.com/@lofigirl/live", { fetchImpl }),
      // The same station written the other ways a person might paste it.
      resolveYouTubeStation("https://m.youtube.com/@lofigirl/live/", { fetchImpl }),
    ]);
    release();
    const [first, second] = await both;
    expect(first).toEqual(second);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps an answer for its window, and a miss for a shorter one", async () => {
    let at = 1_000_000;
    const now = () => at;
    const liveFetch = vi.fn(async () => response(page()));
    await resolveYouTubeStation("https://youtube.com/@lofigirl/live", { fetchImpl: liveFetch, now });
    at += FM_STATION_CACHE_MS - 1;
    await resolveYouTubeStation("https://youtube.com/@lofigirl/live", { fetchImpl: liveFetch, now });
    expect(liveFetch).toHaveBeenCalledOnce();
    at += 2;
    await resolveYouTubeStation("https://youtube.com/@lofigirl/live", { fetchImpl: liveFetch, now });
    expect(liveFetch).toHaveBeenCalledTimes(2);

    const offAir = vi.fn(async () => response(page({ live: false, canonical: "" })));
    await resolveYouTubeStation("https://youtube.com/@quiet/live", { fetchImpl: offAir, now });
    at += FM_STATION_MISS_CACHE_MS + 1;
    await resolveYouTubeStation("https://youtube.com/@quiet/live", { fetchImpl: offAir, now });
    expect(offAir).toHaveBeenCalledTimes(2);
  });
});
