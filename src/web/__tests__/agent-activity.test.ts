// The Browser Watch classifier, pinned against the history it was derived from.
//
// `src/server/agent-activity.mjs` is the only module in this feature with no
// I/O — no sqlite, no filesystem, no clock — which makes it the only one whose
// correctness is provable rather than observable. So this file proves it, and
// it spends most of its length on the two boundaries and the two decisions that
// a reader six months from now would otherwise have to re-derive from a browser
// profile nobody still has:
//
//   * the quiet window is EITHER SIDE of the candidate, so a program visit
//     ninety seconds before the user came back is not a finding;
//   * `quietMs` and `gapMs` each name the first distance that counts as FAR —
//     exactly `quietMs` away is still quiet, exactly `gapMs` apart is a new
//     episode — and every off-by-one case below is written as a PAIR, one
//     millisecond on each side, because a single-sided assertion passes whether
//     the comparison is `<` or `<=`;
//   * exclusions drop candidates, never evidence: a human reading the deck's
//     own UI is still a human at the browser;
//   * the fourteen findings measured on 2026-08-24 between 17:05 and 17:44 are
//     ONE episode, which is the entire reason `toEpisodes` exists.
//
// The dates below are the measured burst's, built in UTC. The module never
// reads a clock or a zone — it does arithmetic on numbers the caller supplies —
// so a local-time constructor here would make the fixture depend on where the
// suite runs while proving nothing extra.
//
// Plain node, no DOM: every export under test is pure, so they are called.
import { describe, it, expect } from "vitest";
import {
  FROM_API,
  classify,
  defaultExclusions,
  isProgramNavigation,
  toEpisodes,
} from "../../server/agent-activity.mjs";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** Chrome's core transition types, the low byte of `transition`. LINK is 0 —
 *  which is why the qualifier bit has to be tested on its own: a value of
 *  exactly FROM_API is a complete, ordinary program navigation. */
const LINK = 0x00;
const TYPED = 0x01;
/** The qualifier one bit BELOW the one that matters. Chrome's own neighbour, so
 *  a mask written with the wrong constant still looks plausible in a diff. */
const HOME_PAGE = 0x04000000;
/** The top qualifier, above 2^31 — the value that makes a signed reading of the
 *  column, or a careless `>>`, produce a negative number. */
const SERVER_REDIRECT = 0x80000000;

type Visit = { url: string; timeMs: number; transition: number | string };

/** A visit a person made: any transition WITHOUT the FROM_API bit, which is the
 *  module's whole definition of "somebody was at the browser". */
const human = (url: string, timeMs: number, transition: number = LINK): Visit =>
  ({ url, timeMs, transition });

/** A visit a program made. Written as the measured shape — FROM_API over core
 *  type LINK, which is what all 769 of them were. */
const program = (url: string, timeMs: number, transition: number = FROM_API | LINK): Visit =>
  ({ url, timeMs, transition });

// The measured burst: 2026-08-24, one GitLab project, 17:05 through 17:44.
const BURST_START = Date.UTC(2026, 7, 24, 17, 5);
const BURST_END = Date.UTC(2026, 7, 24, 17, 44);
const BURST_STEP = 3 * MINUTE;
const BURST_COUNT = 14;
const GITLAB = "https://gitlab.example.com";
/** The pages the burst actually walked: settings, jobs, branches, over and
 *  over. Fourteen rows, 39 minutes, never quiet for as long as ten. */
const burst = (): Visit[] => {
  const pages = ["/deck/-/settings/ci_cd", "/deck/-/jobs", "/deck/-/branches"];
  return Array.from({ length: BURST_COUNT }, (_unused, i) =>
    program(`${GITLAB}${pages[i % pages.length]}?page=${i}`, BURST_START + i * BURST_STEP));
};

describe("isProgramNavigation reads Chrome's FROM_API bit", () => {
  it("is 0x08000000, the qualifier the whole feature rests on", () => {
    expect(FROM_API).toBe(0x08000000);
    expect(FROM_API).toBe(134217728);
  });

  it("accepts the same value as a Number and as a String", () => {
    // The reader CASTs the column to text; a caller holding a raw row has a
    // number. Both shapes are real and the answer may not depend on which.
    for (const value of [FROM_API, FROM_API | LINK, FROM_API | TYPED, FROM_API | HOME_PAGE]) {
      expect(isProgramNavigation(value)).toBe(true);
      expect(isProgramNavigation(String(value))).toBe(true);
    }
    for (const value of [0, LINK, TYPED, HOME_PAGE, HOME_PAGE | TYPED]) {
      expect(isProgramNavigation(value)).toBe(false);
      expect(isProgramNavigation(String(value))).toBe(false);
    }
  });

  it("does not fire on HOME_PAGE, the neighbouring qualifier", () => {
    // 0x04000000 is one bit below FROM_API and is set by a perfectly ordinary
    // click on the home button. A mask written with it — or a shift off by one
    // — would turn every home-page visit into an agent sighting.
    expect(isProgramNavigation(HOME_PAGE)).toBe(false);
    expect(isProgramNavigation(HOME_PAGE | LINK)).toBe(false);
    expect(isProgramNavigation("67108864")).toBe(false);
    // And the bit above it, for the same reason in the other direction.
    expect(isProgramNavigation(0x10000000)).toBe(false);
  });

  it("reads the measured shape: FROM_API over core type LINK", () => {
    // All 769 FROM_API visits in 46 days carried core type LINK, and the core
    // type is the low byte. The module tests the qualifier and nothing else —
    // a program navigation of another core type is still a program navigation
    // — so this pins that the low byte is not being required.
    const measured = FROM_API | LINK;
    expect(measured & 0xff).toBe(LINK);
    expect(isProgramNavigation(measured)).toBe(true);
    expect(isProgramNavigation(FROM_API | TYPED)).toBe(true);
  });

  it("survives a qualifier above 2^31", () => {
    // SERVER_REDIRECT is 0x80000000, the top bit of an unsigned 32-bit field.
    expect(isProgramNavigation(SERVER_REDIRECT + FROM_API)).toBe(true);
    expect(isProgramNavigation(String(SERVER_REDIRECT + FROM_API))).toBe(true);
    expect(isProgramNavigation(SERVER_REDIRECT)).toBe(false);
    expect(isProgramNavigation(SERVER_REDIRECT + HOME_PAGE)).toBe(false);
  });

  it("reads a signed spelling of the same bits", () => {
    // This case was written as `SERVER_REDIRECT | FROM_API` first, and failed:
    // every bitwise operator in JavaScript goes through ToInt32, so that
    // expression is -2013265920 rather than 2281701376. The field has no
    // negative values, so a negative one is a signed reading of it and the
    // bits are undone rather than refused — otherwise a reader that ever
    // returned signed integers would silently stop seeing every redirected
    // program navigation, which is the failure mode this whole feature exists
    // to avoid repeating.
    expect(SERVER_REDIRECT | FROM_API).toBeLessThan(0);
    expect(isProgramNavigation(SERVER_REDIRECT | FROM_API)).toBe(true);
    expect(isProgramNavigation(String(SERVER_REDIRECT | FROM_API))).toBe(true);
    expect(isProgramNavigation(SERVER_REDIRECT | HOME_PAGE)).toBe(false);
    // -1 is every qualifier at once, and answers true. That is the chosen
    // direction: a false positive is a card the user dismisses, a false
    // negative is a feature that says nothing ever happened.
    expect(isProgramNavigation(-1)).toBe(true);
    // Below -2^31 there is no 32-bit field to undo, so it is not a transition.
    expect(isProgramNavigation(-2147483649)).toBe(false);
    expect(isProgramNavigation("-2147483649")).toBe(false);
  });

  it("reads a long numeric string exactly, which is what the CAST is for", () => {
    // Not a value Chrome emits — the point is that the text arrives intact.
    // Above 2^79 a double's step is wider than bit 27, so `Number(text)` throws
    // away exactly the bit this module exists to read: the two values below
    // round to the SAME double, and a Number-based reading calls both of them
    // false. The CAST upstream exists to avoid that rounding; finishing the
    // journey with Number() would put it back one line later.
    const withBit = ((1n << 80n) | BigInt(FROM_API)).toString();
    const without = (1n << 80n).toString();
    expect(Number(withBit)).toBe(Number(without));
    expect(isProgramNavigation(withBit)).toBe(true);
    expect(isProgramNavigation(without)).toBe(false);
  });

  it("answers false to anything that is not a transition", () => {
    // A malformed row must not become a finding. Every one of these has been
    // seen in some sqlite binding or another: nulls, empty text, a float
    // rendering, and the string "undefined".
    for (const junk of [null, undefined, "", "  ", "undefined", "NaN", NaN, "0x8000000", "1e9", {}, []]) {
      expect(isProgramNavigation(junk as never)).toBe(false);
    }
    // Whitespace around a real value is still a real value.
    expect(isProgramNavigation(` ${FROM_API} `)).toBe(true);
  });
});

describe("defaultExclusions covers the deck's own tabs", () => {
  it("names the port on every loopback spelling", () => {
    // ccdeck opens http://127.0.0.1:<port> itself, but a returning user may
    // have typed localhost, and one history holds both rows.
    expect(defaultExclusions(["http://127.0.0.1:4317"]))
      .toEqual(["127.0.0.1:4317", "localhost:4317", "[::1]:4317"]);
  });

  it("keeps the port, so the rest of localhost still reports", () => {
    const rules = defaultExclusions(["http://127.0.0.1:4317"]);
    const visits = [
      program("http://127.0.0.1:4317/", 0),
      program("http://127.0.0.1:5173/", MINUTE),
    ];
    // The deck is excluded; the dev server on the next port over is not. An
    // exclusion of bare `127.0.0.1` would have silenced every local project the
    // user runs, which is a real answer thrown away to solve one port.
    expect(classify(visits, { exclude: rules }).map(f => f.host)).toEqual(["127.0.0.1:5173"]);
  });

  it("collapses the two ports the deck was measured on into six matchers", () => {
    // 41 visits to :4317 and 34 to :4399 were FROM_API over the measured 46
    // days, because the listen fallback range moves the deck's port.
    expect(defaultExclusions(["http://127.0.0.1:4317", "http://localhost:4399"])).toEqual([
      "127.0.0.1:4317", "localhost:4317", "[::1]:4317",
      "127.0.0.1:4399", "localhost:4399", "[::1]:4399",
    ]);
  });

  it("does not repeat a matcher when two origins name the same server", () => {
    expect(defaultExclusions(["http://127.0.0.1:4317", "http://localhost:4317"]))
      .toEqual(["127.0.0.1:4317", "localhost:4317", "[::1]:4317"]);
  });

  it("takes a bare host:port, a lone string, and ignores junk", () => {
    expect(defaultExclusions("127.0.0.1:4317"))
      .toEqual(["127.0.0.1:4317", "localhost:4317", "[::1]:4317"]);
    expect(defaultExclusions(["", "   ", null, undefined, 4317, {}] as never)).toEqual([]);
    expect(defaultExclusions(undefined as never)).toEqual([]);
  });

  it("removes the deck without touching the site next to it", () => {
    // The end-to-end shape of the measured problem: the deck opening its own
    // tab is the loudest FROM_API source on the machine, and it fires at the
    // exact moment the rule is most sensitive — nobody is browsing when a
    // background process opens a tab.
    const visits = [
      program("http://127.0.0.1:4317/", Date.UTC(2026, 7, 24, 9, 0)),
      program("http://localhost:4399/?tab=usage", Date.UTC(2026, 7, 24, 11, 0)),
      program(`${GITLAB}/deck/-/jobs`, Date.UTC(2026, 7, 24, 13, 0)),
    ];
    const exclude = defaultExclusions(["http://127.0.0.1:4317", "http://127.0.0.1:4399"]);
    expect(classify(visits, { exclude })).toEqual([
      { url: `${GITLAB}/deck/-/jobs`, timeMs: Date.UTC(2026, 7, 24, 13, 0), host: "gitlab.example.com" },
    ]);
    // Without them, the feature's loudest finding is the feature itself.
    expect(classify(visits)).toHaveLength(3);
  });
});

describe("classify's quiet window", () => {
  const t = Date.UTC(2026, 7, 24, 17, 20);
  const QUIET = 15 * MINUTE;

  it("keeps a program visit that had silence on both sides", () => {
    const visits = [
      human("https://news.example.com/", t - 60 * MINUTE),
      program(`${GITLAB}/deck/-/jobs`, t),
      human("https://news.example.com/again", t + 60 * MINUTE),
    ];
    expect(classify(visits, { quietMs: QUIET })).toEqual([
      { url: `${GITLAB}/deck/-/jobs`, timeMs: t, host: "gitlab.example.com" },
    ]);
  });

  it("drops one a person was sitting next to", () => {
    const visits = [
      human("https://news.example.com/", t - MINUTE),
      program(`${GITLAB}/deck/-/jobs`, t),
      human("https://news.example.com/again", t + MINUTE),
    ];
    expect(classify(visits, { quietMs: QUIET })).toEqual([]);
  });

  it("looks AFTER the candidate as well as before it", () => {
    // The half of the rule that is easy to leave out. A program that opened a
    // tab ninety seconds before the user came back and started clicking was not
    // working in an empty room, and only the later side can say so.
    const before = [
      human("https://news.example.com/", t - 90 * MINUTE),
      program(`${GITLAB}/deck/-/jobs`, t),
      human("https://news.example.com/again", t + 90 * SECOND),
    ];
    expect(classify(before, { quietMs: QUIET })).toEqual([]);

    // And the mirror, so the assertion above cannot be satisfied by a rule that
    // only ever looks forward.
    const after = [
      human("https://news.example.com/", t - 90 * SECOND),
      program(`${GITLAB}/deck/-/jobs`, t),
      human("https://news.example.com/again", t + 90 * MINUTE),
    ];
    expect(classify(after, { quietMs: QUIET })).toEqual([]);
  });

  it("puts the boundary at exactly quietMs — that far away is still quiet", () => {
    // Written as a pair on each side. A one-sided assertion here passes whether
    // the comparison is `<` or `<=`, which is precisely the mistake it is
    // supposed to catch.
    const at = (offset: number) => classify(
      [human("https://news.example.com/", t + offset), program(`${GITLAB}/x`, t)],
      { quietMs: QUIET },
    );
    expect(at(-QUIET)).toHaveLength(1);
    expect(at(-QUIET + 1)).toHaveLength(0);
    expect(at(QUIET)).toHaveLength(1);
    expect(at(QUIET - 1)).toHaveLength(0);
  });

  it("defaults to the fifteen minutes the sweep chose", () => {
    // 5 min gave 2.04 findings a day and 15 min gave 0.39; 30, 60 and 120 gave
    // nothing further. The default is a measurement, so it is asserted through
    // the behaviour rather than by reading the number back.
    const at = (offset: number) => classify(
      [human("https://news.example.com/", t + offset), program(`${GITLAB}/x`, t)],
    );
    expect(at(15 * MINUTE)).toHaveLength(1);
    expect(at(15 * MINUTE - 1)).toHaveLength(0);
  });

  it("finds everything when the browser was never touched by a person", () => {
    const visits = burst();
    expect(classify(visits, { quietMs: QUIET })).toHaveLength(BURST_COUNT);
  });

  it("does not let one program visit vouch for another", () => {
    // A burst is the thing being detected. If its own rows counted as company,
    // a long agent session would cancel itself and only the short ones would
    // survive — the exact inversion of what this is for.
    const visits = burst();
    expect(classify(visits, { quietMs: 60 * MINUTE })).toHaveLength(BURST_COUNT);
  });

  it("counts a human visit to an EXCLUDED origin as a person at the browser", () => {
    // Exclusions drop candidates, never evidence. Somebody reading the deck's
    // own UI is somebody sitting there, and removing those rows before the
    // quiet gate would manufacture silence around the exact moments the user
    // was watching this very feature.
    const exclude = defaultExclusions(["http://127.0.0.1:4317"]);
    const visits = [
      human("http://127.0.0.1:4317/", t - MINUTE),
      program(`${GITLAB}/deck/-/jobs`, t),
    ];
    expect(classify(visits, { quietMs: QUIET, exclude })).toEqual([]);
    // The same layout with the human an hour earlier does report, so the empty
    // answer above is the quiet gate and not the exclusion reaching too far.
    const quiet = [
      human("http://127.0.0.1:4317/", t - 60 * MINUTE),
      program(`${GITLAB}/deck/-/jobs`, t),
    ];
    expect(classify(quiet, { quietMs: QUIET, exclude })).toHaveLength(1);
  });

  it("counts a human visit whose URL cannot be parsed", () => {
    // `about:blank`, a new-tab page, a search that never resolved. Hands on the
    // keyboard either way, and common enough that discarding them would widen
    // every quiet window that touches one.
    const visits = [
      human("about:blank", t - MINUTE),
      program(`${GITLAB}/deck/-/jobs`, t),
    ];
    expect(classify(visits, { quietMs: QUIET })).toEqual([]);
  });

  it("drops rows it cannot place or name", () => {
    const visits = [
      { url: `${GITLAB}/a`, timeMs: null, transition: FROM_API },
      { url: `${GITLAB}/b`, timeMs: undefined, transition: FROM_API },
      { url: "about:blank", timeMs: t, transition: FROM_API },
      { url: "", timeMs: t, transition: FROM_API },
      { url: `${GITLAB}/keeper`, timeMs: t, transition: FROM_API },
    ];
    expect(classify(visits as never, { quietMs: QUIET })).toEqual([
      { url: `${GITLAB}/keeper`, timeMs: t, host: "gitlab.example.com" },
    ]);
    // A timestamp-less row must not be filed at the Unix epoch either: a
    // phantom visit in 1970 is not near anything, so nothing would ever fail
    // and the list would just quietly stop being the list of visits.
    const epochWitness = classify(
      [{ url: `${GITLAB}/a`, timeMs: null, transition: LINK }, program(`${GITLAB}/b`, 0)] as never,
      { quietMs: QUIET },
    );
    expect(epochWitness).toHaveLength(1);
  });

  it("reads a transition that arrived as text, all the way through", () => {
    const visits = [
      { url: "https://news.example.com/", timeMs: t - 60 * MINUTE, transition: String(LINK) },
      { url: `${GITLAB}/deck/-/jobs`, timeMs: t, transition: String(FROM_API | LINK) },
    ];
    expect(classify(visits, { quietMs: QUIET })).toEqual([
      { url: `${GITLAB}/deck/-/jobs`, timeMs: t, host: "gitlab.example.com" },
    ]);
  });

  it("answers with exactly url, timeMs and host — the port included", () => {
    const found = classify([program("http://127.0.0.1:5173/deck?x=1#y", t)], { quietMs: QUIET });
    expect(found).toEqual([{ url: "http://127.0.0.1:5173/deck?x=1#y", timeMs: t, host: "127.0.0.1:5173" }]);
    expect(Object.keys(found[0]).sort()).toEqual(["host", "timeMs", "url"]);
    // A default port is not spelled out, because `URL` does not spell it out on
    // either side of an exclusion comparison.
    expect(classify([program("https://gitlab.example.com:443/x", t)], { quietMs: QUIET })[0].host)
      .toBe("gitlab.example.com");
  });

  it("is a function of the input's content, not its order", () => {
    const visits = [
      human("https://news.example.com/", t - 60 * MINUTE),
      ...burst(),
      human("https://news.example.com/again", t + 120 * MINUTE),
    ];
    const straight = classify(visits, { quietMs: 15 * MINUTE });
    const shuffled = classify([...visits].reverse(), { quietMs: 15 * MINUTE });
    expect(shuffled).toEqual(straight);
    // Oldest first, which is the order `toEpisodes` then reads them in.
    expect(straight.map(f => f.timeMs)).toEqual([...straight.map(f => f.timeMs)].sort((a, b) => a - b));
  });

  it("takes an empty history without complaint", () => {
    expect(classify([])).toEqual([]);
    expect(classify(undefined as never)).toEqual([]);
    expect(classify([human("https://news.example.com/", t)])).toEqual([]);
  });
});

describe("classify's exclusion matchers", () => {
  const t = Date.UTC(2026, 7, 24, 3, 0);
  const hosts = (exclude: string[]) => classify([
    program("https://example.com/a", t),
    program("https://docs.example.com/b", t + MINUTE),
    program("https://example.com:8443/c", t + 2 * MINUTE),
    program("https://notexample.com/d", t + 3 * MINUTE),
  ], { exclude }).map(f => f.host);

  it("matches a bare host on every port", () => {
    expect(hosts(["example.com"])).toEqual(["docs.example.com", "notexample.com"]);
  });

  it("matches a host:port on that port only", () => {
    expect(hosts(["example.com:8443"]))
      .toEqual(["example.com", "docs.example.com", "notexample.com"]);
  });

  it("matches a wildcard on the apex and everything under it", () => {
    // And not on `notexample.com`, which ENDS WITH the base string but is a
    // different registrable domain — the suffix test has to include the dot.
    expect(hosts(["*.example.com"])).toEqual(["notexample.com"]);
  });

  it("ignores matchers it cannot read, rather than dropping everything", () => {
    // A bad line in a user's config must cost that line and nothing else. `*.`
    // alone has nothing under it and would otherwise match every host on earth.
    expect(hosts(["", "   ", "*.", "http://", "://x"])).toEqual([
      "example.com", "docs.example.com", "example.com:8443", "notexample.com",
    ]);
  });

  it("compares hosts the way URL normalises them", () => {
    expect(classify([program("https://EXAMPLE.com/a", t)], { exclude: ["example.com"] })).toEqual([]);
    expect(classify([program("https://example.com/a", t)], { exclude: ["EXAMPLE.COM"] })).toEqual([]);
  });
});

describe("toEpisodes collapses a burst into a card", () => {
  it("turns the measured fourteen into exactly one episode", () => {
    // 2026-08-24, 17:05 to 17:44, one GitLab project, fourteen findings that
    // survived a 60-minute gate. Fourteen rows is a worse description of that
    // afternoon than one card is, and this is the assertion that says so.
    const episodes = toEpisodes(classify(burst(), { quietMs: 60 * MINUTE }));
    expect(episodes).toHaveLength(1);
    expect(episodes[0].host).toBe("gitlab.example.com");
    expect(episodes[0].count).toBe(BURST_COUNT);
    expect(episodes[0].startMs).toBe(BURST_START);
    expect(episodes[0].endMs).toBe(BURST_END);
    expect(episodes[0].endMs - episodes[0].startMs).toBe(39 * MINUTE);
    expect(episodes[0].urls).toHaveLength(BURST_COUNT);
    expect(episodes[0].urls.map(u => u.timeMs)).toEqual(
      Array.from({ length: BURST_COUNT }, (_u, i) => BURST_START + i * BURST_STEP));
    // `browser` belongs in this list and was missing from it, which is how the
    // tag stayed dropped: `toEpisodes` built a `browserOf` map, set the field on
    // each group, and then rebuilt every episode without it — and this
    // assertion agreed, so nothing complained for as long as the bug existed.
    // A shape test that pins the wrong shape defends it.
    expect(Object.keys(episodes[0]).sort()).toEqual(["browser", "count", "endMs", "host", "startMs", "urls"]);
    expect(Object.keys(episodes[0].urls[0]).sort()).toEqual(["timeMs", "url"]);
  });

  it("measures the gap between neighbours, not from the start", () => {
    // The burst is 39 minutes long and the default gap is 15. An episode is
    // unbounded in length as long as no single silence inside it reaches
    // `gapMs` — which is what a working agent looks like, and a rule that
    // capped an episode at `gapMs` would shred this one into three.
    const episodes = toEpisodes(classify(burst(), { quietMs: 60 * MINUTE }));
    expect(episodes[0].endMs - episodes[0].startMs).toBeGreaterThan(10 * MINUTE);
    expect(episodes).toHaveLength(1);
  });

  it("puts the boundary at exactly gapMs — that far apart is a new episode", () => {
    const GAP = 10 * MINUTE;
    const twoAt = (apart: number) => toEpisodes([
      { url: `${GITLAB}/a`, timeMs: BURST_START, host: "gitlab.example.com" },
      { url: `${GITLAB}/b`, timeMs: BURST_START + apart, host: "gitlab.example.com" },
    ], { gapMs: GAP });
    expect(twoAt(GAP - 1)).toHaveLength(1);
    expect(twoAt(GAP)).toHaveLength(2);
    // And the same pair on the default, so the fifteen minutes is pinned too.
    // Fifteen rather than ten because the real GitLab burst goes quiet for
    // twelve minutes mid-run; ten shreds it into three cards. See the note on
    // toEpisodes for the sweep that settles it.
    const onDefault = (apart: number) => toEpisodes([
      { url: `${GITLAB}/a`, timeMs: BURST_START, host: "gitlab.example.com" },
      { url: `${GITLAB}/b`, timeMs: BURST_START + apart, host: "gitlab.example.com" },
    ]);
    expect(onDefault(15 * MINUTE - 1)).toHaveLength(1);
    expect(onDefault(15 * MINUTE)).toHaveLength(2);
  });

  it("splits one host's day into the episodes it actually had", () => {
    const findings = [
      { url: `${GITLAB}/a`, timeMs: BURST_START, host: "gitlab.example.com" },
      { url: `${GITLAB}/b`, timeMs: BURST_START + 5 * MINUTE, host: "gitlab.example.com" },
      { url: `${GITLAB}/c`, timeMs: BURST_START + 5 * MINUTE + 3 * 60 * MINUTE, host: "gitlab.example.com" },
    ];
    const episodes = toEpisodes(findings);
    expect(episodes.map(e => e.count)).toEqual([1, 2]);
    // Newest first: the lone later visit leads.
    expect(episodes[0].startMs).toBe(BURST_START + 5 * MINUTE + 3 * 60 * MINUTE);
  });

  it("keeps two hosts in the same window apart", () => {
    // Grouping is by host, so two programs working at once are two cards. A
    // rule that grouped purely on time would merge them and name the card after
    // whichever host happened to sort first.
    const findings = [
      { url: `${GITLAB}/a`, timeMs: BURST_START, host: "gitlab.example.com" },
      { url: "https://ci.example.com/1", timeMs: BURST_START + MINUTE, host: "ci.example.com" },
      { url: `${GITLAB}/b`, timeMs: BURST_START + 2 * MINUTE, host: "gitlab.example.com" },
      { url: "https://ci.example.com/2", timeMs: BURST_START + 3 * MINUTE, host: "ci.example.com" },
    ];
    const episodes = toEpisodes(findings);
    expect(episodes).toHaveLength(2);
    expect(episodes.map(e => e.host)).toEqual(["ci.example.com", "gitlab.example.com"]);
    expect(episodes.map(e => e.count)).toEqual([2, 2]);
    expect(episodes[0].startMs).toBe(BURST_START + MINUTE);
    expect(episodes[1].startMs).toBe(BURST_START);
  });

  it("keeps two ports of the same machine apart", () => {
    // The deck's own 4317 and 4399 were separate servers, and on a machine
    // where both ran they were separate sessions. `host` carries the port for
    // that reason.
    const findings = [
      { url: "http://127.0.0.1:4317/", timeMs: BURST_START, host: "127.0.0.1:4317" },
      { url: "http://127.0.0.1:4399/", timeMs: BURST_START + MINUTE, host: "127.0.0.1:4399" },
    ];
    expect(toEpisodes(findings).map(e => e.host)).toEqual(["127.0.0.1:4399", "127.0.0.1:4317"]);
  });

  it("orders newest first and takes findings in any order", () => {
    const findings = [
      { url: `${GITLAB}/old`, timeMs: BURST_START, host: "gitlab.example.com" },
      { url: "https://ci.example.com/new", timeMs: BURST_START + 5 * 60 * MINUTE, host: "ci.example.com" },
    ];
    expect(toEpisodes(findings).map(e => e.host)).toEqual(["ci.example.com", "gitlab.example.com"]);
    expect(toEpisodes([...findings].reverse())).toEqual(toEpisodes(findings));
  });

  it("does not reorder the array it was handed", () => {
    // Callers pass the output of `classify` and then keep using it. A function
    // that sorted its argument in place would be a trap the second caller finds.
    const findings = [
      { url: `${GITLAB}/b`, timeMs: BURST_START + MINUTE, host: "gitlab.example.com" },
      { url: `${GITLAB}/a`, timeMs: BURST_START, host: "gitlab.example.com" },
    ];
    const snapshot = findings.map(f => f.url);
    toEpisodes(findings);
    expect(findings.map(f => f.url)).toEqual(snapshot);
  });

  it("takes nothing and gives nothing", () => {
    expect(toEpisodes([])).toEqual([]);
    expect(toEpisodes(undefined as never)).toEqual([]);
    expect(toEpisodes([{ url: `${GITLAB}/a`, timeMs: null, host: "gitlab.example.com" }] as never)).toEqual([]);
    expect(toEpisodes([{ url: `${GITLAB}/a`, timeMs: BURST_START, host: "" }] as never)).toEqual([]);
  });

  it("counts what it lists", () => {
    const episodes = toEpisodes(classify(burst(), { quietMs: 60 * MINUTE }));
    for (const episode of episodes) expect(episode.count).toBe(episode.urls.length);
  });
});

describe("the whole rule, over a day that had one agent session in it", () => {
  it("reports the burst as one card and says nothing about the rest", () => {
    // A day shaped like the measured one: a person browsing in the morning and
    // the evening, the deck opening its own tab twice, and one program working
    // through a GitLab project for forty minutes in between.
    const morning = Date.UTC(2026, 7, 24, 9, 0);
    const evening = Date.UTC(2026, 7, 24, 19, 0);
    const visits: Visit[] = [
      ...Array.from({ length: 40 }, (_u, i) => human(`https://news.example.com/${i}`, morning + i * MINUTE)),
      program("http://127.0.0.1:4317/", Date.UTC(2026, 7, 24, 12, 30)),
      program("http://127.0.0.1:4399/", Date.UTC(2026, 7, 24, 12, 31)),
      ...burst(),
      ...Array.from({ length: 40 }, (_u, i) => human(`https://news.example.com/e${i}`, evening + i * MINUTE)),
    ];
    const exclude = defaultExclusions(["http://127.0.0.1:4317", "http://127.0.0.1:4399"]);
    const findings = classify(visits, { exclude });
    expect(findings).toHaveLength(BURST_COUNT);

    const episodes = toEpisodes(findings);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      host: "gitlab.example.com",
      startMs: BURST_START,
      endMs: BURST_END,
      count: BURST_COUNT,
    });
  });
});

describe("classify at the size of a real profile", () => {
  /** A deterministic generator, so a failure here is reproducible rather than a
   *  story about one run. mulberry32 — thirty-two bits of state, uniform enough
   *  for placing timestamps and short enough to read. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** The rule stated the slow, obvious way: for every candidate, look at every
   *  human visit. This is the reference the fast one has to agree with — the
   *  binary search is the only part of the module that could be subtly wrong
   *  while every hand-written case above still passes. */
  function naive(visits: Visit[], quietMs: number) {
    const humans = visits.filter(v => !isProgramNavigation(v.transition)).map(v => v.timeMs);
    return visits
      .filter(v => isProgramNavigation(v.transition))
      .filter(v => humans.every(h => Math.abs(h - v.timeMs) >= quietMs))
      .map(v => ({ url: v.url, timeMs: v.timeMs }))
      .sort((a, b) => a.timeMs - b.timeMs || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  }

  it("agrees with the slow reading of the same rule, on random histories", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const next = rng(seed);
      const visits: Visit[] = Array.from({ length: 300 }, (_u, i) => {
        // Deliberately coarse timestamps: rounding to whole minutes makes exact
        // ties and exact quietMs distances common, which is where a bisection
        // that lands on the wrong side of an equal value gives itself away.
        const timeMs = BURST_START + Math.floor(next() * 240) * MINUTE;
        return next() < 0.1
          ? program(`${GITLAB}/p${i}`, timeMs)
          : human(`https://news.example.com/h${i}`, timeMs);
      });
      const quietMs = [1, 5, 15, 60][seed % 4] * MINUTE;
      const fast = classify(visits, { quietMs }).map(f => ({ url: f.url, timeMs: f.timeMs }));
      expect(fast).toEqual(naive(visits, quietMs));
    }
  });

  it("does not search the history once per candidate", () => {
    // 120,000 visits, about five times the 26,395 measured here — one browser
    // profile that has not been pruned. The nearest-human search is the only
    // thing in this module that can go quadratic, and the shape below is the
    // one where it does: a person browsing for forty days and then a long
    // stretch nobody touched. Every candidate in that stretch has to look at
    // every human visit before it can conclude there is nobody near, where a
    // candidate with a person beside it stops at the first one. So a history in
    // which almost nothing is a finding hides the cost completely — and a
    // history in which a lot is a finding is exactly when this feature has
    // something to say.
    //
    // The candidate share here is far above the measured 2.9%, deliberately:
    // 20,000 of them against 100,000 timestamps. The first version of this case
    // used 4,000 and a flat 1.5-second ceiling, and a linear scan passed it.
    //
    // The budget is a RATIO rather than a number of milliseconds, because a
    // number of milliseconds is a claim about the machine and this case has a
    // claim about the algorithm to make. The unit is 200 full passes over the
    // human timestamps — 20 million comparisons, the same work in the same
    // shape. A scanning `classify` needs 20,000 passes, a hundred units;
    // bisecting needs a few thousand comparisons plus one sort, and measures
    // between 2 and 3. Fifteen leaves the real implementation five times its
    // own worst reading and still fails a scan by a factor of three, on a busy
    // machine as much as on an idle one — measured here at 2.2-2.9 against
    // 47-85 with the search replaced by a scan.
    const DAY = 24 * 60 * MINUTE;
    const next = rng(7);
    const humanTimes = Array.from({ length: 100_000 }, () =>
      BURST_START - 46 * DAY + Math.floor(next() * 40 * DAY));
    const visits: Visit[] = [
      ...humanTimes.map((timeMs, i) => human(`https://news.example.com/h${i}`, timeMs)),
      ...Array.from({ length: 20_000 }, (_u, i) =>
        program(`${GITLAB}/p${i}`, BURST_START - 4 * DAY + Math.floor(next() * 3 * DAY))),
    ];
    const sorted = [...humanTimes].sort((a, b) => a - b);

    /** One unit of the same comparison, over the same array. */
    const unit = () => {
      let seen = 0;
      for (let pass = 0; pass < 200; pass++) {
        for (let i = 0; i < sorted.length; i++) if (sorted[i] < BURST_START) seen++;
      }
      return seen;
    };
    unit(); // once to let the loop reach its steady state before it is timed.

    /** The best ratio of three, because a ratio is not as steady as it looks.
     *  One GC pause landing in the measured half and not in the calibrating one
     *  inflates a single reading by several times, and this case failed exactly
     *  that way once in four full-suite runs on the machine it was written on —
     *  which on a shared CI runner is a release blocked by nothing. Three
     *  readings and the best of them keeps the claim: a scanning classify is
     *  over the ceiling on every one of the three, never near it. */
    let best = Infinity;
    let findings: ReturnType<typeof classify> = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const calibrationStart = performance.now();
      unit();
      const calibration = performance.now() - calibrationStart;

      const started = performance.now();
      findings = classify(visits, { quietMs: 15 * MINUTE });
      best = Math.min(best, (performance.now() - started) / calibration);
    }

    // Every program visit sits in the stretch with no human visits in it, so
    // the answer is known exactly and the case is not only about the clock.
    expect(findings).toHaveLength(20_000);
    // 25 rather than the 15 first written. The real implementation measures
    // 2.2-2.9 and a scan 47-85, so the ceiling has an order of magnitude of gap
    // to sit in; 15 spent that on the algorithm's side and left a quarter of it
    // for the machine, which turned out to be the wrong half to be generous to.
    expect(best).toBeLessThan(25);
  });
});

describe("which browser an episode came from", () => {
  const FROM_API_BIT = 0x08000000;
  const human = (t: number) => ({ url: "https://human.invalid/a", timeMs: t, transition: 0 });
  const program = (t: number, url = "https://example.invalid/x") =>
    ({ url, timeMs: t, transition: FROM_API_BIT });

  it("survives the grouping, which is where it used to be dropped", () => {
    // `toEpisodes` builds a `browserOf` map, sets `browser` on each open group,
    // and then rebuilt every episode field by field WITHOUT it — so the map was
    // careful, commented, dead code and every episode reached the panel with
    // `browser: null`.
    //
    // Neither consequence looked like an error. A reaction had nothing to tell
    // which application to close, and the radar's ring fell through
    // `findIndex(...) === -1` into `Math.max(0, -1)` and drew itself on
    // whichever browser happened to be first in the list.
    const now = 1_000_000_000;
    const tagged = classify(
      [human(now - 600_000), program(now - 60_000)],
      { quietMs: 60_000 },
    ).map(f => ({ ...f, browser: "brave" }));

    const [episode] = toEpisodes(tagged);
    expect(episode.browser, "the browser tag was dropped in grouping again").toBe("brave");
  });

  it("keeps each host with the browser its finding came from", () => {
    // Two browsers, two hosts, one sweep. The tag rides on the HOST because a
    // url row's shape is pinned elsewhere, so this is the case that proves the
    // map is keyed the way the rest of the function assumes.
    const now = 1_000_000_000;
    const findings = [
      ...classify([human(now - 600_000), program(now - 60_000, "https://one.invalid/a")], { quietMs: 60_000 })
        .map(f => ({ ...f, browser: "brave" })),
      ...classify([human(now - 600_000), program(now - 50_000, "https://two.invalid/b")], { quietMs: 60_000 })
        .map(f => ({ ...f, browser: "chrome" })),
    ];
    const byHost = Object.fromEntries(toEpisodes(findings).map(e => [e.host, e.browser]));
    expect(byHost).toEqual({ "one.invalid": "brave", "two.invalid": "chrome" });
  });

  it("says null rather than guessing when no finding carried a tag", () => {
    // An untagged finding is a caller that forgot, and inventing a browser for
    // it would send a reaction at whichever application sorted first.
    const now = 1_000_000_000;
    const untagged = classify([human(now - 600_000), program(now - 60_000)], { quietMs: 60_000 });
    expect(toEpisodes(untagged)[0].browser).toBeNull();
  });
});
