// V4's tour sends a reader to places by the words those places wear: the
// Needs you group, Settings › Notifications, Reopen here, the Workspace, the
// Inspector, the doors on each edge, More, the Local network row, New
// session. A tour that names a control the page spells differently is a tour
// that sends somebody looking for a word that is not there — #818's bell, in
// every language at once. So each line is held to the catalog entry of the
// thing it names, in each of the ten languages, and a renamed door fails here
// until the tour is renamed with it.
import { describe, it, expect } from "vitest";
import { catalogFor } from "../i18n/catalogs";
import { LANGUAGES } from "../i18n";

/** Each tour key, and the words of the page it must contain. */
const NAMES: [string, (string | { literal: string })[]][] = [
  ["shell.guide.welcome.waiting.line", ["board.railGroup.needs"]],
  ["shell.guide.welcome.waiting.tip", ["board.rail.settings", "settings.section.notifications.label"]],
  ["shell.guide.welcome.terminal.tip", ["board.stage.reopenHere"]],
  ["shell.guide.welcome.workspace.line", ["board.view.workspace", { literal: "Ctrl+`" }]],
  ["shell.guide.welcome.workspace.tip", [{ literal: "Shift+Enter" }]],
  ["shell.guide.welcome.inspector.line", ["board.inspector.label"]],
  ["shell.guide.welcome.inspector.tip", ["board.inspector.label", { literal: "D" }]],
  ["shell.guide.welcome.edges.line", ["board.rail.sessionList.short", "board.rail.accounts", "board.rail.settings", "board.rail.usage", "board.rail.machine.hint"]],
  ["shell.guide.welcome.edges.tip", ["board.rail.more"]],
  ["shell.guide.welcome.accounts.tip", ["lan.entry.name"]],
  ["shell.guide.welcome.start.line", ["board.newSession.title", { literal: "claude" }, { literal: "codex" }]],
];

describe("the V4 tour names each place by the word the page shows (in every language)", () => {
  for (const { code } of LANGUAGES) {
    it(code, () => {
      const c = catalogFor(code);
      for (const [key, words] of NAMES) {
        const line = c[key];
        expect(line, `${code} ${key}`).toBeTypeOf("string");
        for (const word of words) {
          const shown = typeof word === "string" ? c[word] : word.literal;
          expect(shown, `${code} ${String(typeof word === "string" ? word : word.literal)}`).toBeTypeOf("string");
          expect(line, `${code} ${key} names ${typeof word === "string" ? word : "a literal"}`).toContain(shown);
        }
      }
    });
  }
});
