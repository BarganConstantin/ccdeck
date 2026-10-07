// The dates the git view's Fork look writes, in Fork's own words: the history
// column says `Today at 09:38`, `Yesterday at 22:22`, and for anything older
// the day in the reader's own date order, `18 Sep 2026 at 12:53`; a commit's
// strip says the absolute form always; its Commit tab says the long form with
// seconds and the zone, `5 October 2026 at 16:50:54 GMT+3`.
//
// Day boundaries are the reader's local midnight. `locale` is for tests; the
// page passes nothing and gets the browser's.

const formats = new Map<string, Intl.DateTimeFormat>();
function format(locale: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ""}\u0000${JSON.stringify(opts)}`;
  let f = formats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts);
    formats.set(key, f);
  }
  return f;
}

const DAY_MS = 86_400_000;
/** Local midnight of the day `ms` falls on. */
const dayStart = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** A git date, or null when it does not parse. */
function parse(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** `18 Sep 2026 at 12:53`, the day in the locale's medium order. */
export function forkDateAbsolute(iso: string, locale?: string): string {
  const ms = parse(iso);
  if (ms === null) return "";
  return `${format(locale, { dateStyle: "medium" }).format(ms)} at ${format(locale, { timeStyle: "short" }).format(ms)}`;
}

/** The history column: `Today at 09:38`, `Yesterday at 22:22`, else the
 *  absolute form. A date in the future (a clock ahead of this one) reads as
 *  the absolute form too, never as a day that has not come. */
export function forkDate(iso: string, now: number, locale?: string): string {
  const ms = parse(iso);
  if (ms === null) return "";
  const time = format(locale, { timeStyle: "short" }).format(ms);
  const today = dayStart(now);
  const day = dayStart(ms);
  if (day === today && ms <= now + 60_000) return `Today at ${time}`;
  // One calendar day back, whatever a daylight-saving change made it last.
  if (day === dayStart(today - DAY_MS / 2)) return `Yesterday at ${time}`;
  return forkDateAbsolute(iso, locale);
}

/** The Commit tab's: `5 October 2026 at 16:50:54 GMT+3`. */
export function forkDateLong(iso: string, locale?: string): string {
  const ms = parse(iso);
  if (ms === null) return "";
  return `${format(locale, { dateStyle: "long" }).format(ms)} at ${format(locale, { timeStyle: "long" }).format(ms)}`;
}
