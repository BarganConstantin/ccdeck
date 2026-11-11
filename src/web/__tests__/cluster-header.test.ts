// #520 put the name Claude Code gives a session on the node card, and the
// cluster header followed: the workspace basename, then the session's title.
//
// CHANGED ON PURPOSE (owner's critique, 2026-11-11): the header also drew four
// characters of the session id whenever a second cluster carried the same
// workspace label ("CCDECK · 2886"), which no other surface said. A session is
// named by one rule everywhere now (rail-row-copy.ts sessionNames), the pill is
// the folder and the title when the title is something else, and when it
// started with its id's tail is in the tooltip.
//
// The other half is width. The header sits over a group of nodes and its box is
// the nodes' bounding box — it is not derived from its own text, and the pill is
// `white-space: nowrap`, so a long name does not wrap, does not clip and does
// not push anything: it simply runs past the right edge of the box it labels.
// The longest agentName in the transcripts on this machine is 53 characters,
// which draws a 480px header over a 276px one-card cluster. The cap is what
// keeps that overhang inside the 240px gutter layout.ts leaves between two
// session columns.
//
// Pure functions only, like the rest of this suite: no DOM, no layout engine.
import { describe, it, expect } from "vitest";
import { clusterBounds, type ClusterNode } from "../cluster-bounds";
import {
  clusterHeader,
  clusterTooltip,
  truncateName,
  NAME_COLUMNS,
  SEP,
  type ClusterHeader,
} from "../cluster-header";
import { startedLine } from "../rail-row-copy";
import type { AgentNodeData } from "../types";

/** The header as it reads on screen, minus the sheet's uppercasing. */
function rendered(h: ClusterHeader): string {
  return [h.label, h.name].filter(Boolean).join(SEP);
}

const NAME = "account-management-oauth-flow";
// The tooltip names the LAST four characters of an id (#1732), so these end in
// the four the cases expect.
const SID = "1c2d0000-0000-4000-8000-000000004efa";
const T0 = 1_700_000_000_000;

describe("the shapes a cluster header draws", () => {
  it("workspace alone, when the session has no title of its own", () => {
    const h = clusterHeader("vcrm-core", undefined, SID);
    expect(rendered(h)).toBe("vcrm-core");
    expect(h.name).toBeUndefined();
    expect(clusterHeader("vcrm-core", "", SID).name).toBeUndefined();
    expect(clusterHeader("vcrm-core", "   ", SID).name).toBeUndefined();
  });

  it("workspace and title, when the session has a title", () => {
    expect(rendered(clusterHeader("vcrm-core", NAME, SID))).toBe(`vcrm-core${SEP}${NAME}`);
  });

  it("says a title that is only the folder again once", () => {
    expect(rendered(clusterHeader("vcrm-core", "VCRM-Core ", SID))).toBe("vcrm-core");
  });

  it("never draws a piece of the id, however many sessions share the workspace", () => {
    const a = clusterHeader("vcrm-core", undefined, "11110000-0000-4000-8000-000000004efa", ["22220000-0000-4000-8000-000000009bd7"]);
    expect(rendered(a)).toBe("vcrm-core");
    expect(a.fullLabel).toBe("vcrm-core");
    expect(a).not.toHaveProperty("shortId");
  });
});

describe("what tells two sessions of one name apart is in the tooltip", () => {
  it("names when the session started and as much of its id's tail as the board needs", () => {
    const peers = ["11110000-0000-4000-8000-000000004efa", "22220000-0000-4000-8000-000000009bd7"];
    const a = clusterHeader("vcrm-core", NAME, peers[0], peers, { startedAt: T0 });
    expect(a.idTail).toBe("4efa");
    expect(a.title).toContain(`\n${startedLine(T0, "4efa")}\n`);
    expect(clusterTooltip(a)).toBe(a.title);
    // The whole run first, the started line under it, then what a press does.
    expect(a.title.split("\n")[0]).toBe(`vcrm-core${SEP}${NAME}`);
  });

  it("grows the tail until the sessions differ", () => {
    const peers = ["019b2c3d-0000-7000-8000-00000000c450", "019b2c3d-0000-7000-8000-00000001c450"];
    expect(clusterHeader("proj", undefined, peers[0], peers, { startedAt: T0 }).idTail).toBe("0c450");
  });

  it("leaves the started line out when the start is not known", () => {
    expect(clusterHeader("vcrm-core", NAME, SID).title).not.toMatch(/4efa/);
  });
});

describe("a name is cut to a bound the header can afford", () => {
  it("leaves a name that already fits exactly as Claude Code wrote it", () => {
    expect(truncateName(NAME)).toBe(NAME);
    expect(NAME.length).toBeLessThanOrEqual(NAME_COLUMNS);
  });

  it("cuts the longest name measured on this machine, ellipsis included in the count", () => {
    // "Refactor mailbox controller request response handling" — an agentName,
    // not an aiTitle, and 53 characters of one. Names are not all kebab slugs.
    const long = "Refactor mailbox controller request response handling";
    const cut = truncateName(long);
    expect(cut.endsWith("…")).toBe(true);
    expect([...cut].length).toBeLessThanOrEqual(NAME_COLUMNS);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
  });

  it("never lets a cut read as a separator the name itself contains", () => {
    // A cut landing on a hyphen would render "oauth-…", which reads as a name
    // whose next segment is empty rather than as a name that continues.
    const cut = truncateName("account-management-oauth-flow-and-then-some", 20);
    expect(cut).toBe("account-management…");
    expect(cut).not.toMatch(/[-\s_.:/]…$/);
  });

  it("counts a double-width code point as the two columns it draws", () => {
    // 20 CJK characters draw 40 monospace columns, so a cap counted in
    // characters would let this name run to twice the bound the header is
    // allowed. Counted in columns it stops at the same width a Latin name does.
    const cjk = "日本語".repeat(20);
    const cut = truncateName(cjk);
    expect([...cut].length).toBeLessThanOrEqual(NAME_COLUMNS / 2);
  });

  it("cuts on code points, so a surrogate pair is never split in half", () => {
    const cut = truncateName(`${"a".repeat(30)}🙂🙂🙂`);
    expect(cut).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("keeps the whole name in the tooltip when the header could not show it", () => {
    const long = "Refactor mailbox controller request response handling";
    const h = clusterHeader("vcrm-core", long, SID);
    expect(h.name).not.toBe(long);
    expect(h.fullLabel).toBe(`vcrm-core${SEP}${long}`);
    expect(h.fullLabel).not.toContain("…");
  });

  it("says the same thing twice when nothing was cut", () => {
    const h = clusterHeader("vcrm-core", NAME, SID);
    expect(h.fullLabel).toBe(rendered(h));
  });
});

// The composition is reached through clusterBounds in the app, and the geometry
// half of that is cluster-bounds.test.ts. What is checked here is only that the
// name arrives from the session ROOT and from nowhere else.
const W = 240, H = 130;

function card(sessionId: string, x: number, over: Partial<AgentNodeData>): ClusterNode {
  return {
    type: "agent",
    position: { x, y: 0 },
    width: W,
    height: H,
    data: { sessionId, kind: "root", label: "vcrm-core", state: "active", ...over } as AgentNodeData,
  };
}

describe("the header reads the name off the session root", () => {
  it("takes the name a root carries", () => {
    const [c] = clusterBounds([card("s1", 0, { sessionName: NAME })]);
    expect(c.name).toBe(NAME);
    expect(c.label).toBe("vcrm-core");
  });

  it("stays nameless for a session whose root has no name yet", () => {
    const [c] = clusterBounds([card("s1", 0, {})]);
    expect(c.name).toBeUndefined();
    expect(c.fullLabel).toBe("vcrm-core");
  });

  it("ignores a name on a subagent, whichever order the store hands them over", () => {
    // A subagent carries no sessionName in the reducer, but the header must not
    // depend on that staying true: only the root speaks for the session.
    const sub = card("s1", 300, { kind: "subagent", label: "explore", sessionName: "not-the-session" });
    const root = card("s1", 0, { sessionName: NAME });
    expect(clusterBounds([root, sub])[0].name).toBe(NAME);
    expect(clusterBounds([sub, root])[0].name).toBe(NAME);
  });

  it("gives two same-named sessions in one workspace their ids' tails for the tooltip, and neither the other name", () => {
    const boxes = clusterBounds([
      card("11110000-0000-4000-8000-000000004efa", 0, { sessionName: NAME }),
      card("22220000-0000-4000-8000-000000009bd7", 900, { sessionName: NAME }),
    ]);
    expect(boxes.map(c => c.idTail)).toEqual(["4efa", "9bd7"]);
    expect(boxes.map(c => c.name)).toEqual([NAME, NAME]);
  });
});

// The workspace is the one field on the header that had no ceiling. The note in
// cluster-header.ts records a measured 21.2px overhang for a long basename and
// treats it as tolerable — which it is, for the basenames on one machine. It is
// not a bound: a checkout under a long directory can cross the 240px gutter
// layout.ts leaves between session columns, which is the exact failure the
// name's own cap exists to prevent.
describe("the workspace field is bounded by the same ruler as the name", () => {
  it("cuts a workspace past the column budget, ellipsis included in the count", () => {
    const long = "a-really-quite-long-monorepo-package-directory-name";
    const h = clusterHeader(long, undefined, "sess-1");
    expect([...h.label].length).toBeLessThanOrEqual(NAME_COLUMNS);
    expect(h.label.endsWith("…")).toBe(true);
  });

  it("keeps the whole of it in the tooltip", () => {
    const long = "a-really-quite-long-monorepo-package-directory-name";
    expect(clusterHeader(long, undefined, "sess-1").fullLabel).toContain(long);
  });

  it("leaves every ordinary workspace exactly as it was", () => {
    for (const w of ["vcrm-core", "ccdeck", "boom-next-gen", "web-core"]) {
      expect(clusterHeader(w, undefined, "sess-1").label).toBe(w);
    }
  });
});
