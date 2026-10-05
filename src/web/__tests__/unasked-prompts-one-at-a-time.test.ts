// A pairing request and the re-sign-in prompt that were both waiting for a
// dialog to close came up together the moment it did, stacked: the re-sign-in
// prompt — the later of the two in the document, and the one that matters
// less — over the pairing request, with the keyboard. One Escape put it away
// and left the request underneath.
//
// Each decided in its own render whether it was its turn, by counting the
// dialogs on the stack, and a dialog only joins the stack in an effect after
// the render that draws it — so on the render where the last dialog went, both
// counted none. The deck's order is the pairing request first: it is holding
// another machine up. The re-sign-in prompt follows once it is answered.
//
// Run, not read: DeckDialogs is drawn on fake-react.ts's React, with the two
// prompts' own components run for what they draw, against the real stack.
import { afterEach, describe, expect, it, vi } from "vitest";

import { all, mount, type Drawn } from "./fake-react";
import type { LanStranger } from "../lan-types";
import type { AttentionRow } from "../reauth-attention";

// The real React for what the dialogs' modules reach for as they load, and
// fake-react.ts's hooks for what is run here. DeckDialogs loads two of its
// dialogs when they open; neither is open here.
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  ...(await import("./fake-react")).react,
  lazy: (load: unknown) => load,
}));
vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));

const { default: DeckDialogs, UnaskedPrompts } = await import("../components/DeckDialogs");
const { AccountAttention, default: AccountAttentionModal } = await import("../components/AccountAttentionModal");
const { default: LanPairRequestModal } = await import("../components/LanPairRequestModal");
const { modalStack } = await import("../modal-dismiss");

const noop = () => {};
const asking: LanStranger = { fp: "aa11", name: "laptop", addr: "192.168.1.9", port: 4317, at: 1_000 };
const expired: AttentionRow = { id: "work@example.com#1", key: "work@example.com@@org-1", since: 1, num: 1, email: "work@example.com", name: "work@example.com", alias: null };

const lanPairs = (lanPending: LanStranger[]) => ({
  lanPending, lanDeferred: { current: new Set<string>() }, lanBusy: null,
  answerLanPair: async () => {}, deferLanPair: noop, lanStatus: undefined,
});
const attention = (rows: AttentionRow[]) => ({
  rows, signingIn: null, observe: noop, signIn: noop, signedIn: noop, refresh: noop, closeSignIn: noop, later: noop,
});
const props = (pending: LanStranger[], rows: AttentionRow[]) => ({
  dialogs: {
    openedTool: null, usageHistoryOpen: false, browserWatchOpen: false, contextAgent: null, summaryFor: null,
    keyHelpOpen: false, feedbackOpen: false, feedbackPrefill: null,
  },
  welcome: { tourOpen: false, releaseNotes: null },
  desktopUpdate: { readyAppUpdate: null, desktopUpdateFailure: null },
  versionCheck: { version: null },
  restart: { askRestart: noop },
  lanPairs: lanPairs(pending),
  attention: attention(rows),
  clearFlow: { clearConfirmOpen: false },
  watchBadge: {}, announcements: {}, appearance: { palette: {} }, providers: {}, stateRef: { current: {} }, agentCount: 0,
}) as unknown as Parameters<typeof DeckDialogs>[0];

/** The prompts' components, wherever DeckDialogs draws them, run for what
 *  they draw — each kept mounted across renders, as React keeps them. */
const prompts = new Set<unknown>([UnaskedPrompts, AccountAttention]);
const kept = new Map<unknown, ReturnType<typeof mount<Record<string, unknown>>>>();
function expand(tree: unknown): unknown {
  if (Array.isArray(tree)) return tree.map(expand);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return tree;
  const el = tree as Drawn;
  if (prompts.has(el.type)) {
    const run = el.type as (p: Record<string, unknown>) => unknown;
    const view = kept.get(run);
    if (view) view.rerender(el.props);
    else kept.set(run, mount(run, el.props));
    return expand(kept.get(run)!.tree);
  }
  return { ...el, props: { ...el.props, children: expand(el.props.children) } };
}

/** Which of the two prompts are on screen, in document order. */
function drawn(tree: unknown): string[] {
  return all(expand(tree), el => el.type === LanPairRequestModal || el.type === AccountAttentionModal)
    .map(el => (el.type === LanPairRequestModal ? "pairing request" : "re-sign-in"));
}

const opened: Array<() => void> = [];
afterEach(() => { while (opened.length) opened.pop()!(); kept.clear(); });

describe("the pairing request and the re-sign-in prompt", () => {
  it("wait together while a dialog is open, and come up one at a time when it closes: the pairing request first", () => {
    opened.push(modalStack.push(noop)); // Feedback, say
    const view = mount(DeckDialogs, props([asking], [expired]));
    expect(drawn(view.tree)).toEqual([]);
    opened.pop()!();
    view.rerender();
    expect(drawn(view.tree)).toEqual(["pairing request"]);
    // Its own mount puts it on the stack, after that render.
    opened.push(modalStack.push(noop));
    view.rerender();
    expect(drawn(view.tree)).toEqual(["pairing request"]);
  });

  it("the re-sign-in prompt follows once the request is answered", () => {
    const view = mount(DeckDialogs, props([asking], [expired]));
    expect(drawn(view.tree)).toEqual(["pairing request"]);
    opened.push(modalStack.push(noop));
    view.rerender(props([], [expired]));
    // The request's dialog leaves the stack as it unmounts, after the render.
    opened.pop()!();
    view.rerender();
    expect(drawn(view.tree)).toEqual(["re-sign-in"]);
  });

  it("each still comes up alone when it is the only one", () => {
    expect(drawn(mount(DeckDialogs, props([asking], [])).tree)).toEqual(["pairing request"]);
    kept.clear();
    expect(drawn(mount(DeckDialogs, props([], [expired])).tree)).toEqual(["re-sign-in"]);
  });
});
