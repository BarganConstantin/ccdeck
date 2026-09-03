// What the big figure in ACTIVITY OVERVIEW counts.
//
// It counted every row in the browser's history since the deck started. On a
// measured profile that was 74 rows, of which 58 were the reader's own browsing
// — so the panel's largest number was 78% a different subject from the panel,
// and `23` read as "23 things to look at" when none of them were.
//
// It counts what a PROGRAM opened now. Ungated on purpose, so it is not the
// findings count beside it: a finding also has to clear the quiet gate. This is
// "what programs did"; the findings are "what they did while you were away".
import { describe, it, expect } from "vitest";
import { visitTotals, type WatchBrowser } from "../components/BrowserWatchModal";

const browser = (over: Partial<WatchBrowser>): WatchBrowser => ({
  key: "brave", name: "Brave", installed: true, profiles: 1,
  withExtension: [], running: true,
  relay: { state: "unknown", count: 0, why: "" },
  ...over,
});

describe("the figure the overview shows", () => {
  it("counts what a program opened, not every page in the history", () => {
    // The measured numbers, kept as the case: 74 rows, 16 of them by a program.
    const totals = visitTotals(
      [browser({})],
      [{ browser: "brave", visits: 74, programVisits: 16 } as never],
    );
    expect(totals[0].visits).toBe(16);
  });

  it("sums a browser's profiles", () => {
    // A browser is what the reader names; a profile is how the deck stores it.
    const totals = visitTotals(
      [browser({})],
      [
        { browser: "brave", visits: 40, programVisits: 3 } as never,
        { browser: "brave", visits: 34, programVisits: 5 } as never,
      ],
    );
    expect(totals[0].visits).toBe(8);
  });

  it("reads zero when a browser has been used but only by hand", () => {
    // The ordinary case, and the one the old figure hid: plenty of browsing,
    // nothing done by a program. The panel should say nothing happened, because
    // nothing did — in its own subject.
    const totals = visitTotals(
      [browser({})],
      [{ browser: "brave", visits: 500, programVisits: 0 } as never],
    );
    expect(totals[0].visits).toBe(0);
  });

  it("leaves a browser with no profile at zero rather than undefined", () => {
    expect(visitTotals([browser({ key: "chrome", name: "Google Chrome" })], [])[0].visits).toBe(0);
  });

  it("keeps the name and the run state beside the number", () => {
    // The row is read as one line — a figure, a browser, and whether it is
    // running — so all three come from the same call.
    const [t] = visitTotals(
      [browser({ running: false })],
      [{ browser: "brave", visits: 9, programVisits: 2 } as never],
    );
    expect([t.name, t.running, t.visits]).toEqual(["Brave", false, 2]);
  });
});

describe("the server counts it separately from the total", () => {
  it("carries programVisits across a cached poll, like everything else", async () => {
    // The bug this avoids has been made twice already in this file's
    // neighbourhood: a cached read means "as before", not "nothing", and a
    // counter that reset on every quiet poll would flicker to zero and back.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const server = readFileSync(
      fileURLToPath(new URL("../../server/browser-watch.mjs", import.meta.url)), "utf8");
    expect(server).toMatch(/byProgram \} =\s*_lastRead\.get\(key\)/);
    expect(server).toMatch(/_lastRead\.set\(key, \{ findings, oldest, human, byProgram \}\)/);
  });

  it("keeps `visits` too, because the feed's deltas are computed against it", async () => {
    // Two numbers answering two questions. Collapsing them would have made the
    // feed's `+3 entries` count only program pages, which is not what a row
    // added to the history means — and the invariant that the deltas sum to the
    // cumulative would have quietly stopped holding.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const server = readFileSync(
      fileURLToPath(new URL("../../server/browser-watch.mjs", import.meta.url)), "utf8");
    expect(server).toMatch(/visits: read\.rows\.length,/);
    expect(server).toMatch(/const n = read\.rows\.length;/);
    expect(server, "the delta is being computed against the program count")
      .not.toMatch(/const n = byProgram/);
  });
});
