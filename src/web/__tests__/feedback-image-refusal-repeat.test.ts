// The "three images at most" refusal, said every time it happens.
//
// With three images attached, a fourth pasted, dropped or picked is refused.
// The first time, the alert appeared and was read out. The second time nothing
// happened at all: the add awaits nothing when the dialog is full, so the
// clear it starts with and the refusal it ends with landed in one React batch,
// the words came out the same, and the alert neither changed nor was read
// again, nor scrolled into view. "Add screenshot" pressed while full set the
// same words without clearing them first, so it was silent from the second
// press on. A refused type was said twice, but only because its add awaits.
//
// Run, not read: the hook runs in React itself, under a root with nothing to
// draw. A component that renders null needs no DOM, only the two things
// react-dom asks of `window` on the way. What the dialog draws from it — the
// alert keyed on each refusal — is FeedbackShots', compared in a browser and
// pinned in feedback-images.test.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FULL_MESSAGE } from "../feedback-images";
import { useFeedbackImages, type FeedbackImages } from "../use-feedback-images";

/** A PNG small enough to be sent as it is, so no canvas is asked for. */
function png(name = "shot.png"): File {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 400);
  view.setUint32(20, 300);
  return new File([bytes], name, { type: "image/png" });
}

const gif = () => new File([new TextEncoder().encode("GIF89a........")], "clip.gif", { type: "image/gif" });

const renders: FeedbackImages[] = [];
let root: Root;
const now = () => renders[renders.length - 1];

/** The refusals the dialog was handed since render `from`. One is new when
 *  its words or its identity differ from the render before — the same words
 *  as a new refusal are what has to be said again. */
function refusalsSince(from: number): string[] {
  const said: string[] = [];
  for (let i = Math.max(from, 1); i < renders.length; i++) {
    const before = renders[i - 1];
    const { problem, problemId } = renders[i];
    if (problem && (problem !== before.problem || problemId !== before.problemId)) said.push(problem);
  }
  return said;
}

async function step(run: (images: FeedbackImages) => void) {
  await act(async () => {
    run(now());
    await now().ready();
  });
}

beforeAll(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // react-dom reads window.event for an update's priority and walks iframes
  // for focus before a commit; neither has anything to find here.
  vi.stubGlobal("window", { HTMLIFrameElement: class {} });
  function Probe() {
    renders.push(useFeedbackImages());
    return null;
  }
  const container = {
    nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {},
  };
  root = createRoot(container as unknown as Element);
  await act(async () => root.render(createElement(Probe)));
  await step(images => images.add([png("1.png"), png("2.png"), png("3.png")]));
});

afterAll(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("a refusal said twice is a second refusal", () => {
  it("starts full", () => {
    expect(now().shots.length).toBe(3);
    expect(now().problem).toBe("");
  });

  it("says the fourth image is one too many, each time one is pasted", async () => {
    const from = renders.length;
    await step(images => images.add([png("4.png")]));
    await step(images => images.add([png("5.png")]));
    expect(refusalsSince(from)).toEqual([FULL_MESSAGE, FULL_MESSAGE]);
  });

  it("says so each time Add screenshot is pressed while full", async () => {
    const from = renders.length;
    await step(images => images.sayFull());
    await step(images => images.sayFull());
    expect(refusalsSince(from)).toEqual([FULL_MESSAGE, FULL_MESSAGE]);
  });

  it("says a refused type twice, however the clear and the refusal land", async () => {
    // A refused type was said again in the browser only because its add
    // awaits the file's first bytes, which let the clear render on its own.
    // Here every update in a step lands in one batch, as the full case's
    // always did; each refusal is new by its identity now, not by the timing.
    await step(images => images.remove(images.shots[2].id));
    const from = renders.length;
    await step(images => images.add([gif()]));
    await step(images => images.add([gif()]));
    const said = refusalsSince(from);
    expect(said.length).toBe(2);
    expect(said[0]).toMatch(/clip\.gif/);
    expect(said[1]).toBe(said[0]);
  });
});
