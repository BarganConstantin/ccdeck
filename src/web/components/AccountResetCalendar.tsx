import type { Account } from "../claude-accounts";
import { resetCalendar, type ResetEntry, type UnscheduledReset } from "../account-reset-calendar";
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

/** Uses the report's existing roster and clock; an open calendar follows polls
 *  and local midnight without another fetch or timer. */
export default function AccountResetCalendar({ accounts, nowSec, held }: {
  accounts: readonly Account[];
  nowSec: number;
  held: string | null;
}) {
  const { days, unscheduled } = resetCalendar(accounts, nowSec, held != null);
  const populated = days.filter(day => day.entries.length > 0);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return <div className="ap-proj-body ap-report-body ap-reset-body" role="region" aria-label="Weekly reset calendar">
    {held && <p className="ap-report-held">{held}</p>}
    <div className="ap-reset-intro">
      <h3>Weekly resets</h3>
      <p>Today and the next six days · {zone}</p>
    </div>
    <ol className="ap-reset-week" aria-label="Seven-day reset counts">
      {days.map((day, i) => <li key={day.key} data-today={i === 0 ? "" : undefined}>
        <time dateTime={day.key} title={fullDate(day.date)}>
          <span className="ap-reset-weekday">{i === 0 ? `Today · ${weekday(day.date)}` : weekday(day.date)}</span>
          <span className="ap-reset-date">{dayLabel(day.date)}</span>
        </time>
        <span className="ap-reset-count"><b>{day.scheduled}</b> scheduled</span>
        {day.outdated > 0 && <span className="ap-reset-old">{day.outdated} outdated</span>}
      </li>)}
    </ol>
    <p className="ap-reset-explain">Counts are scheduled account resets, not token amounts. Outdated readings are listed separately from scheduled counts.</p>
    {populated.length === 0 && <p className="ap-reset-empty">No reported weekly resets in these seven days. The calendar updates when new account readings arrive.</p>}
    <div className="ap-reset-agenda">
      {populated.map(day => <section className="ap-reset-day" key={day.key} aria-label={fullDate(day.date)}>
        <h4>{weekday(day.date)} <span>{dayLabel(day.date)}</span></h4>
        <ul>{day.entries.map(entry => <li className="ap-reset-entry" key={entry.key} data-outdated={entry.stale ? "" : undefined}>
          <ResetTime at={entry.at!} />
          <AccountName entry={entry} />
          <Reading entry={entry} />
        </li>)}</ul>
      </section>)}
    </div>
    {unscheduled.length > 0 && <section className="ap-reset-unplaced" aria-label="Accounts without a reset in these seven days">
      <h3>Other accounts</h3>
      <ul>{unscheduled.map(entry => <Unscheduled key={entry.key} entry={entry} />)}</ul>
    </section>}
  </div>;
}
