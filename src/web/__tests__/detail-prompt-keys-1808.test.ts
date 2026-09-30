// #1808: an expanded background-task notice in the detail panel collapsed, or a
// different notice opened in its place, when a new prompt arrived.
//
// The prompt list renders newest first and was keyed on the position in that
// reversed list. A new prompt takes position 0 and moves every other entry down
// one, so React handed each entry's DOM node — the uncontrolled `open` of a
// notice's <details> with it — to a different prompt. The key is the entry's
// own now, so it stays with the entry however many prompts land around it.
//
// Detail uses no hooks, so it is called directly and the element tree it
// returns is read for the keys React would reconcile by.
import { describe, it, expect } from "vitest";
import type { ReactElement, ReactNode } from "react";
import Detail from "../components/Detail";
import type { AgentNodeData, PromptEntry } from "../types";

const notice = (summary: string) => [
  "<task-notification>",
  "<task-id>b055gq9k8</task-id>",
  "<status>completed</status>",
  `<summary>${summary}</summary>`,
  "</task-notification>",
].join("\n");

const agent = (prompts: PromptEntry[]): AgentNodeData => ({
  id: "s1",
  sessionId: "s1",
  label: "api",
  kind: "root",
  state: "active",
  startedAt: 1_000,
  tools: [],
  prompts,
  toolCount: 0,
  childCount: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
} as AgentNodeData);

/** Every `.prompt-entry` in the tree, in display order, with the key React
 *  reconciles it by and the text it shows. */
function entries(node: ReactNode, out: { key: string | null; text: string }[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) entries(child, out);
    return out;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return out;
  const el = node as ReactElement<{ className?: string; children?: ReactNode }>;
  if (typeof el.props.className === "string" && el.props.className.split(" ").includes("prompt-entry")) {
    out.push({ key: el.key, text: textOf(el.props.children) });
    return out;
  }
  return entries(el.props.children, out);
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node === "object" && "props" in node) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}

const render = (prompts: PromptEntry[]) =>
  entries(Detail({ agent: agent(prompts), now: 600_000, onOpenTool: () => {} }));

const keyOf = (list: { key: string | null; text: string }[], shows: string) => {
  const hit = list.filter(e => e.text.includes(shows));
  expect(hit, shows).toHaveLength(1);
  return hit[0].key;
};

describe("the detail panel's prompt list keeps each entry's identity (#1808)", () => {
  const A = { at: 10_000, text: notice('Background command "Watch CI" completed (exit code 0)') };
  const B = { at: 20_000, text: notice('Background command "Build" completed (exit code 0)') };
  const typed = { at: 30_000, text: "ship it" };

  it("keeps a notice's key when a newer notice arrives", () => {
    const before = keyOf(render([A]), "Watch CI");
    const after = render([A, B]);
    expect(keyOf(after, "Watch CI")).toBe(before);
    // And the newcomer does not inherit it, which is what opened the wrong one.
    expect(keyOf(after, "Build")).not.toBe(before);
  });

  it("keeps a notice's key when a typed prompt arrives", () => {
    const before = keyOf(render([A, B]), "Watch CI");
    expect(keyOf(render([A, B, typed]), "Watch CI")).toBe(before);
    expect(keyOf(render([A, B, typed]), "Build")).toBe(keyOf(render([A, B]), "Build"));
  });

  it("keeps the newer entries' keys when an older prompt is filed among them", () => {
    // The list is kept in time order, so a copy of an earlier prompt that was
    // missed and arrives late lands in the middle rather than at the end.
    const early = { at: 15_000, text: "the one that was missed" };
    const before = render([A, B, typed]);
    const after = render([A, early, B, typed]);
    for (const shows of ["Watch CI", "Build", "ship it"]) expect(keyOf(after, shows)).toBe(keyOf(before, shows));
  });

  it("gives every entry a key of its own, even two filed at the same moment", () => {
    const list = render([A, { at: A.at, text: "same millisecond" }, B]);
    expect(new Set(list.map(e => e.key)).size).toBe(3);
  });
});
