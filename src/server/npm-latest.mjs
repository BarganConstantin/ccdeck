// What npm says the newest version is, asked at most once an hour and never
// more often than the floor allows, with the answer kept on disk between runs.
//
// This lived in src/server/self-update.mjs, in two pieces: the check's windows
// and its floor at the top of the file, and the lookup, its marker file and the
// rules for when to ask again in the middle. They share the marker and the
// state that dedupes and rations the requests, and nothing else in the
// self-update code keeps any, so they moved here together. self-update.mjs
// reads the answer for its version report and re-exports the names it
// exported before; the restart-failure note shares the directory and the rule
// for turning a package name into a file name. The bodies are unchanged.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PUBLISHED_NAME } from "./install-layout.mjs";

// Once an hour, not once a day.
//
// The daily cadence was copied from the ccusage and cswap checks, where it is
// right: those answer "is a different tool out of date", and nobody is waiting
// on it. This one answers "is the thing you are looking at out of date", and a
// day is long enough that a deck started shortly before a release shows nothing
// at all until tomorrow — reported from a machine running `npx ccdeck`, which
// is the case where it bites hardest, since npx runs are short-lived and each
// one inherits the same stale marker. The request is ~20 bytes.
const CHECK_MS = 3600_000;
// A lookup that failed is not an answer, so it must not spend the hour an
// answer buys. It still has to spend something: the reason to rate-limit is
// gone, but a registry that is down would otherwise be asked again on every
// single poll. Five minutes is the compromise — short enough that a network
// coming back is noticed while the user is still looking at the deck, long
// enough that a full npm outage costs a dozen ~20-byte requests an hour.
const RETRY_MS = 300_000;
const FETCH_TIMEOUT_MS = 6_000;
// A third marker family: ccusage owns ~/.agents-deck/ccusage/.last-update-check
// and cswap owns ~/.agents-deck/.cswap-update-check. Sharing one would make the
// three features fight over a single daily slot.
export const MARKER_DIR = join(homedir(), ".agents-deck");
// The name this deck was published under is part of the marker's identity.
//
// A single ~/.agents-deck/.self-update-check was shared by every deck on the
// machine, so whichever one asked npm first pinned the answer for all of them
// until the window expired — including a freshly started `npx ccdeck` that had
// never written it, and including decks running a DIFFERENT package where the
// cached version means nothing. Reported with four decks alive at once: three
// served the same `checkedAt` to the millisecond and none of them showed the
// seven releases that had shipped meanwhile. One file per package name means
// `agents-deck`, `ccdeck` and `agent-dag` decks stop silencing each other; the
// old shared path stays here only to be inherited from once.
const LEGACY_MARKER = join(MARKER_DIR, ".self-update-check");

// Dedupe concurrent /api/version calls into one fetch, per package name — two
// names are two different questions and must not be answered with one answer.
const _inflight = new Map();

// ── what a forced check may cost ─────────────────────────────────────────────
//
// `_inflight` deduplicates callers that OVERLAP and nothing else. `checkDue`
// answers `true` on `force` before it asks anything else, so a caller that
// waited for one check to settle and then asked again got a fresh
// `https://registry.npmjs.org/…/dist-tags` every time. Reads on this server are
// deliberately open — `isTrustedRead` does not apply the `Sec-Fetch-Site` test
// that `isTrustedMutation` does, because a cross-site read of
// `http://127.0.0.1:4317` is an ordinary top-level navigation — so
//
//     (async function spin() {
//       for (;;) await fetch("http://127.0.0.1:4317/api/version?refresh=1",
//                            { mode: "no-cors" });
//     })();
//
// from any page the user had open was one registry request per turn, as fast as
// the round trip allows, and every so often two of them: `runCheck` confirms a
// tag it has not seen before against the version document. The requests are
// small — the whole reason the dist-tags endpoint is used here rather than the
// packument — but they leave the user's address, carrying the user-agent this
// deck sets, and they are aimed at a third party rather than at the machine the
// loop is running on. That makes it #580's shape with the cost pointed
// outwards, which if anything is the worse direction.
//
// Nothing above this line was going to stop it. The hour is written to a marker
// FILE, and `force` walks past it; `first` walks past it too; and on a machine
// where `~/.agents-deck` cannot be written `writeMarker` swallows the failure,
// so `checkDue` sees "never checked" on every single call and the hour is not
// really there at all.
//
// So the floor sits under all of it, in this process's own memory, between the
// last rule that admitted a check and the request it admitted. It is quota.mjs's
// number and codex-quota.mjs's and codex-usage.mjs's — the five routes in this
// deck's router that accept `?refresh=1` and can pay for it have no business
// disagreeing about what it costs.
const FORCE_POLL_MS = 60_000;

// Stamped when a check STARTS rather than when npm answers, because what the
// floor rations is the request. Per package name, like `_inflight` and like the
// markers: two names are two different questions, and one of them being asked
// is not a reason to refuse the other. Deliberately in memory rather than on
// disk — the marker is shared by every deck running that package and this is
// about what THIS process is sending.
const _lastAskAt = new Map();

/**
 * Whether we may spend a registry request right now.
 *
 * Exported for tests, for the same reason quota.mjs exports `maySelfPoll`,
 * codex-quota.mjs `mayFetchQuota` and codex-usage.mjs `mayScanUsage`: this is
 * the rule, it is pure, and it is worth pinning down away from the request it
 * guards.
 */
export function mayAskNpm({ now, lastAskAt }) {
  // A stamp from the future is a clock that moved, not a check that just ran —
  // the same case `checkDue` answers twice below with `> now`, and the same
  // answer. Without it, a machine whose clock corrects backwards by an hour
  // would go an hour without a version check.
  if (lastAskAt > now) return true;
  return now - lastAskAt >= FORCE_POLL_MS;
}

// ── what npm has ─────────────────────────────────────────────────────────────

/** One GET to the registry, asked the way both lookups below ask it: for JSON,
 *  under this deck's user-agent, and given up on after FETCH_TIMEOUT_MS. */
function askRegistry(path) {
  return fetch(`https://registry.npmjs.org/${path}`, {
    headers: { accept: "application/json", "user-agent": "agents-deck" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

// The dist-tags endpoint answers with ~20 bytes ({"latest":"1.30.7"}); the full
// packument is >2 KB and needs parsing we have no use for.
//
// Answers `{ ok, version }` rather than a bare string, because "npm says the
// latest is X" and "npm did not answer" used to arrive here as the same null.
// `ok` is true only when the registry handed back a usable version — a
// timeout, a non-200 and a 200 with no `latest` in it are all failures, and
// the caller has to be able to tell them from an up-to-date deck.
async function fetchLatest(name) {
  try {
    const res = await askRegistry(`-/package/${name}/dist-tags`);
    if (!res.ok) return { ok: false, version: null };
    const v = (await res.json())?.latest;
    return typeof v === "string" ? { ok: true, version: v } : { ok: false, version: null };
  } catch {
    return { ok: false, version: null };
  }
}

// A dist-tag is a pointer, and being pointed at is not the same as being
// installable.
//
// npm makes the moved tag visible before the version document has propagated to
// the replica the installer reads, so for a window `{"latest":"1.33.28"}` and
// `No matching version found for ccdeck@1.33.28` are both true at the same
// moment. Reported live: the banner offered v1.33.28, the restart ran
// `npx -y ccdeck@latest`, npm answered ETARGET, and the deck came back on the
// version it started with after tearing itself down — under npx a restart is
// not free, since the worker exits and hands the port over before anything is
// fetched.
//
// So the tag is checked against the version document, which is the same
// question `npm view <name>@<version> version` asks and the same document the
// installer resolves against. 404 is the answer this exists for: published
// tag, unpublished version, try again in five minutes. `ok` is false only when
// the registry gave no usable answer at all — that is not a licence to
// announce either, but it is not evidence of an unpublished version.
async function isPublished(name, version) {
  try {
    const res = await askRegistry(`${name}/${version}`);
    if (res.status === 404) return { ok: true, published: false };
    if (!res.ok) return { ok: false, published: false };
    // The document has to be the one asked for: a registry that answers 200
    // with something else has not shown that this version is resolvable.
    const body = await res.json().catch(() => null);
    return { ok: true, published: body?.version === version };
  } catch {
    return { ok: false, published: false };
  }
}

/** Marker file name for a package: `ccdeck` → `.self-update-check-ccdeck`.
 *
 *  Pure, and deliberately strict about what reaches the filesystem — a package
 *  name may be scoped (`@scope/pkg`), and `/`, `\` and `:` are either a path
 *  separator or outright illegal in a Windows file name. Everything outside
 *  `[a-z0-9._-]` collapses to `-`, the scope's leading `@` is dropped so the
 *  common case reads plainly, and the tail is trimmed so a pathological name
 *  cannot produce a path the OS refuses. An unusable name falls back to the
 *  default rather than to the shared file this fix exists to get rid of. */
export function markerFileName(name = PUBLISHED_NAME) {
  return `.self-update-check-${safeNamePart(name)}`;
}

/** The sanitised half, shared with the restart-failure note so the two files
 *  agree on what a package name becomes on disk. */
export function safeNamePart(name) {
  const raw = typeof name === "string" ? name.trim().toLowerCase() : "";
  const safe = raw
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .slice(0, 64)
    // Trimmed after the slice, and at both ends: Windows silently drops a
    // trailing dot from a file name, so a name that ends in one would write to
    // a path that is not the path we would later read.
    .replace(/^[-.]+|[-.]+$/g, "");
  return safe || PUBLISHED_NAME;
}

function markerPath(name) {
  return join(MARKER_DIR, markerFileName(name));
}

// The marker carries the answer, not just the timestamp. The existing markers
// store only an mtime, which means a restart inside the window forgets what npm
// said and shows nothing until the window expires.
//
// It carries the outcome too. `at` is when npm last ANSWERED and `version` is
// what it said; `failedAt` is when the last attempt failed, and is null the
// moment one succeeds. Keeping them apart is what lets the deck say "checked
// 3m ago" and "could not reach npm" as the different things they are, instead
// of reporting a timeout as a fresh, up-to-date check.
function readMarkerFile(path) {
  try {
    const m = JSON.parse(readFileSync(path, "utf8"));
    // Either half is enough to be worth keeping: a marker written by a first
    // attempt that failed has no `at` yet, and markers written before
    // `failedAt` existed have no `failedAt` at all.
    return (typeof m?.at === "number" || typeof m?.failedAt === "number") ? m : null;
  } catch {
    return null;
  }
}

// The unsuffixed marker every earlier deck wrote, read at most once per name
// per process: upgrading to this version should not throw away an answer npm
// already gave. It is consulted only while the per-name file is still missing,
// so the shared file never goes back to being in charge.
const _legacy = new Map();
function legacyMarker(name) {
  const key = markerFileName(name);
  if (!_legacy.has(key)) _legacy.set(key, readMarkerFile(LEGACY_MARKER));
  return _legacy.get(key);
}

export function readMarker(name) {
  return readMarkerFile(markerPath(name)) ?? legacyMarker(name);
}

/** The version npm last named as `latest` for this package, straight off the
 *  marker and with no lookup of its own.
 *
 *  This is what the supervisor calls a failed upgrade's TARGET. It has to be
 *  answerable without the network — the supervisor asks it in the moment
 *  between a click and a fetch, and the reason the fetch is about to fail may
 *  well be that there is no network — and it has to be the same number the
 *  banner offered, which is precisely what the marker holds. */
export function lastKnownLatest(name = PUBLISHED_NAME) {
  const v = readMarker(name)?.version;
  return typeof v === "string" && v ? v : null;
}

function writeMarker(name, marker) {
  const path = markerPath(name);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(marker));
  } catch { /* a read-only home must not break the deck */ }
}

/** What the marker should hold after an attempt. Pure, because "a failed
 *  lookup must not be recorded as a successful one" is precisely the rule this
 *  file used to get wrong, and a rule worth a bug is worth a test.
 *
 *  A success stamps the hour and clears the failure. A failure records only
 *  itself, leaving the last real answer and the time it arrived untouched —
 *  the deck keeps showing what it knew, and stops claiming it just confirmed
 *  it.
 *
 *  `installable` is the third outcome: npm answered, and what it named is not
 *  yet a version anything can install. That is a real answer — `at` moves, the
 *  registry was reached — but the version is held in `pending` instead of
 *  `version`, so `latest` stays a number the upgrade command can resolve, and
 *  `pendingAt` puts the next look on the short window rather than the hour. */
export function nextMarker({ prev, now, ok, version, installable = true }) {
  if (!ok) {
    return {
      at: prev?.at ?? null,
      version: prev?.version ?? null,
      failedAt: now,
      pending: prev?.pending ?? null,
      pendingAt: prev?.pendingAt ?? null,
    };
  }
  if (!installable) {
    return { at: now, version: prev?.version ?? null, failedAt: null, pending: version ?? null, pendingAt: now };
  }
  return { at: now, version: version ?? null, failedAt: null, pending: null, pendingAt: null };
}

// Even a per-package marker is shared by every deck running that package, so
// one deck's check still answers for the others inside the window. Asking once
// per PROCESS lands the check exactly where the user expects the truth: a
// freshly started deck — which for `npx ccdeck` is every single run. Keyed by
// name, so a process that asked about one package has not asked about another.
const _askedThisProcess = new Set();

/**
 * Whether to ask npm, or reuse the answer on disk. Pure, because "why did no
 * banner appear" is the question this feature gets asked, and the rule behind
 * it should be readable in one place.
 */
export function checkDue({ at, failedAt, pendingAt, now, first = false, force = false, ttlMs = CHECK_MS, retryMs = RETRY_MS }) {
  if (force || first) return true;      // explicit ask, or this process's first
  // Two ways of not having an answer yet, and neither may spend the hour a real
  // answer buys: the last attempt failed, or npm named a version that cannot be
  // installed yet. Both take the short window instead — an unreachable registry
  // must not turn every poll into another request, and a release mid-publish is
  // resolvable minutes later, not an hour later. Answered before `at`, which
  // here is the older, settled check and would otherwise ask again immediately
  // (or, for a pending version, not for another hour).
  const unsettled = [failedAt, pendingAt].filter(t => typeof t === "number");
  if (unsettled.length) {
    const last = Math.max(...unsettled);
    if (last > now) return true;        // clock moved; do not wait it out
    return now - last >= retryMs;
  }
  if (typeof at !== "number") return true;  // never checked
  if (at > now) return true;            // marker from the future: a moved clock
  return now - at >= ttlMs;
}

/** Last known npm `latest`, refreshed at most once per CHECK_MS. Returns the
 *  cached answer immediately when the window has not elapsed.
 *
 *  `force` skips the window: the first call in this process, and an explicit
 *  "check now" from the UI. What it does not skip is FORCE_POLL_MS — see
 *  mayAskNpm, and the note above it for what a forced call used to cost. */
export async function latestOnNpm(name, now, force = false) {
  const m = readMarker(name);
  const key = markerFileName(name);
  const first = !_askedThisProcess.has(key);
  _askedThisProcess.add(key);
  if (!checkDue({ at: m?.at, failedAt: m?.failedAt, pendingAt: m?.pendingAt, now, first, force })) {
    return m?.version ?? null;
  }
  // Offered before the floor: a check that has not answered yet is a lookup
  // newer than the marker, which is what refresh asked for, and joining it costs
  // nothing.
  const inflight = _inflight.get(key);
  if (inflight) return inflight;
  // The floor, under every rule above it. A refused check is answered with the
  // version we already hold — the same string an ordinary cached call returns,
  // carrying the marker's own `checkedAt` rather than the moment of the read
  // that was refused, so /api/version reports exactly what it reported a moment
  // ago and no surface learns a new failure mode from being asked twice.
  if (!mayAskNpm({ now, lastAskAt: _lastAskAt.get(key) ?? 0 })) return m?.version ?? null;
  _lastAskAt.set(key, now);
  const run = runCheck(name, m, now)
    // Record the outcome, not just the moment, and record it against THIS
    // package: only an answer stamps `at`; a failure takes the short retry
    // window instead of the hour, keeps the version we already knew rather
    // than erasing it, and lands in this name's marker rather than spending
    // another package's window on a lookup that was never about it.
    .then((marker) => {
      writeMarker(name, marker);
      return marker.version ?? null;
    })
    .catch(() => m?.version ?? null)
    .finally(() => { _inflight.delete(key); });
  _inflight.set(key, run);
  return run;
}

/** One check, as a marker: what npm's dist-tag says, and — only when that is a
 *  version this deck has not already confirmed — whether it can be installed.
 *
 *  The second request is what keeps the banner honest, and it is skipped in the
 *  case that runs all day: a tag that has not moved was confirmed the first
 *  time it was seen, so a deck sitting on the current release still costs one
 *  ~20-byte GET per check. Confirming costs one more, once per release. */
async function runCheck(name, prev, now) {
  const { ok, version } = await fetchLatest(name);
  if (!ok || version === prev?.version) return nextMarker({ prev, now, ok, version });
  const probe = await isPublished(name, version);
  return nextMarker({ prev, now, ok, version, installable: probe.ok && probe.published });
}
