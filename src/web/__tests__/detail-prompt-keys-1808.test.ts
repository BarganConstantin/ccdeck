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

// CHANGED ON PURPOSE (V4 critique 3): the Inspector leaves out the prompt its
// Now note is already saying. Here the model has answered every prompt, so the
// note is its own line and every typed prompt is listed, which is what these
// tests are about.
const agent = (prompts: PromptEntry[]): AgentNodeData => ({
  id: "s1",
  sessionId: "s1",
  label: "api",
  kind: "root",
  state: "active",
  startedAt: 1_000,
  activity: { text: "Reading the workflow files", source: "said", at: 500_000 },
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

// CHANGED ON PURPOSE (owner's critique, 2026-11-11): a background task's notice
// is no longer listed, so the entries that keep their identity are the typed
// prompts; a notice landing among them must not move their keys either.
describe("the detail panel's prompt list keeps each entry's identity (#1808)", () => {
  const A = { at: 10_000, text: "watch CI please" };
  const B = { at: 20_000, text: "now build it" };
  const typed = { at: 30_000, text: "ship it" };

  it("keeps a prompt's key when a newer prompt arrives", () => {
    const before = keyOf(render([A]), "watch CI");
    const after = render([A, B]);
    expect(keyOf(after, "watch CI")).toBe(before);
    // And the newcomer does not inherit it.
    expect(keyOf(after, "build it")).not.toBe(before);
  });

  it("keeps every key when a background task's notice arrives, and does not list the notice", () => {
    const before = render([A, B]);
    const after = render([A, { at: 25_000, text: notice('Background command "Watch CI" completed (exit code 0)') }, B]);
    expect(after.map(e => e.key)).toEqual(before.map(e => e.key));
    expect(after.map(e => e.text).join("\n")).not.toContain("Background command");
  });

  it("keeps the newer entries' keys when an older prompt is filed among them", () => {
    // The list is kept in time order, so a copy of an earlier prompt that was
    // missed and arrives late lands in the middle rather than at the end.
    const early = { at: 15_000, text: "the one that was missed" };
    const before = render([A, B, typed]);
    const after = render([A, early, B, typed]);
    for (const shows of ["watch CI", "build it", "ship it"]) expect(keyOf(after, shows)).toBe(keyOf(before, shows));
  });

  it("gives every entry a key of its own, even two filed at the same moment", () => {
    const list = render([A, { at: A.at, text: "same millisecond" }, B]);
    expect(new Set(list.map(e => e.key)).size).toBe(3);
  });
});

describe("the detail panel's Prompts section (owner's critique, 2026-11-11)", () => {
  const N = { at: 40_000, text: notice("Background command finished") };
  /** The number in the Prompts heading, or null when there is no such section. */
  const count = (prompts: PromptEntry[]): string | null => {
    const find = (node: ReactNode): string | null => {
      if (Array.isArray(node)) { for (const c of node) { const hit = find(c); if (hit != null) return hit; } return null; }
      if (!node || typeof node !== "object" || !("props" in node)) return null;
      const el = node as ReactElement<{ className?: string; children?: ReactNode }>;
      if (el.props.className === "section-count" && el.type === "span") return textOf(el.props.children);
      return find(el.props.children);
    };
    const tree = Detail({ agent: { ...agent(prompts), tools: [] }, now: 600_000, onOpenTool: () => {} });
    // The tool calls' heading counts too; the Prompts one comes first.
    const all: string[] = [];
    const walk = (node: ReactNode) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object" || !("props" in node)) return;
      const el = node as ReactElement<{ className?: string; children?: ReactNode }>;
      if (el.type === "h3" && textOf(el.props.children).startsWith("Prompts")) { all.push(find(el.props.children) ?? ""); return; }
      walk(el.props.children);
    };
    walk(tree);
    return all[0] ?? null;
  };

  it("counts only what was typed, and is not there when only notices arrived", () => {
    expect(render([N])).toEqual([]);
    expect(count([N])).toBeNull();
    expect(count([{ at: 10_000, text: "ship it" }, N])).toBe("1");
    expect(render([{ at: 10_000, text: "ship it" }, N]).map(e => e.text)).toEqual([expect.stringContaining("ship it")]);
  });
});
