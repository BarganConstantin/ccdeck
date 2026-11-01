// V4 Workspace: which view is on screen, and the browser's memory of it.
//
// Board or Workspace is one string in localStorage under agent-dag.view, per
// browser (not per account), and it is read for the layout only where the
// Command Panel is on and the window is not a phone. These hold the rules of
// use-view.ts as data, and its place in the first-load chunk as imports.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { WEB_DIR } from "./client-source";
import { withoutComments } from "./tsx-scan";
import { UI_STORAGE_KEYS } from "../account-ui-fields";
import { SHAPE_KEYS } from "../storage";
import { VIEW_KEY, effectiveView, readView, workspaceOffered, writeView } from "../use-view";

describe("the remembered view", () => {
  it("is stored under agent-dag.view, in the namespace every key of the client lives in", () => {
    expect(VIEW_KEY).toBe("agent-dag.view");
  });

  it("reads Workspace only for the one word that says so; anything else is the Board", () => {
    expect(readView(() => "workspace")).toBe("workspace");
    for (const v of [null, "", "board", "Workspace", "split", "1", "workspace "]) {
      expect(readView(() => v), String(v)).toBe("board");
    }
  });

  it("writes the choice as the word it reads back", () => {
    const written: Array<[string, string]> = [];
    writeView("workspace", (k, v) => written.push([k, v]));
    writeView("board", (k, v) => written.push([k, v]));
    expect(written).toEqual([["agent-dag.view", "workspace"], ["agent-dag.view", "board"]]);
    expect(readView(() => written[0][1])).toBe("workspace");
  });

  it("is a blocked store's loss only: an accessor that throws reads as the Board, through storage.ts", async () => {
    // readStored swallows the throw, so the default read is the Board.
    expect(readView()).toBe("board");
  });

  it("is per browser: not an account field, not a shape the build prunes", () => {
    expect(UI_STORAGE_KEYS.has(VIEW_KEY)).toBe(false);
    expect(SHAPE_KEYS).not.toContain(VIEW_KEY);
  });
});

describe("whether Workspace is on offer", () => {
  it("needs the Command Panel on, its platform not refused, and no phone", () => {
    expect(workspaceOffered({ enabled: true, supported: true }, false)).toBe(true);
    expect(workspaceOffered({ enabled: true, supported: null }, false), "support not yet known counts as on").toBe(true);
    expect(workspaceOffered({ enabled: true, supported: false }, false)).toBe(false);
    expect(workspaceOffered({ enabled: false, supported: true }, false)).toBe(false);
    expect(workspaceOffered({ enabled: true, supported: true }, true), "a phone is the Board alone").toBe(false);
  });

  it("follows the stored view only where it is on offer, and leaves the stored view alone", () => {
    expect(effectiveView("workspace", true)).toBe("workspace");
    expect(effectiveView("workspace", false)).toBe("board");
    expect(effectiveView("board", true)).toBe("board");
  });
});

describe("the first-load chunk", () => {
  const STAGE_CODE = /use-stage|stage-shell|stage-geometry|terminal-stage|components\/terminal\/|StageShell|StageSlots/;

  /** Every local module a file reaches by static import. */
  function reach(start: string): string[] {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const src = withoutComments(readFileSync(file, "utf8"));
      const re = /^\s*(?:import|export)\s+(type\s+)?(?:[^;'"]*?\s+from\s+)?["']([^"']+)["']/gm;
      for (const m of src.matchAll(re)) {
        if (m[1] || !m[2].startsWith(".")) continue;
        const base = resolve(dirname(file), m[2]);
        for (const p of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
          if (existsSync(p) && statSync(p).isFile()) { queue.push(p); break; }
        }
      }
    }
    return [...seen];
  }

  it("use-view.ts and ViewSwitch.tsx reach no stage code", () => {
    for (const f of ["use-view.ts", "components/ViewSwitch.tsx"]) {
      const reached = reach(join(WEB_DIR, f)).map(p => p.slice(WEB_DIR.length).replaceAll("\\", "/"));
      expect(reached.filter(p => STAGE_CODE.test(p)), f).toEqual([]);
    }
  });
});
