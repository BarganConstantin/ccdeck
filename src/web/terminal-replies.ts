// The stage's xterm draws a pane; tmux is the pane's terminal, so tmux answers
// — whatever that tmux answers, and xterm the rest.
//
// A program that wants to know something about its terminal — which one it
// is, where the cursor stands, whether a mode is on, what colour the
// background is — writes a query and reads the answer from its input. In a
// tmux pane, tmux is that terminal: its input parser answers the query itself
// (input.c, `input_reply`), into the pane, before any client sees a byte.
// Control mode then hands every client the pane's output RAW (`%output`), the
// query included, and the stage's xterm parses it as if it were the terminal.
// It answers too, through onData, and the deck types that answer into the pane
// with `send-keys`: the program reads a second reply it never asked for — and
// a stray cursor-position report is the worst of them, since `ESC [ 1 ; 5 R`
// is also how a terminal spells Ctrl+F3.
//
// BUT WHAT TMUX ANSWERS DEPENDS ON THE TMUX, and a query nobody answers costs
// more than a timeout: Claude Code decides synchronized output — drawing
// without flicker — from DECRQM ?2026, and goes without it when no reply
// comes. tmux answers that only from 3.7, so on Ubuntu 24.04's 3.4 the stage's
// xterm (which honours BSU/ESU in the raw stream) has to be the one to say
// yes. So the deck tells the panel the tmux SERVER's version as each socket
// opens (`{t:"tmux"}`, terminal-protocol.ts), and each query below is left to
// tmux only where that tmux answers it. Read from input.c of 3.6a and 3.8 and
// from 3.8's CHANGES:
//
//   DA1, DA2, DSR 5n/6n   every version since before 3.2, the deck's floor
//                         (XTVERSION, CSI > q, is tmux's alone: xterm.js 6
//                         does not answer it)
//   DECDSR ?996n          3.6+ (the theme report); xterm.js has no answer.
//                         ?6n (DECXCPR) is answered by no tmux at all, so xterm
//                         always answers it
//   DECRQM, DEC modes     3.6: modes 12, 2004, 1004, 1006 and 2031 only;
//                         3.7+: every mode (3.8 answers 0 for one it does not
//                         know); before 3.6: none
//   DECRQM, ANSI modes    3.7+; none before
//   DECRQSS               3.6+, every request (an unknown one gets `0$r`)
//   OSC 10/11 `?`         3.4+ (from a control client's colours on 3.5+, else
//                         the first attached client's); before that only a
//                         colour the program set inside tmux. A chained `?;?`
//                         is never tmux's: it answers only a lone `?`
//   OSC 12 `?`            only a cursor colour that was set (a program's OSC
//                         12, or the cursor-colour option)
//   OSC 4 `?`             3.3+, only a palette entry set inside tmux (3.6+
//                         asks a real terminal client for the rest, and a
//                         control client is not one)
//
// 3.7 IS INFERRED: there is no 3.7 source here, only its CHANGES entry
// "Respond to DECRQM 2026 … and various others", and 3.8's answer-everything
// code. If 3.7 answers fewer modes than 3.8, those few go unanswered there
// (the program falls back after its timeout, as before this module knew
// versions); if it answers more, a 3.7 program reads one reply, not two.
//
// UNTIL THE VERSION IS KNOWN — the frame comes right after attach, before the
// first seed — every version-dependent query is left to tmux, as if it were
// new: silence costs a timeout, a duplicate costs a phantom keypress.
//
// The colours a program SETS are tracked from the same stream tmux reads (OSC
// 4/10/11/12, and 104/110/111/112 resetting them), because whether tmux
// answers OSC 4 and 12 — and OSC 10/11 before 3.4 — turns on exactly that. A
// colour set before this view attached is not seen, so a program asking back
// a colour it set itself, in a pane opened since, can read two answers; asking
// back what you set is rare, and every other case reads exactly one.
//
// Only the QUERY form of each sequence is ever kept from xterm: OSC 10 with a
// colour still sets the colour, and nothing that draws is touched. Focus
// reports (`CSI I`, `CSI O`) are not answers — they are what the reader did —
// and still go up, as do mouse reports.
import type { TmuxVersion } from "./terminal-protocol";

/** The parser calls this module makes: a subset of xterm's IParser, so a test
 *  can pass a recording fake. A handler returning true ends the sequence there;
 *  false lets xterm's own handler run. */
export interface ReplyParser {
  registerCsiHandler(id: SequenceId, callback: (params: Params) => boolean): Disposable;
  registerDcsHandler(id: SequenceId, callback: (data: string, params: Params) => boolean): Disposable;
  registerOscHandler(ident: number, callback: (data: string) => boolean): Disposable;
}

export interface SequenceId { prefix?: string; intermediates?: string; final: string }
interface Disposable { dispose(): void }
/** xterm's CSI/DCS parameters: one entry per parameter, sub-parameters as an
 *  array. */
type Params = readonly (number | readonly number[])[];

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

/** The OSC sequences that put a colour back to the terminal's own. */
export const RESET_OSC: readonly number[] = [104, 110, 111, 112];

/** The DEC modes tmux 3.6 answers DECRQM for (input.c, INPUT_CSI_QUERY_PRIVATE). */
export const TMUX_36_DEC_MODES: ReadonlySet<number> = new Set([12, 2004, 1004, 1006, 2031]);

/** Whether an OSC colour sequence asks rather than sets. OSC 4 is a list of
 *  `index;colour` pairs and OSC 10 may chain `?;?`, so any `?` among the
 *  fields makes it a question. */
export function asksColour(data: string): boolean {
  return data.split(";").includes("?");
}

const atLeast = (v: TmuxVersion | null, major: number, minor: number) =>
  v === null || v[0] > major || (v[0] === major && v[1] >= minor);

const firstParam = (params: Params): number => {
  const p = params[0];
  return typeof p === "number" ? p : Array.isArray(p) && typeof p[0] === "number" ? p[0] : 0;
};

/**
 * Whether tmux `v` answers this question itself — so xterm must not. `null`
 * is a version not known yet, which leaves every version-dependent query to
 * tmux. Pure; the colour facts are the program's own sets this view has seen.
 */
export function tmuxAnswers(
  query:
    | { kind: "da" | "dsr" }
    | { kind: "decdsr" | "decrqm-dec" | "decrqm-ansi"; mode: number }
    | { kind: "decrqss" }
    | { kind: "osc"; ident: 10 | 11 | 12; data: string; set: boolean }
    | { kind: "osc4"; asked: readonly number[]; set: ReadonlySet<number> },
  v: TmuxVersion | null,
): boolean {
  switch (query.kind) {
    case "da":
    case "dsr":
      return true;
    case "decdsr":
      // tmux answers ?996 (3.6+) and no other; xterm.js answers ?6, not 996.
      return query.mode === 996;
    case "decrqm-dec":
      if (atLeast(v, 3, 7)) return true;
      return atLeast(v, 3, 6) && TMUX_36_DEC_MODES.has(query.mode);
    case "decrqm-ansi":
      return atLeast(v, 3, 7);
    case "decrqss":
      return atLeast(v, 3, 6);
    case "osc":
      if (query.data !== "?") return false;
      if (query.ident === 12) return query.set;
      return query.set || atLeast(v, 3, 4);
    case "osc4":
      return atLeast(v, 3, 3) && query.asked.length > 0 && query.asked.every(i => query.set.has(i));
  }
}

/** The palette indices an OSC 4 body asks about, and the ones it sets. */
function paletteFields(data: string): { asked: number[]; set: number[] } {
  const fields = data.split(";");
  const asked: number[] = [];
  const set: number[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const idx = Number(fields[i]);
    if (!Number.isInteger(idx) || idx < 0 || idx > 255) continue;
    (fields[i + 1] === "?" ? asked : set).push(idx);
  }
  return { asked, set };
}

/** The handle mountXterm keeps: the version to answer as, and the way out. */
export interface TmuxReplies extends Disposable {
  /** The tmux server the pane lives in, as the deck reported it; null when a
   *  new connection has not said yet. */
  setTmux(version: TmuxVersion | null): void;
}

/** Keep xterm from answering what this pane's tmux answers for it. */
export function leaveRepliesToTmux(parser: ReplyParser): TmuxReplies {
  let version: TmuxVersion | null = null;
  // The colours the program set in the stream since this view attached.
  const palette = new Set<number>();
  const colours = { 10: false, 11: false, 12: false } as Record<10 | 11 | 12, boolean>;

  const csi = (id: SequenceId, ask: (params: Params) => boolean) => parser.registerCsiHandler(id, ask);
  const kept: Disposable[] = [
    csi(QUERY_CSI[0], () => tmuxAnswers({ kind: "da" }, version)),
    csi(QUERY_CSI[1], () => tmuxAnswers({ kind: "da" }, version)),
    csi(QUERY_CSI[2], () => tmuxAnswers({ kind: "dsr" }, version)),
    csi(QUERY_CSI[3], p => tmuxAnswers({ kind: "decdsr", mode: firstParam(p) }, version)),
    csi(QUERY_CSI[4], p => tmuxAnswers({ kind: "decrqm-ansi", mode: firstParam(p) }, version)),
    csi(QUERY_CSI[5], p => tmuxAnswers({ kind: "decrqm-dec", mode: firstParam(p) }, version)),
    parser.registerDcsHandler(QUERY_DCS[0], () => tmuxAnswers({ kind: "decrqss" }, version)),
    parser.registerOscHandler(4, data => {
      const { asked, set } = paletteFields(data);
      for (const i of set) palette.add(i);
      return asked.length > 0 && tmuxAnswers({ kind: "osc4", asked, set: palette }, version);
    }),
    ...([10, 11, 12] as const).map(ident => parser.registerOscHandler(ident, data => {
      if (!asksColour(data)) {
        colours[ident] = true;
        return false;
      }
      return tmuxAnswers({ kind: "osc", ident, data, set: colours[ident] }, version);
    })),
    parser.registerOscHandler(104, data => {
      if (data === "") palette.clear();
      else for (const f of data.split(";")) palette.delete(Number(f));
      return false;
    }),
    ...([110, 111, 112] as const).map(ident => parser.registerOscHandler(ident, () => {
      colours[(ident - 100) as 10 | 11 | 12] = false;
      return false;
    })),
  ];
  return {
    setTmux: v => { version = v; },
    dispose: () => { for (const d of kept) d.dispose(); },
  };
}
