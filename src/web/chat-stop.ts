// The Stop button in Chat's composer: Esc, sent the way a question's answer is
// (use-terminal-session.ts sendAsk), so it goes only once the live screen
// shows what this step expects.
//
// WHY THESE WORDS. Claude Code's footer says "esc to interrupt" while it works,
// built from its chat:cancel key (Esc unless rebound). Seeing them proves both
// that it is working on something and that Esc is the key that stops it. A
// rebound key draws other words and an idle prompt draws none, so the wait
// runs out and nothing is sent ("changed").
import type { AskStep } from "./ask-keys";

/** What Claude Code's footer says while Esc would stop it. */
export const STOP_WORDS = "esc to interrupt";

/** The one step that stops Claude Code: Esc, once the screen shows STOP_WORDS. */
export function stopSteps(): AskStep[] {
  return [{ expect: [STOP_WORDS], keys: [{ input: "\x1b" }] }];
}
