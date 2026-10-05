// Which stored agent commits the commits in a repository's history are.
//
// FIRST, BY SHA. A stored line holds the full SHA when the repo confirmed it,
// or the short one git printed; a history commit whose SHA is the stored one,
// or the only one the short SHA is a prefix of, is "seen".
//
// THEN, FOR WHAT A REWRITE LOST. `git commit --amend`, a rebase and an
// interactive squash all make new commits with new SHAs, so a stored SHA stops
// existing — but each keeps the original author time, and usually the subject.
// A stored commit whose SHA is gone is matched to a history commit with the
// same subject, the same author time (to the second) and, when both sides
// know it, the same branch: "matched", a lower confidence the view names.
//
// NEVER A GUESS. A stored commit that fits two history commits, or a history
// commit two stored commits fit, is left unmatched; so is a stored commit with
// no author time (it was never confirmed) or no subject. A history commit that
// is seen in its own right — an amend the deck watched — is never handed to an
// older stored commit.
//
// Pure. History commits are `{ sha, subject, authorTime, branch }`, author
// time in ms or in seconds (git's %at); `branch` may be null or absent.

const FULL = 40;

/** Author time in whole seconds, whichever unit it came in. */
function seconds(t) {
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  return t > 1e11 ? Math.floor(t / 1000) : Math.floor(t);
}

const usableRecord = r => r && typeof r === "object" && typeof r.sha === "string" && /^[0-9a-f]{7,64}$/.test(r.sha);
const usableCommit = c => c && typeof c === "object" && typeof c.sha === "string" && /^[0-9a-f]{7,64}$/.test(c.sha);

/** Whether two branch names can be the same commit's: equal, or one unknown. */
function sameBranch(a, b) {
  return typeof a !== "string" || !a || typeof b !== "string" || !b || a === b;
}

/**
 * Every history commit a stored agent commit accounts for.
 *
 * @param {unknown} records stored lines (agent-git-store.mjs) for one repository
 * @param {unknown} commits that repository's history commits
 * @returns {Map<string, { record: object, confidence: "seen" | "matched" }>} keyed by history SHA
 */
export function attributeCommits(records, commits) {
  const out = new Map();
  const recs = Array.isArray(records) ? records.filter(usableRecord) : [];
  const hist = Array.isArray(commits) ? commits.filter(usableCommit) : [];
  if (!recs.length || !hist.length) return out;

  const bySha = new Map(hist.map(c => [c.sha, c]));
  const unmatched = [];
  for (const r of recs) {
    let hit = bySha.get(r.sha) ?? null;
    if (!hit && r.sha.length < FULL) {
      const fits = hist.filter(c => c.sha.startsWith(r.sha));
      if (fits.length === 1) hit = fits[0];
    }
    if (hit && !out.has(hit.sha)) out.set(hit.sha, { record: r, confidence: "seen" });
    else if (!hit) unmatched.push(r);
  }

  // The fallback: unique both ways, over the commits nothing claims yet.
  const free = hist.filter(c => !out.has(c.sha));
  const fitsOf = new Map(); // record -> commits it fits
  const claimants = new Map(); // commit sha -> records that fit it
  for (const r of unmatched) {
    const t = seconds(r.authorTime);
    if (t === null || typeof r.subject !== "string" || !r.subject.trim()) continue;
    const fits = free.filter(c => c.subject === r.subject && seconds(c.authorTime) === t && sameBranch(r.branch, c.branch));
    fitsOf.set(r, fits);
    for (const c of fits) claimants.set(c.sha, (claimants.get(c.sha) ?? 0) + 1);
  }
  for (const [r, fits] of fitsOf) {
    if (fits.length !== 1) continue;
    const c = fits[0];
    if (claimants.get(c.sha) !== 1) continue;
    out.set(c.sha, { record: r, confidence: "matched" });
  }
  return out;
}

/**
 * Only the fallback's matches: stored commits whose SHA no longer exists,
 * carried to the commit an amend, rebase or squash made of them.
 *
 * @param {unknown} records
 * @param {unknown} commits
 * @returns {{ sha: string, record: object, confidence: "matched" }[]}
 */
export function matchRewritten(records, commits) {
  const out = [];
  for (const [sha, hit] of attributeCommits(records, commits)) {
    if (hit.confidence === "matched") out.push({ sha, record: hit.record, confidence: "matched" });
  }
  return out;
}
