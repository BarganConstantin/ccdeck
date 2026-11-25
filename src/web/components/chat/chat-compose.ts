// What the Chat composer knows besides the draft: the messages sent from it
// (Up and Down bring them back), and the slash commands it offers when a
// message starts with "/". Pure, but for the one store read and write, which
// go through storage.ts.
//
// HISTORY IS PER SESSION. Up on the first line recalls what was sent to THIS
// session, newest first, and Down walks back to the draft you were writing.
// The caret decides: in the middle of the text the arrows move it, as they
// always did. The store keeps HISTORY_CAP messages for each of the
// HISTORY_SESSIONS sessions written to last, and no message longer than
// HISTORY_TEXT_CAP (a long paste stays in the tab, not in the store).
//
// THE SLASH LIST is Claude Code's common built-in commands (names and what
// they do as its commands reference has them) and the commands this session
// already ran. A command that opens a full-screen dialog in Claude Code is
// marked: the pane goes to Term once it is sent, where that dialog is.
import type { MessageKey } from "../../i18n";
import { readStored, writeStored } from "../../storage";
import type { ChatTurn } from "./chat-model";

/** The store key: `{ sessions: [[session, [oldest … newest]], …] }`, the session written to last at the end. */
export const CHAT_HISTORY_KEY = "agent-dag.chatHistory";
/** Messages kept for one session. */
export const HISTORY_CAP = 50;
/** Sessions kept. */
export const HISTORY_SESSIONS = 20;
/** The longest message the store keeps. */
export const HISTORY_TEXT_CAP = 4000;

type Stored = Array<[string, string[]]>;

function readAll(): Stored {
  const raw = readStored(CHAT_HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { sessions?: unknown };
    if (!Array.isArray(parsed?.sessions)) return [];
    return parsed.sessions.filter((row): row is [string, string[]] =>
      Array.isArray(row) && typeof row[0] === "string" && Array.isArray(row[1]) && row[1].every(text => typeof text === "string"));
  } catch {
    return [];
  }
}

/** The messages sent to `session`, oldest first. */
export function readHistory(session: string): string[] {
  return readAll().find(([key]) => key === session)?.[1] ?? [];
}

/** `history` with `text` sent last: a repeat of the last one is not kept twice, and the oldest go past the cap. */
export function withSent(history: readonly string[], text: string): string[] {
  if (!text.trim()) return [...history];
  const kept = history[history.length - 1] === text ? [...history] : [...history, text];
  return kept.slice(-HISTORY_CAP);
}

/** Writes `text` as the last message sent to `session`, and returns that session's history. */
export function rememberSent(session: string, text: string): string[] {
  const all = readAll();
  const at = all.findIndex(([key]) => key === session);
  const mine = withSent(at >= 0 ? all[at][1] : [], text);
  if (at >= 0) all.splice(at, 1);
  const stored = mine.filter(entry => entry.length <= HISTORY_TEXT_CAP);
  all.push([session, stored]);
  writeStored(CHAT_HISTORY_KEY, JSON.stringify({ sessions: all.slice(-HISTORY_SESSIONS) }));
  return mine;
}

/** What Up or Down does in the composer: recall an older message, a newer
 *  one (or the draft), or nothing, which leaves the key to the textarea. */
export function historyMove(
  key: string,
  text: { value: string; start: number; end: number },
  browsing: boolean,
): "older" | "newer" | null {
  const { value, start, end } = text;
  if (start !== end) return null;
  // The caret at either end of the text, never in the middle of it.
  const atEdge = start === 0 || start === value.length;
  if (key === "ArrowUp") {
    if (value === "") return "older";
    return atEdge && !value.slice(0, start).includes("\n") ? "older" : null;
  }
  if (key === "ArrowDown") {
    if (!browsing) return null;
    return atEdge && !value.slice(end).includes("\n") ? "newer" : null;
  }
  return null;
}

/** A built-in command the list offers. `term`: Claude Code answers it with a
 *  full-screen dialog, always or when it has no argument. */
export interface SlashCommand {
  name: string;
  about: MessageKey;
  term?: "always" | "bare";
}

/** Claude Code's common built-ins, most used first (code.claude.com/docs/en/commands). */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "/clear", about: "board.chat.compose.cmd.clear" },
  { name: "/compact", about: "board.chat.compose.cmd.compact" },
  { name: "/context", about: "board.chat.compose.cmd.context" },
  { name: "/model", about: "board.chat.compose.cmd.model", term: "bare" },
  { name: "/review", about: "board.chat.compose.cmd.review" },
  { name: "/init", about: "board.chat.compose.cmd.init" },
  { name: "/plan", about: "board.chat.compose.cmd.plan" },
  { name: "/memory", about: "board.chat.compose.cmd.memory", term: "always" },
  { name: "/usage", about: "board.chat.compose.cmd.usage", term: "always" },
  { name: "/config", about: "board.chat.compose.cmd.config", term: "bare" },
  { name: "/permissions", about: "board.chat.compose.cmd.permissions", term: "always" },
  { name: "/resume", about: "board.chat.compose.cmd.resume", term: "bare" },
  { name: "/rewind", about: "board.chat.compose.cmd.rewind", term: "always" },
  { name: "/mcp", about: "board.chat.compose.cmd.mcp", term: "bare" },
  { name: "/status", about: "board.chat.compose.cmd.status", term: "always" },
  { name: "/help", about: "board.chat.compose.cmd.help", term: "always" },
];

/** One row of the list. */
export interface SlashItem {
  name: string;
  /** What it does; none for a command of the session's own the list does not know. */
  about?: MessageKey;
  /** This session ran it already. */
  used: boolean;
  /** Sent bare, it opens a dialog that only Term shows. */
  term: boolean;
}

/** The slash commands this session ran, the last one first. */
export function usedCommands(turns: readonly ChatTurn[]): string[] {
  const seen: string[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.kind !== "command" || !/^\/\S+$/.test(turn.name) || seen.includes(turn.name)) continue;
    seen.push(turn.name);
  }
  return seen;
}

/** What the list filters by: the draft is a slash and a word being typed, or null. */
export function slashQuery(value: string): string | null {
  const m = /^\/(\S*)$/.exec(value);
  return m ? m[1].toLowerCase() : null;
}

/** The rows for `query`: the session's own commands first, then the built-ins;
 *  names that start with the query before names that only contain it. */
export function slashItems(query: string, used: readonly string[]): SlashItem[] {
  const known = new Map(SLASH_COMMANDS.map(command => [command.name, command]));
  const rows: SlashItem[] = [
    ...used.map(name => ({ name, about: known.get(name)?.about, used: true, term: known.get(name)?.term !== undefined })),
    ...SLASH_COMMANDS.filter(command => !used.includes(command.name))
      .map(command => ({ name: command.name, about: command.about, used: false, term: command.term !== undefined })),
  ];
  const word = (item: SlashItem) => item.name.slice(1).toLowerCase();
  const starts = rows.filter(item => word(item).startsWith(query));
  const contains = query ? rows.filter(item => !word(item).startsWith(query) && word(item).includes(query)) : [];
  return [...starts, ...contains];
}

/** Whether `text`, once sent, is a command whose dialog only Term shows. */
export function opensInTerm(text: string): boolean {
  const m = /^\s*(\/\S+)(\s+\S[\s\S]*)?$/.exec(text);
  if (!m) return false;
  const command = SLASH_COMMANDS.find(c => c.name === m[1]);
  if (!command?.term) return false;
  return command.term === "always" || m[2] === undefined;
}
