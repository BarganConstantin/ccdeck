import { useRef, type CSSProperties, type ReactNode } from "react";
import { ClockGlyph } from "./rail-glyphs";
import type { Account } from "../claude-accounts";
import { resetCalendar, type ResetEntry, type ResetDay, type UnscheduledReset } from "../account-reset-calendar";
import { shownUsed, usageReport, type ReportRow } from "../accounts-usage-report";
import { resetCountdown } from "../relative-time";

const weekday = (date: Date) => date.toLocaleDateString(undefined, { weekday: "short" });
const dayLabel = (date: Date) => date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
const fullDate = (date: Date) => date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const timeUntil = (at: number, nowSec: number) => at - nowSec < 60 ? "less than 1m" : resetCountdown(at, nowSec);

function ResetTime({ at }: { at: number }) {
  const date = new Date(at * 1000);
  return <time className="ap-reset-time" dateTime={date.toISOString()} title={date.toLocaleString()}>
    {date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
  </time>;
}

function AccountName({ entry }: { entry: ResetEntry }) {
  return <span className="ap-reset-name">
    <span>{entry.name}</span>
    {entry.active && <span className="ap-report-current">Current</span>}
    {entry.heldOut && <span className="ap-report-tag">held out</span>}
  </span>;
}

function AccountDetails({ entry, row, nowSec, withReading = false, older = false, context }: { entry: ResetEntry; row?: ReportRow; nowSec: number; withReading?: boolean; older?: boolean; context?: ReactNode }) {
  return <details className="ap-reset-account">
    <summary>{context ? <span className="ap-reset-summary-other"><AccountName entry={entry} />{context}</span> : withReading ? <span className="ap-reset-summary-content"><AccountName entry={entry} /><Reading entry={entry} older={older} /></span> : <AccountName entry={entry} />}<span className="vis-hidden"> · Account details</span></summary>
    <div className="ap-reset-account-body">
      {row && (["five_hour", "seven_day"] as const).map(id => {
        const cell = row.cells[id];
        const pct = cell.counted ? cell.pct : cell.last;
        const at = row.resets[id];
        return <p key={id}><strong>{id === "five_hour" ? "5-hour" : "7-day"}</strong>
          <span>{!cell.counted && cell.reset ? "Estimated unused · awaiting a fresh reading" : pct == null ? "No usage reading" : `${entry.stale || !cell.counted ? "Last read: " : ""}${shownUsed(pct)}% used`}</span>
          <span>{at == null ? "Reset time unknown" : at <= nowSec ? "Reported time passed · awaiting a new reading" : <>{entry.stale ? "Last reported reset" : `Reset in ${timeUntil(at, nowSec)}`} · <ResetTime at={at} /></>}</span>
        </p>;
      })}
      <p>{entry.heldOut ? "Excluded from automatic rotation." : "A weekly reset does not remove a separate 5-hour limit."}</p>
    </div>
  </details>;
}

function Reading({ entry, past = false, older = false }: { entry: ResetEntry; past?: boolean; older?: boolean }) {
  return <span className="ap-reset-reading" data-level={entry.stale || past ? "older" : entry.used != null && entry.used >= 70 ? "limited" : undefined}>
    <span className="ap-reset-usage">{entry.used == null ? "Usage unavailable"
      : `${entry.stale || past ? "Last read: " : ""}${shownUsed(entry.used)}% used`}</span>
    {entry.used != null && !entry.stale && !past && <span className="ap-reset-meter" data-level={entry.used >= 90 ? "hi" : entry.used >= 70 ? "mid" : undefined} aria-hidden="true">
      <span style={{ "--reset-used": Math.min(100, Math.max(0, entry.used)) / 100 } as CSSProperties} />
    </span>}
    {entry.stale && <span className="ap-reset-old">{!older && "Needs a fresh reading · "}{entry.note}</span>}
  </span>;
}

function Unscheduled({ entry, row, nowSec }: { entry: UnscheduledReset; row?: ReportRow; nowSec: number }) {
  const reason = entry.reason === "unknown" ? "Reset time unknown"
    : entry.reason === "passed" ? "Reported time passed · awaiting a new reading" : "Beyond these seven days";
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
  return <div className="ap-reset-agenda">
    {days.map(day => {
      const entries = day.entries.filter(entry => entry.stale === outdated);
      if (!entries.length) return null;
      return <section className="ap-reset-day" key={day.key} aria-label={fullDate(day.date)}>
        <h4 className="vis-hidden">{fullDate(day.date)} · {entries.length} {entries.length === 1 ? "account" : "accounts"}</h4>
        <ul>{Array.from(new Set(entries.map(entry => entry.at))).map((at, index) => <li className="ap-reset-event" key={at}>
          <div className="ap-reset-when" data-outdated={outdated ? "" : undefined}>{outdated && <span className="ap-reset-last-reported">Last reported</span>}{index === 0 && <time className="ap-reset-day-label" dateTime={day.key}>{weekday(day.date)} · {dayLabel(day.date)}</time>}<ResetTime at={at!} />{!outdated && <span>in {timeUntil(at!, nowSec)}</span>}</div>
          <ul className="ap-reset-event-accounts">{entries.filter(entry => entry.at === at).map(entry => <li className="ap-reset-entry" key={entry.key} data-outdated={entry.stale ? "" : undefined}>
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
  const { days, unscheduled } = resetCalendar(accounts, nowSec, held != null);
  const selected = days.find(day => day.key === selectedDate) ?? null;
  const visibleDays = selected ? [selected] : days;
  const scheduled = days.reduce((sum, day) => sum + day.scheduled, 0);
  const outdated = visibleDays.reduce((sum, day) => sum + day.outdated, 0);
  const allOutdated = days.reduce((sum, day) => sum + day.outdated, 0);
  const shownCount = selected ? selected.scheduled : scheduled;
  const next = days.flatMap(day => day.entries).find(entry => !entry.stale);
  const simultaneous = next ? days.flatMap(day => day.entries).filter(entry => !entry.stale && entry.at === next.at) : [];
  const resultsRef = useRef<HTMLDivElement>(null);
  const returnToStart = () => { if (resultsRef.current) resultsRef.current.scrollTop = 0; };
  const inspectCoverage = (target: ResetScope) => {
    returnToStart();
    onSelect(null);
    onScope(target);
  };
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rows = new Map(usageReport(accounts, nowSec).rows.map(row => [row.key, row]));
  return <div className="ap-proj-body ap-report-body ap-reset-body" role="region" aria-label="Weekly reset calendar">
    {held && <p className="ap-report-held">{held}</p>}
    <div className="ap-reset-overview"><div className="ap-reset-command">
    <section className="ap-reset-next" aria-label="Next weekly reset">
      {next ? <>
        <div className="ap-reset-next-identity"><h3><ClockGlyph />Next reported reset <span className="ap-reset-global">· all days</span></h3>
          {simultaneous.length > 1 ? <span className="ap-reset-name">{simultaneous.length} accounts</span> : <details className="ap-reset-next-account"><summary title={next.name}><AccountName entry={next} /><span className="vis-hidden"> · Full account name</span></summary><p className="ap-reset-full-name">{next.name}</p></details>}
          <p>{weekday(new Date(next.at! * 1000))}, {dayLabel(new Date(next.at! * 1000))} · <ResetTime at={next.at!} /></p><p className="ap-reset-next-note">Reported time · recent reading{simultaneous.length > 1 ? "s" : next.used != null ? ` · ${shownUsed(next.used)}% weekly used` : ""}</p></div>
        <p className="ap-reset-countdown"><strong>{timeUntil(next.at!, nowSec)}</strong><span>until reported reset</span></p>
      </> : <div className="ap-reset-next-identity"><h3>No upcoming weekly resets</h3><p>{allOutdated ? "Some schedules need a fresh reading. Check the last reported times below." : "No reported weekly resets in these seven days. Unknown and elapsed times remain below."}</p></div>}
    </section>
    <div className="ap-reset-coverage" role="group" aria-label="Schedule data">
      <button type="button" className="ap-reset-coverage-link" data-scope="upcoming" aria-pressed={scope === "upcoming"} onClick={() => inspectCoverage("upcoming")}><b>{scheduled}</b><span>Upcoming<span>Recent readings</span></span></button>
      <button type="button" className="ap-reset-coverage-link" title="Schedules in these seven days that need a fresh reading" data-scope="older" data-attention={allOutdated > 0 ? "" : undefined} aria-pressed={scope === "older"} onClick={() => inspectCoverage("older")}><b>{allOutdated}</b><span>Needs fresh data<span>This week · excluded</span></span></button>
      <button type="button" className="ap-reset-coverage-link" data-scope="other" aria-pressed={scope === "other"} onClick={() => inspectCoverage("other")}><b>{unscheduled.length}</b><span>Other reset times<span>Unknown, elapsed or later</span></span></button>
    </div></div>
    <section className="ap-reset-navigation" aria-label="Choose a calendar day">
      <div className="ap-reset-intro"><h3>Next 7 days <span>{scheduled} weekly {scheduled === 1 ? "reset" : "resets"}</span></h3><p>{zone}</p></div>
      <ol className="ap-reset-week" role="list" aria-label="Seven-day reset counts">
        {days.map((day, i) => <li key={day.key} data-today={i === 0 ? "" : undefined}>
          <button type="button" className="ap-reset-day-button" aria-current={i === 0 ? "date" : undefined} data-active={day.scheduled > 0 ? "" : undefined} aria-pressed={selected?.key === day.key}
            aria-label={`${fullDate(day.date)}: ${day.scheduled} scheduled resets${day.outdated ? `, ${day.outdated} readings need updating` : ""}`}
            onClick={() => { returnToStart(); onScope("upcoming"); onSelect(selected?.key === day.key ? null : day.key); }}>
            <time dateTime={day.key} title={fullDate(day.date)}><span className="ap-reset-weekday">{i === 0 ? "Today" : weekday(day.date)}</span><span className="ap-reset-date">{day.date.getDate()}</span></time>
            <span className="ap-reset-count"><b>{day.scheduled || "—"}</b><span> {day.scheduled === 1 ? "reset" : "resets"}</span></span>
          </button>
        </li>)}
      </ol>
    </section></div>
    <div ref={resultsRef} className="ap-reset-results">
    <section className="ap-reset-scheduled" hidden={scope !== "upcoming"} aria-label="Scheduled weekly resets">
      <div className="ap-reset-list-head">
        <h3>{selected ? `${weekday(selected.date)}, ${dayLabel(selected.date)}` : "All upcoming resets"} <span>{shownCount}</span></h3>
        <button className="btn" type="button" aria-pressed={!selected} onClick={() => { returnToStart(); onSelect(null); }}>All days</button>
      </div>
      <p className="ap-reset-hint" role="status">{selected ? `Showing only ${fullDate(selected.date)}.` : "All days · select a date to narrow the agenda."}</p>
      {shownCount > 0 ? <Agenda days={visibleDays} rows={rows} nowSec={nowSec} />
        : <p className="ap-reset-empty">{selected ? "No upcoming resets on this day. Choose another date or All days." : "The schedule updates with new account readings. No weekly recurrence is assumed."}</p>}
    </section>
    <section className="ap-reset-disclosure" hidden={scope !== "older"} aria-label="Accounts needing fresh readings">
      <h3>Needs a fresh reading <span>{outdated} {outdated === 1 ? "account" : "accounts"} · excluded from counts</span></h3>
      <p className="ap-reset-explain">These weekly schedules need a fresh reading. Other reset times may also contain stale readings. Last reported times and usage remain visible until updated.</p>
      {outdated > 0 ? <Agenda days={visibleDays} rows={rows} nowSec={nowSec} outdated /> : <p className="ap-reset-empty">No older schedules in these seven days. Unknown or elapsed times are listed in Other reset times.</p>}
    </section>
    <section className="ap-reset-disclosure ap-reset-unplaced" hidden={scope !== "other"} aria-label="Other reset times">
      <h3>Other reset times <span>{unscheduled.length} {unscheduled.length === 1 ? "account" : "accounts"} · unknown, elapsed or later</span></h3>
      {unscheduled.length > 0 ? <ul>{unscheduled.map(entry => <Unscheduled key={entry.key} entry={entry} row={rows.get(entry.key)} nowSec={nowSec} />)}</ul> : <p className="ap-reset-empty">All reported reset times fall within the upcoming week.</p>}
    </section>
    <details className="ap-reset-about">
      <summary>How to read this schedule</summary>
      <p className="ap-reset-explain">Counts are reported weekly account resets, not token amounts. Zero means no upcoming reset on that day, not zero usage. Held-out accounts still appear in the schedule. A timestamp passing does not confirm renewed capacity. Older readings are excluded from upcoming counts. Times use {zone}; a separate 5-hour limit may still apply. Usage bars show reported capacity used. The warning tint at 70% or more indicates lower remaining capacity, not an account error.</p>
    </details>
    </div>
  </div>;
}
