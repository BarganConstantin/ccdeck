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
import { t as translateNow, type TFunction } from "./i18n";

/** The content flags by the words a person would use for them. */
const CONTENT_WORDS: Record<string, string> = {
  OTEL_LOG_USER_PROMPTS: "radar.org.word.prompts",
  OTEL_LOG_ASSISTANT_RESPONSES: "radar.org.word.responses",
  OTEL_LOG_TOOL_DETAILS: "radar.org.word.toolDetails",
  OTEL_LOG_TOOL_CONTENT: "radar.org.word.toolContent",
  OTEL_LOG_RAW_API_BODIES: "radar.org.word.apiBodies",
};

/** The words for a content flag; a flag with no word of its own reads as its name. */
function wordFor(key: string, tr: TFunction): string {
  const id = CONTENT_WORDS[key];
  return id ? tr(id) : key;
}

/** "a, b and c" in the language on show. */
function listed(words: string[], tr: TFunction): string {
  return words.length <= 1 ? words.join("") : tr("radar.org.and", { list: words.slice(0, -1).join(tr("radar.org.sep")), last: words[words.length - 1] });
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
 * be kept off it. `tr` is the caller's t(); without it the language on show is read.
 */
export function telemetryLine(t: OrgTelemetry | null | undefined, nowSec: number, { holdOut = false, tr = translateNow }: { holdOut?: boolean; tr?: TFunction } = {}): TelemetryLine | null {
  if (!t || (t.level !== "metrics" && t.level !== "content")) return null;
  const words = t.level === "content"
    ? t.content.map(k => wordFor(k, tr))
    : [];
  const who = t.orgName ? t.orgName : tr("radar.org.who");
  const what = words.length ? tr("radar.org.whatContent", { words: listed(words, tr) }) : tr("radar.org.usageData");
  const where = t.destinations.length ? listed(t.destinations, tr) : tr("radar.org.collector");
  return {
    text: tr("radar.org.line", { words: words.length ? words.join(tr("radar.org.sep")) : tr("radar.org.usageData") }),
    tone: words.length ? "warn" : "quiet",
    detail: tr("radar.org.detail", { who, what, where, ago: ago(t.seenAt, nowSec) }) + (holdOut ? tr("radar.org.holdOut") : ""),
  };
}

/**
 * The sentence the row's "Now active" note adds after a switch somebody
 * pressed: what the account just made active turns on for the sessions that
 * start from now. Null when nothing is known to be on.
 */
export function switchedTelemetry(t: OrgTelemetry | null | undefined, tr: TFunction = translateNow): string | null {
  if (!t || (t.level !== "metrics" && t.level !== "content")) return null;
  const words = t.level === "content" ? t.content.map(k => wordFor(k, tr)) : [];
  const what = words.length ? tr("radar.org.switchedWhat", { words: listed(words, tr) }) : tr("radar.org.usageData");
  const who = t.orgName ? tr("radar.org.named", { org: t.orgName }) : tr("radar.org.whoPossessive");
  const where = t.destinations.length ? tr("radar.org.switchedTo", { list: listed(t.destinations, tr) }) : "";
  return tr("radar.org.switched", { who, what, where });
}
