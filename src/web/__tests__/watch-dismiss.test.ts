// Marking a finding as reviewed, and why that is not a delete.
//
// The panel rebuilds episodes from the browser's OWN history on every poll. So
// removing an archived row would be undone within ten seconds by the next read
// of the same visits — a delete that resurrects is worse than having none. What
// is stored instead is that the reader has seen this one, and that is filtered
// out of the live read and the archive alike.
//
// The separator is never spelled here. `episodeKey` owns it, the store keys on
// it, and a test that wrote its own copy would be a second spelling of one fact
// — quite apart from it being a NUL, which this repo bans from source for the
// good reason that it is invisible in every diff it appears in.
import { describe, it, expect } from "vitest";
import { episodeKey, readStore, undismissed, writeStore } from "../../server/browser-watch-store.mjs";

describe("dismissing an episode you have reviewed", () => {
  it("filters the live read, not only the archive", () => {
    const live = [{ host: "example.org", startMs: 1000 }, { host: "other.invalid", startMs: 2000 }];
    const left = undismissed(live, [episodeKey("example.org", 1000)]);
    expect(left.map((e: { host: string }) => e.host)).toEqual(["other.invalid"]);
  });

  it("keys on the START, so a run that grows stays dismissed", () => {
    // A run still going gains pages: its end and its count move, its start does
    // not. A key that travelled with the end would let a dismissed episode come
    // back the moment its program opened one more tab.
    const grown = [{ host: "example.org", startMs: 1000, endMs: 9999, count: 14 }];
    expect(undismissed(grown, [episodeKey("example.org", 1000)])).toEqual([]);
  });

  it("lets a genuinely new run through", () => {
    // Dismissal means "I reviewed that run", not "never tell me about this host
    // again". A new episode has a new start, so it is a different key, so it
    // appears — which is the difference between a reviewed list and a blindfold.
    const next = [{ host: "example.org", startMs: 5000 }];
    expect(undismissed(next, [episodeKey("example.org", 1000)])).toHaveLength(1);
  });

  it("costs nothing when nothing has been dismissed", () => {
    const live = [{ host: "example.org", startMs: 1000 }];
    expect(undismissed(live, [])).toBe(live);
  });

  it("survives the store round-trip", async () => {
    // It has to outlive the process: a dismissal the next restart forgot would
    // bring every reviewed episode back at once, which is the failure that
    // teaches somebody to stop pressing the button.
    const key = episodeKey("example.org", 1000);
    let written = "";
    const deps = {
      mkdir: async () => {},
      writeFile: async (_p: string, b: string) => { written = b; },
      rename: async () => {},
      readFile: async () => written,
    };
    await writeStore(
      { settings: { enabled: true }, episodes: [], dismissed: [key] },
      "/nowhere", deps as never,
    );
    expect(JSON.parse(written).dismissed).toEqual([key]);
    expect((await readStore("/nowhere", deps as never)).dismissed).toEqual([key]);
  });

  it("refuses a stored value that is not a key", async () => {
    // This file is a thing a person can open and edit, and a junk entry must
    // cost nothing rather than filter something at random.
    const body = JSON.stringify({
      v: 2, settings: {}, episodes: [],
      dismissed: ["no-separator-here", 7, null, episodeKey("a.invalid", 1)],
    });
    const back = await readStore("/nowhere", { readFile: async () => body } as never);
    expect(back.dismissed).toEqual([episodeKey("a.invalid", 1)]);
  });

  it("drops the set when the store version moves, along with the episodes", async () => {
    // The dismissals name episodes by a key those episodes no longer have.
    // Keeping them would filter rows at random for the rest of the file's life.
    const body = JSON.stringify({ v: 1, settings: {}, episodes: [{ host: "a", startMs: 1 }], dismissed: ["x"] });
    const back = await readStore("/nowhere", { readFile: async () => body } as never);
    expect(back.migrated).toBe(true);
    expect(back.episodes).toEqual([]);
    expect(back.dismissed).toEqual([]);
  });
});
