// Escape pressed while a tracker's modal is still on its way — its chunk
// loading, on a slow link or after the preload failed — closes the dialog the
// press opened, as Escape closes it once it is drawn. The press used to be
// lost: nothing was registered on modalStack while the chunk arrived, so the
// key fell through to the canvas, and the dialog opened seconds later anyway.
//
// Only the integrations' wrapper does this. Usage history, Browser Watch and
// Telemetry Radar keep lazyDialog's way (LazyDialog.tsx is not touched), so
// what they do while they load is as it was.
//
// No DOM: effects run as the server renderer draws, their cleanups kept for the
// test to run as an unmount would, and the chunk is an import that has not
// settled.
import { afterAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const fx = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  useEffect: (run: () => void | (() => void)) => {
    const off = run();
    if (typeof off === "function") fx.cleanups.push(off);
  },
}));

// The modal's chunk, on its way until a test lets it arrive.
const chunk = vi.hoisted(() => {
  let arrive: (mod: unknown) => void = () => {};
  const on = new Promise(resolve => { arrive = resolve; });
  return { on, arrive: (mod: unknown) => arrive(mod) };
});
vi.mock("../components/IntegrationModal", () => chunk.on);

import IntegrationModalOnDemand from "../components/IntegrationModalOnDemand";
import { escapeOutcome, modalStack } from "../modal-dismiss";

afterAll(() => { chunk.arrive({ default: () => null }); });

describe("a tracker's modal while its chunk is on its way", () => {
  const onClose = vi.fn();
  let html = "";

  it("draws nothing in its place, as the other three draw nothing while theirs arrives", () => {
    expect(modalStack.depth()).toBe(0);
    html = renderToStaticMarkup(createElement(IntegrationModalOnDemand, { kind: "jira", connections: [], onClose, onReconnect: () => {} }));
    expect(html).toBe("");
  });

  it("takes Escape already: the press closes the dialog it opened", () => {
    expect(modalStack.depth()).toBe(1);
    // A dialog, as the modal will be: the canvas letters wait behind it.
    expect(modalStack.dialogDepth()).toBe(1);
    // What use-deck-shortcuts.ts does with Escape: an overlay is open, so it
    // is dismissed, rather than the key going on to the canvas.
    expect(escapeOutcome({ overlayOpen: modalStack.depth() > 0, typing: false })).toBe("dismiss");
    expect(modalStack.dismissTop()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lets go of Escape once it is gone, closed or replaced by the modal that arrived", () => {
    expect(fx.cleanups.length).toBeGreaterThan(0);
    for (const off of fx.cleanups.splice(0)) off();
    expect(modalStack.depth()).toBe(0);
    expect(modalStack.dismissTop()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
