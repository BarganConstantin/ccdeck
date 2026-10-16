// The stage's words, decided in plain node (components/terminal/stage-model.ts).
//
// The header is the node's face at the size of a stage, so these pin the
// face's vocabulary — "waiting 6m", never "blocked" (DESIGN-UI decision 3) —
// and the few places where what the stage knows outranks what the board says.
// The keys themselves — the release chord, Shift+Enter — are terminal-keys.ts's
// and pinned in terminal-keys.test.ts.
import { describe, it, expect } from "vitest";
import {
  agentName,
  canType,
  closedAnnouncement,
  elidePath,
  folderName,
  frameRun,
  frameState,
  headerStatus,
  isAbsolutePath,
  projectChoices,
  showsFrame,
  spineLive,
  stageAnnouncement,
  stageStatusFrom,
  waitedFor,
  type StagePhase,
  type StageStatus,
} from "../components/terminal/stage-model";

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const MIN = 60_000;
const live: StagePhase = { kind: "live", sizeOwner: "dock", readOnly: false };

describe("the header's sentence, from what the board knows", () => {
  it("says the face's word for a session waiting on you, with how long in bold", () => {
    const s = stageStatusFrom({ active: true, waiting: { since: NOW - 6 * MIN, tool: "Bash", detail: "git push" } }, NOW);
    expect(s).toEqual({ state: "waiting", phrase: "waiting", emphasis: "6m", tool: "Bash", arg: "git push" });
    expect(JSON.stringify(s), "one word per state, everywhere").not.toMatch(/blocked/i);
  });

  it("counts a long wait in hours and minutes", () => {
    expect(waitedFor(72 * MIN)).toBe("1h 12m");
    expect(waitedFor(6 * MIN + 59_000)).toBe("6m");
  });

  it("counts a fresh ask in seconds, never as '0m'", () => {
    expect(waitedFor(20_000)).toBe("20s");
    expect(waitedFor(59_999)).toBe("59s");
    expect(waitedFor(60_000)).toBe("1m");
    expect(waitedFor(-5)).toBe("0s");
  });

  it("names the open call while working, with its live seconds", () => {
    const s = stageStatusFrom({ active: true, tool: { name: "Task", subject: "3 subagents running", startedAt: NOW - (7 * 60 + 38) * 1000 } }, NOW);
    expect(s).toEqual({ state: "working", phrase: "working", tool: "Task", arg: "3 subagents running", seconds: "7m 38s" });
    expect(stageStatusFrom({ active: true, subagentsLive: 1 }, NOW).arg).toBe("1 subagent running");
  });

  it("puts an ended session first, whatever else is still set on it", () => {
    expect(stageStatusFrom({ active: true, closedAt: NOW - 14 * MIN, waiting: { since: NOW } }, NOW))
      .toEqual({ state: "ended", phrase: "ended 14m ago" });
    expect(stageStatusFrom({ active: false, closedAt: NOW - 1000 }, NOW).phrase).toBe("ended just now");
  });

  it("says your turn, as the card does, for a session waiting at its prompt, even while it still reads active", () => {
    expect(stageStatusFrom({ active: true, yourTurn: true, lastTurnEndAt: NOW - 2 * MIN }, NOW))
      .toEqual({ state: "idle", phrase: "your turn", arg: "last turn 2m ago" });
    expect(stageStatusFrom({ active: true, yourTurn: true, fresh: true }, NOW).phrase, "a fresh one is still invited").toBe("ready");
    expect(stageStatusFrom({ active: true, yourTurn: true, tool: { name: "Bash" } }, NOW).phrase, "an open call is newer").toBe("working");
    expect(stageStatusFrom({ active: true, yourTurn: true, waiting: { since: NOW } }, NOW).phrase, "an alarm outranks it").toBe("waiting");
  });

  it("invites a fresh session's first prompt, and says when an idle one last answered", () => {
    expect(stageStatusFrom({ active: false, fresh: true }, NOW)).toEqual({ state: "ready", phrase: "ready", arg: "for a first prompt" });
    expect(stageStatusFrom({ active: false, lastTurnEndAt: NOW - 3 * MIN }, NOW)).toEqual({ state: "idle", phrase: "idle", arg: "last turn 3m ago" });
    expect(stageStatusFrom({ active: false }, NOW)).toEqual({ state: "idle", phrase: "idle" });
  });
});

describe("what the stage knows better than the board", () => {
  const working: StageStatus = { state: "working", phrase: "working", tool: "Task", arg: "3 subagents" };

  it("lets the board speak while the pane is up", () => {
    expect(headerStatus(working, live)).toBe(working);
  });

  it("says attaching, reconnecting and starting in its own words", () => {
    expect(headerStatus(working, { kind: "attaching", reconnect: false }).phrase).toBe("attaching…");
    expect(headerStatus(working, { kind: "attaching", reconnect: true }).phrase).toBe("reconnecting…");
    expect(headerStatus(null, { kind: "starting", agent: "claude", cwd: "/w/ccdeck" }))
      .toEqual({ state: "starting", phrase: "starting…", arg: "/w/ccdeck" });
  });

  it("calls a session started outside the deck 'running elsewhere', keeping the board's tool", () => {
    const c: StagePhase = { kind: "not-attachable", target: { kind: "C", label: "…", adoptable: true }, stillRunning: false, busy: false };
    expect(headerStatus(working, c)).toEqual({ state: "elsewhere", phrase: "running elsewhere", tool: "Task", arg: "3 subagents" });
  });

  it("says not attached when tmux is missing, and ended when the socket said so first", () => {
    expect(headerStatus(working, { kind: "tmux-missing", reason: "missing", busy: false }).phrase).toBe("not attached");
    expect(headerStatus(working, { kind: "ended" })).toEqual({ state: "ended", phrase: "ended just now" });
    const boardEnded: StageStatus = { state: "ended", phrase: "ended 14m ago" };
    expect(headerStatus(boardEnded, { kind: "ended" })).toBe(boardEnded);
  });

  it("says it is setting up tmux while the deck fetches its own", () => {
    expect(headerStatus(working, { kind: "tmux-installing" })).toEqual({ state: "starting", phrase: "setting up tmux…" });
    expect(stageAnnouncement("paycore", { kind: "tmux-installing" })).toBe("Setting up tmux for the stage.");
  });

  it("does not say 'just now' for a pane that had already ended when the stage opened it", () => {
    expect(headerStatus(working, { kind: "ended", atOpen: true })).toEqual({ state: "ended", phrase: "ended" });
  });

  it("carries a travelling light only while output streams and nobody is waiting", () => {
    expect(spineLive(working, live, true)).toBe(true);
    expect(spineLive(working, live, false)).toBe(false);
    expect(spineLive({ state: "waiting", phrase: "waiting" }, live, true), "still when it waits on you").toBe(false);
    expect(spineLive(working, { kind: "ended" }, true)).toBe(false);
  });

  it("shows the terminal's frame only when it is this session's", () => {
    expect(showsFrame(live)).toBe(true);
    expect(showsFrame({ kind: "ended" })).toBe(true);
    expect(showsFrame({ kind: "attaching", reconnect: true }), "a restart keeps the frozen frame").toBe(true);
    expect(showsFrame({ kind: "attaching", reconnect: false }), "a switch shows the ghost line").toBe(false);
    expect(showsFrame({ kind: "empty" })).toBe(false);
    expect(canType(live)).toBe(true);
    expect(canType({ kind: "live", sizeOwner: "pane", readOnly: true })).toBe(false);
  });

  it("holds the last frame up, dimmed, while a switch attaches — no blank stage between two sessions", () => {
    const switching: StagePhase = { kind: "attaching", reconnect: false };
    expect(frameState("shown", switching)).toBe("held");
    expect(frameState("held", switching), "for as long as the attach takes").toBe("held");
    expect(frameState("held", live), "until the next seed is drawn over it").toBe("shown");
  });

  it("lets the frame after a hold rise from the dim for as long as it is shown, never from nothing a render later", () => {
    const switching: StagePhase = { kind: "attaching", reconnect: false };
    let run = frameRun({ state: "shown", afterHold: false }, switching);
    expect(run).toEqual({ state: "held", afterHold: false });
    run = frameRun(run, live);
    expect(run).toEqual({ state: "shown", afterHold: true });
    run = frameRun(run, live);
    expect(run, "the next render keeps it: dropping it restarts the first reveal's fade").toEqual({ state: "shown", afterHold: true });
    run = frameRun(run, { kind: "empty" });
    expect(run).toEqual({ state: "hidden", afterHold: false });
    expect(frameRun(run, live), "a first reveal fades in as before").toEqual({ state: "shown", afterHold: false });
  });

  it("holds nothing it was not showing, and never holds past the attach", () => {
    expect(frameState("hidden", { kind: "attaching", reconnect: false }), "a first open shows the ghost line").toBe("hidden");
    expect(frameState("held", { kind: "not-attachable", target: { kind: "C", label: "…", adoptable: true }, stillRunning: false, busy: false })).toBe("hidden");
    expect(frameState("shown", { kind: "empty" })).toBe("hidden");
    expect(frameState("hidden", { kind: "attaching", reconnect: true }), "a restart keeps its frozen frame as shown").toBe("shown");
  });
});

describe("what the live region is told", () => {
  it("says a change of what the stage shows once, and never that a closed session stopped", () => {
    expect(stageAnnouncement("paycore", live)).toBe("paycore is on the stage.");
    expect(stageAnnouncement("paycore", { kind: "ended" })).toMatch(/ended/);
    expect(stageAnnouncement("paycore", { kind: "attaching", reconnect: false })).toBeNull();
    expect(closedAnnouncement("paycore")).toBe("Stage closed. paycore keeps running.");
    expect(closedAnnouncement(null)).toBe("Stage closed.");
  });
});

describe("the New session popover's projects", () => {
  it("offers each folder once, most recently heard from first, with the stage's own folder leading", () => {
    const got = projectChoices([
      { cwd: "/home/u/code/paycore", hue: 270, at: 30 },
      { cwd: "/home/u/personal/ccdeck", hue: 20, at: 50 },
      { cwd: "/home/u/code/paycore", hue: 270, at: 90 },
      { cwd: "/home/u/code/vicinae", name: "vicinae", hue: 90, at: 10 },
      { cwd: "relative/path", hue: 0, at: 99 },
      { cwd: "", hue: 0, at: 99 },
    ], "/home/u/code/vicinae");
    expect(got.map(p => p.cwd)).toEqual(["/home/u/code/vicinae", "/home/u/code/paycore", "/home/u/personal/ccdeck"]);
    expect(got[1]).toEqual({ cwd: "/home/u/code/paycore", name: "paycore", hue: 270 });
  });

  it("takes absolute paths on either platform and refuses a tilde the deck cannot expand", () => {
    expect(isAbsolutePath("/srv/app")).toBe(true);
    expect(isAbsolutePath("C:\\work\\app")).toBe(true);
    expect(isAbsolutePath("~/code/app")).toBe(false);
    expect(isAbsolutePath("code/app")).toBe(false);
    expect(folderName("/home/u/code/app/")).toBe("app");
    expect(folderName("C:\\work\\app")).toBe("app");
  });

  it("cuts a long path from the front, keeping the part that tells two projects apart", () => {
    expect(elidePath("/srv/app")).toBe("/srv/app");
    expect(elidePath("/home/constantin/Desktop/personal/ccdeck")).toBe("…/personal/ccdeck");
    expect(elidePath("/home/u/travel-portal-with-an-unusually-long-name", 24)).toMatch(/^…\/travel-portal.*…$/);
    expect(elidePath("/home/u/travel-portal-with-an-unusually-long-name", 24).length).toBeLessThanOrEqual(24);
  });

  it("names the agents the way the stage prints them", () => {
    expect(agentName("claude")).toBe("Claude Code");
    expect(agentName("codex")).toBe("Codex");
  });
});
