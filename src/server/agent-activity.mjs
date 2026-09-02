// Which browser visits a program drove while nobody was at the browser.
//
// Pure classification. No sqlite handle, no filesystem, no clock, no network:
// visit rows in, findings and episodes out. That is deliberate and it is the
// reason this file is the one carrying the judgement calls — every threshold
// below can be proved from a list of literals, where the same rule buried in
// the reader could only be argued about.
//
// MEASURED, on 46 days of this machine's real history — 26,395 visits:
//
//   * Chrome sets PAGE_TRANSITION_FROM_API (0x08000000) on 769 of them, 2.9%,
//     and every single one of those also carried core transition type LINK
//     (the low byte, `transition & 0xFF`). The bit is the signal, and it is not
//     smeared across transition types the way a heuristic would be.
//   * The `visit_source` table looks like the obvious place to ask instead. It
//     is EMPTY. Chrome fills it only for visits that arrived by sync or import,
//     so on a normal profile it answers nothing — and it answers nothing
//     SILENTLY, which reads exactly like "no program has ever touched this
//     browser". Do not reach for it.
//   * The quiet gate, swept over the same history:
//
//       quiet     findings/46d   per day   after excluding the deck's own tabs
//        5 min          94        2.04                   73
//       15 min          18        0.39                   18
//       30 min          14        0.30                   14
//       60 min          14        0.30                   14
//      120 min          13        0.28                   13
//
//     Fifteen minutes is where the noise drops from two a day to under one in
//     two days, and nothing past it is bought at any price. Hence the default.
//   * The 14 that survive a 60-minute gate are not fourteen events. They are
//     ONE burst, on 2026-08-24 between 17:05 and 17:44, every one of them on
//     the same GitLab project — settings, jobs, branches. Fourteen rows
//     describe that worse than one card does. That is what toEpisodes is for.
//   * Without exclusions the deck reports ITSELF: 41 visits to 127.0.0.1:4317
//     and 34 to 127.0.0.1:4399 carry FROM_API, because ccdeck opens its own tab
//     through `open` on every start (bin/deck.js) and the listen fallback range
//     means it is not always the same port. defaultExclusions() is that, and
//     only that.
//
// WHAT "NOBODY WAS AT THE BROWSER" MEANS HERE. It is derived from the visit
// list itself: a human visit is any visit WITHOUT the bit. There is no OS idle
// probe anywhere in this feature and there is not going to be one — under
// Wayland the real idle time is not readable at all without a portal the user
// has to grant, and on Windows it is a native call per poll. A gap in the
// browser's own history costs nothing, is the same three lines on every
// platform this ships to, and is closer to the question actually being asked:
// not "was the screen locked" but "was anyone driving this browser".
//
// The window is either side of the candidate, not just before it. A program
// that opened a tab ninety seconds before the user came back and started
// clicking was not working in an empty room, and only the AFTER half of the
// window can tell you that.
//
// ONE BOUNDARY RULE, spelled once for both thresholds: each names the first
// distance that counts as FAR. A human strictly closer than `quietMs` cancels a
// candidate and a human exactly `quietMs` away does not; two visits strictly
// closer than `gapMs` stay in one episode and two exactly `gapMs` apart start a
// second. Written down because "within 15 minutes" is ambiguous in English, and
// a test that leaves the boundary unpinned passes whichever way the code drifts.
//
// THE VOCABULARY IS DELIBERATE. Nothing here is an "intrusion". The single
// episode this rule found in 46 days was almost certainly the author's own
// Claude Code session driving a browser he had asked it to drive. This module
// reports program navigation; the person reading the card decides what it was.

/** Chrome's PAGE_TRANSITION_FROM_API qualifier — bit 27 of `visits.transition`.
 *  Set when the navigation was started through an API rather than by a person
 *  in the UI, which covers `open`, the debugger protocol, and an extension. */
export const FROM_API = 0x08000000;

/** The same bit for the arbitrary-precision path below. */
const FROM_API_BIG = BigInt(FROM_API);

/** Longest decimal string that is certainly exact as a double: 999999999999999
 *  < 2^53. Anything longer goes through BigInt rather than through a rounding
 *  that would be invisible here. */
const EXACT_DIGITS = 15;

/** The width of the field, for undoing a signed reading of it. Pre-widened to
 *  BigInt as well, so the long-string path does not allocate two of them per
 *  row it looks at. */
const UINT32 = 4294967296;
const INT32_MIN = -2147483648;
const UINT32_BIG = BigInt(UINT32);
const INT32_MIN_BIG = BigInt(INT32_MIN);

/** Loopback spelled every way a browser records it. The deck opens
 *  `http://127.0.0.1:<port>` itself, but a user who bookmarked the deck may
 *  have typed `localhost` — same server, different history rows, and an
 *  exclusion list that only knows one of them still lets the deck report
 *  itself. Bracketed for v6 because that is what `URL` produces. */
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/**
 * The transition as an exact non-negative integer — a Number, or a BigInt when
 * only a BigInt can hold it — or null when the input is not one at all.
 *
 * The reader CASTs the column to text, because a transition is an unsigned
 * 32-bit field that sqlite hands back as a signed 64-bit integer and the
 * bindings differ on what they do with the top of that range; text is the one
 * representation nobody can round. A Number is accepted too, so a caller
 * holding a plain row — a test, or a second reader — is not forced to
 * stringify it first, and a BigInt because both sqlite bindings in reach have a
 * mode that returns one.
 *
 * A string of more than 15 digits becomes a BigInt. Not because Chrome emits
 * one — the largest qualifier is 0x80000000 and every value observed fits in 32
 * bits — but because the whole point of the CAST upstream is that the value
 * survives the trip, and finishing the journey with `Number(text)` would put
 * the rounding back one line later. Above 2^79 a double's step is wider than
 * bit 27, so the bit this module exists to read is exactly the one that would
 * be lost.
 */
function transitionValue(transition) {
  if (typeof transition === "number") {
    if (!Number.isFinite(transition)) return null;
    return transition < 0 ? unsigned32(transition, UINT32, INT32_MIN) : transition;
  }
  if (typeof transition === "bigint") {
    return transition < 0n ? unsigned32(transition, UINT32_BIG, INT32_MIN_BIG) : transition;
  }
  if (typeof transition === "string") {
    const text = transition.trim();
    // A sign and digits: a CAST of Chrome's column produces nothing else, and
    // anything else is a row this module has no business guessing about.
    if (!/^-?\d+$/.test(text)) return null;
    if (text.length > EXACT_DIGITS) {
      const big = BigInt(text);
      return big < 0n ? unsigned32(big, UINT32_BIG, INT32_MIN_BIG) : big;
    }
    const value = Number(text);
    return value < 0 ? unsigned32(value, UINT32, INT32_MIN) : value;
  }
  return null;
}

/**
 * A negative transition, read back as the unsigned 32-bit value it is.
 *
 * `visits.transition` is an UNSIGNED 32-bit field whose top qualifier is
 * SERVER_REDIRECT, 0x80000000. Anything that reads or composes it through a
 * signed 32-bit lens produces a negative number carrying the same bits, and
 * JavaScript makes that happen by accident: `0x80000000 | 0x08000000` is
 * -2013265920, not 2281701376, because every bitwise operator here goes through
 * ToInt32. This module's own test hit it while trying to spell a redirected
 * program navigation.
 *
 * Reinterpreting is the only reading of a negative that can be right, because
 * the field has no negative values. It does mean a corrupt -1 reads as every
 * qualifier at once and answers true — which is the direction chosen on
 * purpose. A false positive is a card the user dismisses; a false negative is
 * this feature's original sin, the empty `visit_source` table that answered
 * "nothing ever happened" and was believed.
 *
 * Below -2^31 there is no 32-bit field to undo, so that is a value from
 * somewhere else entirely and answers null.
 *
 * The width is passed in rather than closed over so that one statement of the
 * rule serves both the Number and the BigInt path — the two cannot share an
 * operator, and they were written out twice before, which is one place for the
 * next edit to only half-land.
 */
function unsigned32(value, width, floor) {
  return value >= floor ? value + width : null;
}

/**
 * Was this navigation started by a program?
 *
 * Bit 27 of the transition, and nothing else. Not the core type: every FROM_API
 * visit measured here was also LINK, which is evidence that the bit means what
 * it says rather than a second condition to require — a program navigation with
 * some other core type is still a program navigation, and demanding LINK would
 * be fitting the rule to the 769 rows that happened to be on this disk.
 *
 * The bit is read with arithmetic rather than with `&`. `&` coerces its operand
 * through ToInt32, so a value that arrives as a BigInt throws outright ("cannot
 * mix BigInt and other types") and a value that arrives as a long numeric
 * string is rounded to a double before the mask ever sees it. Division and a
 * remainder work on the number that is actually there.
 */
export function isProgramNavigation(transition) {
  const value = transitionValue(transition);
  if (value === null) return false;
  if (typeof value === "bigint") return (value & FROM_API_BIG) !== 0n;
  return Math.floor(value / FROM_API) % 2 === 1;
}

/** A timestamp as a finite number, or null.
 *
 *  Written out rather than `Number(value)` because `Number(null)` is 0 and
 *  `Number("")` is 0: a row with a missing timestamp would otherwise be filed
 *  as a real visit at the Unix epoch. It would never be near enough to a
 *  candidate to silence one, so nothing would ever fail — the list would just
 *  quietly stop being the list of visits. */
function toMs(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

/** `hostname` and `port` of a matcher or a URL, parsed by the one parser.
 *
 *  Both sides go through `URL` on purpose. It lower-cases the host, punycodes a
 *  non-ASCII one, brackets IPv6 and drops a port that is the scheme's default —
 *  four normalisations, and a matcher compared against a visit is only ever
 *  right if both of them got all four. A scheme is prepended when the matcher
 *  has none, which is how `127.0.0.1:4317` and `*.example.com` parse at all. */
function hostParts(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url;
  try {
    url = new URL(absolute);
  } catch {
    return null;
  }
  if (url.hostname === "") return null;
  return { host: url.host, hostname: url.hostname, port: url.port };
}

/**
 * Exclusion matchers for the deck's own pages, from the origins it is listening
 * on — `["http://127.0.0.1:4317"]`, or whatever the fallback range settled on.
 *
 * This is not politeness. ccdeck opens its own tab through `open`, so every
 * start writes a FROM_API visit to the deck's own origin, and those visits land
 * exactly where the rule is most sensitive: nobody is browsing at the moment a
 * background process opens a tab. Unfiltered, the feature's loudest and most
 * frequent finding is the feature itself.
 *
 * Each origin expands to its port on all three loopback spellings, because the
 * deck opens 127.0.0.1 and a returning user may have typed localhost, and one
 * history holds both. The port is kept: `127.0.0.1` on its own would exclude
 * every local dev server the user runs, which is a real answer being thrown
 * away to solve a problem that is only about one port.
 */
export function defaultExclusions(deckOrigins) {
  const list = Array.isArray(deckOrigins)
    ? deckOrigins
    : typeof deckOrigins === "string" ? [deckOrigins] : [];
  const out = [];
  for (const origin of list) {
    const parts = hostParts(origin);
    if (parts === null) continue;
    const hosts = LOOPBACK.includes(parts.hostname) ? LOOPBACK : [parts.hostname];
    for (const host of hosts) {
      const matcher = parts.port === "" ? host : `${host}:${parts.port}`;
      // Two origins on the same loopback port — 127.0.0.1 and localhost, say —
      // are one exclusion, and a list that repeats itself reads like a bug.
      if (!out.includes(matcher)) out.push(matcher);
    }
  }
  return out;
}

/**
 * Compile exclusion strings into host tests.
 *
 * Three forms, all host-based and none of them looking at the path or the
 * scheme — an exclusion answers "not this site", and a rule that could be
 * dodged by the same server answering on https would be a rule with a hole in
 * it that nobody would find until it mattered:
 *
 *   `127.0.0.1:4317`   that host on that port
 *   `example.com`      that host on any port
 *   `*.example.com`    that host and anything under it, on any port
 *
 * A port narrows; no port does not. That way `defaultExclusions` can name one
 * port without hiding the rest of localhost, and a user writing `example.com`
 * gets what they meant rather than only the default port.
 */
function compileExclusions(exclude) {
  const list = Array.isArray(exclude) ? exclude : typeof exclude === "string" ? [exclude] : [];
  const rules = [];
  for (const entry of list) {
    const parts = hostParts(entry);
    if (parts === null) continue;
    const wildcard = parts.hostname.startsWith("*.");
    const base = wildcard ? parts.hostname.slice(2) : parts.hostname;
    // `*.` alone has nothing under it and would match every host on earth.
    if (base === "") continue;
    rules.push({ base, wildcard, port: parts.port });
  }
  return rules;
}

function isExcluded(rules, visit) {
  for (const rule of rules) {
    if (rule.port !== "" && rule.port !== visit.port) continue;
    if (rule.wildcard) {
      if (visit.hostname === rule.base || visit.hostname.endsWith(`.${rule.base}`)) return true;
    } else if (visit.hostname === rule.base) {
      return true;
    }
  }
  return false;
}

/**
 * Distance from `t` to the nearest value in an ASCENDING array, or Infinity if
 * the array is empty.
 *
 * Binary search, not a scan. `classify` is handed the whole history — 26,395
 * rows on the machine this was measured on, and a browser profile that is not
 * pruned goes much further — and the honest shape of the question is "for each
 * of the 769 candidates, how far is the nearest of the other 25,626". Comparing
 * every pair is a hundred million comparisons that grows with the square of the
 * profile; sorting once and bisecting is the same answer in milliseconds.
 *
 * Both neighbours are checked, because the nearest human visit can be on either
 * side of the candidate and the insertion point only knows about one of them.
 *
 * `<` rather than `<=` inside the loop is not load-bearing and no test pins it:
 * it moves `lo` between the first index equal to `t` and the first index after
 * the equal run, and since both `lo` and `lo - 1` are then measured, either
 * spelling reports the same distance. Said out loud so the next reader does not
 * go looking for the case that distinguishes them.
 */
function nearestDistance(sortedTimes, t) {
  if (sortedTimes.length === 0) return Infinity;
  let lo = 0;
  let hi = sortedTimes.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (sortedTimes[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  // `lo` is the first index at or after `t`; `lo - 1` is the last one before it.
  let best = Infinity;
  if (lo < sortedTimes.length) best = sortedTimes[lo] - t;
  if (lo > 0) best = Math.min(best, t - sortedTimes[lo - 1]);
  return best;
}

/** Chronological, then by URL. The URL tie-break is not decoration: visits
 *  recorded in the same millisecond would otherwise come out in whatever order
 *  the caller's query happened to hand them over, and the output of a pure
 *  function should be a function of its input's CONTENT. */
function byTimeThenUrl(a, b) {
  if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
  return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
}

/**
 * The program-driven visits that happened in silence.
 *
 * `visits` is `[{ url, timeMs, transition }]` in any order. The answer is
 * `[{ url, timeMs, host }]`, oldest first.
 *
 * Two things worth stating about what counts as evidence of a person.
 *
 * EXCLUSIONS DO NOT REMOVE EVIDENCE. They are applied to candidates only. A
 * human visit to an excluded origin is still a human at the browser — somebody
 * reading the deck's own UI is somebody sitting there — and dropping those rows
 * before the quiet gate would manufacture silence around the exact moments the
 * user was watching this feature.
 *
 * A PROGRAM VISIT NEVER SILENCES ANOTHER. A burst of automated navigation is
 * the thing being detected, so counting its own rows as company would make a
 * long agent session cancel itself and leave only the short ones — the exact
 * inversion of what this is for.
 */
export function classify(visits, { quietMs = 15 * 60_000, exclude = [] } = {}) {
  if (!Array.isArray(visits) || visits.length === 0) return [];
  const rules = compileExclusions(exclude);
  const humanTimes = [];
  const candidates = [];

  for (const visit of visits) {
    const timeMs = toMs(visit?.timeMs);
    // A row with no readable timestamp is neither evidence nor a candidate: it
    // cannot be placed on the line the whole rule is about.
    if (timeMs === null) continue;
    if (!isProgramNavigation(visit?.transition)) {
      // Note the order — a human visit counts even if its URL is unparseable.
      // `about:blank` and a typed search that never resolved are still hands on
      // the keyboard, and they are common enough that discarding them would
      // widen every quiet window that touches one.
      humanTimes.push(timeMs);
      continue;
    }
    const parts = hostParts(visit?.url);
    // A candidate with no host has nothing an episode could be named after and
    // nothing an exclusion could match, so it cannot be reported usefully.
    if (parts === null) continue;
    candidates.push({ url: visit.url, timeMs, host: parts.host, hostname: parts.hostname, port: parts.port });
  }

  humanTimes.sort((a, b) => a - b);

  const findings = [];
  for (const candidate of candidates) {
    if (nearestDistance(humanTimes, candidate.timeMs) < quietMs) continue;
    if (isExcluded(rules, candidate)) continue;
    findings.push({ url: candidate.url, timeMs: candidate.timeMs, host: candidate.host });
  }
  findings.sort(byTimeThenUrl);
  return findings;
}

/**
 * Findings grouped into episodes — `[{ host, startMs, endMs, count, urls }]`,
 * newest first, `urls` oldest first inside each.
 *
 * The measured case is the argument for this function existing. Fourteen
 * findings survived a 60-minute gate over 46 days and all fourteen were one
 * program working through one GitLab project between 17:05 and 17:44. As a list
 * that is fourteen alarms; as an episode it is one sentence — "something drove
 * your browser around one project for forty minutes while you were away" —
 * which is the sentence a person can actually act on.
 *
 * The gap is measured between CONSECUTIVE visits, not from the start of the
 * episode. An episode is therefore unbounded in length as long as no single
 * silence inside it reaches `gapMs`, which is what a working agent looks like:
 * the 17:05-17:44 burst is 39 minutes long and stays one card.
 *
 * FIFTEEN MINUTES, AND THE REAL BURST IS WHY. Ten was the first guess and it
 * was wrong in a way only the real profile could show: that GitLab run goes
 * quiet for twelve minutes between 17:12 and 17:24 — somebody reading a jobs
 * page — so a ten-minute gap shreds one session into three cards, which is the
 * fourteen-alarm problem back in smaller print. Sweeping the whole profile,
 * episodes fall 8, 8, 6, 6, 6 at gaps of 5, 10, 15, 20 and 30 minutes: fifteen
 * is where the count settles and nothing above it buys anything, the same
 * plateau shape that fixed `quietMs`. A synthetic burst cannot find this,
 * because an evenly spaced one has no silence in it to be wrong about.
 *
 * Grouped by `host`, which includes the port, so the deck's own 4317 and 4399
 * are two hosts rather than one — different servers, and on a machine where
 * both were running they were different sessions.
 *
 * Newest first by `startMs`: the list answers "what began most recently",
 * because an episode's headline is when the program started working. Ties fall
 * back to `endMs` and then to the host so that the order is fixed by the
 * findings themselves and not by the order they were collected in.
 */
export function toEpisodes(findings, { gapMs = 15 * 60_000 } = {}) {
  if (!Array.isArray(findings) || findings.length === 0) return [];

  const byHost = new Map();
  const browserOf = new Map();
  for (const finding of findings) {
    const host = typeof finding?.host === "string" && finding.host !== "" ? finding.host : null;
    const url = typeof finding?.url === "string" ? finding.url : null;
    const timeMs = toMs(finding?.timeMs);
    if (host === null || url === null || timeMs === null) continue;
    const rows = byHost.get(host);
    if (rows === undefined) byHost.set(host, [{ url, timeMs }]);
    else rows.push({ url, timeMs });
    // `browser` rides on the HOST, not on each url row: a url row is evidence
    // and its shape is pinned by a test that is right to pin it. A reaction
    // downstream has to know which application to tell, and one host's findings
    // all came from the same profile.
    if (!browserOf.has(host) && typeof finding?.browser === "string") {
      browserOf.set(host, finding.browser);
    }
  }

  const groups = [];
  for (const [host, rows] of byHost) {
    // A copy was built above, so this sorts nothing the caller can see. Callers
    // hand this the output of `classify`, and a function that reordered its
    // argument as a side effect would be a trap the second caller finds.
    rows.sort(byTimeThenUrl);
    let open = null;
    for (const row of rows) {
      if (open !== null && row.timeMs - open.endMs < gapMs) {
        open.urls.push(row);
        open.endMs = row.timeMs;
        continue;
      }
      open = { host, browser: browserOf.get(host) ?? null, startMs: row.timeMs, endMs: row.timeMs, urls: [row] };
      groups.push(open);
    }
  }

  // `count` derived at the end rather than incremented alongside `urls`, so the
  // number on the card cannot disagree with the list under it.
  const episodes = groups.map(g => ({
    host: g.host,
    // THE TAG THIS FUNCTION SPENDS A MAP BUILDING. It was set on the group and
    // then dropped here, because this rebuilds each episode field by field and
    // the field was never added — so `browserOf` above was careful, commented,
    // dead code, and every episode reached the panel with `browser: null`.
    //
    // What that cost, none of it visible as an error: a reaction had nothing to
    // tell which application to close, and the radar's ring for a finding fell
    // through `findIndex(...) === -1` into `Math.max(0, -1)` and drew itself on
    // whichever browser happened to be first.
    browser: g.browser,
    startMs: g.startMs,
    endMs: g.endMs,
    count: g.urls.length,
    urls: g.urls,
  }));
  episodes.sort((a, b) => (
    b.startMs - a.startMs ||
    b.endMs - a.endMs ||
    (a.host < b.host ? -1 : a.host > b.host ? 1 : 0)
  ));
  return episodes;
}
