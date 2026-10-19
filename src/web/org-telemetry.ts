// The line an account row says about its organization's telemetry.
//
// A Team or Enterprise organization can turn Claude Code's OpenTelemetry export
// on for its members, and Claude Code applies it without asking in the VS Code
// panel, the desktop app and `claude -p`. The row says it before anyone
// switches to the account, from what the deck last saw of that organization's
// settings (org-telemetry.mjs): a word for what goes out on the row, and the
// whole sentence — who, what, where to, how long ago — for whoever asks.
//
// Nothing is said for an organization whose settings were seen with telemetry
// off, nor for one never seen: the deck does not know, and an absent line must
// not read as a promise either way. The tooltip of a line that IS shown says
// how old the reading is, because settings change.
import { ago } from "./account-freshness";
import { type OrgTelemetry } from "./claude-accounts";

/** The content flags by the words a person would use for them. */
const CONTENT_WORDS: Record<string, string> = {
  OTEL_LOG_USER_PROMPTS: "prompts",
  OTEL_LOG_ASSISTANT_RESPONSES: "responses",
  OTEL_LOG_TOOL_DETAILS: "tool details",
  OTEL_LOG_TOOL_CONTENT: "tool output",
  OTEL_LOG_RAW_API_BODIES: "full API bodies",
};

/** "a, b and c". */
function listed(words: string[]): string {
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export interface TelemetryLine {
  /** What the row shows: "Telemetry · prompts, tool details". */
  text: string;
  /** The warning ink once content goes out; quiet for usage data alone. */
  tone: "warn" | "quiet";
  /** The whole sentence, for the title and for a screen reader. */
  detail: string;
}

/**
 * `holdOut`: the row offers "Hold out of rotation" in its ⋯ menu (an inactive
 * account, while something rotates), so the sentence says where Auto-switch can
 * be kept off it.
 */
export function telemetryLine(t: OrgTelemetry | null | undefined, nowSec: number, { holdOut = false } = {}): TelemetryLine | null {
  if (!t || (t.level !== "metrics" && t.level !== "content")) return null;
  const words = t.level === "content"
    ? t.content.map(k => CONTENT_WORDS[k] ?? k)
    : [];
  const who = t.orgName ? t.orgName : "This account's organization";
  const what = words.length ? `usage data, and your ${listed(words)}` : "usage data";
  const where = t.destinations.length ? listed(t.destinations) : "its collector";
  return {
    text: `Telemetry · ${words.length ? words.join(", ") : "usage data"}`,
    tone: words.length ? "warn" : "quiet",
    detail: `${who} turns on Claude Code telemetry for new sessions: ${what}, sent to ${where}. `
      + `Seen ${ago(t.seenAt, nowSec)}, while this account was active.`
      + (holdOut ? " To keep Auto-switch off it, choose Hold out of rotation in its ⋯ menu." : ""),
  };
}

/**
 * The sentence the row's "Now active" note adds after a switch somebody
 * pressed: what the account just made active turns on for the sessions that
 * start from now. Null when nothing is known to be on.
 */
export function switchedTelemetry(t: OrgTelemetry | null | undefined): string | null {
  if (!t || (t.level !== "metrics" && t.level !== "content")) return null;
  const words = t.level === "content" ? t.content.map(k => CONTENT_WORDS[k] ?? k) : [];
  const what = words.length ? `your ${listed(words)}` : "usage data";
  const who = t.orgName ? `${t.orgName}'s telemetry` : "Its organization's telemetry";
  const where = t.destinations.length ? ` to ${listed(t.destinations)}` : "";
  return `${who} is on for them: it sends ${what}${where}.`;
}
