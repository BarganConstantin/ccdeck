import React, { useEffect, useState } from "react";
import { type AccountHistory, storageSize } from "../account-history";
import "./account-history.css";
export default function AccountHistorySettings() {
  const [data, setData] = useState<AccountHistory | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false),
    [retention, setRetention] = useState<number | null>(null);
  const refresh = async () => {
    const r = await fetch("/api/accounts/history");
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || "History unavailable");
    setData(d);
  };
  useEffect(() => {
    let alive = true;
    void fetch("/api/accounts/history")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || "History unavailable");
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, []);
  const act = async (url: string, body: object) => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("Could not apply change. Try again.");
      await refresh();
      setConfirm(false);
      setRetention(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not apply change");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ah-settings">
      <h3>Account history</h3>
      <p className="sm-note">
        Local snapshots of Claude account quota. No credentials are stored and
        recording adds no provider requests.
      </p>
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            type="button"
            className="btn"
            onClick={() =>
              void refresh()
                .then(() => setError(""))
                .catch((e) => setError(e.message))
            }
          >
            Retry
          </button>
        </p>
      )}
      {!data && !error && <p role="status">Loading history settings…</p>}
      {data && (
        <>
          <label className="sm-switch">
            <span className="sm-switch-label" id="ah-enable">
              Enable usage snapshots
            </span>
            <button
              type="button"
              className="switch"
              role="switch"
              aria-labelledby="ah-enable"
              aria-checked={data.enabled}
              disabled={busy}
              onClick={() =>
                void act("/api/prefs", { usageSnapshots: !data.enabled })
              }
            >
              <span className="switch-knob" />
            </button>
          </label>
          <p className="sm-note">
            New observations are sampled in 15-minute intervals while ccdeck
            runs. Pausing keeps existing history; retention continues to apply.
          </p>
          <label className="ah-inspect">
            Retention
            <select
              aria-label="Retention"
              value={retention ?? data.retentionDays}
              disabled={busy}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (n < data.retentionDays) setRetention(n);
                else void act("/api/prefs", { snapshotRetentionDays: n });
              }}
            >
              {[30, 60, 90].map((n) => (
                <option key={n} value={n}>
                  {n} days
                </option>
              ))}
            </select>
          </label>
          {retention != null && (
            <div
              className="ah-confirm"
              role="group"
              aria-label="Confirm shorter retention"
            >
              <p>
                Readings older than {retention} days will be permanently
                removed.
              </p>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  void act("/api/prefs", { snapshotRetentionDays: retention })
                }
              >
                Apply {retention} days
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setRetention(null)}
              >
                Cancel
              </button>
            </div>
          )}
          <div className="ah-storage">
            <span>
              History storage <strong>{storageSize(data.bytes)}</strong>
            </span>
            <button
              type="button"
              className="btn"
              disabled={busy || confirm}
              onClick={() => setConfirm(true)}
            >
              Clear history…
            </button>
          </div>
          {confirm && (
            <div
              className="ah-confirm"
              role="group"
              aria-label="Confirm clear history"
            >
              <p>
                Delete all account snapshots? Live quota and account logins stay
                unchanged. New observations can accumulate again if recording is
                enabled.
              </p>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  void act("/api/accounts/history/clear", { confirm: true })
                }
              >
                Delete all history
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setConfirm(false)}
              >
                Cancel
              </button>
            </div>
          )}
          {data.storageError && <p role="alert">{data.storageError}</p>}
        </>
      )}
    </section>
  );
}
