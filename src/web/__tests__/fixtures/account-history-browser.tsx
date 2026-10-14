import React from "react";
import { createRoot } from "react-dom/client";
import Report from "../../components/AccountsUsageReport";
import Settings from "../../components/AccountHistorySettings";
import { modalStack } from "../../modal-dismiss";
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") modalStack.dismissTop();
});
const root = createRoot(document.getElementById("root")!);
const now = Date.now();
const accounts = [
  {
    num: 1,
    email: "account@example.test",
    orgUuid: "org",
    org: null,
    alias: "Demo account",
    active: true,
    disabled: false,
    headroom: 50,
    fetchedAt: now,
    nextAt: null,
    stale: false,
    error: null,
    lanes: [
      { id: "five_hour", label: "5h", pct: 50, resetAt: now / 1000 + 3600 },
      { id: "seven_day", label: "7d", pct: 20, resetAt: now / 1000 + 86400 },
    ],
  },
];
window.openReport = () =>
  root.render(
    <Report
      accounts={accounts}
      order={[]}
      failed={null}
      nowSec={now / 1000}
      onClose={() => root.render(null)}
    />,
  );
document.getElementById("launch")!.onclick = window.openReport;
document.getElementById("settings")!.onclick = () =>
  root.render(
    <div className="modal-backdrop">
      <div
        className="modal"
        style={{ padding: 24, width: 560, maxHeight: "90vh", overflow: "auto" }}
      >
        <Settings />
      </div>
    </div>,
  );
