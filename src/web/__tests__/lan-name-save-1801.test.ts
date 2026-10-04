// #1801. Enter in "appear as", or its `save`, sent the typed name and threw it
// away in the same breath: the write went out and the draft was cleared
// without waiting for the answer. So the field snapped back to the old name at
// once, and when the deck refused the write — a settings folder it could not
// write, a deck that did not answer — the failure line arrived beside a field
// that no longer held what the reader had typed. `save` also took itself away
// under the press, since it is drawn only while there is a draft. Done had the
// rule already: it waited, and on a refusal kept the draft and stayed open.
//
// Run, not read: the dialog is called on fake-react.ts's React, against a
// fetch whose answers the test hands back one at a time and a document whose
// focused element the test holds.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flush, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));
vi.mock("../components/use-modal-dismiss", async orig => ({
  ...(await orig<typeof import("../components/use-modal-dismiss")>()),
  useModalDismiss: () => ({ current: null }),
}));

const { default: LanSetupModal } = await import("../components/LanSetupModal");

type Props = Parameters<typeof LanSetupModal>[0];

/** A focusable node, and how to find the element it is in a tree. */
interface Node { tagName: string; find?: (tree: unknown) => Drawn | null; focus(): void }
const BODY: Node = { tagName: "BODY", focus() {} };
let page: { activeElement: Node; body: null };
const node = (tagName: string, find: (tree: unknown) => Drawn | null): Node => {
  const n: Node = { tagName, find, focus: () => { page.activeElement = n; } };
  return n;
};

const field = (tree: unknown) =>
  one(tree, el => el.type === "input" && el.props["aria-label"] === "This deck's name on the network");
const saveButton = (tree: unknown) => one(tree, el => el.type === "button" && textOf(el) === "save");
const doneButton = (tree: unknown) => one(tree, el => el.type === "button" && textOf(el).trim() === "Done");
/** The failure line's element: what it is handed is what it draws. */
const failureLine = (tree: unknown) =>
  one(tree, el => typeof el.type === "function" && "onDismiss" in el.props && "line" in el.props);

const fieldNode = node("INPUT", field);
const saveNode = node("BUTTON", saveButton);

/** What the deck has been asked, and a way to answer the oldest ask. */
let asks: Array<{ lan: Record<string, unknown>; reply: (out: unknown) => void }>;

beforeEach(() => {
  page = { activeElement: BODY, body: null };
  asks = [];
  vi.stubGlobal("document", page);
  vi.stubGlobal("fetch", vi.fn((_url: string, init: { body: string }) => new Promise(resolve => {
    asks.push({ lan: JSON.parse(init.body).lan, reply: out => resolve({ json: async () => out }) });
  })));
});

afterEach(() => { vi.unstubAllGlobals(); });

async function answer(out: unknown) {
  const ask = asks.shift();
  if (!ask) throw new Error("nothing was asked");
  ask.reply(out);
  await flush();
}

const REFUSED = { ok: false, reason: "EACCES" };

function open(over: Partial<Props> = {}) {
  const props: Props = {
    status: {
      enabled: true, running: true, name: "Studio", fp: "abcd-ef01-2345-6789", port: 57051,
      addrs: [], shared: [], peers: [], trusted: [], invite: null, pending: [], strangers: [],
    } as never,
    accounts: [],
    onClose: vi.fn(),
    onChanged: vi.fn(),
    ...over,
  };
  const view = mount(LanSetupModal, props, {
    // What the document does with a render: the field's node goes to its ref,
    // and a focused element the render took away takes focus with it.
    commit: tree => {
      const f = field(tree);
      if (f?.ref && typeof f.ref === "object") (f.ref as { current: unknown }).current = fieldNode;
      if (page.activeElement.find && !page.activeElement.find(tree)) page.activeElement = BODY;
    },
  });
  const type = (value: string) => (field(view.tree)!.props.onChange as (e: unknown) => void)({ target: { value } });
  const value = () => field(view.tree)!.props.value;
  return { view, props, type, value };
}

describe("a typed name is kept until the deck has kept it (#1801)", () => {
  it("stays in the field while Enter's save is out, and after the deck refuses it", async () => {
    const { view, type, value } = open();
    type("Studio 2");
    (field(view.tree)!.props.onKeyDown as (e: unknown) => void)({ key: "Enter" });
    expect(asks.map(a => a.lan)).toEqual([{ name: "Studio 2" }]);
    // No snap back to the old name while the answer is out.
    expect(value()).toBe("Studio 2");
    await answer(REFUSED);
    expect(value()).toBe("Studio 2");
    expect((failureLine(view.tree)!.props.line as { text?: string } | null)).not.toBeNull();
    // And the way to try again is still there.
    expect(saveButton(view.tree)).not.toBeNull();
  });

  it("stays in the field when `save` is refused, and `save` stays under the press", async () => {
    const { view, type, value } = open();
    type("Studio 2");
    saveNode.focus();
    (saveButton(view.tree)!.props.onClick as () => void)();
    expect(saveButton(view.tree)).not.toBeNull();
    expect(page.activeElement).toBe(saveNode);
    await answer(REFUSED);
    expect(value()).toBe("Studio 2");
    expect(saveButton(view.tree)).not.toBeNull();
    expect(page.activeElement).toBe(saveNode);
  });

  it("lets go of it once the deck has kept it", async () => {
    const { view, props, type, value } = open();
    type("Studio 2");
    (field(view.tree)!.props.onKeyDown as (e: unknown) => void)({ key: "Enter" });
    await answer({ ok: true });
    // Released: with the status not yet reloaded, a kept draft would still
    // be drawing `save` beside a name that differs from the deck's.
    expect(saveButton(view.tree)).toBeNull();
    expect(props.onChanged).toHaveBeenCalled();
    view.rerender({ ...props, status: { ...props.status, name: "Studio 2" } });
    expect(value()).toBe("Studio 2");
  });

  it("keeps what was typed on while the answer was out", async () => {
    // That is newer than what was sent, and the answer is not about it.
    const { view, type, value } = open();
    type("Studio 2");
    (field(view.tree)!.props.onKeyDown as (e: unknown) => void)({ key: "Enter" });
    type("Studio 22");
    await answer({ ok: true });
    expect(value()).toBe("Studio 22");
    expect(saveButton(view.tree)).not.toBeNull();
  });

  it("hands focus to the field when a kept save takes `save` away", async () => {
    const { view, type } = open();
    type("Studio 2");
    saveNode.focus();
    (saveButton(view.tree)!.props.onClick as () => void)();
    await answer({ ok: true });
    expect(saveButton(view.tree)).toBeNull();
    expect(page.activeElement).toBe(fieldNode);
  });

  it("keeps Done's rule: a refused name keeps the dialog open with the name in it", async () => {
    const { view, props, type, value } = open();
    type("Studio 2");
    (doneButton(view.tree)!.props.onClick as () => void)();
    await answer(REFUSED);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(value()).toBe("Studio 2");
    (doneButton(view.tree)!.props.onClick as () => void)();
    await answer({ ok: true });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
