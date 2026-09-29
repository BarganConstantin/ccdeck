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

  it("keeps a notice dismissed while the first-run question was open (#1695)", () => {
    const state = createDesktopState(() => file);
    // First launch: nothing remembered yet, and the question goes up.
    expect(state.read().askedLogin).toBeUndefined();
    // Still open when an update is ready and its notice is answered Later.
    state.merge({ readyUpdateNoticeVersion: "3.30.0" });
    // Then the question is answered.
    state.merge({ askedLogin: true });
    expect(state.read()).toEqual({ readyUpdateNoticeVersion: "3.30.0", askedLogin: true });
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
    expect(main).toContain("desktopState.merge({ askedLogin: true });");
  });

  it("records the first-run answer without writing back a copy read before the question (#1695)", () => {
    // The question stays up until it is answered, and while it does the
    // update notice can be dismissed — which writes readyUpdateNoticeVersion.
    // Spreading the state read before asking put that version's notice back
    // in front of the person at the next launch.
    const from = main.indexOf("async function firstRun() {");
    expect(from, "firstRun is gone or renamed").toBeGreaterThan(-1);
    const body = main.slice(from, main.indexOf("\n}\n", from));
    expect(body).toContain("desktopState.merge({ askedLogin: true });");
    expect(body).not.toMatch(/desktopState\.write\(/);
    expect(body).not.toMatch(/\.\.\.state\b/);
  });

  it("ships inside the app", () => {
    expect(desktop("electron-builder.config.cjs")).toMatch(/"desktop-state\.mjs"/);
  });
});
