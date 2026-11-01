// The two switches in front of the Chat and Decision screens, and nothing else.
//
// OFF BY DEFAULT, AND NOT REACHABLE. Each screen has its own flag, one string in
// the browser's localStorage in the deck's own namespace ("1" is on, anything
// else, or no storage at all, is off), read once at load like use-view.ts reads
// the view. There is no Settings row: a flag nobody can see is the point while
// the data the screens draw does not exist yet.
//
// NO SCREEN CODE HERE. This file imports storage.ts and nothing of
// components/chat/ or components/decision/ (v4-screens-gate.test.ts walks the
// import graph). It is read by the lazy StageShell chunk (StageBody and
// StageHeader), not by the first load; the screens themselves are
// use-screens.ts's one dynamic import, made only with a flag on.
//
// A FLAG IS NOT ENOUGH. A screen is reached only where the Command Panel is
// (the gate Workspace uses) and only in the Workspace view, which a phone never
// has: `screensEffective` is the pair of answers the layout may follow.
import { readStored } from "./storage";

export const CHAT_FLAG_KEY = "agent-dag.chat";
export const DECISION_FLAG_KEY = "agent-dag.decision";

export interface ScreenFlags {
  chat: boolean;
  decision: boolean;
}

export const NO_SCREENS: ScreenFlags = { chat: false, decision: false };

/** What the browser remembered. A key that is anything but "1" is off. */
export function readScreenFlags(read: (key: string) => string | null = readStored): ScreenFlags {
  return {
    chat: read(CHAT_FLAG_KEY) === "1",
    decision: read(DECISION_FLAG_KEY) === "1",
  };
}

export interface ScreenPlace {
  /** The Command Panel's gate: the terminal switch is on and the platform has the panel. */
  gate: boolean;
  /** The layout is the Workspace view. */
  workspace: boolean;
  phone: boolean;
}

/** The flags that count here: both are off unless the gate is on, the view is
 *  Workspace and the window is not a phone. */
export function screensEffective(flags: ScreenFlags, place: ScreenPlace): ScreenFlags {
  if (!place.gate || !place.workspace || place.phone) return NO_SCREENS;
  return flags;
}
