// The join between ccusage's session rows and the canvas, called rather than
// read.
//
// These three were memo bodies inside UsagePanel.tsx, and the only cover they
// had was usage-panel-source-737 matching their text: that the roots-only
// guard was spelled somewhere after `const boardNames = useMemo`, and that the
// renaming template existed. A string match cannot tell that a subagent no
// longer overwrites its session's name, or that three rows under one name all
// get told apart. These cases can.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  boardSessionNames, boardSessionStates, distinctSessionLabels, type JoinableAgent,
} from "../usage-session-join";
import { sessionRows, type UsageRange } from "../usage-from-ccusage";

const root = (sessionId: string, over: Partial<JoinableAgent> = {}): JoinableAgent =>
  ({ kind: "root", sessionId, label: "", state: "active", ...over });
const sub = (sessionId: string, over: Partial<JoinableAgent> = {}): JoinableAgent =>
  ({ kind: "subagent", sessionId, label: "Explore", state: "done", ...over });

// Each ends in the four characters a repeated name is told apart by — the TAIL
// of the id, since a Codex id opens with a timestamp (#1732).
const A = "11110000-0000-4000-8000-00000001aaaa";
const B = "22220000-0000-4000-8000-00000002bbbb";
const C = "33330000-0000-4000-8000-00000003cccc";

describe("what the board calls a session", () => {
  it("uses the session's label, and the working directory when it has none", () => {
    const names = boardSessionNames([
      root(A, { label: "release notes", cwdBasename: "ccdeck" }),
      root(B, { label: "", cwdBasename: "vcrm-core" }),
    ]);
    expect(names.get(A)).toBe("release notes");
    expect(names.get(B)).toBe("vcrm-core");
  });

  it("reads roots only, so a subagent never renames its session after a tool", () => {
    // A subagent carries its parent's sessionId. Read in board order, the one
    // after the root would have replaced "ccdeck" with "Explore".
    const names = boardSessionNames([root(A, { cwdBasename: "ccdeck" }), sub(A), sub(B)]);
    expect(names.get(A)).toBe("ccdeck");
    expect(names.has(B)).toBe(false);
  });

  it("leaves out a root with nothing to call it, or no session to file it under", () => {
    const names = boardSessionNames([root(A), root("", { label: "orphan" })]);
    expect([...names]).toEqual([]);
  });
});

describe("what the board says a session is doing", () => {
  it("reports each root's state under its session id, and nothing for a subagent", () => {
    const states = boardSessionStates([
      root(A, { state: "active" }), sub(A, { state: "err" }), root(B, { state: "done" }), sub(C),
    ]);
    expect(states.get(A)).toBe("active");
    expect(states.get(B)).toBe("done");
    expect(states.has(C)).toBe(false);
  });
});

describe("two sessions under one name", () => {
  const row = (sessionId: string, label: string | null) => ({ sessionId, label, cost: 1 });

  it("takes the tail of the session id for a repeated name, on every row that repeats it", () => {
    const out = distinctSessionLabels([row(A, "vcrm-core"), row(B, "vcrm-core"), row(C, "vcrm-core")]);
    expect(out.map(r => r.label)).toEqual(["vcrm-core aaaa", "vcrm-core bbbb", "vcrm-core cccc"]);
  });

  it("leaves a name that appears once alone, as the same row", () => {
    const once = row(C, "ccdeck");
    const out = distinctSessionLabels([row(A, "vcrm-core"), row(B, "vcrm-core"), once]);
    expect(out[2]).toBe(once);
    expect(out[2].label).toBe("ccdeck");
  });

  it("does not count rows the board could not name, and does not name them", () => {
    const out = distinctSessionLabels([row(A, null), row(B, null), row(C, "ccdeck")]);
    expect(out.map(r => r.label)).toEqual([null, null, "ccdeck"]);
  });

  it("returns new rows rather than renaming the ones it was given", () => {
    const given = [row(A, "vcrm-core"), row(B, "vcrm-core")];
    distinctSessionLabels(given);
    expect(given.map(r => r.label)).toEqual(["vcrm-core", "vcrm-core"]);
  });
});

describe("the join, end to end", () => {
  it("names ccusage's rows from the board and tells the repeated ones apart", () => {
    const board = [root(A, { cwdBasename: "vcrm-core" }), root(B, { cwdBasename: "vcrm-core" }), root(C, { cwdBasename: "ccdeck" })];
    const range = {
      ok: true,
      sessions: [
        { period: A, totalCost: 3, totalTokens: 30 },
        { period: `2026/09/27/rollout-2026-09-27T10-00-00-${B}`, agent: "codex", totalCost: 2, totalTokens: 20 },
        { period: C, totalCost: 1, totalTokens: 10 },
        { period: "dddd4444-0000-4000-8000-000000000004", totalCost: 0.5, totalTokens: 5 },
      ],
    } as unknown as UsageRange;
    const rows = distinctSessionLabels(sessionRows(range, boardSessionNames(board)));
    expect(rows.map(r => r.label)).toEqual(["vcrm-core aaaa", "vcrm-core bbbb", "ccdeck", null]);
  });
});

describe("the panel reads the join from here", () => {
  const panel = readFileSync(fileURLToPath(new URL("../components/UsagePanel.tsx", import.meta.url)), "utf8");

  it("keys both folds on the board's revision", () => {
    expect(panel).toContain("const boardNames = useMemo(() => boardSessionNames(state.agents.values()), [state, state.revision]);");
    expect(panel).toContain("const boardStates = useMemo(() => boardSessionStates(state.agents.values()), [state, state.revision]);");
  });

  it("tells repeated names apart after the cut to twelve, not before it", () => {
    expect(panel).toContain("return distinctSessionLabels(ccSessionRows(range, boardNames).slice(0, 12));");
  });
});
