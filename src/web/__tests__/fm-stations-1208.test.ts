import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FM_CUSTOM_STATIONS_KEY, FM_MUTED_KEY, STATION_URL_MAX, customFmSelection, newCustomFmStation, parseFmStationUrl,
  resolveCustomFmStations, resolveFmMuted, selectionAfterRemovingStation,
} from "../fm-stations";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const player = readFileSync(fileURLToPath(new URL("../components/ClaudeFm.tsx", import.meta.url)), "utf8");
const menu = readFileSync(fileURLToPath(new URL("../components/AppearanceMenu.tsx", import.meta.url)), "utf8");
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8"));

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
      // A login would sit in localStorage in plain text, and a browser will
      // not send one on a media request anyway.
      "https://user:secret@radio.example/live.mp3",
      // The server's resolver refuses a port on a YouTube link; the list must
      // not keep a station it will never resolve.
      "https://www.youtube.com:8443/@lofigirl/live",
      `https://radio.example/${"a".repeat(STATION_URL_MAX)}.mp3`,
    ]) expect(parseFmStationUrl(url), url).toBeNull();
    // A radio portal on a port of its own is ordinary, and stays accepted.
    expect(parseFmStationUrl("https://radio.example:8443/live.mp3")).toMatchObject({ kind: "direct-audio" });
  });

  it("builds a station only from a name and a link it can play", () => {
    expect(newCustomFmStation("  Night radio ", "https://radio.example/live.mp3", "radio-1"))
      .toEqual({ id: "radio-1", name: "Night radio", url: "https://radio.example/live.mp3" });
    expect(newCustomFmStation("   ", "https://radio.example/live.mp3", "radio-1")).toBeNull();
    expect(newCustomFmStation("Night radio", "javascript:alert(1)", "radio-1")).toBeNull();
    expect(newCustomFmStation("x".repeat(81), "https://radio.example/live.mp3", "radio-1")).toBeNull();
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

  it("starts a station on a pick, and never on a restore or a removal", () => {
    // A pick is the click that asked for sound — the rule the built-in list
    // shipped with, which custom stations join rather than bend. What moves
    // is App's pick counter, not the source: a reload restores the source and
    // removing the active station changes it, and neither is a request.
    expect(app).toContain("onFmSource={pickFmSource}");
    expect(app).toContain("playRequest={fmPlayRequest}");
    expect(app).toMatch(/const pickFmSource = useCallback\(\(next: FmSelection\) => \{\s*if \(next === fmSource\) return;\s*setFmSource\(next\);\s*setFmPlayRequest\(count => count \+ 1\);/);
    const removal = app.slice(app.indexOf("const removeFmStation"), app.indexOf("const pickFmSource"));
    expect(removal).toContain("selectionAfterRemovingStation");
    expect(removal).not.toContain("setFmPlayRequest");
    // A mount takes the counter as it finds it, so a restored station is idle.
    expect(player).toContain("const playRequestRef = useRef(playRequest);");
    expect(player).toContain("const asked = playRequestRef.current !== playRequest;");
    expect(player).toContain("setArmed(asked);");
    // A direct stream is started from the pick, as the embed is armed by it.
    expect(player).toContain("if (asked) startDirect(custom.url, custom.format === \"hls\", source);");
    expect(player).toContain("startDirect(probe.audio, probe.hls === true, source);");
  });

  it("does not take a stop or a station switch for a broken stream", () => {
    // Stopping, or switching away, while a stream is connecting rejects its
    // play() with an AbortError. Every failure path asks first whether its
    // player is still the current one; a refused autoplay only idles.
    const start = player.slice(player.indexOf("const startDirect = useCallback"), player.indexOf("}, [onAvailabilityChange, stopDirect]);"));
    expect(start).toContain("const current = () => audio.current === player;");
    expect(start).toMatch(/const failed = \(\) => \{\s*if \(!current\(\)\) return;/);
    expect(start).toMatch(/const refused = \(error: unknown\) => \{\s*if \(!current\(\)\) return;/);
    expect(start).toContain('error.name === "NotAllowedError"');
    expect(start).not.toMatch(/play\(\)\.catch\(failed\)/);
    expect(start).toContain("onAvailabilityChange?.(selection, true)");
  });

  it("loads hls.js only when an HLS stream needs it, and does not install it", () => {
    // ~600KB, wanted only for an HLS station in a browser without native HLS:
    // a chunk of its own rather than part of every page load.
    expect(player).not.toMatch(/^import Hls from "hls\.js";/m);
    expect(player).toContain('import type Hls from "hls.js";');
    expect(player).toContain('import("hls.js")');
    // Bundled by Vite like react, so a devDependency: `npx ccdeck` installs
    // nothing, which tarball-install-smoke.test.ts holds the tarball to.
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.devDependencies["hls.js"]).toBeTruthy();
  });
});

describe("the station form in the Appearance menu (#1208)", () => {
  it("lets a field keep the T the menu otherwise spends on the theme", () => {
    const handler = menu.slice(menu.indexOf("const onMenuKey"), menu.indexOf("return createPortal("));
    const typing = handler.indexOf("if (isTypingTarget(event.target as HTMLElement)) return;");
    expect(typing).toBeGreaterThan(-1);
    expect(typing).toBeLessThan(handler.indexOf('event.key !== "t"'));
  });

  it("puts custom stations in the one combobox, not a second picker", () => {
    expect(menu).toMatch(/const fmSources = \[\s*\.\.\.FM_SOURCES,\s*\.\.\.customFmStations\.map/);
    expect(menu).toContain("{fmSources.map((source, index) => (");
    expect(menu.match(/role="listbox"/g)).toHaveLength(1);
    expect(menu).not.toContain("<select");
  });

  it("reuses the swept button and field instead of a third copy of each", () => {
    expect(menu).not.toContain("appearance-station-button");
    expect(menu).toContain('<button type="submit" className="btn primary">Add</button>');
    expect(menu).toContain('className="btn danger"');
    expect(menu.match(/className="ap-manage-input"/g)).toHaveLength(3);
  });

  it("hands focus back to the picker when the focused control goes away", () => {
    expect(menu).toContain("const backToPicker = () => sourceTriggerRef.current?.focus();");
    for (const step of ["setAddingStation(false);\n    backToPicker();", "setRenamingStation(false);\n    backToPicker();",
      "onRemoveFmStation(activeCustomStation.id); backToPicker();"]) {
      expect(menu, step).toContain(step);
    }
  });
});
