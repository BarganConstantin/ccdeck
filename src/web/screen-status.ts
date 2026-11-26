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
//
// ITS CLOCK, WHEN IT PRINTS ONE. Claude Code counts the work in the same
// parenthesis ("37s", "1m 05s"); screenSpinner hands it on, so a row drawn
// after a refresh or a reconnect counts from when the work began, not from
// when the deck looked.
import { lead } from "./ask-keys";

/** The spinner's glyphs: Claude Code's cycle and its fallback, Codex's dots and braille. */
const STATUS_LINE = /^[·✢✳✶✻✽*∗•◦●○⠀-⣿]\s+([^()\s][^()]*?)\s*\(([^()]*)\)$/u;
/** The words that prove the line is the working spinner's. */
const INTERRUPT = /\besc to interrupt\b/i;
/** A frame's sides, which some screens draw around the input. */
const SIDES = /^[│┃|]\s?|\s?[│┃|]$/g;
/** The most of the words shown: the spinner's are a word or two. */
export const MAX_STATUS = 48;

/** One part of the parenthesis that is a clock: "37s", "1m 05s", "1h 2m". */
const CLOCK = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/;

/** The spinner line as read: its words, and its clock in seconds when it prints one. */
export interface ScreenSpinner {
  words: string;
  seconds?: number;
}

/** The seconds a spinner's parenthesis counts, or undefined when it counts none. */
function spinnerSeconds(parts: string): number | undefined {
  for (const part of parts.split(/[·•]/)) {
    const clock = CLOCK.exec(part.trim());
    if (!clock || (clock[1] ?? clock[2] ?? clock[3]) === undefined) continue;
    return Number(clock[1] ?? 0) * 3600 + Number(clock[2] ?? 0) * 60 + Number(clock[3] ?? 0);
  }
  return undefined;
}

/** The working spinner's line over the input, or null when the screen does not draw one. */
export function screenSpinner(screen: string): ScreenSpinner | null {
  const lines = screen.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(SIDES, "").trim();
    const found = STATUS_LINE.exec(line);
    if (!found || !INTERRUPT.test(found[2])) continue;
    const words = lead(found[1], MAX_STATUS);
    if (!words) return null;
    const seconds = spinnerSeconds(found[2]);
    return seconds === undefined ? { words } : { words, seconds };
  }
  return null;
}

/** The agent's own words for what it is doing now, or null when the screen does not show them. */
export function screenStatus(screen: string): string | null {
  return screenSpinner(screen)?.words ?? null;
}

/** Claude Code's words while it compacts the conversation, by hand (/compact)
 *  or by itself: "Compacting conversation…". */
const COMPACTING = /^compacting\b/i;

/** Whether a spinner's words say the conversation is being compacted. */
export function saysCompacting(words: string): boolean {
  return COMPACTING.test(words);
}
