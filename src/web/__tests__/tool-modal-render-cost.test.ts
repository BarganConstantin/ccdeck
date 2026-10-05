// The tool dialog redid all of its work four times a second.
//
// The board's tick re-renders the deck every 250ms, and the dialog re-rendered
// with it: toolView walked the whole payload again, both copy buttons built
// their strings again (JSON.stringify of a generic tool's response), and every
// block split its full text into line objects again to show sixty of them. On
// a multi-megabyte Read or WebFetch result that was tens of milliseconds per
// tick for as long as the dialog stayed open. All of it is a function of the
// payload, and the payload does not change while it is being read.
//
// Run, not read: fake-react keeps the dialog's hooks across renders the way
// React does, and tool-view's functions are counted as the dialog calls them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../types";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("../components/use-modal-dismiss", () => ({
  useModalDismiss: () => ({ current: null }),
  useScrimDismiss: () => ({}),
}));
const calls = vi.hoisted(() => ({ toolView: 0, copyOf: 0, linesOf: 0 }));
vi.mock("../tool-view", async importOriginal => {
  const real = await importOriginal<typeof import("../tool-view")>();
  return {
    ...real,
    toolView: (...a: Parameters<typeof real.toolView>) => { calls.toolView++; return real.toolView(...a); },
    copyOf: (...a: Parameters<typeof real.copyOf>) => { calls.copyOf++; return real.copyOf(...a); },
    linesOf: (...a: Parameters<typeof real.linesOf>) => { calls.linesOf++; return real.linesOf(...a); },
  };
});

const { mount, all } = await import("./fake-react");
const { default: ToolModal, ToolBlock } = await import("../components/ToolModal");

const BIG = Array.from({ length: 5_000 }, (_, n) => `${n} ${"x".repeat(60)}`).join("\n");
const call = (over: Partial<ToolCall> = {}): ToolCall => ({
  id: "w1", name: "WebFetch", agentId: "s1", startedAt: 1, endedAt: 2, ok: true,
  input: { url: "https://docs.example.com/", prompt: "summarise" },
  inputPreview: "{\"url\":\"https://docs.example.com/\"}",
  response: { result: BIG, meta: { bytes: BIG.length } },
  ...over,
});
const blocksOf = (tree: unknown) => all(tree, el => typeof el.type === "function" && "block" in el.props);

beforeEach(() => { calls.toolView = 0; calls.copyOf = 0; calls.linesOf = 0; });

describe("the tool dialog works out a payload once", () => {
  it("does not redo the view or either copy string on a tick that changed nothing", () => {
    const tool = call();
    const dialog = mount(ToolModal, { tool, onClose: () => {} });
    const first = blocksOf(dialog.tree);
    for (let tick = 0; tick < 4; tick++) dialog.rerender({ tool, onClose: () => {} });
    expect(calls.toolView).toBe(1);
    expect(calls.copyOf).toBe(2);
    // The same elements, so React skips the blocks rather than drawing them again.
    const later = blocksOf(dialog.tree);
    expect(later).toHaveLength(first.length);
    later.forEach((el, n) => expect(el).toBe(first[n]));
  });

  it("works it out again once the response lands", () => {
    const tool = call({ endedAt: undefined, ok: undefined, response: undefined });
    const dialog = mount(ToolModal, { tool, onClose: () => {} });
    dialog.rerender({ tool, onClose: () => {} });
    expect(calls.toolView).toBe(1);
    tool.response = { result: "done" };
    tool.endedAt = 3;
    tool.ok = true;
    dialog.rerender({ tool, onClose: () => {} });
    dialog.rerender({ tool, onClose: () => {} });
    expect(calls.toolView).toBe(2);
  });

  it("splits a block into lines once, not on every render of it", () => {
    const block = { label: "result", text: BIG };
    const drawn = mount(ToolBlock, { block });
    for (let tick = 0; tick < 4; tick++) drawn.rerender({ block });
    expect(calls.linesOf).toBe(1);
  });
});
