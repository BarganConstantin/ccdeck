// The usage panel's reads: Claude's quota windows, Codex's quota and usage, and
// ccusage's daily history.
//
// These lived in src/server/index.mjs after the shutdown route, and each is the
// same few lines: read `?refresh=1`, import the module that does the work,
// hand the flag on, and answer with what comes back. What bounds a forced read
// is those modules' business — codex-usage-forced-read-guard.test.ts keeps the
// census of it there — and each is imported lazily by the package-root URL
// PINNED_MODULES loads. The one rule decided here is isCliDate, because this is
// where a string somebody else chose enters on its way to a child's argv.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { send } from "./http-io.mjs";

// Resolved the way index.mjs resolves it, from a file in the same directory, so
// every lazy import below is the URL the pin has already evaluated.
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * WITH A DEADLINE OF ITS OWN (#1011). Source 3 is `claude --print /usage`, and
 * its cost is the sum of three spawns under a 15-second timeout with two
 * 1.2-second sleeps between them — 47.4 seconds, measured — which nothing here
 * had ever added up. The budget is quota.mjs's, because the "not yet" answer it
 * expires into is made of that module's own last-known-good reading; the read
 * carries on behind it and publishes for the next poll.
 */
export async function handleQuota(req, res) {
  const { fetchClaudeQuota, QUOTA_DEADLINE_MS } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/quota.mjs")).href
  );
  const url = new URL(req.url, "http://localhost");
  const force = url.searchParams.get("refresh") === "1";
  const quota = await fetchClaudeQuota({ force, deadlineMs: QUOTA_DEADLINE_MS });
  send(res, 200, quota);
}

export async function handleCodexUsage(req, res) {
  const { fetchCodexUsage } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/codex-usage.mjs")).href
  );
  const url = new URL(req.url, "http://localhost");
  const force = url.searchParams.get("refresh") === "1";
  const usage = await fetchCodexUsage({ force });
  send(res, 200, usage);
}

export async function handleCodexQuota(req, res) {
  const { fetchCodexQuota } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/codex-quota.mjs")).href
  );
  const url = new URL(req.url, "http://localhost");
  const force = url.searchParams.get("refresh") === "1";
  const quota = await fetchCodexQuota({ force });
  send(res, 200, quota);
}

/**
 * ccusage's `--since`/`--until` grammar: a `YYYYMMDD` calendar date, or nothing
 * at all — an absent parameter lets ccusage.mjs pick the default 30-day range.
 *
 * Eight digits is a shape, not a calendar, and deliberately so. What this gate
 * is for is keeping anything that is not a date out of a child process's
 * argument vector; `99999999` is exactly as inert an argument as `20260101`,
 * and whether a date outside the logs means an empty chart is ccusage's
 * question to answer rather than the deck's to guess at.
 */
export const isCliDate = (v) => v === undefined || /^\d{8}$/.test(v);

export async function handleCcusage(req, res) {
  const url = new URL(req.url, "http://localhost");
  const force = url.searchParams.get("refresh") === "1";
  const since = url.searchParams.get("since") || undefined;
  const until = url.searchParams.get("until") || undefined;
  // Refused here, at the boundary, because this is where a string chosen by
  // someone else enters: /api/ccusage is a GET, so it needs no CORS, no
  // preflight and no ability to read the response — any page the user has open
  // can fire it at the loopback port — and both values end up in the argv of a
  // spawned CLI. The spawn no longer goes through a shell (see ccusage.mjs), so
  // this is the second lock rather than the only one, and it is the one that
  // keeps the pair honest if a shell is ever reintroduced downstream.
  if (!isCliDate(since) || !isCliDate(until)) {
    return send(res, 400, {
      ok: false,
      reason: "bad_range",
      error: "since and until must be YYYYMMDD dates, e.g. 20260101",
    });
  }
  const { fetchCcusageDaily } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/ccusage.mjs")).href
  );
  const data = await fetchCcusageDaily({ since, until, force });
  send(res, 200, data);
}
