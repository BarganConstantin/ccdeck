// Shared by version reporting and post-install verification. No I/O.
// ── version comparison ───────────────────────────────────────────────────────

/** Numeric-segment compare of one version's parts: -1, 0 or 1. Non-numeric
 *  segments count as 0 and missing segments pad with 0, so "1.30" sorts before
 *  "1.30.1" and "1.9.0" before "1.10.0". */
function cmpParts(x, y) {
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** A version split at the FIRST `-`: the release on one side, the prerelease
 *  identifiers on the other, or null when there is no prerelease at all.
 *
 *  `+` stays inside the release half rather than starting a third part, which
 *  keeps build metadata reading exactly as it read before — `1.0.0+build.7`
 *  segments to [1,0,0,0,7] and therefore sorts above `1.0.0`. That is inherited
 *  behaviour rather than a design, this repo has never published one, and a
 *  change to it belongs in its own issue. */
function versionParts(v) {
  const nums = (s) => s.split(/[.+]/).map(n => parseInt(n, 10)).map(n => Number.isNaN(n) ? 0 : n);
  const dash = v.indexOf("-");
  if (dash === -1) return { release: nums(v), pre: null };
  return { release: nums(v.slice(0, dash)), pre: nums(v.slice(dash + 1)) };
}

/** True when `a` sorts before `b`.
 *
 *  A PRERELEASE SORTS BELOW THE RELEASE IT PRECEDES (#976), which is semver's
 *  rule and was not this function's. Splitting on `[.\-+]` and mapping
 *  non-numeric segments to 0 made `3.23.0-rc.1` segment to [3,23,0,0,1] — five
 *  numbers against the release's three, so it compared ABOVE `3.23.0` and the
 *  release compared below the candidate it was meant to supersede:
 *
 *      isOlder("3.23.0-rc.1", "3.23.0") = false    ← the release never looked newer
 *      isOlder("3.23.0", "3.23.0-rc.1") = true     ← and the deck would go backwards
 *
 *  What that costs is not a cosmetic ordering. `autoUpdate` defaults on, so a
 *  deck that has ended up on a prerelease — installed by hand by a tester, or
 *  by the dist-tag accident publish.yml now prevents — produces no upgrade
 *  notice when the real release ships, shows nothing in the banner, and has no
 *  way to come back off it from inside the product. A bad release can be
 *  followed by a good one; a fleet that cannot SEE the good one cannot be
 *  rescued by publishing it, which is why this half matters even with the
 *  dist-tag half in place.
 *
 *  Ordinary numeric ordering is untouched — the release halves are compared
 *  exactly as before — and so is build metadata; see versionParts.
 *
 *  cswap-install.mjs had this written out a second time, without the type guard
 *  below, and imports it from here now (#374). The two bodies were identical:
 *  swept over 271,441 version-string pairs they disagreed on none, and the
 *  guard was the whole difference — `isOlder(null, "1.0.0")` answers false here
 *  and threw a TypeError there. Nothing could reach that call with a non-string
 *  (both arguments are behind `typeof v === "string"` checks at the one call
 *  site), so this is the copy with a test behind it absorbing the one without,
 *  not a bug fix. That sweep is now one-sided on prerelease pairs and
 *  duplicated-helpers.test.ts says which, rather than asserting an equality
 *  that has deliberately stopped holding. */
export function isOlder(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = versionParts(a), y = versionParts(b);
  const release = cmpParts(x.release, y.release);
  if (release !== 0) return release < 0;
  // Same release. A version carrying a prerelease is below the plain one, and
  // never the other way round; two prereleases of one release compare on their
  // own identifiers, so rc.2 is above rc.1.
  if (x.pre && !y.pre) return true;
  if (!x.pre || !y.pre) return false;
  return cmpParts(x.pre, y.pre) < 0;
}
