// The empty board a first run lands on (V4 onboarding): where the deck can
// start a session itself, New session is the screen's one primary, under the
// title, with the terminal as the second way in the line under it and the tour
// gone quiet beside the film. Where it cannot — the Command Panel off, a
// platform without it, its code not loaded — the hero is the one it was, with
// no button that would lead nowhere.
//
// What the press does to the stage (the empty stage, then the form off its own
// button, and the stage gone again with the form closed unused) is
// use-stage.test.ts's "the empty board's New session". This file draws the
// hero, presses its button, and reads the one place App decides it is offered.
//
// No DOM in this suite: the markup is drawn with renderToStaticMarkup, and the
// press reads the element tree the hero returns.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EmptyHero } from "../components/EmptyHero";
import { EMPTY_NEW_SESSION_ID as STAGE_BUTTON_ID } from "../components/terminal/StageBody";
import { EMPTY_NEW_SESSION_ID } from "../stage-shell";
import { LANGUAGES } from "../i18n";
import boardEn from "../i18n/areas/board/en";
import { ASSUMED } from "../providers";
import { all, one, textOf } from "./fake-react";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const noop = () => {};
type HeroProps = Parameters<typeof EmptyHero>[0];
const props = (extra: Partial<HeroProps> = {}): HeroProps =>
  ({ live: true, everConnected: true, providers: ASSUMED, workspace: null, onTour: noop, ...extra });
const hero = (extra: Partial<HeroProps> = {}) => renderToStaticMarkup(createElement(EmptyHero, props(extra)));

describe("the empty board, where the deck can start a session", () => {
  const html = hero({ onNewSession: noop });

  it("offers New session as its one primary, under the title", () => {
    expect(html).toContain('<button type="button" class="btn primary empty-new" aria-haspopup="dialog" title="Start Claude or Codex in a project">New session</button>');
    expect(html.match(/class="btn primary/g), "one primary on the screen").toHaveLength(1);
    expect(html.indexOf("<h2>No sessions yet</h2>")).toBeLessThan(html.indexOf("empty-new"));
  });

  it("keeps the terminal as the second way, in the one line under it", () => {
    expect(boardEn["board.hero.orRun"]).toBe("Or run claude or codex in any folder and it shows up here.");
    expect(html).toContain('<p class="empty-or">Or run <code>claude</code> or <code>codex</code> in any folder and it shows up here.</p>');
    expect(html.indexOf("empty-new")).toBeLessThan(html.indexOf("Or run"));
    // One line, not two saying the same thing.
    expect(html).not.toContain("Start Claude Code or Codex in a terminal");
  });

  it("keeps the help for that way, the tour and the film, with the tour quiet", () => {
    expect(html).toContain('<summary>Session not showing up?</summary>');
    expect(html).toMatch(/<div class="empty-actions" role="group" aria-label="[^"]+" data-quiet=""><button type="button" class="btn empty-tour">Take the tour<\/button>/);
    expect(html).toContain("film-link film-action");
    expect(html.indexOf("Or run")).toBeLessThan(html.indexOf("empty-actions"));
  });

  it("hands the press the button, for the stage to grow out of", () => {
    const start = vi.fn();
    const button = one(EmptyHero(props({ onNewSession: start })), el => el.props.className === "btn primary empty-new");
    expect(button, "the hero draws New session").not.toBeNull();
    expect(textOf(button)).toBe("New session");
    const pressed = { id: "the hero's button" };
    (button!.props.onClick as (e: { currentTarget: unknown }) => void)({ currentTarget: pressed });
    expect(start).toHaveBeenCalledWith(pressed);
  });

  it("says the scope sentence instead of 'any folder' on a scoped deck, under the same button", () => {
    const scoped = hero({ onNewSession: noop, workspace: "/home/u/project" });
    expect(scoped).toContain("empty-new");
    expect(scoped).toContain("<code>/home/u/project</code>");
    expect(scoped).not.toContain("in any folder");
  });

  it("names the commands in <code> in every language, since they are typed as they are", () => {
    for (const { code, catalog } of LANGUAGES) {
      const line = (catalog as Record<string, string>)["board.hero.orRun"];
      expect(line, code).toBeTruthy();
      expect(line, code).toContain("claude");
      expect(line, code).toContain("codex");
    }
  });
});

describe("the empty board, where the deck cannot start one", () => {
  it("draws no New session and is the hero it was: the line, then the tour as its button", () => {
    const html = hero();
    expect(html).not.toContain("empty-new");
    expect(html).not.toContain("New session");
    expect(html).not.toContain("data-quiet");
    expect(html).toContain("<p>Start Claude Code or Codex in a terminal and it appears here.</p>");
    expect(html).toMatch(/<div class="empty-actions" role="group" aria-label="[^"]+"><button type="button" class="btn empty-tour">Take the tour<\/button>/);
    expect(all(EmptyHero(props()), el => el.type === "button").map(textOf)).toEqual(["Take the tour"]);
  });

  it("offers nothing to start while the server is out of reach, whatever it was handed", () => {
    for (const everConnected of [true, false]) {
      const html = hero({ live: false, everConnected, onNewSession: noop });
      expect(html).not.toContain("empty-new");
      expect(html).not.toContain("empty-actions");
    }
  });
});

describe("where App decides it is offered", () => {
  const app = read("../App.tsx");

  it("on what every other New session stands on: the Command Panel on, its platform, its code", () => {
    expect(app).toContain("const canStartSession = stage.enabled && stage.supported !== false && !stage.chunkFailed;");
    expect(app).toContain("onNewSession={canStartSession ? newSessionFromHero : undefined}");
  });

  it("makes the phone's Sessions list give way, as a row's press does, so the pane is seen", () => {
    const fn = /const newSessionFromHero = useCallback\(\(button: HTMLElement\) => \{[\s\S]*?\n {2}\}, \[/.exec(app)?.[0] ?? "";
    expect(fn).not.toBe("");
    expect(fn).toContain("newSessionFromBoard(button);");
    expect(fn).toMatch(/if \(phone && sessionListOpen\) \{\s*paneFromListRef\.current = true;\s*closeSessionListToCanvas\(\);/);
  });

  it("hangs the form off the empty stage's own button, whose id is one constant", () => {
    expect(STAGE_BUTTON_ID).toBe(EMPTY_NEW_SESSION_ID);
    expect(read("../use-stage.ts")).toContain('dispatch({ type: "popover", anchor: EMPTY_NEW_SESSION_ID });');
  });
});

describe("the hero's styles", () => {
  const empty = read("../styles/empty-state.css");
  const guides = read("../styles/guides.css");

  it("gives New session its pointer back, on a hero that lets a drag through", () => {
    expect(empty).toMatch(/\.empty-hero \.empty-new \{[^}]*pointer-events: auto/);
  });

  it("draws the tour quiet only beside New session", () => {
    expect(guides).toMatch(/\.empty-hero \.empty-actions\[data-quiet\] \.empty-tour \{[^}]*border-color: transparent/);
  });

  it("sets the hero upright, where the phone's list would make it italic", () => {
    expect(empty).toMatch(/\.empty-hero \{[^}]*font-style: normal/);
  });
});
