// The terminal stage's steps between closed and open (stage-shell.ts): every
// way a click, a key, the detail panel or the stage's own motion moves it, and
// the small decisions around them — what the Terminal button opens, where the
// stage may grow from, which order j and k walk.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  boardInert,
  initialShell,
  navigatorOrder,
  navigatorSessionAt,
  sameTarget,
  shellReducer,
  stageClaimsKeys,
  stageSeen,
  STAGE_FIRST_RUN_KEY,
  targetSession,
  terminalButtonTarget,
  visibleOrigin,
  type ShellAction,
  type ShellState,
  type StageTarget,
} from "../stage-shell";

const paycore: StageTarget = { kind: "session", id: "s-paycore" };
const travel: StageTarget = { kind: "session", id: "s-travel" };
const face = { x: 400, y: 200, w: 240, h: 90 };
const name = { x: 412, y: 210, w: 60, h: 15 };

/** The state after `actions`, from closed. */
function after(...actions: ShellAction[]): ShellState {
  return actions.reduce(shellReducer, initialShell());
}

describe("opening the stage", () => {
  it("mounts it unseen first, so the morph can wait for the pane to have something to show", () => {
    const s = after({ type: "open", target: paycore, origin: face, originName: name, grace: true });
    expect(s.phase).toBe("waiting");
    expect(s.target).toEqual(paycore);
    expect(s.origin).toEqual(face);
    expect(s.originName).toEqual(name);
    expect(s.grace, "an open from a click keeps the double-click window").toBe(true);
    expect(s.focusRequest, "nobody asked for the keys").toBeNull();
    expect(s.last).toBe("s-paycore");
  });

  it("has no rider without a card to ride out of", () => {
    const s = after({ type: "open", target: { kind: "empty" }, origin: null, originName: name });
    expect(s.originName).toBeNull();
  });

  it("uncovers it, then rests it, and only in that order", () => {
    const waiting = after({ type: "open", target: paycore });
    expect(shellReducer(waiting, { type: "revealed" }), "revealed before reveal is ignored").toBe(waiting);
    const opening = shellReducer(waiting, { type: "reveal" });
    expect(opening.phase).toBe("opening");
    expect(shellReducer(opening, { type: "reveal" })).toBe(opening);
    expect(shellReducer(opening, { type: "revealed" }).phase).toBe("open");
  });

  it("carries a request for the keys as a fresh token each time", () => {
    const s = after({ type: "open", target: paycore, focus: 7 }, { type: "reveal" }, { type: "revealed" });
    expect(s.focusRequest).toBe(7);
    expect(shellReducer(s, { type: "focus", token: 8 }).focusRequest).toBe(8);
    expect(shellReducer(initialShell(), { type: "focus", token: 9 }).phase, "a closed stage takes no keys").toBe("closed");
  });
});

describe("switching while it is open", () => {
  const open = after({ type: "open", target: paycore }, { type: "reveal" }, { type: "revealed" });

  it("shows the other session where it stands, never a second morph", () => {
    const s = shellReducer(open, { type: "open", target: travel, origin: face });
    expect(s.phase).toBe("open");
    expect(s.target).toEqual(travel);
    expect(s.origin, "a switch does not move the origin the stage grew from").toBeNull();
    expect(s.last).toBe("s-travel");
  });

  it("is no change at all when the same session is asked for again", () => {
    expect(shellReducer(open, { type: "open", target: { kind: "session", id: "s-paycore" } })).toBe(open);
  });

  it("still hands the keys over when the same session is asked for with them", () => {
    expect(shellReducer(open, { type: "open", target: paycore, focus: 3 }).focusRequest).toBe(3);
  });

  it("keeps a switch during the wait a wait", () => {
    const waiting = after({ type: "open", target: paycore });
    expect(shellReducer(waiting, { type: "open", target: travel }).phase).toBe("waiting");
  });

  it("comes straight back when asked for again while closing", () => {
    const closing = shellReducer(open, { type: "close" });
    expect(closing.phase).toBe("closing");
    const back = shellReducer(closing, { type: "open", target: travel });
    expect(back.phase).toBe("open");
    expect(back.target).toEqual(travel);
  });
});

describe("closing the stage", () => {
  const open = after({ type: "open", target: paycore, focus: 2 }, { type: "reveal" }, { type: "revealed" }, { type: "popover", anchor: "nav-new-session" });

  it("runs the morph back before it is gone", () => {
    const closing = shellReducer(open, { type: "close" });
    expect(closing.phase).toBe("closing");
    expect(closing.popover, "the popover goes with the first frame").toBeNull();
    expect(shellReducer(closing, { type: "close" }), "a second close changes nothing").toBe(closing);
    const closed = shellReducer(closing, { type: "closed" });
    expect(closed.phase).toBe("closed");
    expect(closed.target).toBeNull();
    expect(closed.focusRequest, "a stale request must not focus the next stage").toBeNull();
    expect(closed.last, "the Terminal button remembers it").toBe("s-paycore");
  });

  it("goes at once when the detail panel takes the slot", () => {
    const closed = shellReducer(open, { type: "close", instant: true });
    expect(closed.phase).toBe("closed");
    expect(closed.last).toBe("s-paycore");
  });

  it("goes at once while still unseen: nothing of it is on screen to move", () => {
    expect(after({ type: "open", target: paycore }, { type: "close" }).phase).toBe("closed");
  });

  it("ignores a stray closed that no closing asked for", () => {
    expect(shellReducer(open, { type: "closed" })).toBe(open);
  });
});

describe("the double-click window", () => {
  it("lets the board under the stage stay reachable until it is over", () => {
    let s = after({ type: "open", target: paycore, grace: true }, { type: "reveal" }, { type: "revealed" });
    expect(boardInert(s), "the second press must reach the card").toBe(false);
    s = shellReducer(s, { type: "grace-over" });
    expect(s.grace).toBe(false);
    expect(boardInert(s)).toBe(true);
    expect(shellReducer(s, { type: "grace-over" })).toBe(s);
  });

  it("never makes the board inert while it is what is on screen", () => {
    expect(boardInert({ phase: "waiting", grace: false })).toBe(false);
    expect(boardInert({ phase: "closing", grace: false })).toBe(false);
    expect(boardInert({ phase: "closed", grace: false })).toBe(false);
    expect(boardInert({ phase: "opening", grace: false })).toBe(true);
  });
});

describe("while the stage is seen", () => {
  it("is from its first uncovered frame until the morph home is over, never while it waits unseen", () => {
    expect(["closed", "waiting", "opening", "open", "closing"].map(p => stageSeen(p as ShellState["phase"])))
      .toEqual([false, false, true, true, true]);
  });

  it("is exactly when the sheet stands the right-hand rail panels aside, so a hook and a rule never disagree", () => {
    // use-stage.ts useRailPanel reads stageSeen to say whether Usage and
    // Machine are on screen; stage-shell.css hides them under a dock in any
    // phase but waiting. Were the two to drift, a button would claim a
    // panel the sheet hides, or the other way round.
    const sheet = readFileSync(new URL("../styles/stage-shell.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = sheet.match(/([^{}]*)\{\s*visibility:\s*hidden;\s*\}/g)?.find(r => r.includes(".usage-panel"));
    expect(rule, "the rule that stands the rail panels aside").toBeTruthy();
    expect(rule).toContain('.app:has(.stage-dock:not([data-phase="waiting"])) :is(.usage-panel, .sysdetail)');
    expect(stageSeen("waiting")).toBe(false);
  });
});

describe("the keys and the popover", () => {
  it("lets the stage claim the board's keys from the moment it is asked for until it starts to leave", () => {
    expect(["closed", "waiting", "opening", "open", "closing"].map(p => stageClaimsKeys(p as ShellState["phase"])))
      .toEqual([false, true, true, true, false]);
  });

  it("opens the popover only on an open stage, and once per anchor", () => {
    expect(shellReducer(initialShell(), { type: "popover", anchor: "x" }).popover).toBeNull();
    const s = after({ type: "open", target: { kind: "empty" } }, { type: "popover", anchor: "ts-empty-new-session" });
    expect(s.popover).toBe("ts-empty-new-session");
    expect(shellReducer(s, { type: "popover", anchor: "ts-empty-new-session" })).toBe(s);
    expect(shellReducer(s, { type: "popover", anchor: null }).popover).toBeNull();
  });
});

describe("a launch becoming its session", () => {
  const launching = after(
    { type: "open", target: { kind: "empty" } },
    { type: "open", target: { kind: "launch", agent: "claude", cwd: "/w/paycore", key: "l1" } },
  );

  it("shows the new session as itself once the board has it", () => {
    const s = shellReducer(launching, { type: "launched", key: "l1", sessionId: "s-new" });
    expect(s.target).toEqual({ kind: "session", id: "s-new" });
    expect(s.last).toBe("s-new");
  });

  it("remembers a launched session for the Terminal button without moving the stage off the launch", () => {
    const s = shellReducer(launching, { type: "remember", sessionId: "s-new" });
    expect(s.target, "still the launch, on the connection it has").toEqual(launching.target);
    expect(s.last).toBe("s-new");
    expect(shellReducer(s, { type: "remember", sessionId: "s-new" })).toBe(s);
    expect(shellReducer(launching, { type: "remember", sessionId: "" })).toBe(launching);
  });

  it("ignores another launch's answer, and a Codex launch's empty id", () => {
    expect(shellReducer(launching, { type: "launched", key: "l0", sessionId: "s-old" })).toBe(launching);
    expect(shellReducer(launching, { type: "launched", key: "l1", sessionId: "" })).toBe(launching);
  });
});

describe("what the canvas's Terminal button opens", () => {
  const onBoard = (id: string) => id === "s-travel";

  it("is the selected session first", () => {
    expect(terminalButtonTarget("s-paycore", "s-travel", onBoard)).toEqual(paycore);
  });

  it("is the last one on the stage when nothing is selected and it is still on the board", () => {
    expect(terminalButtonTarget(null, "s-travel", onBoard)).toEqual(travel);
    expect(terminalButtonTarget(null, "s-gone", onBoard)).toEqual({ kind: "empty" });
  });

  it("is the empty stage, whose one action is New session, otherwise", () => {
    expect(terminalButtonTarget(undefined, null, onBoard)).toEqual({ kind: "empty" });
  });
});

describe("where the stage may grow from", () => {
  const pane = { x: 0, y: 52, w: 1440, h: 848 };

  it("is the card when any of it is on the canvas", () => {
    expect(visibleOrigin(face, pane)).toBe(face);
    expect(visibleOrigin({ x: -200, y: 300, w: 240, h: 90 }, pane), "half off the left edge still shows").not.toBeNull();
  });

  it("is nowhere for a card scrolled off the canvas, or one with no size", () => {
    expect(visibleOrigin({ x: 1600, y: 300, w: 240, h: 90 }, pane)).toBeNull();
    expect(visibleOrigin({ x: 10, y: 0, w: 240, h: 40 }, pane), "under the topbar").toBeNull();
    expect(visibleOrigin({ x: 10, y: 300, w: 0, h: 0 }, pane)).toBeNull();
    expect(visibleOrigin(null, pane)).toBeNull();
  });
});

describe("the order j and k walk", () => {
  /** A stand-in for the navigator's DOM: just the tiles' attributes. */
  const tiles = (ids: string[]) => ({
    querySelectorAll: (sel: string) => {
      expect(sel).toBe(".board-nav [data-nav-session]");
      return ids.map(id => ({ getAttribute: (a: string) => (a === "data-nav-session" ? id : null) }));
    },
  }) as unknown as ParentNode;

  it("is the navigator's tiles in document order, which is its reading order", () => {
    expect(navigatorOrder(tiles(["a", "c", "b"]))).toEqual(["a", "c", "b"]);
    expect(navigatorOrder(null)).toEqual([]);
  });

  it("finds the tile a key was pressed on, or nothing off the navigator", () => {
    const onTile = { closest: (s: string) => (s === "[data-nav-session]" ? { getAttribute: () => "b" } : null) };
    expect(navigatorSessionAt(onTile as unknown as EventTarget)).toBe("b");
    expect(navigatorSessionAt({ closest: () => null } as unknown as EventTarget)).toBeNull();
    expect(navigatorSessionAt(null)).toBeNull();
    // The window is a key's target when nothing has focus, and has no closest().
    expect(navigatorSessionAt({} as EventTarget)).toBeNull();
  });
});

describe("small facts", () => {
  it("compares targets by what they show", () => {
    expect(sameTarget(paycore, { kind: "session", id: "s-paycore" })).toBe(true);
    expect(sameTarget(paycore, travel)).toBe(false);
    expect(sameTarget({ kind: "empty" }, { kind: "empty" })).toBe(true);
    expect(sameTarget({ kind: "launch", agent: "codex", cwd: "/a", key: "1" }, { kind: "launch", agent: "claude", cwd: "/b", key: "1" })).toBe(true);
    expect(sameTarget(null, paycore)).toBe(false);
  });

  it("names the session on stage only when it is a board session", () => {
    expect(targetSession(paycore)).toBe("s-paycore");
    expect(targetSession({ kind: "empty" })).toBeNull();
    expect(targetSession(null)).toBeNull();
  });

  it("keeps its one storage key in the agent-dag namespace", () => {
    expect(STAGE_FIRST_RUN_KEY.startsWith("agent-dag.")).toBe(true);
  });
});
