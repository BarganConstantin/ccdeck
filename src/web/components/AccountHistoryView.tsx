import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useId,
  useRef,
  useState,
} from "react";
import {
  type AccountHistory,
  type SnapshotAccount,
  historySegments,
  smoothHistoryPath,
  historyTooltipPosition,
  createSnapshotTimeFormatter,
  historyTimeDomain,
  formatHistoryAxis,
  clampHistoryRange,
  zoomHistoryRange,
  clampUsageRange,
  zoomUsageRange,
  type HistoryRange,
} from "../account-history";
import "./account-history.css";
function HistoryChart({
  accounts,
  window,
  start,
  end,
  zoomed,
  usageRange,
  active,
  onZoom,
  onPan,
  onReset,
}: {
  accounts: (SnapshotAccount & { color: string })[];
  window: "five_hour" | "seven_day";
  start: number;
  end: number;
  zoomed: boolean;
  usageRange: HistoryRange;
  active: boolean;
  onZoom: (factor: number, anchor?: number, usageAnchor?: number) => void;
  onPan: (delta: number, usageDelta?: number) => void;
  onReset: () => void;
}) {
  const stamp = createSnapshotTimeFormatter().format;
  const chartRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const clipId = useId();
  const dragX = useRef<number | null>(null);
  const dragY = useRef<number | null>(null);
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
        Math.max(
          0,
          Math.min(
            1,
            (height - 30 - (event.clientY - rect.top)) / (height - 50),
          ),
        ),
      );
    };
    svg.addEventListener("wheel", wheel, { passive: false });
    return () => svg.removeEventListener("wheel", wheel);
  }, [onZoom, onPan, start, end, height]);
  const [hover, setHover] = useState<{
    key: string;
    x: number;
    y: number;
    mouseX: number;
    mouseY: number;
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const values = useMemo(
    () =>
      accounts
        .flatMap((a) =>
          a.points
            .filter((p) => p[window] && p.t >= start && p.t <= end)
            .map((p) => ({ ...p, account: a, key: `${a.id}:${p.t}` })),
        )
        .sort((a, b) => a.t - b.t || a.account.id.localeCompare(b.account.id)),
    [accounts, window, start, end],
  );
  const p = values.find((p) => p.key === selected) ?? values.at(-1);
  const w = p?.[window];
  const hovered = values.find((v) => v.key === hover?.key);
  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!tooltip || !hover) return;
    if (!hovered) return;
    const position = historyTooltipPosition(
      width,
      height,
      tooltip.offsetWidth,
      tooltip.offsetHeight,
      hover.mouseX,
      hover.mouseY,
      36 + ((hovered.t - start) / (end - start)) * (width - 50),
      height -
        30 -
        ((hovered[window]!.pct - usageRange.start) /
          (usageRange.end - usageRange.start)) *
          (height - 50),
    );
    if (position.x !== hover.x || position.y !== hover.y)
      setHover((current) => (current ? { ...current, ...position } : null));
  }, [
    hover?.key,
    hover?.mouseX,
    hover?.mouseY,
    hovered?.account.name,
    width,
    height,
    start,
    end,
    usageRange.start,
    usageRange.end,
  ]);
  const tracked = hovered ?? (selected ? p : undefined);
  const visibleAccounts = new Set(values.map((p) => p.account.id)).size;
  const x = (t: number) => 36 + ((t - start) / (end - start)) * (width - 50);
  const y = (used: number) =>
    height -
    30 -
    ((used - usageRange.start) / (usageRange.end - usageRange.start)) *
      (height - 50);
  const geometry = useMemo(
    () =>
      new Map(
        !active
          ? []
          : accounts.map((a) => [
              a.id,
              <>
                {historySegments(a.points, window).map((s, i) => (
                  <g key={i}>
                    <path
                      d={smoothHistoryPath(
                        s.map((p) => ({ x: x(p.t), y: y(p.pct) })),
                      )}
                      className="ah-line"
                      style={{ stroke: a.color }}
                    ></path>
                    <path
                      d={smoothHistoryPath(
                        s.map((p) => ({ x: x(p.t), y: y(p.pct) })),
                      )}
                      className="ah-line-hit"
                    ></path>
                    {s.map((p, index) => (
                      <circle
                        key={p.t}
                        cx={x(p.t)}
                        cy={y(p.pct)}
                        r="2.5"
                        className={`ah-dot${index === 0 || index === s.length - 1 ? " ah-dot-end" : ""}`}
                        style={{ fill: a.color }}
                      ></circle>
                    ))}
                  </g>
                ))}
              </>,
            ]),
      ),
    [
      accounts,
      window,
      start,
      end,
      width,
      height,
      usageRange.start,
      usageRange.end,
      active,
    ],
  );
  const options = useMemo(
    () =>
      !active || !inspectorOpen
        ? []
        : [...values].reverse().map((v) => (
            <option key={v.key} value={v.key}>
              {accounts.length > 1 ? `${v.account.name} · ` : ""}
              {stamp(v.t)} · {v[window]!.pct}% used
            </option>
          )),
    [values, accounts.length, window, active, inspectorOpen],
  );
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
          aria-label={`${window === "five_hour" ? "5-hour" : "7-day"} interactive capacity chart. Top is ${Number(usageRange.end.toFixed(1))} percent used; bottom is ${Number(usageRange.start.toFixed(1))} percent used. 100 percent means exhausted. Scroll to zoom both axes, drag to pan, double-click to reset. Keyboard: plus or minus to zoom, arrow keys to pan both axes, zero to reset. Gaps indicate missing observations or changed reset windows.`}
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
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              onPan(
                0,
                (usageRange.end - usageRange.start) *
                  (e.key === "ArrowUp" ? 0.25 : -0.25),
              );
            } else if (e.key === "0" || e.key === "Home") {
              e.preventDefault();
              onReset();
            }
          }}
          className={`ah-plot${zoomed ? " ah-plot-zoomed" : ""}${hovered ? " ah-plot-inspecting" : ""}`}
          onPointerDown={(e) => {
            pointerKind.current = e.pointerType;
            if (e.pointerType === "touch")
              touchStart.current = { x: e.clientX, y: e.clientY, moved: false };
            if (!zoomed || e.button !== 0) return;
            dragX.current = e.clientX;
            dragY.current = e.clientY;
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
              const visibleCandidates = candidates.filter(
                (v) =>
                  v[window]!.pct >= usageRange.start &&
                  v[window]!.pct <= usageRange.end,
              );
              let nearest: (typeof values)[number] | undefined;
              let distance = Infinity;
              for (const candidate of visibleCandidates) {
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
                      mouseX: mx,
                      mouseY: my,
                      x: Math.max(4, Math.min(width - 240, mx + 12)),
                      y: Math.max(4, my - 90),
                    }
                  : null,
              );
              return;
            }
            setHover(null);
            const dx = e.clientX - dragX.current;
            const dy = e.clientY - (dragY.current ?? e.clientY);
            dragX.current = e.clientX;
            dragY.current = e.clientY;
            onPan(
              (-dx / (e.currentTarget.getBoundingClientRect().width - 50)) *
                (end - start),
              (dy / (height - 50)) * (usageRange.end - usageRange.start),
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
            dragY.current = null;
          }}
          onPointerCancel={() => {
            touchStart.current = null;
            lastTap.current = null;
            dragX.current = null;
            dragY.current = null;
          }}
          onLostPointerCapture={() => {
            dragX.current = null;
            dragY.current = null;
          }}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x="36" y="16" width={width - 50} height={height - 42} />
            </clipPath>
          </defs>
          {[
            usageRange.start,
            (usageRange.start + usageRange.end) / 2,
            usageRange.end,
          ].map((v) => (
            <g key={v}>
              <line
                x1="36"
                x2={width - 14}
                y1={y(v)}
                y2={y(v)}
                className="ah-grid"
              />
              <text x="3" y={y(v) + 4}>
                {Number(v.toFixed(1))}%
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
              {geometry.get(a.id)}
            </g>
          ))}
          {tracked && (
            <g
              pointerEvents="none"
              data-tracked-observation={tracked.key}
              clipPath={`url(#${clipId})`}
            >
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
            ref={tooltipRef}
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
      <details
        className="ah-inspector"
        onToggle={(e) => setInspectorOpen(e.currentTarget.open)}
      >
        <summary>Inspect recorded readings</summary>
        <label className="ah-inspect">
          Inspect observation
          <select
            aria-label={`Inspect ${window === "five_hour" ? "5-hour" : "7-day"} observation`}
            value={p?.key ?? ""}
            onChange={(e) => {
              setSelected(e.target.value);
              const reading = values.find((v) => v.key === e.target.value)?.[
                window
              ];
              if (reading && reading.pct < usageRange.start)
                onPan(0, reading.pct - usageRange.start);
              else if (reading && reading.pct > usageRange.end)
                onPan(0, reading.pct - usageRange.end);
            }}
            disabled={!values.length}
          >
            {!values.length && <option value="">No observations</option>}
            {options}
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
  const stamp = createSnapshotTimeFormatter().format;
  const [data, setData] = useState<AccountHistory | null>(null),
    [error, setError] = useState(""),
    [account, setAccount] = useState(""),
    [days, setDays] = useState(7),
    [retry, setRetry] = useState(0);
  const [activeWindow, setActiveWindow] = useState<"five_hour" | "seven_day">(
    "seven_day",
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
  const [usageViewport, setUsageViewport] = useState<
    (HistoryRange & { key: string }) | null
  >(null);
  const viewKey = `${selectedAccount}:${days}`;
  const usageRange =
    usageViewport?.key === viewKey
      ? clampUsageRange(usageViewport)
      : { start: 0, end: 100 };
  const view =
    viewport?.key === viewKey ? clampHistoryRange(viewport, full) : full;
  const { start, end } = view;
  const zoomed =
    end - start < full.end - full.start - 1 ||
    usageRange.end - usageRange.start < 100;
  const zoom = (factor: number, anchor = 0.5, usageAnchor = 0.5) => {
    setViewport((previous) => ({
      ...zoomHistoryRange(
        previous?.key === viewKey ? clampHistoryRange(previous, full) : full,
        full,
        factor,
        anchor,
      ),
      key: viewKey,
    }));
    setUsageViewport((previous) => ({
      ...zoomUsageRange(
        previous?.key === viewKey
          ? clampUsageRange(previous)
          : { start: 0, end: 100 },
        factor,
        usageAnchor,
      ),
      key: viewKey,
    }));
  };
  const pan = (delta: number, usageDelta = 0) => {
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
    setUsageViewport((previous) => {
      const current =
        previous?.key === viewKey
          ? clampUsageRange(previous)
          : { start: 0, end: 100 };
      return {
        ...clampUsageRange({
          start: current.start + usageDelta,
          end: current.end + usageDelta,
        }),
        key: viewKey,
      };
    });
  };
  const reset = () => {
    setViewport(null);
    setUsageViewport(null);
  };
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
              reset();
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
                        usageRange={usageRange}
                        active={activeWindow === window}
                        onZoom={zoom}
                        onPan={pan}
                        onReset={reset}
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
                    <p className="ah-note">
                      Recorded observations · The live account panel may have
                      newer readings.
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
                    reset();
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
                        reset();
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
