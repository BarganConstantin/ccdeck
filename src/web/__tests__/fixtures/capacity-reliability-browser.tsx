// Development-only fixture. Never imported by the production application.
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState } from "react";
import { useAccountRoster } from "../../use-account-roster";
import AccountsUsageReport from "../../components/AccountsUsageReport";
import { modalStack } from "../../modal-dismiss";
import type { AccountsData } from "../../claude-accounts";

declare global {
  interface Window { capacityClock?: (at: number) => void; capacityLoad?: (force?: boolean) => Promise<void>; }
}
function Probe() {
  const onRoster = useCallback((_data: AccountsData) => {}, []);
  const roster = useAccountRoster(onRoster);
  const [nowSec, clock] = useState(1_800_000_000);
  const [open, setOpen] = useState(false);
  useEffect(() => { window.capacityClock = clock; window.capacityLoad = roster.load; return () => { delete window.capacityLoad; delete window.capacityClock; }; }, [roster.load]);
  return <>
    <button onClick={() => roster.load(true)}>Reload fixture</button>
    <button onClick={() => setOpen(true)}>Open account capacity</button>
    <output id="roster-state">{JSON.stringify({ data: roster.data, reloading: roster.reloading, failure: roster.failure?.text ?? null })}</output>
    {open && <AccountsUsageReport accounts={roster.data?.accounts ?? null} order={[]} failed={roster.failure?.reload ? roster.failure.text : null} nowSec={nowSec} onClose={() => setOpen(false)} />}
  </>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Probe />);
window.addEventListener("keydown", event => { if (event.key === "Escape") modalStack.dismissTop(); });
document.getElementById("unmount")!.onclick = () => root.unmount();
