// The tool dialog's payload turned into "(none)" while it was being read.
//
// The reducer keeps the full input and response of an agent's newest 25 calls
// and releases the rest (TOOL_BLOB_WINDOW, trimTools), in place, on the very
// ToolCall the open dialog renders. So a dialog opened on a working agent's
// newest call lost its payload 25 calls later: the Input fell back to the
// 80-character preview, a successful Response read "(none)" under the
// "payloads were released" note, and the copy buttons went dead.
//
// Run, not read: the board is built by the reducer, the call is found the way
// use-dialogs.ts finds it, and ToolModal is rendered by fake-react, which keeps
// its hooks across renders the way React does.
import { describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../types";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("../components/use-modal-dismiss", () => ({
  useModalDismiss: () => ({ current: null }),
  useScrimDismiss: () => ({}),
}));

const { mount, all, textOf } = await import("./fake-react");
const { default: ToolModal } = await import("../components/ToolModal");
const { applyEvent, findToolOnBoard, initialState, TOOL_BLOB_WINDOW } = await import("../reducer");

const SID = "held-payload";
const OUTPUT = Array.from({ length: 40 }, (_, n) => `line ${n} of a long build log`).join("\n");

let seq = 0;
function send(state: ReturnType<typeof initialState>, payload: Record<string, unknown>) {
  return applyEvent(state, { seq: ++seq, receivedAt: 1_000 + seq, source: "hook", payload: { session_id: SID, ...payload } } as never);
}

function board() {
  let s = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" });
  s = send(s, { hook_event_name: "UserPromptSubmit", prompt: "build it" });
  s = send(s, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b0", tool_input: { command: "npm run build -- --verbose --no-cache --filter=every-package-in-the-repo" } });
  s = send(s, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "b0", tool_response: { stdout: OUTPUT, stderr: "", interrupted: false } });
  return s;
}

/** What the dialog shows and offers to copy, by section. */
function read(tree: unknown) {
  const blocks = (all(tree, el => typeof el.type === "function" && "block" in el.props)
    .map(el => el.props.block as { text: string }));
  const copies = all(tree, el => typeof el.type === "function" && "what" in el.props)
    .map(el => ({ what: el.props.what as string, text: el.props.text as string }));
  return { text: blocks.map(b => b.text).join("\n"), copies, note: /payloads for this call were released/.test(textOf(tree)) };
}

describe("an open tool dialog keeps the payload it was opened with", () => {
  it("still shows the full output after the agent makes 25 more calls", () => {
    let s = board();
    const opened = () => findToolOnBoard(s.agents, SID, "b0")! as ToolCall;
    const dialog = mount(ToolModal, { tool: opened(), onClose: () => {} });
    const before = read(dialog.tree);
    expect(before.text).toContain("line 39 of a long build log");
    expect(before.copies.find(c => c.what === "response")?.text).toContain("line 39");

    for (let n = 1; n <= TOOL_BLOB_WINDOW; n++) {
      s = send(s, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: `r${n}`, tool_input: { file_path: `/repo/f${n}.ts` } });
    }
    // The reducer has let go of it; the dialog has not.
    expect(opened().trimmed).toBe(true);
    expect(opened().response).toBeUndefined();
    dialog.rerender({ tool: opened(), onClose: () => {} });
    const after = read(dialog.tree);
    expect(after.text).toContain("line 39 of a long build log");
    expect(after.text).toContain("--filter=every-package-in-the-repo");
    expect(after.text).not.toContain("(none)");
    expect(after.note).toBe(false);
    expect(after.copies.find(c => c.what === "input")?.text).toContain("--filter=every-package-in-the-repo");
    expect(after.copies.find(c => c.what === "response")?.text).toContain("line 39");
  });

  it("still says the payloads were released for a call opened after they were", () => {
    let s = board();
    for (let n = 1; n <= TOOL_BLOB_WINDOW; n++) {
      s = send(s, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: `r${n}`, tool_input: { file_path: `/repo/f${n}.ts` } });
    }
    const dialog = mount(ToolModal, { tool: findToolOnBoard(s.agents, SID, "b0")!, onClose: () => {} });
    const shown = read(dialog.tree);
    expect(shown.note).toBe(true);
    expect(shown.text).not.toContain("line 39");
  });
});
