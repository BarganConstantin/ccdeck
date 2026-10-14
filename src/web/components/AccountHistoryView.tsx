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
  onReset,
}: {
  accounts: (SnapshotAccount & { color: string })[];
  window: "five_hour" | "seven_day";
  start: number;
  end: number;
  zoomed: boolean;
  onZoom: (factor: number, anchor?: number) => void;
  onPan: (delta: number) => void;
  onReset: () => void;
}) {
  const chartRef = useRef<SVGSVGElement>(null);
  const clipId = useId();
  const dragX = useRef<number | null>(null);
  const touchStart = useRef<{ x: number; y: number; moved: boolean } | null>(
    null,
  );
  const lastTap = useRef<{ x: number; y: number; at: number } | null>(null);
  const pointerKind = useRef("mouse");
  const [width, setWidth] = useState(750);
  const [height, setHeight] = useState(440);
  useEffect(() => {
    const svg = chartRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(() => {
      setWidth(Math.max(220, svg.clientWidth));
      setHeight(Math.max(240, svg.clientHeight));
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const svg = chartRef.current;
    if (!svg) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        onPan((event.deltaX / svg.clientWidth) * (end - start));
        return;
      }
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
  }, [onZoom, onPan, start, end]);
  const [hover, setHover] = useState<{
    key: string;
    x: number;
    y: number;
  } | null>(null);
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
  const hovered = values.find((v) => v.key === hover?.key);
  const tracked = hovered ?? (selected ? p : undefined);
  const visibleAccounts = new Set(values.map((p) => p.account.id)).size;
  const x = (t: number) => 36 + ((t - start) / (end - start)) * (width - 50);
  const y = (used: number) => height - 30 - (used / 100) * (height - 50);
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
      <p className="ah-note">Capacity used</p>
      <div className="ah-plot-wrap">
        <svg
          ref={chartRef}
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          tabIndex={0}
          aria-label={`${window === "five_hour" ? "5-hour" : "7-day"} interactive capacity chart. Top is 100 percent used (exhausted); bottom is zero used. Scroll to zoom, drag to pan, double-click to reset. Keyboard: plus or minus to zoom, left or right arrows to pan, zero to reset. Gaps indicate missing observations or changed reset windows.`}
          onDoubleClick={() => {
            if (pointerKind.current !== "touch") onReset();
          }}
          onKeyDown={(e) => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.key === "+" || e.key === "=") {
              e.preventDefault();
              onZoom(0.5);
            } else if (e.key === "-" || e.key === "_") {
              e.preventDefault();
              onZoom(2);
            } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              onPan((end - start) * (e.key === "ArrowLeft" ? -0.5 : 0.5));
            } else if (e.key === "0" || e.key === "Home") {
              e.preventDefault();
              onReset();
            }
          }}
          className={zoomed ? "ah-plot ah-plot-zoomed" : "ah-plot"}
          onPointerDown={(e) => {
            pointerKind.current = e.pointerType;
            if (e.pointerType === "touch")
              touchStart.current = { x: e.clientX, y: e.clientY, moved: false };
            if (!zoomed || e.button !== 0) return;
            dragX.current = e.clientX;
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerLeave={() => setHover(null)}
          onPointerMove={(e) => {
            if (
              touchStart.current &&
              Math.hypot(
                e.clientX - touchStart.current.x,
                e.clientY - touchStart.current.y,
              ) > 8
            )
              touchStart.current.moved = true;
            if (dragX.current == null) {
              const rect = e.currentTarget.getBoundingClientRect();
              const mx = e.clientX - rect.left,
                my = e.clientY - rect.top;
              const target =
                e.target instanceof Element
                  ? e.target
                      .closest("[data-account]")
                      ?.getAttribute("data-account")
                  : null;
              const candidates = target
                ? values.filter((v) => v.account.id === target)
                : values;
              let nearest: (typeof values)[number] | undefined;
              let distance = Infinity;
              for (const candidate of candidates) {
                const d = Math.hypot(
                  x(candidate.t) - mx,
                  y(candidate[window]!.pct) - my,
                );
                if (d < distance) {
                  nearest = candidate;
                  distance = d;
                }
              }
              setHover(
                nearest && (target || distance < 16)
                  ? {
                      key: nearest.key,
                      x: Math.max(4, Math.min(width - 240, mx + 12)),
                      y: Math.max(4, my - 90),
                    }
                  : null,
              );
              return;
            }
            setHover(null);
            const dx = e.clientX - dragX.current;
            dragX.current = e.clientX;
            onPan(
              (-dx / (e.currentTarget.getBoundingClientRect().width - 50)) *
                (end - start),
            );
          }}
          onPointerUp={(e) => {
            if (
              e.pointerType === "touch" &&
              touchStart.current &&
              !touchStart.current.moved
            ) {
              const previous = lastTap.current;
              if (
                previous &&
                Date.now() - previous.at < 350 &&
                Math.hypot(e.clientX - previous.x, e.clientY - previous.y) < 24
              ) {
                const rect = e.currentTarget.getBoundingClientRect();
                if (zoomed) onReset();
                else
                  onZoom(
                    0.5,
                    Math.max(
                      0,
                      Math.min(
                        1,
                        (e.clientX - rect.left - 36) / (rect.width - 50),
                      ),
                    ),
                  );
                lastTap.current = null;
              } else
                lastTap.current = {
                  x: e.clientX,
                  y: e.clientY,
                  at: Date.now(),
                };
            }
            touchStart.current = null;
            dragX.current = null;
          }}
          onPointerCancel={() => {
            touchStart.current = null;
            lastTap.current = null;
            dragX.current = null;
          }}
          onLostPointerCapture={() => {
            dragX.current = null;
          }}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x="36" y="16" width={width - 50} height={height - 42} />
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
          {!accounts.some((a) => a.points.some((p) => p[window])) && (
            <text x={width / 2} y={height / 2} textAnchor="middle">
              No readings for this window
            </text>
          )}
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
              y2={height - 30}
              className="ah-reset"
            >
              <title>Reported reset {stamp(t * 1000)}</title>
            </line>
          ))}
          {accounts.map((a) => (
            <g
              key={a.id}
              data-account={a.id}
              clipPath={`url(#${clipId})`}
              style={{
                opacity: tracked && tracked.account.id !== a.id ? 0.25 : 1,
              }}
            >
              {historySegments(a.points, window).map((s, i) => (
                <g key={i}>
                  <polyline
                    points={s.map((p) => `${x(p.t)},${y(p.pct)}`).join(" ")}
                    className="ah-line"
                    style={{ stroke: a.color }}
                  ></polyline>
                  <path
                    d={s
                      .map(
                        (p, index) =>
                          `${index ? "L" : "M"}${x(p.t)},${y(p.pct)}`,
                      )
                      .join(" ")}
                    className="ah-line-hit"
                  ></path>
                  {s.map((p) => (
                    <circle
                      key={p.t}
                      cx={x(p.t)}
                      cy={y(p.pct)}
                      r="2.5"
                      className="ah-dot"
                      style={{ fill: a.color }}
                    ></circle>
                  ))}
                </g>
              ))}
            </g>
          ))}
          {tracked && (
            <g pointerEvents="none" data-tracked-observation={tracked.key}>
              <line
                className="ah-crosshair"
                x1={x(tracked.t)}
                x2={x(tracked.t)}
                y1="20"
                y2={height - 30}
              />
              <circle
                cx={x(tracked.t)}
                cy={y(tracked[window]!.pct)}
                r="5"
                fill="var(--bg-soft)"
                stroke={tracked.account.color}
                strokeWidth="2"
              />
            </g>
          )}
          <text x="36" y={height - 6}>
            {formatHistoryAxis(start, start, end)}
          </text>
          <text x={width - 14} y={height - 6} textAnchor="end">
            {formatHistoryAxis(end, start, end)}
          </text>
        </svg>
        {hovered && hover && (
          <div
            className="ah-tooltip"
            role="tooltip"
            style={{ left: hover.x, top: hover.y }}
          >
            <strong>
              <span
                className="ah-swatch"
                style={{ background: hovered.account.color }}
              />
              {hovered.account.name}
            </strong>
            <b>
              {Number(hovered[window]!.pct.toFixed(2))}% <span>used</span>
            </b>
            <span>Observed {stamp(hovered.t)}</span>
            <span>
              {hovered[window]!.resetAt
                ? `Reported reset ${stamp(hovered[window]!.resetAt! * 1000)}`
                : "Reset time unknown"}
            </span>
          </div>
        )}
      </div>
      <details className="ah-inspector">
        <summary>Inspect recorded readings</summary>
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
      </details>
    </section>
  );
}
export default function AccountHistoryView() {
  const [data, setData] = useState<AccountHistory | null>(null),
    [error, setError] = useState(""),
    [account, setAccount] = useState(""),
    [days, setDays] = useState(7),
    [retry, setRetry] = useState(0);
  const [activeWindow, setActiveWindow] = useState<"five_hour" | "seven_day">(
    "five_hour",
  );
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
    <div className="ah-workspace ah-redesign">
      <div className="ah-heading">
        <div>
          <h2>Capacity over time</h2>
          <p className="ah-note">
            Compare recorded capacity across your accounts.
          </p>
        </div>
        <label className="ah-period">
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
          <div className="ah-context">
            <span>
              {data.enabled ? "Recording new observations" : "Recording paused"}
            </span>
            <span>{data.retentionDays}-day retention · Local time</span>
          </div>
          {data.storageError && <p role="alert">{data.storageError}</p>}
          <div className="ah-studio">
            <main className="ah-canvas">
              <div
                className="ah-window-switch"
                role="group"
                aria-label="Usage window"
              >
                <button
                  type="button"
                  aria-pressed={activeWindow === "five_hour"}
                  onClick={() => setActiveWindow("five_hour")}
                >
                  5-hour window
                </button>
                <button
                  type="button"
                  aria-pressed={activeWindow === "seven_day"}
                  onClick={() => setActiveWindow("seven_day")}
                >
                  7-day window
                </button>
                <span>Capacity used</span>
              </div>
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
                  {(["five_hour", "seven_day"] as const).map((window) => (
                    <div key={window} hidden={activeWindow !== window}>
                      <HistoryChart
                        accounts={series}
                        window={window}
                        start={start}
                        end={end}
                        zoomed={zoomed}
                        onZoom={zoom}
                        onPan={pan}
                        onReset={() => setViewport(null)}
                      />
                    </div>
                  ))}
                  <div className="ah-chart-caption">
                    <p className="ah-note" role="status">
                      Viewing {stamp(start)} – {stamp(end)}
                    </p>
                    <p className="ah-note">
                      Scroll to zoom · Drag to pan · Double-click to reset
                      <span className="ah-touch-hint">
                        {" "}
                        · Touch: double-tap to zoom/reset
                      </span>
                    </p>
                  </div>
                </>
              )}
            </main>
            <aside className="ah-accounts" aria-label="Account comparison">
              <div className="ah-accounts-heading">
                <h3>Accounts</h3>
                <span>{colored.length}</span>
              </div>
              <label className="ah-account-picker">
                Show
                <select
                  aria-label="Account"
                  value={selectedAccount}
                  onChange={(e) => {
                    setAccount(e.target.value);
                    setViewport(null);
                  }}
                  disabled={!data.accounts.length}
                >
                  <option value="">All accounts</option>
                  {data.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.removed ? " · Removed account" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <p className="ah-note">Latest recorded · % used</p>
              <div className="ah-legend" aria-label="Account legend">
                {colored.map((a) => {
                  const latest = a.points
                    .filter((p) => p.t >= from && p.t <= now && p[activeWindow])
                    .at(-1);
                  return (
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
                      <span className="ah-account-name">
                        {a.name}
                        <small>
                          {a.removed ? "Removed · " : ""}
                          {latest
                            ? stamp(latest.t)
                            : "No reading in this period"}
                        </small>
                      </span>
                      <span className="ah-account-value">
                        {latest
                          ? `${Number(latest[activeWindow]!.pct.toFixed(2))}%`
                          : "—"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </aside>
          </div>
          <details className="ah-data-notes">
            <summary>About these readings</summary>
            <p className="ah-note">
              Percentages describe reported capacity used, not token
              consumption. Missing readings remain gaps; reported reset times do
              not confirm renewed capacity. The time axis fits available
              readings. Dashed markers show reported resets.
            </p>
          </details>
        </>
      )}
    </div>
  );
}
