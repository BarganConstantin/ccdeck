// What the providers' status pages say, as the page draws it (#1311).
//
// The server reads the pages and answers GET /api/provider-status with one
// line per watched CLI — see src/server/provider-status.mjs for the reading and
// its cache. This file decides what, of that, is worth a mark on screen: only
// an incident, never "operational" and never "unknown". A provider that is fine
// draws nothing, and so does one whose page could not be reached, because an
// unreachable status page says nothing about the provider.
import { ownRow } from "./own-row";

export type ProviderState =
  | "operational" | "degraded" | "partial_outage" | "major_outage" | "maintenance" | "unknown";

/** One provider's line, as the route sends it. */
export interface ProviderStatus {
  provider: "claude" | "codex";
  state: ProviderState;
  /** The incident's own title, when the page named one for our components. */
  summary: string | null;
  /** The affected components, by the page's names. */
  components: string[];
  /** When the page last ANSWERED (epoch ms), null when it never has. */
  checkedAt: number | null;
  /** The latest ask got no answer: what is here is the last thing it said. */
  stale: boolean;
  statusPageUrl: string;
  /** "page" when the state is the page's overall status rather than a named
   *  component's — the server's fallback for a page whose components were
   *  renamed away. */
  scope?: "components" | "page";
}

export interface ProviderStatusReport {
  ok: boolean;
  /** AGENTS_DECK_NO_STATUS or AGENTS_DECK_NO_INSTALL is set. */
  disabled: boolean;
  providers: ProviderStatus[];
}

/** The states that are an incident, in words a chip can hold. */
const STATE_WORDS: Record<string, string> = {
  degraded: "degraded performance",
  partial_outage: "partial outage",
  major_outage: "major outage",
  maintenance: "maintenance",
};

/** The same states as the topbar chip says them, where every pixel is spent
 *  twice: "degraded performance" is the one that does not fit. */
const CHIP_WORDS: Record<string, string> = {
  degraded: "degraded",
  partial_outage: "partial outage",
  major_outage: "major outage",
  maintenance: "maintenance",
};

/** And in one word, for a bar with no room for two: the narrow breakpoint, or
 *  two chips at once. A mark with no word beside it was the alternative, and a
 *  hollow ring beside "Codex" read as Codex being offline. */
const SHORT_WORDS: Record<string, string> = {
  degraded: "degraded",
  partial_outage: "outage",
  major_outage: "outage",
  maintenance: "maint.",
};

const PROVIDER_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };

/** The two pages a link may go to. The route names the page, and this is the
 *  check that a link drawn from it opens a status page and nothing else. */
const STATUS_HOSTS = new Set(["status.claude.com", "status.openai.com"]);

/**
 * How old an answer may be before it is no answer. The server drops a reading
 * at the same age; this is the page's own copy of the rule, for the answer it
 * is still holding when the deck itself stops answering — a laptop that slept,
 * a deck that was stopped — which no server-side expiry can reach.
 */
export const INCIDENT_EXPIRE_MS = 30 * 60_000;

/**
 * How old an answer may be and still be drawn as current. The page asks every
 * three minutes and the server reads the page when it is asked, so an answer
 * this far past its reading has not been renewed — the deck is down, the tab
 * slept, or the tray stopped asking because nothing is running — and it is
 * drawn as what it is, the last thing the page said, dated. The server's own
 * `stale` covers the other way an answer ages: the page was asked and did not
 * answer.
 */
export const INCIDENT_STALE_MS = 10 * 60_000;

/** One incident, ready to draw. */
export interface Incident {
  provider: "claude" | "codex";
  state: Exclude<ProviderState, "operational" | "unknown">;
  /** "Claude" */
  name: string;
  /** "Claude · partial outage", or "Claude · partial outage · as of 14:05" when stale. */
  label: string;
  /** "partial outage", "degraded performance" */
  words: string;
  /** The chip's shorter form of `words`: "degraded" for degraded performance. */
  chipWords: string;
  /** One word, for a bar with no room: "outage", "degraded", "maint.". */
  shortWords: string;
  /** "14:05" when the answer is stale — the time it was last true — else null. */
  asOf: string | null;
  /** The incident's title, or failing that the affected components; null when the page gave neither. */
  what: string | null;
  /** The status page, https and one of the two hosts. */
  href: string;
  /** The host alone, for sentences: "status.claude.com". */
  host: string;
  stale: boolean;
  /** What the chip's title says: the incident, what it touches, how old it is. */
  detail: string;
}

/** A page URL the page is willing to open, or null. */
export function safeStatusPage(url: unknown): URL | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && STATUS_HOSTS.has(u.hostname) ? u : null;
  } catch { return null; }
}

/** "14:05", in the reader's own clock — and a 24-hour one, because "11:47 AM"
 *  is three characters more on a chip that has none to spare. */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** "just now", "4 min ago", "2 h ago". */
function age(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ago`;
}

/**
 * The incident one line reports, or null when it reports none worth drawing:
 * operational, unknown, a state this build has no words for, an answer past
 * INCIDENT_EXPIRE_MS, or a link to anywhere but a status page.
 */
export function incidentOf(s: ProviderStatus, now: number): Incident | null {
  if (!s || typeof s !== "object") return null;
  // Both asked of the tables' own rows: the words arrive over the wire.
  const words = ownRow(STATE_WORDS, s.state);
  const name = ownRow(PROVIDER_NAMES, s.provider);
  if (!words || !name) return null;
  if (typeof s.checkedAt !== "number" || now - s.checkedAt > INCIDENT_EXPIRE_MS) return null;
  const page = safeStatusPage(s.statusPageUrl);
  if (!page) return null;
  const components = Array.isArray(s.components) ? s.components : [];
  // Stale two ways: the page was asked and did not answer (the server's flag),
  // or nobody has asked since — see INCIDENT_STALE_MS.
  const stale = s.stale === true || now - s.checkedAt > INCIDENT_STALE_MS;
  const lines = [
    `${name}: ${words}${s.summary ? ` — ${s.summary}` : ""}`,
    components.length > 0 ? `Affected: ${components.join(", ")}` : null,
    s.scope === "page" ? `The page's overall status: it names none of ${name}'s components` : null,
    // Said in words, because a stale incident is still drawn: it is the last
    // thing the page said, and the reader should know that is all it is.
    stale
      ? `Last read from ${page.hostname} at ${clock(s.checkedAt)}; this is the last thing it said`
      : `Reported by ${page.hostname}, checked ${age(now - s.checkedAt)}`,
    "Opens the status page",
  ];
  const asOf = stale ? clock(s.checkedAt) : null;
  return {
    provider: s.provider,
    state: s.state as Incident["state"],
    name,
    label: `${name} · ${words}${asOf ? ` · as of ${asOf}` : ""}`,
    words,
    chipWords: ownRow(CHIP_WORDS, s.state) ?? words,
    shortWords: ownRow(SHORT_WORDS, s.state) ?? words,
    asOf,
    what: s.summary || (components.length > 0 ? components.join(", ") : null),
    href: page.href,
    host: page.hostname,
    stale,
    detail: lines.filter(Boolean).join("\n"),
  };
}

/** Every incident in a report, Claude first — the route's own order. */
export function incidentsOf(report: ProviderStatusReport | null, now: number): Incident[] {
  if (!report?.ok || report.disabled || !Array.isArray(report.providers)) return [];
  return report.providers.map(p => incidentOf(p, now)).filter((i): i is Incident => i !== null);
}

/**
 * What the deck says aloud about incidents (#1311): one sentence naming each
 * provider in one and its state, or "" for none. Keyed on the state and never
 * on the age, so a report going stale is not news, and fed through the same
 * reducer the blocked-session announcement uses (nextAnnouncement), which is
 * what makes the end of an incident a sentence too.
 */
export function incidentSentence(incidents: readonly Incident[]): string {
  // "a partial outage", but "degraded performance" and "maintenance".
  return incidents.map(i => `${i.name}'s status page reports ${i.state.endsWith("outage") ? `a ${i.words}` : i.words}.`).join(" ");
}

/** The sentence after the last incident clears. */
export const INCIDENTS_CLEAR = "The providers' status pages report no incident.";
