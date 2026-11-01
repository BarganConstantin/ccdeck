// The Decision card's keys, held against the one function that reads them, the
// way v4-status-bar.test.ts holds the bar's table against its handler: a row
// in the sheet or a hint in the bar cannot outlive its key. And the two
// promises that keep a stray key harmless: the digits follow Settings ›
// Keyboard's switch, and the card never takes focus by itself.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  DECISION_GROUP_TITLE, DECISION_HINTS, DECISION_KEY_GROUP, decisionEventFor, decisionKeyGroup, decisionStatusView,
} from "../components/decision/decision-keys";
import { KEY_HELP, documentedKeys, keyHelpFor } from "../key-help";
import { BOARD_HINTS, DECK_HINTS, statusViewFor } from "../status-hints";
import { isCharacterKey } from "../single-key-shortcuts";

const web = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(web, rel), "utf8");

describe("every key the tables name does what it says", () => {
  const binds = (rows: ReadonlyArray<{ binds: readonly string[] }>) => rows.flatMap(r => r.binds);

  it("the sheet's rows and the bar's hints name the same keys", () => {
    expect([...new Set(binds(DECISION_KEY_GROUP.rows))].sort()).toEqual([...new Set(binds(DECISION_HINTS))].sort());
  });

  it("each bound key is read by decisionEventFor (with three rows, and the switch on)", () => {
    for (const key of binds(DECISION_KEY_GROUP.rows)) {
      expect(decisionEventFor({ key }, true, 3), key).not.toBeNull();
    }
  });

  it("reads digits as picks, the arrows and Tab as moves, Enter as submit, Esc as escape", () => {
    expect(decisionEventFor({ key: "1" }, true, 3)).toEqual({ type: "pick", index: 0 });
    expect(decisionEventFor({ key: "3" }, true, 3)).toEqual({ type: "pick", index: 2 });
    expect(decisionEventFor({ key: "ArrowDown" }, true, 3)).toEqual({ type: "move", by: 1 });
    expect(decisionEventFor({ key: "ArrowUp" }, true, 3)).toEqual({ type: "move", by: -1 });
    expect(decisionEventFor({ key: "Tab" }, true, 3)).toEqual({ type: "move", by: 1 });
    expect(decisionEventFor({ key: "Tab", shiftKey: true }, true, 3)).toEqual({ type: "move", by: -1 });
    expect(decisionEventFor({ key: "Enter" }, true, 3)).toEqual({ type: "submit" });
    expect(decisionEventFor({ key: "Escape" }, true, 3)).toEqual({ type: "escape" });
  });

  it("reads nothing else, and no chord", () => {
    for (const key of ["4", "0", "a", " ", "Delete", "j", "k", "n"]) expect(decisionEventFor({ key }, true, 3), key).toBeNull();
    expect(decisionEventFor({ key: "1", ctrlKey: true }, true, 3)).toBeNull();
    expect(decisionEventFor({ key: "1", metaKey: true }, true, 3)).toBeNull();
    expect(decisionEventFor({ key: "1", altKey: true }, true, 3)).toBeNull();
  });

  it("reads a digit only for a row that exists", () => {
    expect(decisionEventFor({ key: "3" }, true, 2)).toBeNull();
    expect(decisionEventFor({ key: "2" }, true, 2)).toEqual({ type: "pick", index: 1 });
  });
});

describe("the single-key switch", () => {
  it("silences the digits and keeps the named keys", () => {
    for (const key of ["1", "2", "3"]) expect(decisionEventFor({ key }, false, 3), key).toBeNull();
    for (const key of ["ArrowUp", "ArrowDown", "Tab", "Enter", "Escape"]) expect(decisionEventFor({ key }, false, 3), key).not.toBeNull();
  });

  it("takes the digits out of the bar and the sheet too, so neither names a dead key", () => {
    expect(decisionStatusView(false).hints.flatMap(h => h.binds).some(isCharacterKey)).toBe(false);
    expect(decisionKeyGroup(false).rows.flatMap(r => r.binds).some(isCharacterKey)).toBe(false);
    expect(decisionStatusView(true).hints).toHaveLength(4);
    expect(decisionKeyGroup(true).rows).toHaveLength(4);
  });

  it("says the bar's words: 1 to 3 pick and send, move, send, close", () => {
    const hints = decisionStatusView(true).hints;
    expect(hints.map(h => h.word)).toEqual(["pick and send", "move", "send", "close"]);
    expect(hints[0].caps[0]).toEqual({ text: "1–3", spoken: "1 to 3" });
  });
});

describe("with the flags off nothing names a Decision key", () => {
  it("the deck's own tables carry no Decision group, hint or word", () => {
    expect(KEY_HELP.map(g => g.title)).not.toContain(DECISION_GROUP_TITLE);
    expect(keyHelpFor(true, undefined, true).map(g => g.title)).not.toContain(DECISION_GROUP_TITLE);
    for (const view of [BOARD_HINTS, DECK_HINTS]) expect(view.map(h => h.word)).not.toContain("pick and send");
    const bar = statusViewFor({ stageOpen: true, pane: null, onCard: false, zoomedOut: false, singleKeys: true, platform: "linux", viewChord: "workspace" });
    expect(bar.layer).not.toBe("decision");
    expect(bar.hints.map(h => h.word)).not.toContain("pick and send");
  });

  it("the sheet and the bar get the Decision words only by prop; first-load files do not name them", () => {
    for (const file of ["key-help.ts", "status-hints.ts", "components/StatusBar.tsx", "components/KeyboardHelp.tsx"]) {
      const text = read(file);
      expect(text, file).not.toMatch(/decision-keys|components\/decision/);
      expect(text, file).not.toContain("pick and send");
    }
    expect(read("components/StatusBar.tsx")).toContain("extra?:");
    expect(read("components/KeyboardHelp.tsx")).toContain("extraGroups?:");
  });

  it("the documented keys of the deck do not claim the digits", () => {
    const documented = documentedKeys();
    for (const key of ["1", "2", "3"]) expect(documented.has(key), key).toBe(false);
  });
});

describe("the card does not take focus", () => {
  it("never focuses an element on its own: focus() is called only after a key or a field opening", () => {
    const card = read("components/decision/DecisionCard.tsx").replace(/\/\/.*$/gm, "");
    const calls = [...card.matchAll(/\.focus\(\)/g)].length;
    expect(calls).toBe(2);
    // The row's focus follows the ring only once a key moved it (ring.current), and the field's only in free mode.
    expect(card).toMatch(/if \(state\.focus != null && ring\.current\) rows\.current\[state\.focus\]\?\.focus\(\);/);
    expect(card).toMatch(/if \(state\.mode === "free"\) input\.current\?\.focus\(\);/);
    expect(card).not.toMatch(/autoFocus/);
  });

  it("answers keys only from inside its own group, and stops the ones it handles", () => {
    const card = read("components/decision/DecisionCard.tsx");
    expect(card).toMatch(/role="group"\s+aria-labelledby=\{titleId\}\s+onKeyDown=\{onKeyDown\}/);
    expect(card).not.toMatch(/addEventListener\("keydown"/);
    expect(card).toMatch(/e\.preventDefault\(\);\s*e\.stopPropagation\(\);/);
  });
});
