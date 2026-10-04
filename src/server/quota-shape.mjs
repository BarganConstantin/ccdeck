// What each of quota.mjs's three sources answers, in the shape the panel
// speaks.
//
// A claude-swap row, an OAuth usage body and the text `claude --print /usage`
// prints go in; the same `{ session5hPct, week7dPct, … }` comes out, whichever
// of the three it was. Nothing here reads a file, asks the network or holds
// anything between calls, and that is why it is a module of its own: quota.mjs
// decides which source to ask and when, which is state and budget, while a
// wrong number on the panel comes from one of these mappings — and a test can
// hand one a body without driving the chain that fetched it.
import { resetLabelIso } from "./reset-label.mjs";
import { resetCreditsFrom } from "./claude-reset-credits.mjs";
// One ANSI stripper for the whole deck. The private copy that used to live
// here accepted only the BEL terminator for an OSC sequence, while term.mjs's
// also accepts ESC \\ — so a hyperlink written the other legal way survived
// into text this module then parsed for quota lines.
import { stripAnsi } from "./term.mjs";

// The two windows' lengths. Every reading carries them, whichever source it
// came from — including the CLI's, which prints no length at all, and the
// zero reading quota.mjs publishes for a window that has just reset.
export const WIN_5H_SEC  = 18000;
export const WIN_7D_SEC  = 604800;

/**
 * A reported utilisation as the whole percentage the panel draws: rounded, and
 * held inside 0–100 whatever the source said.
 *
 * The OAuth body and the claude-swap row each carried this as a private arrow
 * inside their mapping, the same one character for character. One rule written
 * twice is a rule that can drift, and a clamp is where a drift prints 140% on
 * a bar. The CLI's parse is not a third copy: it reads at most three digits
 * off a line, so there is nothing below zero or between integers to handle.
 *
 * Exported for its test.
 */
export function clampPct(v) {
  return Math.min(100, Math.max(0, Math.round(v)));
}

// ISO-8601 → "Jun 19, 1:19pm" (local time, matching the CLI display format).
//
// The body moved to reset-label.mjs in #374: codex-quota.mjs had a copy that
// claimed in its own comment to match this one and did not, so the Codex lanes
// and the Claude lanes printed the same instant two different ways in the same
// panel. This rendering is the one both surfaces use now. The alias stays so
// the four call sites below read the way they always have.
const fmtResetIso = resetLabelIso;

function isoToSec(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return isNaN(t) ? null : Math.floor(t / 1000);
}

// Map the OAuth usage JSON to our quota result shape.
// utilization is already a 0–100 percentage. 5h falls back to 7d if absent.
//
// A 7d window that is absent is UNKNOWN, and published as null (#1627). The
// endpoint can send `seven_day: null`, and this used to fill in a zero there —
// which the bar prints as "< 1%", a week nobody measured and a reader takes as
// almost all of it left. The same kind of zero #765 removed; the CLI's parse
// below already leaves the field out for a week line it did not see.
export function mapOAuthUsage(data) {
  const fh = data?.five_hour;
  const sd = data?.seven_day;
  const son = data?.seven_day_sonnet;
  const opus = data?.seven_day_opus;

  const primary = (fh?.utilization != null) ? fh : sd;
  if (!primary || primary.utilization == null) return null;

  const result = {
    session5hPct:       clampPct(primary.utilization),
    session5hWindowSec: WIN_5H_SEC,
    session5hReset:     fmtResetIso(primary.resets_at),
    session5hResetAt:   isoToSec(primary.resets_at),
    week7dWindowSec:    WIN_7D_SEC,
  };
  if (sd?.utilization != null) {
    result.week7dPct     = clampPct(sd.utilization);
    result.week7dReset   = fmtResetIso(sd.resets_at);
    result.week7dResetAt = isoToSec(sd.resets_at);
  } else {
    result.week7dPct = null;
  }
  if (son?.utilization != null)  result.weekSonnetPct = clampPct(son.utilization);
  if (opus?.utilization != null) result.weekOpusPct   = clampPct(opus.utilization);

  // extra usage credits (pay-as-you-go top-up), if enabled
  const extra = data?.extra_usage;
  if (extra?.is_enabled) {
    result.extraEnabled = true;
    if (extra.used_credits != null)  result.extraUsedCredits  = extra.used_credits;
    if (extra.monthly_limit != null) result.extraMonthlyLimit = extra.monthly_limit;
    if (extra.currency)              result.extraCurrency     = extra.currency;
  }

  // Saved limit resets, from the same response and so from the same account as
  // the windows above. Absent rather than null when the block says nothing
  // readable, so a response without one maps exactly as it always has.
  const credits = resetCreditsFrom(data?.cedar_ember, Date.now());
  if (credits) result.resetCredits = credits;
  return result;
}

/**
 * claude-swap's row for the active account, in the shape the panel speaks.
 *
 * Exported for quota.mjs, which reads the store through it, and pinned by
 * tests: the mapping is where a wrong number would come from, and it is pure.
 */
export function quotaFromStore(entry) {
  const good = entry?.lastGood;
  const fh = good?.five_hour;
  const sd = good?.seven_day;
  const primary = (typeof fh?.pct === "number") ? fh : sd;
  if (typeof primary?.pct !== "number") return null;

  const out = {
    ok: true,
    source: "claude-swap",
    session5hPct:       clampPct(primary.pct),
    session5hWindowSec: WIN_5H_SEC,
    session5hReset:     fmtResetIso(primary.resets_at),
    session5hResetAt:   isoToSec(primary.resets_at),
    week7dWindowSec:    WIN_7D_SEC,
    // Unknown rather than 0 when the row has no 7d window, as mapOAuthUsage
    // publishes it (#1627): claude-swap writes no `seven_day` at all when the
    // endpoint sent none.
    week7dPct:          typeof sd?.pct === "number" ? clampPct(sd.pct) : null,
    week7dReset:        fmtResetIso(sd?.resets_at),
    week7dResetAt:      isoToSec(sd?.resets_at),
    // The age of the DATA, not of our read of it. The panel prints this, and
    // "30s ago" over numbers claude-swap collected twenty minutes back is the
    // kind of true-looking lie this whole change exists to remove.
    fetchedAt: entry.fetchedAt,
  };
  // claude-swap keeps per-model windows in a named list rather than fixed
  // fields, because which ones an account has depends on its plan.
  for (const s of Array.isArray(good.scoped) ? good.scoped : []) {
    if (typeof s?.pct !== "number") continue;
    if (/sonnet/i.test(s.name ?? "")) out.weekSonnetPct = clampPct(s.pct);
    else if (/opus/i.test(s.name ?? "")) out.weekOpusPct = clampPct(s.pct);
  }
  return out;
}

/**
 * Whether a window this reading measured has reset since it was taken: its
 * reset instant is at or before `now`, so the percentage beside it belongs to a
 * window that is over, and a new one has started near empty.
 *
 * Both windows, because both end: a reading from before a weekly reset is as
 * wrong about the week as one from before a 5-hour reset is about the session.
 * A window with no reset instant cannot be said to have passed it.
 */
export function readingLapsed(reading, now) {
  const past = (at) => typeof at === "number" && at * 1000 <= now;
  return past(reading?.session5hResetAt) || past(reading?.week7dResetAt);
}

// Parse "Jun 18, 4:09pm" (local time, no tz) into unix seconds.
// Claude shows times in the user's local timezone, so parsing as local is correct.
// `now` is injectable so the year-boundary case is testable.
export function parseResetToSec(resetStr, now = Date.now()) {
  if (!resetStr) return null;
  try {
    // "4:09pm" → "4:09 PM" so Date.parse handles it. Minutes are optional in
    // the CLI's output ("9am"); Date.parse rejects "9 AM", so supply ":00".
    const norm = resetStr
      .replace(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i,
               (_all, h, mm, ampm) => `${h}:${mm ?? "00"} ${ampm}`)
      .trim();
    // The CLI prints no year, so we have to supply one. Stamping the current
    // year blindly puts a "Jan 2" reset read on Dec 30 eleven months in the
    // past, which hides the countdown and pins the pace marker at 100%. A
    // reset is never more than a week away, so the neighbouring year that
    // lands nearest to `now` is the one Claude meant.
    const thisYear = new Date(now).getFullYear();
    let best = null;
    for (const year of [thisYear - 1, thisYear, thisYear + 1]) {
      const t = new Date(`${norm} ${year}`).getTime();
      if (isNaN(t)) continue;
      if (best === null || Math.abs(t - now) < Math.abs(best - now)) best = t;
    }
    return best === null ? null : Math.floor(best / 1000);
  } catch { return null; }
}

/**
 * Parse `claude --print /usage` output.
 *
 * Observed format (Claude Code ≥ 1.x):
 *   "Current session: 84% used · resets Jun 18, 4:09pm (Europe/Chisinau)"
 *   "Current week (all models): 85% used · resets Jun 21, 8:59am (Europe/Chisinau)"
 *   "Current week (Sonnet only): 48% used · resets Jun 21, 9am (Europe/Chisinau)"
 *   "Current week (Opus only): ..."   (if present)
 */
export function parseUsageText(raw) {
  const text = stripAnsi(raw);
  const result = {};

  // Helper: find "X% used · resets <rest>" on a line matching a label.
  const extract = (labelRe) => {
    const line = text.split("\n").find(l => labelRe.test(l));
    if (!line) return null;
    const pctM = line.match(/(\d{1,3})\s*%/);
    const resetM = line.match(/resets\s+(.+)/i);
    const resetFull = resetM
      ? resetM[1].replace(/\(.*?\)/g, "").replace(/·/g, "").trim()
      : null;
    return {
      pct:     pctM ? Math.min(100, parseInt(pctM[1], 10)) : null,
      reset:   resetFull,
      resetAt: parseResetToSec(resetFull),
    };
  };

  const session = extract(/current session/i);
  if (session?.pct != null) {
    result.session5hPct       = session.pct;
    result.session5hWindowSec = WIN_5H_SEC;
    if (session.reset)   result.session5hReset   = session.reset;
    if (session.resetAt) result.session5hResetAt  = session.resetAt;
  }

  const weekAll = extract(/current week\s*\(all models\)/i) || extract(/current week\s*[:·]/i);
  if (weekAll?.pct != null) {
    result.week7dPct       = weekAll.pct;
    result.week7dWindowSec = WIN_7D_SEC;
    if (weekAll.reset)   result.week7dReset   = weekAll.reset;
    if (weekAll.resetAt) result.week7dResetAt  = weekAll.resetAt;
  }

  const weekSon = extract(/current week\s*\(sonnet/i);
  if (weekSon?.pct != null) result.weekSonnetPct = weekSon.pct;

  const weekOpus = extract(/current week\s*\(opus/i);
  if (weekOpus?.pct != null) result.weekOpusPct = weekOpus.pct;

  return Object.keys(result).length > 0 ? result : null;
}
