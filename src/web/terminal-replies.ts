// The stage's xterm draws a pane; tmux is the pane's terminal, so tmux answers.
//
// A program that wants to know something about its terminal — which one it
// is, where the cursor stands, whether a mode is on, what colour the
// background is — writes a query and reads the answer from its input. In a
// tmux pane, tmux is that terminal: its input parser answers the query itself
// (input.c, `input_reply`), into the pane, before any client sees a byte.
// Control mode then hands every client the pane's output RAW (`%output`), the
// query included, and the stage's xterm parses it as if it were the terminal.
// It answers too, through onData, and the deck types that answer into the pane
// with `send-keys`: the program reads a second reply it never asked for.
//
// Measured on 2026-10-16, tmux 3.8 and xterm.js 6.0.0 fed the same bytes:
// tmux answered DA1, DA2, DSR 5n, CPR 6n, XTVERSION, DECRQM (ANSI and DEC),
// DECRQSS, and OSC 10/11 while a client was attached; xterm answered DA1,
// DA2, DSR, CPR, DECXCPR, DECRQM, DECRQSS and OSC 4/10/11/12. Every overlap was
// a duplicate in the program's input, and a stray cursor-position report is
// the worst of them: `ESC [ 1 ; 5 R` is also how a terminal spells Ctrl+F3, so
// a TUI reading one it did not ask for sees a keypress.
//
// So xterm answers nothing. A query tmux 3.2 (the deck's floor) does not
// answer yet — DECRQM before 3.6, OSC 10/11 before 3.4 — goes unanswered here,
// exactly as it would in any terminal running that tmux; the program falls
// back after its own timeout, which is what it does under tmux everywhere.
// Only the QUERY form of each sequence is kept from xterm: OSC 10 with a
// colour still sets the colour, and nothing that draws is touched.
//
// Focus reports (`CSI I`, `CSI O`) are not answers — they are what the reader
// did — and still go up, as do mouse reports.

/** The parser calls this module makes: a subset of xterm's IParser, so a test
 *  can pass a recording fake. A handler returning true ends the sequence there;
 *  false lets xterm's own handler run. */
export interface ReplyParser {
  registerCsiHandler(id: SequenceId, callback: (params: unknown) => boolean): Disposable;
  registerDcsHandler(id: SequenceId, callback: (data: string, params: unknown) => boolean): Disposable;
  registerOscHandler(ident: number, callback: (data: string) => boolean): Disposable;
}

export interface SequenceId { prefix?: string; intermediates?: string; final: string }
interface Disposable { dispose(): void }

/** The CSI sequences that are only ever questions. */
export const QUERY_CSI: readonly SequenceId[] = [
  { final: "c" }, // DA1: which terminal is this
  { prefix: ">", final: "c" }, // DA2: its version
  { final: "n" }, // DSR: 5 is "are you there", 6 "where is the cursor"
  { prefix: "?", final: "n" }, // DECDSR: ?6 is the cursor again, ?996 the theme
  { intermediates: "$", final: "p" }, // DECRQM, ANSI modes
  { prefix: "?", intermediates: "$", final: "p" }, // DECRQM, DEC private modes
];

/** DECRQSS: "what is this setting" — DCS $ q … ST. */
export const QUERY_DCS: readonly SequenceId[] = [{ intermediates: "$", final: "q" }];

/** The OSC colours a program may ask for with `?` in place of a colour: the
 *  palette (4), foreground (10), background (11) and cursor (12). */
export const COLOUR_OSC: readonly number[] = [4, 10, 11, 12];

/** Whether an OSC colour sequence asks rather than sets. OSC 4 is a list of
 *  `index;colour` pairs and OSC 10 may chain `?;?`, so any `?` among the
 *  fields makes it a question. */
export function asksColour(data: string): boolean {
  return data.split(";").includes("?");
}

/** Keep xterm from answering what tmux answers for the pane. */
export function leaveRepliesToTmux(parser: ReplyParser): Disposable {
  const kept: Disposable[] = [
    ...QUERY_CSI.map(id => parser.registerCsiHandler(id, () => true)),
    ...QUERY_DCS.map(id => parser.registerDcsHandler(id, () => true)),
    ...COLOUR_OSC.map(ident => parser.registerOscHandler(ident, asksColour)),
  ];
  return { dispose: () => { for (const d of kept) d.dispose(); } };
}
