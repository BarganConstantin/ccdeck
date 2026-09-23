import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FM_CUSTOM_STATIONS_KEY, FM_MUTED_KEY, customFmSelection, parseFmStationUrl,
  resolveCustomFmStations, resolveFmMuted, selectionAfterRemovingStation,
} from "../fm-stations";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const player = readFileSync(fileURLToPath(new URL("../components/ClaudeFm.tsx", import.meta.url)), "utf8");

describe("custom FM stations (#1208)", () => {
  it("parses the supported YouTube link shapes", () => {
    expect(parseFmStationUrl("https://www.youtube.com/channel/UCV03SRZXJEz-hchIAogeJOg")).toMatchObject({
      kind: "youtube-channel", channel: "UCV03SRZXJEz-hchIAogeJOg",
    });
    expect(parseFmStationUrl("https://youtube.com/@lofigirl/live")).toMatchObject({
      kind: "youtube-handle", handle: "lofigirl",
    });
    expect(parseFmStationUrl("https://www.youtube.com/watch?v=jfKfPfyJRdk")).toMatchObject({
      kind: "youtube-video", video: "jfKfPfyJRdk",
    });
  });

  it("parses direct radio streams including HLS", () => {
    for (const url of [
      "https://radio.example/live.mp3",
      "https://radio.example/live.aac?token=x",
      "https://radio.example/live.ogg",
    ]) expect(parseFmStationUrl(url)).toMatchObject({ kind: "direct-audio", format: "audio" });
    expect(parseFmStationUrl("https://radio.example/live.m3u8")).toMatchObject({ kind: "direct-audio", format: "hls" });
  });

  it("rejects unsafe schemes and unsupported links", () => {
    for (const url of [
      "javascript:alert(1)", "data:audio/mp3;base64,AA==", "file:///tmp/live.mp3",
      "http://radio.example/live.mp3", "https://example.com/radio", "https://youtube.com/@lofigirl",
    ]) expect(parseFmStationUrl(url), url).toBeNull();
  });

  it("strictly restores local stations and mute under separate keys", () => {
    expect(FM_CUSTOM_STATIONS_KEY).toBe("agent-dag.fm-custom-stations");
    expect(FM_MUTED_KEY).toBe("agent-dag.fm-muted");
    expect(resolveFmMuted("1")).toBe(true);
    expect(resolveFmMuted("0")).toBe(false);
    expect(resolveFmMuted("true")).toBe(false);

    const stored = JSON.stringify([
      { id: "radio-1", name: "  My radio  ", url: "https://radio.example/live.mp3" },
      { id: "bad", name: "Unsafe", url: "javascript:alert(1)" },
      { id: "radio-1", name: "Duplicate", url: "https://radio.example/other.mp3" },
    ]);
    expect(resolveCustomFmStations(stored)).toEqual([
      { id: "radio-1", name: "My radio", url: "https://radio.example/live.mp3" },
    ]);
  });

  it("falls back to Claude FM when the active custom station is removed", () => {
    expect(selectionAfterRemovingStation(customFmSelection("radio-1"), "radio-1")).toBe("claude-fm");
    expect(selectionAfterRemovingStation("lofi-relax", "radio-1")).toBe("lofi-relax");
  });

  it("persists FM mute independently from volume and notification sound", () => {
    expect(app).toContain("localStorage.setItem(FM_MUTED_KEY, fmMuted ? \"1\" : \"0\")");
    expect(app).toContain("localStorage.setItem(FM_VOLUME_KEY, String(fmVolume))");
    expect(FM_MUTED_KEY).not.toBe("agent-dag.sound-muted");
  });

  it("never autoplays a custom stream while restoring or changing its source", () => {
    expect(player).toContain("setArmed(false)");
    expect(player).toContain("setPlaying(false)");
    expect(player).toContain("const player = new Audio()");
    expect(player.indexOf("const player = new Audio()")).toBeGreaterThan(player.indexOf("const press = () =>"));
    expect(player).toContain("Hls.Events.MANIFEST_PARSED");
    expect(player).toContain("onAvailabilityChange?.(source, true)");
  });
});
