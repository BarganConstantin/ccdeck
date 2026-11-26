// The agent's own words for what it is doing, read off its screen
// (screen-status.ts) for Chat's working row: the spinner line over the input,
// only while it says Esc interrupts, read from the bottom.
import { describe, expect, it } from "vitest";
import { MAX_CHOICE, MAX_STATUS, saysCompacting, screenMenu, screenSpinner, screenStatus } from "../screen-status";

const screen = (...lines: string[]) => lines.join("\n");

describe("the spinner line", () => {
  it("is Claude Code's, in each of the shapes it draws", () => {
    expect(screenStatus(screen("⏺ Reading the tests.", "", "✻ Pondering… (12s · ↑ 340 tokens · esc to interrupt)", "", "╭────╮", "│ >  │", "╰────╯"))).toBe("Pondering…");
    expect(screenStatus("✶ Moseying… (esc to interrupt)")).toBe("Moseying…");
    expect(screenStatus("· Wibbling… (esc to interrupt · ctrl+t to show todos)")).toBe("Wibbling…");
    expect(screenStatus("✳ Compacting conversation… (esc to interrupt · 37s · ↓ 1.2k tokens)")).toBe("Compacting conversation…");
    expect(screenStatus("  ✢ Thinking… (Esc to interrupt)  ")).toBe("Thinking…");
  });

  it("is Codex's too", () => {
    expect(screenStatus(screen("• Ran npm test", "", "• Working (12s • esc to interrupt)", "", "▌ Ask Codex to do anything"))).toBe("Working");
    expect(screenStatus("◦ Exploring (3s • Esc to interrupt)")).toBe("Exploring");
  });

  it("is the lowest one on the screen", () => {
    expect(screenStatus(screen("✻ Pondering… (2s · esc to interrupt)", "", "✽ Brewing… (9s · esc to interrupt)"))).toBe("Brewing…");
  });

  it("is read inside a frame's sides", () => {
    expect(screenStatus("│ ✻ Pondering… (12s · esc to interrupt) │")).toBe("Pondering…");
  });
});

describe("what is not the spinner line", () => {
  it("an idle screen, or the hint alone", () => {
    expect(screenStatus(screen("⏺ Done.", "", "╭────╮", "│ >  │", "╰────╯", "  ? for shortcuts"))).toBeNull();
    expect(screenStatus("")).toBeNull();
    expect(screenStatus("esc to interrupt")).toBeNull();
  });

  it("prose in the conversation, a list item, or a spinner without its hint", () => {
    expect(screenStatus("⏺ Press Esc (esc to interrupt) to stop it.")).toBeNull();
    expect(screenStatus("* Add the limiter (see routes.ts)")).toBeNull();
    expect(screenStatus("✻ Pondering… (12s · ↑ 340 tokens)")).toBeNull();
    expect(screenStatus("✻ Pondering… (esc to")).toBeNull();
  });

  it("keeps the words to a line's worth", () => {
    const words = screenStatus(`✻ ${"word ".repeat(30)}(esc to interrupt)`)!;
    expect(words.length).toBeLessThanOrEqual(MAX_STATUS);
    expect(words.startsWith("word word")).toBe(true);
  });
});

describe("the spinner's clock", () => {
  it("is the parenthesis' own count of the work, in seconds, wherever it sits in it", () => {
    expect(screenSpinner("✳ Compacting conversation… (esc to interrupt · 37s · ↓ 1.2k tokens)")).toEqual({ words: "Compacting conversation…", seconds: 37 });
    expect(screenSpinner("✻ Pondering… (1m 05s · ↑ 340 tokens · esc to interrupt)")).toEqual({ words: "Pondering…", seconds: 65 });
    expect(screenSpinner("• Working (1h 2m • esc to interrupt)")).toEqual({ words: "Working", seconds: 3720 });
  });

  it("is left out when the line counts none, and a count of tokens is not one", () => {
    expect(screenSpinner("✶ Moseying… (esc to interrupt)")).toEqual({ words: "Moseying…" });
    expect(screenSpinner("✶ Moseying… (↓ 12 tokens · esc to interrupt)")).toEqual({ words: "Moseying…" });
  });

  it("goes with the line: a screen without one has neither", () => {
    expect(screenSpinner(screen("⏺ Done.", "", "> "))).toBeNull();
    expect(screenSpinner("✻ Pondering… (12s · ↑ 340 tokens)")).toBeNull();
  });
});

describe("a compaction's words", () => {
  it("are Claude Code's, by hand or by itself", () => {
    expect(saysCompacting("Compacting conversation…")).toBe(true);
    expect(saysCompacting("compacting")).toBe(true);
  });

  it("are not another spinner's, nor a word that only starts the same", () => {
    expect(saysCompacting("Pondering…")).toBe(false);
    expect(saysCompacting("Compactingly…")).toBe(false);
    expect(saysCompacting("Not compacting")).toBe(false);
  });
});

// A choice Claude Code draws itself that the transcript does not hold: Chat
// says it waits in Term, with the choices as words (screenMenu).
const SAVE_MENU = [
  "⏺ Here is the agent I wrote for you: reviewer.md",
  "",
  "────────────────────────────────────────────────────────",
  " Save this agent?",
  "",
  " ❯ 1. Looks good — save it",
  "   2. Discard and exit",
  "",
  " Enter to confirm · Esc to cancel",
].join("\n");

describe("a menu at the foot of the screen", () => {
  it("is read with its choices, in order", () => {
    expect(screenMenu(SAVE_MENU)).toEqual(["Looks good — save it", "Discard and exit"]);
  });

  it("with the pointer on any row, inside a frame's sides, or Codex's pointer", () => {
    expect(screenMenu(screen("│ Pick a model │", "│   1. Default │", "│ ❯ 2. Opus    │", "│   3. Haiku   │", "╰──────────────╯"))).toEqual(["Default", "Opus", "Haiku"]);
    expect(screenMenu(screen("Allow this command?", "› 1. Yes, proceed", "  2. No, and tell Codex what to do differently", "", "Press enter to confirm or esc to cancel")))
      .toEqual(["Yes, proceed", "No, and tell Codex what to do differently"]);
  });

  it("keeps its rows' words, not their notes, their boxes, or more than a label's length", () => {
    const menu = screenMenu(screen(
      " ❯ 1. [ ] Unit tests",
      "      Run the fast suite first",
      "   2. [x] Browser checks",
      `   3. ${"a very long choice ".repeat(6)}`,
      "",
      " Enter to select · Esc to cancel",
    ))!;
    expect(menu.slice(0, 2)).toEqual(["Unit tests", "Browser checks"]);
    expect(menu[2].length).toBeLessThanOrEqual(MAX_CHOICE);
    expect(menu[2].endsWith("…")).toBe(true);
  });
});

describe("what is not a menu", () => {
  it("a numbered list the conversation printed: no row has the pointer", () => {
    expect(screenMenu(screen(
      "⏺ Three steps:",
      "  1. Add the limiter",
      "  2. Test it",
      "  3. Ship it",
      "",
      "> ",
      "  ? for shortcuts",
    ))).toBeNull();
  });

  it("a menu scrolled away under newer output", () => {
    expect(screenMenu(screen(
      " ❯ 1. Looks good — save it",
      "   2. Discard and exit",
      "",
      "⏺ Saved reviewer.md.",
      "⏺ Bash(npm test)",
      "  ⎿  12 passed",
      "⏺ Done. The agent runs on every review.",
      "  It reads the diff first.",
      "",
      "> ",
      "  ? for shortcuts",
    ))).toBeNull();
  });

  it("a list with the pointer on two rows, one row alone, or one not starting at 1", () => {
    expect(screenMenu(screen("❯ 1. Yes", "❯ 2. No"))).toBeNull();
    expect(screenMenu(screen("Continue?", "❯ 1. Yes", "", "Esc to cancel"))).toBeNull();
    expect(screenMenu(screen("❯ 2. Yes", "  3. No"))).toBeNull();
  });

  it("an idle screen or none", () => {
    expect(screenMenu(screen("⏺ Done.", "", "╭────╮", "│ >  │", "╰────╯", "  ? for shortcuts"))).toBeNull();
    expect(screenMenu("")).toBeNull();
  });
});
