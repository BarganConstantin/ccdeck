// A field the hook cut for size is shown as a note, not as the marker object.
//
// An event over the deck's ingest cap reaches it with its biggest fields
// replaced by `{ ccdeck_truncated: true, chars }` (hook.js's withinSizeCap) —
// a Write's `content`, a Bash call's `stdout`, an Edit's `originalFile`. The
// tool dialog then printed that object as if it were the payload:
//
//   content:
//     ccdeck_truncated: true
//     chars: 5000000
//
// a Bash call whose output was cut said its output was "none", and the copy
// buttons put the raw marker, or nothing, on the clipboard. The call's row
// carried the same object in its preview.
//
// Driven through the reducer the way the server's events feed it, and the
// dialog rendered from the call it holds.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyEvent, findToolOnBoard, initialState, type GraphState } from "../reducer";
import type { HookPayload } from "../types";
import ToolModal from "../components/ToolModal";
import { copyOf } from "../tool-view";

const CUT = { ccdeck_truncated: true, chars: 5_000_000 };
const NOTE = "(too large to show — 4.8 MB, cut by the hook)";

let seq = 0;
function send(state: GraphState, payload: HookPayload, receivedAt: number): GraphState {
  return applyEvent(state, { seq: ++seq, receivedAt, source: "hook", payload: { session_id: "s1", ...payload } });
}

function call(name: string, input: unknown, response: unknown) {
  seq = 0;
  let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/w" }, 1_000);
  state = send(state, { hook_event_name: "PreToolUse", tool_name: name, tool_use_id: "call_1", tool_input: input }, 2_000);
  state = send(state, { hook_event_name: "PostToolUse", tool_name: name, tool_use_id: "call_1", tool_input: input, tool_response: response }, 3_000);
  const tool = findToolOnBoard(state.agents, "s1", "call_1");
  if (!tool) throw new Error("the call never reached the board");
  return tool;
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const dialog = (tool: ReturnType<typeof call>) =>
  text(renderToStaticMarkup(createElement(ToolModal, { tool, onClose: () => {} })));

describe("a payload field the hook cut for size", () => {
  it("is a note in the tool dialog, not the marker object", () => {
    const tool = call("Write", { file_path: "/w/big.log", content: CUT }, { type: "create", filePath: "/w/big.log" });
    const shown = dialog(tool);
    expect(shown).not.toContain("ccdeck_truncated");
    expect(shown).toContain(NOTE);
    expect(shown).toContain("/w/big.log");
  });

  it("is said where a Bash call's output was, rather than 'none'", () => {
    const tool = call("Bash", { command: "cat big.log" }, { stdout: CUT, stderr: "", interrupted: false });
    const shown = dialog(tool);
    expect(shown).toContain(NOTE);
    expect(shown).not.toContain("ccdeck_truncated");
    expect(copyOf("Bash", "response", tool.response)).toBe(NOTE);
  });

  it("is what the copy buttons put on the clipboard", () => {
    const tool = call("Write", { file_path: "/w/big.log", content: CUT }, CUT);
    expect(copyOf("Write", "input", tool.input)).toContain(`"content": "${NOTE}"`);
    expect(copyOf("Write", "response", tool.response)).toBe(NOTE);
    expect(dialog(tool)).not.toContain("ccdeck_truncated");
  });

  it("is what the call's row carries in its preview", () => {
    const tool = call("Write", { file_path: "/w/big.log", content: CUT }, { type: "create" });
    expect(tool.inputPreview).not.toContain("ccdeck_truncated");
    expect(tool.inputPreview).toContain("too large to show");
  });

  it("leaves a field that merely has the word in it alone", () => {
    const own = { ccdeck_truncated: "yes", chars: "many", note: "a user's own object" };
    const tool = call("mcp__notes__save", own, { ok: true });
    expect(dialog(tool)).toContain("ccdeck_truncated: yes");
  });
});
