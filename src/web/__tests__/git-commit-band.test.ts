// The lane under a card, the page's side of it: the event read and kept on
// the session's root card, whose commits a card's lane holds (the whole team's
// on a main card, a subagent's own only where it has a branch of its own), the
// half-hour window and the fold, the room the layout makes for the lane, its
// colour, and the door it opens the git view through. The lane as the card
// draws it is git-commit-band-card.test.ts's.
import { afterEach, describe, expect, it } from "vitest";
import type { Node } from "reactflow";
import { collectBursts } from "../burst-layout";
import {
  BAND_FOLD_H, BAND_ROW_H, BAND_ROWS, BAND_TOP, BAND_WINDOW_MS, FALLBACK_SLOT, bandRoom, bandRoomFor, bandView, cardBands, drawsLane, laneSlot,
} from "../git-commit-band";
import { recentCommitsFrom } from "../git-events";
import { openGitFor, setGitOpener } from "../git-open";
import { CROSS_SESSION_Y } from "../layout-geometry";
import { initialState } from "../reducer";
import { separateOverlaps } from "../separate-overlaps";
import type { HookPayload } from "../types";
import { API, MIN, NOW, OTHER, board, commit, lane, send, sha } from "./git-commit-band-fixture";

afterEach(() => { setGitOpener(null); });

describe("the event, on the page", () => {
  it("reads a lane newest first, each commit once, and drops what it cannot read", () => {
    const read = recentCommitsFrom({ repo: "/r/.git", commits: [
      commit(1, 9 * MIN), commit(2, 1 * MIN), commit(2, 1 * MIN), { ...commit(3, 2 * MIN), sha: "HEAD" }, { ...commit(4, 3 * MIN), at: "soon" },
      { ...commit(5, 4 * MIN), short: undefined, agentId: "", label: 7 }, null,
    ] as unknown[] });
    expect(read!.repo).toBe("/r/.git");
    expect(read!.commits.map(c => c.sha)).toEqual([sha(2), sha(5), sha(1)]);
    expect(read!.commits[1]).toMatchObject({ short: sha(5).slice(0, 7), agentId: null, label: null });
    expect(recentCommitsFrom({ commits: "nope" })).toBeNull();
  });

  it("keeps it on the session's root card, and an empty lane takes it away", () => {
    let s = board([commit(1, MIN)]);
    expect(s.agents.get(API)!.gitRecent?.commits.map(c => c.sha)).toEqual([sha(1)]);
    s = send(s, lane(API, []));
    expect(s.agents.get(API)!.gitRecent).toBeUndefined();
  });

  it("is the server's word and not the session moving: it never makes a card, never clears a waiting block, and waits for the card", () => {
    let s = board();
    s = send(s, { hook_event_name: "Notification", session_id: API, cwd: "/w/shop-api-auth", message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" } as HookPayload);
    const waiting = s.agents.get(API)!.waiting;
    expect(waiting).toBeTruthy();
    s = send(s, lane(API, [commit(1, MIN)]));
    expect(s.agents.get(API)!.waiting).toEqual(waiting);
    // A session with no card yet: nothing drawn, the lane parked for it.
    s = send(s, lane(OTHER, [commit(2, MIN)]));
    expect(s.agents.has(OTHER)).toBe(false);
    s = send(s, { hook_event_name: "SessionStart", session_id: OTHER, cwd: "/w/shop-api-auth" });
    expect(s.agents.get(OTHER)!.gitRecent?.commits.map(c => c.sha)).toEqual([sha(2)]);
  });
});

describe("the window and the fold", () => {
  it("holds a commit for half an hour after it was made, and the lane goes with the last one", () => {
    expect(BAND_WINDOW_MS).toBe(30 * MIN);
    const cs = [commit(1, MIN), commit(2, 30 * MIN - 1000), commit(3, 30 * MIN)];
    expect(bandView(cs, NOW).rows.map(c => c.sha)).toEqual([sha(1), sha(2)]);
    expect(bandView(cs, NOW + 2000).rows.map(c => c.sha)).toEqual([sha(1)]);
    expect(bandView(cs, NOW + 29 * MIN + 1).rows).toEqual([]);
  });

  it("draws at most five rows, newest on top, and folds the rest into a count", () => {
    const cs = Array.from({ length: 8 }, (_, i) => commit(i + 1, (i + 1) * MIN));
    const v = bandView(cs, NOW);
    expect(BAND_ROWS).toBe(5);
    expect(v.rows.map(c => c.sha)).toEqual([1, 2, 3, 4, 5].map(sha));
    expect(v.earlier).toBe(3);
    // The fold counts only what is still inside the window.
    expect(bandView(cs, NOW + 23 * MIN).earlier).toBe(1);
    expect(bandView(cs.slice(0, 5), NOW).earlier).toBe(0);
  });

  it("is as tall as its rows", () => {
    expect(bandRoom({ rows: [], earlier: 0 })).toBe(0);
    expect(bandRoom({ rows: [1], earlier: 0 })).toBe(BAND_TOP + BAND_ROW_H);
    expect(bandRoom({ rows: [1, 2, 3, 4, 5], earlier: 2 })).toBe(BAND_TOP + 5 * BAND_ROW_H + BAND_FOLD_H);
  });
});

describe("whose commits a lane holds", () => {
  const team = [commit(1, MIN), commit(2, 2 * MIN, { agentId: "tw1", label: "test-writer" }), commit(3, 3 * MIN, { agentId: "dw1", label: "docs-writer", branch: "docs/auth" })];

  it("on a main card, the whole team's, a subagent's named after its subject", () => {
    const bands = cardBands(board(team).agents.values());
    expect(bands.get(API)!.commits.map(c => [c.sha, c.who])).toEqual([[sha(1), null], [sha(2), "↳ test-writer"], [sha(3), "↳ docs-writer"]]);
    expect(bands.get(API)!.repo).toBe("/w/shop-api/.git");
  });

  it("names a subagent whose card has left the board by what the server recorded", () => {
    const s = board(team);
    s.agents.delete(`${API}::tw1`);
    expect(cardBands(s.agents.values()).get(API)!.commits[1].who).toBe("↳ test-writer");
  });

  it("on a subagent's card only where it has a branch of its own, and then only its own commits", () => {
    const s = board(team);
    // In its session's folder: no chip of its own, so no lane — its commit is on the session's.
    expect(drawsLane(s.agents.get(`${API}::tw1`)!)).toBe(false);
    const bands = cardBands(s.agents.values());
    expect(bands.has(`${API}::tw1`)).toBe(false);
    // In a worktree of its own: its own commit, not named twice.
    expect(bands.get(`${API}::dw1`)!.commits.map(c => [c.sha, c.who])).toEqual([[sha(3), null]]);
  });

  it("keeps a lane's identity while it says the same thing, so its card does not draw again", () => {
    const s = board(team);
    const first = cardBands(s.agents.values());
    expect(cardBands(s.agents.values(), first).get(API)).toBe(first.get(API));
    const s2 = send(s, lane(API, [commit(9, 0), ...team]));
    expect(cardBands(s2.agents.values(), first).get(API)).not.toBe(first.get(API));
  });
});

describe("room for the lane", () => {
  const cs = [commit(1, MIN), commit(2, 2 * MIN), commit(3, 3 * MIN)];
  const room = BAND_TOP + 3 * BAND_ROW_H;

  it("is the node's height over the card's, at the canvas's clock", () => {
    const s = board(cs);
    expect(bandRoomFor(s.agents, s.agents.get(API)!, NOW, true)).toBe(room);
    expect(bandRoomFor(s.agents, s.agents.get(`${API}::tw1`)!, NOW, true)).toBe(0);
    expect(bandRoomFor(s.agents, s.agents.get(API)!, NOW + 31 * MIN, true)).toBe(0);
  });

  it("keeps the tool chain on the card's middle, not the middle of the card and its lane", () => {
    // A session with no subagents, so the call is its main thread's.
    let s = initialState();
    s = send(s, { hook_event_name: "SessionStart", session_id: API, cwd: "/w/shop-api-auth" });
    s = send(s, lane(API, cs));
    s = send(s, { hook_event_name: "PreToolUse", session_id: API, cwd: "/w/shop-api-auth", tool_name: "Read", tool_input: { file_path: "/w/a.ts" }, tool_use_id: "toolu_r1" } as HookPayload);
    const measured = new Map([[API, { width: 260, height: 130 + room }]]);
    const bursts = collectBursts(s.agents, new Set([API]), new Map([[API, { x: 0, y: 100 }]]), new Map(), measured, NOW);
    expect(bursts.filter(x => !x.isSub).length).toBeGreaterThan(0);
    // The card's own bubble: a chained one anchors on the bubble before it.
    for (const b of bursts.filter(x => x.agentId === API && !x.isSub)) expect(b.anchorY).toBe(100 + 130 / 2);
  });

  it("pushes what would lie under the lane clear of it, so nothing overlaps", () => {
    const node = (id: string, sessionId: string): Node => ({ id, position: { x: 0, y: 0 }, data: { sessionId } } as Node);
    const positions = new Map([[API, { x: 0, y: 0 }], [OTHER, { x: 0, y: 130 + 40 }]]);
    const measured = new Map([[API, { width: 260, height: 130 + room }], [OTHER, { width: 260, height: 130 }]]);
    separateOverlaps([node(API, API), node(OTHER, OTHER)], positions, new Map(), measured);
    expect(positions.get(OTHER)!.y).toBe(130 + room + CROSS_SESSION_Y);
  });
});

describe("the lane's colour", () => {
  it("is its branch's in the git view's history, and for a branch the history never laid out, the slot it would give it first", () => {
    expect(laneSlot("develop", new Map())).toBe(0);
    expect(laneSlot("main", new Map())).toBe(1);
    expect(laneSlot("feature/x", new Map([["feature/x", 2]]))).toBe(2);
    expect(laneSlot("feature/y", new Map())).toBe(FALLBACK_SLOT);
    expect(laneSlot(null, new Map())).toBe(FALLBACK_SLOT);
  });
});

describe("opening the git view on a commit", () => {
  it("goes through the page's one git opener, naming the commit", () => {
    const seen: unknown[] = [];
    setGitOpener((id, how, hints) => seen.push([id, how, hints ?? null]));
    openGitFor(API, "pointer", { sel: sha(1) });
    openGitFor(API, "key");
    expect(seen).toEqual([[API, "pointer", { sel: sha(1) }], [API, "key", null]]);
  });
});
