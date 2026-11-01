import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { ClockGlyph } from "./rail-glyphs";
import type { Account } from "../claude-accounts";
import { resetCalendar, type ResetEntry, type ResetDay, type UnscheduledReset } from "../account-reset-calendar";
import { shownUsed, usageReport, type ReportRow } from "../accounts-usage-report";
import { resetCountdown } from "../relative-time";
import { currentLanguage, useT, type TFunction } from "../i18n";

// Dates and times follow the language chosen in Settings, not the browser's.
const weekday = (date: Date) => date.toLocaleDateString(currentLanguage(), { weekday: "short" });
const dayLabel = (date: Date) => date.toLocaleDateString(currentLanguage(), { month: "short", day: "numeric" });
const fullDate = (date: Date) => date.toLocaleDateString(currentLanguage(), { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const timeUntil = (at: number, nowSec: number, t: TFunction) => at - nowSec < 60 ? t("accounts.cal.lessThanMin") : resetCountdown(at, nowSec) ?? "";

function ResetTime({ at }: { at: number }) {
  const date = new Date(at * 1000);
  return <time className="ap-reset-time" dateTime={date.toISOString()} title={`${date.toLocaleString(currentLanguage(), { timeZoneName: "shortOffset" })} · ${date.toISOString()} (UTC)`}>
    {date.toLocaleTimeString(currentLanguage(), { hour: "numeric", minute: "2-digit" })}
  </time>;
}

function AccountName({ entry }: { entry: ResetEntry }) {
  const t = useT();
  return <span className="ap-reset-name">
    <span>{entry.name}</span>
    {entry.active && <span className="ap-report-current">{t("accounts.current")}</span>}
    {entry.heldOut && <span className="ap-report-tag">{t("accounts.heldOut")}</span>}
  </span>;
}

function AccountDetails({ entry, row, nowSec, withReading = false, older = false, context }: { entry: ResetEntry; row?: ReportRow; nowSec: number; withReading?: boolean; older?: boolean; context?: ReactNode }) {
  const t = useT();
  return <details className="ap-reset-account">
    <summary>{context ? <span className="ap-reset-summary-other"><AccountName entry={entry} />{context}</span> : withReading ? <span className="ap-reset-summary-content"><AccountName entry={entry} /><Reading entry={entry} older={older} /></span> : <AccountName entry={entry} />}<span className="vis-hidden">{t("accounts.cal.detailsSr")}</span></summary>
    <div className="ap-reset-account-body">
      {row && (["five_hour", "seven_day"] as const).map(id => {
        const cell = row.cells[id];
        const pct = cell.counted ? cell.pct : cell.last;
        const at = row.resets[id];
        return <p key={id}><strong>{t(`accounts.win.${id}`)}</strong>
          <span>{pct == null ? t("accounts.cal.noUsage") : t(entry.stale || !cell.counted ? "accounts.cal.usedLast" : "accounts.cal.used", { pct: shownUsed(pct) })}</span>
          <span>{at == null ? t("accounts.cal.resetUnknown") : at <= nowSec ? t("accounts.cal.timePassed") : <>{entry.stale ? t("accounts.cal.lastReportedReset") : t("accounts.cal.resetIn", { time: timeUntil(at, nowSec, t) })} · <ResetTime at={at} /></>}</span>
        </p>;
      })}
      <p>{entry.heldOut ? t("accounts.cal.excludedRotation") : t("accounts.cal.fiveHourStays")}</p>
    </div>
  </details>;
}

function Reading({ entry, past = false, older = false }: { entry: ResetEntry; past?: boolean; older?: boolean }) {
  const t = useT();
  return <span className="ap-reset-reading" data-level={entry.stale || past ? "older" : entry.used != null && entry.used >= 70 ? "limited" : undefined}>
    <span className="ap-reset-usage">{entry.used == null ? t("accounts.cal.usageUnavailable")
      : t(entry.stale || past ? "accounts.cal.usedLast" : "accounts.cal.used", { pct: shownUsed(entry.used) })}</span>
    {entry.used != null && !entry.stale && !past && <span className="ap-reset-meter" data-level={entry.used >= 90 ? "hi" : entry.used >= 70 ? "mid" : undefined} aria-hidden="true">
      <span style={{ "--reset-used": Math.min(100, Math.max(0, entry.used)) / 100 } as CSSProperties} />
    </span>}
    {entry.stale && <span className="ap-reset-old">{!older && t("accounts.cal.needsFresh")}{entry.note}</span>}
  </span>;
}

function Unscheduled({ entry, row, nowSec }: { entry: UnscheduledReset; row?: ReportRow; nowSec: number }) {
  const t = useT();
  const reason = entry.reason === "unknown" ? t("accounts.cal.resetUnknown")
    : entry.reason === "passed" ? t("accounts.cal.timePassed") : t("accounts.cal.beyond");
  return <li className="ap-reset-unplaced-row">
    <AccountDetails entry={entry} row={row} nowSec={nowSec} context={<>
      <span className="ap-reset-unplaced-detail">
        <span>{reason}</span>
        {entry.at != null && <span>{dayLabel(new Date(entry.at * 1000))} · <ResetTime at={entry.at} /></span>}
      </span>
      <Reading entry={entry} past={entry.reason === "passed"} />
    </>} />
  </li>;
}

function Agenda({ days, rows, nowSec, outdated = false }: { days: ResetDay[]; rows: Map<string, ReportRow>; nowSec: number; outdated?: boolean }) {
  const t = useT();
  return <div className="ap-reset-agenda">
    {days.map(day => {
      const entries = day.entries.filter(entry => entry.stale === outdated);
      if (!entries.length) return null;
      return <section className="ap-reset-day" key={day.key} aria-label={fullDate(day.date)}>
        <h4 className="vis-hidden">{t("accounts.cal.dayAccounts", { date: fullDate(day.date), count: entries.length })}</h4>
        <ul>{Array.from(new Set(entries.map(entry => entry.at))).map((at, index) => <li className="ap-reset-event" key={at}>
          <div className="ap-reset-when" data-outdated={outdated ? "" : undefined}>{outdated && <span className="ap-reset-last-reported">{t("accounts.cal.lastReported")}</span>}{index === 0 && <time className="ap-reset-day-label" dateTime={day.key}>{weekday(day.date)} · {dayLabel(day.date)}</time>}<ResetTime at={at!} />{!outdated && <span>{t("accounts.cal.inTime", { time: timeUntil(at!, nowSec, t) })}</span>}</div>
          <ul>{entries.filter(entry => entry.at === at).map(entry => <li className="ap-reset-entry" key={entry.key} data-outdated={entry.stale ? "" : undefined}>
            <AccountDetails entry={entry} row={rows.get(entry.key)} nowSec={nowSec} withReading older={outdated} />
          </li>)}</ul>
        </li>)}</ul>
      </section>;
    })}
  </div>;
}

/** Reported weekly resets, sharing the report's roster and existing clock.
 * Selection is owned by the dialog so view changes retain the chosen day. */
export type ResetScope = "upcoming" | "older" | "other";

export default function AccountResetCalendar({ accounts, nowSec, held, selectedDate = null, onSelect = () => {}, scope = "upcoming", onScope = () => {} }: {
  accounts: readonly Account[];
  nowSec: number;
  held: string | null;
  selectedDate?: string | null;
  onSelect?: (date: string | null) => void;
  scope?: ResetScope;
  onScope?: (scope: ResetScope) => void;
}) {
  const t = useT();
  const { days, unscheduled } = resetCalendar(accounts, nowSec, held != null, t);
  const selected = days.find(day => day.key === selectedDate) ?? null;
  const visibleDays = selected ? [selected] : days;
  const scheduled = days.reduce((sum, day) => sum + day.scheduled, 0);
  const outdated = visibleDays.reduce((sum, day) => sum + day.outdated, 0);
  const allOutdated = days.reduce((sum, day) => sum + day.outdated, 0);
  const shownCount = selected ? selected.scheduled : scheduled;
  const next = days.flatMap(day => day.entries).find(entry => !entry.stale);
  const simultaneous = next ? days.flatMap(day => day.entries).filter(entry => !entry.stale && entry.at === next.at) : [];
  const resultsRef = useRef<HTMLDivElement>(null);
  const calendarRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef<HTMLElement | null>(null);
  // A clock tick can move the focused account out of this category. Restore
  // a predictable starting point only when its control actually disappeared.
  useEffect(() => {
    const focused = focusedRef.current;
    if (focused && !focused.isConnected && document.activeElement === document.body) {
      calendarRef.current?.querySelector<HTMLButtonElement>('.ap-reset-coverage-link[aria-pressed="true"]')?.focus({ preventScroll: true });
    }
  });
  const returnToStart = () => { if (resultsRef.current) resultsRef.current.scrollTop = 0; };
  const inspectCoverage = (target: ResetScope) => {
    returnToStart();
    onSelect(null);
    onScope(target);
  };
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rows = new Map(usageReport(accounts, nowSec, t).rows.map(row => [row.key, row]));
  return <div ref={calendarRef} onFocusCapture={event => { focusedRef.current = event.target as HTMLElement; }} className="ap-proj-body ap-report-body ap-reset-body" role="region" aria-label={t("accounts.cal.regionLabel")}>
    {held && <p className="ap-report-held">{held}</p>}
    <div className="ap-reset-overview"><div className="ap-reset-command">
    <section className="ap-reset-next" aria-label={t("accounts.cal.nextLabel")}>
      {next ? <>
        <div className="ap-reset-next-identity"><h3><ClockGlyph />{t("accounts.cal.nextReported")} <span className="ap-reset-global">{t("accounts.cal.allDays")}</span></h3>
          {simultaneous.length > 1 ? <span className="ap-reset-name">{t("accounts.cal.nAccounts", { count: simultaneous.length })}</span> : <details className="ap-reset-next-account"><summary title={next.name}><AccountName entry={next} /><span className="vis-hidden">{t("accounts.cal.fullNameSr")}</span></summary><p className="ap-reset-full-name">{next.name}</p></details>}
          <p>{weekday(new Date(next.at! * 1000))}, {dayLabel(new Date(next.at! * 1000))} · <ResetTime at={next.at!} /></p><p className="ap-reset-next-note">{simultaneous.length > 1 ? t("accounts.cal.nextNoteMany") : next.used != null ? t("accounts.cal.nextNoteUsed", { pct: shownUsed(next.used) }) : t("accounts.cal.nextNote")}</p></div>
        <p className="ap-reset-countdown"><strong>{timeUntil(next.at!, nowSec, t)}</strong><span><span className="vis-hidden">{t("accounts.cal.untilSr")}</span>{t("accounts.cal.reportedReset")}</span></p>
      </> : <div className="ap-reset-next-identity"><h3>{t("accounts.cal.noUpcoming")}</h3><p>{allOutdated ? t("accounts.cal.someNeedFresh") : t("accounts.cal.noneInSeven")}</p></div>}
    </section>
    <div className="ap-reset-coverage" role="group" aria-label={t("accounts.cal.scheduleData")}>
      <button type="button" className="ap-reset-coverage-link" data-scope="upcoming" aria-pressed={scope === "upcoming"} onClick={() => inspectCoverage("upcoming")}><b>{scheduled}</b><span>{t("accounts.cal.upcoming")}<span>{t("accounts.cal.recentReadings")}</span></span></button>
      <button type="button" className="ap-reset-coverage-link" title={t("accounts.cal.needsFreshTitle")} data-scope="older" data-attention={allOutdated > 0 ? "" : undefined} aria-pressed={scope === "older"} onClick={() => inspectCoverage("older")}><b>{allOutdated}</b><span>{t("accounts.cal.needsFreshData")}<span>{t("accounts.cal.thisWeekExcluded")}</span></span></button>
      <button type="button" className="ap-reset-coverage-link" data-scope="other" aria-pressed={scope === "other"} onClick={() => inspectCoverage("other")}><b>{unscheduled.length}</b><span>{t("accounts.cal.otherTimes")}<span>{t("accounts.cal.unknownElapsed")}</span></span></button>
    </div></div>
    <section className="ap-reset-navigation" aria-label={t("accounts.cal.chooseDay")}>
      <div className="ap-reset-intro"><h3>{t("accounts.cal.next7")} <span>{t("accounts.cal.weeklyResets", { count: scheduled })}</span></h3><p>{zone}</p></div>
      <ol className="ap-reset-week" role="list" aria-label={t("accounts.cal.sevenCounts")}>
        {days.map((day, i) => <li key={day.key} data-today={i === 0 ? "" : undefined}>
          <button type="button" className="ap-reset-day-button" aria-current={i === 0 ? "date" : undefined} data-active={day.scheduled > 0 ? "" : undefined} aria-pressed={selected?.key === day.key}
            aria-label={`${t("accounts.cal.dayLabel", { date: fullDate(day.date), count: day.scheduled })}${day.outdated ? t("accounts.cal.needUpdating", { count: day.outdated }) : ""}`}
            onClick={() => { returnToStart(); onScope("upcoming"); onSelect(selected?.key === day.key ? null : day.key); }}>
            <time dateTime={day.key} title={fullDate(day.date)}><span className="ap-reset-weekday">{i === 0 ? t("accounts.cal.today") : weekday(day.date)}</span><span className="ap-reset-date">{day.date.getDate()}</span></time>
            <span className="ap-reset-count"><b>{day.scheduled || "—"}</b><span>{t("accounts.cal.resetWord", { count: day.scheduled })}</span></span>
          </button>
        </li>)}
      </ol>
    </section></div>
    <div ref={resultsRef} className="ap-reset-results">
    <section className="ap-reset-scheduled" hidden={scope !== "upcoming"} aria-label={t("accounts.cal.scheduledLabel")}>
      <div className="ap-reset-list-head">
        <h3>{selected ? `${weekday(selected.date)}, ${dayLabel(selected.date)}` : t("accounts.cal.allUpcoming")} <span>{shownCount}</span></h3>
        <button className="btn" type="button" aria-pressed={!selected} onClick={() => { returnToStart(); onSelect(null); }}>{t("accounts.cal.allDaysBtn")}</button>
      </div>
      <p className="ap-reset-hint" role="status">{selected ? t("accounts.cal.showingOnly", { date: fullDate(selected.date) }) : t("accounts.cal.allDaysHint")}</p>
      {shownCount > 0 ? <Agenda days={visibleDays} rows={rows} nowSec={nowSec} />
        : <p className="ap-reset-empty">{selected ? t("accounts.cal.noResetsDay") : t("accounts.cal.scheduleUpdates")}</p>}
    </section>
    <section className="ap-reset-disclosure" hidden={scope !== "older"} aria-label={t("accounts.cal.needingLabel")}>
      <h3>{t("accounts.cal.needsFreshHead")} <span>{t("accounts.cal.excludedCounts", { count: outdated })}</span></h3>
      <p className="ap-reset-explain">{t("accounts.cal.staleExplain")}</p>
      {outdated > 0 ? <Agenda days={visibleDays} rows={rows} nowSec={nowSec} outdated /> : <p className="ap-reset-empty">{t("accounts.cal.noOlder")}</p>}
    </section>
    <section className="ap-reset-disclosure ap-reset-unplaced" hidden={scope !== "other"} aria-label={t("accounts.cal.otherTimes")}>
      <h3>{t("accounts.cal.otherTimes")} <span>{t("accounts.cal.otherCount", { count: unscheduled.length })}</span></h3>
      {unscheduled.length > 0 ? <ul>{unscheduled.map(entry => <Unscheduled key={entry.key} entry={entry} row={rows.get(entry.key)} nowSec={nowSec} />)}</ul> : <p className="ap-reset-empty">{t("accounts.cal.allWithin")}</p>}
    </section>
    <details className="ap-reset-about">
      <summary>{t("accounts.cal.howTo")}</summary>
      <p className="ap-reset-explain">{t("accounts.cal.howToBody", { zone })}</p>
    </details>
    </div>
  </div>;
}
