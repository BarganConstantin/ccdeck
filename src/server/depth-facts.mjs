// How the deck holds up and who runs it, for the daily "active" report
// (reports.mjs), and how an update arrived, for the "update" one.
//
// EVERY VALUE HERE IS A BUCKET, A CATEGORY OR A SMALL COUNT. How long this run
// took to start, the usage day's peak memory and how many events the deck took
// in that day leave as the bucket they fall in ("2s", "512m", "1k"); the Claude
// and Codex plans as the plan's category ("max-20x", "plus") and nothing else
// from the credentials they are read from; the Claude accounts and the paired
// machines as counts, capped. The lists below are the only words that can
// leave, and the API keeps the same ones (ccdeck-api AppEventRequest): a value
// off a list is not sent.
//
// Each bucket is named by its upper edge: "2s" is over one second and up to
// two, "512m" over 256 MB and up to 512 MB, "1k" a day of 100 to 999 events.

export const LAUNCH_BUCKETS = Object.freeze(["1s", "2s", "5s", "10s", "30s", "later"]);
const LAUNCH_EDGES_MS = [1000, 2000, 5000, 10_000, 30_000];

export const MEMORY_BUCKETS = Object.freeze(["128m", "256m", "512m", "1g", "2g", "more"]);
const MEMORY_EDGES_MB = [128, 256, 512, 1024, 2048];

export const EVENT_BUCKETS = Object.freeze(["0", "100", "1k", "10k", "100k", "more"]);
const EVENT_EDGES = [0, 99, 999, 9999, 99_999];

export const CLAUDE_PLANS = Object.freeze(["free", "pro", "max", "max-5x", "max-20x", "team", "enterprise", "api"]);
export const CODEX_PLANS = Object.freeze(["free", "go", "plus", "pro", "pro-lite", "team", "business", "enterprise", "edu", "api"]);

/** How a new version arrived: the deck's own update (a press, or the update it
 *  runs while nobody is looking), the desktop app's updater, npx fetching the
 *  latest, npm run by hand, or a source checkout pulled. */
export const UPDATE_VIAS = Object.freeze(["self-update", "desktop-updater", "npx", "npm", "checkout"]);

/** The most accounts or paired machines a report says; past it, it says this. */
export const COUNT_CAP = 50;

/** How long the deck's own update stays the answer: a press that failed is not
 *  credited with an update somebody made by hand days later. */
export const SELF_UPDATE_FRESH_MS = 2 * 24 * 60 * 60 * 1000;

function bucketOf(value, edges, names) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  const i = edges.findIndex(edge => value <= edge);
  return names[i < 0 ? names.length - 1 : i];
}

/** A run's start, in ms from its process starting to the deck listening. */
export function launchBucket(ms) {
  return bucketOf(ms, LAUNCH_EDGES_MS, LAUNCH_BUCKETS);
}

/** The deck's peak resident memory on a day, in MB. */
export function memoryBucket(mb) {
  return bucketOf(mb, MEMORY_EDGES_MB, MEMORY_BUCKETS);
}

/** The live events a day took in. */
export function eventsBucket(n) {
  return Number.isInteger(n) ? bucketOf(n, EVENT_EDGES, EVENT_BUCKETS) : undefined;
}

/** A whole count of zero or more, capped at COUNT_CAP; anything else, nothing. */
export function cappedCount(n) {
  return Number.isInteger(n) && n >= 0 ? Math.min(n, COUNT_CAP) : undefined;
}

/**
 * The Claude plan as a category, from the two fields Claude Code keeps beside
 * its OAuth token: `subscriptionType` ("pro", "max", "team"…) and, for Max, the
 * `rateLimitTier` that says which of the two ("…max_5x", "…max_20x"). Nothing
 * else in that file is looked at, and a type off the list says nothing.
 */
export function claudePlanToken({ subscriptionType, rateLimitTier } = {}) {
  const type = typeof subscriptionType === "string" ? subscriptionType.trim().toLowerCase() : "";
  if (type === "max") {
    const tier = typeof rateLimitTier === "string" ? rateLimitTier.toLowerCase() : "";
    return tier.includes("20x") ? "max-20x" : tier.includes("5x") ? "max-5x" : "max";
  }
  return ["free", "pro", "team", "enterprise"].includes(type) ? type : undefined;
}

/** The Codex plan as a category, from the `chatgpt_plan_type` claim codex-auth
 *  reads; OpenAI writes Pro Lite three ways. */
export function codexPlanToken(planType) {
  const type = typeof planType === "string" ? planType.trim().toLowerCase().replace(/_/g, "-") : "";
  const plan = type === "prolite" ? "pro-lite" : type;
  return CODEX_PLANS.includes(plan) && plan !== "api" ? plan : undefined;
}

/**
 * How the version this run is on arrived, for the "update" that says it.
 *
 * `marker` is what the deck wrote when it started an update itself
 * (`{ from, at }`, reports.mjs noteSelfUpdate): it counts only for an update
 * away from the version it was written on, and only while fresh. Otherwise the
 * channel says it: the desktop app updates through its own updater, a source
 * checkout through git, and an npm install either because npx fetched the
 * latest or because somebody ran npm.
 */
export function updateVia({ marker, lastVersion, channel, npx = false, now = new Date() } = {}) {
  const at = marker && typeof marker.at === "string" ? Date.parse(marker.at) : NaN;
  if (marker?.from && marker.from === lastVersion && Number.isFinite(at)
    && now.getTime() - at >= 0 && now.getTime() - at <= SELF_UPDATE_FRESH_MS) {
    return "self-update";
  }
  if (channel === "desktop") return "desktop-updater";
  if (channel === "checkout") return "checkout";
  if (channel === "npm") return npx ? "npx" : "npm";
  return undefined;
}

// ── the deck's own readings ──────────────────────────────────────────────────
//
// Read only when an "active" is about to go, never on a hot path, and each by
// lazy import, so the reporter's module graph pulls in none of it. Each one is
// on its own: a reading that fails or does not apply is left out, and none of
// them can throw.

/** The Claude plan, unless the boot left Claude out. Bedrock, Vertex and an
 *  API key are "api"; a machine that keeps its login in the macOS Keychain has
 *  no file to read, and says nothing. Bedrock, Vertex and the key are read
 *  where the quota reader reads them — Claude Code's settings as well as this
 *  deck's environment, "true", "yes" and "on" as well as "1" — so the plan
 *  reported and the quota panel agree about one install. */
async function claudePlan(env) {
  const [{ readFile }, { claudeSignIn, credentialsPath }] = await Promise.all([import("node:fs/promises"), import("./quota-oauth.mjs")]);
  const { cloud, apiKey } = await claudeSignIn(env);
  if (cloud) return "api";
  let oauth = null;
  try {
    oauth = JSON.parse(await readFile(credentialsPath(), "utf8"))?.claudeAiOauth ?? null;
  } catch { /* no file, or not one we can read */ }
  if (oauth) return claudePlanToken(oauth);
  return apiKey ? "api" : undefined;
}

/** The Codex plan, never refreshing a token to learn it. */
async function codexPlan() {
  const { getCodexAuth } = await import("./codex-auth.mjs");
  const auth = await getCodexAuth({ allowRefresh: false, selectedReadOnly: true, enableNative: true });
  if (auth?.apiKeyMode) return "api";
  return auth?.ok ? codexPlanToken(auth.planType) : undefined;
}

/** The accounts the last roster read held: no read is started for this. */
async function accountCount() {
  const { knownAccountCount } = await import("./claude-accounts.mjs");
  return knownAccountCount();
}

async function quietly(read) {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/**
 * What the deck says about itself on its "active": the plans, the accounts and
 * the paired machines. `setup` is what the boot set up (activation.mjs) — the
 * Claude plan is read unless the Claude hooks are off, the Codex plan only when
 * the deck watches Codex — and `prefs` the held prefs, whose paired decks are
 * the machines.
 */
export async function deckDepth({ setup = {}, prefs = null, env = process.env } = {}) {
  const [claude, codex, accounts] = await Promise.all([
    setup.claudeHooks === "off" ? undefined : quietly(() => claudePlan(env)),
    setup.codexWatch === "on" ? quietly(codexPlan) : undefined,
    quietly(accountCount),
  ]);
  const trusted = prefs?.lan?.trusted;
  return {
    claudePlan: claude,
    codexPlan: codex,
    accounts,
    machines: Array.isArray(trusted) ? trusted.length : undefined,
  };
}
