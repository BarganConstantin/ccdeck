// Whether Anthropic or OpenAI say something is wrong on their side (#1311).
//
// When Claude or Codex has an incident, everything this deck can see of it is
// a local symptom — a quota read that fails, an agent that errors and retries,
// a number that stops moving — and nothing here said the cause might be
// upstream. So an outage looked like the user's machine, network, login or
// this deck. Both providers publish their health on a page that serves the
// Atlassian Statuspage API (OpenAI's page is incident.io, which answers the
// same /api/v2/summary.json), and this module asks that page and boils the
// answer down to one line per provider.
//
// SCOPED TO THE COMPONENTS A DECK USES. OpenAI's page covers ChatGPT, the ads
// products, image generation and twenty more, and its page-wide indicator goes
// amber for a ChatGPT outage no Codex session will ever feel. So the state is
// the worst of the NAMED components — Claude Code and the Claude API on
// Anthropic's page, the Codex ones on OpenAI's — and the page-wide indicator is
// a fallback only, for the day a page renames every one of them.
//
// ON DEMAND, NOT ON A TIMER. Nothing in this file polls. A read goes out when
// the page or the desktop tray asks and the last answer is older than
// FRESH_MS, so a deck with nobody looking at it asks nobody anything, and the
// page stops asking while its tab is hidden (use-provider-status.ts).
//
// A FAILED READ IS NOT AN INCIDENT. An unreachable status page says nothing
// about the provider — far more often it is the user's own network — so a
// failure keeps the last answer and marks it stale, and past EXPIRE_MS drops it
// to "unknown", which draws nothing. It never becomes an outage, and nothing
// here throws: this is context for a diagnosis, and no other part of the deck
// waits on it.

/** The two pages, what each page is linked as, and which of its components
 *  are the ones this deck's sessions depend on. */
export const PROVIDERS = {
  claude: {
    summaryUrl: "https://status.claude.com/api/v2/summary.json",
    pageUrl: "https://status.claude.com",
    // claude.ai, the Console and the government and Cowork products are left
    // out: an incident that reaches Claude Code lists Claude Code, and one that
    // only reaches the web app does not stop a session.
    components: [/^Claude Code$/i, /^Claude API\b/i],
  },
  codex: {
    summaryUrl: "https://status.openai.com/api/v2/summary.json",
    pageUrl: "https://status.openai.com",
    // Codex Web and Codex API by name; the CLI and the editor extension are
    // listed on that page without the word.
    components: [/\bCodex\b/i, /^CLI$/i, /^VS Code extension$/i],
  },
};

/** How long an answer is the answer. Status pages are served from a CDN that
 *  caches for about a minute, so asking more often buys nothing. */
export const FRESH_MS = 3 * 60_000;

/** How long a failed read waits before the next one may go out, so a page
 *  that asks on every poll cannot turn an offline machine into a retry loop. */
export const RETRY_MS = 60_000;

/** How old the last answer may be before it is no answer at all. Past this a
 *  stale incident stops being drawn: it may well be over, and "Claude · major
 *  outage" from an hour ago is not a fact about now. */
export const EXPIRE_MS = 30 * 60_000;

const FETCH_TIMEOUT_MS = 8_000;
// A summary is 2-6 KB. Anything a thousand times that is not a status page.
const MAX_BODY_BYTES = 1 << 20;
// Page-supplied words go on screen; they are cut, never trusted to be short.
const MAX_WORDS = 160;

/** A component's status, in this deck's words. */
const COMPONENT_STATES = {
  operational: "operational",
  degraded_performance: "degraded",
  partial_outage: "partial_outage",
  major_outage: "major_outage",
  under_maintenance: "maintenance",
};

/** The page-wide indicator, in the same words — the fallback only. */
const PAGE_INDICATORS = {
  none: "operational",
  minor: "degraded",
  major: "partial_outage",
  critical: "major_outage",
  maintenance: "maintenance",
};

/** Worst last. Maintenance is below degraded: it was planned, and it said so. */
const SEVERITY = ["operational", "maintenance", "degraded", "partial_outage", "major_outage"];

/** The incident and maintenance statuses that are over. */
const FINISHED = new Set(["resolved", "postmortem", "completed", "scheduled"]);

const own = (map, key) => typeof key === "string" && Object.hasOwn(map, key);
const words = (s) => (typeof s === "string" && s.trim() ? s.trim().replace(/\s+/g, " ").slice(0, MAX_WORDS) : null);

/** Whether this deck asks the status pages at all. AGENTS_DECK_NO_INSTALL is
 *  the switch the README says turns off everything but the quota reads, so it
 *  turns this off too. */
export function statusChecksOff(env = process.env) {
  return env.AGENTS_DECK_NO_STATUS === "1" || env.AGENTS_DECK_NO_INSTALL === "1";
}

/**
 * One provider's page, read. Null when the body is not a summary this module
 * can read — which the caller files as a failed read, not as "operational".
 *
 * @returns {{ state: string, summary: string | null, components: string[], scope: "components" | "page", updatedAt: number | null } | null}
 */
export function readSummary(provider, body) {
  const spec = PROVIDERS[provider];
  if (!spec || !body || typeof body !== "object") return null;
  const updatedAt = Date.parse(body.page?.updated_at) || null;
  const listed = Array.isArray(body.components) ? body.components : [];
  const ours = listed.filter(c =>
    c && typeof c.name === "string" && c.group !== true && own(COMPONENT_STATES, c.status)
    && spec.components.some(re => re.test(c.name.trim())));

  if (ours.length > 0) {
    let state = "operational";
    for (const c of ours) {
      const s = COMPONENT_STATES[c.status];
      if (SEVERITY.indexOf(s) > SEVERITY.indexOf(state)) state = s;
    }
    const hit = ours.filter(c => c.status !== "operational");
    return {
      state,
      summary: state === "operational" ? null : incidentName(body, new Set(hit.map(c => c.id))),
      // Names, deduplicated — OpenAI's page lists two components as "Login",
      // and a page may list one twice in a group and out of it.
      components: [...new Set(hit.map(c => words(c.name)).filter(Boolean))],
      scope: "components",
      updatedAt,
    };
  }

  const indicator = body.status?.indicator;
  if (!own(PAGE_INDICATORS, indicator)) return null;
  const state = PAGE_INDICATORS[indicator];
  return {
    state,
    summary: state === "operational" ? null : words(body.status.description),
    components: [],
    scope: "page",
    updatedAt,
  };
}

/**
 * The title of the unfinished incident — or maintenance — that names one of
 * the affected components, when the page says which.
 *
 * Anthropic's page lists each incident's components; OpenAI's summary carries
 * no incidents at all, so its answer is the component names on their own.
 * An incident that names none of ours is not borrowed: a claude.ai outage's
 * title over a Claude Code line would be a diagnosis of the wrong thing.
 */
function incidentName(body, affected) {
  const open = [
    ...(Array.isArray(body.incidents) ? body.incidents : []),
    ...(Array.isArray(body.scheduled_maintenances) ? body.scheduled_maintenances : []),
  ].filter(i => i && !FINISHED.has(i.status));
  for (const i of open) {
    const named = Array.isArray(i.components) ? i.components : [];
    if (named.some(c => affected.has(c?.id))) return words(i.name);
  }
  return null;
}

/** GET a page's summary: a parsed body, or a thrown reason. */
async function fetchSummary(fetchImpl, url) {
  const res = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  if (Number(res.headers?.get?.("content-length")) > MAX_BODY_BYTES) throw new Error("body too large");
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("body too large");
  return JSON.parse(text);
}

/**
 * The cache and the reads behind GET /api/provider-status. A factory so a test
 * can hand in its own fetch and clock; the route uses the one instance below.
 */
export function createProviderStatus({ fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  /** provider → { reading, checkedAt, failedAt, inflight } */
  const held = new Map();

  function slot(provider) {
    let h = held.get(provider);
    if (!h) held.set(provider, h = { reading: null, checkedAt: 0, failedAt: 0, inflight: null });
    return h;
  }

  async function refresh(provider, h) {
    try {
      const reading = readSummary(provider, await fetchSummary(fetchImpl, PROVIDERS[provider].summaryUrl));
      if (!reading) throw new Error("not a status summary");
      h.reading = reading;
      h.checkedAt = now();
      h.failedAt = 0;
    } catch {
      h.failedAt = now();
    }
  }

  /** One provider's line, reading the page first when the answer is due. */
  async function read(provider) {
    const h = slot(provider);
    const t = now();
    const due = t - h.checkedAt >= FRESH_MS && t - h.failedAt >= RETRY_MS;
    if (due) {
      // Deduplicated: the page and the tray asking in the same second is one
      // request, not two.
      h.inflight ??= refresh(provider, h).finally(() => { h.inflight = null; });
      await h.inflight;
    }
    return view(provider, h, now());
  }

  return { read };
}

/**
 * What the route says about one provider.
 *
 * `checkedAt` is when the page last ANSWERED, never when it was last asked, so
 * an answer cannot look fresher than it is; `stale` says the latest ask got no
 * answer. Past EXPIRE_MS the reading is dropped rather than shown stale.
 */
export function view(provider, h, t) {
  const base = { provider, statusPageUrl: PROVIDERS[provider].pageUrl };
  const r = h?.reading;
  if (!r || t - h.checkedAt > EXPIRE_MS) {
    return { ...base, state: "unknown", summary: null, components: [], updatedAt: null, checkedAt: null, stale: false };
  }
  return {
    ...base,
    state: r.state,
    summary: r.summary,
    components: r.components,
    scope: r.scope,
    updatedAt: r.updatedAt,
    checkedAt: h.checkedAt,
    stale: h.failedAt > h.checkedAt,
  };
}

const shared = createProviderStatus();

/**
 * The answer for GET /api/provider-status: one line for each CLI the deck
 * watches, and none for the one it does not (#402) — a Codex-less deck has no
 * reason to ask OpenAI anything.
 */
export async function providerStatusReport({ providers, env = process.env, instance = shared } = {}) {
  if (statusChecksOff(env)) return { ok: true, disabled: true, providers: [] };
  const asked = Object.keys(PROVIDERS).filter(p => providers?.[p] !== false);
  return { ok: true, disabled: false, providers: await Promise.all(asked.map(p => instance.read(p))) };
}
