// What the agent says on its own screen while it works: the spinner line over
// its input, Claude Code's "✻ Pondering… (12s · esc to interrupt)" and Codex's
// "• Working (12s • esc to interrupt)". Chat's working row shows the words
// ("Pondering…"); the clock is the row's own and the key hint is Term's.
// Pure: a screen's text in, the words or null out. use-screen-status.ts reads
// the live screen the way use-prompt-decision.ts does.
//
// ONLY THAT LINE. The words count only on a line that starts with a spinner
// glyph and ends with the parenthesis that says Esc interrupts: the agent
// draws it while a turn runs and never otherwise, and prose in the
// conversation above it does not look like that. Read from the bottom, so the
// line over the input is found before anything the conversation printed.
import { lead } from "./ask-keys";

/** The spinner's glyphs: Claude Code's cycle and its fallback, Codex's dots and braille. */
const STATUS_LINE = /^[·✢✳✶✻✽*∗•◦●○⠀-⣿]\s+([^()\s][^()]*?)\s*\(([^()]*)\)$/u;
/** The words that prove the line is the working spinner's. */
const INTERRUPT = /\besc to interrupt\b/i;
/** A frame's sides, which some screens draw around the input. */
const SIDES = /^[│┃|]\s?|\s?[│┃|]$/g;
/** The most of the words shown: the spinner's are a word or two. */
export const MAX_STATUS = 48;

/** The agent's own words for what it is doing now, or null when the screen does not show them. */
export function screenStatus(screen: string): string | null {
  const lines = screen.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(SIDES, "").trim();
    const found = STATUS_LINE.exec(line);
    if (!found || !INTERRUPT.test(found[2])) continue;
    const words = lead(found[1], MAX_STATUS);
    return words || null;
  }
  return null;
}
