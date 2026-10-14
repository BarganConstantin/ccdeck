import React, { useEffect, useRef, useState } from "react";
import {
  type AccountHistory,
  type AccountSnapshot,
  historySegments,
  formatSnapshotTime,
} from "../account-history";
import "./account-history.css";
const stamp = formatSnapshotTime;
function HistoryChart({
  points,
  window,
  start,
  end,
}: {
  points: AccountSnapshot[];
  window: "five_hour" | "seven_day";
  start: number;
  end: number;
}) {
  const chartRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(750);
  useEffect(() => {
    const svg = chartRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(() =>
      setWidth(Math.max(220, svg.clientWidth)),
    );
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  const [selected, setSelected] = useState<number | null>(null);
  const values = points.filter((p) => p[window]);
  const p = values.find((p) => p.t === selected) ?? values.at(-1);
  const w = p?.[window];
  const x = (t: number) => 36 + ((t - start) / (end - start)) * (width - 50);
  const y = (pct: number) => 140 - pct * 1.2;
  return (
    <section
      className="ah-chart"
      aria-label={`${window === "five_hour" ? "5-hour" : "7-day"} usage history`}
    >
      <header>
        <h3>{window === "five_hour" ? "5-hour window" : "7-day window"}</h3>
        <span>{w ? `${w.pct}% used` : "No observations"}</span>
      </header>
      <svg
        ref={chartRef}
        viewBox={`0 0 ${width} 170`}
        role="img"
        aria-label="Reported usage from 0 to 100 percent. Gaps indicate missing observations; separate lines indicate changed reset windows."
      >
        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line
              x1="36"
              x2={width - 14}
              y1={y(v)}
              y2={y(v)}
              className="ah-grid"
            />
            <text x="3" y={y(v) + 4}>
              {v}%
            </text>
          </g>
        ))}
        {[
          ...new Set(
            points
              .map((p) => p[window]?.resetAt)
              .filter(
                (t): t is number =>
                  t != null && t * 1000 >= start && t * 1000 <= end,
              ),
          ),
        ].map((t) => (
          <line
            key={t}
            x1={x(t * 1000)}
            x2={x(t * 1000)}
            y1="20"
            y2="140"
            className="ah-reset"
          >
            <title>Reported reset {stamp(t * 1000)}</title>
          </line>
        ))}
        {historySegments(points, window).map((s, i) => (
          <g key={i}>
            <polyline
              points={s.map((p) => `${x(p.t)},${y(p.pct)}`).join(" ")}
              className="ah-line"
            />
            {s.map((p) => (
              <circle
                key={p.t}
                cx={x(p.t)}
                cy={y(p.pct)}
                r="2.5"
                className="ah-dot"
              >
                <title>
                  {stamp(p.t)} · {p.pct}% used
                </title>
              </circle>
            ))}
          </g>
        ))}
        <text x="36" y="164">
          {new Date(start).toLocaleDateString()}
        </text>
        <text x={width - 14} y="164" textAnchor="end">
          {new Date(end).toLocaleDateString()}
        </text>
      </svg>
      <label className="ah-inspect">
        Inspect observation
        <select
          aria-label={`Inspect ${window === "five_hour" ? "5-hour" : "7-day"} observation`}
          value={p?.t ?? ""}
          onChange={(e) => setSelected(Number(e.target.value))}
          disabled={!values.length}
        >
          {!values.length && <option value="">No observations</option>}
          {[...values].reverse().map((v) => (
            <option key={v.t} value={v.t}>
              {stamp(v.t)} · {v[window]!.pct}% used
            </option>
          ))}
        </select>
      </label>
      <p className="ah-note">
        Dashed markers show reported reset times; breaks also separate changed
        reset windows.
      </p>
      <p className="ah-note">
        {p
          ? `Read ${stamp(p.t)}${w?.resetAt ? ` · Reported reset ${stamp(w.resetAt * 1000)}` : " · Reset time unknown"}`
          : "Readings will appear as they are collected."}
      </p>
    </section>
  );
}
export default function AccountHistoryView() {
  const [data, setData] = useState<AccountHistory | null>(null),
    [error, setError] = useState(""),
    [account, setAccount] = useState(""),
    [days, setDays] = useState(7),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true,
      running = false;
    const controller = new AbortController();
    const read = async () => {
      if (running) return;
      running = true;
      try {
        const r = await fetch("/api/accounts/history", {
          signal: controller.signal,
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || "History unavailable");
        if (alive) {
          setData(d);
          setError("");
        }
      } catch (e) {
        if (alive && !controller.signal.aborted)
          setError(e instanceof Error ? e.message : "History unavailable");
      } finally {
        running = false;
      }
    };
    void read();
    const timer = setInterval(read, 60_000);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [retry]);
  useEffect(() => {
    if (data && days > data.retentionDays) setDays(data.retentionDays);
  }, [data?.retentionDays, days]);
  const chosen =
    data?.accounts.find((a) => a.id === account) ?? data?.accounts[0];
  const end = Date.now(),
    start = end - days * 86400_000;
  const points = chosen?.points.filter((p) => p.t >= start && p.t <= end) ?? [];
  return (
    <div className="ah-workspace">
      <div className="ah-toolbar">
        <label>
          Account
          <select
            aria-label="Account"
            value={chosen?.id ?? ""}
            onChange={(e) => setAccount(e.target.value)}
            disabled={!data?.accounts.length}
          >
            {!data?.accounts.length && (
              <option value="">No recorded accounts</option>
            )}
            {data?.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.removed ? " · Removed account" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Period
          <select
            aria-label="Period"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {[7, 30, 60, 90]
              .filter((n) => n <= Math.max(7, data?.retentionDays ?? 30))
              .map((n) => (
                <option key={n} value={n}>
                  Last {n} days
                </option>
              ))}
          </select>
        </label>
      </div>
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            type="button"
            className="btn"
            onClick={() => setRetry((n) => n + 1)}
          >
            Retry
          </button>
        </p>
      )}
      {!data && !error && <p role="status">Loading account history…</p>}
      {data && (
        <>
          <p className="ah-note">
            {data.enabled ? "Recording new observations" : "Recording paused"} ·{" "}
            {data.retentionDays}-day retention · Local time. Missing readings
            remain gaps.
          </p>
          {data.storageError && <p role="alert">{data.storageError}</p>}
          {!points.length ? (
            <div className="ah-empty">
              <h3>No readings in this period</h3>
              <p>
                {data.enabled
                  ? "History accumulates while ccdeck runs and new account readings are available."
                  : "Enable usage snapshots in Settings → Account history to collect new readings."}
              </p>
            </div>
          ) : (
            <>
              <HistoryChart
                points={points}
                window="five_hour"
                start={start}
                end={end}
              />
              <HistoryChart
                points={points}
                window="seven_day"
                start={start}
                end={end}
              />
            </>
          )}
          <p className="ah-note">
            Percentages describe reported capacity used, not token consumption.
            A reported reset time does not confirm renewed capacity.
          </p>
        </>
      )}
    </div>
  );
}
