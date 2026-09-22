// The file a session leaves the deck as (#1175).
//
// "Export session JSON" writes something a person keeps: it goes onto bug
// reports, into issues, and into whatever folder somebody files a noteworthy
// run in. Until this moved out of App.tsx it was a module-private function in a
// file at 0% coverage, so `schemaVersion`, the tool stripping and the file name
// appeared in no test at all — and the stripping is the part that costs most if
// it goes. Every tool call on the canvas carries its full `input` and
// `response`: the contents of a file that was read, the output of a command,
// an API answer that may carry a token. The export drops all of it on purpose,
// and `tools: a.tools.map(t => ({ ...t }))` is a tidy-up that would ship it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exportFileName, sessionExport } from "../session-export";
import { PRODUCT } from "../brand";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload, ToolCall } from "../types";

const NOW_ISO = "2026-03-04T05:06:07.000Z";

let seq = 0;
const board = (events: Array<[Partial<HookPayload>, number]>): GraphState => {
  seq = 0;
  let state = initialState();
  for (const [payload, receivedAt] of events) {
    state = applyEvent(state, { seq: ++seq, epoch: 1, receivedAt, source: "hook", payload } as HookEnvelope);
  }
  return state;
};

/** A session with a root, one subagent, and a tool call whose full payloads are
 *  on the board — the ordinary shape, built through the real reducer so the
 *  fields are the ones the deck really holds. */
function aSession(): GraphState {
  return board([
    [{ hook_event_name: "SessionStart", session_id: "S", cwd: "/srv/proj" }, 1000],
    [{ hook_event_name: "SubagentStart", session_id: "S", cwd: "/srv/proj", parent_tool_use_id: "tu1", subagent_type: "worker" }, 1100],
    [{
      hook_event_name: "PreToolUse", session_id: "S", cwd: "/srv/proj",
      tool_name: "Read", tool_use_id: "call1", tool_input: { file_path: "/srv/proj/.env" },
    } as Partial<HookPayload>, 1200],
    [{
      hook_event_name: "PostToolUse", session_id: "S", cwd: "/srv/proj",
      tool_name: "Read", tool_use_id: "call1",
      tool_response: { content: "OPENAI_API_KEY=sk-live-do-not-export" },
    } as Partial<HookPayload>, 1300],
    // A second session sharing the canvas, which is the ordinary state of a
    // deck and the reason `agents` is filtered at all.
    [{ hook_event_name: "SessionStart", session_id: "T", cwd: "/srv/other" }, 1400],
  ]);
}

describe("sessionExport", () => {
  it("carries the session's own agents and nobody else's", () => {
    // The canvas is shared; the file is not. A bug report that quietly holds a
    // colleague's session is the kind of leak nobody thinks to look for.
    const out = sessionExport(aSession(), "S", NOW_ISO)!;
    expect(out).not.toBeNull();
    expect(out.agents.map(a => a.id).sort()).toEqual(["S", "S::tu1"]);
    expect(out.agents.every(a => a.id.startsWith("S"))).toBe(true);
    expect(out.sessionId).toBe("S");
    expect(out.cwd).toBe("/srv/proj");
  });

  it("says which format it is", () => {
    // A file with no version is one a future reader has to guess about.
    expect(sessionExport(aSession(), "S", NOW_ISO)!.schemaVersion).toBe(1);
    expect(sessionExport(aSession(), "S", NOW_ISO)!.exportedAt).toBe(NOW_ISO);
  });

  it("leaves every tool's full input and response behind, keeping the previews", () => {
    // THE ASSERTION THIS FILE EXISTS FOR. The board holds the whole payload —
    // here a .env file's contents — and the export must hold neither key, while
    // still carrying enough to read the call.
    const state = aSession();
    // The reducer hands an unattributed call to the deepest live subagent, so
    // the call is on the subagent here rather than on the root.
    const owner = [...state.agents.values()].find(a => a.tools.length > 0)!;
    const onBoard = owner.tools[0] as ToolCall;
    expect(onBoard.input).toBeDefined();
    expect(onBoard.response).toBeDefined();
    expect(JSON.stringify(onBoard)).toContain("sk-live-do-not-export");

    const tool = sessionExport(state, "S", NOW_ISO)!.agents.find(a => a.id === owner.id)!.tools[0];
    expect(Object.keys(tool).sort())
      .toEqual(["endedAt", "errorPreview", "id", "inputPreview", "name", "ok", "startedAt", "usage"]);
    expect(tool.name).toBe("Read");
    expect(tool.inputPreview).toBe(onBoard.inputPreview);
    // And nothing carried it through under another name.
    expect(JSON.stringify(sessionExport(state, "S", NOW_ISO))).not.toContain("sk-live-do-not-export");
  });

  it("keeps the fields that make the file readable on its own", () => {
    // Which agent is which, and what each one cost: an export whose agents have
    // no parentage and no usage is a list of names.
    const state = aSession();
    const out = sessionExport(state, "S", NOW_ISO)!;
    const root = out.agents.find(a => a.id === "S")!;
    expect(root.kind).toBe("root");
    expect(root.usage).toBe(state.agents.get("S")!.usage);
    const sub = out.agents.find(a => a.id === "S::tu1")!;
    expect(sub.kind).toBe("subagent");
    expect(sub.parentId).toBe("S");
    expect(sub.label).toBe(state.agents.get("S::tu1")!.label);
  });

  it("exports nothing for a session the deck cannot describe", () => {
    // A file named after a session that is not on the board would be a file of
    // nothing, and the caller has no download to make.
    expect(sessionExport(aSession(), "never-seen", NOW_ISO)).toBeNull();
  });
});

describe("exportFileName", () => {
  it("replaces everything a file name cannot carry", () => {
    // A label is whatever the working directory or the first prompt made it, so
    // it holds slashes, colons and spaces. Replaced rather than stripped, so
    // two labels that differ only in punctuation still differ here.
    expect(exportFileName("feat/x: y", "abcdef123456")).toBe(`${PRODUCT}-feat_x__y-abcdef12.json`);
    expect(exportFileName("a b", "s")).toBe(`${PRODUCT}-a_b-s.json`);
  });

  it("keeps the characters a name is allowed to have", () => {
    expect(exportFileName("Deck-1.2_x", "abcdefghij")).toBe(`${PRODUCT}-Deck-1.2_x-abcdefgh.json`);
  });

  it("falls back to `session` rather than leaving a gap", () => {
    expect(exportFileName("", "s1")).toBe(`${PRODUCT}-session-s1.json`);
    expect(exportFileName(undefined, "s1")).toBe(`${PRODUCT}-session-s1.json`);
  });

  it("cuts the id to eight, so the name stays readable in a download list", () => {
    expect(exportFileName("x", "0123456789abcdef")).toBe(`${PRODUCT}-x-01234567.json`);
    // Shorter than eight is left as it is rather than padded.
    expect(exportFileName("x", "abc")).toBe(`${PRODUCT}-x-abc.json`);
  });
});

describe("the download App triggers is the file this module describes", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

  it("builds the blob from sessionExport and names it through exportFileName", () => {
    expect(app).toMatch(/const payload = sessionExport\(state, sessionId, new Date\(\)\.toISOString\(\)\);/);
    expect(app).toMatch(/if \(!payload\) return;/);
    expect(app).toMatch(/a\.download = exportFileName\(payload\.label, sessionId\);/);
    // And builds none of it a second time here, which is how the format came to
    // be unreachable by a test in the first place.
    expect(app).not.toMatch(/schemaVersion: 1/);
    expect(app).not.toMatch(/inputPreview: t\.inputPreview/);
  });
});
