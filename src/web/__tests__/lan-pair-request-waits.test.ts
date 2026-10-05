// A LAN pairing request that arrived while another dialog was open opened
// underneath it and took the keyboard.
//
// The request is not portalled, and the panel's dialogs are — the network map,
// Busiest processes, Add a Claude account and its code step, Account capacity —
// on the same z-index, so the later one in the document paints on top and the
// request was drawn under whatever was open. Its mount still moved focus to its
// Decline, and it was the newest entry in the Escape stack: Escape meant for the
// map put the request off until the page was reloaded, and Enter — the Enter of
// somebody typing a sign-in code — declined the other deck unseen.
//
// Now it waits its turn, as the re-sign-in prompt already did: drawn only while
// no other dialog is up, and kept once it is (promptShows).
//
// Run, not read: usePairRequestDialog is called on fake-react.ts's React,
// against the real stack every dialog registers itself on.
import { afterEach, describe, expect, it, vi } from "vitest";

import { mount, type Drawn } from "./fake-react";
import type { LanStranger } from "../lan-types";

vi.mock("react", async () => (await import("./fake-react")).react);

const { usePairRequestDialog } = await import("../components/LanPairRequestModal");
const { modalStack } = await import("../modal-dismiss");

const ask = (fp: string, name: string, at: number): LanStranger => ({ fp, name, addr: "192.168.1.9", port: 62259, at });
const asking = ask("aa11", "stranger", 1_000);
const next = ask("bb22", "another", 2_000);

/** The hook's return, for this queue, with answers that go nowhere. */
const props = (lanPending: LanStranger[]) => ({
  lanPending,
  lanDeferred: { current: new Set<string>() },
  lanBusy: null,
  answerLanPair: async () => {},
  deferLanPair: () => {},
  lanStatus: undefined,
});

/** Another dialog on screen — the network map, a sign-in, a report. Each one
 *  registers itself on the stack for as long as it is mounted. */
const opened: Array<() => void> = [];
function openDialog() {
  opened.push(modalStack.push(() => {}));
}
afterEach(() => { while (opened.length) opened.pop()!(); });

/** The request's dialog, if one is drawn: the element and the deck it asks about. */
const asked = (tree: unknown) => (tree && typeof tree === "object" ? String((tree as Drawn & { key?: string }).key) : null);

describe("a pairing request that arrives while another dialog is open", () => {
  it("is not drawn under it, so it cannot take the keyboard from it", () => {
    openDialog();
    const view = mount(usePairRequestDialog, props([asking]));
    expect(asked(view.tree)).toBeNull();
  });

  it("is asked once that dialog has closed", () => {
    openDialog();
    const view = mount(usePairRequestDialog, props([asking]));
    opened.pop()!();
    view.rerender();
    expect(asked(view.tree)).toBe(asking.fp);
  });

  it("is asked at once when nothing else is open", () => {
    const view = mount(usePairRequestDialog, props([asking]));
    expect(asked(view.tree)).toBe(asking.fp);
  });

  it("stays once it is asked, whatever opens over it, and brings the next request with its answer", () => {
    const view = mount(usePairRequestDialog, props([asking, next]));
    expect(asked(view.tree)).toBe(asking.fp);
    // Its own dialog is on the stack while it is up, and something arrives
    // over it — neither takes it away.
    openDialog();
    openDialog();
    view.rerender();
    expect(asked(view.tree)).toBe(asking.fp);
    // Answered: the next deck in the queue is asked straight after.
    view.rerender(props([next]));
    expect(asked(view.tree)).toBe(next.fp);
  });
});
