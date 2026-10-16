// The stage's xterm answers nothing a program asks its terminal: tmux, the
// pane's real terminal, already did (terminal-replies.ts). Measured on
// 2026-10-16 by feeding tmux 3.8 and xterm.js 6.0.0 the same queries — see the
// module's header for the two lists. Run here against a parser that dispatches
// the way xterm's does: the newest handler first, and the first one that
// returns true ends the sequence, so xterm's own (the reply) never runs.
import { describe, expect, it } from "vitest";
import { COLOUR_OSC, QUERY_CSI, QUERY_DCS, asksColour, leaveRepliesToTmux, type SequenceId } from "../terminal-replies";

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
  for (const n of COLOUR_OSC) push(`osc:${n}`, own(`osc ${n}`));
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
    csi: (id: SequenceId) => dispatch(`csi:${idKey(id)}`, []),
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

  it("answers none of them, so the program reads tmux's reply and only tmux's", () => {
    const p = parser();
    leaveRepliesToTmux(p.api);
    for (const id of QUERY_CSI) p.csi(id);
    for (const id of QUERY_DCS) p.dcs(id);
    for (const n of COLOUR_OSC) p.osc(n, n === 4 ? "1;?" : "?");
    p.osc(10, "?;?");
    expect(p.replied).toEqual([]);
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
