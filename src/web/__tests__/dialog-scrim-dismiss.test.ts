// A text selection closed the dialog it was made in. A click goes to the
// nearest element its press and its release share, so a drag begun in a field
// and let go past the dialog's edge, over the scrim, arrives as a click whose
// target is the backdrop — the dialog's own stopPropagation is not on that
// path — and every backdrop but the feedback dialog's closed on any click. The
// name typed into "This deck on the network", a code or a share half pasted
// into Add account, the share Share accounts had just made: all of it was the
// dialog's state, and went with it.
//
// The feedback dialog was fixed with useScrimDismiss (#1925); every backdrop
// uses it now. Three of the dialogs that hold something worth keeping are run
// on fake-react.ts's React, their backdrop's handlers called with the targets
// the browser would hand them, and the rest are held to the same rule by
// reading their source.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clientPairs } from "./client-source";
import { mount, one, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("react-dom", async orig => ({ ...(await orig<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));
vi.mock("../components/use-modal-dismiss", async orig => ({
  ...(await orig<typeof import("../components/use-modal-dismiss")>()),
  useModalDismiss: () => ({ current: null }),
}));
// Built with forwardRef when it loads; the success card is not what is under test.
vi.mock("../components/SuccessMark", () => ({ default: () => null }));

const { default: LanSetupModal } = await import("../components/LanSetupModal");
const { default: AddAccountDialog } = await import("../components/AddAccountDialog");
const { default: ShareAccountsDialog } = await import("../components/ShareAccountsDialog");

beforeEach(() => {
  // What the dialogs ask for on open; never answered, which they allow.
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  // Where the portals go, which the mock above never looks at.
  vi.stubGlobal("document", { body: null, activeElement: null });
});
afterEach(() => { vi.unstubAllGlobals(); });

const scrim = (tree: unknown) =>
  one(tree, el => typeof el.props.className === "string" && el.props.className.split(" ").includes("modal-backdrop")) as Drawn;

/** Stand-ins for the nodes a press can land on: the scrim itself, and a field
 *  inside the dialog. */
const SCRIM = { node: "scrim" };
const FIELD = { node: "field" };

/** One mouse press, as the backdrop sees it: down on one node, up on another,
 *  and the click the browser then sends to the nearest node the two share —
 *  the scrim whenever either end was on it, since the dialog is inside it.
 *  Handlers the backdrop does not have are skipped. */
function press(tree: unknown, down: object, up: object) {
  const call = (name: string, target: object) =>
    (scrim(tree).props[name] as ((e: unknown) => void) | undefined)?.({
      target, currentTarget: SCRIM, stopPropagation() {}, preventDefault() {},
    });
  call("onPointerDown", down);
  call("onPointerUp", up);
  call("onClick", down === FIELD && up === FIELD ? FIELD : SCRIM);
}

const dialogs: Array<[string, (onClose: () => void) => { tree: unknown }]> = [
  ["This deck on the network", onClose => mount(LanSetupModal, {
    status: {
      enabled: true, running: true, name: "Studio", fp: "abcd-ef01-2345-6789", port: 57051,
      addrs: [], shared: [], peers: [], trusted: [], invite: null, pending: [], strangers: [],
    } as never,
    accounts: [],
    onClose,
    onChanged: vi.fn(),
  })],
  ["Add account", onClose => mount(AddAccountDialog, { onClose, onChanged: vi.fn() })],
  ["Share accounts", onClose => mount(ShareAccountsDialog, {
    accounts: [{ num: 1, email: "a@example.com", alias: null, org: null }],
    onClose,
    copyText: vi.fn(async () => true),
  })],
];

describe.each(dialogs)("the scrim of %s", (_name, open) => {
  it("stays open when a selection begun in a field is let go over the scrim", () => {
    const onClose = vi.fn();
    const view = open(onClose);
    press(view.tree, FIELD, SCRIM);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stays open when a press begun on the scrim is let go inside the dialog", () => {
    const onClose = vi.fn();
    const view = open(onClose);
    press(view.tree, SCRIM, FIELD);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on a press that starts and ends on the scrim, after a selection that did not", () => {
    const onClose = vi.fn();
    const view = open(onClose);
    press(view.tree, FIELD, SCRIM);
    press(view.tree, SCRIM, SCRIM);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/** Every backdrop's opening tag, from `<div` to the `>` that closes it, with
 *  the file it is in. Braces are counted so an arrow inside an attribute does
 *  not end the tag. */
function backdropTags(): Array<{ file: string; tag: string; src: string }> {
  const out: Array<{ file: string; tag: string; src: string }> = [];
  for (const [file, src] of clientPairs()) {
    for (const m of src.matchAll(/<div className="modal-backdrop[" ]/g)) {
      let depth = 0;
      let end = m.index;
      for (; end < src.length; end++) {
        const c = src[end];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) break;
      }
      out.push({ file, tag: src.slice(m.index, end + 1), src });
    }
  }
  return out;
}

describe("every dialog backdrop", () => {
  it("closes only through useScrimDismiss, never on a bare click", () => {
    const tags = backdropTags();
    // The sweep has to have found the deck's dialogs to say anything about them.
    expect(tags.length).toBeGreaterThanOrEqual(23);
    for (const { file, tag, src } of tags) {
      expect(tag, file).not.toMatch(/\sonClick=/);
      const spread = /\{\.\.\.(\w+)\}/.exec(tag)?.[1];
      expect(spread, file).toBeTruthy();
      expect(src, file).toMatch(new RegExp(`const ${spread} = useScrimDismiss\\(`));
    }
  });
});
