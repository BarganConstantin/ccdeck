// Claude FM's volume: a slider in the Appearance menu's "Claude FM" section,
// in the sound menu's own shape, persisted under its own key and sent to the
// player over the same postMessage channel the play/pause commands already
// take.
//
// What is pinned here is the parts a redesign quietly loses: the stored value
// parses through sound.ts's one strict door rather than a second spelling of
// it, the mount line hands the level to the character, and the component sends
// setVolume twice over — once at the ready handshake, so the first audible
// moment is already at the right level, and once per slider move, so a drag
// mid-track is heard.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FM_VOLUME_KEY, resolveFmVolume } from "../appearance";
import { DEFAULT_LEVEL, LEVEL_MAX, LEVEL_MIN } from "../sound";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, "..", name), "utf8");

describe("the Claude FM volume preference", () => {
  it("uses a stable, namespaced preference key", () => {
    expect(FM_VOLUME_KEY).toBe("agent-dag.fm-volume");
  });

  it("answers the default for anything this app did not write", () => {
    // Missing, empty and garbage all collapse to the default: each is evidence
    // the value did not come from the slider, and none of them may turn the
    // stream down to an end of the track by accident.
    for (const bad of [null, undefined, "", "   ", "loud", "0x10", "1e2", "Infinity", "12abc"]) {
      expect(resolveFmVolume(bad), String(bad)).toBe(DEFAULT_LEVEL);
    }
  });

  it("parses a stored level strictly, then snaps and clamps it", () => {
    expect(resolveFmVolume("50")).toBe(50);
    expect(resolveFmVolume(" 70 ")).toBe(70);
    expect(resolveFmVolume("72")).toBe(70);
    expect(resolveFmVolume("-40")).toBe(LEVEL_MIN);
    expect(resolveFmVolume("400")).toBe(LEVEL_MAX);
  });

  it("is owned by App, persisted on change, and handed to both consumers", () => {
    const app = read("App.tsx");
    expect(app).toContain("useState(storedFmVolume)");
    expect(app).toContain("localStorage.setItem(FM_VOLUME_KEY, String(fmVolume))");
    expect(app).toContain("fmVolume={fmVolume}");
    expect(app).toContain("onFmVolume={setFmVolume}");
    expect(app).toContain("{characterEnabled && <ClaudeFm volume={fmVolume} />}");
  });

  it("reuses the sound menu's slider row rather than inventing a second shape", () => {
    const menu = read("components/AppearanceMenu.tsx");
    expect(menu).toContain('id="appearance-fm-volume"');
    expect(menu).toContain('className="sm-row"');
    expect(menu).toContain('className="sm-read"');
    expect(menu).toContain('"--sm-level"');
    expect(menu).toContain("onChange={e => onFmVolume(Number(e.target.value))}");
    // Native, for the same reasons SoundMenu's is: the arrows, Home and End and
    // the announced percentage are the browser's to give.
    expect(menu).toContain('type="range"');
  });

  it("sends setVolume at the ready handshake and again whenever the level moves", () => {
    const fm = read("components/ClaudeFm.tsx");
    // Two senders: the "ready" branch (before playVideo, so there is no window
    // at the wrong loudness) and the [volume, armed, say] effect (the live
    // retune). setVolume is a plain command — nothing is read back.
    expect(fm.match(/command\("setVolume"/g) ?? []).toHaveLength(2);
    expect(fm).toContain("say(command(\"setVolume\", [volumeRef.current]))");
    expect(fm).toContain("say(command(\"setVolume\", [volume]))");
  });
});
