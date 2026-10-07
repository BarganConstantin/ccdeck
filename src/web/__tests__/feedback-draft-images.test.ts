// What the feedback dialog's images hand back when it closes, and how they
// come back when it opens (feedback-draft.ts): an image that is ready comes
// back as it will be sent; one still being redrawn to fit, or still waiting
// its turn, comes back as its file and is fitted again; one removed, or
// discarded, does not come back at all.
//
// Run on fake-react.ts's React, with the fit of each image answered by the
// test, as feedback-refused-while-sending.test.ts does.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { flush, mount } from "./fake-react";
import type { Prepared } from "../feedback-images";
import type { KeptImages } from "../use-feedback-images";

vi.mock("react", async () => (await import("./fake-react")).react);

/** Each fit under way, answered when the test says. The decoder is called
 *  first, which is the moment the hook shows the image as resizing. */
let fits: Array<(prepared: Prepared) => void>;
vi.mock("../feedback-images", async orig => ({
  ...(await orig<typeof import("../feedback-images")>()),
  browserDecoder: async () => null,
  prepareImage: async (file: Blob, _budget: number, decode: (file: Blob) => Promise<unknown>) => {
    await decode(file);
    return new Promise<Prepared>(resolve => fits.push(resolve));
  },
}));

const { useFeedbackImages } = await import("../use-feedback-images");

const png = (name: string) => new File([new Uint8Array(64)], name, { type: "image/png" });
const fitted = (): Prepared => ({ ok: true, blob: new Blob([new Uint8Array(32)], { type: "image/png" }), resized: { width: 2560, height: 1440 } });

beforeEach(() => { fits = []; });

function open(restore?: KeptImages) {
  return mount((props: { restore?: KeptImages }) => useFeedbackImages(props.restore), { restore });
}

describe("the images a closed feedback dialog keeps", () => {
  it("keeps a ready image as it will be sent, and draws it on the first render when it opens", async () => {
    const first = open();
    first.tree.add([png("chart.png")]);
    await flush();
    const answer = fitted();
    fits[0](answer);
    await first.tree.ready();
    const kept = first.tree.kept();
    expect(kept.waiting).toEqual([]);
    expect(kept.ready).toEqual([{ name: "chart.png", blob: answer.ok && answer.blob, resized: { width: 2560, height: 1440 } }]);
    first.unmount();

    const again = open(kept);
    expect(again.tree.shots.map(shot => [shot.name, shot.blob])).toEqual([["chart.png", answer.ok && answer.blob]]);
    expect(fits).toHaveLength(1);
    expect(await again.tree.ready()).toHaveLength(1);
  });

  it("hands back an image still being fitted as its file, and fits it again when it opens", async () => {
    const file = png("5k.png");
    const first = open();
    first.tree.add([file]);
    await flush();
    expect(first.tree.shots).toHaveLength(1);
    const kept = first.tree.kept();
    expect(kept).toEqual({ ready: [], waiting: [file] });
    first.unmount();
    fits[0](fitted());
    await flush();

    const again = open(kept);
    await flush();
    expect(fits).toHaveLength(2);
    fits[1](fitted());
    expect(await again.tree.ready()).toHaveLength(1);
    expect(again.tree.shots.map(shot => shot.name)).toEqual(["5k.png"]);
  });

  it("hands back files still waiting their turn behind a fit", async () => {
    const [a, b] = [png("a.png"), png("b.png")];
    const view = open();
    view.tree.add([a]);
    view.tree.add([b]);
    await flush();
    expect(fits).toHaveLength(1);
    expect(view.tree.kept()).toEqual({ ready: [], waiting: [a, b] });
  });

  it("does not hand back an image removed while it was being fitted", async () => {
    const view = open();
    view.tree.add([png("oops.png")]);
    await flush();
    view.tree.remove(view.tree.shots[0].id);
    expect(view.tree.kept()).toEqual({ ready: [], waiting: [] });
  });

  it("hands back an image being replaced as its replacement alone", async () => {
    const replacement = png("new.png");
    const view = open();
    view.tree.add([png("old.png")]);
    await flush();
    fits[0](fitted());
    await view.tree.ready();
    view.tree.replace(view.tree.shots[0].id, [replacement]);
    await flush();
    expect(view.tree.kept()).toEqual({ ready: [], waiting: [replacement] });
  });

  it("lets go of everything on clear: the images, a fit under way, and an add still waiting", async () => {
    const view = open();
    view.tree.add([png("a.png")]);
    await flush();
    fits[0](fitted());
    await view.tree.ready();
    view.tree.add([png("b.png")]);
    view.tree.add([png("c.png")]);
    await flush();
    expect(view.tree.shots).toHaveLength(2);

    view.tree.clear();
    expect(view.tree.shots).toEqual([]);
    expect(view.tree.kept()).toEqual({ ready: [], waiting: [] });
    fits[1](fitted());
    await view.tree.ready();
    await flush();
    expect(view.tree.shots).toEqual([]);
    // c.png was waiting behind b.png and never begins.
    expect(fits).toHaveLength(2);
    expect(view.tree.kept()).toEqual({ ready: [], waiting: [] });
  });

  it("takes new images after a clear, once the discarded fit has finished and added nothing", async () => {
    const view = open();
    view.tree.add([png("a.png")]);
    await flush();
    view.tree.clear();
    view.tree.add([png("b.png")]);
    await flush();
    expect(fits).toHaveLength(1);
    fits[0](fitted());
    await flush();
    expect(fits).toHaveLength(2);
    fits[1](fitted());
    await view.tree.ready();
    expect(view.tree.shots.map(shot => shot.name)).toEqual(["b.png"]);
  });
});
