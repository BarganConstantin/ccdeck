import { describe, expect, it, vi } from "vitest";
import {
  parseYouTubeStationUrl, readYouTubeStationPage, resolveYouTubeStation,
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

function response(html: string) {
  return { ok: true, status: 200, body: null, text: async () => html } as Response;
}

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
    ]) expect(parseYouTubeStationUrl(unsafe), unsafe).toBeNull();
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

    const recordedFetch = vi.fn(async () => response(page({ live: false })));
    await expect(resolveYouTubeStation(`https://youtube.com/watch?v=${VIDEO}`, { fetchImpl: recordedFetch }))
      .resolves.toEqual({ ok: false, error: "not_live" });
  });

  it("does not take a recommended channelId ahead of the current video metadata", () => {
    const html = `{"channelId":"${OTHER_CHANNEL}"}${page()}`;
    expect(readYouTubeStationPage(html)).toEqual({ live: true, channel: CHANNEL, video: VIDEO });
  });
});
