// desktop-state.json, the desktop app's memory between launches (#1182, #1187):
// the first-run question, the offer to replace the npm deck's login item, and
// the update notice that has already been shown. One file, three writers, one
// store they all go through (desktop/desktop-state.mjs).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDesktopState } from "../../../desktop/desktop-state.mjs";
import { rmTempDir } from "./rm-temp-dir";

let dir = "";
let file = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccdeck-desktop-state-"));
  file = join(dir, "desktop-state.json");
});
afterEach(() => { rmTempDir(dir); });

describe("the desktop app's memory", () => {
  it("reads as empty when there is no file, or the file is not JSON", () => {
    const state = createDesktopState(() => file);
    expect(state.read()).toEqual({});
    writeFileSync(file, "{ half a file");
    expect(state.read()).toEqual({});
  });

  it("writes indented JSON, the way the file has always been written", () => {
    const state = createDesktopState(() => file);
    state.write({ askedLogin: true });
    expect(readFileSync(file, "utf8")).toBe(JSON.stringify({ askedLogin: true }, null, 2));
    expect(state.read()).toEqual({ askedLogin: true });
  });

  it("merges into what the file holds when it writes, not what it held earlier", () => {
    const state = createDesktopState(() => file);
    state.write({ askedLogin: true, readyUpdateNoticeVersion: "3.29.0" });
    // Another writer lands between two of ours.
    writeFileSync(file, JSON.stringify({ askedLogin: true, readyUpdateNoticeVersion: "3.29.0", askedReplaceService: true }));
    state.merge({ readyUpdateNoticeVersion: "3.30.0" });
    // Every key kept, the changed one where it was.
    expect(readFileSync(file, "utf8")).toBe(JSON.stringify({
      askedLogin: true, readyUpdateNoticeVersion: "3.30.0", askedReplaceService: true,
    }, null, 2));
  });

  it("asks for the path on every use, never before the app is ready", () => {
    let asked = 0;
    const state = createDesktopState(() => { asked++; return file; });
    expect(asked).toBe(0);
    state.read();
    state.merge({ a: 1 });
    // merge reads, then writes: two more.
    expect(asked).toBe(3);
  });

  it("leaves a failed write to its caller", () => {
    const state = createDesktopState(() => join(dir, "missing", "desktop-state.json"));
    expect(() => state.write({ askedLogin: true })).toThrow();
    expect(() => state.merge({ askedLogin: true })).toThrow();
  });
});

describe("the app's wiring", () => {
  const desktop = (name: string) => readFileSync(fileURLToPath(new URL(`../../../desktop/${name}`, import.meta.url)), "utf8");
  const main = desktop("main.mjs");

  it("keeps the file in userData, and writes it only through the store", () => {
    expect(main).toContain('const desktopState = createDesktopState(() => join(app.getPath("userData"), "desktop-state.json"));');
    expect(main).not.toMatch(/writeFileSync\(|JSON\.stringify\(/);
    // The three writers.
    expect(main).toContain("desktopState.merge({ readyUpdateNoticeVersion: version });");
    expect(main).toContain("desktopState.merge({ askedReplaceService: true });");
    expect(main).toMatch(/desktopState\.(?:write|merge)\(\{[^}]*askedLogin: true/);
  });

  it("ships inside the app", () => {
    expect(desktop("electron-builder.config.cjs")).toMatch(/"desktop-state\.mjs"/);
  });
});
