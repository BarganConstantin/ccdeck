// The page holds still while the terminal pane has the keys (quiet-page.ts):
// a page producing frames made every echo wait one, 26 ms against 2.5 ms
// measured with trusted input. Only endless animations outside the stage are
// paused, and exactly those are resumed.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { quietPage } from "../quiet-page";

type Fake = { playState: string; effect: { getTiming(): { iterations: number }; target: { closest(s: string): unknown } | null }; pause(): void; play(): void; log: string[] };

function anim(iterations: number, inStage = false, playState = "running"): Fake {
  const log: string[] = [];
  const a: Fake = {
    playState,
    effect: { getTiming: () => ({ iterations }), target: { closest: (s: string) => (inStage && s === ".stage-dock" ? {} : null) } },
    pause() { log.push("pause"); a.playState = "paused"; },
    play() { log.push("play"); a.playState = "running"; },
    log,
  };
  return a;
}
const page = (list: Fake[]) => ({ getAnimations: () => list as unknown as Animation[] });

afterEach(() => quietPage(false));

describe("the page while the pane has the keys", () => {
  it("pauses the endless animations outside the stage, and resumes exactly those", () => {
    const edge = anim(Infinity), entrance = anim(1), spine = anim(Infinity, true), idle = anim(Infinity, false, "paused");
    quietPage(true, page([edge, entrance, spine, idle]));
    expect(edge.log).toEqual(["pause"]);
    expect(entrance.log, "an entrance runs its course").toEqual([]);
    expect(spine.log, "the stage's own light is composited and says it streams").toEqual([]);
    expect(idle.log, "one already paused is not ours to resume").toEqual([]);
    quietPage(false);
    expect(edge.log).toEqual(["pause", "play"]);
    expect(idle.log).toEqual([]);
  });

  it("pauses what started since when asked again, and never one twice", () => {
    const first = anim(Infinity);
    const list = [first];
    quietPage(true, page(list));
    const later = anim(Infinity);
    list.push(later);
    quietPage(true, page(list));
    expect(first.log).toEqual(["pause"]);
    expect(later.log).toEqual(["pause"]);
  });

  it("does nothing where the page cannot list its animations", () => {
    expect(() => quietPage(true, {})).not.toThrow();
    expect(() => quietPage(true, undefined)).not.toThrow();
  });

  it("is asked by the stage only while the pane has the keys, and undone when it gives them back", () => {
    const stage = readFileSync(fileURLToPath(new URL("../components/terminal/TerminalStage.tsx", import.meta.url)), "utf8");
    expect(stage).toMatch(/if \(session\.keysOwner !== "pane"\) return;\n\s+quietPage\(true\);[\s\S]*?return \(\) => \{ clearInterval\(again\); quietPage\(false\); \};/);
  });

  it("stops xterm's scrollbar fade, spelled past xterm's own rule, which loads after the deck's sheet", () => {
    const css = readFileSync(fileURLToPath(new URL("../styles/terminal-stage.css", import.meta.url)), "utf8");
    expect(css).toContain(".ts-host .xterm .xterm-scrollable-element > .scrollbar.invisible.fade { transition: none; }");
    const xterm = readFileSync(fileURLToPath(new URL("../../../node_modules/@xterm/xterm/css/xterm.css", import.meta.url)), "utf8");
    expect(xterm, "the rule it answers is still xterm's").toContain(".xterm .xterm-scrollable-element > .invisible.fade");
  });

  it("lets the board's tick run once a second instead of four times while the pane has the keys", () => {
    const tick = readFileSync(fileURLToPath(new URL("../use-board-tick.ts", import.meta.url)), "utf8");
    expect(tick).toMatch(/if \(beat % TYPING_EVERY !== 0 && typeof document !== "undefined" && inTerminalPanel\(document\.activeElement\)\) return;/);
  });
});
