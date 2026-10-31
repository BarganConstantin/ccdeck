// The stage's xterm answers what the pane's tmux does not, and nothing tmux
// does (terminal-replies.ts) — which depends on the tmux server's version, as
// read from input.c of 3.6a and 3.8: see the module's header. Run here
// against a parser that dispatches the way xterm's does: the newest handler
// first, and the first one that returns true ends the sequence, so xterm's
// own (the reply) never runs.
import { describe, expect, it } from "vitest";
import {
  COLOUR_OSC, QUERY_CSI, QUERY_DCS, RESET_OSC, TMUX_36_DEC_MODES, asksColour, leaveRepliesToTmux, tmuxAnswers,
  type SequenceId,
} from "../terminal-replies";
import { VIEW_KINDS, type ViewKind } from "../terminal-protocol";

type Handler = (...args: never[]) => boolean;
const idKey = (id: SequenceId) => `${id.prefix ?? ""}|${id.intermediates ?? ""}|${id.final}`;

/** xterm's dispatch, with xterm's own handler at the bottom of every stack
 *  recording a reply. */
function parser() {
  const stacks = new Map<string, Handler[]>();
  const replied: string[] = [];
  const own = (name: string) => () => { replied.push(name); return true; };
  const push = (key: string, h: Handler) => {
    const s = stacks.get(key) ?? [];
    s.push(h);
    stacks.set(key, s);
    return { dispose: () => { const i = s.indexOf(h); if (i >= 0) s.splice(i, 1); } };
  };
  const dispatch = (key: string, ...args: unknown[]) => {
    const s = stacks.get(key) ?? [];
    for (let i = s.length - 1; i >= 0; i--) if ((s[i] as (...a: unknown[]) => boolean)(...args)) return;
  };
  // What xterm registers for these sequences, each of which replies.
  for (const id of QUERY_CSI) push(`csi:${idKey(id)}`, own(`csi ${idKey(id)}`));
  for (const id of QUERY_DCS) push(`dcs:${idKey(id)}`, own(`dcs ${idKey(id)}`));
  for (const n of [...COLOUR_OSC, ...RESET_OSC]) push(`osc:${n}`, own(`osc ${n}`));
  // And what it registers for sequences that only draw or set.
  push(`csi:${idKey({ intermediates: " ", final: "q" })}`, own("cursor style"));
  push(`csi:${idKey({ final: "u" })}`, own("restore cursor"));
  return {
    replied,
    api: {
      registerCsiHandler: (id: SequenceId, cb: Handler) => push(`csi:${idKey(id)}`, cb),
      registerDcsHandler: (id: SequenceId, cb: Handler) => push(`dcs:${idKey(id)}`, cb),
      registerOscHandler: (n: number, cb: Handler) => push(`osc:${n}`, cb),
    },
    csi: (id: SequenceId, params: unknown[] = []) => dispatch(`csi:${idKey(id)}`, params),
    dcs: (id: SequenceId, data = "m") => dispatch(`dcs:${idKey(id)}`, data, []),
    osc: (n: number, data: string) => dispatch(`osc:${n}`, data),
  };
}

describe("what the stage's xterm answers", () => {
  it("names every query xterm.js 6 answers and tmux answers too", () => {
    expect(QUERY_CSI.map(idKey).sort()).toEqual(["|$|p", "||c", "||n", ">||c", "?|$|p", "?||n"].sort());
    expect(QUERY_DCS.map(idKey)).toEqual(["|$|q"]);
    expect([...COLOUR_OSC]).toEqual([4, 10, 11, 12]);
  });

  const DA1 = { final: "c" }, DA2 = { prefix: ">", final: "c" }, DSR = { final: "n" }, DECDSR = { prefix: "?", final: "n" };
  const RQM_ANSI = { intermediates: "$", final: "p" }, RQM_DEC = { prefix: "?", intermediates: "$", final: "p" };
  const RQSS = { intermediates: "$", final: "q" };

  /** Every question, against a pane on tmux `v`: what xterm answered. */
  function ask(v: readonly [number, number] | null | "unset") {
    const p = parser();
    const replies = leaveRepliesToTmux(p.api);
    if (v !== "unset") replies.setTmux(v);
    p.csi(DA1); p.csi(DA2); p.csi(DSR, [5]); p.csi(DSR, [6]);
    p.csi(DECDSR, [996]); p.csi(DECDSR, [6]);
    p.csi(RQM_DEC, [2026]); p.csi(RQM_DEC, [2004]); p.csi(RQM_ANSI, [4]);
    p.dcs(RQSS, " q");
    p.osc(10, "?"); p.osc(11, "?"); p.osc(10, "?;?"); p.osc(12, "?"); p.osc(4, "1;?");
    return p.replied;
  }

  it("on tmux 3.8 answers only what no tmux answers: DECXCPR, a chained colour question, OSC 12 and 4 nobody set", () => {
    expect(ask([3, 8])).toEqual(["csi ?||n", "osc 10", "osc 12", "osc 4"]);
  });

  it("on tmux 3.6 also answers DECRQM for every mode but 3.6's five, and the ANSI modes", () => {
    expect(ask([3, 6])).toEqual(["csi ?||n", "csi ?|$|p", "csi |$|p", "osc 10", "osc 12", "osc 4"]);
    for (const mode of TMUX_36_DEC_MODES) {
      const p = parser();
      leaveRepliesToTmux(p.api).setTmux([3, 6]);
      p.csi(RQM_DEC, [mode]);
      expect(p.replied, `?${mode}`).toEqual([]);
    }
  });

  it("on tmux 3.4 answers DECRQM and DECRQSS as well, so Claude Code hears ?2026 and draws synchronized", () => {
    expect(ask([3, 4])).toEqual(["csi ?||n", "csi ?|$|p", "csi ?|$|p", "csi |$|p", "dcs |$|q", "osc 10", "osc 12", "osc 4"]);
  });

  it("on tmux 3.3 answers the colours too, which tmux 3.3 answers only once a program set them", () => {
    expect(ask([3, 3])).toEqual(["csi ?||n", "csi ?|$|p", "csi ?|$|p", "csi |$|p", "dcs |$|q", "osc 10", "osc 11", "osc 10", "osc 12", "osc 4"]);
  });

  it("until the deck says which tmux, leaves every version-dependent question to tmux, as a new one would", () => {
    expect(ask("unset")).toEqual(["csi ?||n", "osc 10", "osc 12", "osc 4"]);
    expect(ask(null)).toEqual(ask("unset"));
  });

  it("follows the version as it changes, and back to unknown", () => {
    const p = parser();
    const replies = leaveRepliesToTmux(p.api);
    replies.setTmux([3, 4]);
    p.csi(RQM_DEC, [2026]);
    replies.setTmux([3, 8]);
    p.csi(RQM_DEC, [2026]);
    replies.setTmux(null);
    p.csi(RQM_DEC, [2026]);
    expect(p.replied).toEqual(["csi ?|$|p"]);
  });

  it("leaves to tmux a colour the program set, and gives it back once the program resets it", () => {
    const p = parser();
    const replies = leaveRepliesToTmux(p.api);
    replies.setTmux([3, 8]);
    p.osc(12, "#ff0000"); p.osc(4, "1;#cc0000;2;#00cc00");
    p.replied.length = 0;
    p.osc(12, "?"); p.osc(4, "1;?"); p.osc(4, "2;?;1;?");
    expect(p.replied, "tmux answers what was set inside it").toEqual([]);
    p.osc(4, "1;?;3;?");
    expect(p.replied, "a question tmux answers only in part is xterm's whole").toEqual(["osc 4"]);
    p.replied.length = 0;
    p.osc(112, ""); p.osc(104, "1");
    p.osc(12, "?"); p.osc(4, "1;?"); p.osc(4, "2;?");
    expect(p.replied).toEqual(["osc 112", "osc 104", "osc 12", "osc 4"]);
    p.replied.length = 0;
    p.osc(104, "");
    p.osc(4, "2;?");
    expect(p.replied, "OSC 104 with nothing resets them all").toEqual(["osc 104", "osc 4"]);

    const old = parser();
    leaveRepliesToTmux(old.api).setTmux([3, 2]);
    old.osc(11, "#101010"); old.osc(4, "5;#cc0000");
    old.replied.length = 0;
    old.osc(11, "?"); old.osc(10, "?"); old.osc(4, "5;?");
    expect(old.replied, "3.2 answers a background it was given, not a foreground, and no palette").toEqual(["osc 10", "osc 4"]);
  });

  it("still lets a program set its colours, its cursor style and its saved cursor", () => {
    const p = parser();
    leaveRepliesToTmux(p.api);
    p.osc(11, "rgb:11/22/33");
    p.osc(4, "1;#cc0000");
    p.csi({ intermediates: " ", final: "q" });
    p.csi({ final: "u" });
    expect(p.replied).toEqual(["osc 11", "osc 4", "cursor style", "restore cursor"]);
  });

  it("decides each question from the version alone, where the sets do not matter", () => {
    const none = new Set<number>();
    expect(tmuxAnswers({ kind: "decrqm-dec", mode: 2026 }, [3, 7]), "3.7 is inferred to answer every mode").toBe(true);
    expect(tmuxAnswers({ kind: "decrqm-dec", mode: 2026 }, [3, 6])).toBe(false);
    expect(tmuxAnswers({ kind: "decrqm-dec", mode: 1004 }, [3, 5])).toBe(false);
    expect(tmuxAnswers({ kind: "decrqm-ansi", mode: 4 }, [3, 6])).toBe(false);
    expect(tmuxAnswers({ kind: "decrqss" }, [3, 5])).toBe(false);
    expect(tmuxAnswers({ kind: "decrqss" }, [4, 0])).toBe(true);
    expect(tmuxAnswers({ kind: "osc", ident: 11, data: "?", set: false }, [3, 4])).toBe(true);
    expect(tmuxAnswers({ kind: "osc4", asked: [], set: none }, [3, 8]), "an OSC 4 that asks nothing").toBe(false);
    expect(tmuxAnswers({ kind: "da" }, [3, 2])).toBe(true);
    expect(tmuxAnswers({ kind: "dsr" }, null)).toBe(true);
  });

  it("goes back to xterm's own answers once disposed", () => {
    const p = parser();
    leaveRepliesToTmux(p.api).dispose();
    p.csi({ final: "c" });
    p.osc(11, "?");
    expect(p.replied).toEqual(["csi ||c", "osc 11"]);
  });

  it("reads an OSC colour as a question only when one of its fields is ?", () => {
    expect(asksColour("?")).toBe(true);
    expect(asksColour("?;?")).toBe(true);
    expect(asksColour("1;?;2;rgb:00/00/00")).toBe(true);
    expect(asksColour("rgb:ff/ff/ff")).toBe(false);
    expect(asksColour("1;#123456")).toBe(false);
    expect(asksColour("")).toBe(false);
  });
});

// A session with no tmux (the optional engine's console sessions) never says a
// version; the deck may say instead which kinds the stage's xterm answers
// (`{t:"replies"}`, terminal-protocol.ts). Same parser, same questions.
describe("for a session with no tmux, the kinds the deck says the stage's xterm answers", () => {
  const DA1 = { final: "c" }, DA2 = { prefix: ">", final: "c" }, DSR = { final: "n" }, DECDSR = { prefix: "?", final: "n" };
  const RQM_ANSI = { intermediates: "$", final: "p" }, RQM_DEC = { prefix: "?", intermediates: "$", final: "p" };
  const RQSS = { intermediates: "$", final: "q" };

  /** Every question, as the version cases above ask them: what xterm answered. */
  function every(p: ReturnType<typeof parser>) {
    p.csi(DA1); p.csi(DA2); p.csi(DSR, [5]); p.csi(DSR, [6]);
    p.csi(DECDSR, [996]); p.csi(DECDSR, [6]);
    p.csi(RQM_DEC, [2026]); p.csi(RQM_DEC, [2004]); p.csi(RQM_ANSI, [4]);
    p.dcs(RQSS, " q");
    p.osc(10, "?"); p.osc(11, "?"); p.osc(10, "?;?"); p.osc(12, "?"); p.osc(4, "1;?");
    return p.replied;
  }
  /** A view told `kinds`, after the version `v` (the latest word wins). */
  function told(kinds: readonly ViewKind[] | null, v: readonly [number, number] | null = null) {
    const p = parser();
    const replies = leaveRepliesToTmux(p.api);
    replies.setTmux(v);
    replies.setViewAnswers(kinds);
    return { p, replies };
  }

  it("answers exactly the kinds listed and leaves every other question alone, whatever the version", () => {
    for (const v of [null, [3, 2], [3, 8]] as const) {
      expect(every(told(["decrqm-dec", "osc10", "osc11"], v).p), String(v))
        .toEqual(["csi ?|$|p", "csi ?|$|p", "osc 10", "osc 11", "osc 10"]);
    }
  });

  it("answers, for each kind alone, that kind's questions and no other", () => {
    const alone: Record<ViewKind, string[]> = {
      da: ["csi ||c", "csi >||c"],
      dsr: ["csi ||n", "csi ||n"],
      decdsr: ["csi ?||n", "csi ?||n"],
      "decrqm-ansi": ["csi |$|p"],
      "decrqm-dec": ["csi ?|$|p", "csi ?|$|p"],
      decrqss: ["dcs |$|q"],
      osc4: ["osc 4"],
      osc10: ["osc 10", "osc 10"],
      osc11: ["osc 11"],
      osc12: ["osc 12"],
    };
    expect(Object.keys(alone).sort()).toEqual([...VIEW_KINDS].sort());
    for (const kind of VIEW_KINDS) expect(every(told([kind]).p), kind).toEqual(alone[kind]);
    expect(every(told(VIEW_KINDS).p), "every kind listed: xterm answers every question").toEqual([
      "csi ||c", "csi >||c", "csi ||n", "csi ||n", "csi ?||n", "csi ?||n", "csi ?|$|p", "csi ?|$|p", "csi |$|p",
      "dcs |$|q", "osc 10", "osc 11", "osc 10", "osc 12", "osc 4",
    ]);
  });

  it("goes back to the version on a tmux frame, and to none on a new connection", () => {
    const { p, replies } = told(["osc12"]);
    replies.setTmux([3, 4]);
    expect(every(p), "3.4's own").toEqual(["csi ?||n", "csi ?|$|p", "csi ?|$|p", "csi |$|p", "dcs |$|q", "osc 10", "osc 12", "osc 4"]);
    p.replied.length = 0;
    replies.setViewAnswers(["osc12"]);
    replies.setTmux(null);
    expect(every(p), "unknown again, as before any word").toEqual(["csi ?||n", "osc 10", "osc 12", "osc 4"]);
  });

  it("with an empty list, or none, leaves everything exactly as it was", () => {
    for (const v of [null, [3, 4], [3, 8]] as const) {
      const before = parser();
      leaveRepliesToTmux(before.api).setTmux(v);
      const empty = told([], v);
      const cleared = told(["osc11"], v);
      cleared.replies.setViewAnswers(null);
      const expected = every(before);
      expect(every(empty.p), `${v}: empty`).toEqual(expected);
      expect(every(cleared.p), `${v}: null`).toEqual(expected);
    }
  });

  it("still lets a program set its colours and its cursor style while a list leaves their questions alone", () => {
    const { p } = told(["da"]);
    p.osc(11, "rgb:11/22/33"); p.osc(4, "1;#cc0000"); p.osc(10, "#ffffff");
    p.csi({ intermediates: " ", final: "q" });
    expect(p.replied).toEqual(["osc 11", "osc 4", "osc 10", "cursor style"]);
  });

  it("goes back to xterm's own answers once disposed, list and all", () => {
    const { p, replies } = told(["da"]);
    replies.dispose();
    p.csi(DECDSR, [6]); p.osc(11, "?");
    expect(p.replied).toEqual(["csi ?||n", "osc 11"]);
  });
});
