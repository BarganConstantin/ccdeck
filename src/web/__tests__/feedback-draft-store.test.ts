// Where a feedback draft is kept, and for how long (feedback-draft.ts): in
// memory while the page is open, its words also in sessionStorage so a reload
// of the tab keeps them, its images never written anywhere but memory. A
// reload is a second store made over the same storage.
import { describe, expect, it } from "vitest";

import {
  DRAFTS_STORAGE_KEY, MAX_DRAFTS, createDraftStore, draftKey, feedbackSeed, holdsSomething, imagesLostLine,
  parseStoredDraft, type DraftContent,
} from "../feedback-draft";
import type { KeptImages } from "../use-feedback-images";

/** sessionStorage as far as the store uses it. */
function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: key => data.get(key) ?? null,
    key: i => [...data.keys()][i] ?? null,
    removeItem: key => { data.delete(key); },
    setItem: (key, value) => { data.set(key, String(value)); },
  };
}

const BLANK = feedbackSeed({});
const NO_IMAGES: KeptImages = { ready: [], waiting: [] };
const shot = (name: string) => ({ name, blob: new Blob([new Uint8Array(2048)], { type: "image/png" }), resized: null });
const draft = (over: Partial<DraftContent> = {}): DraftContent =>
  ({ kind: "bug", body: "The usage chart is empty after a restart", contact: "", images: NO_IMAGES, ...over });

describe("a feedback draft's words", () => {
  it("are kept through a reload of the tab, and the images are not, though their count is", () => {
    const storage = memoryStorage();
    const before = createDraftStore(() => storage);
    before.keep(draftKey(BLANK), draft({ kind: "idea", contact: "bob@example.org", images: { ready: [shot("a.png"), shot("b.png")], waiting: [] } }), BLANK);

    const after = createDraftStore(() => storage);
    expect(after.read(draftKey(BLANK))).toEqual({
      kind: "idea", body: "The usage chart is empty after a restart", contact: "bob@example.org",
      images: NO_IMAGES, imagesLost: 2,
    });
  });

  it("come back with their images, and nothing said lost, while the page stays open", () => {
    const store = createDraftStore(() => memoryStorage());
    const images = { ready: [shot("a.png")], waiting: [new File([new Uint8Array(8)], "b.png")] };
    store.keep(draftKey(BLANK), draft({ images }), BLANK);
    const read = store.read(draftKey(BLANK));
    expect(read?.images).toBe(images);
    expect(read?.imagesLost).toBe(0);
  });

  it("never write an image's bytes to the storage", () => {
    const storage = memoryStorage();
    createDraftStore(() => storage).keep(draftKey(BLANK), draft({ images: { ready: [shot("a.png")], waiting: [] } }), BLANK);
    const written = storage.getItem(DRAFTS_STORAGE_KEY) ?? "";
    expect(JSON.parse(written)).toEqual([[draftKey(BLANK), {
      kind: "bug", body: "The usage chart is empty after a restart", contact: "", images: 1,
    }]]);
  });

  it("are let go, from memory and the storage, once the draft is forgotten", () => {
    const storage = memoryStorage();
    const store = createDraftStore(() => storage);
    store.keep(draftKey(BLANK), draft(), BLANK);
    store.forget(draftKey(BLANK));
    expect(store.read(draftKey(BLANK))).toBeNull();
    expect(storage.getItem(DRAFTS_STORAGE_KEY)).toBeNull();
    expect(createDraftStore(() => storage).read(draftKey(BLANK))).toBeNull();
  });
});

describe("what counts as a draft", () => {
  it("is words the seed did not have, a contact, or an image — never a kind alone, or spaces", () => {
    expect(holdsSomething({ body: "ok", contact: "", images: 0 }, BLANK)).toBe(true);
    expect(holdsSomething({ body: "", contact: "bob", images: 0 }, BLANK)).toBe(true);
    expect(holdsSomething({ body: "", contact: "", images: 1 }, BLANK)).toBe(true);
    expect(holdsSomething({ body: "  \n ", contact: "  ", images: 0 }, BLANK)).toBe(false);
    const seed = feedbackSeed({ initialKind: "other", initialBody: "Account issue: rate limited." });
    expect(holdsSomething({ body: "Account issue: rate limited.", contact: "", images: 0 }, seed)).toBe(false);
    expect(holdsSomething({ body: "Account issue: rate limited. Still.", contact: "", images: 0 }, seed)).toBe(true);
  });

  it("lets go of a draft that holds nothing its seed did not, rather than keep an empty one", () => {
    const storage = memoryStorage();
    const store = createDraftStore(() => storage);
    store.keep(draftKey(BLANK), draft(), BLANK);
    store.keep(draftKey(BLANK), draft({ kind: "idea", body: "" }), BLANK);
    expect(store.read(draftKey(BLANK))).toBeNull();
    expect(storage.getItem(DRAFTS_STORAGE_KEY)).toBeNull();
  });

  it("is kept per door: a blank report shares one, a seeded one has its own", () => {
    expect(draftKey(feedbackSeed({}))).toBe(draftKey(feedbackSeed({ initialKind: "bug", initialBody: "" })));
    expect(draftKey(feedbackSeed({}))).not.toBe(draftKey(feedbackSeed({ initialKind: "other", initialBody: "Account issue" })));
    expect(draftKey(feedbackSeed({ initialKind: "bug", initialBody: "x" })))
      .not.toBe(draftKey(feedbackSeed({ initialKind: "other", initialBody: "x" })));
  });
});

describe("how many drafts, and what the storage may do", () => {
  it(`keeps at most ${MAX_DRAFTS}, the oldest let go first, and a draft written again counts as new`, () => {
    const storage = memoryStorage();
    const store = createDraftStore(() => storage);
    const seeds = Array.from({ length: MAX_DRAFTS + 1 }, (_, i) => feedbackSeed({ initialKind: "bug", initialBody: `seed ${i}` }));
    for (const seed of seeds.slice(0, MAX_DRAFTS)) store.keep(draftKey(seed), draft({ body: `${seed.body}, written` }), seed);
    store.keep(draftKey(seeds[0]), draft({ body: "seed 0, written again" }), seeds[0]);
    store.keep(draftKey(seeds[MAX_DRAFTS]), draft({ body: "the newest" }), seeds[MAX_DRAFTS]);
    expect(store.read(draftKey(seeds[1]))).toBeNull();
    expect(store.read(draftKey(seeds[0]))?.body).toBe("seed 0, written again");
    expect(store.read(draftKey(seeds[MAX_DRAFTS]))?.body).toBe("the newest");
    expect(JSON.parse(storage.getItem(DRAFTS_STORAGE_KEY) ?? "[]")).toHaveLength(MAX_DRAFTS);
  });

  it("keeps the draft in memory when the storage cannot be reached or refuses a write", () => {
    const unreachable = createDraftStore(() => { throw new Error("SecurityError"); });
    unreachable.keep(draftKey(BLANK), draft(), BLANK);
    expect(unreachable.read(draftKey(BLANK))?.body).toBe("The usage chart is empty after a restart");

    const full = memoryStorage();
    full.setItem = () => { throw new Error("QuotaExceededError"); };
    const refusing = createDraftStore(() => full);
    expect(() => refusing.keep(draftKey(BLANK), draft(), BLANK)).not.toThrow();
    expect(refusing.read(draftKey(BLANK))?.body).toBe("The usage chart is empty after a restart");

    const none = createDraftStore(() => null);
    none.keep(draftKey(BLANK), draft(), BLANK);
    expect(none.read(draftKey(BLANK))?.body).toBe("The usage chart is empty after a restart");
  });

  it("reads back only what it could have written, and nothing from a value it cannot parse", () => {
    const storage = memoryStorage();
    storage.setItem(DRAFTS_STORAGE_KEY, "{not json");
    expect(createDraftStore(() => storage).read(draftKey(BLANK))).toBeNull();

    storage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify([
      ["junk", { kind: "rant", body: "x", contact: "", images: 0 }],
      [draftKey(BLANK), { kind: "bug", body: "kept", contact: "", images: 0 }],
    ]));
    const store = createDraftStore(() => storage);
    expect(store.read("junk")).toBeNull();
    expect(store.read(draftKey(BLANK))?.body).toBe("kept");
  });

  it("refuses a stored draft over the dialog's own limits", () => {
    const ok = { kind: "bug", body: "x", contact: "", images: 0 };
    expect(parseStoredDraft(["k", ok])).toEqual(["k", ok]);
    expect(parseStoredDraft(["k", { ...ok, kind: "rant" }])).toBeNull();
    expect(parseStoredDraft(["k", { ...ok, body: "x".repeat(10_001) }])).toBeNull();
    expect(parseStoredDraft(["k", { ...ok, contact: "x".repeat(201) }])).toBeNull();
    expect(parseStoredDraft(["k", { ...ok, images: 4 }])).toBeNull();
    expect(parseStoredDraft(["k", { ...ok, images: 1.5 }])).toBeNull();
    expect(parseStoredDraft(["k", { ...ok, images: -1 }])).toBeNull();
    expect(parseStoredDraft([1, ok])).toBeNull();
    expect(parseStoredDraft(["k", null])).toBeNull();
    expect(parseStoredDraft(null)).toBeNull();
  });
});

describe("what the dialog says about images a reload left behind", () => {
  it("says it in one line, and how to put them back", () => {
    expect(imagesLostLine(1)).toBe("The screenshot was not kept through the page reload. Add it again to send it.");
    expect(imagesLostLine(3)).toBe("The 3 screenshots were not kept through the page reload. Add them again to send them.");
    for (const line of [imagesLostLine(1), imagesLostLine(2)]) {
      expect(line).not.toMatch(/!|\bsimply\b|\bjust\b/i);
    }
  });
});
