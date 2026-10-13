import { useState, type CSSProperties } from "react";
import type { Account } from "../claude-accounts";
import { resetCalendar, type ResetEntry, type ResetDay, type UnscheduledReset } from "../account-reset-calendar";
import { shownUsed } from "../accounts-usage-report";

const weekday = (date: Date) => date.toLocaleDateString(undefined, { weekday: "short" });
const dayLabel = (date: Date) => date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
const fullDate = (date: Date) => date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

function ResetTime({ at }: { at: number }) {
  const date = new Date(at * 1000);
  return <time className="ap-reset-time" dateTime={date.toISOString()} title={date.toLocaleString()}>
    {date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}
  </time>;
}

function AccountName({ entry }: { entry: ResetEntry }) {
  return <span className="ap-reset-name">
    <span>{entry.name}</span>
    {entry.active && <span className="ap-report-current">Current</span>}
    {entry.heldOut && <span className="ap-report-tag">held out</span>}
  </span>;
}

function Reading({ entry, past = false }: { entry: ResetEntry; past?: boolean }) {
  return <span className="ap-reset-reading">
    <span className="ap-reset-usage">{entry.used == null ? "Usage unavailable"
      : `${entry.stale || past ? "Last read: " : ""}${shownUsed(entry.used)}% used`}</span>
    {entry.used != null && !entry.stale && !past && <span className="ap-reset-meter" aria-hidden="true">
      <span style={{ width: `${Math.min(100, Math.max(0, entry.used))}%` }} />
    </span>}
    {entry.stale && <span className="ap-reset-old">Outdated · {entry.note}</span>}
  </span>;
}

function Unscheduled({ entry }: { entry: UnscheduledReset }) {
  const reason = entry.reason === "unknown" ? "Reset time unknown"
    : entry.reason === "passed" ? "Reset passed · awaiting a new reading" : "Outside these seven days";
  return <li className="ap-reset-unplaced-row">
    <AccountName entry={entry} />
    <span className="ap-reset-unplaced-detail">
      <span>{reason}</span>
      {entry.at != null && <span>{dayLabel(new Date(entry.at * 1000))} · <ResetTime at={entry.at} /></span>}
    </span>
    <Reading entry={entry} past={entry.reason === "passed"} />
  </li>;
}

function Agenda({ days, outdated = false }: { days: ResetDay[]; outdated?: boolean }) {
  return <div className="ap-reset-agenda">
    {days.map(day => {
      const entries = day.entries.filter(entry => entry.stale === outdated);
      if (!entries.length) return null;
      return <section className="ap-reset-day" key={day.key} aria-label={fullDate(day.date)}>
        <h4>{weekday(day.date)} <span>{dayLabel(day.date)}</span></h4>
        <ul>{entries.map(entry => <li className="ap-reset-entry" key={entry.key} data-outdated={entry.stale ? "" : undefined}>
          <ResetTime at={entry.at!} />
          <AccountName entry={entry} />
          <Reading entry={entry} />
        </li>)}</ul>
      </section>;
    })}
  </div>;
}

/** Same roster and clock as the account table. The chart shows scheduled
 * resets; older readings remain available separately without inflating it. */
export default function AccountResetCalendar({ accounts, nowSec, held }: {
  accounts: readonly Account[];
  nowSec: number;
  held: string | null;
}) {
  const { days, unscheduled } = resetCalendar(accounts, nowSec, held != null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const selected = days.find(day => day.key === selectedDate) ?? null;
  const visibleDays = selected ? [selected] : days;
  const scheduled = days.reduce((sum, day) => sum + day.scheduled, 0);
  const outdated = visibleDays.reduce((sum, day) => sum + day.outdated, 0);
  const shownCount = selected ? selected.scheduled : scheduled;
  const maximum = Math.max(1, ...days.map(day => day.scheduled));
  const next = days.flatMap(day => day.entries).find(entry => !entry.stale);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return <div className="ap-proj-body ap-report-body ap-reset-body" role="region" aria-label="Weekly reset calendar">
    {held && <p className="ap-report-held">{held}</p>}
    <div className="ap-reset-intro">
      <h3>Weekly resets <span>{scheduled} scheduled</span></h3>
      <p>Today and the next six days · {zone}</p>
    </div>
    <p className="ap-reset-next">
      {next ? <><span>Next reset</span> <strong>{weekday(new Date(next.at! * 1000))}, {dayLabel(new Date(next.at! * 1000))} · <ResetTime at={next.at!} /></strong><span className="ap-reset-next-name">{next.name}</span></>
        : <><strong>No scheduled resets in these seven days</strong><span>Older readings and unknown reset times are listed below.</span></>}
    </p>
    <ol className="ap-reset-week" role="list" aria-label="Seven-day reset counts">
      {days.map((day, i) => <li key={day.key} data-today={i === 0 ? "" : undefined}>
        <button type="button" className="ap-reset-day-button" aria-pressed={selected?.key === day.key}
          aria-label={`${fullDate(day.date)}: ${day.scheduled} scheduled resets${day.outdated ? `, ${day.outdated} outdated readings` : ""}`}
          onClick={() => setSelectedDate(selected?.key === day.key ? null : day.key)}>
          <time dateTime={day.key} title={fullDate(day.date)}>
            <span className="ap-reset-weekday">{i === 0 ? "Today" : weekday(day.date)}</span>
            <span className="ap-reset-date">{dayLabel(day.date)}</span>
            <span className="ap-reset-shortdate">{day.date.getDate()}</span>
          </time>
          <span className="ap-reset-chart" aria-hidden="true">
            <span style={{ "--reset-height": `${day.scheduled / maximum * 100}%` } as CSSProperties} />
          </span>
          <span className="ap-reset-count"><b>{day.scheduled}</b><span> scheduled</span></span>
          <span className="ap-reset-old">{day.outdated > 0 ? `${day.outdated} outdated` : ""}</span>
        </button>
      </li>)}
    </ol>
    <p className="ap-reset-hint">Select a day to see its accounts.</p>
    <section className="ap-reset-scheduled" aria-label="Scheduled weekly resets">
      <div className="ap-reset-list-head">
        <h3>{selected ? `${weekday(selected.date)}, ${dayLabel(selected.date)}` : "Scheduled resets"} <span>{shownCount}</span></h3>
        {selected && <button className="btn" type="button" onClick={() => setSelectedDate(null)}>Show all days</button>}
      </div>
      {shownCount > 0 ? <Agenda days={visibleDays} />
        : <p className="ap-reset-empty">{selected ? "No scheduled resets on this day." : "No reported weekly resets in these seven days. The calendar updates when new account readings arrive."}</p>}
    </section>
    {outdated > 0 && <details className="ap-reset-disclosure" key={selected?.key ?? "all"}>
      <summary>{outdated} outdated {outdated === 1 ? "reading" : "readings"}<span>Excluded from counts</span></summary>
      <p className="ap-reset-explain">These are older readings, not confirmed schedules. Their last reported reset times and usage are kept here until updated.</p>
      <Agenda days={visibleDays} outdated />
    </details>}
    {unscheduled.length > 0 && <details className="ap-reset-disclosure ap-reset-unplaced">
      <summary>Other accounts <span>{unscheduled.length} without a reset in these seven days</span></summary>
      <ul>{unscheduled.map(entry => <Unscheduled key={entry.key} entry={entry} />)}</ul>
    </details>}
    <details className="ap-reset-about">
      <summary>About these counts</summary>
      <p className="ap-reset-explain">Counts are scheduled account resets, not token amounts. Outdated readings are listed separately from scheduled counts. Times use {zone}.</p>
    </details>
  </div>;
}
