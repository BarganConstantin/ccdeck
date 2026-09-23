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
    // A pick of the station already set is still no pick — unless that
    // station is marked unavailable, when the pick is the retry.
    const pick = app.slice(app.indexOf("const pickFmSource"), app.indexOf("const markFmStationAvailability"));
    expect(pick).toContain("if (next === fmSource && !retry) return;");
    expect(pick).toMatch(/setFmSource\(next\);\s*setFmPlayRequest\(count => count \+ 1\);/);
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
    // Drawn from that one list, a run per group, each option by its index in it.
    expect(menu).toContain("fmSources.forEach((source, index) => {");
    expect(menu).toContain("{sourceRuns.map((run, runIndex) => run.group ? (");
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

// The station picker's audit. The menu is read as CODE here, with its prose
// taken out, because the comments that explain these fixes quote the very
// attributes the assertions rule out.
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const menuCode = strip(menu);
const appCode = strip(app);
const css = strip(readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8"));
const between = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to));

/** The value of `prop` in the rule written for exactly this selector. */
function decl(selector: string, prop: string): string | null {
  const rule = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  const m = rule && new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(rule[1]);
  return m ? m[1].trim() : null;
}

describe("the station picker as a combobox", () => {
  const keys = between(menuCode, "const moveSource", "const backToPicker");

  it("lets Escape through to the dialog while its list is closed", () => {
    // The dialog closes from App's listener on window, so a stopped Escape
    // never reaches it — and focus comes back to this trigger after every
    // pick, add, rename and remove. Only an open list may claim the key.
    expect(keys).toMatch(/if \(isEscapeKey\(event\.key\)\) \{\s*if \(!sourceOpen\) return;\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*setSourceOpen\(false\);/);
    expect(keys.match(/stopPropagation/g)).toHaveLength(1);
    expect(appCode).toContain('if (outcome === "dismiss") modalStack.dismissTop();');
  });

  it("closes its list when focus leaves the picker", () => {
    // Tab closes it and still moves focus: the list scrolls, so it would
    // otherwise be the next stop, with no options to move between from there.
    const tab = between(keys, 'if (event.key === "Tab")', 'if (event.key === "Enter"');
    expect(tab).toMatch(/setSourceOpen\(false\);\s*return;/);
    expect(tab).not.toContain("preventDefault");
    // And any other way out: focus landing outside the picker, rather than on
    // nothing (a press on the list) or on the list itself.
    expect(menuCode).toMatch(/className=\{`appearance-source-picker\$\{sourceOpen \? " is-open" : ""\}`\} onBlur=\{closeOnLeave\}/);
    expect(menuCode).toMatch(/if \(next && !event\.currentTarget\.contains\(next\)\) setSourceOpen\(false\);/);
  });

  it("points aria-controls at the list only while the list exists (#800)", () => {
    expect(menuCode).toContain('aria-controls={sourceOpen ? "appearance-fm-source-list" : undefined}');
    expect(menuCode).toMatch(/\{sourceOpen && \(\s*<div ref=\{sourceListRef\} id="appearance-fm-source-list"/);
  });

  it("names each group of stations to a screen reader", () => {
    // The APG's grouped listbox: a role="group" labelled by its header row.
    expect(menuCode).toContain('<div key={`group-${runIndex}`} role="group" aria-labelledby={`appearance-fm-group-${runIndex}`}>');
    expect(menuCode).toContain('<div id={`appearance-fm-group-${runIndex}`} className="appearance-source-group" role="presentation">');
    // The options keep the flat index the highlight is keyed on, so the id
    // aria-activedescendant names is still the option the arrows are on.
    expect(menuCode).toContain("id={`appearance-fm-option-${index}`}");
    expect(menuCode).toContain("aria-activedescendant={sourceOpen ? `appearance-fm-option-${highlightedSource}` : undefined}");
    expect(menuCode.match(/role="option"/g)).toHaveLength(1);
  });

  it("lets a station that failed be picked again, which is the retry", () => {
    // Refused, it could not be picked, and so never renamed or removed either.
    const choose = between(menuCode, "const chooseSource", "const moveSource");
    expect(choose).not.toContain("unavailable");
    expect(menuCode).not.toContain("aria-disabled");
    const pick = between(appCode, "const pickFmSource", "const markFmStationAvailability");
    expect(pick).toContain("const retry = retryId !== null && unavailableFmStations.has(retryId);");
    expect(pick).toContain("rest.delete(retryId)");
    expect(pick).toContain("}, [fmSource, unavailableFmStations]);");
    expect(decl(".appearance-source-option[data-unavailable]", "color")).toBe("var(--text-dim)");
    expect(decl('.appearance-source-option[aria-disabled="true"]', "cursor")).toBeNull();
  });

  it("gives the keyboard's place in the list a ring rather than a tint", () => {
    // The tint read 1.28:1 dark and 1.19:1 light; control-edges measures the
    // ring against every bed, and here it is held apart from hover and the
    // selected row, which keep the tints.
    expect(decl('.appearance-source-option[data-highlighted="true"]', "outline")).toBe("2px solid var(--accent)");
    expect(decl('.appearance-source-option[data-highlighted="true"]', "outline-offset")).toBe("-2px");
    expect(decl(".appearance-source-option:hover", "background")).toMatch(/var\(--accent\) 12%/);
    expect(decl('.appearance-source-option[aria-selected="true"]', "background")).toMatch(/var\(--accent\) 16%/);
  });

  it("keeps a long station name inside the dialog", () => {
    // An 80-character name with no space made the trigger 532px wide in a
    // 323px dialog. The trigger stops at its column and ellipsizes; the list
    // wraps the name instead.
    expect(decl(".appearance-source-trigger", "max-width")).toBe("100%");
    expect(decl(".appearance-source-trigger > span", "min-width")).toBe("0");
    expect(decl(".appearance-source-trigger > span", "overflow")).toBe("hidden");
    expect(decl(".appearance-source-trigger > span", "text-overflow")).toBe("ellipsis");
    expect(decl(".appearance-source-trigger > span", "white-space")).toBe("nowrap");
    expect(css).toContain(".appearance-source-option > span:first-child { min-width: 0; overflow-wrap: anywhere; }");
  });
});

describe("the station forms, named and answering", () => {
  it("names every field with words that stay on screen", () => {
    const forms = between(menuCode, "{addingStation && (", 'className="appearance-row"');
    const fields = forms.match(/<label className="appearance-station-field">\s*<span>[^<]+<\/span>\s*<input/g) ?? [];
    expect(fields.map(f => /<span>([^<]+)<\/span>/.exec(f)![1])).toEqual(["Station name", "Link", "Station name"]);
    // The <label> names each one, so none keeps an aria-label that would
    // override it, and no name lives in a placeholder.
    expect(forms).not.toContain("aria-label=");
    expect(forms).not.toContain('placeholder="Station name"');
  });

  it("puts focus in the field a refusal is about", () => {
    const add = between(menuCode, "const addStation", "const saveRename");
    expect(add).toMatch(/setStationError\(NAME_MISSING\);\s*stationNameRef\.current\?\.focus\(\);\s*return;/);
    expect(add).toMatch(/setStationError\(LINK_UNUSABLE\);\s*stationUrlRef\.current\?\.focus\(\);\s*return;/);
  });

  it("says why an empty rename was not saved, instead of doing nothing", () => {
    const rename = between(menuCode, "const saveRename", "const moveTheme");
    expect(rename).toMatch(/if \(!renameValue\.trim\(\)\) \{\s*setRenameError\(NAME_MISSING\);\s*renameInputRef\.current\?\.focus\(\);\s*return;\s*\}/);
    expect(menuCode).toContain('aria-describedby={renameError ? "appearance-rename-error" : undefined}');
    expect(menuCode).toContain('<p id="appearance-rename-error" className="appearance-station-error" role="alert">{renameError}</p>');
    // Every opening of the form starts it clean.
    expect(menuCode).toContain('setRenameValue(activeCustomStation.name); setRenameError(""); setRenamingStation(true);');
  });
});
