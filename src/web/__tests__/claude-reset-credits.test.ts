// Claude's saved limit resets, as claude-reset-credits.mjs reads them out of the
// `cedar_ember` block (#1308).
//
// These are the rules the Usage panel's count stands on, and every one of them
// is a way to print a reset the account cannot spend: a paused grant, one that
// has not started, one that has ended, one whose numbers contradict each other,
// a block from a client the endpoint did not recognise. The fixtures are shaped
// like Claude Code's own schema for the block and carry no real identifiers —
// the parser never reads `id`, and the tests below prove it does not need one.
import { describe, it, expect } from "vitest";
import {
  readResetGrants, availableResetCredits, resetCreditsFrom,
  MAX_GRANT_RECORDS, MAX_AVAILABLE_RESETS, RESET_KINDS,
// @ts-expect-error — plain JS module, no types
} from "../../server/claude-reset-credits.mjs";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const DAY = 24 * 3600 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

/** One grant holding one reset, started yesterday, ending in a week. */
const grant = (over: Record<string, unknown> = {}) => ({
  id: "test-grant",
  label: "test",
  resets_total: 1,
  resets_left: 1,
  starts_at: iso(NOW - DAY),
  ends_at: iso(NOW + 7 * DAY),
  paused: false,
  usable_now: false,
  ...over,
});
const block = (grants: unknown, over: Record<string, unknown> = {}) =>
  ({ eligible: true, grants, ...over });
const read = (b: unknown) => resetCreditsFrom(b, NOW);
/** The answer for grants that do not say what they clear — every grant sent
 *  before Claude named them, and every fixture above the "which limit" block:
 *  one group, of kind "unknown". */
const unknown = (availableCount: number, nextExpiryAt: number | null) => [{ kind: "unknown", availableCount, nextExpiryAt }];

describe("counting what can be spent", () => {
  it("sums resets_left across the grants that are live", () => {
    expect(read(block([
      grant(),
      grant({ resets_total: 3, resets_left: 2, ends_at: iso(NOW + 3 * DAY) }),
    ]))).toEqual(unknown(3, NOW + 3 * DAY));
  });

  it("reports the earliest end among the counted grants, not the first listed", () => {
    const r = read(block([
      grant({ ends_at: iso(NOW + 9 * DAY) }),
      grant({ ends_at: iso(NOW + 2 * DAY) }),
      grant({ ends_at: iso(NOW + 5 * DAY) }),
    ]));
    expect(r).toEqual(unknown(3, NOW + 2 * DAY));
  });

  it("ignores the end of a grant it did not count", () => {
    // A paused grant ending tomorrow would otherwise put "expires tomorrow"
    // beside a count it is not part of.
    const r = read(block([
      grant({ ends_at: iso(NOW + 8 * DAY) }),
      grant({ paused: true, ends_at: iso(NOW + DAY) }),
    ]));
    expect(r).toEqual(unknown(1, NOW + 8 * DAY));
  });

  it("counts a grant with no end, and says there is no expiry when none has one", () => {
    expect(read(block([grant({ ends_at: null })])))
      .toEqual(unknown(1, null));
    expect(read(block([grant({ ends_at: undefined, starts_at: undefined })])))
      .toEqual(unknown(1, null));
  });

  it("counts a reset Claude will not redeem yet, because it is still owned", () => {
    // usable_now is false while the account is under its limit; the reset is
    // saved, not gone.
    expect(read(block([grant({ usable_now: false })]))).toMatchObject([{ availableCount: 1 }]);
  });

  it("does not need a grant's id to count it", () => {
    const { id: _dropped, ...anonymous } = grant();
    expect(read(block([anonymous]))).toMatchObject([{ availableCount: 1 }]);
  });
});

describe("filtering out what cannot be spent", () => {
  it("drops a paused grant", () => {
    expect(read(block([grant({ paused: true })]))).toEqual([]);
  });

  it("drops a grant that has not started", () => {
    expect(read(block([grant({ starts_at: iso(NOW + 1000) })]))).toEqual([]);
  });

  it("drops a grant that has ended, at the instant it ends", () => {
    expect(read(block([grant({ ends_at: iso(NOW) })]))).toEqual([]);
    expect(read(block([grant({ ends_at: iso(NOW - 1) })]))).toEqual([]);
    expect(read(block([grant({ ends_at: iso(NOW + 1) })]))).toMatchObject([{ availableCount: 1 }]);
  });

  it("drops a grant that is used up", () => {
    expect(read(block([grant({ resets_left: 0 })]))).toEqual([]);
  });

  it("stops counting a held grant once it ends, without a new fetch", () => {
    // The inventory is held between fetches, so expiry is decided at read time.
    const grants = readResetGrants(block([grant({ ends_at: iso(NOW + 60_000) })]));
    expect(availableResetCredits(grants, NOW)).toMatchObject([{ availableCount: 1 }]);
    expect(availableResetCredits(grants, NOW + 60_000)).toEqual([]);
  });
});

describe("a block that says nothing trustworthy", () => {
  it("is unknown when it is absent", () => {
    expect(read(undefined)).toBeNull();
    expect(read(null)).toBeNull();
  });

  it("is unknown when the account is not eligible, including for an unrecognised client", () => {
    expect(read({ eligible: false, ineligible_reason: "surface", grants: [grant()] })).toBeNull();
    expect(read({ eligible: false, ineligible_reason: "cli_version" })).toBeNull();
  });

  it("is unknown unless eligible is exactly true", () => {
    expect(read({ eligible: "true", grants: [grant()] })).toBeNull();
    expect(read({ grants: [grant()] })).toBeNull();
  });

  it("is unknown when it is not an object, or its grants are not a list", () => {
    expect(read("cedar")).toBeNull();
    expect(read([grant()])).toBeNull();
    expect(read(block({ 0: grant() }))).toBeNull();
    expect(read(block("none"))).toBeNull();
  });

  it("is zero, not unknown, when an eligible account holds no grants", () => {
    // Zero is no group at all, and still not null.
    expect(read(block([]))).toEqual([]);
    expect(read({ eligible: true })).toEqual([]);
  });

  it("is unknown when it lists implausibly many grants", () => {
    const many = Array.from({ length: MAX_GRANT_RECORDS + 1 }, () => grant({ resets_left: 0 }));
    expect(read(block(many))).toBeNull();
  });

  it("is unknown when it would add up to an implausible count", () => {
    expect(read(block([grant({ resets_total: 99, resets_left: MAX_AVAILABLE_RESETS + 1 })]))).toBeNull();
    expect(read(block([grant({ resets_total: MAX_AVAILABLE_RESETS, resets_left: MAX_AVAILABLE_RESETS })])))
      .toMatchObject([{ availableCount: MAX_AVAILABLE_RESETS }]);
  });
});

describe("a malformed grant", () => {
  // Each is dropped on its own, so the good grant beside it still counts —
  // and the malformed one never does.
  const beside = (bad: unknown) => read(block([grant(), bad]));

  it.each([
    ["a negative resets_left", grant({ resets_left: -1 })],
    ["a fractional resets_left", grant({ resets_left: 1.5 })],
    ["a resets_left sent as a string", grant({ resets_left: "1" })],
    ["no resets_left at all", grant({ resets_left: undefined })],
    ["more left than it ever held", grant({ resets_total: 1, resets_left: 2 })],
    ["a resets_total that is not a count", grant({ resets_total: -3 })],
    ["an unknown pause state", grant({ paused: undefined })],
    ["a pause state sent as a string", grant({ paused: "false" })],
    ["an end nobody can read", grant({ ends_at: "next tuesday" })],
    ["an end sent as a number", grant({ ends_at: NOW + DAY })],
    ["a start nobody can read", grant({ starts_at: "soon" })],
    ["not an object", "grant"],
    ["null", null],
    ["a list", [grant()]],
  ])("is not counted: %s", (_why, bad) => {
    expect(beside(bad)).toEqual(unknown(1, NOW + 7 * DAY));
  });
});

describe("what survives the parse", () => {
  it("keeps no identifier, label or event property of a grant", () => {
    // A grant id is a redemption handle. What the parser keeps is all that
    // quota.mjs can hold or publish, so it is where that stops. The one key
    // added since is the grant's kind, a word from a fixed list — never a
    // string the grant itself sent.
    const grants = readResetGrants(block([grant({
      id: "handle-that-must-not-leak", label: "Launch promo",
      gives_back_weekly: true, type: "full", clears: ["five_hour", "seven_day"],
    })], {
      next_grant_id: "handle-that-must-not-leak",
      event_props: { surface: "claude_code_cli" },
    }));
    expect(JSON.stringify(grants)).not.toMatch(/handle-that-must-not-leak|Launch promo|surface/);
    expect(Object.keys(grants[0]).sort()).toEqual(["endsAt", "kind", "paused", "resetsLeft", "startsAt"]);
    expect(RESET_KINDS).toContain(grants[0].kind);
    // And the published groups carry nothing else either.
    const groups = availableResetCredits(grants, NOW);
    expect(groups.map((g: object) => Object.keys(g).sort())).toEqual([["availableCount", "kind", "nextExpiryAt"]]);
    expect(JSON.stringify(groups)).not.toMatch(/handle-that-must-not-leak|Launch promo|surface|five_hour|seven_day/);
  });

  it("never copies a kind the grant sent: one it does not know is not read", () => {
    // `type` is the only field whose value could be passed through as it came,
    // so a word outside the three known ones must not reach the answer.
    const [g] = readResetGrants(block([grant({ type: "handle-that-must-not-leak" })]));
    expect(g.kind).toBe("unknown");
    expect(JSON.stringify(g)).not.toContain("handle-that-must-not-leak");
  });
});

describe("which limit a reset clears", () => {
  // Claude Code's rule (2.1.328): a grant that gives back weekly usage is a
  // Fable reset; otherwise its `type`; otherwise what its `clears` names.
  const kindOf = (over: Record<string, unknown>) => readResetGrants(block([grant(over)]))[0].kind;

  it("is a Fable reset when it gives back weekly usage, whatever else it says", () => {
    expect(kindOf({ gives_back_weekly: true })).toBe("fable");
    expect(kindOf({ gives_back_weekly: true, type: "full", clears: ["five_hour"] })).toBe("fable");
  });

  it("is the grant's own type when it has one Claude Code knows", () => {
    expect(kindOf({ type: "full" })).toBe("full");
    expect(kindOf({ type: "weekly" })).toBe("weekly");
    expect(kindOf({ type: "session" })).toBe("session");
    // The type wins over the list.
    expect(kindOf({ gives_back_weekly: false, type: "full", clears: ["five_hour"] })).toBe("full");
  });

  it("is worked out from what it clears when it has no type", () => {
    expect(kindOf({ clears: ["five_hour"] })).toBe("session");
    expect(kindOf({ clears: ["seven_day"] })).toBe("weekly");
    expect(kindOf({ clears: ["seven_day", "seven_day_opus", "seven_day_sonnet"] })).toBe("weekly");
    expect(kindOf({ clears: ["five_hour", "seven_day"] })).toBe("full");
    expect(kindOf({ gives_back_weekly: false, clears: ["seven_day_oauth_apps", "five_hour"] })).toBe("full");
  });

  it("is unknown when none of the three fields is there, as in every older payload", () => {
    expect(kindOf({})).toBe("unknown");
  });

  it.each([
    ["gives_back_weekly sent as a string", { gives_back_weekly: "true" }],
    ["gives_back_weekly false and nothing else", { gives_back_weekly: false }],
    ["a type nobody knows", { type: "turbo" }],
    ["a type in another case", { type: "Full" }],
    ["clears that is not a list", { clears: "five_hour" }],
    ["an empty clears", { clears: [] }],
    ["clears naming a limit nobody knows", { clears: ["five_hour", "seven_day_new_model"] }],
    ["clears holding a number", { clears: ["seven_day", 7] }],
  ])("ignores a malformed field: %s", (_why, over) => {
    expect(kindOf(over)).toBe("unknown");
    // A grant whose kind cannot be read is still a grant: it counts as before.
    expect(read(block([grant(over)]))).toEqual(unknown(1, NOW + 7 * DAY));
  });

  it("falls through a malformed field to the next one", () => {
    expect(kindOf({ gives_back_weekly: "yes", type: "weekly" })).toBe("weekly");
    expect(kindOf({ type: "turbo", clears: ["five_hour"] })).toBe("session");
  });
});

describe("one line per kind", () => {
  it("groups the resets by kind, Fable first, then full, weekly, 5-hour and unknown", () => {
    expect(RESET_KINDS).toEqual(["fable", "full", "weekly", "session", "unknown"]);
    const r = read(block([
      grant({ clears: ["five_hour"], ends_at: iso(NOW + 2 * DAY) }),
      grant(),
      grant({ type: "weekly", resets_total: 2, resets_left: 2, ends_at: iso(NOW + 4 * DAY) }),
      grant({ type: "full", ends_at: iso(NOW + 9 * DAY) }),
      grant({ gives_back_weekly: true, ends_at: iso(NOW + 5 * DAY) }),
      grant({ type: "full", ends_at: iso(NOW + 3 * DAY) }),
    ]));
    expect(r).toEqual([
      { kind: "fable", availableCount: 1, nextExpiryAt: NOW + 5 * DAY },
      { kind: "full", availableCount: 2, nextExpiryAt: NOW + 3 * DAY },
      { kind: "weekly", availableCount: 2, nextExpiryAt: NOW + 4 * DAY },
      { kind: "session", availableCount: 1, nextExpiryAt: NOW + 2 * DAY },
      { kind: "unknown", availableCount: 1, nextExpiryAt: NOW + 7 * DAY },
    ]);
  });

  it("leaves out a kind with nothing to spend, and the end of a grant it did not count", () => {
    const r = read(block([
      grant({ gives_back_weekly: true, paused: true, ends_at: iso(NOW + DAY) }),
      grant({ type: "full", ends_at: iso(NOW + 8 * DAY) }),
      grant({ type: "full", resets_left: 0, ends_at: iso(NOW + DAY) }),
    ]));
    expect(r).toEqual([{ kind: "full", availableCount: 1, nextExpiryAt: NOW + 8 * DAY }]);
  });

  it("is unknown when one kind would add up to an implausible count", () => {
    expect(read(block([grant({ type: "full", resets_total: 99, resets_left: MAX_AVAILABLE_RESETS + 1 })]))).toBeNull();
    expect(read(block([grant({ type: "full", resets_total: MAX_AVAILABLE_RESETS, resets_left: MAX_AVAILABLE_RESETS })])))
      .toEqual([{ kind: "full", availableCount: MAX_AVAILABLE_RESETS, nextExpiryAt: NOW + 7 * DAY }]);
  });

  it("is unknown when the kinds together would add up to an implausible count", () => {
    const half = Math.ceil((MAX_AVAILABLE_RESETS + 1) / 2);
    expect(read(block([
      grant({ type: "full", resets_total: half, resets_left: half }),
      grant({ gives_back_weekly: true, resets_total: half, resets_left: half }),
    ]))).toBeNull();
  });
});
