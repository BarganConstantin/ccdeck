// Less to read (V4 top-10 #10), on the surfaces a static render can draw:
// a Settings row is its name and its control on one line, with a muted line
// only where the name does not already say what the control does and a
// Details only where it says more than that line; the empty board is a title,
// one plain line and its actions, with no chevron over them; and a usage
// bar's pace note is quiet text whose warning colour sits on its figure.
// The accounts header's ⋯ menu is opened in v4-read-less-accounts.test.ts.
//
// No DOM in this suite, so the markup is drawn with renderToStaticMarkup.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SettingRow } from "../components/SettingsParts";
import LanguageSection from "../components/LanguageSection";
import SessionsSection from "../components/SessionsSection";
import SessionRecoveryRow, { ContinueStoppedRow } from "../components/SessionRecoverySettings";
import { EmptyHero } from "../components/EmptyHero";
import QuotaBar from "../components/QuotaBar";
import boardEn from "../i18n/areas/board/en";
import { LANGUAGES } from "../i18n";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const noop = () => {};

describe("a Settings row with nothing more to say", () => {
  it("is its name and its control in one row, with no line under the name and no Details", () => {
    const html = renderToStaticMarkup(createElement(SettingRow, {
      settingId: "plain", name: "Plain", nameId: "plain-name",
      control: createElement("button", { type: "button", role: "switch", "aria-checked": false }),
    }));
    // One element holds both, in that order, and nothing wraps it.
    expect(html).toBe(
      '<label class="settings-row" data-setting="plain"><span class="settings-row-name" id="plain-name">Plain</span>'
      + '<span class="settings-row-control"><button type="button" role="switch" aria-checked="false"></button></span></label>',
    );
    expect(html).not.toContain("settings-row-note");
    expect(html).not.toContain("settings-row-details");
    expect(html).not.toContain("settings-row-with-details");
  });

  it("draws a Details only when it is handed one", () => {
    const html = renderToStaticMarkup(createElement(SettingRow, {
      name: "With more", details: "What turning it on costs.", control: createElement("input"),
    }));
    expect(html).toContain('<div class="settings-row-with-details">');
    expect(html).toContain("What turning it on costs.");
  });

  it("Language: one row, under no caption of the same name, with no line under it", () => {
    const html = renderToStaticMarkup(createElement(LanguageSection));
    expect(html).not.toMatch(/<h3/);
    expect(html).not.toContain("settings-row-note");
    expect(html).not.toContain("settings-row-details");
    expect(html).not.toContain("aria-describedby");
    expect(html.match(/class="settings-row"/g)).toHaveLength(1);
    // Every language is still offered.
    expect(html.match(/<option /g)).toHaveLength(LANGUAGES.length);
  });

  it("Sessions: a note on each row, and a Details only on Continue stopped", () => {
    const html = renderToStaticMarkup(createElement(SessionsSection, null,
      createElement(SessionRecoveryRow, { provider: "Claude" }),
      createElement(SessionRecoveryRow, { provider: "Codex" }),
      createElement(ContinueStoppedRow)));
    expect(html.match(/class="settings-row-note"/g)).toHaveLength(4);
    expect(html.match(/<details class="settings-row-details"/g)).toHaveLength(1);
    const details = html.indexOf('<details class="settings-row-details"');
    expect(details).toBeGreaterThan(html.indexOf('data-setting="claude-continue-stopped"'));
  });
});

describe("the empty board", () => {
  const hero = (workspace: string | null = null) => renderToStaticMarkup(createElement(EmptyHero, {
    live: true, everConnected: true, providers: {} as never, workspace, onTour: noop,
  }));

  it("draws no chevron over its title", () => {
    expect(hero()).not.toContain("empty-symbol");
    // The cursor's blink went with it.
    const sheet = read("../styles/empty-state.css");
    expect(sheet).not.toContain("empty-cursor");
    expect(sheet).not.toContain("@keyframes empty-cursor-blink");
  });

  it("says a title and one line, in the new words, then its actions", () => {
    const html = hero();
    expect(boardEn["board.hero.noSessions"]).toBe("No sessions yet");
    expect(boardEn["board.hero.startHint"]).toBe("Start Claude Code or Codex in a terminal and it appears here.");
    expect(html).toContain("<h2>No sessions yet</h2>");
    expect(html).toContain("<p>Start Claude Code or Codex in a terminal and it appears here.</p>");
    expect(html).not.toContain("Waiting for Claude Code or Codex");
    expect(html).not.toContain("subagents");
    // The actions are the ones it had, in their labelled group.
    expect(html).toMatch(/<div class="empty-actions" role="group" aria-label="[^"]+"><button type="button" class="btn empty-tour">Take the tour<\/button>/);
    // The title comes first, the line under it, and the actions after both.
    expect(html.indexOf("<h2>")).toBeLessThan(html.indexOf("Start Claude Code"));
    expect(html.indexOf("Start Claude Code")).toBeLessThan(html.indexOf("empty-actions"));
  });

  it("keeps the scope sentence where the deck watches one folder, under the same title", () => {
    const html = hero("/home/u/project");
    expect(html).toContain("<h2>No sessions yet</h2>");
    expect(html).toContain("<code>/home/u/project</code>");
    expect(html).not.toContain("Start Claude Code or Codex in a terminal");
  });

  it("uses the new keys from source, not the old ones", () => {
    const src = read("../components/EmptyHero.tsx");
    expect(src).toContain('t("board.hero.noSessions")');
    expect(src).toContain('t("board.hero.startHint")');
    expect(src).not.toContain('t("board.hero.waiting")');
    expect(src).not.toContain('t("board.hero.run")');
  });
});

describe("a usage bar's pace note", () => {
  const WINDOW = 18_000, RESET = 18_000, HOUR_LEFT = RESET - 3600;
  const bar = (pct: number) => renderToStaticMarkup(createElement(QuotaBar, {
    label: "5-hour window", resetAt: RESET, windowSec: WINDOW, pct, nowSec: HOUR_LEFT,
  }));
  const note = (html: string) => /<button type="button" class="qb-pace"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";

  it("is not drawn in a colour of its own, in any state", () => {
    for (const pct of [100, 99, 90, 80, 70]) {
      const button = /<button type="button" class="qb-pace"[^>]*>/.exec(bar(pct))?.[0] ?? "";
      expect(button, String(pct)).not.toBe("");
      expect(button, String(pct)).not.toContain("style=");
    }
  });

  it("puts the warning colour on the figure that warns, and on nothing when there is no warning", () => {
    expect(note(bar(99))).toContain('runs out in <span class="qb-pace-figure">2m</span>');
    expect(note(bar(80))).not.toContain("qb-pace-figure");
    expect(note(bar(70))).not.toContain("qb-pace-figure");
    expect(note(bar(100))).not.toContain("qb-pace-figure");
  });

  it("reads as quiet text that still answers a press: muted, underlined only under a pointer", () => {
    const sheet = read("../styles/usage-panel.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.()[\]]/g, "\\$&")} \\{([^}]*)\\}`).exec(sheet)?.[1] ?? "";
    expect(rule(".qb-pace")).toContain("color: var(--muted)");
    expect(rule("button.qb-pace")).toContain("text-decoration: none");
    expect(rule("button.qb-pace")).toContain("cursor: pointer");
    expect(sheet).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{\nbutton\.qb-pace:hover \{ text-decoration: underline; \}\n\}/);
    expect(sheet).toContain("button.qb-pace:active { transform: scale(var(--press)); }");
    expect(rule(".qb-pace-figure")).toContain("color: var(--err)");
  });
});
