// The one line Settings shows under its page head when a write is refused
// (V4's failed write): what went wrong, the repair the deck can make from here
// when the server offers one (settings-give-back.ts), and a dismiss.
//
// A store outside React, so a write made anywhere in Settings — a section's own
// switch, the shared Claude Code writer, the hooks App hands down — reaches the
// one line the dialog draws, without a provider every section would have to sit
// under. The dialog empties it when it opens, when the section changes and when
// it closes, so a refusal is only ever said on the page it happened on.
//
// A write that takes clears it: the line asked the reader to try again, and
// they did.
import { useSyncExternalStore } from "react";
import { refusalLine, type SettingsLine } from "./settings-give-back";
import { t as tNow, type TFunction } from "./i18n";

/** What the line says, and a count that tells two equal refusals apart, so the
 *  dialog draws the second as a new alert and a screen reader says it again. */
export interface SettingsFailure { line: SettingsLine; serial: number }

let current: SettingsFailure | null = null;
let serial = 0;
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

/** The line on show, or null. */
export function settingsFailure(): SettingsFailure | null {
  return current;
}

/** Say `line` under the page head, or take the line away with null. */
export function setSettingsFailure(line: SettingsLine | null): void {
  if (line === null && current === null) return;
  current = line === null ? null : { line, serial: ++serial };
  for (const onChange of listeners) onChange();
}

/** What the line says once its own press has an answer: the same line, so
 *  focus that was on the press is handed on inside it (SettingsFailureLine). */
export function answerSettingsFailure(line: SettingsLine): void {
  current = { line, serial: current?.serial ?? ++serial };
  for (const onChange of listeners) onChange();
}

/** A refused save, in V4's words, with the server's answer when there is one
 *  (`out`, the body of the refusal) so the give-back press is offered where the
 *  server says it would help. */
export function refuseSave(out?: Parameters<typeof refusalLine>[1], t: TFunction = tNow): void {
  setSettingsFailure(refusalLine(t("settings.failure.save"), out));
}

export function useSettingsFailure(): SettingsFailure | null {
  return useSyncExternalStore(subscribe, settingsFailure, settingsFailure);
}
