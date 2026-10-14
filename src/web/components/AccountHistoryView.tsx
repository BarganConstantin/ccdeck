import React, { useEffect, useId, useRef, useState } from "react";
import {
  type AccountHistory,
  type SnapshotAccount,
  historySegments,
  formatSnapshotTime,
  historyTimeDomain,
  formatHistoryAxis,
  clampHistoryRange,
  zoomHistoryRange,
  type HistoryRange,
} from "../account-history";
import "./account-history.css";
const stamp = formatSnapshotTime;
function HistoryChart({
  accounts,
  window,
  start,
  end,
  zoomed,
  onZoom,
  onPan,
}: {
  accounts: (SnapshotAccount & { color: string })[];
  window: "five_hour" | "seven_day";
  start: number;
  end: number;
  zoomed: boolean;
  onZoom: (factor: number, anchor?: number) => void;
  onPan: (delta: number) => void;
}) {
  const chartRef = useRef<SVGSVGElement>(null);
  const clipId = useId();
  const dragX = useRef<number | null>(null);
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
  useEffect(() => {
    const svg = chartRef.current;
    if (!svg) return;
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const anchor = Math.max(
        0,
        Math.min(1, (event.clientX - rect.left - 36) / (rect.width - 50)),
      );
      onZoom(
        Math.exp(Math.max(-100, Math.min(100, event.deltaY)) * 0.005),
        anchor,
      );
    };
    svg.addEventListener("wheel", wheel, { passive: false });
    return () => svg.removeEventListener("wheel", wheel);
  }, [onZoom]);
  const [selected, setSelected] = useState<string | null>(null);
  const values = accounts
    .flatMap((a) =>
      a.points
        .filter((p) => p[window] && p.t >= start && p.t <= end)
        .map((p) => ({ ...p, account: a, key: `${a.id}:${p.t}` })),
    )
    .sort((a, b) => a.t - b.t || a.account.id.localeCompare(b.account.id));
  const p = values.find((p) => p.key === selected) ?? values.at(-1);
  const w = p?.[window];
  const visibleAccounts = new Set(values.map((p) => p.account.id)).size;
  const x = (t: number) => 36 + ((t - start) / (end - start)) * (width - 50);
  const y = (pct: number) => 140 - pct * 1.2;
  return (
    <section
      className="ah-chart"
      aria-label={`${window === "five_hour" ? "5-hour" : "7-day"} usage history`}
    >
      <header>
        <h3>{window === "five_hour" ? "5-hour window" : "7-day window"}</h3>
        <span>
          {accounts.length > 1
            ? `${visibleAccounts} ${visibleAccounts === 1 ? "account" : "accounts"}`
            : w
              ? `${w.pct}% used`
              : "No observations"}
        </span>
      </header>
      <svg
        ref={chartRef}
        viewBox={`0 0 ${width} 170`}
        role="img"
        aria-label="Reported usage from 0 to 100 percent. Gaps indicate missing observations; separate lines indicate changed reset windows."
        className={zoomed ? "ah-plot ah-plot-zoomed" : "ah-plot"}
        onPointerDown={(e) => {
          if (!zoomed || e.button !== 0) return;
          dragX.current = e.clientX;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (dragX.current == null) return;
          const dx = e.clientX - dragX.current;
          dragX.current = e.clientX;
          onPan(
            (-dx / (e.currentTarget.getBoundingClientRect().width - 50)) *
              (end - start),
          );
        }}
        onPointerUp={() => {
          dragX.current = null;
        }}
        onPointerCancel={() => {
          dragX.current = null;
        }}
        onLostPointerCapture={() => {
          dragX.current = null;
        }}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x="36" y="16" width={width - 50} height="128" />
          </clipPath>
        </defs>
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
            accounts
              .flatMap((a) => a.points)
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
        {accounts.map((a) => (
          <g key={a.id} data-account={a.id} clipPath={`url(#${clipId})`}>
            {historySegments(a.points, window).map((s, i) => (
              <g key={i}>
                <polyline
                  points={s.map((p) => `${x(p.t)},${y(p.pct)}`).join(" ")}
                  className="ah-line"
                  style={{ stroke: a.color }}
                />
                {s.map((p) => (
                  <circle
                    key={p.t}
                    cx={x(p.t)}
                    cy={y(p.pct)}
                    r="2.5"
                    className="ah-dot"
                    style={{ fill: a.color }}
                  >
                    <title>
                      {a.name} · {stamp(p.t)} · {p.pct}% used
                    </title>
                  </circle>
                ))}
              </g>
            ))}
          </g>
        ))}
        <text x="36" y="164">
          {formatHistoryAxis(start, start, end)}
        </text>
        <text x={width - 14} y="164" textAnchor="end">
          {formatHistoryAxis(end, start, end)}
        </text>
      </svg>
      <label className="ah-inspect">
        Inspect observation
        <select
          aria-label={`Inspect ${window === "five_hour" ? "5-hour" : "7-day"} observation`}
          value={p?.key ?? ""}
          onChange={(e) => setSelected(e.target.value)}
          disabled={!values.length}
        >
          {!values.length && <option value="">No observations</option>}
          {[...values].reverse().map((v) => (
            <option key={v.key} value={v.key}>
              {accounts.length > 1 ? `${v.account.name} · ` : ""}
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
          ? `${accounts.length > 1 ? p.account.name + " · " : ""}Read ${stamp(p.t)}${w?.resetAt ? ` · Reported reset ${stamp(w.resetAt * 1000)}` : " · Reset time unknown"}`
          : "No readings in this visible interval."}
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
  const [viewport, setViewport] = useState<
    (HistoryRange & { key: string }) | null
  >(null);
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
  const chosen = data?.accounts.find((a) => a.id === account);
  const selectedAccount = chosen?.id ?? "";
  const colored = (data?.accounts ?? []).map((a, index) => ({
    ...a,
    color: `hsl(${(210 + index * 137.508) % 360} 60% var(--session-accent-l, 65%))`,
  }));
  const now = Date.now(),
    from = now - days * 86400_000;
  const series = colored
    .filter((a) => !selectedAccount || a.id === selectedAccount)
    .map((a) => ({
      ...a,
      points: a.points.filter((p) => p.t >= from && p.t <= now),
    }));
  const full = historyTimeDomain(
    series.flatMap((a) =>
      a.points.filter((p) => p.five_hour || p.seven_day).map((p) => p.t),
    ),
    from,
    now,
  );
  const viewKey = `${selectedAccount}:${days}`;
  const view =
    viewport?.key === viewKey ? clampHistoryRange(viewport, full) : full;
  const { start, end } = view;
  const zoomed = end - start < full.end - full.start - 1;
  const zoom = (factor: number, anchor = 0.5) =>
    setViewport((previous) => ({
      ...zoomHistoryRange(
        previous?.key === viewKey ? clampHistoryRange(previous, full) : full,
        full,
        factor,
        anchor,
      ),
      key: viewKey,
    }));
  const pan = (delta: number) =>
    setViewport((previous) => {
      const current =
        previous?.key === viewKey ? clampHistoryRange(previous, full) : full;
      return {
        ...clampHistoryRange(
          { start: current.start + delta, end: current.end + delta },
          full,
        ),
        key: viewKey,
      };
    });
  const hasPoints = series.some((a) => a.points.length > 0);
  return (
    <div className="ah-workspace">
      <div className="ah-toolbar">
        <label>
          Account
          <select
            aria-label="Account"
            value={selectedAccount}
            onChange={(e) => {
              setAccount(e.target.value);
              setViewport(null);
            }}
            disabled={!data?.accounts.length}
          >
            <option value="">All accounts</option>
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
            onChange={(e) => {
              setDays(Number(e.target.value));
              setViewport(null);
            }}
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
            remain gaps. The time axis fits available readings.
          </p>
          {data.storageError && <p role="alert">{data.storageError}</p>}
          {data.accounts.length > 0 && (
            <div className="ah-legend" aria-label="Account legend">
              {colored.map((a) => (
                <button
                  type="button"
                  key={a.id}
                  className="ah-legend-account"
                  aria-pressed={selectedAccount === a.id}
                  onClick={() => {
                    setAccount(selectedAccount === a.id ? "" : a.id);
                    setViewport(null);
                  }}
                  title={a.name}
                >
                  <span
                    className="ah-swatch"
                    style={{ background: a.color }}
                    aria-hidden="true"
                  />
                  <span>
                    {a.name}
                    {a.removed ? " · Removed" : ""}
                  </span>
                </button>
              ))}
            </div>
          )}
          {!hasPoints ? (
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
              <div
                className="ah-explore"
                role="group"
                aria-label="History chart navigation"
              >
                <button
                  type="button"
                  className="btn"
                  aria-label="Earlier observations"
                  disabled={!zoomed || start <= full.start + 1}
                  onClick={() => pan(-(end - start) * 0.5)}
                >
                  ←
                </button>
                <button
                  type="button"
                  className="btn"
                  aria-label="Zoom in"
                  disabled={end - start <= 5 * 60_000 + 1}
                  onClick={() => zoom(0.5)}
                >
                  +
                </button>
                <button
                  type="button"
                  className="btn"
                  aria-label="Zoom out"
                  disabled={!zoomed}
                  onClick={() => zoom(2)}
                >
                  −
                </button>
                <button
                  type="button"
                  className="btn"
                  aria-label="Later observations"
                  disabled={!zoomed || end >= full.end - 1}
                  onClick={() => pan((end - start) * 0.5)}
                >
                  →
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={!zoomed}
                  onClick={() => setViewport(null)}
                >
                  Reset zoom
                </button>
                <span className="ah-note">
                  Ctrl/⌘ + scroll to zoom · Drag when zoomed
                </span>
              </div>
              <p className="ah-note" role="status">
                Viewing {stamp(start)} – {stamp(end)}
              </p>
              <HistoryChart
                accounts={series}
                window="five_hour"
                start={start}
                end={end}
                zoomed={zoomed}
                onZoom={zoom}
                onPan={pan}
              />
              <HistoryChart
                accounts={series}
                window="seven_day"
                start={start}
                end={end}
                zoomed={zoomed}
                onZoom={zoom}
                onPan={pan}
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
